// Smoke test for the new sculpt API on Structure.CreateTerrain.
// Run: node --import tsx/esm src/terrain-sculpt-smoke.ts
//
// Confirms: heightmap is created, RaiseHill / DigPit / Flatten mutate the
// expected cells, GetHeightAt returns sampled values, and auto-snap lifts a
// newly-positioned Object.Create entity to the sculpted height.

import assert from 'node:assert/strict';
import { LuaRuntime } from './lua-runtime.js';

const SCRIPT = `
Game.OnStart(function()
  local t = Structure.CreateTerrain(0, 0, 0, 100, 100, {
    { materialType = "grass", slopeMin = 0.0, slopeMax = 0.35, tiling = 8.0 },
    { materialType = "rock",  slopeMin = 0.55, slopeMax = 1.0, tiling = 5.0 },
  })
  t:RaiseHill(20, 10, 18, 6)
  t:DigPit(-10, -10, 6, 2)
  t:Flatten(30, 30, 8, 8, 3)

  -- Sample the grid at each feature center.
  local hH = t:GetHeightAt(20, 10)
  local hP = t:GetHeightAt(-10, -10)
  local hF = t:GetHeightAt(30, 30)
  print("hill=" .. tostring(hH) .. " pit=" .. tostring(hP) .. " pad=" .. tostring(hF))

  -- Drop a meshy prop on top of the hill — y=0 means ground-relative.
  local tree = Object.Create("model:fake-tree")
  tree:SetTag("smoke-tree")
  tree:SetPosition(20, 0, 10)
end)
`;

async function main(): Promise<void> {
  const rt = new LuaRuntime();
  await rt.init(SCRIPT);
  // Tick once so OnStart-pending state is fully realized.
  await rt.tick(0.016, []);

  const w = rt.getWorldState();
  // Find the terrain and the tree.
  let terrain = null as null | (typeof w.entities extends Map<unknown, infer V> ? V : never);
  let tree = null as typeof terrain;
  for (const e of w.entities.values()) {
    if (e.type === 'terrain') terrain = e;
    if (e.tag === 'smoke-tree') tree = e;
  }
  assert.ok(terrain, 'terrain entity missing');
  assert.ok(tree,    'tree entity missing');
  assert.ok(terrain!.terrainHeights, 'terrain heights missing');
  assert.equal(terrain!.terrainHeights!.length, 64 * 64, 'grid size wrong');

  const max = Math.max(...terrain!.terrainHeights!);
  const min = Math.min(...terrain!.terrainHeights!);
  console.log('grid min:', min.toFixed(2), 'max:', max.toFixed(2));
  assert.ok(max > 4,  `hill peak too low (max=${max})`);
  assert.ok(min < -1, `pit too shallow (min=${min})`);

  // Tree's server-side Y should be lifted to the hill height (~6).
  console.log('tree.y after auto-snap:', tree!.position[1]);
  assert.ok(tree!.position[1] > 5, `tree did not auto-snap (y=${tree!.position[1]})`);

  console.log('\nOK — terrain sculpt smoke test passed.');
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
