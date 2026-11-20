/**
 * Per-client toolbar probe (mobile action button). Two players join; Bob taps a toolbar slot.
 * Asserts (a) Bob's own equipped slot updates, (b) Alice's does NOT change,
 * (c) the tap's configured key actually reaches the Lua key handler (the
 * pulse used to be overwritten by the next per-frame input packet).
 */
import WebSocket from 'ws';
const GAME_ID = process.argv[2] || '105';
const URL = `ws://localhost:4000/api/game-ws?gameId=${GAME_ID}&published=true`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

class C {
  constructor(n) { this.name = n; this.seq = 0; this.toolbar = null; this.events = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      const to = setTimeout(() => rej(new Error('timeout')), 60000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', username: this.name })));
      this.ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'snapshot') { this.toolbar = m.world.toolbar; this.own = m.world.player; clearTimeout(to); res(this); }
        if (m.type === 'diff') {
          if (m.data.toolbar) this.toolbar = m.data.toolbar;
          if (m.data.player) this.own = { ...this.own, ...m.data.player };
          for (const e of m.data.events ?? []) this.events.push(e);
        }
      });
      this.ws.on('error', e => { clearTimeout(to); rej(e); });
    });
  }
  // The real client sends an input packet every frame; this is what used to
  // stomp the equipTool key pulse before the next 50 ms server tick.
  spamInput() { this.spam = setInterval(() => this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, moveX: 0, moveZ: 0, groundY: 0, keys: {} })), 16); }
  stop() { clearInterval(this.spam); }
  async goto(x, z, tol = 1.2, timeoutMs = 25000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const p = this.own.position, dx = x - p[0], dz = z - p[2], d = Math.hypot(dx, dz);
      if (d < tol) break;
      this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, moveX: dx / d, moveZ: dz / d, groundY: 0, keys: {} }));
      await sleep(50);
    }
    this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, moveX: 0, moveZ: 0, groundY: 0, keys: {} }));
    await sleep(400);
  }
  equip(name, key) { this.ws.send(JSON.stringify({ type: 'equipTool', name, key })); }
  close() { this.stop(); try { this.ws.close(); } catch {} }
}

(async () => {
  console.log(`\n=== Per-client toolbar probe (game ${GAME_ID}) ===\n`);
  const alice = new C('tbalice'); await alice.connect(); await sleep(500);
  const bob   = new C('tbbob');   await bob.connect();   await sleep(1000);
  console.log(`toolbar: ${JSON.stringify(alice.toolbar)}`);
  const tools = alice.toolbar?.tools ?? [];
  if (tools.length < 1) {
    console.log(`\nGame ${GAME_ID} registers no toolbar slots. Skipping.`);
    alice.close(); bob.close(); process.exit(2);
  }
  // Walk Bob next to the lantern so the "e" handler has something to do.
  await bob.goto(8.0, -4.0);
  console.log(`bob at ${bob.own.position.map(v => v.toFixed(1))} (lantern at 8.0,1.0,-4.0)`);
  alice.spamInput(); bob.spamInput();
  await sleep(600);
  const target = tools[tools.length - 1];
  const aliceBefore = alice.toolbar.equipped;
  console.log(`\n-- bob taps "${target.name}" (key "${target.key}") while both clients stream input every 16ms --`);
  alice.events.length = 0; bob.events.length = 0;
  bob.equip(target.name, target.key);
  await sleep(1500);
  console.log(`bob   events after tap: ${JSON.stringify(bob.events.slice(0, 3))}`);
  console.log(`alice events after tap: ${JSON.stringify(alice.events.slice(0, 3))}`);
  check('the tapping player’s slot is equipped', bob.toolbar.equipped === target.name,
    `bob equipped="${bob.toolbar.equipped}"`);
  check('the OTHER player’s toolbar is unchanged', alice.toolbar.equipped === aliceBefore,
    `alice equipped="${alice.toolbar.equipped}" (was "${aliceBefore}")`);
  check('the tap’s key reaches the Lua handler (pulse survives per-frame input)',
    bob.events.length > 0, `${bob.events.length} event(s) fired by the tap`);
  // Personal feedback (the collect ding, score toasts) is addressed to the
  // tapper. World-positioned Effects.Spawn at the lantern stays shared — the
  // bell rings in a world both players are standing in.
  const personal = e => e.type === 'message' || e.type === 'title' || e.type === 'popup' ||
                        e.type === 'hud_update' || e.type === 'screen_shake' || e.type === 'flash' ||
                        (e.type === 'audio' && e.payload?.sound);
  check('the tap’s personal feedback does not leak to the other player',
    !alice.events.some(personal),
    `alice got ${alice.events.filter(personal).length} personal / ${alice.events.length} total`);
  alice.close(); bob.close(); await sleep(300);
  const failed = results.filter(r => !r.p).length;
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
