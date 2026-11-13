import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { buildGameHtml, extractGameLogic } from './game-html.js';
import { selectTemplate, buildTemplatePrompt, scoreTemplates, GAME_TEMPLATES, CONFIDENCE_THRESHOLD, type TemplateExample } from './game-templates.js';
import {
  validatePromptLength,
  filterContent,
  scanLuaScript,
  validateManifest,
  validateObjectPlacement,
  detectSystemPromptLeak,
} from './prompt-validation.js';
import { createPreview, createRefine, waitForTask, meshyDevMode, meshySkipRefine, getBalance } from './meshy.js';
import { uploadBuffer, downloadBuffer, publicUrl, r2Configured, listObjects } from './r2.js';
import { loadIndex as loadAssetCacheIndex, getAllEntries as getAllCacheEntries } from './asset-cache.js';
import { getCatalog, buildCatalogSection, type CatalogItem } from './catalog.js';
import { roomManager } from './room-manager.js';
import {
  check as moderationCheck, strike as moderationStrike, strikes as moderationStrikes,
  checkPublish, checkGenerationPrompt, checkModelThumbnail, sanitizeGeneratedListing,
  safeDisplayName, loadModerationState,
} from './moderation/index.js';
import { moderationRouter } from './moderation/routes.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const app = express();
// Trust the first proxy hop so req.ip reflects the real client IP (X-Forwarded-For).
// Without this, req.ip is the load-balancer address and per-IP Meshy limits are bypassed.
app.set('trust proxy', 1);
const httpServer = createServer(app);

const SUPABASE_URL      = process.env.SUPABASE_URL      ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

// ── Supabase REST helpers ─────────────────────────────────────────────────────

// Returns the best auth token to use. Prefer a real user JWT; fall back to anon key.
function sbBearer(jwt?: string): string {
  return jwt && jwt.length > 20 ? jwt : SUPABASE_ANON_KEY;
}

async function sbInsert(table: string, data: Record<string, unknown>, jwt?: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${sbBearer(jwt)}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  // If the user JWT is invalid/expired, retry with the anon key so the row is
  // always persisted to Supabase (RLS INSERT policy allows auth.uid() IS NULL).
  if ((r.status === 401 || r.status === 403) && jwt) {
    console.warn(`[supabase] insert ${table} JWT rejected (${r.status}) — retrying with anon key`);
    return sbInsert(table, data, undefined);
  }
  if (!r.ok) {
    const body = await r.text();
    console.error(`[supabase] insert ${table} failed (${r.status}): ${body}`);
    throw new Error(`Supabase insert ${table} failed (${r.status}): ${body}`);
  }
  return r.json() as Promise<Record<string, unknown>[]>;
}

async function sbPatch(table: string, id: number, data: Record<string, unknown>, jwt?: string): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${sbBearer(jwt)}`,
    },
    body: JSON.stringify(data),
  });
  // If the user JWT is invalid/expired, retry with the anon key. The RLS UPDATE
  // policy now allows auth.uid() IS NULL so the server can always patch its own rows.
  if ((r.status === 401 || r.status === 403) && jwt) {
    console.warn(`[supabase] patch ${table}#${id} JWT rejected (${r.status}) — retrying with anon key`);
    return sbPatch(table, id, data, undefined);
  }
  if (!r.ok) {
    const body = await r.text();
    console.error(`[supabase] patch ${table}#${id} failed (${r.status}): ${body}`);
    throw new Error(`Supabase patch ${table}#${id} failed (${r.status}): ${body}`);
  }
}

async function sbGetById(table: string, id: number): Promise<Record<string, unknown> | null> {
  if (!SUPABASE_URL) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&limit=1`, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!r.ok) {
    console.error(`[supabase] getById ${table}#${id} failed (${r.status}): ${await r.text()}`);
    return null;
  }
  const arr = await r.json() as Record<string, unknown>[];
  return arr.length > 0 ? arr[0] : null;
}

// Extract the Supabase user UUID from a JWT without verifying the signature.
// The payload is just base64url-encoded JSON; the real verification happens
// server-side when Supabase evaluates auth.uid() in RLS policies.
function userIdFromJwt(jwt: string): string {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return '';
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const data = JSON.parse(json) as Record<string, unknown>;
    return typeof data.sub === 'string' ? data.sub : '';
  } catch {
    return '';
  }
}

async function sbGetByUser(table: string, userId: string): Promise<Record<string, unknown>[]> {
  if (!SUPABASE_URL) return [];
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?created_by_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  if (!r.ok) {
    console.error(`[supabase] getByUser ${table} failed (${r.status}): ${await r.text()}`);
    return [];
  }
  return r.json() as Promise<Record<string, unknown>[]>;
}

async function sbGetByCreatorName(table: string, creatorName: string): Promise<Record<string, unknown>[]> {
  if (!SUPABASE_URL) return [];
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?creator_name=eq.${encodeURIComponent(creatorName)}&order=created_at.desc`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  if (!r.ok) {
    console.error(`[supabase] getByCreatorName ${table} failed (${r.status}): ${await r.text()}`);
    return [];
  }
  return r.json() as Promise<Record<string, unknown>[]>;
}

// In-memory GLB buffer store — GLBs are served via /api/glb/* so Unity can always
// reach them through the same API server, regardless of R2 public URL config.
const glbBuffers = new Map<string, Buffer>();

// Feedback registry: successful manifest combinations indexed by template genre.
// Each completed forge registers here; next generation of the same genre sees
// up to 3 proven examples injected into the Claude prompt as concrete inspiration.
const templateSuccesses = new Map<string, TemplateExample[]>();

function registerTemplateSuccess(genre: string, gameId: number, manifest: { id: string; asset: string; is_humanoid: boolean }[]) {
  const list = templateSuccesses.get(genre) ?? [];
  list.unshift({ gameId, manifest });
  if (list.length > 5) list.pop(); // keep the 5 most recent
  templateSuccesses.set(genre, list);
  console.log(`[templates] registered example for genre "${genre}" — ${list.length} stored`);
}

// ── Security headers ─────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── CORS — only allow known origins; never reflect arbitrary origins with credentials ──
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',   // React dev server
  'http://localhost:4000',   // same-origin API calls
  'http://localhost:8080',   // Unity WebGL local preview
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
]);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no Origin header (Unity native, curl, server-to-server)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── In-memory rate limiter — caps AI-calling endpoints per remote IP ──────────
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(windowMs: number, maxRequests: number) {
  return (req: Request, res: Response, next: () => void) => {
    const ip  = (req.headers['x-forwarded-for'] as string ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Please wait before trying again.', retryAfter });
      return;
    }
    next();
  };
}
// Prune stale buckets every 5 minutes so the map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitBuckets) if (now >= v.resetAt) rateLimitBuckets.delete(k);
}, 5 * 60 * 1000);

// Handle CORS rejection as 403 instead of 500
app.use((err: Error, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err.message?.startsWith('CORS:')) {
    res.status(403).json({ error: 'Forbidden: cross-origin request not allowed' });
    return;
  }
  next(err);
});

app.use(express.json({ limit: '4mb' }));

// ── In-memory game store ──────────────────────────────────────────────────────

interface Game {
  id: number;
  title: string;
  description: string;
  genre: string;
  gameCode: string;           // Luau script (empty = still generating)
  creatorName: string;
  createdByUserId: string;
  tags: string[];
  plays: number;
  isHot: boolean;
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
  thumbnailUrl: string;
  thumbnailPrompt: string;
  estimatedDuration: string;
  playerCount: string;
  difficulty: string;
  assetUrlsJson: string;      // JSON-serialized Record<string,string> of model id → /api/glb/... relative path
  humanoidIdsJson: string;   // JSON-serialized string[] of asset IDs that are humanoid (need walk animator)
  sizeHintsJson: string;     // JSON-serialized Record<string,number> of asset id → real-world size in meters
  // Claude's chat-friendly reply summarizing the generated game. Surfaced in the
  // AI editor chat panel so the user sees a real "I made you…" response instead
  // of just the synthetic build steps. Empty if generation predates this field.
  forgeReply: string;
  // ── Published snapshot ──────────────────────────────────────────────────────
  // Frozen copies of the user-facing fields at the moment of the most recent
  // publish. The public play path (Home/Explore/GameRenderClient) reads from
  // these so edits made after publishing don't bleed into the public version.
  // Empty strings (or "" assetUrlsJson) mean the game has never been published;
  // readers fall back to the live draft fields in that case for backwards
  // compatibility with games published before this snapshot was introduced.
  publishedGameCode:        string;
  publishedTitle:           string;
  publishedDescription:     string;
  publishedGenre:           string;
  publishedThumbnailUrl:    string;
  publishedAssetUrlsJson:   string;
  publishedHumanoidIdsJson: string;
  publishedAt:              Date | null;
  // ── Editor session state ───────────────────────────────────────────────────
  // Snapshot of per-object transform tweaks, gear-panel settings, and Custom
  // Logic graphs from the React editor. Captured by Unity's EditorState.Capture,
  // round-tripped verbatim through Supabase (forge_games.editor_state_json), and
  // reapplied by EditorState.Apply after the Lua script re-creates objects on
  // reload. Empty object means "no edits beyond the script itself".
  editorStateJson: string;
  // Frozen copy of editor_state_json at the moment of the last publish. Public
  // players read this so the creator's edits travel into the published game
  // instead of being trapped in the editor session.
  publishedEditorStateJson: string;
}

// One entry in the asset manifest Claude returns alongside the Luau script.
interface AssetManifestItem {
  id: string;           // referenced in Object.Create("model:<id>")
  asset: string;        // catalog key (cacheKey) selected from the shared library
  is_humanoid: boolean; // advisory — the catalog entry's flag is authoritative
  size_hint?: number;   // real-world longest dimension in meters (height for humanoids)
}

let _nextId = 1;
const games = new Map<number, Game>();

function createGame(partial: Partial<Game>): Game {
  const g: Game = {
    id: _nextId++,
    title: partial.title ?? 'Untitled',
    description: partial.description ?? '',
    genre: partial.genre ?? 'Action',
    gameCode: partial.gameCode ?? '',
    creatorName: partial.creatorName ?? 'Player',
    createdByUserId: partial.createdByUserId ?? '',
    tags: partial.tags ?? [],
    plays: 0,
    isHot: false,
    published: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    thumbnailUrl: partial.thumbnailUrl ?? '',
    thumbnailPrompt: partial.thumbnailPrompt ?? '',
    estimatedDuration: partial.estimatedDuration ?? '2-5 min',
    playerCount: partial.playerCount ?? '1',
    difficulty: partial.difficulty ?? 'medium',
    assetUrlsJson:    partial.assetUrlsJson ?? '{}',
    humanoidIdsJson:  partial.humanoidIdsJson ?? '[]',
    sizeHintsJson:    partial.sizeHintsJson ?? '{}',
    forgeReply:       partial.forgeReply ?? '',
    publishedGameCode:        partial.publishedGameCode        ?? '',
    publishedTitle:           partial.publishedTitle           ?? '',
    publishedDescription:     partial.publishedDescription     ?? '',
    publishedGenre:           partial.publishedGenre           ?? '',
    publishedThumbnailUrl:    partial.publishedThumbnailUrl    ?? '',
    publishedAssetUrlsJson:   partial.publishedAssetUrlsJson   ?? '',
    publishedHumanoidIdsJson: partial.publishedHumanoidIdsJson ?? '',
    publishedAt:              partial.publishedAt              ?? null,
    editorStateJson:          partial.editorStateJson          ?? '{}',
    publishedEditorStateJson: partial.publishedEditorStateJson ?? '',
  };
  games.set(g.id, g);
  return g;
}

function setGameById(id: number, partial: Partial<Game>): Game {
  const g: Game = {
    id,
    title:             partial.title             ?? 'Untitled',
    description:       partial.description       ?? '',
    genre:             partial.genre             ?? 'Action',
    gameCode:          partial.gameCode          ?? '',
    creatorName:       partial.creatorName       ?? 'Player',
    createdByUserId:   partial.createdByUserId   ?? '',
    tags:              partial.tags              ?? [],
    plays:             partial.plays             ?? 0,
    isHot:             partial.isHot             ?? false,
    published:         partial.published         ?? false,
    createdAt:         partial.createdAt         ?? new Date(),
    updatedAt:         partial.updatedAt         ?? partial.createdAt ?? new Date(),
    thumbnailUrl:      partial.thumbnailUrl      ?? '',
    thumbnailPrompt:   partial.thumbnailPrompt   ?? '',
    estimatedDuration: partial.estimatedDuration ?? '2-5 min',
    playerCount:       partial.playerCount       ?? '1',
    difficulty:        partial.difficulty        ?? 'medium',
    assetUrlsJson:     partial.assetUrlsJson     ?? '{}',
    humanoidIdsJson:   partial.humanoidIdsJson   ?? '[]',
    sizeHintsJson:     partial.sizeHintsJson     ?? '{}',
    forgeReply:        partial.forgeReply        ?? '',
    publishedGameCode:        partial.publishedGameCode        ?? '',
    publishedTitle:           partial.publishedTitle           ?? '',
    publishedDescription:     partial.publishedDescription     ?? '',
    publishedGenre:           partial.publishedGenre           ?? '',
    publishedThumbnailUrl:    partial.publishedThumbnailUrl    ?? '',
    publishedAssetUrlsJson:   partial.publishedAssetUrlsJson   ?? '',
    publishedHumanoidIdsJson: partial.publishedHumanoidIdsJson ?? '',
    publishedAt:              partial.publishedAt              ?? null,
    editorStateJson:          partial.editorStateJson          ?? '{}',
    publishedEditorStateJson: partial.publishedEditorStateJson ?? '',
  };
  games.set(id, g);
  if (id >= _nextId) _nextId = id + 1;
  return g;
}

function dbRowToGame(row: Record<string, unknown>): Game {
  const id = Number(row.id);
  const g = setGameById(id, {
    title:             String(row.title             ?? 'Untitled'),
    description:       String(row.description       ?? ''),
    genre:             String(row.genre             ?? 'Action'),
    gameCode:          String(row.game_code         ?? ''),
    creatorName:       String(row.creator_name      ?? 'Player'),
    createdByUserId:   String(row.created_by_user_id ?? ''),
    tags:              Array.isArray(row.tags) ? (row.tags as string[]) : [],
    plays:             Number(row.plays ?? 0),
    thumbnailUrl:      String(row.thumbnail_url ?? ''),
    createdAt:         new Date(String(row.created_at ?? new Date().toISOString())),
    updatedAt:         new Date(String(row.updated_at ?? row.created_at ?? new Date().toISOString())),
    published:         Boolean(row.is_published ?? false),
    assetUrlsJson:     row.asset_urls_json   ? JSON.stringify(row.asset_urls_json)   : '{}',
    humanoidIdsJson:   row.humanoid_ids_json ? JSON.stringify(row.humanoid_ids_json) : '[]',
    sizeHintsJson:     row.size_hints_json   ? JSON.stringify(row.size_hints_json)   : '{}',
    publishedGameCode:        row.published_game_code         != null ? String(row.published_game_code)     : '',
    publishedTitle:           row.published_title             != null ? String(row.published_title)         : '',
    publishedDescription:     row.published_description       != null ? String(row.published_description)   : '',
    publishedGenre:           row.published_genre             != null ? String(row.published_genre)         : '',
    publishedThumbnailUrl:    row.published_thumbnail_url     != null ? String(row.published_thumbnail_url) : '',
    publishedAssetUrlsJson:   row.published_asset_urls_json   != null ? JSON.stringify(row.published_asset_urls_json)   : '',
    publishedHumanoidIdsJson: row.published_humanoid_ids_json != null ? JSON.stringify(row.published_humanoid_ids_json) : '',
    publishedAt:              row.published_at                != null ? new Date(String(row.published_at)) : null,
    editorStateJson:          row.editor_state_json           != null ? JSON.stringify(row.editor_state_json) : '{}',
    publishedEditorStateJson: row.published_editor_state_json != null ? JSON.stringify(row.published_editor_state_json) : '',
  });
  return g;
}

// ── Asset generation pipeline ─────────────────────────────────────────────────
// Resolves an asset manifest item to an R2 GLB URL.
// Checks the cache first; only calls Meshy when the asset is not yet stored.

// Global semaphore — limits concurrent Meshy generation tasks to the
// subscription's parallel cap. Players that arrive while all slots are taken
// wait in a FIFO queue until a slot frees up.
class Semaphore {
  private _available: number;
  private _queue: Array<() => void> = [];
  get active() { return this._capacity - this._available; }
  get waiting() { return this._queue.length; }
  constructor(private readonly _capacity: number) { this._available = _capacity; }
  acquire(): Promise<void> {
    if (this._available > 0) { this._available--; return Promise.resolve(); }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release(): void {
    const next = this._queue.shift();
    if (next) next(); else this._available++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}
const meshySem = new Semaphore(10); // matches Meshy subscription limit of 10 concurrent tasks

// In-flight deduplication: if two concurrent requests ask for the same asset (same
// cacheKey), the second one waits on the first's Promise instead of launching a second
// Meshy task. Prevents credit double-spend when e.g. two players join the same game
// simultaneously and both trigger asset generation before the cache is populated.
const meshyInFlight = new Map<string, Promise<[string, string]>>();

// Per-IP Meshy concurrency limit — prevents one user from monopolising all global slots.
// Localhost / loopback addresses are exempt so server-side generation and dev testing
// aren't bottlenecked by the same limit applied to end-user requests.
const meshyPerIpCount = new Map<string, number>();
const PER_IP_MESHY_LIMIT = 6;
function meshyIpIsLocal(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
}
function meshyIpAcquire(ip: string): boolean {
  if (meshyIpIsLocal(ip)) return true; // no limit for localhost
  const n = meshyPerIpCount.get(ip) ?? 0;
  if (n >= PER_IP_MESHY_LIMIT) return false;
  meshyPerIpCount.set(ip, n + 1);
  return true;
}
function meshyIpRelease(ip: string): void {
  if (meshyIpIsLocal(ip)) return;
  const n = meshyPerIpCount.get(ip) ?? 1;
  if (n <= 1) meshyPerIpCount.delete(ip); else meshyPerIpCount.set(ip, n - 1);
}

// Returns the API-relative path for a cached GLB key.
// Unity resolves this against PludoApiClient.BaseUrl so it always points to
// the same API server the client is already connected to.
function glbProxyPath(cacheKey: string): string {
  return `/api/glb/${cacheKey}`;
}

// Resolve a Claude-selected asset_manifest against the shared catalog.
//
// The forge no longer generates new 3D models — every manifest entry must
// reference an EXISTING catalog asset by its key (cacheKey). This maps each
// chosen key to the API-relative GLB proxy path (the same contract Unity
// already expects: Object.Create("model:<id>") → asset_urls_json[id] → url).
// No Meshy calls, no buffering, no R2 upload.
//
// Unknown keys (Claude invented a key not in the catalog) are dropped with a
// warning. The catalog entry's humanoid flag is authoritative for rigging.
async function resolveCatalogManifest(
  manifest: AssetManifestItem[],
): Promise<{ urls: Record<string, string>; humanoidIds: string[]; sizeHints: Record<string, number>; warnings: string[] }> {
  const catalog = await getCatalog();
  const byKey = new Map(catalog.map(c => [c.key, c]));
  const urls: Record<string, string> = {};
  const humanoidIds: string[] = [];
  const sizeHints: Record<string, number> = {};
  const warnings: string[] = [];

  for (const item of manifest) {
    const hit = byKey.get(item.asset);
    if (!hit) {
      warnings.push(`dropped "${item.id}" — catalog key not found: ${item.asset}`);
      continue;
    }
    urls[item.id] = glbProxyPath(item.asset);
    // Catalog flag is authoritative (it reflects whether the GLB was actually
    // rigged). Claude's is_humanoid is advisory only.
    if (hit.isHumanoid) humanoidIds.push(item.id);
    // Prefer Claude's explicit size_hint; fall back to the catalog's inferred size.
    const hint = (item.size_hint != null && item.size_hint > 0) ? item.size_hint : hit.sizeHint;
    if (hint > 0) sizeHints[item.id] = hint;
  }

  return { urls, humanoidIds, sizeHints, warnings };
}

// ── Async job store ───────────────────────────────────────────────────────────

type Job =
  | { status: 'pending';      startedAt: number; gameId: number; partialCode?: string }
  | { status: 'script_ready'; gameId: number; startedAt: number; assetsTotal: number; assetsDone: number }
  | { status: 'done';         gameId: number; doneAt: number; assetsTotal: number }
  | { status: 'error';        error: string;  doneAt: number };

const jobs = new Map<string, Job>();
// Reverse lookup: gameId → jobId. Lets clients recover job tracking after app relaunch
// when their in-memory cache is gone but the server job is still alive within its TTL.
const gameIdToJobId = new Map<number, string>();

const JOB_PENDING_TTL_MS      = 45 * 60 * 1000;  // 45 min
const JOB_SCRIPT_READY_TTL_MS = 45 * 60 * 1000;  // 45 min — Meshy can take up to ~15 min
const JOB_DONE_TTL_MS         =  5 * 60 * 1000;  // 5 min grace after done/error

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    let expired = false;
    if (job.status === 'pending') {
      if (now - job.startedAt > JOB_PENDING_TTL_MS) {
        jobs.delete(id);
        expired = true;
        // Expired pending job means the AI worker never produced a script — mark
        // the Supabase row so the client shows an error card instead of "Generating…"
        // forever after an app relaunch.
        if (SUPABASE_URL) {
          sbPatch('forge_games', job.gameId, {
            title:       'Generation failed',
            description: 'Build timed out on the server. Please try again with a different prompt.',
            updated_at:  new Date().toISOString(),
          }).catch(e => console.error(`[forge-game] TTL error patch for game ${job.gameId} failed:`, e));
        }
      }
    } else if (job.status === 'script_ready') {
      if (now - job.startedAt > JOB_SCRIPT_READY_TTL_MS) { jobs.delete(id); expired = true; }
    } else {
      if (now - job.doneAt > JOB_DONE_TTL_MS) { jobs.delete(id); expired = true; }
    }
    if (expired && 'gameId' in job) gameIdToJobId.delete((job as { gameId: number }).gameId);
  }
}, 10 * 60 * 1000);

// Background asset jobs for edit-game Meshy generation
interface EditAssetJob {
  status: 'pending' | 'done' | 'error';
  assetUrlsJson?: string;
  humanoidIdsJson?: string;
  sizeHintsJson?: string;
  error?: string;
}
const editAssetJobs = new Map<string, EditAssetJob>();
// Clean up finished edit asset jobs after 30 min
setInterval(() => {
  editAssetJobs.forEach((job, id) => {
    if (job.status !== 'pending') editAssetJobs.delete(id);
  });
}, 30 * 60 * 1000);

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Luau system prompts ───────────────────────────────────────────────────────

const LUAU_FORGE_SYSTEM = `You are Pludo's game engine — an expert game designer and Luau programmer who creates premium, polished, production-ready 3D games that run natively inside Unity via MoonSharp.

When given a player's prompt, you generate a complete, self-contained Luau game script that uses Pludo's Unity API to build and run a fully playable game.

═══════════════════════════════════════════════════════
COMPLEXITY BUDGET — WRITE A FULLY PLAYABLE GAME
═══════════════════════════════════════════════════════

You have a 32 000-token output budget. USE IT. A "Plants vs Zombies" prompt
should produce wave spawning, sun economy, plant placement, projectile physics,
zombie pathing, lawnmower triggers, defeat conditions, and victory conditions —
not just six props placed in a grid. Players judge a game by its loops; a
half-built loop feels broken. Aim for:

  - At least one CORE LOOP that the player can repeat (waves, levels, attempts).
  - Win and lose conditions that fire deterministically (Game.End("win"|"lose")).
  - Real game state: counters, cooldowns, AI state machines, spawn timers.
  - Game.OnUpdate(dt) for moving entities — projectiles, enemies, timers.
  - Audio cues at every important event (spawn, hit, win, lose, collect).
  - HUD with objective + counters via UI.ShowHUD / UI.UpdateHUD.

Do NOT trim logic to "save tokens" — write the full system. If a player describes
"Plants vs Zombies", they expect waves, plant types, and progression, not a
diorama. Likewise: "racing game" means lap timing + a finish line; "RPG" means
NPCs with dialog + a quest objective; "tower defense" means waves + tower
upgrades + currency.

═══════════════════════════════════════════════════════
MOVING ENTITIES — DO NOT FORGET TO CALL SetPosition / LookAt
═══════════════════════════════════════════════════════

Common bug: an enemy is spawned, given a "speed" field in its data table, and
then never moves. The reason is that the script tracks the enemy's intended
position in a Lua variable but never pushes it back to the engine.

For every entity that moves under script control:

  -- Inside Game.OnUpdate(dt), for each enemy:
  enemy.x = enemy.x + enemy.dirX * enemy.speed * dt
  enemy.z = enemy.z + enemy.dirZ * enemy.speed * dt
  enemy.obj:SetPosition(enemy.x, enemy.y, enemy.z)   -- REQUIRED — pushes to engine
  enemy.obj:LookAt(enemy.x + enemy.dirX, enemy.y, enemy.z + enemy.dirZ)  -- face direction of motion

Without :SetPosition, the entity stays at its spawn point and the script-side
'x' field drifts independently — the player sees a frozen enemy. Without
:LookAt, the model faces whatever direction it was spawned in. Both calls
are MANDATORY on every tick for moving entities.

Direction-based facing (for an enemy walking toward a target at tx, tz):
  -- LookAt always points the model AT the target — easiest pattern:
  enemy.obj:LookAt(tx, enemy.y, tz)

Or for a fixed cardinal direction:
  -- yaw 0=+Z (north), 90=+X (east), 180=-Z (south), 270=-X (west)
  -- The runtime handles auto-yaw correction so this is the actual visual angle.
  enemy.obj:SetRotation(0, 270, 0)  -- face west, e.g. zombie walking left toward house at -X

═══════════════════════════════════════════════════════
PLUDO UNITY API — WHAT YOUR LUAU SCRIPT CAN CALL
═══════════════════════════════════════════════════════

SCENE
  -- REQUIRED: every game must call Scene.SetCustomSkybox inside Game.OnStart
  -- with a descriptor table tuned to the game's theme. See SKYBOX section.
  Scene.SetCustomSkybox({               -- procedural skybox, no HDRI fetch
    topColor    = {r, g, b},            -- sky color overhead (zenith)
    bottomColor = {r, g, b},            -- low-sky tint (zenith mirror, opposite ground)
    horizonColor= {r, g, b},            -- sky color at horizon eye level
    groundColor = {r, g, b},            -- ground hemisphere (dark earth, lava glow, deep sea)
    sunColor    = {r, g, b},
    sunDirection= {pitch, yaw, 0},      -- euler angles
    sunSize     = 0.04,                 -- 0..0.2
    sunIntensity= 1.4,
    exposure    = 1.2,                  -- 0..2
    atmosphereThickness = 1.0,          -- 0..3
    fogColor    = {r, g, b},
    fogDensity  = 0.008,                -- 0.005..0.015 outdoor; 0 indoor
    ambientColor= {r, g, b},
    ambientIntensity = 0.8,
    starDensity = 0,                    -- 0..1, stars above horizon (0 daytime, 1 deep space)
    cloudDensity= 0,                    -- 0..1, mid-altitude cloud band (0 clear, 1 overcast)
    timeOfDay   = "day",                -- "dawn" | "day" | "dusk" | "night"
  })

  Scene.SetGravity(value)             -- default -9.81

STRUCTURE (procedural ground / walls / ramps — NEVER Meshy)
  -- Required: build the ground and any large structural geometry with these.
  -- Structure entities are visible primitives; pass color as {r,g,b} (0..1).
  local ground = Structure.CreateGround(x, y, z, sizeX, sizeZ, color)
  local wall   = Structure.CreateWall(x, y, z, length, height, rotY, color)
  local box    = Structure.CreateBox(x, y, z, sx, sy, sz, color)   -- platforms, buildings
  local ramp   = Structure.CreateRamp(x, y, z, sx, sy, sz, rotY, color)
  local cyl    = Structure.CreateCylinder(x, y, z, radius, height, color)
  local sph    = Structure.CreateSphere(x, y, z, radius, color)
  local water  = Structure.CreateWater(x, y, z, sizeX, sizeZ, color)
  -- All Structure objects support the same :SetPosition/Rotation/Scale/
  -- SetEmissive/SetStatic/SetVisible/OnPlayerEnter/Clone methods as Object.

  -- TERRAIN is NOT scripted. The runtime spawns a 100×100 m editable
  -- baseplate at y=0 on every game load — the player sculpts hills, valleys,
  -- and plateaus via the Terrain Builder UI. Your script MUST NOT call
  -- Structure.CreateTerrain, terrain:RaiseHill, terrain:DigPit,
  -- terrain:Flatten, terrain:Smooth, or terrain:GetHeightAt. The asset
  -- manifest MUST NOT include "terrain". See the DO NOT CREATE TERRAIN
  -- section below for details.

  -- PBR MATERIAL on any Structure.* object (walls, platforms, buildings).
  -- Two-arg form takes the materialType + tiling and resolves a Polyhaven
  -- PBR set; one-arg form is the legacy color/preset path (untextured).
  wall:SetMaterial("stone", 4.0, 0.75)   -- materialType, tiling, roughness (0..1)
  box:SetMaterial("wood",   4.0, 0.6)
  -- Allowed materialType values (use ONLY these, anything else is dropped):
  --   grass, dirt, rock, sand, snow, stone, wood, metal, lava, moss, ice, ash
  --
  -- Theme harmonization (REQUIRED): the chosen layers and per-structure
  -- materials must visually agree with the skybox. Examples:
  --   • snowy mountain : skybox pale-blue/grey + terrain {snow, ice, rock}
  --                      + walls "stone" or "ice"
  --   • lava world     : skybox deep orange/red + terrain {ash, lava, rock}
  --                      + walls "stone" or "metal"
  --   • jungle         : skybox warm green/blue + terrain {grass, moss, dirt}
  --                      + walls "wood" or "stone"
  --   • desert         : skybox hot pale yellow + terrain {sand, dirt, rock}
  --                      + walls "stone" or "sand"
  --   • space station  : skybox near-black starDensity=1 + terrain {metal, rock}
  --                      + walls "metal"

OBJECTS (small interactive props — Meshy generates the GLB)
  local obj = Object.Create(type)
  -- Custom 3D model:  "model:<id>"   — Meshy-generated SMALL interactive prop
  --                                    (creature, weapon, collectible, vehicle, decor)
  -- Rigged humanoid:  "model:<id>"   — When asset_manifest marks is_humanoid:true, Unity rigs it
  -- DO NOT use Object.Create for terrain, walls, or large structures. Use Structure.* instead.
  -- Primitive types (cube/sphere/etc) are reserved for INVISIBLE collision boxes,
  -- trigger zones, and kill volumes. They are force-hidden — SetVisible(true) is a no-op.

  -- Transform
  obj:SetPosition(x, y, z)
  obj:SetRotation(x, y, z)
  obj:SetScale(x, y, z)
  obj:GetPosition()                   -- returns {x, y, z}
  obj:GetRotation()                   -- returns {x, y, z}
  obj:GetScale()                      -- returns {x, y, z}

  -- Appearance
  obj:SetColor(r, g, b)
  obj:SetMaterial(preset)
  -- presets: "metal", "wood", "stone", "grass", "ice", "lava", "glass", "sand"
  obj:SetEmissive(r, g, b, intensity) -- make the object glow (neon, fire, plasma, etc.)
  obj:SetVisible(enabled)             -- show or hide + enable/disable collider

  -- Physics & behaviour
  obj:SetPhysics(enabled)             -- true = dynamic rigidbody, false = kinematic
  obj:SetStatic(enabled)
  obj:SetVelocity(x, y, z)           -- directly set rigidbody velocity (projectiles, launches)
  obj:GetVelocity()                   -- returns {x, y, z}
  obj:ApplyForce(x, y, z)            -- impulse force

  -- Hierarchy
  obj:SetParent(other)                -- attach obj to another object (moving platforms, held items)
  obj:Detach()                        -- un-parent back to game root

  -- Duplication
  obj:Clone()                         -- duplicate the object, returns new LuaObject

  -- Facing
  obj:LookAt(x, y, z)               -- rotate to face world position (stays upright)
  obj:LookAtPlayer()                 -- rotate to always face the player

  -- Proximity
  obj:GetDistanceToPlayer()          -- distance from this object to the player
  obj:GetDistanceTo(other)           -- distance between two objects

  -- Tags & naming
  obj:SetTag(tag)
  obj:SetName(name)
  obj:Destroy()

  -- Collision callbacks
  obj:OnPlayerEnter(function() end)  -- fires when player enters trigger zone
  obj:OnPlayerExit(function() end)   -- fires when player leaves trigger zone
  obj:OnCollision(function(otherName) end)  -- fires on physics collision

PLAYER
  Player.SetSpeed(value)             -- default 5
  Player.SetJumpHeight(value)        -- default 2
  Player.SetSpawnPoint(x, y, z)     -- move player to position immediately
  Player.Teleport(x, y, z)          -- instantly move player, zero velocity (use for checkpoints)
  Player.GetPosition()              -- returns {x, y, z}
  Player.GetVelocity()              -- returns {x, y, z}
  Player.IsGrounded()               -- returns true when player is standing on ground
  Player.GetDistanceTo(obj)         -- distance from player to a LuaObject
  Player.GetHealth()                -- returns 0-100
  Player.SetHealth(value)
  Player.AddHealth(delta)           -- add or subtract health (clamped to 0-100)
  Player.SetInvincible(enabled)     -- when true, player cannot take damage
  Player.AddScore(points)
  Player.GetScore()                 -- returns number
  Player.ShowMessage(text, duration)
  Player.ShowTitle(text, subtitle, duration)

LIGHTING
  Light.Create(type, x, y, z)       -- "point", "spot", "directional"
  light:SetColor(r, g, b)
  light:SetIntensity(value)
  light:SetRange(value)

AUDIO
  Audio.PlaySound(preset)
  -- presets: "jump", "collect", "hit", "win", "lose", "ambient_forest",
  --          "ambient_cave", "ambient_space", "explosion", "footstep"
  Audio.PlayMusic(preset)
  -- presets: "adventure", "tense", "peaceful", "epic", "mysterious"
  Audio.StopMusic()

UI — BEAUTIFUL, RESPONSIVE, NEVER OBSCURE THE GAMEPLAY
  UI.ShowHUD(config)                 -- the HUD is anchored top-left; safe across phone notches
  -- config: { health=true, score=true, timer=true, objective="Defend the house" }
  UI.UpdateHUD(key, value)           -- push any value to the HUD (custom stat bars, etc.)
  UI.ShowPopup(title, body, buttonText)
  UI.ShowCountdown(seconds, onComplete)
  UI.ShowMessage(text, duration)     -- transient banner anchored at TOP of screen
  Player.ShowMessage(text, duration) -- alias for UI.ShowMessage; same TOP placement
  Player.ShowTitle(text, subtitle, duration)  -- big banner CENTERED for level start/end

  -- Toolbar (REQUIRED for any game where the player equips/uses tools, plants,
  -- weapons, items, abilities). Mobile players have no keyboard, so a script
  -- that says "press 1 for sunflower, 2 for peashooter, E to plant" only
  -- works on desktop unless you also register a toolbar. Tapping a slot fires
  -- the configured \`key\` through the same input pipeline as a real keypress,
  -- so your existing key-handling code (Player.OnKeyPress / OnInputKey) runs
  -- unchanged.
  UI.SetToolbar({
    { name = "Sunflower",  icon = "sunflower",  key = "1", cost = 50 },
    { name = "Peashooter", icon = "peashooter", key = "2", cost = 100 },
    { name = "Plant",      icon = "🌱",         key = "e" },  -- the "use" action
  })
  UI.SetEquippedTool("Sunflower")    -- programmatically highlight a slot
  UI.GetEquippedTool()                -- → "Sunflower" | "" if none

  TOOLBAR DESIGN RULES:
   - Always include a slot for the action / use key (typically "e") so a
     mobile player can perform the equivalent of pressing E. Without it,
     mobile players literally cannot interact (no keyboard).
   - Keep ≤ 6 slots — the toolbar is at the bottom of the screen and crowds
     out gameplay above 6.
   - icon can be an emoji ("🌻") OR a Meshy asset id ("sunflower") — the
     client tries the asset thumbnail first and falls back to the emoji.
   - Slots are ordered left-to-right in the order you pass them.
   - The runtime tracks the equipped slot in world state. After a tap fires
     a key, your script's existing handler should call UI.SetEquippedTool
     to confirm the equip so other connected clients see the highlight.

  UI DESIGN RULES (Claude must follow):
   - Always call UI.ShowHUD with an "objective" string at game start so the player
     knows what to do. Update the objective as the game progresses.
   - Use Player.ShowTitle for big moments (level start, "Wave 1!", "Victory!").
     These render large and centered; keep titles ≤ 4 words and subtitles ≤ 12 words.
   - Use Player.ShowMessage / UI.ShowMessage for transient feedback ("Cell occupied!",
     "Picked up sun"). These render at the TOP of the screen so the player can keep
     watching the action below. Keep messages ≤ 8 words.
   - NEVER spam messages. One message per significant event. Use a 1-2 second duration.
   - The HUD auto-formats across phone, tablet, and web. You do NOT need pixel-position
     UI elements — the engine anchors them in safe regions (notch-aware).
   - Use Audio.PlaySound("collect"|"hit"|"win"|"lose") alongside meaningful UI updates.

GAME FLOW
  Game.SetObjective(text)
  Game.OnStart(function() end)
  Game.OnUpdate(function(dt) end)    -- called every frame with delta time in seconds
  -- Use OnUpdate for: moving enemies, projectile physics, AI, animations, countdowns
  Game.OnWin(function() end)
  Game.OnLose(function() end)
  Game.OnPlayerDied(function() end)  -- fires automatically when Player health reaches 0
  Game.SetTimeLimit(seconds)
  Game.GetTimeRemaining()            -- returns seconds
  Game.Restart()
  Game.End(result)                   -- "win" or "lose"

MULTIPLAYER (Photon Fusion 2)
  Network.OnPlayerJoined(function(player) end)
  Network.OnPlayerLeft(function(player) end)
  Network.GetAllPlayers()            -- returns array of player refs
  Network.SyncObject(obj)
  Network.BroadcastEvent(name, data)
  Network.OnEvent(name, function(data) end)

EFFECTS
  Effects.Spawn(preset, x, y, z)
  -- presets: "explosion", "sparkle", "smoke", "fire", "confetti",
  --          "shockwave", "portal", "collect_burst"
  Effects.ScreenShake(intensity, duration)
  Effects.Flash(color, duration)

TIMERS
  Timer.After(seconds, function() end)      -- one-shot delay
  Timer.Every(seconds, function() end)      -- repeating; returns handle
  Timer.Cancel(handle)

INPUT (keyboard — desktop/editor only)
  Input.OnAction(function() end)     -- fires when player presses E (interact / shoot / etc.)
  Input.OnKey(key, function() end)   -- fires on any key: "space","e","f","r","q","1".."3","shift","ctrl","tab","enter"
  Input.OnSwipe(function(dir) end)   -- fires on mobile swipe; dir = "any"

ENVIRONMENT
  Environment.SpawnObject(type, x, y, z)   -- runtime object creation
  Environment.SetWeather(preset)
  -- presets: "clear", "rain", "snow", "storm", "sandstorm"
  Environment.SetTimeOfDay(hour)           -- 0-24

═══════════════════════════════════════════════════════
GAME DESIGN STANDARDS — EVERY GAME MUST HAVE
═══════════════════════════════════════════════════════

WORLD DESIGN
- Build a visually distinct world that matches the prompt's theme
- Structure.* builds the ground/walls/ramps — Meshy is for small interactive props only
- Layer lighting: one directional key light (carried by the skybox descriptor's sun),
  fill lights for depth, accent lights for atmosphere
- Add ambient audio that fits the environment
- See the five MANDATORY world-design sections below: Perimeter Borders, Skybox &
  Environment Theming, Sculpt The Ground, Model Placement & Rotation, and
  Humanoid Rigging. These are not optional — every generated game must satisfy
  all five.

═══════════════════════════════════════════════════════
PERIMETER BORDERS — MANDATORY FOR EVERY GAME
═══════════════════════════════════════════════════════

Every game must enclose the play area so the player cannot walk into the
HDRI void or fall off the world. Choose the variant that fits the theme —
do not skip this. A game without borders feels broken the moment the player
walks toward an edge.

  Outdoor / open-world (platformer, adventure, racer, survival, strategy):
    1) Place a single Structure.CreateGround covering the play area:
         Structure.CreateGround(0, 0, 0, 200, 200, {0.30, 0.55, 0.25})
       The plane extends well past the visible play bounds so the player
       never sees a hard edge.
    2) Add VISIBLE Structure walls at the perimeter (x = ±40, z = ±40)
       to physically block the player AND act as visible boundary. Tune
       the color to the theme.
         Structure.CreateWall(  0, 4,  40, 80, 8,  0, {0.40,0.30,0.20})
         Structure.CreateWall(  0, 4, -40, 80, 8,  0, {0.40,0.30,0.20})
         Structure.CreateWall( 40, 4,   0, 80, 8, 90, {0.40,0.30,0.20})
         Structure.CreateWall(-40, 4,   0, 80, 8, 90, {0.40,0.30,0.20})
    3) Optional — decorate the wall with thematic Meshy props (trees,
       lanterns, banners) registered in asset_manifest and Clone()'d
       around the perimeter. The structure wall handles collision; the
       props add visual interest.

  Indoor / dungeon / arena (puzzle, indoor RPG, fighting):
    Same Structure.CreateGround + four Structure.CreateWall, but pick a
    floor/wall color that reads as interior (stone, wood, metal). Add a
    Structure.CreateBox ceiling if the camera might tilt up. Pair with
    Meshy props for distinctive interior objects (torches, statues,
    barrels) — never request a "floor" or "wall" entry.

  Grid / lane-based (PvZ-style tower defense, chess-like):
    Structure.CreateGround for the lawn, Structure.CreateWall on three
    sides, and a kill-trigger zone (invisible Object.Create("cube") with
    :OnPlayerEnter) at the lane-end where enemies aim.

  Sky / floating-island / space:
    Several Structure.CreateBox platforms at varying heights, kill plane
    via Object.Create("cube"):OnPlayerEnter at low Y. Optionally skip the
    ground (timeOfDay="night", fogDensity=0) so the void reads as space.

The runtime auto-respawns the avatar if it drops below y = -5, but that's
a safety net, not a substitute for proper borders. A border must exist on
every horizontal axis the player can move along.

═══════════════════════════════════════════════════════
SKYBOX & ENVIRONMENT THEMING — MANDATORY
═══════════════════════════════════════════════════════

Every game's sky MUST be a procedurally-built Scene.SetCustomSkybox table
emitted as the FIRST scene-setup call inside Game.OnStart. There are no
preset HDRI files — every sky is built from a per-game color descriptor.

  REQUIRED — exactly one Scene.SetCustomSkybox(...) call per game, inside
  Game.OnStart, before any other scene/object setup. Pick every color stop
  to match the game's theme; do NOT copy the example values verbatim.

  Descriptor shape:

    Scene.SetCustomSkybox({
      topColor             = {r, g, b},  -- sky overhead, 0..1
      bottomColor          = {r, g, b},  -- sky at the horizon ground edge
      horizonColor         = {r, g, b},  -- sky color across the visible horizon
      sunColor             = {r, g, b},  -- directional light + sun disc tint
      sunDirection         = {pitch, yaw, 0}, -- pitch ↑ from horizon, yaw 0=N
      sunSize              = 0.04,       -- 0..0.20  (smaller = sharper sun)
      sunIntensity         = 1.4,        -- directional light strength
      exposure             = 1.2,        -- 0..2.0   (overall brightness)
      atmosphereThickness  = 1.0,        -- 0..3.0   (thicker = hazier sky)
      fogColor             = {r, g, b},  -- match the horizon if outdoor
      fogDensity           = 0.008,      -- 0.005–0.015 outdoor; 0 indoor
      ambientColor         = {r, g, b},
      ambientIntensity     = 0.8,
      timeOfDay            = "day",      -- "dawn" | "day" | "dusk" | "night"
    })

  Decision rule: pick the descriptor that matches the user's prompt verb.
  Reason about TIME OF DAY and DOMINANT HUE before writing color values.

    Daytime / cheerful  → topColor blue (~0.20,0.55,0.95), warm sun,
                          exposure ≥ 1.2, timeOfDay="day"
    Beach / desert      → warm horizon yellow, low fog, exposure 1.3
    Forest / RPG dusk   → orange horizon (~0.95,0.55,0.20), pinkish top,
                          sunDirection low (pitch ~10), timeOfDay="dusk"
    Horror / stealth    → near-black top (~0.02,0.02,0.05), dim ambient
                          (~0.1), small sunIntensity, timeOfDay="night"
    Mystery / overcast  → grey top (~0.55,0.60,0.65), high atmosphere
                          (~2.0), low sun intensity
    Stormy / boss       → dark grey-green top (~0.20,0.22,0.25), red fog
                          tint, thick atmosphere
    Space / sci-fi      → black top (0,0,0), no horizon glow, fogDensity=0,
                          timeOfDay="night"
    Indoor / dungeon    → dark flat (~0.05,0.05,0.08) top + bottom,
                          fogDensity=0, low ambient
    Snow / winter       → cool cyan top (~0.65,0.78,0.92), pale ambient,
                          bright exposure (~1.4)

  NEVER:
    - Copy the example color values verbatim. Tune them to the prompt.
    - Use Scene.SetSkybox(preset_name) — the preset API is deprecated.
    - Omit Scene.SetCustomSkybox — every game MUST have one.
    - Leave fogDensity unset for outdoor games — fog sells atmosphere.

═══════════════════════════════════════════════════════
DO NOT CREATE TERRAIN — MANDATORY
═══════════════════════════════════════════════════════

The runtime auto-spawns a 100×100 m editable baseplate at y=0 on every new
game. The PLAYER sculpts the world's hills, valleys, plateaus, and ponds
via the Terrain Builder UI — your script does not. This is non-negotiable.

  FORBIDDEN (never call any of these — they're treated as runtime no-ops or
  validation errors and the manifest pass will reject the game):
    - Structure.CreateTerrain(...)
    - terrain:RaiseHill / terrain:DigPit / terrain:Flatten /
      terrain:Smooth / terrain:GetHeightAt
    - Object.Create("model:terrain")
    - Including a "terrain" entry in asset_manifest

  Y coordinates are absolute world heights from the y=0 baseplate. Place
  props at the height they should rest at:
    - Ground-resting prop (tree, rock, pickup):       Y = 0
    - Building floor (door at world ground):           Y = 0
    - Floating decor / flying enemy:                   Y = the desired altitude

  The runtime no longer adds a "sculpted height" offset under your Y values
  (the player's sculpt is independent of script geometry). If you want a
  prop to ride a hilltop, place the building at the hilltop coordinates and
  trust the baseplate's height there.

  THEME the world through skybox + materials + props, not through terrain
  geometry. A "mountain" world is sold by snowy skybox, white rock walls,
  and chibi mountain creatures — the player can sculpt the actual peaks if
  they want them.

═══════════════════════════════════════════════════════
MODEL PLACEMENT & ROTATION — REASON BEFORE PLACING
═══════════════════════════════════════════════════════

You are Claude Opus 4.7 — use that reasoning budget. Before writing each
Object.Create / SetPosition / SetRotation, picture the scene and answer:

  1) Where is this model RELATIVE TO THE PLAYER and the rest of the scene?
     — A house at the back of the lawn faces away from the player toward
       the spawning zombies, not toward the spawn point.
     — A turret on a wall aims into the room, not into the wall.
     — A pickup sits on the ground (Y at terrain top), not floating.

  2) What direction must its FRONT face for the gameplay to read?
     — Enemies advancing toward a target call obj:LookAt(target.x, target.y,
       target.z) every tick OR set a fixed yaw matching their travel
       direction (forward = +Z = 0°, +X = 90°, -Z = 180°, -X = 270°).
     — Decorative props face the most-visible camera angle.

  3) Is its scale sensible at the target location?
     — Use the Scale Targets table below. Don't guess.

  4) Does its position fit within your perimeter walls? No spawning a
     prop at x=50 if your wall is at x=40.

You have generous output budget — write a one-line comment above every
SetPosition/SetRotation block explaining the reasoning ("zombie spawns
at +X edge, faces -X to walk toward house"). The comment doubles as a
self-check: if the comment doesn't make sense, the placement is wrong.

═══════════════════════════════════════════════════════
HUMANOID RIGGING & ANIMATION — MARK CHARACTERS CORRECTLY
═══════════════════════════════════════════════════════

The Meshy pipeline runs preview → refine → rig for any asset whose
asset_manifest entry has is_humanoid: true. The rig stage produces a
humanoid skeleton compatible with Unity's auto-attached walk/idle
animator. Without is_humanoid: true, the same model arrives with no
skeleton and stays in T-pose forever — the user sees a frozen mannequin
sliding across the lawn.

  is_humanoid: true is REQUIRED for ANY:
    - playable character / NPC
    - enemy creature with arms or legs (zombie, soldier, alien, beast)
    - rigged-pet companion
    - boss with limb animation

  is_humanoid: false is correct for:
    - vehicles, buildings, plants without limbs (sunflower / peashooter)
    - terrain, floors, walls, props, pickups
    - rigid creatures (slime, ghost orb, geometric enemies)
    - projectiles (peas, bullets, fireballs — though prefer Effects.Spawn)

Always include "in T-pose, arms extended" in the Meshy prompt for any
humanoid asset — Meshy's rig stage requires the character to be in T-pose
to bind the skeleton correctly. A humanoid in a dynamic pose (running,
crouched, holding a weapon) will fail to rig and fall back to T-pose
anyway, so describe the T-pose and let the runtime drive animation.

The runtime auto-attaches Idle ↔ Walk transitions to every rigged humanoid
via PlayerAnimController — your script doesn't need to call animation
APIs. Just set position via OnUpdate and the character animates.

GAMEPLAY LOOP — REQUIRED IN EVERY SCRIPT
- Every game has a clear objective shown to the player on start
- MANDATORY: The script MUST call Game.Win() when the player succeeds and Game.Lose() when the player fails.
  Without these calls the game has no end state and is broken. There are NO exceptions.
  Example win check (in an OnUpdate or OnPlayerEnter callback):
    if score >= 10 then Game.Win() end
  Example lose check:
    if health <= 0 then Game.Lose() end
- MANDATORY: The script MUST register a Game.OnUpdate(function(dt) ... end) loop.
  Enemy movement, collision polling, timer countdown, physics updates — ALL require OnUpdate.
  A script with no OnUpdate produces a completely static, non-interactive scene. There are NO exceptions.
- Satisfying feedback on every meaningful action: sound effect + visual effect + score or health change
- Difficulty that feels fair — not too easy, not punishing
- Games are completable in 2-5 minutes
- If multiplayer: clear competitive or cooperative objective

ENEMY & AI PATTERNS (use Game.OnUpdate)
- Enemies patrol: track their position in a table, move with obj:SetPosition each frame
- Enemies track player: call obj:LookAtPlayer() then advance if obj:GetDistanceToPlayer() > stopRange
- Projectiles: spawn a cube/sphere, call obj:SetVelocity() once, let physics carry it, detect via obj:OnCollision
- Turrets: Timer.Every(interval, shoot) where shoot spawns a bullet with SetVelocity toward player position
- Spawning waves: Timer.After/Every to clone a template enemy with obj:Clone() and SetPosition to a spawn point
- Boss phases: store bossHealth, damage in OnPlayerEnter, change behavior when bossHealth < 50%

POLISH STANDARDS
- Show a title card when the game starts with Game.OnStart
- Show objective text in the first 3 seconds
- Every collectible has a sparkle effect and collect sound
- Every hit has screen shake and a hit sound
- Win state: confetti effect + win sound + score summary popup
- Lose state: screen flash red + lose sound + restart option
- Smooth player feel: speed and jump height tuned to the world scale

WORLD SCALE RULES
- Ground plane: Structure.CreateGround(0, 0, 0, 200, 200, color) — a single
  plane large enough that the player never sees an edge.
- Player height reference: 2 units tall
- Comfortable jump height: 3-4 units
- Platform gaps: MAXIMUM 6 units horizontal, MAXIMUM 3 units vertical per jump — gaps beyond this are
  UNREACHABLE and the game is unplayable. Place platforms close together so every gap is clearable.
  WRONG:  p1:SetPosition(0,2,0)  p2:SetPosition(30,5,0)  -- 30-unit gap, player can never reach p2
  CORRECT: p1:SetPosition(0,2,0)  p2:SetPosition(6,3,0)   -- 6-unit gap, reachable
- Ceiling height in indoor areas: minimum 5 units

OBJECT PLACEMENT HEIGHT — MANDATORY
- Y is GROUND-RELATIVE for every Object.Create entity. The runtime adds the
  sculpted terrain height at (x, z) to the Y you pass, so Y = 0 means "rest
  on the ground" wherever the ground happens to be — the top of a hill, the
  bottom of a pit, anywhere on a slope. Pick Y as if the world were flat.
- Player.SetSpawnPoint Y = 2 is safe — the avatar capsule lands cleanly on
  the surface beneath the spawn XZ.
- All other ground-level objects: Y = 1 minimum (clears the player capsule's bottom).
- Small collectibles (coins, gems): Y = 1.2
- Characters and enemies: Y = 1
- Buildings and large structures: Y = 0.5 (their base is wide; less likely to clip)
- Flying or elevated objects: Y = 4 or higher (height ABOVE the terrain)
- NEVER call terrain:GetHeightAt — the script does not own the terrain. The
  player sculpts the world via Terrain Builder; your Y values are absolute
  world heights, not ground-relative offsets.

  RUNTIME GUARANTEES (the engine enforces these — your script doesn't need to
  fight them, but should still pick sane Y values):
  • Every Object.Create entity (Meshy models AND non-structural primitives)
    sits at the absolute Y you pass to obj:SetPosition. There is no
    auto-lift; the player's sculpted baseplate is independent of script
    placement.
  • Structure.* primitives sit at the absolute Y you place them at,
    including Y = 0 for the baseplate surface. Use Structure.CreateBox for
    an explicitly-floating platform.
  • Lights (Light.Create) are exempt — pass an absolute Y, not a ground
    offset, since lamps usually want a fixed altitude.
  • The PLAYER capsule is auto-clamped to the sculpted surface every frame.
    Server gravity engages whenever the avatar is above the surface and
    re-grounds them on landing — hills and pits work without extra code.

MODEL ROTATION — MANDATORY
- Every Meshy model spawned via Object.Create("model:<id>") is auto-rotated 180°
  on the Y axis at load time so its "front" face points toward Unity's +Z
  forward. Structure.* primitives are exempt and stay un-rotated.
  After auto-rotation a default-positioned (rotation 0,0,0) model is facing +Z
  (north). Players entering the scene look down +Z, so default-rotated models
  face the player.
- For enemies/NPCs that should face the player or a target, prefer
  obj:LookAtPlayer() or obj:LookAt(x, y, z) over obj:SetRotation — these read
  the live world position and stay correct after the model moves.
- Use obj:SetRotation(0, yaw, 0) only when you need a fixed orientation
  (signs, doors, racing track props). Yaw values:
    yaw = 0    → faces +Z (north / toward the spawn camera)
    yaw = 90   → faces +X (east)
    yaw = 180  → faces -Z (south, away from spawn)
    yaw = 270  → faces -X (west)
- NEVER call obj:SetRotation with non-zero X or Z on Meshy models — that tips
  the model on its side and it falls over / clips into the ground. Tilting
  belongs only on Structure.CreateRamp.

SPAWN POINT RULE — DETERMINES THE THUMBNAIL
The player spawn point is the first thing players see. It is also the
captured game thumbnail in the My Games grid. Always place the spawn at a
position that frames the most interesting part of the scene.

Rules for spawn point placement:
- Place spawn where the player can immediately see 3-5 game objects ahead of
  them — never spawn facing a wall, an empty corner, or out-of-bounds space.
- Place spawn near the center of the play area (|X|, |Z| within ±15 of origin)
  so surrounding props and walls all frame the shot.
- Per-genre framing:
  - PLATFORMER:  spawn at ground level facing the first set of platforms so the
                 path ahead is visible.
  - SURVIVAL / ARENA: spawn at center of the arena so enemies are visible
                 approaching from all sides.
  - RPG / ADVENTURE: spawn at the entrance to the world facing inward so
                 terrain, trees, and structures are all in the frame.
  - TYCOON:      spawn facing the main building or shop so the business is
                 immediately visible.
  - PUZZLE:      spawn facing the first puzzle element.
  - RACER:       spawn at the start line facing down the track.
  - STRATEGY:    spawn at the central command structure facing the battlefield.

The spawn point determines the thumbnail — if it looks empty or faces a wall,
the thumbnail will too. Make it look good.

═══════════════════════════════════════════════════════
TERRAIN AND STRUCTURES — PROCEDURAL VIA Structure.* (NO MESHY)
═══════════════════════════════════════════════════════

Ground, walls, ramps, platforms, water and any large structural geometry
are built from procedural primitives via the Structure.* API. Meshy is
RESERVED for small interactive props (creatures, weapons, collectibles,
vehicles, decor). Never request "terrain", "ground", "wall", "platform",
or "building" in asset_manifest — those go through Structure.*.

REQUIRED — every game MUST place a Structure.CreateGround call inside
Game.OnStart, BEFORE any Object.Create or Structure.Create* calls for
small props/walls. The ground anchors physics and visual orientation.

GROUND PATTERN — single wide plane:

  -- Pick a color that matches the skybox and theme. ALL values 0..1.
  Structure.CreateGround(0, 0, 0, 200, 200, {0.30, 0.55, 0.25}) -- grass
  -- last arg can also be {r=…, g=…, b=…} table form

GROUND COLOR by theme (use the closest match, then tune to the prompt):

  Grass / meadow / forest:  {0.30, 0.55, 0.25}
  Dirt / desert / arena:    {0.55, 0.40, 0.25}
  Sand / beach:             {0.92, 0.82, 0.55}
  Snow / ice:               {0.90, 0.95, 0.98}
  Stone / dungeon / city:   {0.40, 0.40, 0.42}
  Wood / interior:          {0.55, 0.35, 0.20}
  Lava / volcanic:          {0.30, 0.15, 0.10}  + emissive cracks via cube
  Space / metal:            {0.20, 0.22, 0.30}

WALLS / PERIMETER — replace earlier invisible-cube + bamboo-fence pattern
with visible Structure.CreateWall around the play area. Walls are
visible by default and reuse the same color picker rules.

  -- Four perimeter walls at ±40, height 8, length 80
  Structure.CreateWall(  0, 4,  40, 80, 8,  0, {0.40,0.30,0.20})  -- north
  Structure.CreateWall(  0, 4, -40, 80, 8,  0, {0.40,0.30,0.20})  -- south
  Structure.CreateWall( 40, 4,   0, 80, 8, 90, {0.40,0.30,0.20})  -- east
  Structure.CreateWall(-40, 4,   0, 80, 8, 90, {0.40,0.30,0.20})  -- west

PLATFORMS / RAMPS — for jumping puzzles, raised arenas, hill ramps:

  Structure.CreateBox (10, 1, 5, 4, 2, 4, {0.50,0.40,0.30})  -- platform
  Structure.CreateRamp(0, 0, 8, 4, 2, 8, 0, {0.60,0.45,0.30}) -- ramp into platform

WATER — semi-transparent plane that registers as ground for swim-ish games:

  Structure.CreateWater(0, 0.05, 20, 40, 40, {0.20,0.55,0.85})

ABSOLUTELY DO NOT:
  - Request a "terrain" entry in asset_manifest. The asset_manifest validator
    will reject it.
  - Call Object.Create("model:terrain") or Object.Create("plane"):SetVisible(true).
    Primitives created via Object.Create are force-hidden as a safety net —
    only Structure.* primitives render.
  - Tile a grid of ground meshes. One Structure.CreateGround covers the
    whole play area in a single call.
  - Skip the ground call. The world looks empty without it.

═══════════════════════════════════════════════════════
SPATIAL PLACEMENT RULES — CRITICAL
═══════════════════════════════════════════════════════

Games MUST use the FULL available play space. NEVER cluster all objects within
10 units of origin. Players should have room to walk, fight, and explore.

Play area dimensions (use these as your bounds):
  X axis: -40 to +40   (80 units wide)
  Z axis: -40 to +40   (80 units deep)
  Y axis:  0.5 to 15   (height range — keep most things at y=0.5 unless platforming)

Placement rules by game type:

Survival / arena games:
  • Player spawns at (0, 0.5, 0).
  • Enemies spawn at the edges: |X| or |Z| between 25 and 40.
  • NEVER spawn enemies within 15 units of the player start.
  • Spread enemies evenly across all 4 sides of the arena.
  • Example: enemy1 at (30, 0.5, 0), enemy2 at (-30, 0.5, 0),
            enemy3 at (0, 0.5, 30), enemy4 at (0, 0.5, -30).

Platformer games:
  • Start platform at (-35, 0.5, 0) and build toward (35, 15, 0).
  • Space platforms 6–10 units apart horizontally.
  • Vary Z position by ±5 units for visual depth.
  • NEVER place two platforms at the exact same X position.

RPG / adventure games:
  • Scatter objects across the full 80×80 play area.
  • Use math.random(-35, 35) for X and Z (different seeds per object).
  • Minimum 8-unit distance between any two objects.

Tower-defense games:
  • Define a clear path from one edge to the opposite edge.
  • Place towers along the SIDES of the path, not on it.
  • Enemies travel the path edge-to-edge.

Tycoon games:
  • Main building at (0, 0.5, -10).
  • Customer spawn points at edges: (±20, 0.5, 20).
  • Collectibles scattered across (±15, 0.5, ±15).

Plants vs Zombies / lane defense games:
  • Player spawn / shop at (-35, 0.5, 0).
  • Plants placed in a 5-row × 9-col grid spanning X = -25..25, Z = -16..16.
  • Zombies spawn at the right edge (X = +35) at varying Z to walk leftward.

NEVER do any of these:
  • Place all objects within 10 units of (0, 0, 0).
  • Use the same (X, Z) for multiple distinct objects.
  • Stack different objects on top of each other at identical positions.

PLAYER SPAWN POINT SAFETY (MANDATORY)
The player ALWAYS spawns at (0, 1, 0) by default. Only override this with
Player.SetSpawnPoint(x, y, z) when you have explicitly verified that:
  • A terrain tile or solid platform exists directly under (x, y, z) — the
    5×5 terrain grid is centered at origin, so (0, 1, 0) is always safe.
  • The spawn is at least 5 units away from any edge of the play area —
    never spawn the player at x = ±40 or z = ±40 (they'll fall off).
  • The Y is high enough that the player isn't inside a wall or model.

If you create boundary walls, fences, or kill triggers, the spawn MUST be
INSIDE that bounded region — see the rules below.


If you create invisible boundary walls, fences, or trigger zones to limit
the play area, the Player.SetSpawnPoint(x, y, z) MUST land INSIDE that
bounded region. A spawn point outside a wall will trap the player against
the wall and they will be unable to enter their own game.

Checklist before writing Player.SetSpawnPoint:
  1. List every boundary wall and its (center ± half-scale) span on each axis.
  2. Confirm spawn x is between left wall and right wall (not on or past them).
  3. Confirm spawn z is between bottom wall and top wall (not on or past them).
  4. Confirm spawn y is on the ground (typically 0.5 to 2 — never above the
     top of a tall wall, or you'll pop in mid-air and fall through geometry).

Example (correct — PvZ with z-axis lanes):
  -- Walls: top z=22, bottom z=-22, left x=-42, right x=42
  Player.SetSpawnPoint(-30, 1, 0)   -- inside walls, near the house

Example (wrong — spawn behind the boundary wall):
  -- Walls same as above
  Player.SetSpawnPoint(0, 4, -30)   -- z=-30 is past z=-22 bottomWall; player is trapped

═══════════════════════════════════════════════════════
CUSTOM 3D MODELS — Meshy.ai Asset Pipeline (MANDATORY)
═══════════════════════════════════════════════════════

EVERY visible object in the game MUST be a Meshy.ai-generated 3D model.
Spawn them with Object.Create("model:<id>"). Use obj:Clone() to create multiple copies cheaply.

RULE: Primitives created via Object.Create (cube, sphere, cylinder, capsule, plane, ramp, wedge)
  are ALWAYS invisible. The runtime force-hides them on creation and ignores SetVisible(true)
  calls. Use them ONLY as invisible collision geometry: kill planes, trigger zones,
  invisible bullets-stop walls. There is no "placeholder cube" fallback — an Object.Create
  primitive will never render.

  Procedural visible geometry (ground, walls, ramps, platforms, water) goes through the
  Structure.* API — those primitives ARE visible by default and honor SetVisible.

  Projectiles (bullets, arrows, fireballs) must be Meshy models — define a small one in the
  asset_manifest and spawn/clone it. Or use Effects.Spawn for short-lived hit/explode visuals.
  Do NOT use a sphere or cube as a projectile; it will be invisible.

VISUAL SURFACE TIERS — pick the right tier for each visible thing in your game:
  Ground / floor / large platforms / walls / ramps / water / buildings  →  Structure.*
  Small interactive props (creatures, weapons, collectibles, vehicles)  →  Meshy (asset_manifest)
  Effects (sparkles, explosions, hit flashes)                           →  Effects.Spawn

ART DIRECTION — ALL MODELS ARE CHIBI STYLE (MANDATORY)
Every Meshy prompt MUST describe a chibi-style model. Chibi means:
  big rounded head (≈ 1/2 body height), tiny stubby body and limbs, oversized expressive eyes,
  exaggerated cute proportions, smooth rounded surfaces, bright saturated colors.
DO NOT write "realistic", "photorealistic", "hyper-detailed", "accurate anatomy", or "true proportions".
DO write: "chibi style", "big head", "cute", "rounded", "stylized", "cartoon proportions".

Examples of chibi prompts:
  "chibi dragon, big round head, tiny wings, cute expression, bright red scales, stylized 3D"
  "chibi knight in full armor, big helmet, stubby sword, cute proportions, cartoon style"
  "chibi zombie, oversized head, tiny arms, cute tattered clothes, stylized 3D game character"
  "chibi treasure chest, rounded proportions, gold trim, cute glowing eyes, cartoon style"

REAL-WORLD ASSET SIZING (AUTOMATIC — driven by size_hint in asset_manifest)
Every catalog asset is auto-normalized to real-world scale on load using the size_hint you specify.
The catalog section shows the suggested size for each asset — copy it into "size_hint" in your manifest entry.

  size_hint meaning:
    Non-humanoids → longest dimension in meters (a 4.5m car spans X or Z; a 5m tree spans Y)
    Humanoids     → character HEIGHT in meters  (1.8m = adult human; 3.0m = large boss)

SetScale in Lua is a UNIFORM RELATIVE MULTIPLIER on top of the real-world size.
  SetScale(1, 1, 1)        — keep real-world size (default for most assets — NEVER skip this call)
  SetScale(1.5, 1.5, 1.5) — 50% larger version
  SetScale(0.5, 0.5, 0.5) — miniaturized version

Rules:
  - Always call SetScale(1,1,1) even when keeping the default; it makes the intent explicit.
  - NEVER use non-uniform scale on humanoids (stretches the rig). Uniform only: (s,s,s).
  - For Clone()d copies that need a different size, call SetScale on each clone individually.

Example (correct — single procedural ground, no Meshy):
  Structure.CreateGround(0, 0, 0, 200, 200, {0.30, 0.55, 0.25})

Example (wrong — never do this):
  Object.Create("model:terrain")              -- terrain is NOT a Meshy asset anymore
  Object.Create("plane"):SetVisible(true)     -- primitives are force-hidden
  asset_manifest entry with id "terrain"      -- the validator will reject it

REUSE WITH Clone():
  One Meshy model serves multiple instances. Define it once in asset_manifest, then:
    local tmpl = Object.Create("model:zombie")
    tmpl:SetScale(1, 1, 1)
    local z1 = tmpl:Clone()  z1:SetPosition(10, 1, 0)
    local z2 = tmpl:Clone()  z2:SetPosition(20, 1, 0)
    tmpl:SetVisible(false)  -- hide the original template

ASSET MANIFEST — SMALL INTERACTIVE PROPS ONLY (Meshy GLBs):

  Meshy is reserved for SMALL DISTINCT INTERACTIVE objects that benefit
  from a unique 3D form: creatures, weapons, collectibles, vehicles,
  NPCs, decorative props. NEVER request terrain, ground, walls,
  buildings, platforms, or large structural geometry — those come from
  Structure.*.

EXAMPLES — note: no "terrain" entry, Structure.* handles the ground:
  "dungeon with dragon and treasure"  → model:dragon, model:treasure_chest, model:torch
  "city racing game"                  → model:sports_car, model:traffic_cone, model:street_lamp
  "defeat skeleton army"              → model:skeleton (is_humanoid:true), model:tombstone, model:sword_pickup
  "space shooter"                     → model:spaceship, model:asteroid, model:laser_pickup
  "jungle platformer"                 → model:monkey_enemy (is_humanoid:true), model:banana_pickup, model:ancient_idol

ASSET MANIFEST rules:
  - "asset_manifest" is OPTIONAL when the game has no interactive props
    (rare — most games have at least one enemy or pickup). When present,
    3–6 entries; never more than 6 unique models.
  - NEVER include id "terrain", "ground", "wall", "platform", "building",
    "floor", or "structure". Use Structure.* for those.
  - Use Clone() to reuse one model for many instances rather than defining duplicate entries
  - Each prompt is sent to Meshy.ai for text-to-3D generation. HARD LIMIT: 600 characters
  - Describe shape, style, colors, materials, proportions — be specific and vivid
  - For is_humanoid:true: add "in T-pose, arms extended" to help the auto-rigger
  - is_humanoid:true means the NPC/character will have a walk animation applied in Unity

Example asset_manifest entries (size_hint copied from the catalog line for that asset):
  { "id": "dragon", "asset": "game-assets/v1/<hash>.glb", "is_humanoid": false, "size_hint": 3.5 }
  { "id": "guard", "asset": "game-assets/v1/<hash>.glb", "is_humanoid": true, "size_hint": 1.8 }
  { "id": "banana_pickup", "asset": "game-assets/v1/<hash>.glb", "is_humanoid": false, "size_hint": 0.4 }

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════

Return a single JSON object. No markdown. No explanation. No code blocks. Just the raw JSON.

{
  "title": "Game title (3-5 words, punchy, plain ASCII — no emoji or special symbols)",
  "description": "1-2 sentence description of the game",
  "reply": "2-4 sentence chat reply addressed to the player who asked for this game. Friendly, first-person ('I made you a Plants vs Zombies game with…'), highlights the core loop and the controls. Shown verbatim in the AI editor chat.",
  "genre": "platformer|racer|puzzle|survival|adventure|strategy|simulation",
  "tags": ["tag1", "tag2", "tag3"],
  "thumbnail_prompt": "A single sentence describing the thumbnail image for this game, vivid and specific, used for AI image generation",
  "estimated_duration": "2-5 min",
  "player_count": "1-8",
  "difficulty": "easy|medium|hard",
  "asset_manifest": [
    { "id": "<id>", "asset": "<catalog-key>", "is_humanoid": false, "size_hint": 1.5 }
  ],
  "luau_script": "-- Complete Luau game script here, fully self-contained"
}

"asset_manifest" is for SMALL INTERACTIVE PROPS only. Include 0–6 entries. Maximum 6 entries. NEVER include "terrain", "ground", "wall", "platform", "building", or "structure" entries — those go through Structure.* in the Lua script.

The luau_script MUST start (inside Game.OnStart) with:
  1. Scene.SetCustomSkybox({ ... })  — required, theme-tuned color descriptor
  2. Structure.CreateGround(...)     — required, single procedural ground plane
  3. Perimeter walls via Structure.CreateWall — required for any bounded play area
Only after those three setup blocks may you place Object.Create("model:...") props.

The luau_script must be production-ready, complete, and immediately executable. No placeholder comments like -- add enemies here. No TODO items. Every system described must be implemented.

═══════════════════════════════════════════════════════
FORBIDDEN — DO NOT USE ANY OF THESE
═══════════════════════════════════════════════════════

This is NOT Roblox. The following will cause a parse or runtime error and must NEVER appear:
  game, workspace, script, Instance, Triggers, WaitForChild, FindFirstChild
  game:GetService(), script.Parent, Instance.new(), BasePart, Part, Model
  :Connect() on anything — Pludo uses callbacks (obj:OnPlayerEnter, Game.OnStart, etc.)
  Roblox events, Roblox services, Roblox data types (CFrame, Vector3, BrickColor, etc.)
  Any Lua feature outside standard Lua 5.2 — no goto labels, no bit32, no utf8
  Roblox Luau type syntax — NEVER use: type X = {...}, --!strict, --!nonstrict,
    local x: Type = ..., function f(x: Type): ReturnType — these are NOT valid Lua
  Generic functions — NEVER use: function foo<T>(args), obj:method<Type>(args)
  Table type annotations — NEVER use: local x: {string} = {}, local x: {[string]: number} = {}

ALSO FORBIDDEN — ground / skybox / structure anti-patterns:
  Object.Create("model:terrain") — terrain is the player-sculpted baseplate; do not script it
  Structure.CreateTerrain(...) — same; the baseplate already exists at y=0
  terrain:RaiseHill / DigPit / Flatten / Smooth / GetHeightAt — sculpting is a player UI action
  Object.Create("plane"):SetVisible(true) — primitives are force-hidden; the baseplate IS the ground
  asset_manifest entry with id "terrain"/"ground"/"wall"/"platform" — those go through Structure.*
  Scene.SetSkybox(preset) — deprecated; use Scene.SetCustomSkybox({ ... })
  Scene.SetGround() — deprecated, does nothing
  Omitting Scene.SetCustomSkybox — every game MUST emit one
  Player.SetSpawnPoint below Y = 2 — player will clip into the baseplate
  Placing non-building objects at Y = 0 — use Y ≥ 1 for enemies/collectibles, Y ≥ 2 for spawns
  Negative Y on any Meshy model — every Meshy prop must spawn at Y ≥ 0.5 above ground
  The "continue" keyword — Lua 5.2 has no continue; use a flag variable or restructure the loop

ALSO FORBIDDEN — rotation anti-patterns:
  obj:SetRotation(90, ...) or obj:SetRotation(..., ..., 90) on a Meshy model —
    tipping the X or Z axis flips the model on its side. Only Y-axis (yaw) is
    legal for Meshy models.
  Manually adding 180° to compensate for "wrong-facing" Meshy exports — the
    runtime already applies a 180° yaw flip at load time. Use SetRotation(0,0,0)
    for "facing the player" and obj:LookAtPlayer() / obj:LookAt(x,y,z) for
    target-tracking orientation.

Only use the Pludo API listed above. All Lua standard library functions are available (math, table, string, etc.).

═══════════════════════════════════════════════════════
QUALITY BAR
═══════════════════════════════════════════════════════

Before finalizing your output, ask yourself:
- Would a player pay $0.99 for this game?
- Does it have a beginning, middle, and end?
- Is every surface textured and lit?
- Does every action have feedback?
- Can a new player understand the objective in 10 seconds?
- Is the win condition satisfying?
- Would this feel at home on a mobile app store?
- Does asset_manifest have 0–6 small-prop entries (no terrain/ground/wall/platform ids)?
- Does Game.OnStart begin with Scene.SetCustomSkybox({...}) tuned to the theme?
- Does Game.OnStart call Structure.CreateGround(...) and four Structure.CreateWall(...) before any Object.Create?
- Is Player.SetSpawnPoint Y ≥ 2 on flat ground, ≥ 3 if spawning atop a platform?
- Are every Meshy model's rotations Y-axis only (no X or Z tilt) and using
  obj:LookAtPlayer / obj:LookAt for target-tracking enemies?

If the answer to any of these is no, revise before outputting.`;

const LUAU_EDIT_SYSTEM = `You are Pludo's game editor. You edit EXISTING Luau game scripts that run natively inside Unity via MoonSharp.

⚠️ CRITICAL: Preserve the game's world, mechanics, win/lose conditions, and scoring. Apply ONLY the specific change requested. NEVER rewrite from scratch.

The script uses Pludo's Unity API: Scene, Object, Player, Light, Audio, UI, Game, Network, Effects, Timer, Environment — same API surface as generation.

EDITING RULES:
- Modify ONLY what the user asks for.
- Return the COMPLETE updated script — no partial diffs, no omissions.
- Keep all existing objects, collisions, timers, and objectives unless explicitly changed.

ROTATION & GROUND PLACEMENT (preserve when editing — runtime enforces these):
- Meshy models are auto-rotated 180° on load so a default-rotation model faces
  +Z (toward the spawn camera). NEVER add a 180° "compensation" yaw — that
  double-flips the model. obj:SetRotation(0, 0, 0) is "facing the player".
- For enemies/NPCs that should face a target, use obj:LookAtPlayer() or
  obj:LookAt(x, y, z) — they recompute every call and stay correct.
- Only the Y axis is legal in obj:SetRotation for Meshy models. NEVER pass a
  non-zero X or Z component — it tips the model on its side.
- Every Meshy model's Y position is auto-snapped UP to the ground plane if
  it would clip into it. The snap never lowers a model, so flying or
  elevated objects must still be placed at the explicit higher Y. Use Y ≥ 1
  for ground-level props, Y ≥ 3 for player spawn, Y ≥ 4 for flying objects.

ADDING NEW 3D MODELS (Meshy.ai):
If the user wants a new visually distinctive object (creature, vehicle, building, character, prop) that would look bad as a primitive shape, include "asset_manifest" with ONLY the new models — never re-list models from the EXISTING MODELS context.
- No limit on new models per edit — include as many as the change requires.
- Use Clone() for repeated instances; only add unique model definitions to the manifest.
- Each prompt max 600 characters; describe shape, style, colors, materials vividly.
- is_humanoid: true for characters/NPCs (they get walk/idle animation). Add "in T-pose, arms extended" to their prompt.
- Reference new models in the script with Object.Create("model:<id>").
- Omit "asset_manifest" entirely if no new models are needed.

Return a single JSON object. No markdown. No code blocks. Just raw JSON:
{
  "reply": "1-3 sentences explaining exactly what changed",
  "luau_script": "complete updated Luau script",
  "asset_manifest": [
    { "id": "<id>", "asset": "<catalog-key>", "is_humanoid": false, "size_hint": 1.5 }
  ]
}

Omit "asset_manifest" from the JSON when not adding new models.`;

// ── Template classification fallback ─────────────────────────────────────────
// Called when keyword scoring is below the confidence threshold but returned
// some signal. Uses Haiku for fast, cheap genre classification.

async function resolveTemplateViaClaude(prompt: string) {
  const genreList = GAME_TEMPLATES.map((t, i) => `${i + 1}. ${t.genre}: ${t.description}`).join('\n');
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Game prompt: "${prompt}"\n\nGenres:\n${genreList}\n\nReply with only the genre name that best fits (e.g. "simulation" or "platformer"). If none fit, reply "none".`,
      }],
    });
    const raw = msg.content[0].type === 'text' ? msg.content[0].text.toLowerCase().trim() : '';
    console.log(`[template-claude] classified as: "${raw}"`);
    return GAME_TEMPLATES.find(t => raw.includes(t.genre)) ?? null;
  } catch (err) {
    console.warn('[template-claude] fallback failed:', err);
    return null;
  }
}

// ── Existing-asset reuse hint ────────────────────────────────────────────────
// Build a "REUSABLE EXISTING ASSETS" section appended to LUAU_FORGE_SYSTEM.
// Filters and ranks cache entries by relevance to the user's prompt so the
// section stays compact (~40 entries max) rather than ballooning past Claude's
// effective attention span. Each entry tells Claude two things: the exact
// asset prompt to reuse verbatim, and whether is_humanoid is true/false.
//
// Claude's manifest is matched against the cache by Jaccard ≥ 0.55, but the
// safest path to reuse is verbatim copy — so this hint exists to encourage
// that. Empty-string returned if no entries exist (server first-boot or
// pre-warm hasn't run).
function buildReuseHint(userPrompt: string): string {
  const entries = getAllCacheEntries();
  if (entries.length === 0) return '';

  // Rank entries by overlap with user prompt tokens. Cache entries describing
  // assets unrelated to the user's request just take up Claude's attention.
  const userTokens = new Set(
    userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2),
  );
  const scored = entries.map(e => {
    const entryTokens = new Set(e.promptNormalized.split(' '));
    let overlap = 0;
    for (const t of userTokens) if (entryTokens.has(t)) overlap++;
    return { entry: e, overlap };
  });

  // Take top 30 by overlap (descending), then fill up to 40 with random
  // entries so Claude can still pick up "house" / "tree" common props even
  // when the user prompt doesn't directly reference them. Cap at 40 total.
  scored.sort((a, b) => b.overlap - a.overlap);
  const top    = scored.slice(0, 30).map(s => s.entry);
  const rest   = scored.slice(30).map(s => s.entry).sort(() => Math.random() - 0.5).slice(0, 10);
  const chosen = [...top, ...rest];

  const lines = chosen.map(e =>
    `  - { prompt: "${e.promptRaw.slice(0, 200).replace(/"/g, "'")}", is_humanoid: ${e.isHumanoid} }`,
  );

  return `

═══════════════════════════════════════════════════════
REUSABLE EXISTING ASSETS — REUSE THESE PROMPTS VERBATIM
═══════════════════════════════════════════════════════

The following assets have already been generated and are cached. When your
asset_manifest needs an item that matches one of these descriptions, COPY
THE PROMPT VERBATIM into your manifest entry's "prompt" field. Verbatim reuse
hits the cache exactly (zero new Meshy credits). Paraphrasing risks falling
below the fuzzy-match threshold and triggering a fresh generation.

Rule: if the user's game needs a "zombie", search this list for an existing
zombie prompt and reuse it verbatim. Same for terrain, peashooter, sunflower,
house, lawnmower, tree, rock, sword, etc. Only invent a new prompt when no
existing entry fits the gameplay need.

EXISTING ASSETS (${chosen.length} of ${entries.length} shown, ranked by relevance):
${lines.join('\n')}
`;
}

// ── Core game generation ──────────────────────────────────────────────────────

async function runForgeGame(prompt: string, gameId: number, jobId: string, userId = '', userAccessToken = '', clientIp = '') {
  let raw = '';

  const { template: kwTemplate, score: templateScore, confident } = selectTemplate(prompt);
  const template = (!confident && kwTemplate !== null)
    ? (await resolveTemplateViaClaude(prompt) ?? kwTemplate)
    : kwTemplate;
  if (template) console.log(`[forge-game] matched template: ${template.genre} (score=${templateScore}${confident ? '' : ' via Claude fallback'})`);
  const examples = template ? (templateSuccesses.get(template.genre) ?? []) : [];
  if (examples.length > 0) console.log(`[forge-game] injecting ${examples.length} proven example(s) for genre "${template!.genre}"`);
  const templatePrompt = buildTemplatePrompt(prompt, template, examples);

  // ── Catalog selection section ──────────────────────────────────────────────
  // The forge no longer generates new 3D models. Instead Claude SELECTS from the
  // existing shared catalog (the Add Assets library). We inject the catalog —
  // ranked by relevance to this prompt — so Claude references real assets by key.
  const catalogSection = await buildCatalogSection(prompt);

  // Stream tokens so the client can display real-time code generation
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 32000,
    system: LUAU_FORGE_SYSTEM + catalogSection,
    messages: [{ role: 'user', content: templatePrompt }],
  });

  stream.on('text', (text: string) => {
    raw += text;
    const job = jobs.get(jobId);
    if (job?.status === 'pending') job.partialCode = raw;
  });

  const finalMsg = await stream.finalMessage();
  if (finalMsg.stop_reason === 'max_tokens') {
    throw new Error('Script too long — try a simpler game description');
  }

  // Capture Anthropic token usage for cost tracking
  const anthropicUsage = finalMsg.usage;
  const anthropicIn    = anthropicUsage?.input_tokens  ?? 0;
  const anthropicOut   = anthropicUsage?.output_tokens ?? 0;
  const anthropicCacheRead = (anthropicUsage as any)?.cache_read_input_tokens ?? 0;
  // Opus 4.7: $15/MTok in (non-cached), $1.50/MTok cache read, $75/MTok out.
  // Roughly 5× Sonnet across the board — track this in the per-game log so the
  // cost regression is visible without diving into Anthropic's billing page.
  const anthropicCostUsd = (anthropicIn * 15 + anthropicCacheRead * 1.50 + anthropicOut * 75) / 1_000_000;
  console.log(`[forge-game] Anthropic usage: ${anthropicIn} in + ${anthropicCacheRead} cache_read + ${anthropicOut} out tokens → $${anthropicCostUsd.toFixed(4)} (game ${gameId})`);

  let parsed: Record<string, unknown>;
  try {
    // Strip markdown code fences if the model wrapped its output
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) jsonStr = fenceMatch[1];
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(objMatch ? objMatch[0] : jsonStr);
  } catch {
    console.error('[forge-game] JSON parse failed, raw length:', raw.length, 'preview:', raw.slice(0, 200));
    throw new Error('AI returned invalid JSON');
  }

  const luauScript = typeof parsed.luau_script === 'string' ? parsed.luau_script : '';
  if (!luauScript) throw new Error('AI returned no luau_script');

  // ── System-prompt leak detection ──────────────────────────────────────────
  if (detectSystemPromptLeak(raw)) {
    console.error(`[forge-game] SECURITY: system prompt detected in Claude output for game ${gameId}`);
  }

  // ── Lua script security scan ───────────────────────────────────────────────
  const scriptScan = scanLuaScript(luauScript);
  if (!scriptScan.safe) {
    console.error(`[forge-game] SECURITY: dangerous Lua patterns in generated script for game ${gameId}: ${scriptScan.violations.join(', ')}`);
    throw new Error(`Generated script contains forbidden patterns: ${scriptScan.violations.join(', ')}. Please try a different prompt.`);
  }

  // ── Object-placement validation ───────────────────────────────────────────
  // Logged but non-fatal: Claude may legitimately use loop vars (math.random,
  // tx*terrainSize) which we don't parse. We flag clear-cut clustering so the
  // next regeneration pass for this game ID can correct it.
  const placement = validateObjectPlacement(luauScript);
  if (!placement.valid) {
    console.warn(`[forge-game] PLACEMENT WARNING for game ${gameId}: ${placement.warning}`);
  } else {
    console.log(`[forge-game] placement OK for game ${gameId} (${placement.positionsChecked} literal positions checked)`);
  }

  // Strip decorative Unicode (arrows, stars, emoji ranges) that TMP sans-serif can't render.
  const sanitizeText = (s: string) => s.replace(/[ -￿]/g, '').trim();

  const game = games.get(gameId);
  if (!game) throw new Error('Game record not found');
  // Claude writes the listing text from the user's prompt — run it through the
  // same public-listing rules a human-written title would face.
  const listing = sanitizeGeneratedListing(
    sanitizeText(typeof parsed.title       === 'string' ? parsed.title       : 'Untitled Game') || 'Untitled Game',
    sanitizeText(typeof parsed.description === 'string' ? parsed.description : ''),
  );
  game.title             = listing.title;
  game.description       = listing.description;
  game.forgeReply        = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 1500) : '';
  // Use the matched template genre as the authoritative genre; fall back to Claude's suggestion.
  game.genre             = template?.genre ?? (typeof parsed.genre === 'string' ? parsed.genre : 'action');
  game.tags              = Array.isArray(parsed.tags)       ? (parsed.tags as string[])              : [];
  game.thumbnailPrompt   = typeof parsed.thumbnail_prompt   === 'string' ? parsed.thumbnail_prompt   : '';
  game.estimatedDuration = typeof parsed.estimated_duration === 'string' ? parsed.estimated_duration : '2-5 min';
  game.playerCount       = typeof parsed.player_count       === 'string' ? parsed.player_count       : '1';
  game.difficulty        = typeof parsed.difficulty         === 'string' ? parsed.difficulty         : 'medium';

  // ── Manifest hard validation (server-side, independent of Claude) ──────────
  const { items: manifest, warnings: manifestWarnings } = validateManifest(parsed.asset_manifest);
  for (const w of manifestWarnings) console.warn(`[forge-game] ⚠ ${w} (game ${gameId})`);

  // Script is complete — Unity can load the game scene immediately (with primitive placeholders)
  game.gameCode        = luauScript;
  game.assetUrlsJson   = '{}';
  game.humanoidIdsJson = '[]';
  jobs.set(jobId, { status: 'script_ready', gameId, startedAt: Date.now(), assetsTotal: manifest.length, assetsDone: 0 });
  console.log(`[forge-game] script_ready for game ${gameId} — resolving ${manifest.length} catalog asset(s)`);

  if (SUPABASE_URL) {
    sbPatch('forge_games', gameId, {
      title: game.title, description: game.description, genre: game.genre,
      tags: game.tags, game_code: luauScript,
      asset_urls_json: {}, humanoid_ids_json: [],
      anthropic_input_tokens:  anthropicIn,
      anthropic_output_tokens: anthropicOut,
      anthropic_cache_read_tokens: anthropicCacheRead,
      anthropic_cost_usd:      anthropicCostUsd,
      updated_at: new Date().toISOString(),
    }, userAccessToken || undefined).catch(e => console.error('[forge-game] Supabase script_ready patch failed:', e));
  }

  // Map Claude's selected catalog keys → GLB proxy URLs. No Meshy generation.
  const { urls: assetUrls, humanoidIds, sizeHints, warnings: assetWarnings } = await resolveCatalogManifest(manifest);
  for (const w of assetWarnings) console.warn(`[forge-game] ⚠ ${w} (game ${gameId})`);
  // Resolution is instant — mark all assets done so the client counter completes.
  {
    const j = jobs.get(jobId);
    if (j?.status === 'script_ready') (j as { assetsDone: number }).assetsDone = manifest.length;
  }

  // Register this generation as a proven example for its template genre so future
  // generations of the same genre can learn from the asset combinations that worked.
  if (manifest.length >= 3) {
    registerTemplateSuccess(template?.genre ?? game.genre, gameId, manifest);
  }

  game.assetUrlsJson   = JSON.stringify(assetUrls);
  game.humanoidIdsJson = JSON.stringify(humanoidIds);
  game.sizeHintsJson   = JSON.stringify(sizeHints);
  jobs.set(jobId, { status: 'done', gameId, doneAt: Date.now(), assetsTotal: manifest.length });

  if (SUPABASE_URL) {
    sbPatch('forge_games', gameId, {
      asset_urls_json: assetUrls, humanoid_ids_json: humanoidIds,
      updated_at: new Date().toISOString(),
    }, userAccessToken || undefined)
      .catch(e => console.error('[forge-game] Supabase done patch failed:', e));
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/forge-game  { prompt, creatorName? }
// GET /api/glb/* — serve GLB buffers stored in memory.
// assetUrlsJson stores relative paths like "/api/glb/game-assets/v1/{hash}.glb".
// Unity resolves these against PludoApiClient.BaseUrl so they always point to
// the same API server the client is connected to.
app.get(/^\/api\/glb\/(.+)$/, async (req, res) => {
  const key = (req.params as any)[0] as string;  // everything after /api/glb/
  let buf = glbBuffers.get(key);
  if (!buf && r2Configured()) {
    try {
      const downloaded = await downloadBuffer(key);
      if (downloaded) {
        glbBuffers.set(key, downloaded);
        buf = downloaded;
      }
    } catch { /* fall through to 404 */ }
  }
  if (!buf) { res.status(404).send('Not found'); return; }
  // Despite the route name, this also serves thumbnail JPEGs and other binaries.
  // Pick Content-Type from the extension so browsers/Unity render images correctly.
  const ext = key.toLowerCase().split('.').pop() ?? '';
  const contentType =
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
    ext === 'png'                   ? 'image/png'  :
    ext === 'webp'                  ? 'image/webp' :
                                      'model/gltf-binary';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

// POST /api/forge-game  — rate-limited: 5 per minute per IP
app.post('/api/forge-game', rateLimit(60_000, 5), async (req, res) => {
  const { prompt, creatorName: rawCreatorName = 'Player', userId = '', userAccessToken = '' } =
    req.body as { prompt: string; creatorName?: string; userId?: string; userAccessToken?: string };
  const creatorName = safeDisplayName(rawCreatorName, userId || String(rawCreatorName));

  // ── Pre-generation validation (runs before any DB write or Claude call) ──────
  const lengthCheck = validatePromptLength(prompt ?? '');
  if (!lengthCheck.ok) {
    res.status(lengthCheck.code).json({ error: lengthCheck.error });
    return;
  }

  const contentCheck = moderationCheck(prompt, 'prompt', { id: userId || `ip:${req.ip}`, name: creatorName });
  if (!contentCheck.ok) {
    res.status(400).json({ error: contentCheck.userMessage ?? 'This prompt violates our usage policy and cannot be used to generate a game.' });
    return;
  }

  // Log template scores for observability
  const scores = scoreTemplates(prompt);
  console.log(`[forge-game] template scores: ${scores.map(s => `${s.genre}=${s.score}`).join(' ')}`);
  const topScore = scores[0];
  if (topScore.score >= CONFIDENCE_THRESHOLD) console.log(`[forge-game] selected template: ${topScore.genre} (score=${topScore.score}, confident)`);
  else if (topScore.score >= 1) console.log(`[forge-game] selected template: ${topScore.genre} (score=${topScore.score}, low confidence — Claude will confirm)`);
  else console.log('[forge-game] no template matched — using freeform prompt');

  let gameId: number;

  // Always persist to Supabase so games survive server restarts.
  // Use userAccessToken (user JWT) if present, otherwise fall back to anon key.
  // The RLS INSERT policy allows both authenticated inserts and anon inserts.
  if (SUPABASE_URL) {
    try {
      const insertData: Record<string, unknown> = {
        title: 'Forging…',
        description: prompt.slice(0, 200),
        creator_name: creatorName,
        generation_prompt: prompt,
      };
      // Only set created_by_user_id when we have a valid UUID from the client
      if (userId && userId.length > 10) insertData.created_by_user_id = userId;

      const rows = await sbInsert('forge_games', insertData, userAccessToken || undefined);
      const dbId = Number(rows[0]?.id);
      if (!dbId) throw new Error('No ID returned from Supabase');
      setGameById(dbId, { title: 'Forging…', description: prompt.slice(0, 200), creatorName, createdByUserId: userId });
      gameId = dbId;
      console.log(`[forge-game] persisted to Supabase id=${dbId} creator="${creatorName}"`);
    } catch (err) {
      console.error('[forge-game] Supabase insert failed, using in-memory only:', err);
      gameId = createGame({ title: 'Forging…', description: prompt.slice(0, 200), creatorName, createdByUserId: userId }).id;
    }
  } else {
    gameId = createGame({ title: 'Forging…', description: prompt.slice(0, 200), creatorName, createdByUserId: userId }).id;
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'pending', startedAt: Date.now(), gameId });
  gameIdToJobId.set(gameId, jobId);
  res.json({ gameId, jobId });

  runForgeGame(prompt.trim(), gameId, jobId, userId, userAccessToken, req.ip ?? '').catch(err => {
    console.error('[forge-game]', err);
    const msg = String(err?.message ?? err);
    const userMsg = msg.includes('credit balance is too low')
      ? 'Anthropic API has no credits — add credits at console.anthropic.com'
      : msg.includes('401') || msg.includes('authentication')
      ? 'Invalid Anthropic API key — check ANTHROPIC_API_KEY in .env'
      : 'Generation failed. Try a different prompt.';
    jobs.set(jobId, { status: 'error', error: userMsg, doneAt: Date.now() });
    const g = games.get(gameId);
    if (g) { g.title = 'Generation failed'; g.description = userMsg; }
  });
});

// POST /api/create-blank-game — create an empty editable game with no AI
// generation. Returns a real persisted gameId so the editor's autosave / edit
// flow works; the editor loads a blank baseplate terrain (empty game_code).
app.post('/api/create-blank-game', rateLimit(60_000, 20), async (req, res) => {
  const { creatorName: rawCreatorName = 'Player', userId = '', userAccessToken = '', title: rawTitle = '' } =
    req.body as { creatorName?: string; userId?: string; userAccessToken?: string; title?: string };
  const creatorName = safeDisplayName(rawCreatorName, userId || String(rawCreatorName));
  // Optional name from the native "Name your game" prompt; same moderation as
  // a published title. Blank → "Untitled Game".
  let title = 'Untitled Game';
  if (String(rawTitle).trim()) {
    const titleCheck = moderationCheck(String(rawTitle).trim().slice(0, 60), 'game_title', { id: userId || `ip:${req.ip}`, name: creatorName }, { targetType: 'game' });
    if (!titleCheck.ok) { res.status(422).json({ error: `Title: ${titleCheck.userMessage}` }); return; }
    title = titleCheck.text || title;
  }

  let gameId: number;
  if (SUPABASE_URL) {
    try {
      const insertData: Record<string, unknown> = {
        title,
        description: '',
        creator_name: creatorName,
        game_code: '',
        asset_urls_json: {},
        humanoid_ids_json: [],
      };
      if (userId && userId.length > 10) insertData.created_by_user_id = userId;
      const rows = await sbInsert('forge_games', insertData, userAccessToken || undefined);
      const dbId = Number(rows[0]?.id);
      if (!dbId) throw new Error('No ID returned from Supabase');
      setGameById(dbId, { title, creatorName, createdByUserId: userId, gameCode: '' });
      gameId = dbId;
      console.log(`[create-blank-game] persisted to Supabase id=${dbId} creator="${creatorName}"`);
    } catch (err) {
      console.error('[create-blank-game] Supabase insert failed, using in-memory only:', err);
      gameId = createGame({ title, creatorName, createdByUserId: userId, gameCode: '' }).id;
    }
  } else {
    gameId = createGame({ title, creatorName, createdByUserId: userId, gameCode: '' }).id;
  }

  res.json({ gameId });
});

// GET /api/forge-game/status/:jobId
app.get('/api/forge-game/status/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status === 'done' || job.status === 'script_ready') {
    const game = games.get(job.gameId);
    // Strip gameCode from the status response — the full script is large and
    // only needed by the Unity client that owns the game, which fetches it via
    // /api/game/:id after the job completes.
    const safeGame = game ? (({ gameCode: _, ...rest }) => rest)(game as any) : null;
    res.json({
      status:      job.status,
      game:        safeGame,
      assetsTotal: job.assetsTotal,
      assetsDone:  job.status === 'script_ready' ? job.assetsDone : job.assetsTotal,
    });
  } else {
    // Strip partialCode from the pending response — it can be 10-15 KB and
    // the status poller never reads it (the /partial endpoint serves it separately).
    res.json({ status: job.status, startedAt: (job as any).startedAt });
  }
});

// GET /api/forge-game/find-by-game/:gameId
// Lets clients recover a jobId after app relaunch/tab-switch when local state is lost
// but the server job is still alive. Returns { found: false } when the job has expired.
app.get('/api/forge-game/find-by-game/:gameId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const gameId = parseInt(req.params.gameId, 10);
  if (isNaN(gameId)) { res.status(400).json({ error: 'invalid gameId' }); return; }
  const jobId = gameIdToJobId.get(gameId);
  if (!jobId) { res.json({ found: false }); return; }
  const job = jobs.get(jobId);
  if (!job) { gameIdToJobId.delete(gameId); res.json({ found: false }); return; }
  res.json({ found: true, jobId, status: job.status });
});

// Extracts the partial Luau script from the raw streaming JSON Claude outputs.
// The raw string looks like: { "title": "...", ... "luau_script": "Scene.SetSkybox(\"day\")\n..." }
// We parse out the Luau manually so we don't need a complete (valid) JSON object.
function extractPartialLuau(raw: string): string {
  const markerIdx = raw.indexOf('"luau_script"');
  if (markerIdx === -1) return '';

  // Find the opening quote of the value
  let i = markerIdx + '"luau_script"'.length;
  while (i < raw.length && raw[i] !== '"') i++;
  if (i >= raw.length) return '';
  i++; // skip opening quote

  // Decode the JSON string one character at a time
  let decoded = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') break; // closing quote — complete string
    if (ch === '\\') {
      const next = raw[i + 1];
      if      (next === 'n')  { decoded += '\n'; i += 2; }
      else if (next === 't')  { decoded += '\t'; i += 2; }
      else if (next === '"')  { decoded += '"';  i += 2; }
      else if (next === '\\') { decoded += '\\'; i += 2; }
      else if (next === 'r')  { decoded += '\r'; i += 2; }
      else if (next === undefined) { break; } // incomplete escape at end of stream
      else { decoded += next; i += 2; }
    } else {
      decoded += ch;
      i++;
    }
  }

  // Trim to the last complete line so we never send a half-written statement
  const lastNewline = decoded.lastIndexOf('\n');
  return lastNewline > 0 ? decoded.substring(0, lastNewline) : '';
}

// GET /api/forge-game/partial/:jobId — live code stream while generating
app.get('/api/forge-game/partial/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  const partialLuau = job.status === 'pending'
    ? extractPartialLuau(job.partialCode ?? '')
    : '';
  res.json({ status: job.status, partialLuau });
});

// POST /api/edit-game  { gameId, userMessage, history?, userAccessToken? } — rate-limited: 20 per minute per IP
app.post('/api/edit-game', rateLimit(60_000, 20), async (req, res) => {
  const { gameId, userMessage, history = [], userAccessToken = '' } = req.body as {
    gameId: number;
    userMessage: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    userAccessToken?: string;
  };

  if (!gameId || !userMessage?.trim()) {
    res.status(400).json({ error: 'gameId and userMessage are required' });
    return;
  }
  const editCheck = moderationCheck(userMessage, 'prompt', { id: userAccessToken ? userIdFromJwt(userAccessToken) : `ip:${req.ip}` }, { targetType: 'game', targetId: String(gameId) });
  if (!editCheck.ok) {
    res.status(400).json({ error: editCheck.userMessage ?? 'This request violates our usage policy.' });
    return;
  }

  const game = games.get(Number(gameId));
  if (!game) { res.status(404).json({ error: 'Game not found' }); return; }
  if (!game.gameCode) { res.status(400).json({ error: 'Game has not finished generating yet' }); return; }

  const currentCode = game.gameCode;

  // Tell Claude what models already exist so it doesn't re-request them
  const existingUrls = JSON.parse(game.assetUrlsJson || '{}') as Record<string, string>;
  const existingIds  = Object.keys(existingUrls);
  const assetContext = existingIds.length > 0
    ? `EXISTING 3D MODELS (already loaded — do NOT re-request these): ${existingIds.join(', ')}`
    : 'No custom 3D models in this game yet.';

  const recentHistory = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 500) }));

  try {
    const editCatalogSection = await buildCatalogSection(userMessage);
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 32000,
      system: LUAU_EDIT_SYSTEM + editCatalogSection,
      messages: [
        { role: 'user', content: `EXISTING GAME CODE:\n\`\`\`lua\n${currentCode}\n\`\`\`\n\n${assetContext}` },
        { role: 'assistant', content: 'I have reviewed the existing Luau game code and the current 3D model assets.' },
        ...recentHistory,
        { role: 'user', content: userMessage.trim().slice(0, 1000) },
      ],
    });

    const raw = msg.content[0].type === 'text' ? msg.content[0].text : '';

    // Log Anthropic token usage for this edit
    const editIn    = msg.usage?.input_tokens  ?? 0;
    const editOut   = msg.usage?.output_tokens ?? 0;
    const editCacheRead = (msg.usage as any)?.cache_read_input_tokens ?? 0;
    const editCost  = (editIn * 3 + editCacheRead * 0.30 + editOut * 15) / 1_000_000;
    console.log(`[edit-game] Anthropic usage: ${editIn} in + ${editCacheRead} cache_read + ${editOut} out → $${editCost.toFixed(4)} (game ${gameId})`);

    let parsed: { reply?: string; luau_script?: string; asset_manifest?: AssetManifestItem[] };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      res.status(500).json({ error: 'AI returned invalid JSON' });
      return;
    }

    if (parsed.luau_script) {
      game.gameCode = parsed.luau_script;
      if (SUPABASE_URL) {
        sbPatch('forge_games', Number(gameId), {
          game_code: parsed.luau_script, updated_at: new Date().toISOString(),
        }, userAccessToken || undefined).catch(e => console.error('[edit-game] Supabase patch failed:', e));
      }
      // Hot-reload any active rooms for this game
      roomManager.hot_reload_game(String(gameId), parsed.luau_script)
        .then(n => { if (n > 0) console.log(`[edit-game] hot-reloaded ${n} active room(s) for game ${gameId}`); })
        .catch(e => console.warn('[edit-game] hot-reload failed:', e));
    }

    // Resolve any newly-referenced catalog assets. Resolution is an instant
    // catalog lookup (no Meshy), but we keep the async-job shape so the client's
    // existing poll of /api/edit-game/assets/:jobId still works.
    const { items: newManifest } = validateManifest(parsed.asset_manifest);
    const pendingItems = newManifest.filter(m => !existingUrls[m.id]);

    let assetJobId: string | undefined;
    if (pendingItems.length > 0) {
      assetJobId = randomUUID();
      const existingHumanoidIds = JSON.parse(game.humanoidIdsJson || '[]') as string[];

      const { urls: newUrls, humanoidIds: newHumanoidIds, sizeHints: newSizeHints, warnings } = await resolveCatalogManifest(pendingItems);
      for (const w of warnings) console.warn(`[edit-assets] ⚠ ${w} (game ${gameId})`);
      const merged = { ...existingUrls, ...newUrls };
      const allHumanoidIds = [...new Set([...existingHumanoidIds, ...newHumanoidIds])];
      const existingSizeHints = JSON.parse(game.sizeHintsJson || '{}') as Record<string, number>;
      const allSizeHints = { ...existingSizeHints, ...newSizeHints };
      game.assetUrlsJson   = JSON.stringify(merged);
      game.humanoidIdsJson = JSON.stringify(allHumanoidIds);
      game.sizeHintsJson   = JSON.stringify(allSizeHints);
      editAssetJobs.set(assetJobId, {
        status:         'done',
        assetUrlsJson:  game.assetUrlsJson,
        humanoidIdsJson: game.humanoidIdsJson,
        sizeHintsJson:  game.sizeHintsJson,
      });
      if (SUPABASE_URL) {
        sbPatch('forge_games', Number(gameId), {
          asset_urls_json: merged, humanoid_ids_json: allHumanoidIds,
          updated_at: new Date().toISOString(),
        }, userAccessToken || undefined).catch(e => console.error('[edit-assets] Supabase patch failed:', e));
      }
      console.log(`[edit-assets] job ${assetJobId} done — ${Object.keys(newUrls).length} new catalog model(s)`);
    }

    res.json({
      reply:       parsed.reply      ?? 'Done!',
      luau_script: parsed.luau_script ?? currentCode,
      assetJobId,
    });
  } catch (err) {
    console.error('[edit-game]', err);
    res.status(500).json({ error: 'AI edit failed' });
  }
});

// GET /api/edit-game/assets/:jobId — poll background Meshy generation for an edit
app.get('/api/edit-game/assets/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = editAssetJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Asset job not found' }); return; }
  res.json(job);
});

// Returns a Game view where the live fields reflect the published snapshot.
// Empty snapshot fields fall back to the draft for backwards compatibility with
// games published before the published_* columns existed.
function withPublishedView(g: Game): Game {
  return {
    ...g,
    gameCode:        g.publishedGameCode        || g.gameCode,
    title:           g.publishedTitle           || g.title,
    description:     g.publishedDescription     || g.description,
    genre:           g.publishedGenre           || g.genre,
    thumbnailUrl:    g.publishedThumbnailUrl    || g.thumbnailUrl,
    assetUrlsJson:   g.publishedAssetUrlsJson   || g.assetUrlsJson,
    humanoidIdsJson: g.publishedHumanoidIdsJson || g.humanoidIdsJson,
    // Apply the frozen editor state for public players. Falls back to the live
    // draft so games published before this column existed still get the
    // creator's tweaks (best-effort — same backwards-compat pattern as the
    // other published_* fields).
    editorStateJson: g.publishedEditorStateJson || g.editorStateJson,
  };
}

// GET /api/game/:id  AND  GET /games/:id  (both routes, PludoApiClient uses /games/:id)
//   ?published=true → return the snapshot taken at the most recent publish.
//   (default)      → return the live draft (used by the editor).
async function serveGame(req: Request, res: Response) {
  const id        = Number(req.params.id);
  const published = String(req.query.published ?? '') === 'true';
  let   game      = games.get(id);

  // Fall back to Supabase when the game isn't cached in memory (e.g. after a restart).
  if (!game && SUPABASE_URL) {
    const row = await sbGetById('forge_games', id).catch(() => null);
    if (row) game = dbRowToGame(row);
  }

  if (!game) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(published ? withPublishedView(game) : game);
}
app.get('/api/game/:id', serveGame);
app.get('/games/:id',    serveGame);

// ── Editor state persistence ────────────────────────────────────────────────
// React's CreateScreen debounces (~1.5 s after edits go quiet) and PATCHes the
// captured Unity scene JSON here. The latest autosave IS the canonical
// unpublished draft — there is no version history; every prior save is
// overwritten in place. On publish, the current editor_state_json freezes
// into published_editor_state_json so public players see the creator's edits.
//
// `editor_state_json` is jsonb; we accept either a parsed object on the
// request body (preferred — Express has already parsed it) or a JSON string
// for clients that pre-stringify. The hot in-memory game cache is updated in
// lockstep so a follow-up GET /api/game/:id doesn't return the stale value.

const MAX_EDITOR_STATE_BYTES = 256 * 1024; // 256 KB — generous; a typical scene is ~5 KB

function parseEditorState(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try { return JSON.parse(input) as Record<string, unknown>; }
    catch { return null; }
  }
  return null;
}

// PATCH /api/game/:id/editor-state  — debounced autosave
app.patch('/api/game/:id/editor-state', rateLimit(60_000, 120), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'bad game id' }); return; }
  const game = games.get(id);
  if (!game) { res.status(404).json({ error: 'Game not found' }); return; }

  const { editorState, userAccessToken = '' } = (req.body ?? {}) as {
    editorState?: unknown; userAccessToken?: string;
  };
  const parsed = parseEditorState(editorState);
  if (!parsed) { res.status(400).json({ error: 'editorState (object or JSON string) required' }); return; }

  const json = JSON.stringify(parsed);
  if (json.length > MAX_EDITOR_STATE_BYTES) {
    res.status(413).json({ error: `editor state too large (${json.length} > ${MAX_EDITOR_STATE_BYTES})` });
    return;
  }

  if (SUPABASE_URL) {
    // PostgREST default is a silent no-op when RLS filters out the row: the
    // request returns 204 with no body and the user thinks the save succeeded
    // while the DB is unchanged. We use `Prefer: return=representation` so the
    // response includes the patched rows; an empty array means RLS rejected
    // and we surface the auth failure to the client instead of pretending
    // the autosave landed.
    const updatedAtIso = new Date().toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/forge_games?id=eq.${id}&select=id`, {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${sbBearer(userAccessToken || undefined)}`,
        'Prefer':        'return=representation',
      },
      body: JSON.stringify({ editor_state_json: parsed, updated_at: updatedAtIso }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`[editor-state] Supabase patch failed (${r.status}): ${body}`);
      res.status(500).json({ error: 'persist failed' }); return;
    }
    const rows = await r.json() as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) {
      // RLS filtered the row out — most commonly the user is signed out or
      // their JWT has expired. Tell the client so they can re-auth and retry
      // instead of losing the edit silently.
      console.warn(`[editor-state] PATCH #${id} matched 0 rows — auth or ownership mismatch`);
      res.status(403).json({ error: 'not authorized to save this game (sign in and retry)' });
      return;
    }
    game.editorStateJson = json;
    game.updatedAt = new Date(updatedAtIso);
  } else {
    // No Supabase configured — keep cache update for in-memory dev only.
    game.editorStateJson = json;
    game.updatedAt = new Date();
  }
  // Push the fresh overlay into any active draft rooms so co-editors / preview
  // sessions see the creator's tweaks within one tick. Public (`:pub`) rooms
  // are unaffected — they read published_editor_state_json which only changes
  // on /api/game/:id/publish.
  try {
    const n = roomManager.hot_reload_editor_state(String(id), game.editorStateJson);
    if (n > 0) console.log(`[editor-state] PATCH #${id} hot-applied to ${n} draft room(s)`);
  } catch (e) {
    console.warn('[editor-state] hot-reload failed:', e);
  }
  res.json({ ok: true, savedAt: game.updatedAt.toISOString() });
});


// GET /api/game/:id/html  — serve playable game HTML
app.get('/api/game/:id/html', (req, res) => {
  const game = games.get(Number(req.params.id));
  if (!game) { res.status(404).send('Game not found'); return; }
  if (!game.gameCode) { res.status(202).send('Game is still generating, try again in a moment.'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildGameHtml(game.gameCode));
});

// GET /api/meshy-queue — live semaphore stats (active slots, queued models)
app.get('/api/meshy-queue', (_req, res) => {
  res.json({ active: meshySem.active, waiting: meshySem.waiting, capacity: 10, perGameLimit: 6 });
});

// GET /api/meshy-balance — live credit balance from Meshy API
app.get('/api/meshy-balance', async (_req, res) => {
  if (meshyDevMode()) { res.json({ balance: null, devMode: true }); return; }
  const balance = await getBalance();
  res.json({ balance: balance >= 0 ? balance : null });
});

// GET /api/games — the public feed. Returns the published snapshot of each
// game (title/description/genre/thumbnail) so post-publish draft edits don't
// retitle a published game in Home/Explore. Falls back to the live draft for
// games published before the snapshot columns existed.
app.get('/api/games', (_req, res) => {
  console.log(`[/api/games] hit from ${_req.ip ?? 'unknown'} ua=${(_req.headers['user-agent'] ?? '').toString().slice(0, 60)}`);
  const list = Array.from(games.values())
    .filter(g => g.published && !!(g.publishedGameCode || g.gameCode))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(g => ({
      id: g.id,
      title:        g.publishedTitle        || g.title,
      description:  g.publishedDescription  || g.description,
      genre:        g.publishedGenre        || g.genre,
      plays:        g.plays, isHot: g.isHot, tags: g.tags, creatorName: g.creatorName,
      thumbnailUrl: g.publishedThumbnailUrl || g.thumbnailUrl,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
      hasCode: true,
    }));
  res.json({ games: list });
});

// ── Avatar items catalog ──────────────────────────────────────────────────────
// Populated by Meshy generation; initially empty until items are created.

interface AvatarItem {
  id: number;
  name: string;
  category: string;
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  price: number;
  imageUrl?: string;
  thumbnailUrl?: string;
  modelUrl?: string;
  description?: string;
  creatorName?: string;
  createdAt: Date;
}

let _nextItemId = 1;
const avatarItems = new Map<number, AvatarItem>();

// GET /api/assets  — list every 3D model in the R2 bucket (pludo-assets-dev in
// dev, pludo-assets in prod) under the game-assets/v1/ prefix.
//
// R2 is the source of truth. The Supabase asset_cache index supplies
// prompt/humanoid metadata when available; for any R2 keys not yet indexed we
// backfill a stub entry (prompt = bare hash) so future hits stay consistent.
// Falls back to the cache index if R2 isn't configured locally.
//
// Optional ?q= filter does case-insensitive substring match on the prompt label.
app.get('/api/assets', async (req, res) => {
  const q     = String(req.query.q ?? '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 200), 500);

  type AssetOut = {
    cacheKey: string;
    prompt: string;
    isHumanoid: boolean;
    modelUrl: string | null;
    title: string | null;
    thumbnailUrl: string | null;
  };
  // Shared catalog enumeration (also feeds the forge's asset selection).
  const catalog = await getCatalog();
  const items: AssetOut[] = catalog.map(c => ({
    cacheKey:     c.key,
    prompt:       c.label,
    isHumanoid:   c.isHumanoid,
    sizeHint:     c.sizeHint,
    modelUrl:     publicUrl(c.key),
    title:        c.title,
    thumbnailUrl: c.thumbnailUrl,
  }));

  const total       = items.length;
  const withUrl     = items.filter(i => !!i.modelUrl);
  const droppedUrls = total - withUrl.length;
  if (droppedUrls > 0) {
    const envName = process.env.NODE_ENV === 'production' ? 'R2_PROD_PUBLIC_URL' : 'R2_DEV_PUBLIC_URL';
    console.warn(`[assets] Dropped ${droppedUrls}/${total} item(s) with null modelUrl — ${envName} is empty in api-server/.env. UI will show "No assets yet" even though the bucket has objects. Set ${envName} to the public R2.dev URL and restart.`);
  }
  let filtered = withUrl;
  if (q) {
    filtered = filtered.filter(i =>
      (i.title ?? '').toLowerCase().includes(q) ||
      i.prompt.toLowerCase().includes(q)
    );
  }
  filtered = filtered.slice(0, limit);
  res.json({ assets: filtered, total });
});

// GET /api/avatar-items  — returns the public item catalog
app.get('/api/avatar-items', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const cat   = String(req.query.category ?? '');
  let list = Array.from(avatarItems.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (cat) list = list.filter(i => i.category.toLowerCase() === cat.toLowerCase());
  res.json({ items: list.slice(0, limit), total: list.length });
});

// POST /api/avatar-items  — add an item to the catalog (called by generation pipeline)
app.post('/api/avatar-items', async (req, res) => {
  const { name, category, rarity, price, imageUrl, thumbnailUrl, modelUrl, description, creatorName }
    = req.body as Partial<AvatarItem>;
  if (!name || !category) { res.status(400).json({ error: 'name and category required' }); return; }
  const itemActor = { id: `ip:${req.ip}`, name: creatorName };
  const nameCheck = moderationCheck(name, 'item_name', itemActor, { targetType: 'avatar_item' });
  if (!nameCheck.ok) { res.status(422).json({ error: `Name: ${nameCheck.userMessage}` }); return; }
  const descCheck = moderationCheck(description ?? '', 'game_description', itemActor, { targetType: 'avatar_item' });
  if (!descCheck.ok) { res.status(422).json({ error: `Description: ${descCheck.userMessage}` }); return; }
  const preview = await checkModelThumbnail(thumbnailUrl ?? imageUrl, name, itemActor, { type: 'avatar_item' });
  if (!preview.ok) { res.status(422).json({ error: preview.userMessage }); return; }
  const item: AvatarItem = {
    id: _nextItemId++,
    name: nameCheck.text, category,
    rarity: (rarity ?? 'Common') as AvatarItem['rarity'],
    price:  price  ?? 0,
    imageUrl, thumbnailUrl, modelUrl, description: descCheck.text,
    creatorName: safeDisplayName(creatorName ?? 'Pludo', req.ip ?? ''),
    createdAt: new Date(),
  };
  avatarItems.set(item.id, item);
  res.status(201).json(item);
});

// ── Avatar item generation pipeline ──────────────────────────────────────────
// POST /ai/generate-avatar-item  { prompt, creatorName? }
// Returns { jobId } immediately; poll /ai/generate-avatar-item/status/:jobId

const ITEM_FORGE_SYSTEM = `You are Pludo's avatar item designer. Given a creative prompt, design a unique wearable avatar item.

Return a single JSON object. No markdown. No code blocks. Just raw JSON:
{
  "name": "Item name (2-4 punchy words)",
  "category": "head|hair|face|neck|top|bottom|shoes|back|front|waist|accessory",
  "rarity": "Common|Uncommon|Rare|Epic|Legendary",
  "description": "One sentence describing the item's look and feel",
  "meshy_prompt": "Detailed English prompt for Meshy 3D generation: describe the object shape, materials, colors, style. Be specific. Example: 'A golden crown with glowing purple crystals and ornate engravings, fantasy RPG style, high detail'",
  "price": <integer, Common=50 Uncommon=120 Rare=250 Epic=500 Legendary=1200>
}`;

interface ItemJob {
  status: 'pending' | 'modeling' | 'done' | 'error';
  itemId?: number;
  error?: string;
}
const itemJobs = new Map<string, ItemJob>();

app.post('/ai/generate-avatar-item', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
    return;
  }
  const { prompt, creatorName: rawItemCreator = 'Player' } = req.body as { prompt: string; creatorName?: string };
  if (!prompt?.trim()) { res.status(400).json({ error: 'prompt required' }); return; }
  const creatorName = safeDisplayName(rawItemCreator, req.ip ?? '');
  const itemActor = { id: `ip:${req.ip}`, name: creatorName };

  // Prompt gate: lexicon + AI. Runs before any paid Claude/Meshy call.
  const promptCheck = await checkGenerationPrompt(prompt, 'asset_prompt', itemActor, { ai: true });
  if (!promptCheck.ok) { res.status(400).json({ error: promptCheck.userMessage }); return; }

  const jobId = randomUUID();
  itemJobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      // Step 1: AI designs the item
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        system: ITEM_FORGE_SYSTEM,
        messages: [{ role: 'user', content: prompt.trim() }],
      });
      const raw = msg.content[0].type === 'text' ? msg.content[0].text : '';
      let jsonStr = raw.trim();
      const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fence) jsonStr = fence[1];
      const obj = jsonStr.match(/\{[\s\S]*\}/);
      const meta = JSON.parse(obj ? obj[0] : jsonStr) as {
        name: string; category: string; rarity: string;
        description: string; meshy_prompt: string; price: number;
      };
      // Claude's output is derived from user input — moderate it like UGC.
      const metaName = moderationCheck(meta.name, 'item_name', itemActor, { targetType: 'avatar_item' });
      const metaDesc = moderationCheck(meta.description ?? '', 'game_description', itemActor, { targetType: 'avatar_item' });
      const metaMeshy = moderationCheck(meta.meshy_prompt ?? '', 'asset_prompt', itemActor, { targetType: 'avatar_item' });
      if (!metaMeshy.ok) throw new Error('MODERATION: generated model prompt failed review');
      meta.name = metaName.ok ? metaName.text : 'Mystery Item';
      meta.description = metaDesc.ok ? metaDesc.text : '';

      // Step 2: Generate 3D model with Meshy (if API key available)
      let glbUrl: string | undefined;
      let thumbnailUrl: string | undefined;
      if (process.env.MESHY_API_KEY) {
        itemJobs.set(jobId, { status: 'modeling' });
        const previewId = await createPreview(meta.meshy_prompt);
        const task      = await waitForTask(previewId, 150_000);
        glbUrl       = task.model_urls?.glb;
        thumbnailUrl = task.thumbnail_url;
        // Post-generation gate: look at the actual rendered model.
        const look = await checkModelThumbnail(thumbnailUrl, `${meta.name}: ${meta.meshy_prompt}`, itemActor, { type: 'avatar_item' });
        if (!look.ok) throw new Error('MODERATION: generated model failed visual review');
      }

      // Step 3: Save to catalog
      const item: AvatarItem = {
        id:           _nextItemId++,
        name:         meta.name,
        category:     meta.category,
        rarity:       (meta.rarity ?? 'Common') as AvatarItem['rarity'],
        price:        meta.price ?? 100,
        description:  meta.description,
        creatorName:  creatorName,
        modelUrl:     glbUrl,
        thumbnailUrl: thumbnailUrl,
        imageUrl:     thumbnailUrl,
        createdAt:    new Date(),
      };
      avatarItems.set(item.id, item);
      itemJobs.set(jobId, { status: 'done', itemId: item.id });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const userMsg = msg.startsWith('MODERATION') ? 'This item didn’t pass our content review. Try a different idea.'
        : msg.includes('MESHY_API_KEY') ? 'Meshy API key not configured'
        : msg.includes('credit balance') ? 'Anthropic API out of credits'
        : 'Item generation failed — try a different prompt';
      itemJobs.set(jobId, { status: 'error', error: userMsg });
    }
  })();
});

app.get('/ai/generate-avatar-item/status/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = itemJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status === 'done' && job.itemId != null) {
    res.json({ status: 'done', item: avatarItems.get(job.itemId) ?? null });
  } else {
    res.json(job);
  }
});

// GET /api/my-games?userId=<uuid>&creatorName=<name>&userAccessToken=<jwt>
app.get('/api/my-games', async (req, res) => {
  const userAccessToken = String(req.query.userAccessToken ?? '');
  // Resolve userId: prefer explicit param, fall back to JWT sub claim
  let userId      = String(req.query.userId      ?? '');
  const creatorName = String(req.query.creatorName ?? '');
  if (!userId && userAccessToken) {
    userId = userIdFromJwt(userAccessToken);
  }

  const seenIds = new Set<number>();

  const toStub = (g: { id: number; title: string; description: string; genre: string; plays: number; thumbnailUrl?: string; gameCode?: string; hasCode?: boolean }) => ({
    id:           g.id,
    title:        g.title,
    description:  g.description,
    genre:        g.genre,
    plays:        g.plays,
    thumbnailUrl: g.thumbnailUrl ?? '',
    hasCode:      !!(g.gameCode ?? g.hasCode),
  });

  const rowToStub = (r: Record<string, unknown>) => ({
    id:           Number(r.id),
    title:        String(r.title        ?? 'Untitled'),
    description:  String(r.description  ?? ''),
    genre:        String(r.genre        ?? 'Action'),
    plays:        Number(r.plays        ?? 0),
    thumbnailUrl: String(r.thumbnail_url ?? ''),
    hasCode:      !!(r.game_code as string),
  });

  let list: ReturnType<typeof toStub>[] = [];

  if (SUPABASE_URL) {
    // Primary: filter by userId (authenticated)
    if (userId && userId.length > 10) {
      const rows = await sbGetByUser('forge_games', userId).catch(() => [] as Record<string, unknown>[]);
      for (const r of rows) {
        seenIds.add(Number(r.id));
        list.push(rowToStub(r));
      }
    }

    // Fallback: filter by creator_name for anonymous / pre-auth sessions
    if (creatorName) {
      const rows = await sbGetByCreatorName('forge_games', creatorName).catch(() => [] as Record<string, unknown>[]);
      for (const r of rows) {
        const id = Number(r.id);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          list.push(rowToStub(r));
        }
      }
    }
  }

  // In-memory fallback covers games whose Supabase insert failed this session
  const memFilter = userId
    ? (g: Game) => g.createdByUserId === userId
    : creatorName
    ? (g: Game) => g.creatorName === creatorName
    : () => false;

  const memGames = Array.from(games.values())
    .filter(g => memFilter(g) && !seenIds.has(g.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(g => toStub({ ...g, gameCode: g.gameCode }));
  list = list.concat(memGames);

  res.json({ games: list });
});

// ── /ai/generate-game-luau — matches PludoApiClient.CreateLuauGame() ─────────
// Returns { jobId } immediately; client polls /ai/generate-game-luau/status/:jobId

const luauJobs = new Map<string, { status: string; result?: Record<string, unknown>; error?: string }>();

app.post('/ai/generate-game-luau', (req, res) => {
  const { prompt, creatorName: rawLuauCreator = 'Player' } = req.body as { prompt: string; creatorName?: string };
  if (!prompt?.trim()) { res.status(400).json({ error: 'prompt required' }); return; }
  const creatorName = safeDisplayName(rawLuauCreator, req.ip ?? '');
  const luauCheck = moderationCheck(prompt, 'prompt', { id: `ip:${req.ip}`, name: creatorName });
  if (!luauCheck.ok) { res.status(400).json({ error: luauCheck.userMessage }); return; }

  const jobId = randomUUID();
  const callerIp = req.ip ?? '';
  luauJobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      const { template: luauKwTemplate, score: luauScore, confident: luauConfident } = selectTemplate(prompt.trim());
      const luauTemplate = (!luauConfident && luauKwTemplate !== null)
        ? (await resolveTemplateViaClaude(prompt.trim()) ?? luauKwTemplate)
        : luauKwTemplate;
      if (luauTemplate) console.log(`[generate-game-luau] matched template: ${luauTemplate.genre} (score=${luauScore}${luauConfident ? '' : ' via Claude fallback'})`);
      const luauExamples = luauTemplate ? (templateSuccesses.get(luauTemplate.genre) ?? []) : [];
      const luauTemplatePrompt = buildTemplatePrompt(prompt.trim(), luauTemplate, luauExamples);
      const luauCatalogSection = await buildCatalogSection(prompt.trim());
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 32000,
        system: LUAU_FORGE_SYSTEM + luauCatalogSection,
        messages: [{ role: 'user', content: luauTemplatePrompt }],
      });
      if (msg.stop_reason === 'max_tokens') throw new Error('Script too long — try a simpler game description');
      const raw = msg.content[0].type === 'text' ? msg.content[0].text : '';
      let jsonStr = raw.trim();
      const fenceMatch2 = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch2) jsonStr = fenceMatch2[1];
      const objMatch2 = jsonStr.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(objMatch2 ? objMatch2[0] : jsonStr) as Record<string, unknown>;
      const luauScript = typeof parsed.luau_script === 'string' ? parsed.luau_script : '';
      if (!luauScript) throw new Error('No luau_script in response');

      // Map Claude's selected catalog keys → GLB proxy URLs. No Meshy generation.
      luauJobs.set(jobId, { status: 'assets', result: undefined, error: undefined });
      const { items: manifest } = validateManifest(parsed.asset_manifest);
      const { urls: assetUrls, humanoidIds, sizeHints } = await resolveCatalogManifest(manifest);

      luauJobs.set(jobId, {
        status: 'done',
        result: {
          title:              parsed.title              ?? 'Untitled',
          description:        parsed.description        ?? '',
          genre:              luauTemplate?.genre ?? (typeof parsed.genre === 'string' ? parsed.genre : 'action'),
          tags:               parsed.tags               ?? [],
          thumbnail_prompt:   parsed.thumbnail_prompt   ?? '',
          estimated_duration: parsed.estimated_duration ?? '2-5 min',
          player_count:       parsed.player_count       ?? '1',
          difficulty:         parsed.difficulty         ?? 'medium',
          gameCode:           luauScript,
          assetUrlsJson:      JSON.stringify(assetUrls),
          humanoidIdsJson:    JSON.stringify(humanoidIds),
          sizeHintsJson:      JSON.stringify(sizeHints),
        },
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const userMsg = msg.includes('credit balance') ? 'Add Anthropic credits at console.anthropic.com'
        : msg.includes('401') ? 'Invalid Anthropic API key'
        : 'Generation failed';
      luauJobs.set(jobId, { status: 'error', error: userMsg });
    }
  })();
});

app.get('/ai/generate-game-luau/status/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = luauJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// POST /games  — save a game (called by PludoApiClient after generation)
app.post('/games', (req, res) => {
  const { title, description, genre, gameCode, creatorName, tags, assetUrlsJson } = req.body as Partial<Game>;
  if (!gameCode) { res.status(400).json({ error: 'gameCode required' }); return; }
  // ensureUser removed — user registry now queries Supabase directly
  const game = createGame({ title, description, genre, gameCode, creatorName, tags,
    assetUrlsJson: typeof assetUrlsJson === 'string' ? assetUrlsJson : '{}' });
  res.status(201).json(game);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── User registry + friends ───────────────────────────────────────────────────

// GET /api/users/search?q=alice  — searches real accounts from the profiles table.
// Returns { users: [{ id, username, handle }] }.
app.get('/api/users/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.json({ users: [] });
    return;
  }

  try {
    let url = `${SUPABASE_URL}/rest/v1/profiles?select=id,username,display_name&limit=30&order=username.asc`;
    if (q) {
      url += `&or=(username.ilike.${encodeURIComponent(`*${q}*`)},display_name.ilike.${encodeURIComponent(`*${q}*`)})`;
    }

    const r = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept':        'application/json',
      },
    });

    if (!r.ok) {
      console.error('[users/search] Supabase error:', r.status, await r.text());
      res.json({ users: [] });
      return;
    }

    const rows = await r.json() as Array<{ id: string; username: string; display_name: string }>;
    const users = rows.map(row => ({
      id:       row.id,
      username: row.username,
      handle:   row.username.toLowerCase().replace(/\s+/g, '_'),
    }));
    res.json({ users });
  } catch (err) {
    console.error('[users/search] fetch error:', err);
    res.json({ users: [] });
  }
});

// ── Meshy 3D model generation ─────────────────────────────────────────────────

interface MeshyJob {
  status: 'pending' | 'preview' | 'refining' | 'done' | 'error';
  previewTaskId?: string;
  refineTaskId?: string;
  glbUrl?: string;
  thumbnailUrl?: string;
  error?: string;
}
const meshyJobs = new Map<string, MeshyJob>();

// POST /api/meshy/generate  { prompt, refine? }
// Returns a jobId immediately; poll /api/meshy/status/:jobId for results.
app.post('/api/meshy/generate', async (req, res) => {
  if (!process.env.MESHY_API_KEY) {
    res.status(503).json({ error: 'MESHY_API_KEY not configured' });
    return;
  }
  const { prompt, refine = false } = req.body as { prompt: string; refine?: boolean };
  if (!prompt?.trim()) { res.status(400).json({ error: 'prompt required' }); return; }
  const meshyActor = { id: `ip:${req.ip}` };
  const meshyCheck = await checkGenerationPrompt(prompt, 'asset_prompt', meshyActor, { ai: true });
  if (!meshyCheck.ok) { res.status(400).json({ error: meshyCheck.userMessage }); return; }

  const jobId = randomUUID();
  meshyJobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      meshyJobs.set(jobId, { status: 'preview' });
      const previewId = await createPreview(prompt.trim());
      const previewTask = await waitForTask(previewId, 120_000);
      const look = await checkModelThumbnail(previewTask.thumbnail_url, prompt, meshyActor, { type: 'asset', id: previewId });
      if (!look.ok) { meshyJobs.set(jobId, { status: 'error', error: look.userMessage }); return; }
      if (!refine) {
        meshyJobs.set(jobId, {
          status: 'done',
          previewTaskId: previewId,
          glbUrl: previewTask.model_urls?.glb,
          thumbnailUrl: previewTask.thumbnail_url,
        });
        return;
      }
      meshyJobs.set(jobId, { status: 'refining', previewTaskId: previewId, thumbnailUrl: previewTask.thumbnail_url });
      const refineId = await createRefine(previewId);
      const refineTask = await waitForTask(refineId, 180_000);
      meshyJobs.set(jobId, {
        status: 'done',
        previewTaskId: previewId,
        refineTaskId: refineId,
        glbUrl: refineTask.model_urls?.glb ?? previewTask.model_urls?.glb,
        thumbnailUrl: refineTask.thumbnail_url ?? previewTask.thumbnail_url,
      });
    } catch (err) {
      console.error('[meshy]', err);
      meshyJobs.set(jobId, { status: 'error', error: String((err as Error)?.message ?? err) });
    }
  })();
});

// GET /api/meshy/status/:jobId
app.get('/api/meshy/status/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = meshyJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// POST /api/game/:id/publish — marks a game as published so it appears in the Games feed.
// Snapshots the draft (gameCode, title, description, genre, thumbnail, asset/humanoid JSON)
// into the published_* fields so further edits don't leak into the public version. The
// public play path reads those frozen fields; the editor keeps reading the draft.
app.post('/api/game/:id/publish', async (req, res) => {
  const id = Number(req.params.id);
  const { userAccessToken = '' } = req.body as { userAccessToken?: string };
  let game = games.get(id);
  if (!game && SUPABASE_URL) {
    const row = await sbGetById('forge_games', id).catch(() => null);
    if (row) game = dbRowToGame(row);
  }
  if (!game) { res.status(404).json({ error: 'Game not found' }); return; }

  // ── Moderation gate: title + description (lexicon + AI review) ─────────────
  const publisherId = userAccessToken ? userIdFromJwt(userAccessToken) : '';
  const verdict = await checkPublish(game.title, game.description, { id: publisherId || `ip:${req.ip}`, name: game.creatorName }, String(id));
  if (!verdict.ok) {
    res.status(422).json({ error: verdict.userMessage ?? 'This game doesn’t meet our community guidelines.', moderation: true });
    return;
  }
  game.title = verdict.title;
  game.description = verdict.description;

  const publishedAt = new Date();
  const snapshotPatch: Record<string, unknown> = {
    is_published: true,
    updated_at: publishedAt.toISOString(),
    published_game_code:         game.gameCode,
    published_title:             game.title,
    published_description:       game.description,
    published_genre:             game.genre,
    published_thumbnail_url:     game.thumbnailUrl,
    // jsonb columns — pass parsed JSON so PostgREST stores objects, not strings.
    published_asset_urls_json:   safeParseJson(game.assetUrlsJson,   {}),
    published_humanoid_ids_json: safeParseJson(game.humanoidIdsJson, []),
    // Freeze the current editor session so the creator's transform tweaks,
    // gear-panel settings, and Custom Logic graphs land in the public play.
    published_editor_state_json: safeParseJson(game.editorStateJson,  {}),
    published_at:                publishedAt.toISOString(),
  };
  // Persist before flipping the in-memory flag so a server restart can't quietly
  // re-introduce the unpublished state. If the row write fails, surface it to
  // the client instead of pretending the publish succeeded.
  if (userAccessToken && SUPABASE_URL) {
    let snapshotPersisted = true;
    try {
      await sbPatch('forge_games', id, snapshotPatch, userAccessToken);
    } catch (e) {
      // If the published_* columns don't exist yet (migration 015 not applied),
      // PostgREST returns 400 PGRST204. Fall back to flipping is_published only
      // so the publish flow keeps working; the in-memory snapshot is still
      // honored by /api/game-ws?published=true within this server's lifetime.
      const msg = String((e as Error)?.message ?? e);
      snapshotPersisted = false;
      console.warn(`[publish] full snapshot patch failed, falling back to is_published only: ${msg}`);
      try {
        await sbPatch('forge_games', id, { is_published: true, updated_at: publishedAt.toISOString() }, userAccessToken);
      } catch (e2) {
        console.error('[publish] Supabase patch failed:', e2);
        res.status(502).json({ error: 'Could not persist publish status' });
        return;
      }
    }
    if (!snapshotPersisted) {
      console.warn(`[publish] game ${id} snapshot exists only in memory — apply migration 015_published_snapshot.sql to persist it.`);
    }
  }
  game.published                = true;
  game.publishedGameCode        = game.gameCode;
  game.publishedTitle           = game.title;
  game.publishedDescription     = game.description;
  game.publishedGenre           = game.genre;
  game.publishedThumbnailUrl    = game.thumbnailUrl;
  game.publishedAssetUrlsJson   = game.assetUrlsJson;
  game.publishedHumanoidIdsJson = game.humanoidIdsJson;
  game.publishedEditorStateJson = game.editorStateJson;
  game.publishedAt              = publishedAt;
  res.json({ ok: true });
});

function safeParseJson(raw: string, fallback: unknown): unknown {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// PUT /api/game/:id/script — update game script directly (used for undo/redo)
app.put('/api/game/:id/script', async (req, res) => {
  const id = Number(req.params.id);
  const { luau_script, userAccessToken = '' } = req.body as { luau_script?: string; userAccessToken?: string };
  if (!luau_script) { res.status(400).json({ error: 'luau_script required' }); return; }
  let game = games.get(id);
  if (!game && SUPABASE_URL) {
    const row = await sbGetById('forge_games', id).catch(() => null);
    if (row) game = dbRowToGame(row);
  }
  if (!game) { res.status(404).json({ error: 'Game not found' }); return; }
  game.gameCode = luau_script;
  roomManager.hot_reload_game(String(id), luau_script).catch(e => console.warn('[put-script] hot-reload failed:', e));
  if (userAccessToken && SUPABASE_URL) {
    sbPatch('forge_games', id, { game_code: luau_script, updated_at: new Date().toISOString() }, userAccessToken)
      .catch(e => console.warn('[put-script] Supabase patch failed:', e));
  }
  res.json({ ok: true });
});

// POST /api/game/:id/thumbnail — receive a base64-encoded JPEG from Unity, upload to
// R2 (or in-memory in dev), and update forge_games.thumbnail_url.
//
// Two-phase pipeline: Unity sends a placeholder capture ~3 s after the game starts and
// a final capture ~5 s later (after Meshy assets render). The two are stored under
// different R2 keys so the final replaces the placeholder cleanly:
//   placeholder → game-thumbnails/{id}_placeholder.jpg
//   final       → game-thumbnails/{id}.jpg
//
// DB write rules:
//   - final:       always overwrites forge_games.thumbnail_url
//   - placeholder: only writes when thumbnail_url is currently empty (so a previously
//                  saved final isn't reverted by a fresh placeholder on a re-open).
//
// Always writes an absolute URL so Unity's image renderer can resolve it. When R2 is
// configured with a public CDN URL we use that; otherwise we fall back to serving the
// JPEG via this same api-server (in-memory or R2 round-trip via /api/glb/*).
app.post('/api/game/:id/thumbnail', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) { res.status(400).json({ error: 'invalid game id' }); return; }

  const { imageBase64, isFinal } = req.body as { imageBase64?: string; isFinal?: boolean };
  if (!imageBase64) { res.status(400).json({ error: 'imageBase64 required' }); return; }

  let buf: Buffer;
  try { buf = Buffer.from(imageBase64, 'base64'); }
  catch { res.status(400).json({ error: 'invalid base64' }); return; }

  if (buf.length < 100) { res.status(400).json({ error: 'image too small' }); return; }

  const phase: 'final' | 'placeholder' = isFinal ? 'final' : 'placeholder';
  const key = phase === 'final'
    ? `game-thumbnails/${id}.jpg`
    : `game-thumbnails/${id}_placeholder.jpg`;
  // Absolute fallback URL pointing at this api-server, used whenever there's no R2 CDN URL.
  // req.protocol/req.get('host') honor X-Forwarded-* via app.set('trust proxy') if set.
  const fallbackUrl = `${req.protocol}://${req.get('host')}/api/glb/${key}`;

  let url: string;
  try {
    if (r2Configured()) {
      await uploadBuffer(key, buf, 'image/jpeg');
      url = publicUrl(key) ?? fallbackUrl;
    } else {
      glbBuffers.set(key, buf);
      url = fallbackUrl;
    }
  } catch (err) {
    console.error(`[thumbnail] ${phase} upload failed for game ${id}:`, err);
    res.status(500).json({ error: 'upload failed' });
    return;
  }

  // Forward the user's JWT (if Unity sent one) so the forge_games UPDATE RLS policy
  // (created_by_user_id = auth.uid()) is satisfied; without it the PATCH succeeds
  // with 0 rows affected and thumbnail_url stays empty.
  const auth = req.get('authorization') ?? '';
  const jwt  = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : undefined;

  // Decide whether this upload should win the DB write.
  let shouldWriteDb = phase === 'final';
  if (phase === 'placeholder') {
    // Only set placeholder when current value is empty/null — never clobber a final.
    const current = await sbGetById('forge_games', id);
    const existing = (current?.thumbnail_url as string | undefined) ?? '';
    shouldWriteDb = !existing;
  }

  if (shouldWriteDb) {
    await sbPatch('forge_games', id, { thumbnail_url: url }, jwt).catch(e =>
      console.warn(`[thumbnail] Supabase patch failed for game ${id} (${phase}):`, e),
    );
    const game = games.get(id);
    if (game) game.thumbnailUrl = url;
  }

  console.log(`[thumbnail] ${phase} uploaded for game ${id} (${buf.length} bytes)` +
              `${shouldWriteDb ? '' : ' (DB write skipped — final already set)'} → ${url}`);
  res.json({ url, phase, persisted: shouldWriteDb });
});

// ── Game social: likes, comments, plays, summary ──────────────────────────────
// Public read endpoints; writes require a valid Supabase JWT (extracted via
// userIdFromJwt — anonymous viewers can browse but not interact).

const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY;

async function sbCount(table: string, filter: string): Promise<number> {
  if (!SUPABASE_URL) return 0;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&select=*`, {
    headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) return 0;
  const range = r.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  return total && total !== '*' ? parseInt(total, 10) : 0;
}

// GET /api/game/:id/social — { likes, comments, plays, likedByMe, recentComments[] }
app.get('/api/game/:id/social', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) { res.status(400).json({ error: 'invalid id' }); return; }
  const auth = req.get('authorization') ?? '';
  const jwt  = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const me   = jwt ? userIdFromJwt(jwt) : '';

  const [likes, comments, commentsRaw, mineRaw] = await Promise.all([
    sbCount('game_likes',    `game_id=eq.${id}`),
    sbCount('game_comments', `game_id=eq.${id}`),
    fetch(`${SUPABASE_URL}/rest/v1/game_comments?game_id=eq.${id}&order=created_at.desc&limit=50`, {
      headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
    }).then(r => r.ok ? r.json() : []).catch(() => []),
    me ? fetch(`${SUPABASE_URL}/rest/v1/game_likes?game_id=eq.${id}&user_id=eq.${me}&select=user_id&limit=1`, {
      headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
    }).then(r => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),
  ]);

  const game = games.get(id);
  const plays = game?.plays ?? 0;

  res.json({
    likes,
    comments,
    plays,
    likedByMe: Array.isArray(mineRaw) && mineRaw.length > 0,
    recentComments: (Array.isArray(commentsRaw) ? commentsRaw : []).map((c: any) => ({
      id: c.id,
      userName: c.user_name ?? 'Anonymous',
      body: c.body ?? '',
      createdAt: c.created_at ?? '',
    })),
  });
});

// POST /api/game/:id/like — toggles like for the calling user (requires JWT).
app.post('/api/game/:id/like', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) { res.status(400).json({ error: 'invalid id' }); return; }
  const { userAccessToken = '', userName = '' } = req.body as { userAccessToken?: string; userName?: string };
  const me = userAccessToken ? userIdFromJwt(userAccessToken) : '';
  if (!me) { res.status(401).json({ error: 'sign-in required' }); return; }

  // Check if liked already to decide insert vs delete.
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/game_likes?game_id=eq.${id}&user_id=eq.${me}&select=user_id&limit=1`,
    { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } },
  ).then(r => r.ok ? r.json() : []).catch(() => []);

  const wasLiked = Array.isArray(existing) && existing.length > 0;

  if (wasLiked) {
    await fetch(`${SUPABASE_URL}/rest/v1/game_likes?game_id=eq.${id}&user_id=eq.${me}`, {
      method: 'DELETE',
      headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/game_likes`, {
      method: 'POST',
      headers: {
        apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ game_id: id, user_id: me, user_name: userName.slice(0, 64) || null }),
    });
  }
  const likes = await sbCount('game_likes', `game_id=eq.${id}`);
  res.json({ liked: !wasLiked, likes });
});

// POST /api/game/:id/comment — append a comment (requires JWT, body 1-500 chars).
app.post('/api/game/:id/comment', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) { res.status(400).json({ error: 'invalid id' }); return; }
  const { userAccessToken = '', userName = '', body = '' } =
    req.body as { userAccessToken?: string; userName?: string; body?: string };
  const me = userAccessToken ? userIdFromJwt(userAccessToken) : '';
  if (!me) { res.status(401).json({ error: 'sign-in required' }); return; }
  if (!String(body).trim()) { res.status(400).json({ error: 'body required' }); return; }
  const muted = moderationStrikes.mutedFor(me);
  if (muted > 0) { res.status(429).json({ error: `You’re temporarily muted for ${Math.ceil(muted / 60_000)} min.` }); return; }
  const commentCheck = moderationCheck(body, 'comment', { id: me, name: userName }, { targetType: 'game', targetId: String(id) });
  if (!commentCheck.ok) {
    moderationStrike(me, commentCheck);
    res.status(422).json({ error: commentCheck.userMessage ?? 'Comment blocked by moderation.' });
    return;
  }
  const trimmed = commentCheck.text.slice(0, 500);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/game_comments`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify({ game_id: id, user_id: me, user_name: userName ? safeDisplayName(userName, me) : null, body: trimmed }),
  });
  if (!r.ok) {
    console.error('[comment] insert failed:', r.status, await r.text());
    res.status(502).json({ error: 'could not save comment' });
    return;
  }
  const rows = await r.json() as any[];
  const c = rows[0] ?? {};
  res.json({
    comment: { id: c.id, userName: c.user_name ?? 'Anonymous', body: c.body ?? trimmed, createdAt: c.created_at },
  });
});

// POST /api/game/:id/play — increment the play counter (no auth needed).
app.post('/api/game/:id/play', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) { res.status(400).json({ error: 'invalid id' }); return; }
  const game = games.get(id);
  if (game) game.plays = (game.plays ?? 0) + 1;
  if (SUPABASE_URL) {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_game_plays`, {
      method: 'POST',
      headers: {
        apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_game_id: id }),
    }).catch(() => { /* best-effort; in-memory bump is the source of truth for the feed */ });
  }
  res.json({ ok: true, plays: game?.plays ?? 0 });
});

// ── Room stats ────────────────────────────────────────────────────────────────

app.get('/api/room-stats', (_req, res) => res.json(roomManager.stats()));

app.get('/api/rooms/:gameId', (req, res) => {
  const rooms = roomManager.getRoomsForGame(req.params.gameId);
  res.json({ rooms: rooms.map(r => ({ id: r.id, players: r.playerCount })) });
});

// ── WebSocket multiplayer ─────────────────────────────────────────────────────

interface Player {
  id: string;
  ws: WebSocket;
  username: string;
  avatarConfig: unknown;
  gameId: string;
  x: number; y: number; z: number; rotY: number;
}

const rooms = new Map<string, Map<string, Player>>();

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64 KB max message

wss.on('connection', (ws, req) => {
  const gameId = new URL(req.url ?? '', 'http://x').searchParams.get('gameId') ?? 'unknown';
  const playerId = randomUUID();
  let player: Player | null = null;

  ws.on('message', raw => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'join') {
      if (!rooms.has(gameId)) rooms.set(gameId, new Map());
      const room = rooms.get(gameId)!;
      player = {
        id: playerId, ws,
        username: safeDisplayName(msg.username ?? 'Player', playerId),
        avatarConfig: msg.avatarConfig ?? {},
        gameId, x: 0, y: 0, z: 0, rotY: 0,
      };
      room.set(playerId, player);

      ws.send(JSON.stringify({
        type: 'joined',
        playerId,
        players: Array.from(room.values())
          .filter(p => p.id !== playerId)
          .map(p => ({ id: p.id, username: p.username, avatarConfig: p.avatarConfig, x: p.x, y: p.y, z: p.z })),
      }));

      broadcast(gameId, playerId, { type: 'player_join', id: playerId, username: player.username, avatarConfig: player.avatarConfig, x: 0, y: 0, z: 0 });

    } else if (msg.type === 'move' && player) {
      player.x = Number(msg.x ?? 0);
      player.y = Number(msg.y ?? 0);
      player.z = Number(msg.z ?? 0);
      player.rotY = Number(msg.rotY ?? 0);
      broadcast(gameId, playerId, { type: 'move', playerId, x: player.x, y: player.y, z: player.z, rotY: player.rotY });

    } else if (msg.type === 'chat' && player) {
      const mod = moderationCheck(String(msg.message ?? '').slice(0, 200), 'chat', { id: playerId, name: player.username });
      if (!mod.ok) { ws.send(JSON.stringify({ type: 'chat_rejected', reason: mod.userMessage })); return; }
      broadcast(gameId, null, { type: 'chat', playerId, username: player.username, message: mod.text });
    }
  });

  ws.on('error', (err) => {
    console.warn(`[wss] ws error for player ${playerId.slice(0,8)}:`, err.message);
  });

  ws.on('close', () => {
    const room = rooms.get(gameId);
    if (!room) return;
    room.delete(playerId);
    if (room.size === 0) rooms.delete(gameId);
    else broadcast(gameId, null, { type: 'player_leave', playerId });
  });
});

function broadcast(gameId: string, excludeId: string | null, msg: unknown) {
  const room = rooms.get(gameId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const [id, p] of room) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  }
}

// ── Server-authoritative game WebSocket (/api/game-ws?gameId=N) ──────────────
// Each connection joins (or creates) a Room for the given gameId.
// Protocol:
//   Client → Server: { type:"join", username, gameId }
//                    { type:"input", forward, back, left, right, jump, action, keys }
//                    { type:"trigger_enter", entityId }
//                    { type:"trigger_exit", entityId }
//                    { type:"collision", entityId, otherName }
//   Server → Client: { type:"snapshot", world:{entities,player,scene,tick} }
//                    { type:"diff", data:{tick,entities,player,scene,events} }
//                    { type:"reload" }
//                    { type:"error", message }

const gameWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64 KB max message

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://x');
  if (url.pathname === '/api/game-ws') {
    gameWss.handleUpgrade(req, socket, head, ws => gameWss.emit('connection', ws, req));
  } else if (url.pathname === '/api/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

gameWss.on('connection', (ws, req) => {
  const url    = new URL(req.url ?? '', 'http://x');
  const gameId = url.searchParams.get('gameId') ?? '';
  // ?published=true asks for the room running the most recently published
  // snapshot of the script. Without it, the room runs the live draft (the
  // editor's preview). Draft and published rooms are kept separate so an
  // edit-time hot-reload can't bleed into a public play session.
  const wantPublished = url.searchParams.get('published') === 'true';
  const clientIp = (req.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
  const connectedAt = Date.now();

  let roomId:   string | null = null;
  let clientId: string | null = null;
  let lastPingAt = Date.now();
  console.log(`[gameWss] CONNECT ip=${clientIp} gameId=${gameId}${wantPublished ? ' (published)' : ''}`);

  ws.on('message', async raw => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    // Keep-alive: client pings every 15s, we pong immediately. The presence of
    // any inbound message also resets lastPingAt so we don't tear down active
    // sessions just because their game logic isn't sending pings.
    lastPingAt = Date.now();
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', t: msg.t ?? Date.now() })); } catch {}
      return;
    }

    if (msg.type === 'join') {
      if (clientId) return; // already joined
      if (!gameId) { ws.send(JSON.stringify({ type: 'error', message: 'gameId required' })); return; }

      // Fetch game script
      let game = games.get(Number(gameId));
      if (!game && SUPABASE_URL) {
        const row = await sbGetById('forge_games', Number(gameId)).catch(() => null);
        if (row) game = dbRowToGame(row);
      }
      if (!game) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game not found or not ready' }));
        return;
      }
      // Resolve the script to run. Published-mode falls back to the draft if
      // no snapshot exists (e.g. a game that was published before the snapshot
      // column landed) so old games keep playing.
      const scriptToRun = wantPublished
        ? (game.publishedGameCode || game.gameCode)
        : game.gameCode;
      if (!scriptToRun) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game not found or not ready' }));
        return;
      }
      // Use distinct room pools for draft vs published so hot-reloads on the
      // draft don't kick public players, and so two snapshots can coexist
      // in-memory at the same time.
      const roomKey = wantPublished ? `${gameId}:pub` : gameId;

      // Public players get the frozen published_editor_state_json; editor-
      // preview rooms get the live draft. The overlay is applied server-side
      // in Room.init() after Lua finishes spawning entities so first-frame
      // already reflects the creator's transform/setting tweaks.
      const editorOverlay = wantPublished
        ? (game.publishedEditorStateJson || game.editorStateJson || '')
        : (game.editorStateJson || '');

      try {
        const room = await roomManager.getOrCreateRoom(roomKey, scriptToRun, editorOverlay);
        roomId   = room.id;
        clientId = room.addClient(ws, safeDisplayName(msg.username ?? 'Player', `${clientIp}:${msg.username ?? ''}`), clientIp);
        ws.send(JSON.stringify({ type: 'joined', clientId, roomId }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: String((e as Error).message) }));
      }
      return;
    }

    // All other messages require an active room session
    if (!roomId || !clientId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not in a room — send join first' }));
      return;
    }

    const room = roomManager.getRoom(roomId);
    if (!room) { roomId = null; clientId = null; return; }
    room.handleMessage(clientId, msg);
  });

  ws.on('error', (err) => {
    // Absorb per-connection errors (e.g. maxPayload exceeded) so they don't crash the process
    const dur = ((Date.now() - connectedAt) / 1000).toFixed(1);
    console.warn(`[gameWss] ERROR ip=${clientIp} client=${clientId?.slice(0,8) ?? 'pre-join'} duration=${dur}s reason=${err.message}`);
    if (roomId && clientId) roomManager.getRoom(roomId)?.removeClient(clientId);
  });

  ws.on('close', (code, reasonBuf) => {
    const dur = ((Date.now() - connectedAt) / 1000).toFixed(1);
    const reason = reasonBuf?.toString() || '<empty>';
    console.log(`[gameWss] CLOSE ip=${clientIp} client=${clientId?.slice(0,8) ?? 'pre-join'} duration=${dur}s code=${code} reason=${reason}`);
    if (roomId && clientId) {
      roomManager.getRoom(roomId)?.removeClient(clientId);
    }
  });

  // Force-disconnect any session that hasn't sent a message in 60 s. Healthy
  // clients ping every 15 s so this is well clear of normal traffic.
  const idleTimer = setInterval(() => {
    if (Date.now() - lastPingAt > 60_000 && ws.readyState === WebSocket.OPEN) {
      console.warn(`[gameWss] IDLE-KILL ip=${clientIp} client=${clientId?.slice(0,8) ?? 'pre-join'} (no msg in 60s)`);
      try { ws.close(1001, 'idle timeout'); } catch {}
    }
  }, 15_000);
  ws.on('close', () => clearInterval(idleTimer));
});

// ── Moderation: check / report / admin queue ─────────────────────────────────

app.use(moderationRouter({
  userIdFromJwt,
  rateLimit,
  async snapshotFor(targetType, targetId) {
    if (targetType === 'game') {
      const g = games.get(Number(targetId));
      return g ? `title: ${g.publishedTitle || g.title}\ndescription: ${g.publishedDescription || g.description}\ncreator: ${g.creatorName}` : null;
    }
    if (targetType === 'avatar_item') {
      const it = avatarItems.get(Number(targetId));
      return it ? `name: ${it.name}\ndescription: ${it.description ?? ''}\nmodel: ${it.modelUrl ?? ''}\nthumb: ${it.thumbnailUrl ?? ''}` : null;
    }
    if (targetType === 'chat') {
      // targetId = "<roomId>:<clientId>:<ts>" as delivered in the chat broadcast
      const [roomId, cId, ts] = targetId.split(':');
      return roomManager.getRoom(roomId)?.findChat(cId, Number(ts)) ?? null;
    }
    if ((targetType === 'comment' || targetType === 'user') && SUPABASE_URL) {
      const url = targetType === 'comment'
        ? `${SUPABASE_URL}/rest/v1/game_comments?id=eq.${encodeURIComponent(targetId)}&select=user_id,user_name,body`
        : `${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(targetId)}&select=id,username,display_name`;
      const r = await fetch(url, { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } });
      if (!r.ok) return null;
      const rows = await r.json() as Array<Record<string, unknown>>;
      return rows[0] ? JSON.stringify(rows[0]) : null;
    }
    return null;
  },
  async unpublishGame(id) {
    let game = games.get(id);
    if (!game && SUPABASE_URL) {
      const row = await sbGetById('forge_games', id).catch(() => null);
      if (row) { game = dbRowToGame(row); games.set(id, game); }
    }
    if (!game) return false;
    game.published = false;
    if (SUPABASE_URL) await sbPatch('forge_games', id, { is_published: false, updated_at: new Date().toISOString() }, SB_SERVICE_KEY).catch(e => console.error('[moderation] unpublish persist failed', e));
    return true;
  },
}));

loadModerationState().catch(err => console.warn('[moderation] state load failed:', err));

// ── Start ─────────────────────────────────────────────────────────────────────

// Load fuzzy asset cache index from Supabase in the background on startup.
// Errors are swallowed inside loadIndex() — never block server start.
loadAssetCacheIndex().catch(err => console.warn('[asset-cache] startup load failed:', err));

// Warm the in-memory `games` map with all published games so /api/games returns
// the full feed without lazy-loading each row on first hit.
async function loadPublishedGames(): Promise<void> {
  if (!SUPABASE_URL) return;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_games?is_published=eq.true&select=*&order=created_at.desc&limit=200`,
      { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } },
    );
    if (!r.ok) { console.warn(`[games] startup load failed (${r.status})`); return; }
    const rows = await r.json() as Record<string, unknown>[];
    let n = 0;
    for (const row of rows) { dbRowToGame(row); n++; }
    console.log(`[games] loaded ${n} published game(s) from Supabase`);
  } catch (err) {
    console.warn('[games] startup load error:', err);
  }
}
loadPublishedGames().catch(() => { /* logged inside */ });

// Pre-warm terrain assets for the 5 most common genres so the first user of each
// genre doesn't pay the Meshy generation cost for terrain. Fires after cache loads.
const TERRAIN_WARMUP: { genre: string; prompt: string }[] = [
  { genre: 'platformer', prompt: 'grassy rolling hills game terrain tile, vibrant green grass with dirt patches, seamless, chibi style, cartoon proportions' },
  { genre: 'adventure',  prompt: 'lush forest floor terrain tile, mossy ground with tree roots, green and brown, seamless, chibi style, cartoon proportions' },
  { genre: 'survival',   prompt: 'dirt arena ground terrain tile, worn earth with rock patches, brown tones, seamless, chibi style, cartoon proportions' },
  { genre: 'puzzle',     prompt: 'stone dungeon floor terrain tile, dark grey stone with cracks and moss, seamless, chibi style, cartoon proportions' },
  { genre: 'simulation', prompt: 'city pavement terrain tile, grey concrete with road markings and sidewalk, seamless, chibi style, cartoon proportions' },
];

async function warmupTerrainAssets(): Promise<void> {
  // Terrain is now built from Structure.CreateGround at runtime — no Meshy
  // GLB to pre-generate. TERRAIN_WARMUP is retained above for reference /
  // potential future tier-2 procedural-cache use, but this hook is now a no-op.
  console.log('[terrain-warmup] tier-2 procedural — no Meshy pre-warm required');
  console.log('[terrain-warmup] complete');
}

// Fire warmup 10 s after startup so it doesn't compete with initial requests.
setTimeout(() => warmupTerrainAssets().catch(err => console.warn('[terrain-warmup] error:', err)), 10_000);

httpServer.listen(PORT, () => {
  console.log(`Pludo API server → http://localhost:${PORT}`);
  console.log(`  Claude:  ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ ANTHROPIC_API_KEY missing'}`);
  console.log(`  Meshy:   ${process.env.MESHY_API_KEY    ? '✓ configured' : '✗ MESHY_API_KEY missing'}${meshyDevMode() ? ' (DEV MODE — no credits spent)' : meshySkipRefine() ? ' (SKIP_REFINE — 5 credits/asset)' : ' (preview+refine — 15 credits/asset)'}`);
  console.log(`  R2:      ${r2Configured()               ? '✓ configured' : '✗ R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY missing (assets use Meshy CDN URLs)'}`);
  console.log(`  POST /api/forge-game`);
  console.log(`  POST /api/edit-game`);
  console.log(`  GET  /api/game/:id/html`);
  console.log(`  POST /api/meshy/generate`);
  console.log(`  GET  /api/meshy/status/:jobId`);
  console.log(`  WS   /api/ws?gameId=N           (legacy position sync)`);
  console.log(`  WS   /api/game-ws?gameId=N      (server-authoritative game rooms)`);
  console.log(`  GET  /api/room-stats`);
});
