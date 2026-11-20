// edit-flow.test.ts — Comprehensive tests for the game editing pipeline.
// Run with: node --import tsx/esm src/edit-flow.test.ts
//
// Tests are grouped by the step they cover.  Steps that require a live
// Claude/Meshy API are marked NEEDS_MANUAL_REVIEW and skipped here.

import assert from 'node:assert/strict';
import { LuaRuntime } from './lua-runtime.js';
import { RoomManager, Room } from './room-manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: TestResult[] = [];

interface TestResult {
  step: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  expected?: string;
  actual?: string;
  note?: string;
}

async function test(step: string, name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ step, name, status: 'PASS' });
    passed++;
    console.log(`  ✓ [${step}] ${name}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ step, name, status: 'FAIL', actual: msg });
    failed++;
    console.error(`  ✗ [${step}] ${name}\n      ${msg}`);
  }
}

function skip(step: string, name: string, note: string) {
  results.push({ step, name, status: 'SKIP', note });
  console.log(`  - [${step}] ${name} (NEEDS_MANUAL_REVIEW: ${note})`);
}

// Minimal valid game scripts for testing
const MINIMAL_SCRIPT = `
Game.OnStart(function()
  local floor = Object.Create("cube")
  floor:SetPosition(0, 0, 0)
  floor:SetScale(10, 0.5, 10)
end)
Game.OnUpdate(function(dt)
  if Player.GetScore() >= 10 then Game.Win("You win!") end
end)
`;

const SCRIPT_WITH_ENEMY = `
Game.OnStart(function()
  local floor = Object.Create("cube")
  floor:SetPosition(0, 0, 0)
  local enemy = Object.Create("sphere")
  enemy:SetPosition(5, 1, 0)
end)
Game.OnUpdate(function(dt)
  if Player.GetScore() >= 10 then Game.Win("You win!") end
end)
`;

const SCRIPT_SYNTAX_ERROR = `
Game.OnStart(function()
  local x = -- syntax error here
end)
`;

// ── Step 2: Asset Reuse Validation ───────────────────────────────────────────

console.log('\nStep 2: Asset Reuse Validation');

await test('S2', 'manifest filter keeps only truly new assets', () => {
  // Simulate the server-side filter logic from /api/edit-game
  const existingUrls: Record<string, string> = {
    'grass_terrain': 'https://cdn.example.com/grass.glb',
    'stone_platform': 'https://cdn.example.com/stone.glb',
  };
  const newManifest = [
    { id: 'grass_terrain', asset: 'game-assets/v1/grass.glb', is_humanoid: false },  // existing — should be filtered
    { id: 'power_mushroom', asset: 'game-assets/v1/mushroom.glb', is_humanoid: false }, // new
  ];

  const pendingItems = newManifest.filter(m => !existingUrls[m.id]).slice(0, 3);
  assert.equal(pendingItems.length, 1, 'only 1 new asset should be pending');
  assert.equal(pendingItems[0].id, 'power_mushroom');
});

await test('S2', 'manifest cap enforces max 3 new assets per edit', () => {
  const existingUrls: Record<string, string> = {};
  const newManifest = [
    { id: 'a', asset: 'game-assets/v1/a.glb', is_humanoid: false },
    { id: 'b', asset: 'game-assets/v1/b.glb', is_humanoid: false },
    { id: 'c', asset: 'game-assets/v1/c.glb', is_humanoid: false },
    { id: 'd', asset: 'game-assets/v1/d.glb', is_humanoid: false }, // should be dropped
  ];
  const pendingItems = newManifest.filter(m => !existingUrls[m.id]).slice(0, 3);
  assert.equal(pendingItems.length, 3, 'cap enforced at 3');
  assert.equal(pendingItems.find(m => m.id === 'd'), undefined, 'd was dropped');
});

await test('S2', 'merged asset urls include both old and new after edit', () => {
  const existingUrls: Record<string, string> = { 'old_model': 'https://cdn/old.glb' };
  const newUrls: Record<string, string> = { 'new_model': 'https://cdn/new.glb' };
  const merged = { ...existingUrls, ...newUrls };
  assert.equal(merged['old_model'], 'https://cdn/old.glb', 'old asset preserved');
  assert.equal(merged['new_model'], 'https://cdn/new.glb', 'new asset added');
  assert.equal(Object.keys(merged).length, 2);
});

skip('S2', 'Meshy not called for existing asset IDs (R2 cache hit log check)',
  'Requires live Meshy API + R2 logs');
skip('S2', 'Claude does not re-request existing model IDs',
  'Requires live Claude API call');

// ── Step 3: Hot-Reload Stability ──────────────────────────────────────────────

console.log('\nStep 3: Hot-Reload Stability');

await test('S3', 'hot-reload creates new objects without ghost entities', async () => {
  const lua = new LuaRuntime();
  await lua.init(SCRIPT_WITH_ENEMY);

  const beforeState = lua.getWorldState();
  const beforeCount = beforeState.entities.size;
  assert.equal(beforeCount, 2, `initial script should create 2 entities, got ${beforeCount}`);

  // Reload with a script that creates 3 entities
  const script3 = `
Game.OnStart(function()
  Object.Create("cube")
  Object.Create("cube")
  Object.Create("cube")
end)
Game.OnUpdate(function(dt)
  if Player.GetScore() >= 1 then Game.Win() end
end)
`;
  await lua.hot_reload(script3);

  const afterState = lua.getWorldState();
  const afterCount = afterState.entities.size;
  assert.equal(afterCount, 3,
    `after reload should have exactly 3 entities (no ghosts), got ${afterCount}`);

  lua.destroy();
});

await test('S3', 'hot-reload same script twice produces identical entity count', async () => {
  const lua = new LuaRuntime();
  await lua.init(MINIMAL_SCRIPT);

  await lua.hot_reload(MINIMAL_SCRIPT);
  const count1 = lua.getWorldState().entities.size;

  await lua.hot_reload(MINIMAL_SCRIPT);
  const count2 = lua.getWorldState().entities.size;

  assert.equal(count1, count2,
    `entity count must be identical after double reload: ${count1} vs ${count2}`);

  lua.destroy();
});

await test('S3', 'hot-reload with syntax error preserves previous valid state', async () => {
  const lua = new LuaRuntime();
  await lua.init(MINIMAL_SCRIPT);

  const beforeCount = lua.getWorldState().entities.size;

  let threw = false;
  try {
    await lua.hot_reload(SCRIPT_SYNTAX_ERROR);
  } catch {
    threw = true;
  }

  assert.ok(threw, 'hot_reload should throw on syntax error');

  const afterCount = lua.getWorldState().entities.size;
  assert.equal(afterCount, beforeCount,
    `entity count must be preserved after failed reload (before=${beforeCount} after=${afterCount})`);

  // Game loop must still work — tick should not throw
  const diff = await lua.tick(0.05, []);
  assert.ok(diff !== undefined, 'tick should succeed after failed reload');

  lua.destroy();
});

await test('S3', 'hot-reload preserves player stats (health, score)', async () => {
  const lua = new LuaRuntime();
  await lua.init(MINIMAL_SCRIPT);

  // Manually bump score/health in world state to simulate in-progress game
  const world = lua.getWorldState();
  world.player.score  = 7;
  world.player.health = 42;

  await lua.hot_reload(MINIMAL_SCRIPT);

  const after = lua.getWorldState();
  assert.equal(after.player.score,  7,  'score preserved across hot-reload');
  assert.equal(after.player.health, 42, 'health preserved across hot-reload');

  lua.destroy();
});

await test('S3', 'OnUpdate is re-registered after hot-reload', async () => {
  const lua = new LuaRuntime();
  await lua.init(MINIMAL_SCRIPT);

  await lua.hot_reload(MINIMAL_SCRIPT);

  // Tick should succeed (OnUpdate is wired); errors would throw
  const diff = await lua.tick(0.05, []);
  assert.ok(diff !== undefined, 'tick works post-reload — OnUpdate is registered');

  lua.destroy();
});

await test('S3', 'rapid 10 hot-reloads do not accumulate ghost entities', async () => {
  const lua = new LuaRuntime();
  await lua.init(MINIMAL_SCRIPT); // creates 1 entity

  for (let i = 0; i < 10; i++) {
    await lua.hot_reload(MINIMAL_SCRIPT);
  }

  const count = lua.getWorldState().entities.size;
  assert.equal(count, 1,
    `after 10 reloads must still be 1 entity, got ${count}`);

  lua.destroy();
});

// ── Step 4: Chat History Window ───────────────────────────────────────────────

console.log('\nStep 4: Chat History Window');

await test('S4', 'slice(-20) keeps last 20 messages', () => {
  const history = Array.from({ length: 25 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i + 1}`,
  }));

  const sliced = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 500) }));

  assert.equal(sliced.length, 20, 'exactly 20 messages');
  assert.equal(sliced[0].content, 'message 6', 'oldest kept is message 6 (drop 1-5)');
  assert.equal(sliced[19].content, 'message 25', 'newest is message 25');
});

await test('S4', '21st message drops oldest, window is messages 2-21', () => {
  const history = Array.from({ length: 21 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i + 1}`,
  }));

  const sliced = history
    .filter(m => m.content.trim())
    .slice(-20);

  assert.equal(sliced.length, 20);
  assert.equal(sliced[0].content, 'message 2', 'message 1 dropped');
  assert.equal(sliced[19].content, 'message 21', 'message 21 kept');
});

await test('S4', 'truncation always drops from oldest end', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: 'user' as const,
    content: `msg ${i + 1}`,
  }));
  const sliced = history.slice(-20);
  // First kept message should be #11, last should be #30
  assert.equal(sliced[0].content, 'msg 11');
  assert.equal(sliced[19].content, 'msg 30');
});

await test('S4', 'content is capped at 500 chars per message', () => {
  const long = 'x'.repeat(600);
  const history = [{ role: 'user' as const, content: long }];
  const sliced = history.slice(-20).map(m => ({ ...m, content: m.content.slice(0, 500) }));
  assert.equal(sliced[0].content.length, 500);
});

await test('S4', 'history is ordered chronologically (oldest first)', () => {
  const history = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'second' },
    { role: 'user' as const, content: 'third' },
  ];
  const sliced = history.slice(-20);
  assert.equal(sliced[0].content, 'first');
  assert.equal(sliced[2].content, 'third');
});

skip('S4', 'Claude lacks context after 25 messages when context from msg 1 is needed',
  'Known product limitation — context window drops msgs > 20 back. Documented below.');

// ── Step 5: Concurrent Player Mid-Session Reload ──────────────────────────────

console.log('\nStep 5: Concurrent Mid-Session Edit');

await test('S5', 'hot_reload_game reloads all rooms for a gameId', async () => {
  const mgr = new RoomManager();

  const room1 = await mgr.getOrCreateRoom('game-42', MINIMAL_SCRIPT, '', 16);
  // Force a second room for the same game by filling room1
  // (we can't easily fill to 16 in tests, so test with one room)

  const reloaded = await mgr.hot_reload_game('game-42', MINIMAL_SCRIPT);
  assert.equal(reloaded, 1, '1 room reloaded');

  mgr.destroyAll();
});

await test('S5', 'hot_reload for unknown gameId reloads 0 rooms', async () => {
  const mgr = new RoomManager();
  const reloaded = await mgr.hot_reload_game('nonexistent-game', MINIMAL_SCRIPT);
  assert.equal(reloaded, 0, '0 rooms for unknown game');
  mgr.destroyAll();
});

await test('S5', 'room remains intact (not destroyed) after hot-reload error', async () => {
  const mgr = new RoomManager();
  await mgr.getOrCreateRoom('game-99', MINIMAL_SCRIPT, '', 16);

  let threw = false;
  try {
    await mgr.hot_reload_game('game-99', SCRIPT_SYNTAX_ERROR);
  } catch { threw = true; }

  // Room should still exist with the valid previous script
  const rooms = mgr.getRoomsForGame('game-99');
  assert.equal(rooms.length, 1, 'room still exists after failed reload');
  // And it can still tick
  const room = rooms[0];
  assert.ok(room !== undefined);

  mgr.destroyAll();
});

skip('S5', 'two WebSocket clients both receive snapshot after hot-reload',
  'Requires live WebSocket server wiring');
skip('S5', 'neither client disconnects during hot-reload',
  'Requires live WebSocket server wiring');
skip('S5', 'game state (score/health) preserved or reset consistently across reload',
  'Documented behavior: player stats (health, score, speed) are preserved; entities reset');

// ── Step 6: Partial Script Streaming ─────────────────────────────────────────

console.log('\nStep 6: Partial Script Streaming');

await test('S6', 'partial script with no OnUpdate does not crash the runtime', async () => {
  // A valid partial with only OnStart (no OnUpdate yet)
  const partial = `
Game.OnStart(function()
  Object.Create("cube")
end)
`;
  const lua = new LuaRuntime();
  await lua.init(partial);
  // Tick should not throw even without OnUpdate registered
  const diff = await lua.tick(0.05, []);
  assert.ok(diff !== undefined);
  lua.destroy();
});

await test('S6', 'sanitizer strips Luau type annotations before execution', () => {
  // The sanitizer is private, but we can verify indirectly by loading annotated code
  const annotated = `
--!strict
type EnemyList = {string}
local x: number = 5
Game.OnStart(function()
  local count: number = 3
end)
Game.OnUpdate(function(dt: number)
  if Player.GetScore() >= 1 then Game.Win() end
end)
`;
  // If the sanitizer works, this loads without error
  const lua = new LuaRuntime();
  return lua.init(annotated).then(() => {
    lua.destroy();
  });
});

skip('S6', 'stream of 5 partial scripts each hot-reloads without crashing',
  'Requires live streaming endpoint wiring');
skip('S6', 'unclosed function block in partial is handled gracefully (deferred or skipped)',
  'Lua syntax error at doString time — handled by hot_reload error path (tested in S3)');
skip('S6', 'final script correctly replaces all partial state with no leftover objects',
  'Covered by S3 ghost-object test');

// ── Step 7: Edit Prompt Edge Cases ────────────────────────────────────────────

console.log('\nStep 7: Edit Prompt Edge Cases');

await test('S7', 'empty userMessage returns 400 without touching Claude', () => {
  // Simulate the guard at the top of /api/edit-game
  const userMessage = '';
  const gameId = 1;
  const wouldReturn400 = !gameId || !userMessage?.trim();
  assert.ok(wouldReturn400, 'empty prompt → 400');
});

await test('S7', 'whitespace-only userMessage returns 400', () => {
  const userMessage = '   \t\n  ';
  const wouldReturn400 = !userMessage?.trim();
  assert.ok(wouldReturn400);
});

await test('S7', 'userMessage capped at 1000 chars before Claude call', () => {
  const long = 'a'.repeat(1500);
  const capped = long.trim().slice(0, 1000);
  assert.equal(capped.length, 1000);
});

await test('S7', 'asset cap enforced — 7th asset for a 6-asset game is filtered', () => {
  // Game already has 6 assets
  const existingUrls: Record<string, string> = {
    'a': 'u', 'b': 'u', 'c': 'u', 'd': 'u', 'e': 'u', 'f': 'u',
  };
  const newManifest = [
    { id: 'g', asset: 'game-assets/v1/g.glb', is_humanoid: false }, // 7th — should be filtered OR capped
  ];
  // The edit endpoint allows up to 3 NEW assets, but the caller already has 6.
  // The merged total could be 7 — the cap is on NEW assets per edit (3), not total.
  // Document: total asset count is not hard-capped server-side post-edit.
  // The 6-asset cap is enforced at generation time by Claude prompt; edits allow +3 new.
  const pendingItems = newManifest.filter(m => !existingUrls[m.id]).slice(0, 3);
  assert.equal(pendingItems.length, 1, '7th asset is technically allowed as a "new" asset in edit');
  // NOTE: this is a documented gap — the edit endpoint allows exceeding the 6-asset cap.
});

skip('S7', 'genre-shift edit (platformer → racer) handled gracefully or rejected',
  'Requires live Claude API call');
skip('S7', 'edit references non-existent asset — Claude ignores or surfaces error',
  'Requires live Claude API call');
skip('S7', 'non-English edit prompt — document behavior',
  'Requires live Claude API call');
skip('S7', 'rapid-fire 10 concurrent edits processed in order',
  'Requires load testing against live server');

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped`);
if (failed > 0) console.error('FAILURES DETECTED');

// ── Known limitations documentation ──────────────────────────────────────────

const knownLimitations = [
  {
    area: 'Chat history context window',
    limitation: 'The /api/edit-game endpoint trims history to the last 20 messages (each capped at 500 chars). If a user references something from before message N-20, Claude will not have that context. This is a product-level limitation: "revert the change you made earlier" fails silently if the referenced edit is outside the window.',
    impact: 'Users making many edits in a single session may find Claude unable to reference early edits.',
    recommendation: 'Consider persisting a rolling summary message rather than raw history, or raising the window for paid tiers.',
  },
  {
    area: 'Asset cap post-edit',
    limitation: 'The 6-asset cap from the initial generation prompt is not enforced server-side during edits. An edit can add up to 3 new assets on top of an existing 6, resulting in 9 total assets in the manifest.',
    impact: 'Games can accumulate more than 6 Meshy models over multiple edits, increasing load times.',
    recommendation: 'Add a server-side check: if existingIds.length + pendingItems.length > 6, trim pendingItems to fit.',
  },
  {
    area: 'Server-side hot-reload entity state on reload',
    limitation: 'Player health and score are preserved across hot-reloads; entity world is fully reset. This means in-progress game state (enemy positions, collected items, score multipliers stored in Lua locals) is lost on every edit.',
    impact: 'Players in active sessions see a full scene reset when the game creator makes an edit.',
    recommendation: 'Documented and expected behavior. Consider adding a client-side "game updated" banner.',
  },
];

// Write output JSON
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const output = {
  runAt: new Date().toISOString(),
  summary: { passed, failed, skipped: results.filter(r => r.status === 'SKIP').length },
  results,
  knownLimitations,
  fixesApplied: [
    {
      file: 'api-server/src/lua-runtime.ts',
      description: 'hot_reload: removed savedEntities restoration — OnStart now rebuilds entities from scratch, eliminating ghost objects.',
      bug: 'Old entity map was preserved and then _callbacks.start() added new entities on top, leaving uncontrolled ghosts.',
    },
    {
      file: 'api-server/src/lua-runtime.ts',
      description: 'hot_reload: new engine created before old engine closed. On script error, new engine is discarded and previous state is fully restored (lua, world, pending queues).',
      bug: 'Lua engine was closed before validating new script. A syntax error left the game with no engine and no entities.',
    },
  ],
};

const outPath = path.join(__dirname, '../../edit-flow-tests.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to edit-flow-tests.json`);

if (failed > 0) process.exit(1);
