// One-shot backfill: render a PNG thumbnail for every .glb in the R2 bucket
// that doesn't already have one, upload it next to the GLB, and write the
// public URL onto the matching asset_cache row.
//
// Usage:
//   cd api-server
//   npm install      (first time — pulls puppeteer + three)
//   npm run thumbs:backfill
//
// Flags:
//   --force         Re-render even when game-assets/v1/thumbnails/<hash>.png exists.
//   --only=<hash>   Only render the asset whose cache key starts with this hash.
//   --limit=<n>     Stop after N successful renders (useful for smoke-testing).

import 'dotenv/config';
import fs                           from 'node:fs';
import path                         from 'node:path';
import { fileURLToPath }            from 'node:url';
import puppeteer, { Browser, Page } from 'puppeteer';

import { listObjects, publicUrl, r2Configured, uploadBuffer, keyExists } from '../src/r2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const ONLY  = (process.argv.find(a => a.startsWith('--only='))  ?? '').split('=')[1] ?? '';
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) ?? '').split('=')[1] ?? 0) || Infinity;

// ── Supabase helpers ──────────────────────────────────────────────────────────
const SB_URL = process.env.SUPABASE_URL ?? '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

async function updateAssetCacheThumbnail(cacheKey: string, thumbnailUrl: string): Promise<void> {
  if (!SB_URL || !SB_KEY) {
    console.warn('[backfill] No Supabase creds — thumbnail uploaded to R2 but not recorded in asset_cache.');
    return;
  }
  const url = `${SB_URL}/rest/v1/asset_cache?cache_key=eq.${encodeURIComponent(cacheKey)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ thumbnail_url: thumbnailUrl }),
  });
  if (!r.ok) {
    console.warn(`[backfill] asset_cache PATCH failed for ${cacheKey}: ${r.status} ${await r.text()}`);
  }
}

// ── Puppeteer renderer ────────────────────────────────────────────────────────
async function spawnPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 });
  const fileUrl = `file://${path.join(__dirname, 'render-template.html')}`;
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });
  // Wait for three.js + the renderer module to finish booting.
  await page.waitForFunction('window.rendererReady === true', { timeout: 30_000 });
  return page;
}

async function renderOne(page: Page, modelUrl: string): Promise<Buffer> {
  // Fetch the GLB Node-side (no CORS) and hand the bytes to the page.
  // The R2 public CDN doesn't include Access-Control-Allow-Origin, so an
  // in-browser fetch from a file:// page is blocked.
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching GLB`);
  const buf = Buffer.from(await res.arrayBuffer());
  const glbB64 = buf.toString('base64');

  const dataUrl = await page.evaluate(async (b64: string) => {
    return await (window as any).renderGlbBytes(b64) as string;
  }, glbB64);
  if (!dataUrl || dataUrl.startsWith('ERROR:')) {
    throw new Error(dataUrl || 'no data url returned');
  }
  const pngB64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(pngB64, 'base64');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function thumbnailKey(glbKey: string): string {
  const hash = glbKey.replace(/^game-assets\/v1\//, '').replace(/\.glb$/i, '');
  return `game-assets/v1/thumbnails/${hash}.png`;
}

async function main() {
  if (!r2Configured()) {
    console.error('R2 is not configured — set R2_ACCOUNT_ID and R2_DEV_ACCESS_KEY_ID/R2_DEV_SECRET_ACCESS_KEY in api-server/.env.');
    process.exit(1);
  }
  if (!process.env.R2_DEV_PUBLIC_URL && process.env.NODE_ENV !== 'production') {
    console.error('R2_DEV_PUBLIC_URL is empty — thumbnails would be uploaded but their public URLs would be null. Set it and re-run.');
    process.exit(1);
  }

  console.log('[backfill] Listing GLBs in R2…');
  const objects = await listObjects('game-assets/v1/');
  const glbs    = objects.filter(o => o.key.toLowerCase().endsWith('.glb'));
  console.log(`[backfill] Found ${glbs.length} .glb file(s).`);

  if (ONLY) {
    const before = glbs.length;
    const filt   = glbs.filter(o => o.key.includes(ONLY));
    console.log(`[backfill] --only=${ONLY} narrowed ${before} → ${filt.length}.`);
    glbs.length = 0;
    glbs.push(...filt);
  }

  // Launch one shared browser; one tab handles the whole queue serially to
  // avoid GPU/three.js memory issues.
  console.log('[backfill] Launching headless Chrome…');
  const browser = await puppeteer.launch({ headless: true });
  const page    = await spawnPage(browser);

  let ok      = 0;
  let skipped = 0;
  let failed  = 0;

  try {
    for (const o of glbs) {
      if ((ok + failed) >= LIMIT) break;
      const thumbKey = thumbnailKey(o.key);
      const modelUrl = publicUrl(o.key);
      if (!modelUrl) {
        console.warn(`[backfill] No public URL for ${o.key} — skipping.`);
        skipped++;
        continue;
      }

      if (!FORCE && await keyExists(thumbKey)) {
        // Already rendered — still ensure asset_cache has the URL recorded.
        const thumbUrl = publicUrl(thumbKey)!;
        await updateAssetCacheThumbnail(o.key, thumbUrl);
        skipped++;
        process.stdout.write(`. (${o.key}) already had thumb\n`);
        continue;
      }

      try {
        process.stdout.write(`> ${o.key} … `);
        const png      = await renderOne(page, modelUrl);
        await uploadBuffer(thumbKey, png, 'image/png');
        const thumbUrl = publicUrl(thumbKey)!;
        await updateAssetCacheThumbnail(o.key, thumbUrl);
        ok++;
        process.stdout.write(`ok (${png.length} bytes)\n`);
      } catch (err) {
        failed++;
        process.stdout.write(`FAIL: ${(err as Error).message}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[backfill] Done. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

// Allow `npm run thumbs:backfill` to call this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[backfill] Fatal:', err);
    process.exit(1);
  });
}
