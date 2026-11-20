/**
 * Join a real game 3 times in sequence, exercise gameplay each session,
 * and report any issues. Output: probe-3joins-report.json
 */
import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const BASE_URL = 'ws://localhost:4000/api/game-ws';
const GAME_ID  = process.env.GAME_ID || '89';
const ISSUES   = [];
const SESSIONS = [];

function issue(severity, code, detail, ctx = {}) {
  ISSUES.push({ severity, code, detail, ctx, ts: new Date().toISOString() });
  const tag = severity === 'error' ? '[ERR]' : severity === 'warn' ? '[WRN]' : '[INFO]';
  console.log(`${tag} ${code}: ${detail}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectAndJoin(username, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_URL}?gameId=${GAME_ID}`);
    const t0 = Date.now();
    const recv = [];
    let joined = null;
    let snapshot = null;
    let settled = false;

    const settleIfReady = () => {
      if (joined && snapshot && !settled) {
        settled = true;
        resolve({ ws, joined, snapshot, joinMs: Date.now() - t0, recv });
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        issue('error', 'join_timeout', `${label}: timed out after 20s`, { joined: !!joined, snapshot: !!snapshot });
        try { ws.terminate(); } catch {}
        reject(new Error('join timeout'));
      }
    }, 20000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', username })));

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch {
        issue('warn', 'non_json_frame', `${label}: server sent non-JSON frame`, { raw: String(raw).slice(0, 80) });
        return;
      }
      recv.push({ t: Date.now() - t0, msg });
      if (msg.type === 'joined')   joined = msg;
      if (msg.type === 'snapshot') snapshot = msg;
      if (msg.type === 'error')    issue('error', 'server_error_msg', `${label}: ${msg.message}`);
      settleIfReady();
      if (settled) {
        // Once joined, only fire timer cleanup once
        clearTimeout(timer);
      }
    });

    ws.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

// Convert recv array to structured stats
function summarizeRecv(recv) {
  const byType = {};
  for (const { msg } of recv) byType[msg.type] = (byType[msg.type] ?? 0) + 1;
  return byType;
}

// Capture position changes during a movement burst
function trackPositionFromDiffs(ws, durationMs, label) {
  return new Promise(resolve => {
    const positions = [];
    let lastY = null, lastX = null, lastZ = null;
    let voidFalls = 0, jumpsApex = 0, lastVy = 0;
    const handler = raw => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === 'diff' && m.data?.player) {
          const p = m.data.player;
          if (Array.isArray(p.position)) {
            positions.push({ t: Date.now(), pos: p.position, grounded: p.grounded });
            const [x, y, z] = p.position;
            if (lastY !== null && y < -2) voidFalls++;
            if (lastY !== null && y > lastY && lastY < 1.5 && y >= 1.5) jumpsApex++;
            lastX = x; lastY = y; lastZ = z;
          }
        }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve({ positions, voidFalls, lastPos: lastX !== null ? [lastX, lastY, lastZ] : null });
    }, durationMs);
  });
}

async function exerciseSession(ws, label, snapshot) {
  console.log(`  → ${label}: exercising gameplay`);
  const issues = [];

  // 1) Send input bursts: forward/back/left/right/jump
  const seqStart = Date.now();
  let seq = 0;
  const sendInput = (patch) => {
    ws.send(JSON.stringify({ type: 'input', seq: ++seq, forward: false, back: false, left: false, right: false, jump: false, action: false, keys: {}, ...patch }));
  };

  // Track positions starting now
  const movementTrack = trackPositionFromDiffs(ws, 5000, label);

  // 1.5s walk forward
  for (let i = 0; i < 30; i++) { sendInput({ forward: true, moveX: 0, moveZ: 1 }); await sleep(50); }
  sendInput({}); // stop
  await sleep(200);

  // 1s walk right
  for (let i = 0; i < 20; i++) { sendInput({ right: true, moveX: 1, moveZ: 0 }); await sleep(50); }
  sendInput({});
  await sleep(200);

  // 0.5s jump
  sendInput({ jump: true });
  await sleep(50);
  sendInput({});
  await sleep(800);

  // 1s walk back
  for (let i = 0; i < 20; i++) { sendInput({ back: true, moveX: 0, moveZ: -1 }); await sleep(50); }
  sendInput({});
  await sleep(300);

  const track = await movementTrack;
  if (track.positions.length < 5) {
    issue('warn', 'few_position_updates', `${label}: only ${track.positions.length} player position updates in 5s`, { count: track.positions.length });
  }
  if (track.voidFalls > 0) {
    issue('error', 'void_fall', `${label}: player y went below -2 (${track.voidFalls} times)`);
  }
  // Movement coverage — final position should differ from start
  const startPos = snapshot.world?.player?.position;
  const endPos = track.lastPos;
  if (startPos && endPos) {
    const dx = endPos[0] - startPos[0];
    const dz = endPos[2] - startPos[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.1) {
      issue('warn', 'no_player_movement', `${label}: player barely moved (${dist.toFixed(2)} units) over 5s of inputs`, { startPos, endPos });
    } else {
      console.log(`    moved ${dist.toFixed(2)} units (start=${startPos.map(n=>n.toFixed(1))} end=${endPos.map(n=>n.toFixed(1))})`);
    }
  }

  // 2) Chat
  const chatPromise = new Promise(resolve => {
    let received = null;
    const handler = raw => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === 'chat' || m.type === 'chat_rejected') { received = m; ws.off('message', handler); resolve(received); }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(received); }, 1500);
  });
  ws.send(JSON.stringify({ type: 'chat', text: `hello from ${label}` }));
  const chatResult = await chatPromise;
  if (!chatResult) issue('warn', 'chat_no_echo', `${label}: chat not echoed back within 1.5s`);
  else if (chatResult.type === 'chat_rejected') issue('warn', 'chat_rejected', `${label}: ${chatResult.reason}`);

  // 3) Ping (keepalive sanity)
  const pingPromise = new Promise(resolve => {
    const handler = raw => {
      try { const m = JSON.parse(String(raw)); if (m.type === 'pong') { ws.off('message', handler); resolve(m); } } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => { ws.off('message', handler); resolve(null); }, 500);
  });
  ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  const pongResult = await pingPromise;
  if (!pongResult) issue('warn', 'ping_no_pong', `${label}: ping not answered within 500ms`);

  return {
    movement: { positionUpdates: track.positions.length, lastPos: track.lastPos, voidFalls: track.voidFalls },
    chatEchoed: !!chatResult && chatResult.type === 'chat',
    pingPonged: !!pongResult,
  };
}

function entitySig(e) {
  return `${e.id}:${e.modelKey || e.model || e.name || ''}:${e.position.map(n => Math.round(n * 10) / 10).join(',')}`;
}

function compareSnapshots(a, b, labelA, labelB) {
  const wa = a.world, wb = b.world;
  // Entity count
  if (wa.entities.length !== wb.entities.length) {
    issue('error', 'entity_count_mismatch',
      `${labelA} had ${wa.entities.length} entities, ${labelB} had ${wb.entities.length}`,
      { a: wa.entities.length, b: wb.entities.length });
  }
  // Player spawn
  const pa = wa.player.position, pb = wb.player.position;
  const dx = Math.abs(pa[0] - pb[0]), dy = Math.abs(pa[1] - pb[1]), dz = Math.abs(pa[2] - pb[2]);
  if (dx + dy + dz > 0.5) {
    issue('warn', 'player_spawn_drift',
      `${labelA}.player=${pa} vs ${labelB}.player=${pb} — drift ${(dx+dy+dz).toFixed(2)}`,
      { pa, pb });
  }
  // Entity overlap by id
  const aIds = new Set(wa.entities.map(e => e.id));
  const bIds = new Set(wb.entities.map(e => e.id));
  const onlyA = [...aIds].filter(id => !bIds.has(id));
  const onlyB = [...bIds].filter(id => !aIds.has(id));
  if (onlyA.length || onlyB.length) {
    issue('warn', 'entity_id_diff',
      `${onlyA.length} only in ${labelA}, ${onlyB.length} only in ${labelB}`,
      { onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5) });
  }
}

async function main() {
  console.log(`\nProbing game ${GAME_ID} — 3 sequential joins\n`);

  const sessions = [];

  for (let i = 1; i <= 3; i++) {
    const label = `join${i}`;
    console.log(`\n── ${label} ──`);
    let session;
    try {
      session = await connectAndJoin(`Probe${i}`, label);
    } catch (e) {
      issue('error', 'join_failed', `${label}: ${e.message}`);
      continue;
    }
    console.log(`  connected & received snapshot in ${session.joinMs}ms`);
    console.log(`  entities=${session.snapshot.world.entities.length} player=${session.snapshot.world.player.position}`);

    // Validate snapshot
    if (!session.snapshot.world.player) issue('error', 'no_player_in_snapshot', `${label}: world.player missing`);
    if (!Array.isArray(session.snapshot.world.entities)) issue('error', 'no_entities_array', `${label}: world.entities not array`);

    // Check for NaN positions
    const bad = (session.snapshot.world.entities || []).filter(e => !Array.isArray(e.position) || e.position.some(v => isNaN(v) || v === null));
    if (bad.length) issue('error', 'invalid_entity_positions', `${label}: ${bad.length} entities have NaN/null positions`, { sampleIds: bad.slice(0,3).map(e => e.id) });

    // Exercise gameplay
    const stats = await exerciseSession(session.ws, label, session.snapshot);

    sessions.push({ label, joinMs: session.joinMs, entityCount: session.snapshot.world.entities.length, player: session.snapshot.world.player.position, recvSummary: summarizeRecv(session.recv), stats, snapshot: session.snapshot });

    try { session.ws.close(); } catch {}
    await sleep(700); // let server fire player_leave cleanup
  }

  // Cross-session comparisons
  console.log(`\n── snapshot consistency ──`);
  if (sessions.length >= 2) compareSnapshots(sessions[0].snapshot, sessions[1].snapshot, 'join1', 'join2');
  if (sessions.length >= 3) compareSnapshots(sessions[1].snapshot, sessions[2].snapshot, 'join2', 'join3');
  if (sessions.length >= 3) compareSnapshots(sessions[0].snapshot, sessions[2].snapshot, 'join1', 'join3');

  // Final report
  const report = {
    gameId: GAME_ID,
    runAt: new Date().toISOString(),
    sessions: sessions.map(({ snapshot, ...s }) => ({ ...s, snapshotEntityCount: snapshot.world.entities.length })),
    issues: ISSUES,
  };
  writeFileSync('/Users/blakegibson/Pludo/api-server/probe-3joins-report.json', JSON.stringify(report, null, 2));

  console.log(`\n── summary ──`);
  console.log(`  joins: ${sessions.length}/3`);
  console.log(`  issues: ${ISSUES.length}`);
  console.log(`  errors: ${ISSUES.filter(i => i.severity === 'error').length}`);
  console.log(`  warns:  ${ISSUES.filter(i => i.severity === 'warn').length}`);
  if (ISSUES.length) {
    console.log(`\nIssues:`);
    for (const i of ISSUES) console.log(`  [${i.severity}] ${i.code}: ${i.detail}`);
  }
  console.log(`\nFull report → probe-3joins-report.json`);
  process.exit(ISSUES.filter(i => i.severity === 'error').length > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
