#!/usr/bin/env node
// Reads Supabase forge_games for the 7 most-recent rows, downloads each thumbnail_url,
// inspects size + JPEG dimensions, and writes the runtime sections back into
// thumbnail-spawn-fix.json. Run after forging the 7 template test games and opening
// each in the editor (so the spawn-point captures fire).
//
// Usage:
//   node scripts/verify-thumbnail-spawn-fix.js
//   node scripts/verify-thumbnail-spawn-fix.js --ids=85,86,87,88,89,90,91
//
// No deps beyond Node ≥ 18 (uses built-in fetch and node:fs).

const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const ROOT          = path.resolve(__dirname, '..');
const JSON_PATH     = path.join(ROOT, 'thumbnail-spawn-fix.json');
const SAMPLES_DIR   = path.join(ROOT, 'thumbnail-samples');
const SUPABASE_URL  = 'https://daahlworuhbdindjepyg.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhYWhsd29ydWhiZGluZGplcHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODc1MzIsImV4cCI6MjA5MzE2MzUzMn0.2bZa49XuHTBxb-LgqStR_1ouevs-qrFOHGQAZCCxLeQ';

const TEMPLATE_GENRES = ['platformer', 'survival', 'adventure', 'tycoon', 'puzzle', 'racer', 'strategy'];

function parseIdsArg() {
  const arg = process.argv.find(a => a.startsWith('--ids='));
  if (!arg) return null;
  return arg.slice('--ids='.length).split(',').map(s => Number(s.trim())).filter(Boolean);
}

async function fetchRecentForgeGames(limit = 14) {
  const url = `${SUPABASE_URL}/rest/v1/forge_games?select=id,title,genre,thumbnail_url,created_at&order=created_at.desc&limit=${limit}`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function fetchById(id) {
  const url = `${SUPABASE_URL}/rest/v1/forge_games?id=eq.${id}&select=id,title,genre,thumbnail_url,created_at&limit=1`;
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const arr = await r.json();
  return arr[0] ?? null;
}

// JPEG SOF marker walker — returns [width, height] or null if it's not parseable.
function jpegDimensions(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p < buf.length) {
    if (buf[p] !== 0xff) return null;
    while (buf[p] === 0xff && p < buf.length) p++;
    const marker = buf[p++];
    if (marker === 0xd9 || marker === 0xda) return null;
    // Standalone markers without segment payload
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const segLen = (buf[p] << 8) | buf[p + 1];
    if (
      // SOF0..SOF15 except DHT(0xc4), JPG(0xc8), DAC(0xcc)
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const h = (buf[p + 3] << 8) | buf[p + 4];
      const w = (buf[p + 5] << 8) | buf[p + 6];
      return [w, h];
    }
    p += segLen;
  }
  return null;
}

async function inspectUrl(url) {
  if (!url) return { reachable: false, status: 'empty_url' };
  try {
    const r = await fetch(url);
    if (!r.ok) return { reachable: false, status: r.status };
    const buf  = Buffer.from(await r.arrayBuffer());
    const dims = jpegDimensions(buf);
    return {
      reachable:    true,
      status:       r.status,
      content_type: r.headers.get('content-type'),
      bytes:        buf.length,
      width:        dims?.[0] ?? null,
      height:       dims?.[1] ?? null,
      buf,
    };
  } catch (e) {
    return { reachable: false, error: String(e) };
  }
}

function placeholderUrlFor(finalUrl) {
  if (!finalUrl) return '';
  return finalUrl.replace(/\/(\d+)\.jpg$/, '/$1_placeholder.jpg');
}

async function main() {
  if (!existsSync(JSON_PATH)) {
    console.error(`Missing ${JSON_PATH}. Re-run after the offline JSON has been generated.`);
    process.exit(1);
  }
  if (!existsSync(SAMPLES_DIR)) mkdirSync(SAMPLES_DIR);

  const json = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

  const explicitIds = parseIdsArg();
  let rows;
  if (explicitIds) {
    rows = (await Promise.all(explicitIds.map(fetchById))).filter(Boolean);
    console.log(`Inspecting ${rows.length} rows by --ids: ${explicitIds.join(', ')}`);
  } else {
    const recent = await fetchRecentForgeGames(14);
    // Bucket by genre and pick most recent per genre.
    const byGenre = new Map();
    for (const row of recent) {
      const g = (row.genre ?? '').toLowerCase();
      if (!TEMPLATE_GENRES.includes(g)) continue;
      if (!byGenre.has(g)) byGenre.set(g, row);
    }
    rows = TEMPLATE_GENRES.map(g => byGenre.get(g)).filter(Boolean);
    const missing = TEMPLATE_GENRES.filter(g => !byGenre.has(g));
    if (missing.length) console.warn(`Missing recent games for genres: ${missing.join(', ')}`);
    console.log(`Inspecting most-recent row per genre: ${rows.map(r => `${r.genre}:${r.id}`).join(', ')}`);
  }

  for (const row of rows) {
    const genre = (row.genre ?? '').toLowerCase();
    if (!TEMPLATE_GENRES.includes(genre)) {
      console.warn(`Skipping id=${row.id} — genre '${row.genre}' not in template list`);
      continue;
    }
    const finalUrl       = row.thumbnail_url ?? '';
    const placeholderUrl = placeholderUrlFor(finalUrl);

    const finalInfo       = await inspectUrl(finalUrl);
    const placeholderInfo = await inspectUrl(placeholderUrl);

    // Persist the actual JPEGs locally under thumbnail-samples/ for visual review.
    if (finalInfo.buf)
      writeFileSync(path.join(SAMPLES_DIR, `${genre}_${row.id}_final.jpg`), finalInfo.buf);
    if (placeholderInfo.buf)
      writeFileSync(path.join(SAMPLES_DIR, `${genre}_${row.id}_placeholder.jpg`), placeholderInfo.buf);

    const blankFinal       = finalInfo.bytes < 1500;
    const blankPlaceholder = placeholderInfo.bytes < 1500;

    const dimsOk = finalInfo.width === 512 && finalInfo.height === 288;
    const visualAssertion =
      !finalInfo.reachable     ? 'NEEDS_MANUAL_REVIEW — final thumbnail not reachable'
      : !dimsOk                ? `NEEDS_MANUAL_REVIEW — dimensions ${finalInfo.width}x${finalInfo.height} (expected 512x288)`
      : blankFinal             ? 'NEEDS_MANUAL_REVIEW — final JPEG suspiciously small (likely blank)'
      :                          'NEEDS_MANUAL_REVIEW — open thumbnail-samples/' + `${genre}_${row.id}_final.jpg and confirm the spawn-point view matches expected_view`;

    json.test_templates[genre] = {
      ...json.test_templates[genre],
      game_id:            row.id,
      title:              row.title,
      created_at:         row.created_at,
      spawn_camera_state: 'NEEDS_MANUAL_REVIEW — copy from Unity console: [LuauGameRunner] Spawn camera state recorded …',
      thumbnail_url:      finalUrl || 'EMPTY',
      placeholder_url:    placeholderUrl || 'EMPTY',
      final_size:         finalInfo.bytes ?? null,
      placeholder_size:   placeholderInfo.bytes ?? null,
      final_dimensions:   dimsOk ? '512x288' : `${finalInfo.width}x${finalInfo.height}`,
      final_reachable:    finalInfo.reachable,
      placeholder_reachable: placeholderInfo.reachable,
      sample_jpeg_path:   finalInfo.buf       ? `thumbnail-samples/${genre}_${row.id}_final.jpg`       : null,
      placeholder_path:   placeholderInfo.buf ? `thumbnail-samples/${genre}_${row.id}_placeholder.jpg` : null,
      visual_assertion:   visualAssertion,
      issues:             [
        !finalInfo.reachable     && 'final-not-reachable',
        !placeholderInfo.reachable && 'placeholder-not-reachable',
        blankFinal               && 'final-suspiciously-small',
        blankPlaceholder         && 'placeholder-suspiciously-small',
        !dimsOk                  && 'final-dimensions-not-512x288',
      ].filter(Boolean),
    };

    console.log(
      `${genre.padEnd(10)} id=${row.id}  ` +
      `final=${finalInfo.reachable ? `${finalInfo.bytes}B ${finalInfo.width}x${finalInfo.height}` : 'X'}  ` +
      `placeholder=${placeholderInfo.reachable ? `${placeholderInfo.bytes}B` : 'X'}`,
    );
  }

  json.status.step_8_template_verification =
    Object.values(json.test_templates).every(t => t.final_reachable) ? 'partial — all URLs reachable; visual review still needed'
    : 'incomplete — see test_templates.*.issues';
  json.status.step_9_runtime_outputs = 'partial — sample JPEGs saved under thumbnail-samples/, paste spawn camera state from Unity console manually';

  writeFileSync(JSON_PATH, JSON.stringify(json, null, 2) + '\n');
  console.log(`\nWrote ${JSON_PATH}`);
  console.log(`Sample JPEGs in: ${SAMPLES_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
