import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

// Native sign-in against the same Supabase project the Unity app uses
// (react/src/screens/CreateScreen.tsx SB_URL / anon key — public by design).
// Mirrors Assets/Scripts/Services/Auth/AuthService.cs: a username is resolved
// to its email via the get_email_for_login RPC, then the password grant runs.
export const SB_URL      = 'https://daahlworuhbdindjepyg.supabase.co';
export const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhYWhsd29ydWhiZGluZGplcHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODc1MzIsImV4cCI6MjA5MzE2MzUzMn0.2bZa49XuHTBxb-LgqStR_1ouevs-qrFOHGQAZCCxLeQ';

const STORE_KEY = 'pludo.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // epoch seconds
  userId: string;
  username: string;
}

interface AuthApi {
  session: Session | null;
  restoring: boolean;
  signIn: (usernameOrEmail: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** A non-expired access token (refreshes if needed), or null when signed out. */
  getAccessToken: () => Promise<string | null>;
}

const Ctx = createContext<AuthApi | null>(null);
export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

const headers = { apikey: SB_ANON_KEY, 'Content-Type': 'application/json' };

function toSession(body: any): Session {
  const user = body.user ?? {};
  return {
    accessToken:  body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:    body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    userId:       user.id,
    username:     user.user_metadata?.username || (user.email ? String(user.email).split('@')[0] : 'player'),
  };
}

async function authError(res: Response): Promise<Error> {
  let msg = `Sign-in failed (${res.status})`;
  try {
    const b = await res.json();
    msg = b.error_description || b.msg || b.message || msg;
    if (/invalid login credentials/i.test(msg)) msg = 'Wrong username or password.';
  } catch { /* non-JSON */ }
  return new Error(msg);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);

  const save = useCallback(async (s: Session | null) => {
    setSession(s);
    if (s) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(s));
    else   await SecureStore.deleteItemAsync(STORE_KEY);
  }, []);

  const refresh = useCallback(async (s: Session): Promise<Session | null> => {
    const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers, body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    if (!res.ok) { await save(null); return null; }
    const next = toSession(await res.json());
    if (!next.username || next.username === 'player') next.username = s.username;
    await save(next);
    return next;
  }, [save]);

  // Restore the saved session on launch.
  useEffect(() => {
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(STORE_KEY);
        if (raw) {
          const s: Session = JSON.parse(raw);
          if (s.expiresAt - 60 > Date.now() / 1000) setSession(s);
          else await refresh(s);
        }
      } catch { /* corrupt store — stay signed out */ }
      setRestoring(false);
    })();
  }, [refresh]);

  // Refresh shortly before expiry so long sessions (eg. hours in the Unity
  // editor, which only uses the token it's handed) never run on a dead token.
  useEffect(() => {
    if (!session) return;
    const ms = (session.expiresAt - 120) * 1000 - Date.now();
    const t = setTimeout(() => { refresh(session).catch(() => {}); }, Math.max(5_000, ms));
    return () => clearTimeout(t);
  }, [session, refresh]);

  const api = useMemo<AuthApi>(() => ({
    session,
    restoring,
    signIn: async (usernameOrEmail, password) => {
      let email = usernameOrEmail.trim();
      if (!email.includes('@')) {
        const rpc = await fetch(`${SB_URL}/rest/v1/rpc/get_email_for_login`, {
          method: 'POST', headers, body: JSON.stringify({ p_username_or_email: email }),
        });
        if (!rpc.ok) throw await authError(rpc);
        const resolved = String(await rpc.text()).trim().replace(/^"|"$/g, '');
        if (!resolved || resolved === 'null') throw new Error('No account found for that username.');
        email = resolved;
      }
      const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw await authError(res);
      await save(toSession(await res.json()));
    },
    signOut: async () => {
      const token = session?.accessToken;
      await save(null);
      if (token) fetch(`${SB_URL}/auth/v1/logout`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` } }).catch(() => {});
    },
    getAccessToken: async () => {
      if (!session) return null;
      if (session.expiresAt - 60 > Date.now() / 1000) return session.accessToken;
      return (await refresh(session))?.accessToken ?? null;
    },
  }), [session, restoring, save, refresh]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
