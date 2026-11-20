// Re-join an already-forged game and inspect its snapshot. Use this to verify
// fixes (slug map, texture cap) against the existing game 106 without paying
// Claude credits to forge a new one.
import WebSocket from 'ws';
const GAME_ID = process.argv[2] || '106';
const ws = new WebSocket(`ws://localhost:4000/api/game-ws?gameId=${GAME_ID}`);
const t0 = Date.now();
await new Promise(r => ws.on('open', r));
const snap = await new Promise((resolve, reject) => {
  const tm = setTimeout(() => reject(new Error('timeout')), 20000);
  ws.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.type === 'snapshot') { clearTimeout(tm); resolve(m); }
  });
  ws.send(JSON.stringify({ type: 'join', username: 'Rejoiner' }));
});
const w = snap.world;
const sky = w.scene?.skyboxDescriptor;
const terrains = w.entities.filter(e => Array.isArray(e.terrainLayers) && e.terrainLayers.length > 0);
const structured = w.entities.filter(e => e.structureMaterial);

console.log(`Join took ${Date.now() - t0}ms. entities=${w.entities.length}`);
console.log(`skybox.starDensity=${sky?.starDensity} cloudDensity=${sky?.cloudDensity} timeOfDay=${sky?.timeOfDay}`);

console.log(`\nterrainLayers entities: ${terrains.length}`);
for (const t of terrains) {
  console.log(`  type=${t.type} layers=${t.terrainLayers.length}`);
  for (const L of t.terrainLayers) {
    const file = L.albedoUrl ? L.albedoUrl.split('/').pop() : '(UNRESOLVED)';
    console.log(`    ${L.materialType.padEnd(6)} albedo=${file}`);
  }
}
console.log(`\nstructureMaterial entities: ${structured.length}`);
const byMt = {};
for (const s of structured) byMt[s.structureMaterial.materialType] = (byMt[s.structureMaterial.materialType] ?? 0) + 1;
for (const [mt, n] of Object.entries(byMt)) {
  const example = structured.find(s => s.structureMaterial.materialType === mt);
  const file = example.structureMaterial.albedoUrl ? example.structureMaterial.albedoUrl.split('/').pop() : '(UNRESOLVED)';
  console.log(`  ${mt}: x${n}  albedo=${file}`);
}

const unresolved = [
  ...terrains.flatMap(t => t.terrainLayers.filter(L => !L.albedoUrl)),
  ...structured.filter(s => !s.structureMaterial.albedoUrl),
];
console.log(`\nunresolved: ${unresolved.length}`);

ws.close();
