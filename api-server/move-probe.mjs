import WebSocket from 'ws';
const GAME_ID = process.argv[2] || '89';
const DIR = process.argv[3] || 'forward'; // forward, back, left, right, jump
const ws = new WebSocket(`ws://localhost:4000/api/game-ws?gameId=${GAME_ID}`);
let seq = 0;
let joined = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'join', username: 'MoveProbe' })));
ws.on('message', raw => {
  const m = JSON.parse(String(raw));
  if (m.type === 'joined') {
    joined = true;
    console.log('[probe] joined, sending inputs…');
    const tick = setInterval(() => {
      const base = { type:'input', seq:++seq, forward:false, back:false, left:false, right:false, jump:false, action:false, keys:{} };
      if (DIR === 'forward') Object.assign(base, { forward:true, moveX:0, moveZ:1 });
      else if (DIR === 'back') Object.assign(base, { back:true, moveX:0, moveZ:-1 });
      else if (DIR === 'left') Object.assign(base, { left:true, moveX:-1, moveZ:0 });
      else if (DIR === 'right') Object.assign(base, { right:true, moveX:1, moveZ:0 });
      else if (DIR === 'jump') Object.assign(base, { jump: seq <= 2 });
      ws.send(JSON.stringify(base));
    }, 50);
    setTimeout(() => { clearInterval(tick); ws.close(); }, parseInt(process.argv[4] || '2500', 10));
  }
});
ws.on('close', () => { console.log('[probe] closed'); process.exit(0); });
ws.on('error', e => { console.error('[probe] error', e.message); process.exit(1); });
