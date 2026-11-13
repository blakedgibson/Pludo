// Fuzzy asset cache — normalises prompt text and uses Jaccard similarity to
// find existing R2 models for prompts that differ only in wording.
//
// Pipeline in resolveAsset():
//   1. Dev mode → skip  (handled by caller)
//   2. In-memory buffer hit  (handled by caller)
//   3. findFuzzy() → exact normalised match or Jaccard ≥ JACCARD_THRESHOLD
//   4. R2 exact SHA-256 key check  (handled by caller)
//   5. Meshy generation → register()
//
// Threshold calibration (run against real pairs — see asset-cache calibration results):
//   0.65 chosen to catch near-rephrasings (e.g. "stone platform tile" vs "stone platform"
//   scores 0.667) without causing colour-confusion matches ("red car" vs "blue car" = 0.600).
//   The pairs share modifiers but differ on main noun ("platform" vs "ledge" = 0.500) — those
//   are intentionally not matched.

export interface CacheEntry {
  promptRaw: string;
  promptNormalized: string;
  cacheKey: string;
  isHumanoid: boolean;
  // User-editable label shown in the Assets modal and used for search.
  // Falls back to promptRaw when null.
  title?: string | null;
  // Public URL of a pre-rendered PNG preview of the GLB. Populated by the
  // backfill script in scripts/backfill-thumbnails.ts.
  thumbnailUrl?: string | null;
}

export interface FuzzyMatch {
  cacheKey: string;
  score: number;       // 1.0 for exact normalised hit
  matchedPrompt: string;
}

const JACCARD_THRESHOLD = 0.55;

// ── Stop-word list ────────────────────────────────────────────────────────────
// Common English words that carry no semantic weight for 3D asset matching.
// Includes Claude's common 3D-prompt filler words ("highly", "detailed", etc.)
// that appear in nearly every asset description and inflate Jaccard scores.
const STOP_WORDS = new Set([
  // Articles / conjunctions / prepositions
  'a','an','the','and','or','of','in','on','at','to','for','with','is','are',
  'was','were','be','been','being','it','its','this','that','these','those',
  'by','as','from','into','up','out','about','over','after','before','between',
  'through','during','some','but','not','no','so','if','then','than',
  'there','here','just','also','like','very',
  // Size/quantity words with low discriminative value for assets
  'large','small','big','tiny','great','one','two','three',
  // Auxiliary verbs
  'made','has','have','had','do','does','did','can','could','will',
  'would','should','may','might','shall','must',
  // Claude's common 3D-prompt filler words — appear in almost every asset
  // prompt so they inflate Jaccard similarity between unrelated assets
  'highly','detailed','realistic','featuring','style','styled',
  // "looking" as in "creature-looking" is structural, not descriptive
  'looking',
  // Terrain prompt filler — every terrain prompt contains these; strip so
  // "grassy terrain seamless cartoon asset" matches "grassy rolling hills terrain"
  'seamless','tile','tones','mobile','cartoon','patches','details','asset','game',
]);

// ── Normalise ─────────────────────────────────────────────────────────────────
// Lowercase → strip punctuation → remove stop words → sort tokens alphabetically.
// KNOWN LIMITATION: sorting destroys word order, so "zombie eating plant" and
// "plant eating zombie" normalise identically. For asset prompts this is
// acceptable because the same physical object is described regardless of order.
export function normalizePrompt(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOP_WORDS.has(t))
    .sort()
    .join(' ');
}

// ── Jaccard similarity on word sets ──────────────────────────────────────────
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── In-memory index ───────────────────────────────────────────────────────────
// Loaded from Supabase on startup; updated on every successful Meshy generation.
const _index: CacheEntry[] = [];
let _loaded = false;

// ── Supabase helpers (used only by this module) ───────────────────────────────
// asset_cache and asset_cache_hits don't grant SELECT/INSERT to anon, so we
// require the service-role key. (Other tables like forge_games still use anon
// with RLS on the user side.) Falls back to anon only so a misconfigured dev
// box logs a clear 401 rather than silently noop'ing.

const SUPABASE_URL = () => process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

async function fetchAllEntries(): Promise<CacheEntry[]> {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  if (!url || !key) return [];
  try {
    const r = await fetch(
      `${url}/rest/v1/asset_cache?select=prompt_raw,prompt_normalized,cache_key,is_humanoid,title,thumbnail_url&limit=10000`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } },
    );
    if (!r.ok) {
      console.warn(`[asset-cache] Supabase fetch failed (${r.status})`);
      return [];
    }
    const rows = await r.json() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      promptRaw:        String(row['prompt_raw']        ?? ''),
      promptNormalized: String(row['prompt_normalized'] ?? ''),
      cacheKey:         String(row['cache_key']         ?? ''),
      isHumanoid:       Boolean(row['is_humanoid']),
      title:            row['title']         == null ? null : String(row['title']),
      thumbnailUrl:     row['thumbnail_url'] == null ? null : String(row['thumbnail_url']),
    }));
  } catch (err) {
    console.warn('[asset-cache] Supabase fetch error:', err);
    return [];
  }
}

async function insertEntry(entry: CacheEntry): Promise<void> {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  if (!url || !key) return;
  try {
    const r = await fetch(`${url}/rest/v1/asset_cache`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        prompt_raw:        entry.promptRaw,
        prompt_normalized: entry.promptNormalized,
        cache_key:         entry.cacheKey,
        is_humanoid:       entry.isHumanoid,
        ...(entry.title        ? { title: entry.title } : {}),
        ...(entry.thumbnailUrl ? { thumbnail_url: entry.thumbnailUrl } : {}),
      }),
    });
    if (!r.ok) console.warn(`[asset-cache] Supabase insert failed (${r.status})`);
  } catch (err) {
    console.warn('[asset-cache] Supabase insert error:', err);
  }
}

async function insertHit(
  queryPrompt: string,
  matchedPrompt: string,
  score: number,
  cacheKey: string,
  isHumanoid: boolean,
): Promise<void> {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/asset_cache_hits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        query_prompt:   queryPrompt,
        matched_prompt: matchedPrompt,
        similarity:     score,
        cache_key:      cacheKey,
        is_humanoid:    isHumanoid,
      }),
    });
  } catch {
    // Hit logging is best-effort — never block asset serving
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadIndex(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  const entries = await fetchAllEntries();
  _index.push(...entries);
  console.log(`[asset-cache] loaded ${entries.length} entries from Supabase`);
}

// Returns a snapshot of the in-memory cache index. Used by the forge prompt to
// inject the list of reusable existing assets into Claude's system prompt so
// Claude can REUSE existing prompts verbatim (full credit savings) rather than
// rephrasing them just below the Jaccard threshold and triggering a fresh
// Meshy generation.
export function getAllEntries(): readonly CacheEntry[] {
  return _index;
}

// Lookup: exact normalised match first (score=1.0), then best Jaccard ≥ threshold.
// Returns null if no match meets the threshold.
export function findFuzzy(promptRaw: string, isHumanoid: boolean): FuzzyMatch | null {
  const normalized = normalizePrompt(promptRaw);
  const candidates = _index.filter(e => e.isHumanoid === isHumanoid);

  // Exact normalised hit (fastest)
  for (const e of candidates) {
    if (e.promptNormalized === normalized) {
      console.log(`[asset-cache] exact hit for "${promptRaw.slice(0, 60)}" → ${e.cacheKey}`);
      return { cacheKey: e.cacheKey, score: 1.0, matchedPrompt: e.promptRaw };
    }
  }

  // Jaccard fuzzy match — find best-scoring candidate above threshold
  let bestScore = 0;
  let bestEntry: CacheEntry | null = null;
  for (const e of candidates) {
    const score = jaccardSimilarity(normalized, e.promptNormalized);
    if (score > bestScore) { bestScore = score; bestEntry = e; }
  }

  if (bestEntry && bestScore >= JACCARD_THRESHOLD) {
    console.log(`[asset-cache] fuzzy hit (${(bestScore * 100).toFixed(0)}%) for "${promptRaw.slice(0, 60)}" → ${bestEntry.cacheKey}`);
    return { cacheKey: bestEntry.cacheKey, score: bestScore, matchedPrompt: bestEntry.promptRaw };
  }

  return null;
}

// Log a successful fuzzy cache hit to Supabase for threshold tuning.
// Fire-and-forget — never awaited by the caller.
export function logHit(
  queryPrompt: string,
  match: FuzzyMatch,
  isHumanoid: boolean,
): void {
  insertHit(queryPrompt, match.matchedPrompt, match.score, match.cacheKey, isHumanoid)
    .catch(err => console.warn('[asset-cache] hit log failed:', err));
}

// Register a new entry in the in-memory index and persist to Supabase.
// Called after a Meshy generation succeeds and the GLB is uploaded to R2.
export async function register(
  promptRaw: string, isHumanoid: boolean, cacheKey: string,
  meta?: { title?: string; thumbnailUrl?: string | null },
): Promise<void> {
  const normalized = normalizePrompt(promptRaw);
  // Skip duplicate registrations to keep index clean
  const already = _index.some(e => e.cacheKey === cacheKey && e.isHumanoid === isHumanoid);
  if (already) return;
  const entry: CacheEntry = {
    promptRaw, promptNormalized: normalized, cacheKey, isHumanoid,
    title: meta?.title ?? null, thumbnailUrl: meta?.thumbnailUrl ?? null,
  };
  _index.push(entry);
  await insertEntry(entry);
  console.log(`[asset-cache] registered "${promptRaw.slice(0, 60)}" → ${cacheKey}`);
}
