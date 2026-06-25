// Shared asset-catalog provider.
//
// The "catalog" is the set of 3D models that already exist in the shared
// library — the R2 bucket `game-assets/v1/` joined with the `asset_cache`
// metadata index. This is exactly what the "Add Assets modal" (GET /api/assets)
// shows.
//
// The forge no longer generates new 3D models; it SELECTS from this catalog.
// `getCatalog()` enumerates the catalog (reused by /api/assets), and
// `buildCatalogSection()` produces a compact, prompt-relevance-ranked list that
// is injected into the Claude system prompt so Claude can reference assets by
// their stable `key` (the cacheKey) instead of describing new ones.

import { listObjects, publicUrl, r2Configured } from './r2.js';
import {
  loadIndex as loadAssetCacheIndex,
  getAllEntries as getAllCacheEntries,
  register as registerAssetCache,
} from './asset-cache.js';

export interface CatalogItem {
  key: string;          // cacheKey — the STABLE selector Claude copies into asset_manifest
  label: string;        // human description Claude matches against (title ?? promptRaw ?? stub)
  isHumanoid: boolean;
  sizeHint: number;     // real-world longest dimension in meters (height for humanoids)
  // Extra fields the /api/assets view needs, carried through so it doesn't
  // have to re-join the cache index.
  title: string | null;
  thumbnailUrl: string | null;
}

// Infer a real-world size in meters from an asset's text description.
// Humanoids normalise by HEIGHT; props by longest dimension.
export function inferSizeHint(label: string, isHumanoid: boolean): number {
  if (isHumanoid) return 1.8;
  const l = label.toLowerCase();
  if (/\b(car|automobile|truck|van|bus|jeep|tank)\b/.test(l))           return 4.5;
  if (/\b(ship|boat|yacht|pirate ship|vessel)\b/.test(l))               return 8.0;
  if (/\b(airplane|jet|aircraft|plane|helicopter)\b/.test(l))           return 6.0;
  if (/\b(spaceship|rocket|ufo|spacecraft)\b/.test(l))                   return 5.0;
  if (/\b(building|house|castle|tower|skyscraper|mansion|temple|church|cottage|barn)\b/.test(l)) return 8.0;
  if (/\b(tree|pine|oak|palm|fir|spruce|cedar|birch)\b/.test(l))        return 5.0;
  if (/\b(dragon|dinosaur|t.rex|kraken|leviathan)\b/.test(l))           return 3.5;
  if (/\b(bear|elephant|rhino|rhinoceros|hippo|gorilla)\b/.test(l))     return 2.5;
  if (/\b(horse|lion|tiger|wolf|cow|deer|moose)\b/.test(l))             return 2.0;
  if (/\b(bridge|walkway)\b/.test(l))                                    return 8.0;
  if (/\b(door|gate|arch|portal)\b/.test(l))                             return 2.5;
  if (/\b(lamp|torch|lantern|streetlight|candlestick|brazier)\b/.test(l)) return 2.0;
  if (/\b(bench|chair|table|desk|throne)\b/.test(l))                    return 1.2;
  if (/\b(rock|stone|boulder)\b/.test(l))                               return 1.5;
  if (/\b(signpost|sign|post|pillar|column|statue)\b/.test(l))          return 2.5;
  if (/\b(chest|barrel|crate|box|pot|vase|urn|bucket)\b/.test(l))       return 0.9;
  if (/\b(sword|blade|spear|axe|staff|lance|trident)\b/.test(l))        return 1.0;
  if (/\b(gun|rifle|pistol|cannon|weapon)\b/.test(l))                   return 0.8;
  if (/\b(mushroom|flower|bush|shrub|plant|fern)\b/.test(l))            return 0.6;
  if (/\b(cat|dog|rabbit|bird|fox|turtle|chicken)\b/.test(l))           return 0.6;
  if (/\b(coin|gem|crystal|orb|star|ring|token|pickup|collectible)\b/.test(l)) return 0.4;
  if (/\b(bomb|grenade|potion|bottle|flask)\b/.test(l))                 return 0.4;
  return 1.5;
}

// Enumerate the full asset catalog. Mirrors the logic that used to live inline
// in GET /api/assets: list R2 GLBs, join with the cache index for metadata, and
// backfill stub entries for un-indexed objects. Falls back to the in-memory
// cache index when R2 is not configured.
export async function getCatalog(): Promise<CatalogItem[]> {
  await loadAssetCacheIndex();
  const indexByKey = new Map(getAllCacheEntries().map(e => [e.cacheKey, e]));

  let items: CatalogItem[] = [];

  if (r2Configured()) {
    try {
      const objects = await listObjects('game-assets/v1/');
      const glbs    = objects.filter(o => o.key.toLowerCase().endsWith('.glb'));
      for (const o of glbs) {
        const entry = indexByKey.get(o.key);
        if (entry) {
          const label = entry.title ?? entry.promptRaw;
          items.push({
            key:          entry.cacheKey,
            label,
            isHumanoid:   entry.isHumanoid,
            sizeHint:     inferSizeHint(label, entry.isHumanoid),
            title:        entry.title        ?? null,
            thumbnailUrl: entry.thumbnailUrl ?? null,
          });
        } else {
          // Un-indexed R2 object — use the hash as a stub label and backfill
          // the cache index so subsequent lookups have something to match.
          const hash = o.key.replace(/^game-assets\/v1\//, '').replace(/\.glb$/i, '');
          const stubPrompt = `asset ${hash.slice(0, 8)}`;
          items.push({
            key:          o.key,
            label:        stubPrompt,
            isHumanoid:   false,
            sizeHint:     1.5,
            title:        null,
            thumbnailUrl: null,
          });
          // Fire-and-forget — register() is idempotent.
          registerAssetCache(stubPrompt, false, o.key)
            .catch(err => console.warn('[catalog] backfill register failed:', err));
        }
      }
    } catch (err) {
      console.warn('[catalog] R2 list failed, falling back to cache index:', err);
    }
  }

  // Fallback path: no R2 access. Use the in-memory cache index.
  if (items.length === 0) {
    items = getAllCacheEntries().map(e => ({
      key:          e.cacheKey,
      sizeHint:     inferSizeHint(e.title ?? e.promptRaw, e.isHumanoid),
      label:        e.title ?? e.promptRaw,
      isHumanoid:   e.isHumanoid,
      title:        e.title        ?? null,
      thumbnailUrl: e.thumbnailUrl ?? null,
    }));
  }

  return items;
}

// Build the "AVAILABLE CATALOG ASSETS" section appended to the forge/edit system
// prompt. Ranks the catalog by token overlap with the user's prompt so the
// section stays compact (~40 entries) rather than ballooning past Claude's
// effective attention span. Each line gives Claude the exact key to copy and a
// short label; humanoid assets are flagged with a trailing `|H`.
//
// Returns '' when the catalog is empty (server first-boot / no assets yet) so
// the system prompt's empty-manifest path takes over.
export async function buildCatalogSection(userPrompt: string): Promise<string> {
  const catalog = await getCatalog();
  if (catalog.length === 0) return '';

  // Rank by overlap with user-prompt tokens. Items unrelated to the request
  // just consume Claude's attention.
  const userTokens = new Set(
    userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2),
  );
  const scored = catalog.map(item => {
    const itemTokens = new Set(item.label.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/));
    let overlap = 0;
    for (const t of userTokens) if (itemTokens.has(t)) overlap++;
    return { item, overlap };
  });

  // Top 30 by overlap, then 10 more (deterministic — no Math.random in scripts)
  // so common props ("tree", "rock") can still surface when not referenced.
  scored.sort((a, b) => b.overlap - a.overlap);
  const chosen = scored.slice(0, 40).map(s => s.item);

  const lines = chosen.map(item => {
    const label = item.label.slice(0, 120).replace(/[\r\n|]/g, ' ').trim();
    return `  ${item.key}|${label}|${item.sizeHint}m${item.isHumanoid ? '|H' : ''}`;
  });

  return `

═══════════════════════════════════════════════════════
AVAILABLE CATALOG ASSETS — THE ONLY 3D MODELS YOU MAY USE
═══════════════════════════════════════════════════════

These are the ONLY 3D models available. You may NOT invent or generate new ones.
Each asset_manifest entry MUST set its "asset" field to one of the keys below,
copied EXACTLY (the full "game-assets/v1/<hash>.glb" string). A trailing "|H"
marks a humanoid (rigged) asset — use those for characters/NPCs. The size column
is the real-world target — copy it verbatim as the "size_hint" in your manifest entry.

If no listed asset fits a gameplay need, OMIT that prop and build the mechanic
from Structure.* geometry and Effects.* instead. NEVER invent a key.

Format per line:  <key>|<description>|<size>m[|H]

CATALOG (${chosen.length} of ${catalog.length} shown, ranked by relevance):
${lines.join('\n')}
`;
}
