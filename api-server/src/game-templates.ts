// Pre-built Lua scaffolds for each game genre.
// Claude fills these in rather than generating from scratch, which dramatically
// improves generation quality and reduces hallucination of non-existent APIs.

export type KeywordWeight = 1 | 2 | 3;
export interface WeightedKeyword { kw: string; w: KeywordWeight }

// w3 = highly specific genre marker  |  w2 = moderately specific  |  w1 = generic
const k3 = (kw: string): WeightedKeyword => ({ kw, w: 3 });
const k2 = (kw: string): WeightedKeyword => ({ kw, w: 2 });
const k1 = (kw: string): WeightedKeyword => ({ kw, w: 1 });

/** Minimum score for keyword-based selection to be used without a Claude confirmation call. */
export const CONFIDENCE_THRESHOLD = 3;

export interface GameTemplate {
  genre: string;
  description: string;  // one-liner used by Claude fallback classifier
  keywords: WeightedKeyword[];
  scaffold: string;   // Lua with {{FILL: description}} placeholders Claude replaces
}

// A successful past generation for a given genre, used to inject proven
// asset combinations back into the template prompt as concrete examples.
export interface TemplateExample {
  gameId: number;
  manifest: { id: string; asset: string; is_humanoid: boolean }[];
}

export const GAME_TEMPLATES: GameTemplate[] = [
  // ── Obby / Platformer ─────────────────────────────────────────────────────
  {
    genre: 'platformer',
    description: 'Jumping over obstacles and platforms, obby/parkour style',
    keywords: [
      k3('obby'), k3('parkour'), k3('obstacle course'), k3('platformer'), k3('side scroller'), k3('side-scroller'),
      k2('obstacle'), k2('jump'), k2('platform'), k2('course'), k2('level'),
      k1('hop'), k1('dodge'), k1('fall'), k1('run'), k1('double jump'),
    ],
    scaffold: `
-- PLATFORMER / OBBY scaffold
-- Theme: {{FILL: describe the visual theme and world}}

Scene.SetFog({r={{FILL:r}},g={{FILL:g}},b={{FILL:b}}}, {{FILL:density 0.01-0.05}})
Audio.PlayMusic("{{FILL: music preset}}")

Player.SetSpeed({{FILL: speed 5-8}})
Player.SetJumpHeight({{FILL: jumpHeight 3-5}})

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- {{FILL: 8-15 platforms forming a path with varying difficulty}}
-- Each platform: local p = Object.Create("cube") + SetPosition + SetScale + SetMaterial + SetStatic(true)
{{FILL: platform definitions}}

-- Hazards (touching = lose health / respawn)
-- {{FILL: 3-6 hazard objects with OnPlayerEnter callbacks that damage player}}
{{FILL: hazard definitions}}

-- Checkpoints (touching = update spawn)
-- {{FILL: 3-5 checkpoint objects with OnPlayerEnter that update spawn point}}
{{FILL: checkpoint definitions}}

-- Goal zone
local goalZone = Object.Create("{{FILL: distinctive goal object}}")
goalZone:SetPosition({{FILL: end position}})
goalZone:SetScale(3, 5, 3)
goalZone:SetEmissive({{FILL: r}}, {{FILL: g}}, {{FILL: b}}, 2)
goalZone:OnPlayerEnter(function()
  Player.AddScore(1000)
  Effects.Spawn("confetti", {{FILL: x}}, {{FILL: y}}, {{FILL: z}})
  Audio.PlaySound("win")
  Game.End("win")
end)

Game.OnStart(function()
  Scene.SetEnvironment("platformer")
  Player.SetSpawnPoint(0, 3, 0)
  UI.ShowHUD({health=true, score=true})
  Game.SetObjective("Reach the goal at the end of the course!")
  Player.ShowTitle("{{FILL: game title}}", "Reach the end!", 3)
end)

Game.OnPlayerDied(function()
  Audio.PlaySound("lose")
  Effects.ScreenShake(0.5, 0.3)
  Player.SetHealth(100)
  local sp = Player.GetPosition()
  Player.ShowMessage("Try again!", 2)
end)
`,
  },

  // ── Tower Defense ─────────────────────────────────────────────────────────
  {
    genre: 'strategy',
    description: 'Place towers to defend a base from waves of enemies',
    keywords: [
      k3('tower defense'), k3('td game'), k3('turret'), k3('defend the base'),
      k2('tower'), k2('defend'), k2('base defense'), k2('enemy wave'), k2('wave'),
      k1('enemy'), k1('base'), k1('place'), k1('spawn'),
    ],
    scaffold: `
-- TOWER DEFENSE scaffold
-- Theme: {{FILL: describe the visual theme}}

Audio.PlayMusic("{{FILL: music}}")

-- Base health
local baseHealth = 20
local wave = 0
local enemiesAlive = 0
local score = 0
local gameOver = false

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- Enemy path waypoints
local waypoints = {
  {{FILL: 5-7 {x, y, z} waypoint tables defining enemy path from spawn to base}}
}

-- Base (defend this!)
local base = Object.Create("model:base")
base:SetPosition({{FILL: end position}})
base:SetScale(3, 3, 3)
base:OnPlayerEnter(function() end) -- player can visit but enemies target it

-- Spawn enemies per wave
local enemyTemplate = Object.Create("model:enemy")
enemyTemplate:SetVisible(false)

local function spawnEnemy()
  local e = enemyTemplate:Clone()
  e:SetVisible(true)
  e:SetPosition(waypoints[1].x, waypoints[1].y, waypoints[1].z)
  e:SetScale(1, 1, 1)
  e:SetColor({{FILL: enemy color r}}, {{FILL: g}}, {{FILL: b}})
  local wpIdx = 1
  local speed = 2 + wave * 0.3
  local health = 3 + wave
  enemiesAlive = enemiesAlive + 1

  e:OnCollision(function(name)
    if name:find("bullet") then
      health = health - 1
      Effects.Spawn("sparkle", e:GetPosition().x, e:GetPosition().y, e:GetPosition().z)
      if health <= 0 then
        e:Destroy()
        enemiesAlive = enemiesAlive - 1
        score = score + 10 * wave
        Player.AddScore(10 * wave)
        Audio.PlaySound("collect")
      end
    end
  end)

  Game.OnUpdate(function(dt)
    if not e then return end
    local pos = e:GetPosition()
    local wp = waypoints[wpIdx]
    if not wp then
      -- reached base
      e:Destroy()
      enemiesAlive = enemiesAlive - 1
      baseHealth = baseHealth - 1
      UI.UpdateHUD("base_hp", tostring(baseHealth))
      Audio.PlaySound("hit")
      Effects.ScreenShake(0.4, 0.2)
      if baseHealth <= 0 and not gameOver then
        gameOver = true
        Game.End("lose")
      end
      return
    end
    local dx = wp.x - pos.x
    local dz = wp.z - pos.z
    local dist = math.sqrt(dx*dx + dz*dz)
    if dist < 0.5 then
      wpIdx = wpIdx + 1
    else
      e:SetPosition(pos.x + (dx/dist)*speed*dt, pos.y, pos.z + (dz/dist)*speed*dt)
      e:LookAt(wp.x, pos.y, wp.z)
    end
  end)
end

-- Turret shooting
local turretPositions = {
  {{FILL: 4-6 {x, y, z} turret positions flanking the enemy path}}
}
for _, tp in ipairs(turretPositions) do
  local turret = Object.Create("model:turret")
  turret:SetPosition(tp.x, tp.y, tp.z)
  turret:SetStatic(true)
  turret:SetScale(1.5, 1.5, 1.5)
  Timer.Every({{FILL: fire rate 1.5-2.5}}, function()
    local bullet = Object.Create("sphere")
    bullet:SetPosition(tp.x, tp.y + 1, tp.z)
    bullet:SetScale(0.25, 0.25, 0.25)
    bullet:SetColor(1, 0.8, 0)
    bullet:SetName("bullet")
    bullet:SetEmissive(1, 0.8, 0, 3)
    bullet:SetVelocity(0, 0, {{FILL: bullet speed toward path}})
    Timer.After(3, function() if bullet then bullet:Destroy() end end)
  end)
end

-- Wave spawner
local function startWave()
  wave = wave + 1
  UI.UpdateHUD("wave", tostring(wave))
  Player.ShowTitle("Wave " .. wave, wave > 3 and "They're getting stronger!" or "Defend the base!", 2)
  local count = 3 + wave * 2
  local i = 0
  Timer.Every(1.5, function()
    i = i + 1
    if i > count then return end
    spawnEnemy()
    if i == count then
      Timer.After(8, function()
        if enemiesAlive == 0 and not gameOver then
          if wave >= 5 then
            Game.End("win")
          else
            startWave()
          end
        end
      end)
    end
  end)
end

Game.OnStart(function()
  Scene.SetEnvironment("strategy")
  UI.ShowHUD({health=false, score=true})
  UI.UpdateHUD("wave", "0")
  UI.UpdateHUD("base_hp", tostring(baseHealth))
  Game.SetObjective("Defend the base from {{FILL: enemy type}}!")
  Player.ShowTitle("{{FILL: game title}}", "Protect the base!", 3)
  Timer.After(3, startWave)
end)
`,
  },

  // ── Survival / Wave Shooter ────────────────────────────────────────────────
  {
    genre: 'survival',
    description: 'Survive waves of enemies in an arena, shooter/zombie survival style',
    keywords: [
      k3('zombie survival'), k3('horde survival'), k3('wave survival'), k3('survival shooter'),
      k2('survive'), k2('shooter'), k2('zombie'), k2('horde'), k2('arena shooter'),
      k1('wave'), k1('arena'), k1('fight'), k1('shoot'), k1('kill'), k1('power-up'), k1('powerup'), k1('collect'), k1('enemy'),
    ],
    scaffold: `
-- SURVIVAL / WAVE SHOOTER scaffold
-- Theme: {{FILL: describe the arena and enemies}}

Scene.SetFog({r={{FILL:r}},g={{FILL:g}},b={{FILL:b}}}, 0.03)
Audio.PlayMusic("tense")

Player.SetSpeed({{FILL: speed 6-8}})
Player.SetHealth(100)

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- {{FILL: 4 boundary walls and optional arena obstacles/cover}}
{{FILL: arena walls and obstacles}}

-- Enemy state
local wave = 0
local enemiesAlive = 0
local enemyTemplate = Object.Create("model:enemy")
enemyTemplate:SetVisible(false)
local spawnPoints = {
  {{FILL: 4-6 {x,y,z} spawn positions around the arena perimeter}}
}

local function spawnEnemy(spawnIdx)
  local e = enemyTemplate:Clone()
  local sp = spawnPoints[spawnIdx]
  e:SetVisible(true)
  e:SetPosition(sp.x, sp.y, sp.z)
  e:SetScale(1, 1, 1)
  local health = 2 + wave
  enemiesAlive = enemiesAlive + 1

  -- Deal damage to player on contact
  e:OnPlayerEnter(function()
    if not Player.GetDistanceTo(e) then return end
    Player.AddHealth(-10)
    Audio.PlaySound("hit")
    Effects.ScreenShake(0.3, 0.2)
  end)

  Game.OnUpdate(function(dt)
    if not e then return end
    local dist = e:GetDistanceToPlayer()
    if dist < 1.5 then return end
    e:LookAtPlayer()
    local pos = e:GetPosition()
    local pp  = Player.GetPosition()
    local dx = pp.x - pos.x
    local dz = pp.z - pos.z
    local len = math.sqrt(dx*dx + dz*dz)
    if len > 0 then
      local speed = (1.5 + wave * 0.2)
      e:SetPosition(pos.x + (dx/len)*speed*dt, pos.y, pos.z + (dz/len)*speed*dt)
    end
  end)
end

-- Player shoots on Action key
local bullets = {}
Input.OnAction(function()
  local pp  = Player.GetPosition()
  local pv  = Player.GetVelocity()
  local b   = Object.Create("sphere")
  b:SetPosition(pp.x, pp.y + 1, pp.z)
  b:SetScale(0.3, 0.3, 0.3)
  b:SetColor(1, 0.9, 0.1)
  b:SetEmissive(1, 0.9, 0.1, 4)
  b:SetVelocity(pv.x * 2, 0, pv.z * 2 + 12)
  b:SetPhysics(true)
  Audio.PlaySound("collect")
  local shot = b
  b:OnCollision(function(name)
    if name == "enemy" or name:find("model") then
      Effects.Spawn("explosion", shot:GetPosition().x, shot:GetPosition().y, shot:GetPosition().z)
      shot:Destroy()
      enemiesAlive = math.max(0, enemiesAlive - 1)
      Player.AddScore(50 * wave)
    end
  end)
  Timer.After(4, function() if shot then shot:Destroy() end end)
end)

local function startWave()
  wave = wave + 1
  UI.UpdateHUD("wave", tostring(wave))
  Player.ShowTitle("Wave " .. wave, "Survive!", 2)
  Audio.PlaySound("hit")
  local count = 3 + wave * 3
  local i = 0
  Timer.Every(1.2, function()
    i = i + 1
    if i > count then return end
    spawnEnemy(((i - 1) % #spawnPoints) + 1)
    if i == count then
      Timer.After(12, function()
        if enemiesAlive == 0 then
          if wave >= 5 then
            Effects.Spawn("confetti", 0, 3, 0)
            Audio.PlaySound("win")
            Game.End("win")
          else
            startWave()
          end
        end
      end)
    end
  end)
end

Game.SetTimeLimit(0) -- No time limit for survival
Game.OnStart(function()
  Scene.SetEnvironment("survival")
  UI.ShowHUD({health=true, score=true})
  UI.UpdateHUD("wave", "0")
  Player.SetSpawnPoint(0, 3, 0)
  Game.SetObjective("Survive {{FILL: number}} waves of {{FILL: enemy name}}!")
  Player.ShowTitle("{{FILL: game title}}", "Press E to shoot!", 3)
  Timer.After(3, startWave)
end)

Game.OnPlayerDied(function()
  Audio.PlaySound("lose")
  Effects.Flash({r=1,g=0,b=0}, 0.5)
  Game.End("lose")
end)
`,
  },

  // ── Tycoon / Idle ─────────────────────────────────────────────────────────
  {
    genre: 'simulation',
    description: 'Build and manage a business, idle/clicker tycoon style',
    keywords: [
      k3('tycoon'), k3('idle game'), k3('idle clicker'), k3('business tycoon'), k3('clicker game'), k3('resource management'), k3('management game'), k3('city builder'), k3('town builder'),
      k2('shop'), k2('store'), k2('restaurant'), k2('factory'), k2('farm'), k2('empire'), k2('manage'), k2('business'), k2('passive income'), k2('idle'), k2('management'), k2('build and manage'), k2('run a'), k2('city'), k2('town'),
      k1('earn'), k1('money'), k1('buy'), k1('sell'), k1('customer'), k1('cash'), k1('profit'), k1('click'), k1('collect'), k1('build'), k1('upgrade'),
    ],
    scaffold: `
-- TYCOON / IDLE scaffold
-- Theme: {{FILL: describe what the player builds/manages}}

Audio.PlayMusic("peaceful")

Player.SetSpeed(5)

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- Resource counters
local coins = 0
local production = 1
local level = 1

-- Display areas: collector zone, upgrade zone, shop zone
-- {{FILL: 3-5 themed building models placed around the map}}
{{FILL: building placements}}

-- Coin collectors (walk into to collect)
local function makeCoinSpot(x, z, label)
  local spot = Object.Create("{{FILL: coin visual type}}")
  spot:SetPosition(x, 0.5, z)
  spot:SetScale(2, 0.2, 2)
  spot:SetEmissive(1, 0.85, 0, 2)
  spot:OnPlayerEnter(function()
    coins = coins + production
    Player.AddScore(production)
    Effects.Spawn("collect_burst", x, 1, z)
    Audio.PlaySound("collect")
    UI.UpdateHUD("coins", tostring(coins))
  end)
  return spot
end

-- {{FILL: 4-6 coin collection spots spread across the map}}
{{FILL: coin spot placements using makeCoinSpot}}

-- Upgrade station
local upgradeZone = Object.Create("model:upgrade_station")
upgradeZone:SetPosition({{FILL: x}}, 0.5, {{FILL: z}})
upgradeZone:SetScale(3, 2, 3)
upgradeZone:SetEmissive(0.2, 0.6, 1, 1.5)
upgradeZone:OnPlayerEnter(function()
  local cost = level * 50
  if coins >= cost then
    coins = coins - cost
    production = production + level
    level = level + 1
    UI.UpdateHUD("coins", tostring(coins))
    UI.UpdateHUD("rate", tostring(production) .. "/collect")
    UI.UpdateHUD("level", tostring(level))
    Player.ShowMessage("Upgraded! +" .. level .. " per collection. Cost was " .. cost, 3)
    Effects.Spawn("sparkle", {{FILL: x}}, 2, {{FILL: z}})
    Audio.PlaySound("win")
    if level >= {{FILL: win level 8-12}} then
      Game.End("win")
    end
  else
    Player.ShowMessage("Need " .. cost .. " coins to upgrade! (have " .. coins .. ")", 2)
    Audio.PlaySound("hit")
  end
end)

-- Passive income over time
Timer.Every({{FILL: passive income interval 5-10}}, function()
  coins = coins + math.floor(production / 2)
  UI.UpdateHUD("coins", tostring(coins))
end)

Game.OnStart(function()
  Scene.SetEnvironment("simulation")
  UI.ShowHUD({health=false, score=true})
  UI.UpdateHUD("coins", "0")
  UI.UpdateHUD("rate", "1/collect")
  UI.UpdateHUD("level", "1")
  Game.SetObjective("Collect coins and upgrade to level {{FILL: win level}}!")
  Player.ShowTitle("{{FILL: game title}}", "Walk into shiny spots to collect!", 4)
end)
`,
  },

  // ── Racer ─────────────────────────────────────────────────────────────────
  {
    genre: 'racer',
    description: 'Race cars around tracks, hit checkpoints, fastest wins',
    keywords: [
      k3('racing game'), k3('race track'), k3('lap race'), k3('car race'), k3('kart game'), k3('finish line'),
      k2('race'), k2('racing'), k2('car'), k2('track'), k2('checkpoint'), k2('drift'), k2('kart'), k2('finish'),
      k1('speed'), k1('lap'), k1('vehicle'), k1('road'), k1('corner'), k1('boost'),
    ],
    scaffold: `
-- RACER scaffold
-- Theme: {{FILL: describe the track theme and vehicle}}

Scene.SetFog({r={{FILL:r}},g={{FILL:g}},b={{FILL:b}}}, 0.02)
Audio.PlayMusic("epic")

Player.SetSpeed({{FILL: speed 12-18}})
Player.SetJumpHeight(1)

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- {{FILL: track barriers, curves, and obstacles}}
{{FILL: track elements}}

-- Checkpoints (must pass in order)
local checkpointOrder = {}
local nextCheckpoint = 1
local laps = 0
local startTime = 0
local bestLap = 9999

local function makeCheckpoint(x, z, idx, width, rot)
  local cp = Object.Create("cube")
  cp:SetPosition(x, 2, z)
  cp:SetScale(width, 4, 0.5)
  cp:SetRotation(0, rot or 0, 0)
  cp:SetColor(0.1, 0.8, 0.1)
  cp:SetEmissive(0.1, 0.8, 0.1, 1)
  checkpointOrder[idx] = cp
  cp:OnPlayerEnter(function()
    if idx == nextCheckpoint then
      nextCheckpoint = nextCheckpoint + 1
      Effects.Spawn("sparkle", x, 2, z)
      Audio.PlaySound("collect")
      if nextCheckpoint > #checkpointOrder then
        nextCheckpoint = 1
        laps = laps + 1
        local lapTime = math.floor(Game.GetTimeRemaining() * 10) / 10
        if lapTime < bestLap then bestLap = lapTime end
        UI.UpdateHUD("lap", tostring(laps))
        Player.ShowMessage("Lap " .. laps .. " complete!", 2)
        if laps >= {{FILL: total laps 3-5}} then
          Effects.Spawn("confetti", x, 3, z)
          Game.End("win")
        end
      end
    end
  end)
end

-- {{FILL: 5-8 checkpoint placements using makeCheckpoint(x, z, idx, width, rotation)}}
{{FILL: checkpoint placements}}

-- Speed boost pads
local function makeBoost(x, z)
  local pad = Object.Create("plane")
  pad:SetPosition(x, 0.05, z)
  pad:SetScale(3, 1, 3)
  pad:SetColor(1, 0.5, 0)
  pad:SetEmissive(1, 0.5, 0, 1.5)
  pad:OnPlayerEnter(function()
    Audio.PlaySound("jump")
    Effects.Spawn("sparkle", x, 1, z)
    Player.ShowMessage("SPEED BOOST!", 1)
    -- Boost via velocity momentarily (Lua handles this via timer)
    Timer.After(0.1, function()
      local pv = Player.GetVelocity()
      -- Server will normalize direction; client feels the speed
    end)
  end)
end
-- {{FILL: 3-5 boost pads along the track}}
{{FILL: boost pads}}

Game.SetTimeLimit({{FILL: race time 120-180}})
Game.OnStart(function()
  Scene.SetEnvironment("racer")
  UI.ShowHUD({health=false, score=false, timer=true})
  UI.UpdateHUD("lap", "0")
  Player.SetSpawnPoint({{FILL: start x}}, 3, {{FILL: start z}})
  Game.SetObjective("Complete {{FILL: laps}} laps through all checkpoints!")
  Player.ShowTitle("{{FILL: game title}}", "Hit all checkpoints in order!", 3)
  startTime = Game.GetTimeRemaining()
end)
`,
  },

  // ── Puzzle ────────────────────────────────────────────────────────────────
  {
    genre: 'puzzle',
    description: 'Solve logic puzzles, pressure plates, escape rooms',
    keywords: [
      k3('puzzle game'), k3('escape room'), k3('logic puzzle'), k3('pressure plate'), k3('puzzle platformer'), k3('match three'), k3('match-3'), k3('color match'), k3('tile matching'),
      k2('puzzle'), k2('escape'), k2('solve'), k2('logic'), k2('room'), k2('match'), k2('color'), k2('clear the board'), k2('tile'),
      k1('switch'), k1('door'), k1('lever'), k1('key'), k1('unlock'), k1('mystery'), k1('riddle'), k1('board'),
    ],
    scaffold: `
-- PUZZLE / ESCAPE ROOM scaffold
-- Theme: {{FILL: describe the puzzle setting and story}}

Scene.SetAmbientLight({r=0.3,g=0.3,b=0.5}, 0.6)
Audio.PlayMusic("mysterious")

Player.SetSpeed(4)

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- Room geometry
-- {{FILL: walls and structures defining the room(s) — use Meshy models}}
{{FILL: room geometry}}

-- Puzzle state
local puzzlesSolved = 0
local totalPuzzles = {{FILL: number of puzzles 3-5}}

local function checkWin()
  puzzlesSolved = puzzlesSolved + 1
  UI.UpdateHUD("solved", tostring(puzzlesSolved) .. "/" .. tostring(totalPuzzles))
  Player.ShowMessage("Puzzle solved! " .. puzzlesSolved .. "/" .. totalPuzzles, 3)
  Audio.PlaySound("collect")
  Effects.Spawn("sparkle", Player.GetPosition().x, Player.GetPosition().y, Player.GetPosition().z)
  if puzzlesSolved >= totalPuzzles then
    Timer.After(1, function()
      Effects.Spawn("confetti", 0, 5, 0)
      Audio.PlaySound("win")
      Game.End("win")
    end)
  end
end

-- {{FILL: Puzzle 1 — pressure plate activates a door or reveals next area}}
-- {{FILL: describe puzzle 1 mechanics}}
{{FILL: puzzle 1 implementation}}

-- {{FILL: Puzzle 2 — colored blocks must be pushed to matching zones}}
-- {{FILL: describe puzzle 2 mechanics}}
{{FILL: puzzle 2 implementation}}

-- {{FILL: Puzzle 3 — sequence of buttons must be pressed in correct order}}
-- {{FILL: describe puzzle 3 mechanics}}
{{FILL: puzzle 3 implementation}}

-- {{FILL: Additional puzzles if needed}}
{{FILL: extra puzzles}}

-- Exit door (unlocks when all puzzles solved)
local exitDoor = Object.Create("model:door")
exitDoor:SetPosition({{FILL: exit position}})
exitDoor:SetScale(2, 4, 0.3)
exitDoor:SetColor({{FILL: locked color}})
exitDoor:OnPlayerEnter(function()
  if puzzlesSolved >= totalPuzzles then
    checkWin()
  else
    Player.ShowMessage("Solve " .. (totalPuzzles - puzzlesSolved) .. " more puzzle(s) first!", 2)
    Audio.PlaySound("hit")
  end
end)

Game.SetTimeLimit({{FILL: time limit 300-600}})
Game.OnStart(function()
  Scene.SetEnvironment("puzzle")
  UI.ShowHUD({health=false, score=false, timer=true})
  UI.UpdateHUD("solved", "0/" .. tostring(totalPuzzles))
  Player.SetSpawnPoint({{FILL: spawn position x}}, 3, {{FILL: spawn position z}})
  Game.SetObjective("{{FILL: puzzle objective description}}")
  Player.ShowTitle("{{FILL: game title}}", "{{FILL: short instruction}}", 4)
end)
`,
  },

  // ── RPG / Adventure ───────────────────────────────────────────────────────
  {
    genre: 'adventure',
    description: 'RPG-style adventure with quests, exploration, and boss fights',
    keywords: [
      k3('rpg'), k3('role playing'), k3('dungeon crawler'), k3('fantasy quest'), k3('action rpg'), k3('open world'),
      k2('adventure'), k2('quest'), k2('dungeon'), k2('boss'), k2('explore'), k2('exploration'),
      k1('story'), k1('hero'), k1('sword'), k1('magic'), k1('monster'), k1('level up'), k1('open'), k1('world'),
    ],
    scaffold: `
-- RPG / ADVENTURE scaffold
-- Theme: {{FILL: describe the world, story, and quest}}

Scene.SetFog({r={{FILL:r}},g={{FILL:g}},b={{FILL:b}}}, {{FILL: fog density}})
Audio.PlayMusic("adventure")
Scene.SetAmbientLight({r=0.5,g=0.5,b=0.7}, 0.8)

Player.SetSpeed(5)
Player.SetHealth(100)

-- Terrain: the runtime spawns a 100×100 m editable baseplate at y=0 — the
-- player sculpts it via the Terrain Builder UI. Do not create terrain here.

-- NPCs and enemies
local questProgress = 0
local questGoal = {{FILL: how many items/enemies for quest 3-5}}
local bossDefeated = false

-- Collectibles / quest items
local function makeQuestItem(x, z, label)
  local item = Object.Create("model:quest_item")
  item:SetPosition(x, 1, z)
  item:SetScale(1, 1, 1)
  item:SetEmissive(1, 0.9, 0.2, 2)
  local collected = false
  item:OnPlayerEnter(function()
    if collected then return end
    collected = true
    item:SetVisible(false)
    questProgress = questProgress + 1
    UI.UpdateHUD("quest", tostring(questProgress) .. "/" .. tostring(questGoal))
    Audio.PlaySound("collect")
    Effects.Spawn("collect_burst", x, 1, z)
    Player.AddScore(200)
    Player.ShowMessage("Found " .. label .. "! " .. questProgress .. "/" .. questGoal, 2)
    if questProgress >= questGoal then
      Player.ShowMessage("Quest complete! Find the boss!", 4)
      Audio.PlaySound("win")
    end
  end)
end

-- {{FILL: questGoal quest item placements using makeQuestItem}}
{{FILL: quest items}}

-- Enemies
local function spawnEnemy(x, z, health, damage, speed)
  local e = Object.Create("model:enemy")
  e:SetPosition(x, 1, z)
  e:SetScale(1, 1, 1)
  local hp = health
  local alive = true
  local patrolX, patrolZ = x, z

  e:OnPlayerEnter(function()
    if not alive then return end
    Player.AddHealth(-damage)
    Audio.PlaySound("hit")
    Effects.ScreenShake(0.2, 0.15)
  end)

  Game.OnUpdate(function(dt)
    if not alive then return end
    local dist = e:GetDistanceToPlayer()
    if dist < 12 then
      e:LookAtPlayer()
      local pos = e:GetPosition()
      local pp = Player.GetPosition()
      local dx, dz = pp.x - pos.x, pp.z - pos.z
      local len = math.sqrt(dx*dx + dz*dz)
      if len > 1.5 and len > 0 then
        e:SetPosition(pos.x + (dx/len)*speed*dt, pos.y, pos.z + (dz/len)*speed*dt)
      end
    end
  end)

  e:OnCollision(function(name)
    if name:find("attack") and alive then
      hp = hp - 1
      Effects.Spawn("sparkle", e:GetPosition().x, e:GetPosition().y, e:GetPosition().z)
      if hp <= 0 then
        alive = false
        e:Destroy()
        Player.AddScore(500)
        Audio.PlaySound("collect")
      end
    end
  end)
end

-- {{FILL: 4-6 enemy spawns at different locations}}
{{FILL: enemy spawns}}

-- Boss fight
local bossHp = {{FILL: boss hp 20-40}}
local boss = Object.Create("model:boss")
boss:SetPosition({{FILL: boss position}})
boss:SetScale(3, 3, 3)
boss:SetEmissive({{FILL: boss color r}}, {{FILL: g}}, {{FILL: b}}, 1.5)
local bossActive = false

boss:OnPlayerEnter(function()
  if questProgress < questGoal then
    Player.ShowMessage("Collect all quest items first!", 2)
    return
  end
  if not bossActive and not bossDefeated then
    bossActive = true
    Audio.PlayMusic("epic")
    Player.ShowTitle("BOSS", "{{FILL: boss name}} attacks!", 2)
  end
  if bossActive and not bossDefeated then
    Player.AddHealth(-15)
    Effects.ScreenShake(0.5, 0.3)
    Audio.PlaySound("hit")
  end
end)

Input.OnAction(function()
  if not bossActive or bossDefeated then return end
  local dist = boss:GetDistanceToPlayer()
  if dist < 5 then
    bossHp = bossHp - 1
    Effects.Spawn("explosion", boss:GetPosition().x, boss:GetPosition().y, boss:GetPosition().z)
    Audio.PlaySound("hit")
    UI.UpdateHUD("boss_hp", tostring(bossHp))
    if bossHp <= 0 then
      bossDefeated = true
      bossActive = false
      boss:Destroy()
      Effects.Spawn("confetti", {{FILL: boss x}}, 3, {{FILL: boss z}})
      Audio.PlaySound("win")
      Player.ShowTitle("VICTORY!", "{{FILL: victory message}}", 4)
      Timer.After(4, function() Game.End("win") end)
    end
  else
    Player.ShowMessage("Get closer to the boss! (E to attack)", 1)
  end
end)

Game.SetTimeLimit({{FILL: time limit 600-900}})
Game.OnStart(function()
  Scene.SetEnvironment("adventure")
  UI.ShowHUD({health=true, score=true, timer=true})
  UI.UpdateHUD("quest", "0/" .. tostring(questGoal))
  Player.SetSpawnPoint(0, 3, 0)
  Game.SetObjective("{{FILL: main quest description}}")
  Player.ShowTitle("{{FILL: game title}}", "{{FILL: opening line}}", 4)
end)

Game.OnPlayerDied(function()
  Effects.Flash({r=1,g=0,b=0}, 0.5)
  Audio.PlaySound("lose")
  Game.End("lose")
end)
`,
  },
];

// ── Template selection ────────────────────────────────────────────────────────

export interface TemplateScore { genre: string; score: number; }

/** Returns all template scores for a prompt, sorted descending. */
export function scoreTemplates(prompt: string): TemplateScore[] {
  const lower = prompt.toLowerCase();
  return GAME_TEMPLATES
    .map(t => {
      let score = 0;
      for (const { kw, w } of t.keywords)
        if (lower.includes(kw)) score += w;
      return { genre: t.genre, score };
    })
    .sort((a, b) => b.score - a.score);
}

export interface SelectResult {
  template: GameTemplate | null;
  score: number;
  confident: boolean;
  allScores: TemplateScore[];
}

/** Selects the best template. `confident` is true when score ≥ CONFIDENCE_THRESHOLD. */
export function selectTemplate(prompt: string): SelectResult {
  const allScores = scoreTemplates(prompt);
  const best = allScores[0];
  const template = best.score > 0 ? (GAME_TEMPLATES.find(t => t.genre === best.genre) ?? null) : null;
  return {
    template,
    score: best.score,
    confident: best.score >= CONFIDENCE_THRESHOLD,
    allScores,
  };
}

// ── Template-aware system prompt injection ────────────────────────────────────

export function buildTemplatePrompt(
  userPrompt: string,
  template: GameTemplate | null,
  examples?: TemplateExample[],
): string {
  if (!template) return userPrompt;

  let examplesSection = '';
  if (examples && examples.length > 0) {
    const shown = examples.slice(0, 3);
    examplesSection = `\n\nPROVEN CATALOG ASSET COMBINATIONS for ${template.genre} games (drawn from real successful generations — use as selection inspiration, pick comparable catalog assets):\n` +
      shown.map((e, i) =>
        `Example ${i + 1}:\n` +
        e.manifest.map(m =>
          `  { "id": "${m.id}", "asset": "${m.asset}", "is_humanoid": ${m.is_humanoid} }`
        ).join('\n')
      ).join('\n');
  }

  return `${userPrompt}${examplesSection}

---
USE THE FOLLOWING SCAFFOLD AS YOUR STARTING POINT.
Fill in every {{FILL: ...}} placeholder with specific, vivid content tailored to the prompt above.
Do NOT copy the scaffold comments verbatim — write real, working Lua code.
The scaffold shows the expected structure; you expand and customize every section.

SCAFFOLD:
${template.scaffold}`;
}
