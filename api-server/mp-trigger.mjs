/**
 * Reproduces the real Unity pickup path in multiplayer: the client detects the
 * trigger overlap locally and reports {type:'trigger_enter', entityId}.
 * Alice joins first, Bob second. BOB walks onto the coin and reports it.
 * Question: whose score goes up?
 */
import WebSocket from 'ws';

const URL = 'ws://localhost:4000/api/game-ws?gameId=105&published=true';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COIN_TRIGGER = { x: -18, z: 10 };
const results = [];
const check = (n, p, d) => { results.push({ n, p, d }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

class Client {
  constructor(name) { this.name = name; this.seq = 0; this.events = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      const to = setTimeout(() => rej(new Error('timeout')), 45000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', username: this.name })));
      this.ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'joined') this.clientId = m.clientId;
        if (m.type === 'snapshot') {
          this.own = m.world.player;
          this.entities = m.world.entities;
          clearTimeout(to); res(this);
        }
        if (m.type === 'diff') {
          if (m.data.player) this.own = { ...this.own, ...m.data.player };
          for (const e of m.data.events ?? []) this.events.push(e);
        }
      });
      this.ws.on('error', e => { clearTimeout(to); rej(e); });
    });
  }
  input(f) { this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, ...f })); }
  async goto(x, z, tol = 1.0, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const p = this.own.position, dx = x - p[0], dz = z - p[2], d = Math.hypot(dx, dz);
      if (d < tol) break;
      this.input({ moveX: dx / d, moveZ: dz / d, groundY: 0 });
      await sleep(50);
    }
    this.input({ moveX: 0, moveZ: 0, groundY: 0 });
    await sleep(400);
  }
  reportTrigger(entityId) { this.ws.send(JSON.stringify({ type: 'trigger_enter', entityId })); }
  score() { return this.own?.score ?? null; }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log('\n=== Trigger-ownership probe (real Unity pickup path) ===\n');
  const alice = new Client('mptestalice'); await alice.connect();
  await sleep(600);
  const bob = new Client('mptestbob'); await bob.connect();
  await sleep(1200);

  const coin = alice.entities.find(e => e.hasTrigger && e.position[0] === COIN_TRIGGER.x && e.position[2] === COIN_TRIGGER.z);
  console.log(`coin trigger entity ${coin.id} at ${JSON.stringify(coin.position)}  visible=${coin.visible}\n`);

  console.log(`alice(first)=${alice.score()} bob(second)=${bob.score()}`);

  // Bob walks onto the pad and reports the overlap, exactly like the Unity client.
  console.log(`\n-- BOB (second joiner) walks onto the coin and reports trigger_enter --`);
  // Baseline BEFORE the walk: the server-side sweep now also sees these pads,
  // so the award can land during goto() rather than on the explicit report.
  // We measure the whole "walk on + client reports the overlap" sequence, which
  // is what the real Unity client does.
  const aBefore = alice.score(), bBefore = bob.score();
  alice.events.length = 0; bob.events.length = 0;
  await bob.goto(COIN_TRIGGER.x, COIN_TRIGGER.z);
  bob.reportTrigger(coin.id);
  await sleep(1500);

  console.log(`alice pos=${alice.own.position.map(v => v.toFixed(1))} score ${aBefore} → ${alice.score()}`);
  console.log(`bob   pos=${bob.own.position.map(v => v.toFixed(1))} score ${bBefore} → ${bob.score()}`);
  console.log(`alice events: ${JSON.stringify(alice.events.slice(0, 4))}`);
  console.log(`bob   events: ${JSON.stringify(bob.events.slice(0, 4))}`);

  check('the player who touched the coin gets the score', bob.score() > bBefore,
    `bob ${bBefore} → ${bob.score()}`);
  check('the OTHER player is not credited', alice.score() === aBefore,
    `alice ${aBefore} → ${alice.score()}`);
  // The server AABB sweep and the client's physics report both see this
  // crossing. They must collapse to a single award, not two.
  check('the coin is awarded exactly once (server sweep + client report deduped)',
    bob.score() === bBefore + 1, `bob ${bBefore} → ${bob.score()}`);
  // Personal feedback (score toast, HUD update, 2D collect ding) is addressed
  // to the collector. World-positioned FX (Effects.Spawn) stays shared — a
  // burst of particles at the coin's location is part of the scene both players
  // are standing in, so bystanders SHOULD see it.
  const personal = e => e.type === 'message' || e.type === 'title' || e.type === 'popup' ||
                        e.type === 'hud_update' || e.type === 'screen_shake' || e.type === 'flash' ||
                        (e.type === 'audio' && e.payload?.sound);
  check('pickup feedback goes to the collector',
    bob.events.some(personal) && !alice.events.some(personal),
    `bob ${bob.events.filter(personal).length} personal / ${bob.events.length} total, ` +
    `alice ${alice.events.filter(personal).length} personal / ${alice.events.length} total`);
  check('world FX stays shared',
    alice.events.some(e => e.type === 'effect'),
    `alice saw ${alice.events.filter(e => e.type === 'effect').length} world effect(s)`);

  alice.close(); bob.close();
  await sleep(300);
  const failed = results.filter(r => !r.p);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
