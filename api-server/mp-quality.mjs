/**
 * Movement-quality probe: measures how faithfully one client's avatar is
 * reproduced on the other client — update rate, positional lag, velocity
 * (used for facing), idle jitter — plus a 3-player fan-out check.
 */
import WebSocket from 'ws';

const GAME_ID = process.argv[2] || '105';
const URL = `ws://localhost:4000/api/game-ws?gameId=${GAME_ID}&published=true`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

class Client {
  constructor(name) {
    this.name = name; this.remotes = new Map(); this.own = null; this.seq = 0;
    this.ownSamples = []; this.remoteSamples = new Map(); // clientId -> [{t,pos,vel}]
  }
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
          const now = Date.now();
          if (m.data.player) { this.own = { ...this.own, ...m.data.player }; this.ownSamples.push({ t: now, pos: [...m.data.player.position] }); }
          for (const r of m.data.remotePlayers ?? []) {
            this.remotes.set(r.clientId, r);
            if (!this.remoteSamples.has(r.clientId)) this.remoteSamples.set(r.clientId, []);
            this.remoteSamples.get(r.clientId).push({ t: now, pos: [...r.position], vel: [...r.velocity], grounded: r.grounded });
          }
        }
      });
      this.ws.on('error', e => { clearTimeout(to); rej(e); });
    });
  }
  input(f) { this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, ...f })); }
  async hold(f, ms) { const end = Date.now() + ms; while (Date.now() < end) { this.input(f); await sleep(50); } this.input({ moveX: 0, moveZ: 0 }); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log(`\n=== Movement-quality probe: game ${GAME_ID} ===\n`);
  const a = new Client('mptestalice'); await a.connect();
  const b = new Client('mptestbob');   await b.connect();
  await sleep(1200);

  // ── Continuous motion: how well does B track A? ───────────────────────────
  a.ownSamples.length = 0; b.remoteSamples.clear();
  const t0 = Date.now();
  await a.hold({ moveX: 1, moveZ: 0.4, groundY: 0 }, 4000);
  const span = (Date.now() - t0) / 1000;
  await sleep(400);

  const bSeesA = b.remoteSamples.get(a.clientId) ?? [];
  const rateOwn = a.ownSamples.length / span;
  const rateRemote = bSeesA.length / span;
  console.log(`A own-state updates: ${a.ownSamples.length} (${rateOwn.toFixed(1)} Hz)`);
  console.log(`B remote-of-A updates: ${bSeesA.length} (${rateRemote.toFixed(1)} Hz)`);
  check('remote stream runs at a smooth rate (>=15 Hz)', rateRemote >= 15, `${rateRemote.toFixed(1)} Hz`);
  check('remote stream matches own-state rate (no downsampling)',
    Math.abs(rateRemote - rateOwn) < 3, `own ${rateOwn.toFixed(1)} vs remote ${rateRemote.toFixed(1)} Hz`);

  // Positional fidelity: pair each remote sample with A's own sample nearest in time.
  let maxErr = 0, sumErr = 0, n = 0;
  for (const rs of bSeesA) {
    let best = null, bestDt = 1e9;
    for (const os of a.ownSamples) { const dt = Math.abs(os.t - rs.t); if (dt < bestDt) { bestDt = dt; best = os; } }
    if (best && bestDt < 60) { const e = dist(best.pos, rs.pos); maxErr = Math.max(maxErr, e); sumErr += e; n++; }
  }
  console.log(`position error vs A's own state: max=${maxErr.toFixed(3)} avg=${(sumErr / Math.max(n, 1)).toFixed(3)} over ${n} paired samples`);
  check('remote positions are exact (no drift/rubber-banding)', maxErr < 0.05, `max err ${maxErr.toFixed(3)}`);

  // Facing: velocity must be non-zero and point along the travel direction.
  const moving = bSeesA.filter(s => Math.hypot(s.vel[0], s.vel[2]) > 0.5);
  const sample = moving[Math.floor(moving.length / 2)];
  const velAngle = sample ? Math.atan2(sample.vel[0], sample.vel[2]) * 180 / Math.PI : null;
  const wantAngle = Math.atan2(1, 0.4) * 180 / Math.PI;
  console.log(`velocity samples while moving: ${moving.length}/${bSeesA.length}; heading=${velAngle?.toFixed(1)}° expected≈${wantAngle.toFixed(1)}°`);
  check('velocity is streamed for remotes (drives facing + run/walk anim)',
    moving.length > bSeesA.length * 0.5, `${moving.length}/${bSeesA.length} samples had velocity`);
  check('remote velocity points along the travel direction',
    velAngle != null && Math.abs(velAngle - wantAngle) < 15, `${velAngle?.toFixed(1)}° vs ${wantAngle.toFixed(1)}°`);

  // ── Idle jitter ───────────────────────────────────────────────────────────
  await sleep(600);
  b.remoteSamples.clear();
  await sleep(2500);
  const idle = b.remoteSamples.get(a.clientId) ?? [];
  let jitter = 0;
  for (let i = 1; i < idle.length; i++) jitter = Math.max(jitter, dist(idle[i - 1].pos, idle[i].pos));
  console.log(`idle: ${idle.length} samples, max frame-to-frame movement ${jitter.toFixed(4)}`);
  check('an idle remote avatar does not jitter', jitter < 0.02, `max delta ${jitter.toFixed(4)}`);
  check('idle remotes keep streaming (avatar stays spawned)', idle.length > 10, `${idle.length} samples`);

  // ── Third player fan-out ──────────────────────────────────────────────────
  const c = new Client('mptestcarol'); await c.connect();
  await sleep(1500);
  check('3rd player: A sees both B and C', a.remotes.size === 2, `A remotes=${a.remotes.size}`);
  check('3rd player: B sees both A and C', b.remotes.size === 2, `B remotes=${b.remotes.size}`);
  check('3rd player: C sees both A and B', c.remotes.size === 2, `C remotes=${c.remotes.size}`);

  await c.hold({ moveX: 0, moveZ: 1, groundY: 0 }, 1500);
  await sleep(500);
  const cPos = c.own.position;
  check('C movement visible to A', dist(cPos, a.remotes.get(c.clientId).position) < 0.5,
    `err=${dist(cPos, a.remotes.get(c.clientId).position).toFixed(3)}`);
  check('C movement visible to B', dist(cPos, b.remotes.get(c.clientId).position) < 0.5,
    `err=${dist(cPos, b.remotes.get(c.clientId).position).toFixed(3)}`);
  check('A and B remain at their own distinct positions',
    dist(a.own.position, b.own.position) > 0.5 && dist(a.own.position, cPos) > 0.5,
    `A=${a.own.position.map(v=>v.toFixed(1))} B=${b.own.position.map(v=>v.toFixed(1))} C=${cPos.map(v=>v.toFixed(1))}`);

  // ── Score/health isolation (per-player game state) ─────────────────────────
  console.log(`\nper-player state: A score=${a.own.score} health=${a.own.health} | B score=${b.own.score} | C score=${c.own.score}`);

  a.close(); b.close(); c.close();
  await sleep(300);
  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILURES:\n' + failed.map(f => `  - ${f.name} (${f.detail ?? ''})`).join('\n'));
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
