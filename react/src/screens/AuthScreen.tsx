import React, { useState, useRef } from 'react';
import { C } from '../theme';
import { CONTENT_MAX_WIDTH } from '../responsive';

type Mode = 'login' | 'signup';

interface Props {
  onAuth: () => void;
}

async function callGlobal(name: string, ...args: any[]): Promise<any> {
  // Retry up to 10 s in case ServiceBootstrap hasn't finished registering globals yet.
  for (let i = 0; i < 40; i++) {
    try {
      const fn = (Globals as any)[name];
      if (fn != null) {
        const result = fn(...args);
        return (result != null && typeof result.then === 'function') ? result : Promise.resolve(result);
      }
    } catch (e) {
      return Promise.reject(e);
    }
    await new Promise<void>(r => setTimeout(r, 250));
  }
  return Promise.reject(new Error('Services not ready — please wait a moment and try again.'));
}

// ── Shared input ──────────────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, secure, hint, hintColor, borderColor,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  hint?: string;
  hintColor?: string;
  borderColor?: string;
}) {
  return (
    <view style={{ marginBottom: 14 }}>
      <text style={{ fontSize: 12, color: C.secondary, fontWeight: 'bold', marginBottom: 6, letterSpacing: 0.3 }}>
        {label}
      </text>
      <view style={{
        backgroundColor: C.card,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: borderColor ?? 'rgba(255,255,255,0.08)',
        paddingLeft: 14, paddingRight: 14,
        paddingTop: 12,  paddingBottom: 12,
      }}>
        <input
          value={value}
          type={secure ? 'password' : 'text'}
          onChange={(e: any) => onChange(e?.target?.value ?? e)}
          placeholder={placeholder ?? label}
          style={{
            flex: 1,
            fontSize: 15,
            color: C.text,
            backgroundColor: 'transparent',
            borderWidth: 0,
            minHeight: 40,
          }}
        />
      </view>
      {hint ? <text style={{ fontSize: 11, color: hintColor ?? C.secondary, marginTop: 4 }}>{hint}</text> : null}
    </view>
  );
}

// ── Login form ─────────────────────────────────────────────────────────────────

function LoginForm({ onAuth, onSwitch }: { onAuth: () => void; onSwitch: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password,   setPassword]   = useState('');
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');

  async function submit() {
    if (!identifier.trim() || !password) {
      setError('Please enter your username or email and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const err = await callGlobal('signIn', identifier.trim(), password);
      if (err) { setError(err); }
      else      { onAuth(); }
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = identifier.trim().length > 0 && password.length > 0 && !loading;

  return (
    <view style={{ flex: 1 }}>
      <Field label="USERNAME OR EMAIL" value={identifier} onChange={setIdentifier} placeholder="Enter username or email" />
      <Field label="PASSWORD"          value={password}   onChange={setPassword}   placeholder="Enter password" secure />

      {error ? (
        <view style={{ backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,69,58,0.35)', padding: 12, marginBottom: 14 }}>
          <text style={{ color: '#FF453A', fontSize: 13 }}>{error}</text>
        </view>
      ) : null}

      <button
        onClick={submit}
        style={{
          backgroundColor: canSubmit ? C.green : C.surface,
          borderRadius: 14, borderWidth: 0,
          paddingTop: 15, paddingBottom: 15,
          alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}
      >
        <text style={{ color: canSubmit ? C.bg : C.secondary, fontSize: 15, fontWeight: 'bold' }}>
          {loading ? 'Signing In...' : 'Log In'}
        </text>
      </button>

      <view style={{ flexDirection: 'row', justifyContent: 'center', gap: 4 }}>
        <text style={{ color: C.secondary, fontSize: 13 }}>Don't have an account?</text>
        <button onClick={onSwitch} style={{ backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0, padding: 0 }}>
          <text style={{ color: C.green, fontSize: 13, fontWeight: 'bold' }}>Sign Up</text>
        </button>
      </view>
    </view>
  );
}

// ── Birthday picker ────────────────────────────────────────────────────────────

const MONTH_OPTIONS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
].map((name, i) => ({ label: name, value: String(i + 1) }));

const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
  label: String(i + 1), value: String(i + 1),
}));

const YEAR_OPTIONS = (() => {
  const y = new Date().getFullYear();
  return Array.from({ length: 100 }, (_, i) => ({ label: String(y - i), value: String(y - i) }));
})();

function DropPicker({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const displayLabel = value ? (options.find(o => o.value === value)?.label ?? value) : placeholder;

  return (
    <view style={{ flexDirection: 'column', position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          backgroundColor: C.card,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.08)',
          paddingLeft: 12, paddingRight: 10,
          paddingTop: 0, paddingBottom: 0,
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <text style={{ fontSize: 14, color: value ? C.text : C.secondary, flex: 1 }}>
          {displayLabel}
        </text>
        <icon set="material-rounded" style={{ fontSize: 18, color: C.secondary, lineHeight: 18 }}>{open ? 'expand_less' : 'expand_more'}</icon>
      </button>

      {open && (
        <view style={{
          position: 'absolute',
          top: 52,
          left: 0,
          right: 0,
          zIndex: 999,
          backgroundColor: C.card,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.15)',
          overflow: 'hidden',
        }}>
          <scroll className="pludo-scroll" style={{ height: 160 }}>
            {options.map(opt => (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  backgroundColor: opt.value === value ? C.surface : 'rgba(0,0,0,0)',
                  borderWidth: 0,
                  paddingLeft: 14, paddingRight: 14,
                  paddingTop: 9, paddingBottom: 9,
                  alignItems: 'flex-start',
                }}
              >
                <text style={{ fontSize: 13, color: opt.value === value ? C.green : C.text }}>
                  {opt.label}
                </text>
              </button>
            ))}
          </scroll>
        </view>
      )}
    </view>
  );
}

// ── Sign-up form ───────────────────────────────────────────────────────────────

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

function SignUpForm({ onAuth, onSwitch }: { onAuth: () => void; onSwitch: () => void }) {
  const [username,       setUsername]       = useState('');
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');
  const [email,          setEmail]          = useState('');
  const [password,       setPassword]       = useState('');
  const [month,          setMonth]          = useState('');
  const [day,            setDay]            = useState('');
  const [year,           setYear]           = useState('');
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState('');

  const checkTimerRef = useRef<any>(null);

  function handleUsernameChange(v: string) {
    setUsername(v);
    setUsernameStatus('idle');
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    const trimmed = v.trim();
    if (!USERNAME_RE.test(trimmed)) return;
    setUsernameStatus('checking');
    checkTimerRef.current = setTimeout(async () => {
      try {
        const result = await callGlobal('checkUsername', trimmed);
        setUsernameStatus(result === 'available' ? 'available' : result === 'taken' ? 'taken' : 'idle');
      } catch {
        setUsernameStatus('idle');
      }
    }, 600);
  }

  function buildBirthday(): string | null {
    const m = parseInt(month, 10);
    const d = parseInt(day,   10);
    const y = parseInt(year,  10);
    if (isNaN(m) || isNaN(d) || isNaN(y) || m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > new Date().getFullYear())
      return null;
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  async function submit() {
    if (!username.trim()) { setError('Username is required.'); return; }
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username.trim())) {
      setError('Username must be 3-32 characters: letters, numbers, and underscores only.');
      return;
    }
    if (!email.trim() || !email.includes('@')) { setError('A valid email is required.'); return; }
    if (password.length < 8)                   { setError('Password must be at least 8 characters.'); return; }

    const birthday = buildBirthday();
    if (!birthday) { setError('Please enter a valid birthday (month, day, and year).'); return; }

    setLoading(true);
    setError('');
    try {
      const err = await callGlobal('signUp', email.trim(), password, username.trim(), birthday);
      if (err) { setError(err); }
      else      { onAuth(); }
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = username.trim() && email.trim() && password.length >= 8 && month && day && year && !loading;

  return (
    <view style={{ flex: 1 }}>
      <Field
        label="USERNAME"
        value={username}
        onChange={handleUsernameChange}
        placeholder="3-32 chars, letters/numbers/_"
        hint={
          usernameStatus === 'available' ? 'Username available' :
          usernameStatus === 'taken'     ? 'Username already taken' :
          usernameStatus === 'checking'  ? 'Checking...' :
          'Only letters, numbers, and underscores.'
        }
        hintColor={
          usernameStatus === 'available' ? C.green :
          usernameStatus === 'taken'     ? '#FF453A' :
          undefined
        }
        borderColor={
          usernameStatus === 'available' ? C.green :
          usernameStatus === 'taken'     ? '#FF453A' :
          undefined
        }
      />
      <Field label="EMAIL"     value={email}    onChange={setEmail}    placeholder="you@example.com" />
      <Field label="PASSWORD"  value={password} onChange={setPassword} placeholder="At least 8 characters" secure
             hint="At least 8 characters." />

      {/* Birthday row */}
      <view style={{ marginBottom: 14 }}>
        <text style={{ fontSize: 12, color: C.secondary, fontWeight: 'bold', marginBottom: 6, letterSpacing: 0.3 }}>
          BIRTHDAY
        </text>
        <view style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <view style={{ flex: 5 }}>
            <DropPicker value={month} onChange={setMonth} options={MONTH_OPTIONS} placeholder="Month" />
          </view>
          <view style={{ flex: 2 }}>
            <DropPicker value={day} onChange={setDay} options={DAY_OPTIONS} placeholder="Day" />
          </view>
          <view style={{ flex: 3 }}>
            <DropPicker value={year} onChange={setYear} options={YEAR_OPTIONS} placeholder="Year" />
          </view>
        </view>
      </view>

      {error ? (
        <view style={{ backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,69,58,0.35)', padding: 12, marginBottom: 14 }}>
          <text style={{ color: '#FF453A', fontSize: 13 }}>{error}</text>
        </view>
      ) : null}

      <button
        onClick={submit}
        style={{
          backgroundColor: canSubmit ? C.green : C.surface,
          borderRadius: 14, borderWidth: 0,
          paddingTop: 15, paddingBottom: 15,
          alignItems: 'center', justifyContent: 'center',
          marginBottom: 12,
        }}
      >
        <text style={{ color: canSubmit ? C.bg : C.secondary, fontSize: 15, fontWeight: 'bold' }}>
          {loading ? 'Creating Account...' : 'Sign Up'}
        </text>
      </button>

      {/* Legal disclaimer */}
      <text style={{ fontSize: 11, color: C.secondary, textAlign: 'center', marginBottom: 20, lineHeight: 16 }}>
        By clicking Sign Up, you are agreeing to our Terms of Use (including arbitration) and acknowledge our Privacy Policy. If you are under 18, you agree that your parent/guardian permits you to create this account and agrees to our Terms of Use.
      </text>

      <view style={{ flexDirection: 'row', justifyContent: 'center', gap: 4 }}>
        <text style={{ color: C.secondary, fontSize: 13 }}>Already have an account?</text>
        <button onClick={onSwitch} style={{ backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0, padding: 0 }}>
          <text style={{ color: C.green, fontSize: 13, fontWeight: 'bold' }}>Log In</text>
        </button>
      </view>
    </view>
  );
}

// ── AuthScreen ─────────────────────────────────────────────────────────────────

export function AuthScreen({ onAuth }: Props) {
  const [mode, setMode] = useState<Mode>('login');

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      {/* Content column — centered/constrained on tablet so the form doesn't
          stretch edge-to-edge across the wider portrait canvas. */}
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>
        {/* Header */}
        <view style={{ alignItems: 'center', paddingTop: 60, paddingBottom: 32 }}>
          <text style={{ fontSize: 32, color: C.green, fontWeight: 'bold', letterSpacing: -1 }}>Pludo</text>
          <text style={{ fontSize: 14, color: C.secondary, marginTop: 4 }}>
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </text>
        </view>

        {/* Scrollable form body */}
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 20, paddingRight: 20 }}>
          {mode === 'login'
            ? <LoginForm  onAuth={onAuth} onSwitch={() => setMode('signup')} />
            : <SignUpForm onAuth={onAuth} onSwitch={() => setMode('login')}  />
          }
          {/* Bottom padding so content clears the keyboard */}
          <view style={{ height: 40 }} />
        </scroll>
      </view>
    </view>
  );
}
