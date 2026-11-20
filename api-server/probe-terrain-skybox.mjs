// Manually inject a minimal Lua script via /api/edit-game (cheapest path),
// then connect a WS client and inspect the cold-join snapshot to confirm
// the new fields land where we expect:
//   - world.scene.skyboxDescriptor with all new keys
//   - one entity with terrainLayers[] each having albedoUrl/normalUrl/roughnessUrl
//   - one entity with structureMaterial including the same three URL fields
//
// We side-step Claude entirely by patching the Supabase row's gameCode column
// via the api-server's hot-reload endpoint.
//
// Run: node probe-terrain-skybox.mjs

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const BASE_URL = 'ws://localhost:4000/api/game-ws';
const HTTP_URL = 'http://localhost:4000';
const GAME_ID  = process.env.GAME_ID || '89';

const TEST_SCRIPT = `
Game.OnStart(function()
  Scene.SetCustomSkybox({
    topColor    = {0.05, 0.10, 0.30},
    horizonColor= {0.20, 0.30, 0.55},
    bottomColor = {0.10, 0.15, 0.40},
    groundColor = {0.04, 0.06, 0.10},
    sunColor    = {0.85, 0.90, 1.00},
    sunDirection= {30, 60, 0},
    sunSize     = 0.03,
    sunIntensity= 1.0,
    exposure    = 1.1,
    fogColor    = {0.10, 0.15, 0.30},
    fogDensity  = 0.006,
    ambientColor= {0.30, 0.35, 0.55},
    ambientIntensity = 0.7,
    starDensity = 0.9,
    cloudDensity= 0.0,
    timeOfDay   = "night",
  })

  local terrain = Structure.CreateTerrain(0, 0, 0, 100, 100, {
    { materialType = "grass", slopeMin = 0.0,  slopeMax = 0.35, tiling = 8.0 },
    { materialType = "dirt",  slopeMin = 0.25, slopeMax = 0.65, tiling = 6.0 },
    { materialType = "rock",  slopeMin = 0.55, slopeMax = 1.0,  tiling = 5.0 },
  })

  local wall = Structure.CreateWall(0, 1, 10, 20, 4)
  wall:SetMaterial("stone", 4.0, 0.75)

  Player.SetSpawnPoint(0, 1, 0)
end)
`;

async function main() {
  // 1) Hot-reload the test script into game 89's room (rebuilds Lua, fires OnStart,
  //    re-broadcasts state — same path the /api/edit-game endpoint uses internally).
  console.log('Hot-reloading test script into game ' + GAME_ID);
  const r = await fetch(`${HTTP_URL}/api/edit-game/raw-replace?gameId=${GAME_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameCode: TEST_SCRIPT }),
  });
  if (!r.ok) {
    console.error(`raw-replace failed: ${r.status}`);
    // Fallback: tell the user how to inject manually
    console.error('No raw-replace endpoint — falling back to plain WS join probe');
  }

  // 2) Connect a fresh client; capture the first snapshot.
  const ws = new WebSocket(`${BASE_URL}?gameId=${GAME_ID}`);
  await new Promise(res => ws.on('open', res));

  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.type === 'snapshot') { clearTimeout(timer); resolve(m); }
    });
    ws.send(JSON.stringify({ type: 'join', username: 'TerrainProbe' }));
  });

  const world = snapshot.world;
  const sky   = world.scene?.skyboxDescriptor;
  const terrains   = world.entities.filter(e => Array.isArray(e.terrainLayers) && e.terrainLayers.length > 0);
  const structured = world.entities.filter(e => e.structureMaterial);

  console.log('\n── Snapshot inspection ──');
  console.log('scene.skyboxDescriptor:');
  if (sky) {
    for (const k of ['topColor','horizonColor','bottomColor','groundColor','sunColor','starDensity','cloudDensity','timeOfDay','fogDensity']) {
      console.log(`  ${k}: ${JSON.stringify(sky[k])}`);
    }
  } else console.log('  (absent)');

  console.log(`\nTerrain entities with terrainLayers: ${terrains.length}`);
  for (const t of terrains) {
    console.log(`  id=${t.id.slice(0,8)} type=${t.type} layers=${t.terrainLayers.length}`);
    for (const L of t.terrainLayers) {
      console.log(`    ${L.materialType.padEnd(6)} slope=[${L.slopeMin},${L.slopeMax}] tiling=${L.tiling} albedo=${L.albedoUrl ?? '(unresolved)'}`);
    }
  }

  console.log(`\nStructure entities with structureMaterial: ${structured.length}`);
  for (const s of structured) {
    const sm = s.structureMaterial;
    console.log(`  id=${s.id.slice(0,8)} type=${s.type} materialType=${sm.materialType} tiling=${sm.tiling} roughness=${sm.roughness} albedo=${sm.albedoUrl ?? '(unresolved)'}`);
  }

  writeFileSync('/Users/blakegibson/Pludo/api-server/probe-terrain-skybox-report.json', JSON.stringify({
    skyboxDescriptor: sky,
    terrainEntities:  terrains,
    structureEntities: structured,
  }, null, 2));
  console.log('\nFull report → probe-terrain-skybox-report.json');

  ws.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
