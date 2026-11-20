/**
 * Two-client multiplayer probe: Alice + Bob join the same published game,
 * move independently, and we assert each sees the other's avatar move correctly.
 *
 * Usage: node mp-test.mjs [gameId]
 */
import WebSocket from 'ws';

const GAME_ID = process.argv[2] || '105';
const PUBLISHED = process.env.PUBLISHED !== '0';
const URL = `ws://localhost:4000/api/game-ws?gameId=${GAME_ID}${PUBLISHED ? '&published=true' : ''}`;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d3 = v => v ? `[${v.map(n => n.toFixed(2)).join(', ')}]` : 'null';
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

class Client {
  constructor(name) {
    this.name = name;
    this.clientId = null;
    this.roomId = null;
    this.snapshot = null;
    this.own = null;          // latest own player state
    this.remotes = new Map(); // clientId -> latest remote wire
    this.events = [];         // presence / chat / lifecycle msgs
    this.diffCount = 0;
    this.remoteDiffCount = 0;
    this.seq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      const to = setTimeout(() => reject(new Error(`${this.name}: join timeout`)), 45000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'join', username: this.name })));
      this.ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'joined') { this.clientId = m.clientId; this.roomId = m.roomId; }
        else if (m.type === 'snapshot') {
          this.snapshot = m.world;
          this.own = m.world.player;
          for (const r of m.world.remotePlayers ?? []) this.remotes.set(r.clientId, r);
          clearTimeout(to); resolve(this);
        }
        else if (m.type === 'diff') {
          this.diffCount++;
          if (m.data.player) this.own = { ...this.own, ...m.data.player };
          if (m.data.remotePlayers) {
            this.remoteDiffCount++;
            for (const r of m.data.remotePlayers) this.remotes.set(r.clientId, r);
          }
        }
        else if (m.type === 'player_join' || m.type === 'player_leave' ||
                 m.type === 'presence' || m.type === 'chat' || m.type === 'error') {
          this.events.push(m);
          if (m.type === 'player_leave') this.remotes.delete(m.clientId);
        }
      });
      this.ws.on('error', e => { clearTimeout(to); reject(e); });
    });
  }

  input(fields) {
    this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, ...fields }));
  }

  // Hold a movement input for ms, sending at ~20 Hz like the real client.
  async hold(fields, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { this.input(fields); await sleep(50); }
    this.input({ moveX: 0, moveZ: 0 });  // stop
    await sleep(300);
  }

  pos() { return this.own?.position; }
  remoteOf(other) { return this.remotes.get(other.clientId); }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  console.log(`\n=== Multiplayer probe: game ${GAME_ID} (${PUBLISHED ? 'published' : 'draft'}) ===\n`);

  // ── 1. Alice joins ──────────────────────────────────────────────────────────
  const alice = new Client('mptestalice');
  const t0 = Date.now();
  await alice.connect();
  console.log(`alice joined in ${Date.now() - t0}ms  room=${alice.roomId?.slice(0, 8)} entities=${alice.snapshot.entities.length} spawn=${d3(alice.pos())}`);

  await sleep(500);

  // ── 2. Bob joins the same game ─────────────────────────────────────────────
  const bob = new Client('mptestbob');
  const t1 = Date.now();
  await bob.connect();
  console.log(`bob   joined in ${Date.now() - t1}ms  room=${bob.roomId?.slice(0, 8)} entities=${bob.snapshot.entities.length} spawn=${d3(bob.pos())}`);
  await sleep(800);

  check('both clients land in the SAME room', alice.roomId === bob.roomId,
    `alice=${alice.roomId?.slice(0, 8)} bob=${bob.roomId?.slice(0, 8)}`);

  check('alice received player_join for bob',
    alice.events.some(e => e.type === 'player_join' && e.clientId === bob.clientId),
    JSON.stringify(alice.events.filter(e => e.type === 'player_join').map(e => e.username)));

  check('bob received presence list containing alice',
    bob.events.some(e => e.type === 'presence' && e.players?.some(p => p.clientId === alice.clientId)),
    JSON.stringify(bob.events.find(e => e.type === 'presence')?.players?.map(p => p.username) ?? null));

  check('alice sees bob in remotePlayers', !!alice.remoteOf(bob), `remotes=${alice.remotes.size}`);
  check('bob sees alice in remotePlayers', !!bob.remoteOf(alice), `remotes=${bob.remotes.size}`);

  check('remote entry carries a username',
    alice.remoteOf(bob)?.username === 'mptestbob',
    `got ${JSON.stringify(alice.remoteOf(bob)?.username)}`);

  // Room registry view
  const rooms = await (await fetch(`http://localhost:4000/api/rooms/${GAME_ID}`)).json().catch(() => null);
  console.log('room registry:', JSON.stringify(rooms));

  // ── 3. Alice moves, Bob stands still ───────────────────────────────────────
  const aliceStart = [...alice.pos()], bobStart = [...bob.pos()];
  console.log(`\n-- alice moves +X for 2s (bob idle) --`);
  await alice.hold({ moveX: 1, moveZ: 0, groundY: 0 }, 2000);
  await sleep(400);

  const aliceOwn = alice.pos();
  const aliceViaBob = bob.remoteOf(alice)?.position;
  const aliceMoved = dist(aliceStart, aliceOwn);
  console.log(`alice own=${d3(aliceOwn)}  bob-sees-alice=${d3(aliceViaBob)}  moved=${aliceMoved.toFixed(2)}`);

  check('alice actually moved', aliceMoved > 1.0, `Δ=${aliceMoved.toFixed(2)} from ${d3(aliceStart)}`);
  check('bob sees alice at the same position she reports',
    aliceViaBob && dist(aliceOwn, aliceViaBob) < 0.75,
    `mismatch=${aliceViaBob ? dist(aliceOwn, aliceViaBob).toFixed(3) : 'no remote'}`);
  check('alice moving did NOT move bob (independent bodies)',
    dist(bobStart, bob.pos()) < 0.75,
    `bob drift=${dist(bobStart, bob.pos()).toFixed(3)}  bob=${d3(bob.pos())}`);
  check('alice does not see herself in her own remotePlayers',
    !alice.remotes.has(alice.clientId));

  // ── 4. Bob moves the other way, Alice idle ─────────────────────────────────
  const bobStart2 = [...bob.pos()], aliceStart2 = [...alice.pos()];
  console.log(`\n-- bob moves -Z for 2s (alice idle) --`);
  await bob.hold({ moveX: 0, moveZ: -1, groundY: 0 }, 2000);
  await sleep(400);

  const bobOwn = bob.pos();
  const bobViaAlice = alice.remoteOf(bob)?.position;
  const bobMoved = dist(bobStart2, bobOwn);
  console.log(`bob own=${d3(bobOwn)}  alice-sees-bob=${d3(bobViaAlice)}  moved=${bobMoved.toFixed(2)}`);

  check('bob actually moved', bobMoved > 1.0, `Δ=${bobMoved.toFixed(2)}`);
  check('alice sees bob at the same position he reports',
    bobViaAlice && dist(bobOwn, bobViaAlice) < 0.75,
    `mismatch=${bobViaAlice ? dist(bobOwn, bobViaAlice).toFixed(3) : 'no remote'}`);
  check('bob moving did NOT move alice',
    dist(aliceStart2, alice.pos()) < 0.75,
    `alice drift=${dist(aliceStart2, alice.pos()).toFixed(3)}`);
  check('the two avatars are at DIFFERENT positions',
    dist(alice.pos(), bob.pos()) > 1.0,
    `separation=${dist(alice.pos(), bob.pos()).toFixed(2)}`);

  // ── 5. Simultaneous opposite movement ──────────────────────────────────────
  console.log(`\n-- both move simultaneously in opposite directions (2s) --`);
  const aPre = [...alice.pos()], bPre = [...bob.pos()];
  await Promise.all([
    alice.hold({ moveX: -1, moveZ: 0, groundY: 0 }, 2000),
    bob.hold({ moveX: 1, moveZ: 0, groundY: 0 }, 2000),
  ]);
  await sleep(500);
  const aDelta = alice.pos()[0] - aPre[0];
  const bDelta = bob.pos()[0] - bPre[0];
  console.log(`alice ΔX=${aDelta.toFixed(2)} bob ΔX=${bDelta.toFixed(2)}`);
  check('simultaneous inputs move each avatar its own way',
    aDelta < -0.9 && bDelta > 0.9, `aliceΔX=${aDelta.toFixed(2)} bobΔX=${bDelta.toFixed(2)}`);
  check('cross-view stays in sync after simultaneous movement',
    dist(alice.pos(), bob.remoteOf(alice).position) < 0.75 &&
    dist(bob.pos(), alice.remoteOf(bob).position) < 0.75,
    `a→b=${dist(alice.pos(), bob.remoteOf(alice).position).toFixed(3)} b→a=${dist(bob.pos(), alice.remoteOf(bob).position).toFixed(3)}`);

  // ── 6. Jump ────────────────────────────────────────────────────────────────
  console.log(`\n-- alice jumps --`);
  const yBefore = alice.pos()[1];
  let peakOwn = yBefore, peakRemote = bob.remoteOf(alice).position[1];
  alice.input({ jump: true, groundY: 0 });
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    peakOwn = Math.max(peakOwn, alice.pos()[1]);
    peakRemote = Math.max(peakRemote, bob.remoteOf(alice)?.position[1] ?? -99);
  }
  console.log(`alice y ${yBefore.toFixed(2)} → peak ${peakOwn.toFixed(2)}; bob saw peak ${peakRemote.toFixed(2)}`);
  check('jump raises alice', peakOwn - yBefore > 0.4, `Δy=${(peakOwn - yBefore).toFixed(2)}`);
  check('bob sees alice jump', peakRemote - yBefore > 0.4, `Δy=${(peakRemote - yBefore).toFixed(2)}`);
  check('grounded flag is transmitted for remotes',
    typeof bob.remoteOf(alice)?.grounded === 'boolean');

  // ── 7. Chat ────────────────────────────────────────────────────────────────
  console.log(`\n-- chat --`);
  alice.ws.send(JSON.stringify({ type: 'chat', text: 'hey bob, testing multiplayer' }));
  await sleep(1200);
  const bobChat = bob.events.filter(e => e.type === 'chat');
  check('bob receives alice chat message', bobChat.length > 0, JSON.stringify(bobChat.slice(-1)));

  // ── 8. Disconnect ──────────────────────────────────────────────────────────
  console.log(`\n-- alice disconnects --`);
  alice.close();
  await sleep(1500);
  check('bob receives player_leave for alice',
    bob.events.some(e => e.type === 'player_leave' && e.clientId === alice.clientId));
  check('bob no longer sees alice in remotePlayers', !bob.remotes.has(alice.clientId),
    `remotes=${bob.remotes.size}`);

  // ── 9. Rejoin — does the returning player spawn correctly? ─────────────────
  console.log(`\n-- alice rejoins --`);
  const alice2 = new Client('mptestalice');
  await alice2.connect();
  await sleep(1000);
  console.log(`alice2 spawn=${d3(alice2.pos())} room=${alice2.roomId?.slice(0, 8)}`);
  check('rejoining client lands in the same live room', alice2.roomId === bob.roomId);
  check('rejoining client sees the still-present bob', !!alice2.remoteOf(bob),
    `remotes=${alice2.remotes.size}`);
  check('bob sees the rejoined alice', !!bob.remoteOf(alice2), `remotes=${bob.remotes.size}`);

  console.log(`\ndiffs: alice=${alice.diffCount} (w/ remotes ${alice.remoteDiffCount}) bob=${bob.diffCount} (w/ remotes ${bob.remoteDiffCount})`);

  alice2.close(); bob.close();
  await sleep(300);

  const failed = results.filter(r => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log('FAILURES:\n' + failed.map(f => `  - ${f.name} (${f.detail ?? ''})`).join('\n'));
  process.exit(0);
})().catch(e => { console.error('PROBE CRASHED:', e); process.exit(1); });
