import { SB_ANON_KEY, SB_URL } from './auth';

// Same backend the Unity app talks to (Assets/Resources/Config/PludoEnvironmentConfig:
// dev = localhost:4000). The iOS Simulator reaches the Mac's localhost directly.
export const API_BASE = 'http://localhost:4000';

export interface GameSummary {
  id: number;
  title: string;
  description: string;
  genre: string;
  plays: number;
  creatorName: string;
  thumbnailUrl: string;
  tags?: string[];
}

export async function fetchGames(limit = 30): Promise<GameSummary[]> {
  const res = await fetch(`${API_BASE}/api/games?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.games ?? [];
}

export interface MyGame {
  id: number;
  title: string;
  description: string;
  genre: string;
  plays: number;
  thumbnailUrl: string;
  hasCode: boolean;
}

/** Games created by the signed-in user, newest edit first. Same query the
 *  Unity app's Create screen runs (forge_games by created_by_user_id), with the
 *  user's token in the Authorization header so row-level security applies. */
export async function fetchMyGames(userId: string, accessToken: string): Promise<MyGame[]> {
  const url = `${SB_URL}/rest/v1/forge_games?select=id,title,description,genre,plays,game_code,thumbnail_url`
            + `&created_by_user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc`;
  const res = await fetch(url, { headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows: any[] = await res.json();
  return rows.map(r => ({
    id: Number(r.id),
    title: String(r.title ?? 'Untitled'),
    description: String(r.description ?? ''),
    genre: String(r.genre ?? ''),
    plays: Number(r.plays ?? 0),
    thumbnailUrl: String(r.thumbnail_url ?? ''),
    hasCode: !!r.game_code,
  }));
}

export interface GameDetail {
  id: number;
  title: string;
  description: string;
  genre: string;
  creatorName: string;
  createdByUserId: string;
  plays: number;
  thumbnailUrl: string;
  tags: string[];
  hasCode: boolean;
}

/** Full game record. Published snapshot first (what players see); falls back
 *  to the draft for the owner's own unpublished games. */
export async function fetchGameDetail(id: number): Promise<GameDetail> {
  let res = await fetch(`${API_BASE}/games/${id}?published=true`);
  if (!res.ok) res = await fetch(`${API_BASE}/games/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const g = await res.json();
  return {
    id: Number(g.id),
    title: String(g.publishedTitle || g.title || 'Untitled'),
    description: String(g.publishedDescription || g.description || ''),
    genre: String(g.publishedGenre || g.genre || ''),
    creatorName: String(g.creatorName ?? ''),
    createdByUserId: String(g.createdByUserId ?? ''),
    plays: Number(g.plays ?? 0),
    thumbnailUrl: String(g.publishedThumbnailUrl || g.thumbnailUrl || ''),
    tags: Array.isArray(g.tags) ? g.tags.map(String) : [],
    hasCode: !!(g.publishedGameCode || g.gameCode),
  };
}

export interface GameSocial { likes: number; likedByMe: boolean }

export async function fetchSocial(id: number, accessToken: string | null): Promise<GameSocial> {
  const res = await fetch(`${API_BASE}/api/game/${id}/social`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = await res.json();
  return { likes: Number(b.likes ?? 0), likedByMe: !!b.likedByMe };
}

/** Toggles the signed-in user's like (shown as "Favorite"). */
export async function toggleFavorite(id: number, accessToken: string, username: string): Promise<GameSocial> {
  const res = await fetch(`${API_BASE}/api/game/${id}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userAccessToken: accessToken, userName: username }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = await res.json();
  return { likes: Number(b.likes ?? 0), likedByMe: !!b.liked };
}

/** A 3D model the editor can place (mirrors ReactUnity's AssetItem). */
export interface EditorAsset {
  cacheKey: string;
  prompt: string;
  isHumanoid: boolean;
  sizeHint: number;
  modelUrl: string;
  thumbnailUrl?: string | null;
  title?: string | null;
}

/** The shared asset library (500 is the server-side cap). */
export async function fetchAssets(q = '', limit = 500): Promise<EditorAsset[]> {
  const query = `?limit=${limit}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`;
  const r = await fetch(`${API_BASE}/api/assets${query}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data?.assets) ? data.assets : [];
}

/** Creates an empty, editable game (the native "Name your game" prompt).
 *  The server moderates the title; a rejection throws its message. */
export async function createBlankGame(opts: {
  title: string; username: string; userId: string; accessToken: string;
}): Promise<number> {
  const r = await fetch(`${API_BASE}/api/create-blank-game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: opts.title, creatorName: opts.username, userId: opts.userId, userAccessToken: opts.accessToken,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.gameId) throw new Error(data?.error || `Couldn't create the game (HTTP ${r.status}).`);
  return Number(data.gameId);
}

/** A model made by the AI forge (mirrors ReactUnity's AvatarItemData). */
export interface ForgedItem {
  id?: number;
  name: string;
  category: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  modelUrl?: string;
}

/** Starts an AI 3D-model forge job; the server moderates the prompt. */
export async function startModelForge(prompt: string, creatorName: string): Promise<string> {
  const r = await fetch(`${API_BASE}/ai/generate-avatar-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, creatorName }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.jobId) throw new Error(data?.error || `Couldn't start the forge (HTTP ${r.status}).`);
  return String(data.jobId);
}

export type ForgeStatus =
  | { status: 'pending' | 'modeling' }
  | { status: 'done'; item: ForgedItem }
  | { status: 'error'; error: string };

export async function forgeStatus(jobId: string): Promise<ForgeStatus> {
  const r = await fetch(`${API_BASE}/ai/generate-avatar-item/status/${encodeURIComponent(jobId)}`);
  const data = await r.json().catch(() => ({}));
  if (data?.status === 'done' && data.item) return { status: 'done', item: data.item };
  if (data?.status === 'error') return { status: 'error', error: data.error || 'Forge failed. Try a different prompt.' };
  return { status: data?.status === 'modeling' ? 'modeling' : 'pending' };
}
