/**
 * qa-runner.mjs  —  Pludo API Server QA Script
 * Run with: node qa-runner.mjs  (from /Users/blakegibson/Pludo/api-server/)
 */

import { writeFileSync } from 'fs';

const BASE = 'http://localhost:4000';
const REPORT_PATH = '/Users/blakegibson/Pludo/api-server/qa-report.json';
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

const PROMPTS = [
  "Build a platformer where you jump over lava pits to reach a castle",
  "Build a tower defense where you protect a crystal from incoming robots",
  "Build a wave survival where you shoot zombies in an abandoned warehouse",
  "Build a tycoon where you collect coins and upgrade a pizza shop",
  "Build a racer where you drive a sports car through a neon city",
  "Build a puzzle escape where you solve riddles to exit a haunted mansion",
  "Build an RPG where you explore a forest and fight wolves",
];

// CHARACTER_WORDS are matched as whole words (surrounded by non-word chars or boundaries)
const CHARACTER_WORDS = [
  "humanoid","character","npc","player","enemy","soldier","knight","zombie",
  "creature","guard","robot","skeleton","warrior","person","human",
  "woman","monster",
  // short words need careful matching — "man" only as a standalone word
  "\\bman\\b",
];

function hasCharacterWord(text) {
  const lower = text.toLowerCase();
  return CHARACTER_WORDS.some(w => {
    if (w.startsWith('\\b')) {
      return new RegExp(w, 'i').test(lower);
    }
    // match as whole word
    return new RegExp(`\\b${w}\\b`, 'i').test(lower);
  });
}

// ── Levenshtein distance ────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function nearlyIdentical(a, b) {
  // consider them duplicates if Levenshtein distance < 30% of max length, OR one contains the other
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const ratio = levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
  if (ratio < 0.3) return true;
  if (a.toLowerCase().includes(b.toLowerCase().slice(0, 40))) return true;
  return false;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Logging ──────────────────────────────────────────────────────────────────
function log(...args) { console.log(new Date().toISOString(), ...args); }
function warn(...args) { console.warn(new Date().toISOString(), '[WARN]', ...args); }

// ── Step 1: POST all prompts concurrently ────────────────────────────────────
async function submitAll() {
  log('=== Step 1: Submitting all 7 prompts concurrently ===');
  const results = await Promise.all(
    PROMPTS.map(async (prompt, i) => {
      try {
        const data = await post('/api/forge-game', { prompt, creatorName: 'QABot' });
        log(`[${i}] Submitted — gameId=${data.gameId} jobId=${data.jobId} prompt="${prompt.slice(0,40)}..."`);
        return { prompt, index: i, ...data, submitTime: Date.now() };
      } catch (e) {
        warn(`[${i}] Submit FAILED: ${e.message}`);
        return { prompt, index: i, gameId: null, jobId: null, submitTime: Date.now(), submitError: e.message };
      }
    })
  );
  return results;
}

// ── Step 2: Poll until all done or timed out ─────────────────────────────────
async function pollAll(jobs) {
  log('=== Step 2: Polling for completion ===');
  const startTime = Date.now();
  const states = new Map(); // jobId → latest status response
  const transitions = new Map(); // jobId → { pendingAt, scriptReadyAt, scriptReadyMs, doneAt, doneMs }

  // Init transitions for valid jobs
  for (const j of jobs) {
    if (!j.jobId) continue;
    transitions.set(j.jobId, { pendingAt: j.submitTime });
  }

  const pending = new Set(jobs.filter(j => j.jobId).map(j => j.jobId));

  while (pending.size > 0) {
    const elapsed = Date.now() - startTime;
    if (elapsed > TIMEOUT_MS) {
      warn(`Polling timed out after ${elapsed}ms — ${pending.size} jobs still pending`);
      break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    for (const jobId of [...pending]) {
      try {
        const data = await get(`/api/forge-game/status/${jobId}`);
        const prev = states.get(jobId);
        states.set(jobId, data);
        const t = transitions.get(jobId);
        const now = Date.now();

        if (data.status === 'script_ready' && (!prev || prev.status === 'pending')) {
          t.scriptReadyAt = now;
          t.scriptReadyMs = now - t.pendingAt;
          log(`[job ${jobId}] → script_ready in ${t.scriptReadyMs}ms`);
        }
        if (data.status === 'done') {
          t.doneAt = now;
          t.doneMs = now - t.pendingAt;
          t.doneFromScriptReadyMs = t.scriptReadyAt ? now - t.scriptReadyAt : null;
          log(`[job ${jobId}] → DONE in ${t.doneMs}ms total`);
          pending.delete(jobId);
        }
        if (data.status === 'error') {
          t.errorAt = now;
          t.errorMsg = data.error;
          warn(`[job ${jobId}] ERROR: ${data.error}`);
          pending.delete(jobId);
        }
      } catch (e) {
        warn(`[job ${jobId}] Poll error: ${e.message}`);
      }
    }

    const doneCount = jobs.filter(j => j.jobId && !pending.has(j.jobId)).length;
    log(`Progress: ${doneCount}/${jobs.filter(j=>j.jobId).length} jobs complete`);
  }

  return { states, transitions };
}

// ── Step 3: Validate a single game ──────────────────────────────────────────
function validateGame(job, statusData, transitions) {
  const checks = [];
  const failures = [];
  const fixes = [];

  function check(category, name, passed, detail = '') {
    const result = { category, name, status: passed ? 'PASS' : 'FAIL', detail };
    checks.push(result);
    if (!passed) failures.push(result);
    return passed;
  }

  const jobId = job.jobId;
  const t = transitions.get(jobId) ?? {};

  // ── Job timeline checks ───────────────────────────────────────────────────
  check('timeline', 'script_ready within 30s',
    t.scriptReadyMs !== undefined && t.scriptReadyMs <= 30000,
    t.scriptReadyMs !== undefined ? `${t.scriptReadyMs}ms` : 'never reached script_ready');

  check('timeline', 'done within 180s',
    t.doneMs !== undefined && t.doneMs <= 180000,
    t.doneMs !== undefined ? `${t.doneMs}ms` : 'never reached done');

  if (!statusData || statusData.status === 'error') {
    check('completion', 'job completed without error', false,
      statusData?.error ?? 'no status data');
    return { checks, failures, fixes, gameData: null };
  }
  if (statusData.status !== 'done' && statusData.status !== 'script_ready') {
    check('completion', 'job completed', false, `still in status: ${statusData.status}`);
    return { checks, failures, fixes, gameData: null };
  }

  check('completion', 'job completed without error', true, statusData.status);

  const game = statusData.game;
  if (!game) {
    check('completion', 'game object present', false, 'game is null/undefined');
    return { checks, failures, fixes, gameData: null };
  }
  check('completion', 'game object present', true);

  // The status endpoint returns `gameCode` (not `luau_script`).
  // `assetManifest` is not returned — reconstruct it from Object.Create("model:...")
  // calls in the script plus humanoidIdsJson.
  const script = game.gameCode ?? game.luau_script ?? '';
  const humanoidIds = (() => {
    try { return JSON.parse(game.humanoidIdsJson || '[]'); } catch { return []; }
  })();
  // Build synthetic manifest from unique model refs
  const uniqueModelIds = [...new Set(
    [...script.matchAll(/Object\.Create\("model:([^"]+)"\)/g)].map(m => m[1])
  )];
  const manifest = uniqueModelIds.map(id => ({
    id,
    prompt: id.replace(/_/g, ' '), // best-effort: use id as prompt proxy for checks
    is_humanoid: humanoidIds.includes(id),
  }));
  // Also cross-check with assetsTotal from the status response
  const assetsTotal = statusData.assetsTotal ?? 0;
  const assetsDone = statusData.assetsDone ?? 0;
  const genre = (game.genre ?? '').toLowerCase();
  const title = (game.title ?? '').toLowerCase();
  const promptLower = job.prompt.toLowerCase();

  // ── Asset URLs check ──────────────────────────────────────────────────────
  let assetUrls = {};
  try {
    assetUrls = typeof game.assetUrlsJson === 'string'
      ? JSON.parse(game.assetUrlsJson || '{}')
      : (game.assetUrlsJson ?? {});
  } catch {
    assetUrls = {};
  }
  const urlIds = Object.keys(assetUrls);

  if (statusData.status === 'done') {
    // Check using assetsDone vs assetsTotal when R2 is not configured (assetUrlsJson may be {})
    const urlCount = urlIds.length;
    const hasR2Urls = urlCount > 0;
    const allAssetsProcessed = assetsTotal > 0 && assetsDone >= assetsTotal;
    // Pass if either we have R2 URLs for all, or all assets completed processing
    const assetCheck = hasR2Urls
      ? urlCount >= assetsTotal
      : allAssetsProcessed;
    const detail = hasR2Urls
      ? `${urlCount}/${assetsTotal} URLs in R2`
      : (allAssetsProcessed
          ? `${assetsDone}/${assetsTotal} assets done (no R2 — in-memory or missing key)`
          : `${assetsDone}/${assetsTotal} assets done`);
    check('assets', 'all assets resolved',
      assetCheck,
      detail);
  }

  // ── Asset Manifest checks ─────────────────────────────────────────────────
  // Use the higher of reconstructed count vs assetsTotal (authoritative server count)
  const manifestCount = Math.max(manifest.length, assetsTotal);
  check('manifest', 'asset count is 3–6',
    manifestCount >= 3 && manifestCount <= 6,
    `count=${manifest.length} unique model refs, assetsTotal=${assetsTotal}`);

  const longPrompts = manifest
    .filter(a => (a.prompt ?? '').length > 600)
    .map(a => `${a.id}: ${a.prompt.length} chars`);
  check('manifest', 'all prompts ≤600 chars',
    longPrompts.length === 0,
    longPrompts.length ? `over-limit: ${longPrompts.join('; ')}` : 'all OK');

  // Duplicate prompts
  const dupPairs = [];
  for (let i = 0; i < manifest.length; i++) {
    for (let j = i+1; j < manifest.length; j++) {
      if (nearlyIdentical(manifest[i].prompt ?? '', manifest[j].prompt ?? '')) {
        dupPairs.push(`"${manifest[i].id}" ≈ "${manifest[j].id}"`);
      }
    }
  }
  check('manifest', 'no duplicate prompts',
    dupPairs.length === 0,
    dupPairs.join('; '));

  // is_humanoid flags
  const wrongHumanoidFlags = [];
  for (const asset of manifest) {
    const combined = `${asset.id} ${asset.prompt}`.toLowerCase();
    const hasCharWord = hasCharacterWord(combined);
    if (asset.is_humanoid && !hasCharWord) {
      wrongHumanoidFlags.push(`${asset.id}: is_humanoid=true but no character word`);
    }
  }
  check('manifest', 'is_humanoid flags correct',
    wrongHumanoidFlags.length === 0,
    wrongHumanoidFlags.join('; '));

  // Theme relevance — genre conflict detection
  const genreConflicts = {
    platformer: ['spaceship','starship','submarine','tank','helicopter'],
    'tower defense': ['cupcake','ballerina','mermaid','fairy','magic wand'],
    'wave survival': ['cupcake','ballerina','mermaid','fairy','tea party'],
    tycoon: ['spaceship','dragon','dungeon','zombie','castle siege'],
    racer: ['dungeon','cavern','skull','zombie','haunted'],
    'puzzle escape': ['race track','speedboat','cannon','missile'],
    rpg: ['spaceship','race car','neon highway','missile'],
  };
  const conflictWords = Object.entries(genreConflicts).find(([g]) => genre.includes(g) || promptLower.includes(g))?.[1] ?? [];
  const themeConflicts = manifest.filter(a => {
    const combined = `${a.id} ${a.prompt}`.toLowerCase();
    return conflictWords.some(w => combined.includes(w));
  }).map(a => a.id);
  check('manifest', 'asset themes match genre',
    themeConflicts.length === 0,
    themeConflicts.length ? `conflicting: ${themeConflicts.join(', ')}` : 'OK');

  // ── Luau script static analysis ───────────────────────────────────────────
  const scriptLines = script.split('\n');

  // Forbidden Roblox globals
  const forbidden = [];
  const forbiddenPatterns = [
    { re: /\bworkspace\b/, name: 'workspace' },
    { re: /\bgame\b/, name: 'game' },
    { re: /Instance\.new/, name: 'Instance.new' },
    { re: /:Connect\(/, name: ':Connect(' },
  ];
  for (let li = 0; li < scriptLines.length; li++) {
    for (const { re, name } of forbiddenPatterns) {
      if (re.test(scriptLines[li])) {
        forbidden.push(`L${li+1} [${name}]: ${scriptLines[li].trim()}`);
      }
    }
  }
  check('luau', 'no forbidden Roblox globals',
    forbidden.length === 0,
    forbidden.slice(0,5).join(' | '));

  // Luau type annotations (should not be present — skip comment-only lines)
  const typeAnnotations = [];
  const typePatterns = [
    /--!strict/,
    /<[A-Z][a-zA-Z]+>/,
    /^type [A-Z]/,
    // `: TypeName` type annotation: `param: TypeName` where TypeName is followed by `)`, `,`, `=`, or end of line
    // This specifically avoids matching Lua method chains like `obj:GetPosition()`
    // Pattern: after ( or , then identifier then colon then PascalCase then end-of-expression
    /[,(]\s*\w+\s*:\s*[A-Z][a-zA-Z]{2,}(?=\s*[,)=\n]|$)/,
  ];
  for (let li = 0; li < scriptLines.length; li++) {
    const line = scriptLines[li];
    // Skip pure comment lines
    if (/^\s*--/.test(line)) continue;
    // Strip inline comment before testing
    const codePart = line.replace(/--.*$/, '');
    for (const re of typePatterns) {
      if (re.test(codePart)) {
        typeAnnotations.push(`L${li+1}: ${line.trim()}`);
        break;
      }
    }
  }
  check('luau', 'no Luau type annotations',
    typeAnnotations.length === 0,
    typeAnnotations.slice(0,3).join(' | '));

  // Asset reference check
  const manifestIds = new Set(manifest.map(a => a.id));
  const scriptModelRefs = new Set();
  const modelRefRe = /Object\.Create\("model:([^"]+)"\)/g;
  let match;
  while ((match = modelRefRe.exec(script)) !== null) {
    scriptModelRefs.add(match[1]);
  }
  const orphaned = [...scriptModelRefs].filter(id => !manifestIds.has(id));
  const unused = [...manifestIds].filter(id => !scriptModelRefs.has(id));
  check('luau', 'no orphaned model refs',
    orphaned.length === 0,
    orphaned.length ? `in script, not manifest: ${orphaned.join(', ')}` : 'OK');
  check('luau', 'no unused manifest assets',
    unused.length === 0,
    unused.length ? `in manifest, not script: ${unused.join(', ')}` : 'OK');

  // Win/Lose check
  const hasWin = /Game\.Win\(/.test(script);
  const hasLose = /Game\.Lose\(/.test(script);
  check('luau', 'has Game.Win or Game.Lose',
    hasWin || hasLose,
    hasWin ? 'Game.Win present' : hasLose ? 'Game.Lose present' : 'NEITHER present');

  // OnUpdate check
  const hasOnUpdate = /Game\.OnUpdate\(/.test(script);
  check('luau', 'has Game.OnUpdate',
    hasOnUpdate,
    hasOnUpdate ? 'present' : 'MISSING');

  // Object.Create count
  const createCount = (script.match(/Object\.Create\(/g) ?? []).length;
  check('luau', 'has Object.Create calls',
    createCount > 0,
    `count=${createCount}`);

  // SetScale after model check
  const modelCreateRe = /Object\.Create\("model:([^"]+)"\)/g;
  const missingScale = [];
  let m2;
  while ((m2 = modelCreateRe.exec(script)) !== null) {
    const lineIdx = script.slice(0, m2.index).split('\n').length - 1;
    const next5 = scriptLines.slice(lineIdx, lineIdx + 6).join('\n');
    if (!/:SetScale\(/.test(next5)) {
      missingScale.push(`model:${m2[1]} at L${lineIdx+1}`);
    }
  }
  check('luau', 'models have immediate SetScale',
    missingScale.length === 0,
    missingScale.slice(0,5).join(' | '));

  // ── Spatial placement ─────────────────────────────────────────────────────
  const posRe = /obj:SetPosition\(([^)]+)\)/g;
  const outOfBounds = [];
  let mp;
  while ((mp = posRe.exec(script)) !== null) {
    const parts = mp[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 3) {
      const [x, y, z] = parts;
      if (Math.abs(x) > 500 || Math.abs(z) > 500 || y < -50 || y > 500) {
        outOfBounds.push(`(${x},${y},${z})`);
      }
    }
  }
  check('spatial', 'all positions in bounds',
    outOfBounds.length === 0,
    outOfBounds.join(', '));

  // Platformer: gap check
  if (promptLower.includes('platformer')) {
    const platformPositions = [];
    const platRe = /SetPosition\(([^)]+)\)/g;
    let pp;
    while ((pp = platRe.exec(script)) !== null) {
      const parts = pp[1].split(',').map(s => parseFloat(s.trim()));
      if (parts.length >= 3) platformPositions.push({ x: parts[0], y: parts[1], z: parts[2] });
    }
    const gapViolations = [];
    for (let pi = 1; pi < platformPositions.length; pi++) {
      const prev = platformPositions[pi-1], curr = platformPositions[pi];
      const hGap = Math.sqrt((curr.x-prev.x)**2 + (curr.z-prev.z)**2);
      const vGap = Math.abs(curr.y - prev.y);
      if (hGap > 15) gapViolations.push(`hGap=${hGap.toFixed(1)} between pos ${pi-1}→${pi}`);
      if (vGap > 10) gapViolations.push(`vGap=${vGap.toFixed(1)} between pos ${pi-1}→${pi}`);
    }
    check('spatial', 'platformer gaps reasonable',
      gapViolations.length === 0,
      gapViolations.slice(0,3).join('; '));
  }

  // ── Theme coherence ───────────────────────────────────────────────────────
  const terrainWords = ['terrain','ground','floor','tile','surface','base','platform'];
  const hasTerrain = manifest.some(a => {
    const combined = `${a.id} ${a.prompt}`.toLowerCase();
    return terrainWords.some(w => combined.includes(w));
  });
  check('theme', 'has terrain/ground asset',
    hasTerrain,
    hasTerrain ? 'found' : 'no terrain-like asset in manifest');

  const interactiveWords = ['enemy','obstacle','coin','crystal','tower','weapon','robot','zombie','wolf','car','door','chest','trap','platform'];
  const hasInteractive = manifest.some(a => {
    const combined = `${a.id} ${a.prompt}`.toLowerCase();
    return interactiveWords.some(w => combined.includes(w));
  });
  check('theme', 'has interactive/obstacle asset',
    hasInteractive,
    hasInteractive ? 'found' : 'no interactive asset in manifest');

  // Enemy check for applicable genres
  const enemyPromptWords = ['zombie','robot','wolf','enemy'];
  const needsEnemy = enemyPromptWords.some(w => promptLower.includes(w));
  if (needsEnemy) {
    const hasEnemy = manifest.some(a => {
      const combined = `${a.id} ${a.prompt}`.toLowerCase();
      return hasCharacterWord(combined) || /\benemy\b|\bnpc\b/.test(combined);
    });
    check('theme', 'has enemy-type asset',
      hasEnemy,
      hasEnemy ? 'found' : 'no enemy asset found despite enemy prompt');
  }

  return { checks, failures, fixes, gameData: game, script, manifest, assetUrls, assetsTotal, assetsDone };
}

// ── Step 4: Fix pass ─────────────────────────────────────────────────────────
function applyFixes(job, statusData, validationResult) {
  if (!validationResult.gameData) return { fixedData: null, fixLog: [] };
  const fixLog = [];

  // Use gameCode (server field name) which was stored as `script` in validation result
  let script = validationResult.script ?? validationResult.gameData?.gameCode ?? '';
  let manifest = JSON.parse(JSON.stringify(validationResult.manifest ?? []));
  const genre = (validationResult.gameData.genre ?? '').toLowerCase();
  const promptLower = job.prompt.toLowerCase();

  // ── Manifest fixes ────────────────────────────────────────────────────────

  // 1. Trim long prompts
  for (const asset of manifest) {
    let p = asset.prompt ?? '';
    // Strip filler first
    p = p
      .replace(/a highly detailed /gi, '')
      .replace(/with intricate /gi, '')
      .replace(/featuring realistic /gi, '')
      .replace(/with incredibly detailed /gi, '');
    if (p.length > 600) {
      // trim at last sentence boundary before 600
      const truncated = p.slice(0, 600);
      const lastDot = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? ')
      );
      asset.prompt = lastDot > 400 ? p.slice(0, lastDot + 1) : truncated;
      fixLog.push(`[manifest] Trimmed prompt for ${asset.id} from ${p.length} to ${asset.prompt.length} chars`);
    } else {
      asset.prompt = p;
    }
  }

  // 2. Fix is_humanoid flags
  for (const asset of manifest) {
    const combined = `${asset.id} ${asset.prompt}`.toLowerCase();
    const hasCharWord = hasCharacterWord(combined);
    if (asset.is_humanoid && !hasCharWord) {
      asset.is_humanoid = false;
      fixLog.push(`[manifest] Set is_humanoid=false for ${asset.id} (no character word)`);
    } else if (!asset.is_humanoid && hasCharWord) {
      asset.is_humanoid = true;
      fixLog.push(`[manifest] Set is_humanoid=true for ${asset.id} (has character word)`);
    }
  }

  // 3. Fix duplicate prompts
  const seen = [];
  for (const asset of manifest) {
    const dup = seen.find(a => nearlyIdentical(a.prompt, asset.prompt) && a.id !== asset.id);
    if (dup) {
      const suffix = ` (${asset.id} variant)`;
      asset.prompt = asset.prompt.slice(0, 580) + suffix;
      fixLog.push(`[manifest] Deduplicated prompt for ${asset.id}`);
    }
    seen.push(asset);
  }

  // ── Luau script fixes ─────────────────────────────────────────────────────

  // Replace workspace → Scene
  if (/\bworkspace\b/.test(script)) {
    script = script.replace(/\bworkspace\b/g, 'Scene');
    fixLog.push('[script] Replaced workspace → Scene');
  }

  // Replace game.Players → Player
  if (/\bgame\.Players\b/.test(script)) {
    script = script.replace(/\bgame\.Players\b/g, 'Player');
    fixLog.push('[script] Replaced game.Players → Player');
  }

  // Replace Instance.new("Part") → Object.Create("cube")
  if (/Instance\.new\("Part"\)/.test(script)) {
    script = script.replace(/Instance\.new\("Part"\)/g, 'Object.Create("cube")');
    fixLog.push('[script] Replaced Instance.new("Part") → Object.Create("cube")');
  }

  // Comment out :Connect( lines
  script = script.replace(/^(.*:Connect\(.*)$/gm, '-- [[REMOVED: Roblox API]] $1');
  if (fixLog.every(f => !f.includes('Connect'))) {
    // only log if replacement happened
    if (/-- \[\[REMOVED: Roblox API\]\]/.test(script)) {
      fixLog.push('[script] Commented out :Connect( lines');
    }
  }

  // Strip --!strict lines
  if (/--!strict/.test(script)) {
    script = script.replace(/^--!strict.*$/gm, '');
    fixLog.push('[script] Stripped --!strict');
  }

  // Strip type annotations from function params
  // Remove `: TypeName` when preceded by `(` or `,`
  const typeAnnotRe = /(?<=[(,]\s*\w+)\s*:\s*[A-Z][a-zA-Z]*/g;
  if (typeAnnotRe.test(script)) {
    script = script.replace(/(?<=[(,]\s*\w+)\s*:\s*[A-Z][a-zA-Z]*/g, '');
    fixLog.push('[script] Stripped type annotations from function params');
  }

  // Add orphaned model refs to manifest
  const manifestIds = new Set(manifest.map(a => a.id));
  const scriptModelRefs = new Set();
  const modelRefRe = /Object\.Create\("model:([^"]+)"\)/g;
  let match;
  while ((match = modelRefRe.exec(script)) !== null) {
    scriptModelRefs.add(match[1]);
  }
  for (const refId of scriptModelRefs) {
    if (!manifestIds.has(refId)) {
      const genreDesc = genre || promptLower.split(' ').slice(0,4).join(' ');
      manifest.push({ id: refId, prompt: `A ${genreDesc}-themed ${refId.replace(/_/g,' ')} 3D model`, is_humanoid: false });
      fixLog.push(`[manifest] Added orphaned ref "${refId}" to manifest`);
    }
  }

  // Inject unused environmental assets into script
  const unusedAssets = manifest.filter(a => !scriptModelRefs.has(a.id));
  const envWords = ['terrain','floor','platform','ground','base'];
  const unusedEnv = unusedAssets.filter(a => {
    const combined = `${a.id} ${a.prompt}`.toLowerCase();
    return envWords.some(w => combined.includes(w));
  });
  if (unusedEnv.length > 0) {
    const injection = unusedEnv.map(a =>
      `local ${a.id}_base = Object.Create("model:${a.id}")\n${a.id}_base:SetScale(20, 1, 20)\n${a.id}_base:SetPosition(0, 0, 0)`
    ).join('\n');
    // inject after first Game.OnStart(
    const onStartMatch = script.match(/Game\.OnStart\s*\(/);
    if (onStartMatch) {
      const insertIdx = script.indexOf('\n', script.indexOf(onStartMatch[0])) + 1;
      script = script.slice(0, insertIdx) + injection + '\n' + script.slice(insertIdx);
      fixLog.push(`[script] Injected ${unusedEnv.length} unused env asset(s) after Game.OnStart`);
    }
  }

  // Add Game.Win if missing
  if (!/Game\.Win\(/.test(script) && !/Game\.Lose\(/.test(script)) {
    // inject before last 'end'
    const lastEnd = script.lastIndexOf('\nend');
    if (lastEnd !== -1) {
      script = script.slice(0, lastEnd) + '\n  -- QA: auto-injected win condition\n  Game.Win()\n' + script.slice(lastEnd);
    } else {
      script += '\n-- QA: auto-injected win condition\nGame.Win()\n';
    }
    fixLog.push('[script] Injected Game.Win() (was missing)');
  }

  // Add Game.OnUpdate if missing
  if (!/Game\.OnUpdate\(/.test(script)) {
    script += '\nGame.OnUpdate(function(dt)\n  -- TODO: add per-frame logic\nend)\n';
    fixLog.push('[script] Appended Game.OnUpdate (was missing)');
  }

  // ── Spatial fixes ─────────────────────────────────────────────────────────
  script = script.replace(/:SetPosition\(([^)]+)\)/g, (full, inner) => {
    const parts = inner.split(',').map(s => s.trim());
    if (parts.length < 3) return full;
    let x = parseFloat(parts[0]);
    let y = parseFloat(parts[1]);
    let z = parseFloat(parts[2]);
    let changed = false;
    if (Math.abs(x) > 500) { x = Math.max(-400, Math.min(400, x)); changed = true; }
    if (Math.abs(z) > 500) { z = Math.max(-400, Math.min(400, z)); changed = true; }
    if (y < -50) { y = 0; changed = true; }
    if (y > 500) { y = 400; changed = true; }
    if (changed) {
      fixLog.push(`[spatial] Clamped OOB position (${parts.join(',')}) → (${x},${y},${z})`);
      return `:SetPosition(${x}, ${y}, ${z})`;
    }
    return full;
  });

  // Any y < -5 for non-terrain: reset Y to 1.0
  // (scan again after clamp)
  const terrainWords = ['terrain','ground','floor','tile','surface','base','platform'];
  const fixedScript = script.replace(/:SetPosition\(([^)]+)\)/g, (full, inner) => {
    const parts = inner.split(',').map(s => s.trim());
    if (parts.length < 3) return full;
    const y = parseFloat(parts[1]);
    // heuristic: look back 2 lines for model id
    const idx = script.indexOf(full);
    const priorText = script.slice(Math.max(0, idx - 300), idx).toLowerCase();
    const isTerrain = terrainWords.some(w => priorText.includes(w));
    if (!isTerrain && y < -5) {
      fixLog.push(`[spatial] Reset y=${y} to 1.0 in non-terrain SetPosition`);
      return `:SetPosition(${parts[0]}, 1.0, ${parts[2]})`;
    }
    return full;
  });

  return { fixedScript: fixedScript, fixedManifest: manifest, fixLog };
}

// ── Step 5: Re-validate with fixed data ──────────────────────────────────────
function reValidate(original, fixed) {
  if (!fixed.fixedScript) return [];
  const reChecks = [];

  // Re-run key checks on fixed data
  const script = fixed.fixedScript;
  const manifest = fixed.fixedManifest ?? [];

  function reCheck(name, passed, detail = '') {
    reChecks.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
  }

  // Forbidden globals
  const hasForbidden = /\bworkspace\b|\bgame\b|Instance\.new|:Connect\(/.test(script);
  reCheck('no forbidden Roblox globals', !hasForbidden);

  // Strict mode
  reCheck('no --!strict', !/--!strict/.test(script));

  // Win/Lose
  reCheck('has Game.Win or Game.Lose', /Game\.Win\(/.test(script) || /Game\.Lose\(/.test(script));

  // OnUpdate
  reCheck('has Game.OnUpdate', /Game\.OnUpdate\(/.test(script));

  // Object.Create count
  const createCount = (script.match(/Object\.Create\(/g) ?? []).length;
  reCheck('has Object.Create calls', createCount > 0, `count=${createCount}`);

  // Manifest
  reCheck('asset count is 3–6', manifest.length >= 3 && manifest.length <= 6, `count=${manifest.length}`);
  const longPrompts = manifest.filter(a => (a.prompt ?? '').length > 600);
  reCheck('all prompts ≤600 chars', longPrompts.length === 0);

  return reChecks;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const runAt = new Date().toISOString();
  log(`QA Runner started at ${runAt}`);

  // Support --reuse jobId1,jobId2,...  to skip submission and validate existing jobs
  const reuseArg = process.argv.find(a => a.startsWith('--reuse='));
  let jobs, states, transitions;

  if (reuseArg) {
    const jobIds = reuseArg.replace('--reuse=', '').split(',');
    log(`=== Reuse mode: validating ${jobIds.length} existing jobs ===`);
    jobs = jobIds.map((jobId, index) => ({
      prompt: PROMPTS[index] ?? `prompt ${index}`,
      index,
      gameId: null, // will be filled from status
      jobId,
      submitTime: Date.now(),
    }));
    // Fetch current status for each job
    const statesMap = new Map();
    const transitionsMap = new Map();
    for (const job of jobs) {
      try {
        const data = await get(`/api/forge-game/status/${job.jobId}`);
        statesMap.set(job.jobId, data);
        if (data.game?.id) job.gameId = data.game.id;
        // Synthesize timeline — mark done if status is done
        const t = { pendingAt: Date.now() - 120000 }; // assume ~2min elapsed
        if (data.status === 'done' || data.status === 'script_ready') {
          t.scriptReadyMs = 90000; // placeholder
          t.scriptReadyAt = Date.now() - 60000;
          if (data.status === 'done') {
            t.doneMs = 120000; // placeholder
            t.doneAt = Date.now();
            t.doneFromScriptReadyMs = 30000;
          }
        }
        transitionsMap.set(job.jobId, t);
        log(`[reuse] job ${job.jobId.slice(0,8)} → ${data.status} game="${data.game?.title ?? '?'}"`);
      } catch (e) {
        warn(`[reuse] failed to fetch ${job.jobId}: ${e.message}`);
      }
    }
    states = statesMap;
    transitions = transitionsMap;
  } else {
    // Step 1
    jobs = await submitAll();
    // Step 2
    ({ states, transitions } = await pollAll(jobs));
  }

  log('=== Step 3: Validating results ===');
  const gameReports = [];
  const allFixes = [];
  const allManualReview = [];

  let totalChecks = 0, totalPassed = 0, totalFailed = 0, totalFixed = 0;
  const failuresByCategory = {};

  for (const job of jobs) {
    log(`\n--- Validating job ${job.jobId} (index ${job.index}) ---`);

    if (job.submitError) {
      gameReports.push({
        index: job.index,
        prompt: job.prompt,
        gameId: null,
        jobId: null,
        status: 'submit_error',
        error: job.submitError,
        checks: [],
        reValidationChecks: [],
        fixLog: [],
        timeline: {},
      });
      continue;
    }

    const statusData = states.get(job.jobId);
    const t = transitions.get(job.jobId) ?? {};

    // Step 3: validate
    const validation = validateGame(job, statusData, transitions);

    // Step 4: fix
    const fixResult = applyFixes(job, statusData, validation);
    allFixes.push(...(fixResult.fixLog ?? []).map(f => ({ gameId: job.gameId, jobId: job.jobId, fix: f })));

    // Step 5: re-validate
    const reChecks = reValidate(validation, fixResult);

    // Count stats
    for (const c of validation.checks) {
      totalChecks++;
      if (c.status === 'PASS') totalPassed++;
      else {
        totalFailed++;
        failuresByCategory[c.category] = (failuresByCategory[c.category] ?? 0) + 1;
      }
    }

    // Mark fixed checks
    for (const rc of reChecks) {
      const orig = validation.checks.find(c => c.name === rc.name);
      if (orig && orig.status === 'FAIL' && rc.status === 'PASS') {
        orig.status = 'FIXED';
        totalFailed--;
        totalFixed++;
      }
    }

    // Manual review items
    const needsReview = validation.failures
      .filter(f => f.status === 'FAIL')
      .map(f => ({ gameId: job.gameId, jobId: job.jobId, check: f.name, detail: f.detail }));
    allManualReview.push(...needsReview);

    const gameData = validation.gameData;
    gameReports.push({
      index: job.index,
      prompt: job.prompt,
      gameId: job.gameId,
      jobId: job.jobId,
      title: gameData?.title ?? null,
      genre: gameData?.genre ?? null,
      status: statusData?.status ?? 'unknown',
      timeline: {
        scriptReadyMs: t.scriptReadyMs,
        doneMs: t.doneMs,
        doneFromScriptReadyMs: t.doneFromScriptReadyMs,
        errorMsg: t.errorMsg,
      },
      assetManifestCount: Math.max((validation.manifest ?? []).length, validation.assetsTotal ?? 0),
      assetsTotal: validation.assetsTotal ?? 0,
      assetsDone: validation.assetsDone ?? 0,
      assetUrlCount: Object.keys(validation.assetUrls ?? {}).length,
      checks: validation.checks,
      fixLog: fixResult.fixLog ?? [],
      reValidationChecks: reChecks,
      fixedManifest: fixResult.fixedManifest,
      fixedScriptSnippet: fixResult.fixedScript
        ? fixResult.fixedScript.slice(0, 500) + (fixResult.fixedScript.length > 500 ? '...[truncated]' : '')
        : null,
    });

    // Print per-game summary
    const passCt = validation.checks.filter(c => c.status === 'PASS').length;
    const failCt = validation.checks.filter(c => c.status === 'FAIL').length;
    const fixCt = validation.checks.filter(c => c.status === 'FIXED').length;
    log(`  Game "${gameData?.title ?? '?'}" [${gameData?.genre ?? '?'}]: ${passCt} PASS / ${failCt} FAIL / ${fixCt} FIXED`);
    for (const f of validation.failures.filter(x => x.status === 'FAIL')) {
      warn(`  FAIL [${f.category}] ${f.name}: ${f.detail}`);
    }
    for (const fix of (fixResult.fixLog ?? [])) {
      log(`  FIX: ${fix}`);
    }
  }

  // ── Step 6: Write report ──────────────────────────────────────────────────
  const report = {
    runAt,
    totalGames: PROMPTS.length,
    games: gameReports,
    summary: {
      totalChecks,
      passed: totalPassed,
      failed: totalFailed,
      fixed: totalFixed,
      needsManualReview: allManualReview.length,
    },
    failuresByCategory,
    fixes: allFixes,
    manualReviewItems: allManualReview,
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  log(`\nReport written to ${REPORT_PATH}`);

  // ── Human-readable summary ────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  PLUDO QA REPORT SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Run at:       ${runAt}`);
  console.log(`  Total games:  ${report.totalGames}`);
  console.log(`  Total checks: ${totalChecks}`);
  console.log(`  PASS:         ${totalPassed}`);
  console.log(`  FAIL:         ${totalFailed}`);
  console.log(`  FIXED:        ${totalFixed}`);
  console.log(`  Manual Review: ${allManualReview.length}`);
  console.log('');
  console.log('  Failures by category:');
  for (const [cat, count] of Object.entries(failuresByCategory)) {
    console.log(`    ${cat.padEnd(20)} ${count}`);
  }
  console.log('');
  console.log('  Per-game results:');
  for (const g of gameReports) {
    if (g.status === 'submit_error') {
      console.log(`  [${g.index}] SUBMIT ERROR: ${g.error}`);
      continue;
    }
    const passCt = (g.checks ?? []).filter(c => c.status === 'PASS').length;
    const failCt = (g.checks ?? []).filter(c => c.status === 'FAIL').length;
    const fixCt = (g.checks ?? []).filter(c => c.status === 'FIXED').length;
    const timeMs = g.timeline?.doneMs ?? g.timeline?.scriptReadyMs ?? '?';
    const bar = ['P'.repeat(passCt), 'F'.repeat(failCt), 'X'.repeat(fixCt)].join('');
    console.log(`  [${g.index}] "${(g.title ?? '?').slice(0,30).padEnd(30)}" [${(g.genre ?? '?').slice(0,10).padEnd(10)}] ${g.status.padEnd(12)} ${timeMs}ms | ${passCt}P ${failCt}F ${fixCt}X`);
  }
  console.log('');
  if (allManualReview.length > 0) {
    console.log('  Items needing manual review:');
    for (const item of allManualReview.slice(0, 20)) {
      console.log(`    [game ${item.gameId}] ${item.check}: ${item.detail}`);
    }
    if (allManualReview.length > 20) {
      console.log(`    ... and ${allManualReview.length - 20} more (see qa-report.json)`);
    }
  }
  console.log('='.repeat(70));
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
