/**
 * "Play a game together" probe on game 105 (Sunny Meadow Coins).
 * Alice joins first (server-side primary), Bob second. Each walks onto the
 * same coin pad; we watch score, HUD events and coin visibility per client.
 */
import WebSocket from 'ws';

const URL = 'ws://localhost:4000/api/game-ws?gameId=105&published=true';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

class Client {
  constructor(name) { this.name = name; this.seq = 0; this.events = []; this.remotes = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      const to = setTimeout(() => rej(new Error('timeout')), 45000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', username: this.name })));
      this.ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'joined') this.clientId = m.clientId;
        if (m.type === 'snapshot') { this.own = m.world.player; clearTimeout(to); res(this); }
        if (m.type === 'diff') {
          if (m.data.player) this.own = { ...this.own, ...m.data.player };
          for (const e of m.data.events ?? []) this.events.push(e);
          for (const r of m.data.remotePlayers ?? []) this.remotes.set(r.clientId, r);
        }
      });
      this.ws.on('error', e => { clearTimeout(to); rej(e); });
    });
  }
  input(f) { this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, ...f })); }
  // Walk toward (x,z) with closed-loop steering until within `tol` or timeout.
  async goto(x, z, tol = 1.0, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const p = this.own.position;
      const dx = x - p[0], dz = z - p[2];
      const d = Math.hypot(dx, dz);
      if (d < tol) break;
      this.input({ moveX: dx / d, moveZ: dz / d, groundY: 0 });
      await sleep(50);
    }
    this.input({ moveX: 0, moveZ: 0, groundY: 0 });
    await sleep(400);
    const p = this.own.position;
    return Math.hypot(x - p[0], z - p[2]);
  }
  score() { return this.own?.score ?? null; }
  close() { try { this.ws.close(); } catch {} }
}

const COIN = { x: -18, z: 10 };      // first coin spot in the script
const COIN2 = { x: 20, z: 15 };      // second coin spot

(async () => {
  console.log('\n=== Gameplay-together probe: Sunny Meadow Coins (game 105) ===\n');

  const alice = new Client('mptestalice'); await alice.connect();   // joins FIRST
  await sleep(600);
  const bob = new Client('mptestbob');     await bob.connect();     // joins SECOND
  await sleep(1200);
  console.log(`alice score=${alice.score()} bob score=${bob.score()}`);

  // ── Alice (first joiner) collects a coin ──────────────────────────────────
  console.log(`\n-- alice walks to coin pad (${COIN.x}, ${COIN.z}) --`);
  alice.events.length = 0; bob.events.length = 0;
  const aErr = await alice.goto(COIN.x, COIN.z);
  await sleep(1200);
  console.log(`alice at ${alice.own.position.map(v => v.toFixed(1))} (${aErr.toFixed(2)} from pad)`);
  console.log(`alice score=${alice.score()} bob score=${bob.score()}`);
  console.log(`alice events: ${JSON.stringify(alice.events.slice(0, 6))}`);
  console.log(`bob   events: ${JSON.stringify(bob.events.slice(0, 6))}`);

  const aliceScored = alice.score() > 0;
  check('first-joiner collecting a coin scores', aliceScored, `score=${alice.score()}`);
  check('first-joiner sees the pickup feedback (HUD/message event)',
    alice.events.some(e => e.type === 'message' || e.type === 'hud'), `${alice.events.length} events`);
  const bobScoreAfterAlice = bob.score();

  // ── Bob (second joiner) collects a DIFFERENT coin ─────────────────────────
  console.log(`\n-- bob walks to coin pad (${COIN2.x}, ${COIN2.z}) --`);
  alice.events.length = 0; bob.events.length = 0;
  const aliceScoreBefore = alice.score();
  const bErr = await bob.goto(COIN2.x, COIN2.z);
  await sleep(1500);
  console.log(`bob at ${bob.own.position.map(v => v.toFixed(1))} (${bErr.toFixed(2)} from pad)`);
  console.log(`alice score=${alice.score()} bob score=${bob.score()}`);
  console.log(`alice events: ${JSON.stringify(alice.events.slice(0, 6))}`);
  console.log(`bob   events: ${JSON.stringify(bob.events.slice(0, 6))}`);

  check('second-joiner collecting a coin scores for THEMSELVES',
    bob.score() > bobScoreAfterAlice, `bob score ${bobScoreAfterAlice} → ${bob.score()}`);
  check("second-joiner's pickup does not credit the first joiner",
    alice.score() === aliceScoreBefore, `alice score ${aliceScoreBefore} → ${alice.score()}`);
  check('second-joiner receives pickup feedback',
    bob.events.some(e => e.type === 'message' || e.type === 'hud'), `${bob.events.length} events`);

  // ── Does one player's pickup remove the coin for the other? ───────────────
  console.log(`\n-- alice walks to the SAME pad bob just used (${COIN2.x}, ${COIN2.z}) --`);
  alice.events.length = 0;
  const aScoreBefore2 = alice.score();
  await alice.goto(COIN2.x + 2, COIN2.z + 2);
  await sleep(1500);
  console.log(`alice score ${aScoreBefore2} → ${alice.score()}; events ${JSON.stringify(alice.events.slice(0, 4))}`);

  console.log(`\nfinal: alice=${alice.score()} bob=${bob.score()}`);
  alice.close(); bob.close();
  await sleep(300);
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILURES:\n' + failed.map(f => `  - ${f.name} (${f.detail ?? ''})`).join('\n'));
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
