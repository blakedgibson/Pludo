// Smoke test: cold-join a public room for game 106, wait for the initial
// snapshot, and report the position of an entity named "Skier" (which we set
// to [7,2,7] earlier in the conversation via PATCH /editor-state + publish).
// Pre-overlay, the Lua script for "Frostpeak Ascent" places this entity at
// its script-defined coords; with overlay applied the snapshot should report
// [7,2,7].
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:4000/api/game-ws?gameId=106&published=true');
const target = 'Skier';
let timer = setTimeout(() => { console.log('TIMEOUT — no snapshot received'); ws.close(); process.exit(2); }, 30000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'join', username: 'OverlayProbe' }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.type === 'joined') {
    console.log('joined room', msg.roomId);
  }
  if (msg.type === 'snapshot' || msg.type === 'state') {
    const entities = msg.world?.entities ?? msg.entities ?? [];
    const list = Array.isArray(entities) ? entities : Object.values(entities);
    const names = list.filter(e => e?.name).map(e => `${e.name} @ ${JSON.stringify(e.position)}`);
    console.log(`snapshot: ${list.length} entities, ${names.length} with explicit name`);
    const hit = list.find(e => e?.name === target || e?.type === target);
    if (hit) {
      console.log(`FOUND ${target}: name=${hit.name} type=${hit.type} position=${JSON.stringify(hit.position)} scale=${JSON.stringify(hit.scale)}`);
    } else {
      console.log(`no entity matching "${target}". First 12 (name | type @ pos):`);
      list.slice(0, 12).forEach(e => console.log(`  ${e?.name ?? '-'} | ${e?.type ?? '-'} @ ${JSON.stringify(e?.position)}`));
    }
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(3); });
