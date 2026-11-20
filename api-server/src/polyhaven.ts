// Polyhaven CC0 PBR texture pipeline.
//
// Claude emits `materialType` strings like "grass", "rock", "snow" — this
// module maps each to a Polyhaven asset slug, downloads the 1K albedo /
// normal / roughness JPGs the first time it sees the type, and caches them
// in R2 forever (same SHA-256 cache pattern as the GLB pipeline). All
// subsequent games that reference the same materialType hit R2 in ~30 ms.
//
// We don't need a Polyhaven API key — the public API at api.polyhaven.com
// is rate-limited but free. We keep concurrency bounded with a per-slug
// in-flight Promise map so two simultaneously-forging games requesting the
// same slug only fetch once.

import { createHash } from 'crypto';
import { keyExists, uploadBuffer, publicUrl, r2Configured } from './r2.js';

// ── Slug map ─────────────────────────────────────────────────────────────────
// Polyhaven asset slugs (verify in the Polyhaven catalog before changing —
// the API will 404 if a slug doesn't exist). The chosen slugs lean toward
// seamless, top-down photographs of natural surfaces suitable for triplanar
// projection. When adding new materialTypes, follow the same pattern.
// All slugs verified against `GET https://api.polyhaven.com/info/<slug>` in
// May 2026. When swapping in new slugs, hit that URL first — Polyhaven returns
// 404 for non-existent slugs and our resolver silently falls back to flat
// color, which is hard to spot. Polyhaven does NOT have textures for "ice",
// "lava", or "ash" specifically, so those map to the closest visual analogue.
const SLUG_MAP: Record<string, string> = {
  grass:  'aerial_grass_rock',
  dirt:   'brown_mud_leaves_01',
  rock:   'rock_ground_02',
  sand:   'aerial_beach_03',
  snow:   'snow_02',
  stone:  'cobblestone_floor_02',
  wood:   'wood_floor_deck',
  metal:  'metal_plate',
  lava:   'aerial_rocks_02',       // no lava texture on Polyhaven — dark volcanic rock is closest
  moss:   'forest_ground_04',      // forest_ground_01 doesn't exist; _04 is the available cousin
  ice:    'snow_02',               // no ice texture on Polyhaven — fresh snow is the closest cool/white surface
  ash:    'brown_mud_03',          // no ash texture — dark mud reads as ashy on a cool palette
};

export type TextureMapType = 'albedo' | 'normal' | 'roughness';

// Map our internal map type to Polyhaven's URL param names. Polyhaven's
// `/files/<slug>` endpoint returns a structure like:
//   { "Diffuse": { "1k": { "jpg": { "url": "https://..." } } }, ... }
// Different texture sets use slightly different map keys — we try several
// candidate keys per type and pick the first one present.
const POLYHAVEN_KEY_CANDIDATES: Record<TextureMapType, string[]> = {
  albedo:    ['Diffuse', 'diff', 'Albedo', 'albedo'],
  normal:    ['nor_gl', 'nor_dx', 'Normal', 'normal'],
  // Polyhaven packs roughness with AO in `rough_ao` (R=rough, G=AO, B=unused).
  // Our shader reads only the R channel so the AO bleed is harmless; storing
  // the joint map keeps us aligned with the manifest layout. Fallback names
  // cover older sets that ship a standalone Rough/Roughness branch.
  roughness: ['rough_ao', 'Rough', 'rough', 'Roughness'],
};

export interface ResolvedMaterial {
  materialType: string;
  slug: string;
  albedoUrl: string;
  normalUrl: string;
  roughnessUrl: string;
}

// ── Cache key ────────────────────────────────────────────────────────────────
// Deterministic, content-addressable. Same slug + map type always produces the
// same R2 key, so concurrent generations dedup naturally at the storage layer
// in addition to the in-flight Promise map below.
export function textureCacheKey(slug: string, map: TextureMapType): string {
  const hash = createHash('sha256')
    .update(`${slug}|${map}|1k`)
    .digest('hex')
    .slice(0, 16);
  return `textures/polyhaven/v1/${hash}.jpg`;
}

// ── In-flight dedup ──────────────────────────────────────────────────────────
// Two games forging concurrently that both want `materialType:grass` should
// trigger exactly one Polyhaven fetch. The first call writes a Promise into
// this map; the second call awaits the same Promise.
const inflight = new Map<string, Promise<ResolvedMaterial | null>>();

// Skip mode for local dev where you don't want to hammer Polyhaven on every
// server restart. Mirrors MESHY_DEV_MODE — setting POLYHAVEN_SKIP=1 makes
// every resolveMaterial return null (Unity falls back to flat-color material).
function polyhavenSkip(): boolean {
  return process.env.POLYHAVEN_SKIP === '1' || process.env.POLYHAVEN_SKIP === 'true';
}

// ── Public entry point ───────────────────────────────────────────────────────
export async function resolveMaterial(materialType: string): Promise<ResolvedMaterial | null> {
  const mt = (materialType || '').trim().toLowerCase();
  const slug = SLUG_MAP[mt];
  if (!slug) {
    console.warn(`[polyhaven] unknown materialType '${materialType}' — no slug mapping`);
    return null;
  }
  if (polyhavenSkip()) return null;

  const existing = inflight.get(slug);
  if (existing) return existing;

  const promise = doResolve(mt, slug).catch(err => {
    console.warn(`[polyhaven] resolve failed for slug='${slug}':`, err?.message ?? err);
    return null;
  });
  inflight.set(slug, promise);
  // Always evict once resolved. Concurrent callers during the in-flight
  // window get the same Promise (dedup'd fetch). Once it settles — success
  // OR failure — drop the cached entry so future requests can retry. On
  // success the R2 keyExists check short-circuits within ~30ms; on failure
  // a retry is what we want (the previous bug here was caching null forever).
  promise.finally(() => inflight.delete(slug));
  return promise;
}

async function doResolve(materialType: string, slug: string): Promise<ResolvedMaterial | null> {
  const t0 = Date.now();

  // Check R2 for all three maps. If all present, no fetch needed.
  const albedoKey    = textureCacheKey(slug, 'albedo');
  const normalKey    = textureCacheKey(slug, 'normal');
  const roughnessKey = textureCacheKey(slug, 'roughness');

  let allCached = false;
  if (r2Configured()) {
    const [a, n, r] = await Promise.all([
      keyExists(albedoKey),
      keyExists(normalKey),
      keyExists(roughnessKey),
    ]);
    allCached = a && n && r;
  }

  if (allCached) {
    console.log(`[polyhaven] resolved '${materialType}' → slug=${slug} (cache-hit in ${Date.now() - t0}ms)`);
    return {
      materialType, slug,
      albedoUrl:    serveUrl(albedoKey),
      normalUrl:    serveUrl(normalKey),
      roughnessUrl: serveUrl(roughnessKey),
    };
  }

  // Fetch the file manifest from Polyhaven. Result is a nested object keyed
  // by map type → resolution → format.
  const fileManifest = await fetchWithRetry(`https://api.polyhaven.com/files/${slug}`);
  const json = JSON.parse(fileManifest.toString('utf-8')) as Record<string, unknown>;

  const albedoUrl    = await fetchAndStore(json, 'albedo',    albedoKey);
  const normalUrl    = await fetchAndStore(json, 'normal',    normalKey);
  const roughnessUrl = await fetchAndStore(json, 'roughness', roughnessKey);

  if (!albedoUrl || !normalUrl || !roughnessUrl) {
    console.warn(`[polyhaven] slug='${slug}' missing maps — albedo=${!!albedoUrl} normal=${!!normalUrl} roughness=${!!roughnessUrl}`);
    return null;
  }

  console.log(`[polyhaven] resolved '${materialType}' → slug=${slug} (cache-miss, fetched + cached in ${Date.now() - t0}ms)`);
  return { materialType, slug, albedoUrl, normalUrl, roughnessUrl };
}

// Walk the Polyhaven file manifest looking for the 1K JPG URL of the given
// map type, download it, upload to R2 under `cacheKey`, return the public URL
// that Unity can fetch.
async function fetchAndStore(
  manifest: Record<string, unknown>,
  map: TextureMapType,
  cacheKey: string,
): Promise<string | null> {
  // Already cached? (Race with allCached check above — possible if only some
  // maps were cached previously.)
  if (r2Configured() && await keyExists(cacheKey)) return serveUrl(cacheKey);

  const url = extractMapUrl(manifest, map);
  if (!url) return null;

  const jpg = await fetchWithRetry(url);
  if (r2Configured()) {
    await uploadBuffer(cacheKey, jpg, 'image/jpeg');
  }
  return serveUrl(cacheKey);
}

// Polyhaven manifest layout: top-level keys vary by texture set ("Diffuse" vs
// "diff", "nor_gl" vs "Normal", etc.). Try our candidate list, then drill into
// → 1k → jpg.url. Returns null if no candidate has a 1k JPG.
function extractMapUrl(manifest: Record<string, unknown>, map: TextureMapType): string | null {
  for (const key of POLYHAVEN_KEY_CANDIDATES[map]) {
    const branch = manifest[key];
    if (!branch || typeof branch !== 'object') continue;
    const sizeBranch = (branch as Record<string, unknown>)['1k'];
    if (!sizeBranch || typeof sizeBranch !== 'object') continue;
    const fmtBranch = (sizeBranch as Record<string, unknown>)['jpg'];
    if (!fmtBranch || typeof fmtBranch !== 'object') continue;
    const url = (fmtBranch as Record<string, unknown>)['url'];
    if (typeof url === 'string') return url;
  }
  return null;
}

// Same retry pattern as meshy.ts — exponential backoff on 429/5xx, give up
// after 3 attempts. Polyhaven is well-behaved so we rarely retry, but a
// transient CloudFront blip shouldn't fail a forge. AbortSignal caps each
// attempt at 15 s so a stalled connection doesn't sit hot for minutes.
async function fetchWithRetry(url: string, attempt = 1): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let r: Response;
  try {
    r = await fetch(url, { headers: { 'User-Agent': 'Pludo-api-server/1.0' }, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (attempt >= 3) throw err;
    const delay = 1000 * Math.pow(2, attempt);
    await new Promise(res => setTimeout(res, delay));
    return fetchWithRetry(url, attempt + 1);
  }
  clearTimeout(timer);
  if (r.status >= 500 || r.status === 429) {
    if (attempt >= 3) throw new Error(`Polyhaven ${url} returned ${r.status} after ${attempt} attempts`);
    const delay = 1000 * Math.pow(2, attempt);
    await new Promise(res => setTimeout(res, delay));
    return fetchWithRetry(url, attempt + 1);
  }
  if (!r.ok) throw new Error(`Polyhaven ${url} returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Always proxy through /api/glb/* — Unity already resolves relative paths
// against the api-server base URL. Returning publicUrl(key) directly would
// bypass our Cache-Control and force Unity to hit the R2 CDN, which is fine
// but inconsistent with the GLB pipeline. Keep one code path.
function serveUrl(key: string): string {
  // Mirror the resolveAsset pattern at index.ts:440 — '/api/glb/' prefix.
  return `/api/glb/${key}`;
}

// Bypass — returns the public CDN URL when configured. Reserved for future
// use if we want to skip the api-server proxy for textures. Not used today
// but kept symmetric with publicUrl for any direct-CDN debugging.
export function publicTextureUrl(slug: string, map: TextureMapType): string | null {
  return publicUrl(textureCacheKey(slug, map));
}

// Helper for the prompt-generation path — list the allowed materialType
// vocabulary so the prompt can interpolate it without duplicating the map.
export function allowedMaterialTypes(): readonly string[] {
  return Object.keys(SLUG_MAP);
}
