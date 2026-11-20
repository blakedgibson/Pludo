import { GameData, AvatarItemData, UserResult, AssetItem } from './types';

function baseUrl(): string {
  try { return (Globals as any).apiBaseUrl ?? ''; } catch { return ''; }
}

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const url = baseUrl();
  if (!url) return fallback;
  try {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) return fallback;
    return await res.json() as T;
  } catch {
    return fallback;
  }
}

export async function fetchGames(limit = 10): Promise<GameData[]> {
  const data = await fetchJson<{ games: GameData[] }>(`/api/games`, { games: [] });
  return data.games.slice(0, limit);
}

export async function fetchMyGames(creatorName = 'Player'): Promise<GameData[]> {
  const data = await fetchJson<{ games: GameData[] }>(`/api/my-games?creator=${encodeURIComponent(creatorName)}`, { games: [] });
  return data.games;
}

export async function fetchAvatarItems(limit = 20): Promise<AvatarItemData[]> {
  const data = await fetchJson<{ items: AvatarItemData[] }>(`/api/avatar-items?limit=${limit}`, { items: [] });
  return data.items;
}

export async function fetchAssets(q = '', limit = 200): Promise<AssetItem[]> {
  const query = `?limit=${limit}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`;
  const data = await fetchJson<{ assets: AssetItem[] }>(`/api/assets${query}`, { assets: [] });
  return data.assets;
}

export async function searchUsers(q: string): Promise<UserResult[]> {
  if (!q.trim()) return [];
  const data = await fetchJson<{ users: UserResult[] }>(
    `/api/users/search?q=${encodeURIComponent(q.trim())}`,
    { users: [] }
  );
  return data.users;
}

export function formatCount(n: number): string {
  if (n >= 1000) return (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// "5m ago", "3h ago", "2d ago" — null/empty input renders as 'just now'.
export function formatTimeAgo(when: string | Date | null | undefined): string {
  if (!when) return 'just now';
  const d = typeof when === 'string' ? new Date(when) : when;
  const ms = Date.now() - d.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)  return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)  return `${hr}h ago`;
  const day = Math.floor(hr  / 24);
  if (day < 30)  return `${day}d ago`;
  const mo  = Math.floor(day / 30);
  if (mo  < 12)  return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export interface GameComment {
  id: number;
  userName: string;
  body: string;
  createdAt: string;
}

export interface GameSocial {
  likes: number;
  comments: number;
  plays: number;
  likedByMe: boolean;
  recentComments: GameComment[];
}

function authHeader(): Record<string, string> {
  try {
    const tok = (Globals as any).getAccessToken?.() ?? '';
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch { return {}; }
}

export async function fetchGameSocial(gameId: number): Promise<GameSocial> {
  const url = baseUrl();
  const empty: GameSocial = { likes: 0, comments: 0, plays: 0, likedByMe: false, recentComments: [] };
  if (!url) return empty;
  try {
    const r = await fetch(`${url}/api/game/${gameId}/social`, { headers: authHeader() });
    if (!r.ok) return empty;
    return await r.json() as GameSocial;
  } catch { return empty; }
}

export async function toggleGameLike(
  gameId: number,
  userName: string,
): Promise<{ liked: boolean; likes: number } | null> {
  const url = baseUrl();
  if (!url) return null;
  try {
    const tok = (Globals as any).getAccessToken?.() ?? '';
    const r = await fetch(`${url}/api/game/${gameId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessToken: tok, userName }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function postGameComment(
  gameId: number,
  body: string,
  userName: string,
): Promise<GameComment | null> {
  const url = baseUrl();
  if (!url || !body.trim()) return null;
  try {
    const tok = (Globals as any).getAccessToken?.() ?? '';
    const r = await fetch(`${url}/api/game/${gameId}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAccessToken: tok, userName, body }),
    });
    if (!r.ok) return null;
    const data = await r.json() as { comment: GameComment };
    return data.comment;
  } catch { return null; }
}

export async function recordGamePlay(gameId: number): Promise<void> {
  const url = baseUrl();
  if (!url) return;
  try {
    await fetch(`${url}/api/game/${gameId}/play`, { method: 'POST' });
  } catch { /* fire-and-forget */ }
}

// ── Moderation ───────────────────────────────────────────────────────────────

export type ModerationContext = 'username' | 'display_name' | 'item_name' | 'game_title' | 'game_description' | 'comment';

/**
 * Pre-validates user text against the server's moderation rules. Returns null
 * when allowed, or a user-facing reason when blocked. Fails open on network
 * errors — the server re-checks on every write, so this is UX only.
 */
export async function checkModeration(context: ModerationContext, text: string): Promise<string | null> {
  const url = baseUrl();
  if (!url) return null;
  try {
    const r = await fetch(`${url}/api/moderation/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, text }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { ok: boolean; message?: string };
    return j.ok ? null : (j.message ?? 'That isn’t allowed on Pludo.');
  } catch {
    return null;
  }
}

export type ReportReason =
  | 'harassment' | 'hate' | 'sexual' | 'self_harm' | 'violence' | 'scam' | 'personal_info'
  | 'inappropriate_name' | 'inappropriate_game' | 'inappropriate_model' | 'cheating' | 'other';

/** Files a report (signed-in users only). Returns true on success. */
export async function submitReport(
  targetType: 'user' | 'game' | 'comment' | 'avatar_item' | 'asset' | 'chat',
  targetId: string | number,
  reason: ReportReason,
  details = '',
): Promise<boolean> {
  const url = baseUrl();
  if (!url) return false;
  try {
    const token = (Globals as any).getAccessToken?.() ?? '';
    const r = await fetch(`${url}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType, targetId: String(targetId), reason, details, userAccessToken: token }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
