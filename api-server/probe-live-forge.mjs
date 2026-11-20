// Live forge verification.
// POSTs a themed prompt to /api/forge-game, polls the job status until done,
// then joins via WS and inspects the snapshot for the three new wire fields:
//   - world.scene.skyboxDescriptor
//   - entities[i].terrainLayers (with resolved Polyhaven URLs)
//   - entities[j].structureMaterial (with resolved Polyhaven URLs)
//
// Also prints the generated Lua script so we can see which new APIs Claude
// actually emitted.

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const HTTP = 'http://localhost:4000';
const WS_  = 'ws://localhost:4000/api/game-ws';
const PROMPT = process.env.PROMPT ||
  'snowy mountain platformer — slope-blended snow, ice, and rock terrain; stone block platforms; pale grey-blue night sky with stars';

async function main() {
  console.log(`Forging: "${PROMPT}"`);
  const t0 = Date.now();
  const r = await fetch(`${HTTP}/api/forge-game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, creatorName: 'LiveForgeProbe' }),
  });
  if (!r.ok) { console.error('forge-game request failed:', r.status, await r.text()); process.exit(1); }
  const { gameId, jobId } = await r.json();
  console.log(`gameId=${gameId} jobId=${jobId}`);

  // Poll. Phase 1 (Claude → script_ready) usually 60-180s; Phase 2 (Meshy) variable.
  let last = '';
  while (true) {
    const sr = await fetch(`${HTTP}/api/forge-game/status/${jobId}`);
    if (!sr.ok) { console.error('status failed', sr.status); break; }
    const s = await sr.json();
    const stamp = `${((Date.now() - t0)/1000).toFixed(0)}s`;
    const sig = `${stamp} ${s.status} assets=${s.assetsDone ?? '-'}/${s.assetsTotal ?? '-'}`;
    if (sig !== last) { console.log(sig); last = sig; }
    if (s.status === 'done')  break;
    if (s.status === 'error') { console.error('forge errored:', s.error ?? s); process.exit(1); }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Fetch the generated game (full data including gameCode)
  const gr = await fetch(`${HTTP}/api/game/${gameId}`);
  const game = await gr.json();
  const code = String(game.gameCode ?? game.game_code ?? '');
  console.log(`\nGenerated script: ${code.length} chars`);

  // Highlight the API calls we care about
  const apiHits = {
    SetCustomSkybox:  /Scene\.SetCustomSkybox/g,
    CreateTerrain:    /Structure\.CreateTerrain/g,
    PBR_SetMaterial:  /:SetMaterial\([^)]*,[^)]*,[^)]*\)/g,
  };
  for (const [name, re] of Object.entries(apiHits)) {
    const matches = code.match(re) ?? [];
    console.log(`  ${name}: ${matches.length} hit(s)`);
  }

  // Join via WS and capture snapshot
  console.log('\nJoining…');
  const ws = new WebSocket(`${WS_}?gameId=${gameId}`);
  await new Promise(r => ws.on('open', r));
  const snap = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('snapshot timeout')), 15000);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.type === 'snapshot') { clearTimeout(timeout); resolve(m); }
    });
    ws.send(JSON.stringify({ type: 'join', username: 'Verifier' }));
  });
  const w = snap.world;
  const sky = w.scene?.skyboxDescriptor;
  const terrains = w.entities.filter(e => Array.isArray(e.terrainLayers) && e.terrainLayers.length > 0);
  const structured = w.entities.filter(e => e.structureMaterial);

  console.log('\n── Snapshot ──');
  console.log(`entities=${w.entities.length}  player=${w.player.position.join(',')}`);
  if (sky) {
    console.log('skyboxDescriptor:');
    for (const k of ['topColor','horizonColor','groundColor','sunColor','starDensity','cloudDensity','timeOfDay','fogDensity']) {
      if (sky[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(sky[k])}`);
    }
  } else console.log('skyboxDescriptor: (absent)');

  console.log(`\nterrainLayers entities: ${terrains.length}`);
  for (const t of terrains) {
    console.log(`  type=${t.type} layers=${t.terrainLayers.length}`);
    for (const L of t.terrainLayers) {
      const url = L.albedoUrl ? L.albedoUrl.split('/').pop() : '(unresolved)';
      console.log(`    ${L.materialType.padEnd(6)} slope=[${L.slopeMin},${L.slopeMax}] tiling=${L.tiling} albedo=${url}`);
    }
  }

  console.log(`\nstructureMaterial entities: ${structured.length}`);
  for (const s of structured.slice(0, 5)) {
    const sm = s.structureMaterial;
    const url = sm.albedoUrl ? sm.albedoUrl.split('/').pop() : '(unresolved)';
    console.log(`  type=${s.type} materialType=${sm.materialType} tiling=${sm.tiling} rough=${sm.roughness} albedo=${url}`);
  }
  if (structured.length > 5) console.log(`  …and ${structured.length - 5} more`);

  writeFileSync('/Users/blakegibson/Pludo/api-server/probe-live-forge-report.json', JSON.stringify({
    gameId, prompt: PROMPT, duration_s: ((Date.now() - t0)/1000).toFixed(0),
    apiHits: Object.fromEntries(Object.entries(apiHits).map(([k, re]) => [k, (code.match(re) ?? []).length])),
    sky, terrains, structured: structured.slice(0, 10), script: code,
  }, null, 2));
  console.log('\nFull report → probe-live-forge-report.json');
  ws.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
