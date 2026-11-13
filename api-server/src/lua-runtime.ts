// Server-side Lua runtime using wasmoon (Lua 5.4 via WASM).
// Hosts the game script, maintains world state, and produces state diffs each tick.

import { LuaFactory, type LuaEngine } from 'wasmoon';
import { randomUUID } from 'crypto';
import {
  type WorldState,
  type EntityState,
  type UIEvent,
  type StateDiff,
  type EntityDiff,
  type ClientInput,
  type TerrainLayer,
  type TerrainSculptOp,
  TERRAIN_GRID_SIZE,
  ROOM_WIDE_UI_EVENTS,
  createDefaultEntity,
  createDefaultPlayer,
  createDefaultScene,
  createDefaultWorldState,
  stepHorizontalVelocity,
  PLAYER_SUBSTEP,
} from './world-state.js';
import { resolveMaterial } from './polyhaven.js';

const LUA_FACTORY = new LuaFactory();

// ── Lua preamble injected before every game script ────────────────────────────
// Defines the high-level Pludo API (Object, Player, Game, etc.) in terms of
// JS functions registered on the global scope.  Timers run inside Lua via
// _tickTimers(dt) called each server tick, so there is no async/setTimeout.

const LUA_PREAMBLE = `
-- Internal state
_callbacks = {}
_timers    = {}
_timerSeq  = 0

-- ── Helpers ────────────────────────────────────────────────────────────────────

function _makeObj(id)
  if not id or id == "" then return nil end
  local o = { _id = id }
  function o:SetPosition(x, y, z)    _objSetPos(id, x, y, z) end
  function o:SetRotation(x, y, z)    _objSetRot(id, x, y, z) end
  function o:SetScale(x, y, z)       _objSetScale(id, x, y, z) end
  function o:SetColor(r, g, b)       _objSetColor(id, r, g, b) end
  function o:SetMaterial(m, tiling, roughness)
    -- Polymorphic: 1 string arg = legacy material preset path; with a tiling
    -- number it's a PBR material-type request routed through Polyhaven.
    if type(tiling) == "number" then
      _objSetStructMat(id, tostring(m), tiling, roughness or 0.7)
    else
      _objSetMat(id, m)
    end
  end
  function o:SetPhysics(en)          _objSetPhysics(id, en) end
  function o:SetStatic(en)           _objSetStatic(id, en) end
  function o:SetVisible(en)          _objSetVisible(id, en) end
  function o:SetTag(t)               _objSetTag(id, t) end
  function o:SetName(n)              _objSetName(id, n) end
  function o:Destroy()               _objDestroy(id) end
  function o:GetPosition()           return _objGetPos(id) end
  function o:GetRotation()           return _objGetRot(id) end
  function o:GetScale()              return _objGetScale(id) end
  function o:SetVelocity(x, y, z)   _objSetVel(id, x, y, z) end
  function o:GetVelocity()           return _objGetVel(id) end
  function o:ApplyForce(x, y, z)    _objApplyForce(id, x, y, z) end
  function o:SetEmissive(r, g, b, i) _objSetEmissive(id, r, g, b, i) end
  function o:LookAt(x, y, z)        _objLookAt(id, x, y, z) end
  function o:LookAtPlayer()          _objLookAtPlayer(id) end
  function o:GetDistanceToPlayer()   return _objDistPlayer(id) end
  function o:GetDistanceTo(other)    return _objDistTo(id, other._id) end
  function o:SetParent(p)            _objSetParent(id, p._id) end
  function o:Detach()                _objDetach(id) end
  function o:Clone()                 return _makeObj(_objClone(id)) end
  function o:OnPlayerEnter(cb)
    _callbacks["trigger_enter_"..id] = cb
    _objSetTrigger(id, true)
  end
  function o:OnPlayerExit(cb)
    _callbacks["trigger_exit_"..id] = cb
    _objSetTrigger(id, true)
  end
  function o:OnCollision(cb)
    _callbacks["collision_"..id] = cb
    _objSetCollision(id, true)
  end
  return o
end

-- ── Object ────────────────────────────────────────────────────────────────────
Object = {}
function Object.Create(t)
  return _makeObj(_objCreate(t))
end

-- ── Structure ─────────────────────────────────────────────────────────────────
-- Procedural primitive ground/walls/ramps. Unlike Object.Create, Structure.*
-- entities are visible by default and survive SetVisible(true). Use these for
-- terrain, walls, platforms, ramps, water — any shape you'd previously asked
-- Meshy to generate as a large structural mesh.
Structure = {}
local function _structApply(id, color)
  if color then
    local r, g, b
    if type(color) == "table" then
      r = color.r or color[1] or 1
      g = color.g or color[2] or 1
      b = color.b or color[3] or 1
    else
      r, g, b = 1, 1, 1
    end
    _objSetColor(id, r, g, b)
  end
  return _makeObj(id)
end

-- A wide flat ground plane. Default: 200x200 centered at origin.
function Structure.CreateGround(x, y, z, sizeX, sizeZ, color)
  local id = _structCreate("plane")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, sizeX or 200, 1, sizeZ or 200)
  return _structApply(id, color)
end

-- An axis-aligned box. Use for walls, buildings, platforms, water bodies.
function Structure.CreateBox(x, y, z, sx, sy, sz, color)
  local id = _structCreate("cube")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, sx or 1, sy or 1, sz or 1)
  return _structApply(id, color)
end

-- A thin vertical wall. length runs along world-Z by default; rotY rotates.
function Structure.CreateWall(x, y, z, length, height, rotY, color)
  local id = _structCreate("cube")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, 0.4, height or 4, length or 10)
  if rotY then _objSetRot(id, 0, rotY, 0) end
  return _structApply(id, color)
end

-- A ramp. Default 30° incline (preserves the legacy _objCreate("ramp") tilt).
function Structure.CreateRamp(x, y, z, sx, sy, sz, rotY, color)
  local id = _structCreate("ramp")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, sx or 4, sy or 2, sz or 4)
  if rotY then _objSetRot(id, 30, rotY, 0) end
  return _structApply(id, color)
end

function Structure.CreateCylinder(x, y, z, radius, height, color)
  local id = _structCreate("cylinder")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, (radius or 1) * 2, height or 2, (radius or 1) * 2)
  return _structApply(id, color)
end

function Structure.CreateSphere(x, y, z, radius, color)
  local id = _structCreate("sphere")
  _objSetPos(id, x or 0, y or 0, z or 0)
  local d = (radius or 1) * 2
  _objSetScale(id, d, d, d)
  return _structApply(id, color)
end

-- A flat translucent water plane. Tint with color; alpha is forced via material.
function Structure.CreateWater(x, y, z, sizeX, sizeZ, color)
  local id = _structCreate("plane")
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, sizeX or 40, 1, sizeZ or 40)
  _objSetMat(id, "water")
  return _structApply(id, color or { r = 0.25, g = 0.55, b = 0.75 })
end

-- A textured ground plane with up to 3 slope-blended PBR layers. Layers is an
-- array of { materialType, slopeMin, slopeMax, tiling } tables. The materialType
-- values must come from the Polyhaven vocabulary (grass, dirt, rock, sand,
-- snow, stone, wood, metal, lava, moss, ice, ash) — anything else is silently
-- dropped server-side. Example:
--   Structure.CreateTerrain(0, 0, 0, 100, 100, {
--     { materialType = "grass", slopeMin = 0.0, slopeMax = 0.35, tiling = 8.0 },
--     { materialType = "dirt",  slopeMin = 0.25, slopeMax = 0.65, tiling = 6.0 },
--     { materialType = "rock",  slopeMin = 0.55, slopeMax = 1.0, tiling = 5.0 },
--   })
function Structure.CreateTerrain(x, y, z, sizeX, sizeZ, layers)
  -- Encode layers as a flat string the host can re-parse — simpler than the
  -- table-bridge MoonSharp path and keeps the runtime self-contained. Format:
  --   materialTypeslope_minslope_maxtiling...
  local US = string.char(31)
  local RS = string.char(30)
  local parts = {}
  if type(layers) == "table" then
    for i, l in ipairs(layers) do
      if type(l) == "table" and type(l.materialType) == "string" then
        parts[#parts+1] = l.materialType
          .. US .. tostring(l.slopeMin or 0)
          .. US .. tostring(l.slopeMax or 1)
          .. US .. tostring(l.tiling   or 4)
      end
    end
  end
  local _sx = sizeX or 100
  local _sz = sizeZ or 100
  local id = _structCreateTerrain(table.concat(parts, RS), _sx, _sz)
  _objSetPos(id, x or 0, y or 0, z or 0)
  _objSetScale(id, _sx, 1, _sz)
  local t = _structApply(id)
  -- Sculpt tools — let Claude pull hills up, push pits down, and flatten
  -- plateaus where buildings will sit. Each call updates the server's height
  -- grid and pushes it on the next diff so the Unity client redeforms the
  -- mesh. See LUAU_FORGE_SYSTEM for the world-design mandate.
  function t:RaiseHill(cx, cz, radius, height)
    _terrainRaise(id, cx or 0, cz or 0, radius or 5, height or 1)
    return self
  end
  function t:DigPit(cx, cz, radius, depth)
    _terrainPit(id, cx or 0, cz or 0, radius or 5, depth or 1)
    return self
  end
  function t:Flatten(cx, cz, sx, sz, h)
    _terrainFlatten(id, cx or 0, cz or 0, sx or 5, sz or 5, h or 0)
    return self
  end
  function t:GetHeightAt(cx, cz)
    return _terrainHeightAt(id, cx or 0, cz or 0)
  end
  return t
end

-- ── Player ────────────────────────────────────────────────────────────────────
Player = {}
function Player.SetSpeed(v)              _plrSetSpeed(v) end
function Player.SetJumpHeight(v)         _plrSetJump(v) end
function Player.SetSpawnPoint(x, y, z)  _plrSetSpawn(x, y, z) end
function Player.Teleport(x, y, z)       _plrTeleport(x, y, z) end
function Player.GetPosition()           return _plrGetPos() end
function Player.GetVelocity()           return _plrGetVel() end
function Player.IsGrounded()            return _plrIsGrounded() end
function Player.GetHealth()             return _plrGetHealth() end
function Player.SetHealth(v)            _plrSetHealth(v) end
function Player.AddHealth(v)            _plrAddHealth(v) end
function Player.SetInvincible(en)       _plrSetInvincible(en) end
function Player.AddScore(pts)           _plrAddScore(pts) end
function Player.GetScore()              return _plrGetScore() end
function Player.ShowMessage(txt, dur)   _plrShowMsg(txt, dur or 3) end
function Player.ShowTitle(txt, sub, dur) _plrShowTitle(txt, sub or "", dur or 3) end
function Player.GetDistanceTo(obj)      return _plrDistTo(obj._id) end

-- ── Scene ─────────────────────────────────────────────────────────────────────
Scene = {}
function Scene.SetSkybox(preset)          _sceneSetSkybox(preset) end

-- Procedural skybox descriptor — preferred over SetSkybox. Pass a table with
-- per-game color stops, sun direction, fog, ambient. The Unity client builds
-- a runtime procedural skybox material from these values, no HDRI required.
-- Example:
--   Scene.SetCustomSkybox({
--     topColor    = {0.20, 0.55, 0.95},
--     bottomColor = {0.85, 0.93, 1.00},
--     horizonColor= {0.90, 0.85, 0.75},
--     sunColor    = {1.00, 0.95, 0.85},
--     sunDirection= {50, 30, 0},
--     sunSize     = 0.04,
--     sunIntensity= 1.4,
--     exposure    = 1.2,
--     atmosphereThickness = 1.0,
--     fogColor    = {0.85, 0.93, 1.00},
--     fogDensity  = 0.008,
--     ambientColor= {0.60, 0.65, 0.70},
--     ambientIntensity = 0.8,
--     timeOfDay   = "day",
--   })
function Scene.SetCustomSkybox(d)
  if type(d) ~= "table" then return end
  -- Serialize manually so MoonSharp's table → host bridge stays simple.
  local function _arr(t)
    if type(t) ~= "table" then return nil end
    local r = t.r or t[1]; local g = t.g or t[2]; local b = t.b or t[3]
    if type(r) ~= "number" or type(g) ~= "number" or type(b) ~= "number" then return nil end
    return string.format("[%g,%g,%g]", r, g, b)
  end
  local function _num(v) return type(v) == "number" and tostring(v) or nil end
  local function _str(v) return type(v) == "string" and string.format("%q", v) or nil end
  local fields = {}
  local function _push(k, v) if v then fields[#fields+1] = string.format("%q:%s", k, v) end end
  _push("topColor",            _arr(d.topColor))
  _push("bottomColor",         _arr(d.bottomColor))
  _push("horizonColor",        _arr(d.horizonColor))
  _push("groundColor",         _arr(d.groundColor))
  _push("sunColor",            _arr(d.sunColor))
  _push("sunDirection",        _arr(d.sunDirection))
  _push("fogColor",            _arr(d.fogColor))
  _push("ambientColor",        _arr(d.ambientColor))
  _push("sunSize",             _num(d.sunSize))
  _push("sunIntensity",        _num(d.sunIntensity))
  _push("exposure",            _num(d.exposure))
  _push("atmosphereThickness", _num(d.atmosphereThickness))
  _push("fogDensity",          _num(d.fogDensity))
  _push("ambientIntensity",    _num(d.ambientIntensity))
  _push("starDensity",         _num(d.starDensity))
  _push("cloudDensity",        _num(d.cloudDensity))
  _push("timeOfDay",           _str(d.timeOfDay))
  _sceneSetSkyboxDescriptor("{" .. table.concat(fields, ",") .. "}")
end
function Scene.SetBackgroundColor(r,g,b)  _sceneSetBg(r, g, b) end
function Scene.SetFog(color, density)
  _sceneSetFog(color.r or 0.7, color.g or 0.7, color.b or 0.8, density)
end
function Scene.SetAmbientLight(color, intensity)
  _sceneSetAmbient(color.r or 1, color.g or 1, color.b or 1, intensity)
end
function Scene.SetGravity(v)              _sceneSetGravity(v) end
function Scene.SetGround(t)               end  -- deprecated no-op (terrain is a Meshy model)
function Scene.SetEnvironment(genre)
  local presets = {
    platformer = "clear_blue",
    racer      = "midday",
    puzzle     = "overcast",
    survival   = "stormy",
    adventure  = "warm_day",
    strategy   = "overcast",
    simulation = "midday",
  }
  _sceneSetSkybox(presets[genre] or "midday")
end

-- ── Light ─────────────────────────────────────────────────────────────────────
Light = {}
function Light.Create(ltype, x, y, z)
  local id = _lightCreate(ltype, x, y, z)
  local l = { _id = id }
  function l:SetColor(r, g, b)   _lightSetColor(id, r, g, b) end
  function l:SetIntensity(v)     _lightSetIntensity(id, v) end
  function l:SetRange(v)         _lightSetRange(id, v) end
  return l
end

-- ── Audio ─────────────────────────────────────────────────────────────────────
Audio = {}
function Audio.PlaySound(p)  _audioPlaySound(p) end
function Audio.PlayMusic(p)  _audioPlayMusic(p) end
function Audio.StopMusic()   _audioStopMusic() end

-- ── UI ────────────────────────────────────────────────────────────────────────
UI = {}
function UI.ShowHUD(config)
  _uiShowHUD(
    config.health  ~= false,
    config.score   ~= false,
    config.timer   ~= false
  )
end
function UI.UpdateHUD(key, value) _uiUpdateHUD(key, tostring(value)) end
function UI.ShowPopup(title, body, btn) _uiShowPopup(title, body, btn) end
function UI.ShowCountdown(secs, cb)
  _uiShowCountdown(secs)
  _callbacks.countdown_done = cb
end
function UI.ShowMessage(txt, dur) _uiShowMsg(txt, dur or 3) end
-- Toolbar: pass an array of {name, icon, key, cost?, color?} tables. Mobile
-- players see tappable buttons at the bottom of the screen; tapping fires the
-- configured key through the same input pipeline as a desktop keypress, so
-- your existing key-handling code (if pressed and key == "1" then ...) works.
function UI.SetToolbar(tools)
  if type(tools) ~= "table" then return end
  -- Encode as a flat string the host can re-parse. MoonSharp's table-to-JSON
  -- bridge would work but adds a dependency; encoding manually keeps the
  -- runtime self-contained and avoids quoting edge cases.
  local US = string.char(31)  -- unit separator between fields within a slot
  local RS = string.char(30)  -- record separator between slots
  local parts = {}
  for i, t in ipairs(tools) do
    if type(t) == "table" then
      parts[#parts+1] = (t.name or "") .. US .. (t.icon or "") .. US
        .. (t.key or "") .. US .. tostring(t.cost or "") .. US .. (t.color or "")
    end
  end
  _uiSetToolbar(table.concat(parts, RS))
end
function UI.SetEquippedTool(name) _uiSetEquippedTool(tostring(name or "")) end
function UI.GetEquippedTool() return _uiGetEquippedTool() end

-- ── Game ─────────────────────────────────────────────────────────────────────
Game = {}
function Game.OnUpdate(cb)     _callbacks.update = cb end
function Game.OnStart(cb)      _callbacks.start = cb end
function Game.OnWin(cb)        _callbacks.win = cb end
function Game.OnLose(cb)       _callbacks.lose = cb end
function Game.OnPlayerDied(cb) _callbacks.playerDied = cb end
function Game.SetObjective(txt) _gameSetObjective(txt) end
function Game.SetTimeLimit(s)  _gameSetTimeLimit(s) end
function Game.GetTimeRemaining() return _gameGetTimeRemaining() end
function Game.Restart()        _gameRestart() end
function Game.End(result)      _gameEnd(result) end

-- ── Network ───────────────────────────────────────────────────────────────────
Network = {}
function Network.OnPlayerJoined(cb) _callbacks.playerJoined = cb end
function Network.OnPlayerLeft(cb)   _callbacks.playerLeft = cb end
function Network.GetAllPlayers()    return _netGetAllPlayers() end
function Network.SyncObject(obj)    end
function Network.BroadcastEvent(n, d) end
function Network.OnEvent(n, cb)     end

-- ── Physics ───────────────────────────────────────────────────────────────────
Physics = {}
function Physics.SetGravity(v)   _sceneSetGravity(v) end
function Physics.Raycast(ox, oy, oz, dx, dy, dz, maxDist)
  return _physRaycast(ox, oy, oz, dx, dy, dz, maxDist or 100)
end

-- ── Effects ───────────────────────────────────────────────────────────────────
Effects = {}
function Effects.Spawn(preset, x, y, z)     _fxSpawn(preset, x, y, z) end
function Effects.ScreenShake(i, d)          _fxShake(i, d) end
function Effects.Flash(color, dur)
  _fxFlash(color.r or 1, color.g or 0, color.b or 0, dur)
end

-- ── Timer ────────────────────────────────────────────────────────────────────
Timer = {}
function Timer.After(secs, cb)
  _timerSeq = _timerSeq + 1
  local id = _timerSeq
  _timers[id] = { kind="after", secs=secs, elapsed=0, cb=cb }
  return id
end
function Timer.Every(secs, cb)
  _timerSeq = _timerSeq + 1
  local id = _timerSeq
  _timers[id] = { kind="every", secs=secs, elapsed=0, cb=cb }
  return id
end
function Timer.Cancel(id)
  _timers[id] = nil
end

-- Internal timer tick (called each server frame)
function _tickTimers(dt)
  local done = {}
  for id, t in pairs(_timers) do
    t.elapsed = t.elapsed + dt
    while t.elapsed >= t.secs do
      t.elapsed = t.elapsed - t.secs
      if t.kind == "after" then
        done[#done+1] = id
        t.cb()
        break
      else
        t.cb()
      end
    end
  end
  for _, id in ipairs(done) do _timers[id] = nil end
end

-- ── Environment ───────────────────────────────────────────────────────────────
Environment = {}
function Environment.SpawnObject(t, x, y, z)
  local obj = Object.Create(t)
  if obj then obj:SetPosition(x, y, z) end
  return obj
end
function Environment.SetWeather(preset) end
function Environment.SetTimeOfDay(hour) end

-- ── Input ─────────────────────────────────────────────────────────────────────
Input = {}
function Input.OnAction(cb)       _callbacks.inputAction = cb end
function Input.OnKey(key, cb)     _callbacks["key_"..key] = cb end
function Input.OnSwipe(cb)        _callbacks.inputSwipe = cb end

-- ── Interface buttons ─────────────────────────────────────────────────────────
-- Called when a player taps a HUD button with action="event".
-- name matches the eventName field set in the editor Interface panel.
-- Example: Interface.OnButton("openShop", function() ... end)
Interface = {}
function Interface.OnButton(name, cb)
  _callbacks["hudButton_"..name] = cb
end

-- ── Legacy aliases ────────────────────────────────────────────────────────────
workspace = Object
script = {}
game = Game
task = { wait=function() end, spawn=function(f) if f then f() end end }
`;

// ── CPU time guard ────────────────────────────────────────────────────────────
const MAX_TICK_MS = 8; // kill tick if Lua takes longer than 8ms

// ── LuaRuntime ────────────────────────────────────────────────────────────────

export class LuaRuntime {
  private lua!: LuaEngine;
  private world: WorldState;
  private pendingCreated: EntityState[] = [];
  private pendingUpdated: Map<string, Partial<EntityState>> = new Map();
  private pendingDestroyed: Set<string> = new Set();
  private pendingEvents: UIEvent[] = [];
  private pendingPlayerUpdate: Partial<import('./world-state.js').PlayerState> | null = null;
  private pendingSceneUpdate: Partial<import('./world-state.js').SceneConfig> | null = null;
  // Pending Polyhaven texture resolutions. _structCreateTerrain and
  // _objSetStructMat each kick off an async resolveMaterial() and push the
  // returned Promise here. room-manager._waitForInitialObjectPlacement awaits
  // all of these (capped) before flipping gameReady so the cold-join snapshot
  // already carries every texture URL — no async pop-in on first frame.
  private pendingTextures: Promise<void>[] = [];
  private lastPlayerState: import('./world-state.js').PlayerState;
  private restartRequested = false;
  private loaded = false;
  private players: Map<string, { id: string; username: string }> = new Map();

  // ── Acting-player context ──────────────────────────────────────────────────
  // Every generated game writes its scoring/health logic against the singular
  // `Player.*` API inside a callback:
  //
  //   coin:OnPlayerEnter(function() Player.AddScore(10) end)
  //
  // With one avatar per client, "which Player" is answered by WHO caused the
  // callback to run. `_actingPlayerId` is set for the duration of a single
  // Lua entry point (trigger, collision, key, HUD button, join) and read by
  // `_activePlayer()`; every `_plr*` bridge function resolves through it. When
  // it is null — OnStart, OnUpdate, timers — the API falls back to the primary
  // player exactly as before, so single-player games are unaffected.
  private _actingPlayerId: string | null = null;

  // wasmoon's Lua state is not reentrant: two overlapping `doString` calls on
  // the same engine interleave unpredictably, and the acting-player context
  // above would leak between them. Every Lua entry point is therefore chained
  // through this promise so exactly one runs at a time, in enqueue order.
  private _luaChain: Promise<void> = Promise.resolve();

  // Per-entity set of clientIds currently inside a trigger volume. Replaces the
  // old single `_triggerInside` boolean stashed on the entity, which could only
  // ever track the primary player. Shared by BOTH the server-side AABB sweep in
  // _checkTriggers and the client-reported {type:'trigger_enter'} path, so the
  // two can no longer double-fire the same enter for the same player (which
  // used to award pickups twice).
  private _triggerInsideBy: Map<string, Set<string>> = new Map();

  // External callbacks
  onRestart?: () => void;
  onGameEnd?: (result: string) => void;

  constructor() {
    this.world = createDefaultWorldState();
    this.lastPlayerState = { ...this.world.player };
  }

  async init(gameScript: string): Promise<void> {
    this.lua = await LUA_FACTORY.createEngine({
      openStandardLibs: true, // enables ipairs, pairs, math, string, table, etc.
    });

    // Remove dangerous globals — file I/O, OS access, dynamic code loading
    await this.lua.doString(`
      os             = nil
      io             = nil
      require        = nil
      package        = nil
      debug          = nil
      load           = nil
      loadfile       = nil
      dofile         = nil
      collectgarbage = nil
    `);

    // Register all JS → Lua bridge functions
    this._registerBridge();

    // Inject preamble + game script
    const fullScript = LUA_PREAMBLE + '\n' + this._sanitize(gameScript);
    await this.lua.doString(fullScript);

    this.world.gameRunning = true;
    this.loaded = true;

    // Fire OnStart
    await this._callLua('if _callbacks.start then _callbacks.start() end');
  }

  // Decode the packed terrain-layer string emitted by Structure.CreateTerrain.
  // Format: rows of "<materialType><US>slopeMin<US>slopeMax<US>tiling" joined
  // by ASCII RS (chr 30). Unknown materialTypes are dropped so a typo in the
  // generated script doesn't leak a broken layer into the shader.
  private _parseTerrainLayers(packed: string): TerrainLayer[] {
    if (!packed) return [];
    const RS = String.fromCharCode(30);
    const US = String.fromCharCode(31);
    const out: TerrainLayer[] = [];
    for (const row of packed.split(RS)) {
      const parts = row.split(US);
      if (parts.length < 4) continue;
      const materialType = parts[0].trim();
      if (!materialType) continue;
      out.push({
        materialType,
        slopeMin: Number(parts[1]) || 0,
        slopeMax: Number(parts[2]) || 1,
        tiling:   Number(parts[3]) || 4,
      });
    }
    return out;
  }

  // Resolve one terrain layer's materialType to Polyhaven URLs, patch them
  // back onto the entity once available, and mark the entity updated so the
  // next diff broadcast picks up the new fields. The Promise is tracked on
  // pendingTextures so room init can await it.
  private _resolveLayerAsync(entityId: string, layerIndex: number, materialType: string): void {
    const p = resolveMaterial(materialType).then(resolved => {
      if (!resolved) return;
      const ent = this.world.entities.get(entityId);
      if (!ent || !ent.terrainLayers || !ent.terrainLayers[layerIndex]) return;
      const layer = ent.terrainLayers[layerIndex];
      layer.albedoUrl    = resolved.albedoUrl;
      layer.normalUrl    = resolved.normalUrl;
      layer.roughnessUrl = resolved.roughnessUrl;
      const prev = this.pendingUpdated.get(entityId) ?? {};
      this.pendingUpdated.set(entityId, { ...prev, terrainLayers: ent.terrainLayers.map(l => ({ ...l })) });
    });
    this.pendingTextures.push(p);
  }

  // Search every terrain entity for one whose XZ footprint covers (wx, wz).
  // Returns its bilinearly-sampled height, or null when no terrain covers the
  // point (Claude built a non-terrain world, or the point is outside any
  // terrain's bounds — e.g. a sky platform off the side of the map).
  private _findTerrainHeightAt(wx: number, wz: number): number | null {
    for (const ent of this.world.entities.values()) {
      if (ent.type !== 'terrain' || !ent.terrainHeights || !ent.terrainSize) continue;
      const [tx, , tz] = ent.position;
      const [sx, sz] = ent.terrainSize;
      if (Math.abs(wx - tx) > sx / 2 || Math.abs(wz - tz) > sz / 2) continue;
      return this._terrainHeightAtWorld(ent, wx, wz);
    }
    return null;
  }

  // Bilinear-sample the terrain entity's height grid at world XZ. Returns 0
  // when (x, z) falls outside the terrain's footprint, or when the grid is
  // missing (entity isn't a sculpted terrain). Reused by `_terrainHeightAt`
  // Lua binding AND by the auto-snap path on entity creation.
  private _terrainHeightAtWorld(ent: EntityState, wx: number, wz: number): number {
    if (!ent.terrainHeights || !ent.terrainSize) return 0;
    const [tx, , tz] = ent.position;
    const [sx, sz] = ent.terrainSize;
    const half_x = sx / 2;
    const half_z = sz / 2;
    // Local 0..1 inside the terrain footprint.
    const u = (wx - (tx - half_x)) / sx;
    const v = (wz - (tz - half_z)) / sz;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const N = TERRAIN_GRID_SIZE;
    const fi = u * (N - 1);
    const fj = v * (N - 1);
    const i0 = Math.floor(fi); const i1 = Math.min(N - 1, i0 + 1);
    const j0 = Math.floor(fj); const j1 = Math.min(N - 1, j0 + 1);
    const tu = fi - i0;
    const tv = fj - j0;
    const h = ent.terrainHeights;
    const h00 = h[j0 * N + i0];
    const h10 = h[j0 * N + i1];
    const h01 = h[j1 * N + i0];
    const h11 = h[j1 * N + i1];
    const a = h00 * (1 - tu) + h10 * tu;
    const b = h01 * (1 - tu) + h11 * tu;
    return a * (1 - tv) + b * tv;
  }

  // Append a sculpt op, re-derive the cells it touches in the cached grid,
  // and mark the entity updated so the next diff carries `terrainHeights`
  // (and the op list for completeness) to the client.
  private _applySculpt(id: string, op: TerrainSculptOp): void {
    const ent = this.world.entities.get(id);
    if (!ent || !ent.terrainHeights || !ent.terrainSize || !ent.terrainSculpts) return;
    const [tx, , tz] = ent.position;
    const [sx, sz] = ent.terrainSize;
    const N = TERRAIN_GRID_SIZE;
    // World XZ per grid cell.
    const stepX = sx / (N - 1);
    const stepZ = sz / (N - 1);
    const cellWorld = (i: number, j: number): [number, number] => [
      (tx - sx / 2) + i * stepX,
      (tz - sz / 2) + j * stepZ,
    ];

    if (op.op === 'raise' || op.op === 'pit') {
      const amt = op.op === 'raise' ? op.height : -op.depth;
      const r = op.radius;
      // Restrict the loop to cells within the AABB of the affected disc.
      const iMin = Math.max(0, Math.floor((op.x - r - (tx - sx / 2)) / stepX));
      const iMax = Math.min(N - 1, Math.ceil((op.x + r - (tx - sx / 2)) / stepX));
      const jMin = Math.max(0, Math.floor((op.z - r - (tz - sz / 2)) / stepZ));
      const jMax = Math.min(N - 1, Math.ceil((op.z + r - (tz - sz / 2)) / stepZ));
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          const [wxC, wzC] = cellWorld(i, j);
          const d = Math.hypot(wxC - op.x, wzC - op.z);
          if (d > r) continue;
          // Smooth bell: (1 - smoothstep(0, r, d))^2 — flat-topped at center,
          // soft tail at the rim. Squaring keeps the shape from looking
          // too narrow at typical radii (5-20).
          const t = d / r;
          const s = 1 - (t * t * (3 - 2 * t));
          ent.terrainHeights[j * N + i] += amt * s * s;
        }
      }
    } else if (op.op === 'flatten') {
      // Set every cell in the rectangle to exactly `height`. Hard-edged on
      // purpose — Claude calls Flatten precisely so building footprints are
      // tilt-free, and a feathered edge would defeat that intent.
      const x0 = op.x - op.sizeX / 2;
      const x1 = op.x + op.sizeX / 2;
      const z0 = op.z - op.sizeZ / 2;
      const z1 = op.z + op.sizeZ / 2;
      const iMin = Math.max(0, Math.floor((x0 - (tx - sx / 2)) / stepX));
      const iMax = Math.min(N - 1, Math.ceil((x1 - (tx - sx / 2)) / stepX));
      const jMin = Math.max(0, Math.floor((z0 - (tz - sz / 2)) / stepZ));
      const jMax = Math.min(N - 1, Math.ceil((z1 - (tz - sz / 2)) / stepZ));
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          const [wxC, wzC] = cellWorld(i, j);
          if (wxC < x0 || wxC > x1 || wzC < z0 || wzC > z1) continue;
          ent.terrainHeights[j * N + i] = op.height;
        }
      }
    }

    ent.terrainSculpts.push(op);
    const prev = this.pendingUpdated.get(id) ?? {};
    this.pendingUpdated.set(id, { ...prev, terrainHeights: ent.terrainHeights.slice() });
  }

  // Awaited by room-manager._waitForInitialObjectPlacement to gate gameReady
  // on first-frame textures. Resolves immediately when nothing is pending.
  // Returns once all currently-tracked Polyhaven resolutions complete OR
  // `capMs` elapses (defense against a single slow fetch blocking everyone).
  //
  // Cap sizing: a cache-miss fetch is one Polyhaven `/files/<slug>` call +
  // three parallel JPG downloads + three R2 uploads, observed to run in
  // 4-6 seconds per slug on a cold cache. A new game with ~4 distinct
  // materialTypes can take 8-10s of wall time even with our per-slug
  // concurrency. 12s gives one slow slug some headroom; after the first
  // forge per type the R2 keyExists short-circuit puts every subsequent
  // resolve under 100ms, making the cap effectively irrelevant.
  async awaitPendingTextures(capMs = 12000): Promise<void> {
    if (this.pendingTextures.length === 0) return;
    await Promise.race([
      Promise.allSettled(this.pendingTextures),
      new Promise(res => setTimeout(res, capMs)),
    ]);
  }

  async tick(dt: number, inputs: ClientInput[]): Promise<StateDiff> {
    const start = Date.now();

    // Process client inputs
    for (const input of inputs) {
      this._applyInput(input, dt);
    }

    // Physics step for dynamic entities
    this._stepPhysics(dt);

    // Check trigger overlaps (server-side AABB)
    this._checkTriggers();

    // Time limit
    if (this.world.timeLimitSecs > 0) {
      this.world.timeElapsed += dt;
      const remaining = Math.max(0, this.world.timeLimitSecs - this.world.timeElapsed);
      if (remaining <= 0 && this.world.gameRunning) {
        this.world.gameRunning = false;
        this._queueEvent('game_end', { result: 'lose', message: "Time's up!" });
      }
    }

    // Tick Lua timers + OnUpdate
    const elapsed = Date.now() - start;
    if (elapsed < MAX_TICK_MS) {
      try {
        await this._callLua(`_tickTimers(${dt})`);
        if (this.world.gameRunning) {
          await this._callLua(`if _callbacks.update then _callbacks.update(${dt}) end`);
        }
      } catch (e) {
        console.warn('[LuaRuntime] tick error:', e);
      }
    }

    this.world.tickNumber++;

    return this._flushDiff();
  }

  async hot_reload(newScript: string): Promise<void> {
    // Preserve only player stats — entity world is rebuilt from scratch by the new
    // script's OnStart.  Saving the old entities caused ghost objects: they would
    // persist alongside freshly-created entities from the new _callbacks.start().
    const savedPlayer  = { ...this.world.player };
    const savedSim     = new Map(this.world.simPlayers);
    const savedPrimary = this._primaryId;
    const oldLua       = this.lua;
    const oldWorld     = this.world;

    // Build the replacement engine BEFORE closing the old one so a script error
    // restores rather than destroys the running game state.
    const newLua   = await LUA_FACTORY.createEngine({ openStandardLibs: true });
    const newWorld = createDefaultWorldState();
    newWorld.player      = savedPlayer;
    newWorld.gameRunning = true;
    // Carry connected players across the reload, preserving positions. The
    // primary aliases the new world.player so Lua logic keeps its target.
    for (const [cid, oldP] of savedSim) {
      newWorld.simPlayers.set(cid, cid === savedPrimary ? newWorld.player : { ...oldP });
    }

    // Redirect this.lua / this.world so _registerBridge() targets the new engine.
    this.lua   = newLua;
    this.world = newWorld;

    try {
      await newLua.doString(`os=nil;io=nil;require=nil;package=nil;debug=nil;load=nil;loadfile=nil;dofile=nil;collectgarbage=nil`);
      this._registerBridge();
      const full = LUA_PREAMBLE + '\n' + this._sanitize(newScript);
      await newLua.doString(full);
      await this._callLua('if _callbacks.start then _callbacks.start() end');
      // Commit success — release old engine.
      try { oldLua.global.close(); } catch {}
    } catch (e) {
      // New script failed — discard the failed engine and restore previous state.
      try { newLua.global.close(); } catch {}
      this.lua   = oldLua;
      this.world = oldWorld;
      // Discard any partial entity/event state written by the failed script.
      this.pendingCreated  = [];
      this.pendingUpdated.clear();
      this.pendingDestroyed.clear();
      this.pendingEvents   = [];
      throw e;
    }
  }

  // Called by room when a player triggers a zone. `clientId` identifies WHICH
  // player crossed the volume — it becomes the acting player for the callback,
  // so a `Player.AddScore(10)` inside credits the collector rather than always
  // the first-joined client.
  //
  // Enter/exit are latched per (entity, player) in `_triggerInsideBy`. The Unity
  // client's physics callbacks and the server's own AABB sweep both land here,
  // and before the latch they each fired the same enter — a coin worth 10 was
  // routinely worth 20. Now whichever path notices the crossing first wins and
  // the other is a no-op until the player actually leaves.
  firePlayerEnterTrigger(entityId: string, clientId?: string): void {
    const who = clientId ?? this._primaryId ?? '';
    let inside = this._triggerInsideBy.get(entityId);
    if (!inside) { inside = new Set(); this._triggerInsideBy.set(entityId, inside); }
    if (inside.has(who)) return;
    inside.add(who);
    this._callLua(
      `local cb = _callbacks["trigger_enter_${entityId}"] if cb then cb() end`,
      who || null,
    ).catch(() => {});
  }

  firePlayerExitTrigger(entityId: string, clientId?: string): void {
    const who = clientId ?? this._primaryId ?? '';
    const inside = this._triggerInsideBy.get(entityId);
    if (!inside || !inside.has(who)) return;
    inside.delete(who);
    if (inside.size === 0) this._triggerInsideBy.delete(entityId);
    this._callLua(
      `local cb = _callbacks["trigger_exit_${entityId}"] if cb then cb() end`,
      who || null,
    ).catch(() => {});
  }

  fireCollision(entityId: string, otherName: string, clientId?: string): void {
    this._callLua(
      `local cb = _callbacks["collision_${entityId}"] if cb then cb("${otherName}") end`,
      clientId ?? null,
    ).catch(() => {});
  }

  fireHudEvent(eventName: string, clientId?: string): void {
    const safe = eventName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    this._callLua(
      `local cb = _callbacks["hudButton_${safe}"] if cb then cb() end`,
      clientId ?? null,
    ).catch(() => {});
  }

  fireInputKey(key: string, clientId?: string): void {
    this._callLua(
      `local cb = _callbacks["key_${key}"] if cb then cb() end`,
      clientId ?? null,
    ).catch(() => {});
  }

  fireInputAction(clientId?: string): void {
    this._callLua(
      `if _callbacks.inputAction then _callbacks.inputAction() end`,
      clientId ?? null,
    ).catch(() => {});
  }

  fireSwipe(dir: string, clientId?: string): void {
    this._callLua(
      `if _callbacks.inputSwipe then _callbacks.inputSwipe("${dir}") end`,
      clientId ?? null,
    ).catch(() => {});
  }

  firePlayerJoined(playerId: string, username: string): void {
    const safe = username.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    this.players.set(playerId, { id: playerId, username });
    this._callLua(
      `if _callbacks.playerJoined then _callbacks.playerJoined({id="${playerId}", username="${safe}"}) end`,
      playerId,
    ).catch(() => {});
  }

  firePlayerLeft(playerId: string): void {
    this.players.delete(playerId);
    this._callLua(
      `if _callbacks.playerLeft then _callbacks.playerLeft("${playerId}") end`
    ).catch(() => {});
  }

  // Set the equipped toolbar slot from outside Lua (e.g. when a mobile player
  // taps a button via the equipTool ws message). Marks the diff dirty so all
  // connected clients pick up the highlight. No-op if the world has no toolbar
  // registered yet — the script must call UI.SetToolbar first to opt in.
  setEquippedTool(name: string): void {
    if (!this.world.toolbar) this.world.toolbar = { tools: [], equipped: '' };
    this.world.toolbar.equipped = name;
    this._toolbarDirty = true;
  }

  // Snap the player back to their spawn point and zero velocity. Triggered by
  // a client {type:'respawn'} message after it detects it has fallen below the
  // void threshold, and re-used by the server's own y<-5 safety net.
  respawnPlayerToSpawn(clientId?: string): void {
    const p = (clientId && this.world.simPlayers.get(clientId)) || this.world.player;
    p.position[0] = p.spawnPoint[0];
    p.position[1] = Math.max(p.spawnPoint[1], 1);
    p.position[2] = p.spawnPoint[2];
    p.velocity[0] = 0;
    p.velocity[1] = 0;
    p.velocity[2] = 0;
    p.moveIntent = [0, 0]; // don't carry momentum through a teleport
    p.grounded = true;
    // pendingPlayerUpdate only feeds the legacy single-player diff path; the
    // per-client diff in room-manager streams each player's full state anyway.
    if (!clientId || this.world.simPlayers.get(clientId) === this.world.player) {
      this.pendingPlayerUpdate = {
        ...(this.pendingPlayerUpdate ?? {}),
        position: [...p.position] as [number, number, number],
        velocity: [...p.velocity] as [number, number, number],
        grounded: true,
      };
    }
  }

  // Register a per-client simulated player. The first player to join REUSES the
  // canonical world.player object so all existing Lua game logic keeps acting on
  // it; later joiners get their own PlayerState cloned from the game's configured
  // spawn/speed/jump settings. Idempotent.
  addPlayer(clientId: string): void {
    if (this.world.simPlayers.has(clientId)) return;
    let p: import('./world-state.js').PlayerState;
    if (this.world.simPlayers.size === 0) {
      p = this.world.player;
      this._primaryId = clientId;
    } else {
      p = createDefaultPlayer();
      const prim = this.world.player;
      // Creator-placed spawn markers (world.spawnPoints, populated from
      // editor_state_json — see Room._applyEditorStateOverlay) spread each
      // newly-joining player across a random marker instead of stacking
      // everyone on the primary player's single spawnPoint.
      p.spawnPoint = this.world.spawnPoints.length > 0
        ? [...this.world.spawnPoints[Math.floor(Math.random() * this.world.spawnPoints.length)]] as [number, number, number]
        : [...prim.spawnPoint] as [number, number, number];
      p.speed      = prim.speed;
      p.jumpHeight = prim.jumpHeight;
    }
    p.position = [p.spawnPoint[0], Math.max(p.spawnPoint[1], 1), p.spawnPoint[2]];
    p.velocity = [0, 0, 0];
    p.moveIntent = [0, 0];
    p.grounded = true;
    this.world.simPlayers.set(clientId, p);
  }

  // Remove a client's simulated player. If it was the primary, re-point
  // world.player at another connected player so Lua logic keeps a live target.
  removePlayer(clientId: string): void {
    this.world.simPlayers.delete(clientId);
    this._lastGroundedAtById.delete(clientId);
    this._lastClientGroundYById.delete(clientId);
    // Clear this client's trigger latches so a rejoining player (same room, new
    // clientId) isn't blocked by a stale "already inside" entry, and so the sets
    // don't grow unbounded over a long-lived room.
    for (const [id, inside] of this._triggerInsideBy) {
      if (inside.delete(clientId) && inside.size === 0) this._triggerInsideBy.delete(id);
    }
    if (this._primaryId === clientId) {
      const next = this.world.simPlayers.entries().next();
      if (!next.done) {
        this._primaryId   = next.value[0];
        this.world.player = next.value[1];
      } else {
        this._primaryId = null;
        // No players left — keep world.player as-is (idle-room behavior).
      }
    }
  }

  getWorldState(): WorldState { return this.world; }

  destroy(): void {
    try { this.lua?.global.close(); } catch {}
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _registerBridge(): void {
    const g = this.lua.global;
    const w = this.world;

    // ── Object API ──────────────────────────────────────────────────────────
    g.set('_objCreate', (type: string): string => {
      const id = randomUUID();
      const e = createDefaultEntity(id, type);
      // Apply type-specific defaults
      if (type === 'ramp' || type === 'wedge') e.rotation = [30, 0, 0];
      if (type === 'sphere') e.scale = [1, 1, 1];
      // Force every primitive (cube/sphere/cylinder/capsule/plane/ramp/wedge
      // and the cube-fallback default) to spawn invisible. The system prompt
      // tells Claude to use Meshy models for everything visible and only use
      // primitives for invisible collision geometry / kill zones / triggers,
      // but generated scripts still occasionally drop in a stray visible
      // cube as filler — those leak through into existing saved games as
      // visible placeholder boxes. Auto-hiding here removes them everywhere
      // (existing games and future ones) without breaking the legitimate
      // "invisible barrier" use case, which already wanted SetVisible(false).
      // Lights and Meshy models keep their default visibility. Visible
      // procedural ground/walls go through Structure.* → _structCreate.
      if (!type.startsWith('model:') && !type.startsWith('light:'))
        e.visible = false;
      w.entities.set(id, e);
      this.pendingCreated.push({ ...e });
      return id;
    });

    // Structure API: same primitive types as _objCreate but marked structural
    // so they spawn visible and SetVisible(true) is honored on them. Use
    // these for procedural ground/walls/ramps. Stray Object.Create("cube")
    // calls remain force-hidden — the lock only releases for explicitly
    // structural entities.
    g.set('_structCreate', (type: string): string => {
      const id = randomUUID();
      const e = createDefaultEntity(id, type);
      if (type === 'ramp' || type === 'wedge') e.rotation = [30, 0, 0];
      if (type === 'sphere') e.scale = [1, 1, 1];
      e.visible    = true;
      e.structural = true;
      w.entities.set(id, e);
      this.pendingCreated.push({ ...e });
      return id;
    });

    // Triplanar terrain: a structural plane carrying up to 3 slope-blended
    // PBR layers. The packed string format is RecordSeparator-delimited rows
    // of "materialType{US}slopeMin{US}slopeMax{US}tiling" (see the matching
    // Structure.CreateTerrain Lua wrapper). Each unique materialType triggers
    // a polyhaven.resolveMaterial() which populates the layer URLs and marks
    // the entity updated once the texture set is ready.
    g.set('_structCreateTerrain', (packed: string, sizeX: number, sizeZ: number): string => {
      const id = randomUUID();
      const e = createDefaultEntity(id, 'terrain');
      e.visible    = true;
      e.structural = true;
      e.terrainLayers = this._parseTerrainLayers(packed).slice(0, 3); // shader supports up to 3
      // Seed sculpted-terrain state. Grid starts flat (all zeros); each
      // RaiseHill/DigPit/Flatten call appends an op and re-derives the grid.
      // Clients receive `terrainHeights` + `terrainSize` on the create diff and
      // build a 64-segment deformable mesh sized to (sizeX, sizeZ).
      e.terrainSize    = [Number(sizeX) || 100, Number(sizeZ) || 100];
      e.terrainSculpts = [];
      e.terrainHeights = new Array(TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE).fill(0);
      w.entities.set(id, e);
      this.pendingCreated.push({ ...e });
      // Fire async texture resolution per unique materialType. Track on
      // pendingTextures so room init waits before snapshot-out.
      for (let i = 0; i < e.terrainLayers.length; i++) {
        const layer = e.terrainLayers[i];
        this._resolveLayerAsync(id, i, layer.materialType);
      }
      return id;
    });

    // Terrain sculpting bindings. Each writer appends a TerrainSculptOp, then
    // mutates the cached row-major height grid in place. The grid + ops list
    // are marked updated so they ship on the next diff; clients deform the
    // mesh from the grid. Server-side helpers (`terrainHeightAtWorld`,
    // `_applySculpt`) live below the wasmoon-binding block.
    g.set('_terrainRaise', (id: string, wx: number, wz: number, radius: number, height: number) => {
      this._applySculpt(id, { op: 'raise', x: Number(wx)||0, z: Number(wz)||0, radius: Math.max(0.001, Number(radius)||1), height: Number(height)||0 });
    });
    g.set('_terrainPit', (id: string, wx: number, wz: number, radius: number, depth: number) => {
      this._applySculpt(id, { op: 'pit', x: Number(wx)||0, z: Number(wz)||0, radius: Math.max(0.001, Number(radius)||1), depth: Number(depth)||0 });
    });
    g.set('_terrainFlatten', (id: string, wx: number, wz: number, sx: number, sz: number, h: number) => {
      this._applySculpt(id, { op: 'flatten', x: Number(wx)||0, z: Number(wz)||0, sizeX: Math.max(0.001, Number(sx)||1), sizeZ: Math.max(0.001, Number(sz)||1), height: Number(h)||0 });
    });
    g.set('_terrainHeightAt', (id: string, wx: number, wz: number): number => {
      const e = w.entities.get(id);
      if (!e || !e.terrainHeights || !e.terrainSize) return 0;
      return this._terrainHeightAtWorld(e, Number(wx)||0, Number(wz)||0);
    });

    // PBR material on a structural object (single-layer mode of Pludo/Terrain).
    // Called by the polymorphic obj:SetMaterial(materialType, tiling, rough).
    g.set('_objSetStructMat', (id: string, materialType: string, tiling: number, roughness: number) => {
      const e = w.entities.get(id);
      if (!e || !e.structural) return;
      e.structureMaterial = {
        materialType: String(materialType),
        tiling: Number(tiling) || 4,
        roughness: Number(roughness) || 0.7,
      };
      const existing = this.pendingUpdated.get(id) ?? {};
      this.pendingUpdated.set(id, { ...existing, structureMaterial: { ...e.structureMaterial } });
      // Kick off Polyhaven resolution and patch URLs in when done.
      const p = resolveMaterial(e.structureMaterial.materialType).then(resolved => {
        if (!resolved) return;
        const ent = w.entities.get(id);
        if (!ent || !ent.structureMaterial) return;
        ent.structureMaterial.albedoUrl    = resolved.albedoUrl;
        ent.structureMaterial.normalUrl    = resolved.normalUrl;
        ent.structureMaterial.roughnessUrl = resolved.roughnessUrl;
        const prev = this.pendingUpdated.get(id) ?? {};
        this.pendingUpdated.set(id, { ...prev, structureMaterial: { ...ent.structureMaterial } });
      });
      this.pendingTextures.push(p);
    });

    g.set('_objDestroy', (id: string) => {
      w.entities.delete(id);
      // Remove from pending created if never sent
      const ci = this.pendingCreated.findIndex(e => e.id === id);
      if (ci !== -1) this.pendingCreated.splice(ci, 1);
      else this.pendingDestroyed.add(id);
    });

    g.set('_objClone', (id: string): string => {
      const src = w.entities.get(id);
      if (!src) return '';
      const newId = randomUUID();
      const clone = { ...src, id: newId };
      w.entities.set(newId, clone);
      this.pendingCreated.push({ ...clone });
      return newId;
    });

    // Transform setters
    const markUpdated = (id: string, patch: Partial<EntityState>) => {
      const e = w.entities.get(id);
      if (!e) return;
      Object.assign(e, patch);
      const existing = this.pendingUpdated.get(id) ?? {};
      this.pendingUpdated.set(id, { ...existing, ...patch });
    };

    g.set('_objSetPos', (id: string, x: number, y: number, z: number) => {
      // Auto-snap: for meshy props and primitives placed on top of a sculpted
      // terrain, treat the script's Y as a ground-relative offset. The server
      // adds the terrain height at the entity's XZ so trees, NPCs and houses
      // ride the surface no matter how Claude sculpted it. Skip the terrain
      // itself, other structural primitives (Claude positioned those on
      // purpose), and lights (lamp posts are usually placed at a specific
      // absolute height).
      const ent = w.entities.get(id);
      let lifted = y;
      if (ent
          && !ent.structural
          && ent.type !== 'terrain'
          && !ent.type.startsWith('light:')) {
        const tH = this._findTerrainHeightAt(x, z);
        if (tH !== null) lifted = y + tH;
      }
      markUpdated(id, { position: [x, lifted, z] });
    });
    g.set('_objSetRot', (id: string, x: number, y: number, z: number) =>
      markUpdated(id, { rotation: [x, y, z] }));
    g.set('_objSetScale', (id: string, x: number, y: number, z: number) =>
      markUpdated(id, { scale: [x, y, z] }));
    g.set('_objSetColor', (id: string, r: number, g: number, b: number) =>
      markUpdated(id, { color: [r, g, b] }));
    g.set('_objSetMat', (id: string, m: string) =>
      markUpdated(id, { material: m }));
    g.set('_objSetPhysics', (id: string, en: boolean) =>
      markUpdated(id, { physics: en, isStatic: !en }));
    g.set('_objSetStatic', (id: string, en: boolean) =>
      markUpdated(id, { isStatic: en }));
    g.set('_objSetVisible', (id: string, en: boolean) => {
      const ent = w.entities.get(id);
      if (!ent) return;
      // Lock primitives to invisible: same rationale as the _objCreate
      // auto-hide above. Without this, a generated script that flips
      // SetVisible(true) on a stray cube could re-introduce the
      // placeholder geometry the auto-hide is meant to suppress. Models,
      // lights, and Structure.*-created primitives (ent.structural) all
      // respect SetVisible(true/false) normally.
      if (en && !ent.type.startsWith('model:') && !ent.type.startsWith('light:') && !ent.structural) return;
      markUpdated(id, { visible: en });
    });
    g.set('_objSetTag', (id: string, tag: string) =>
      markUpdated(id, { tag }));
    g.set('_objSetName', (id: string, name: string) =>
      markUpdated(id, { name }));
    g.set('_objSetVel', (id: string, x: number, y: number, z: number) =>
      markUpdated(id, { velocity: [x, y, z], physics: true, isStatic: false }));
    g.set('_objSetEmissive', (id: string, r: number, gb: number, b: number, i: number) =>
      markUpdated(id, { emissive: [r, gb, b, i] }));
    g.set('_objSetParent', (id: string, parentId: string) =>
      markUpdated(id, { parentId }));
    g.set('_objDetach', (id: string) =>
      markUpdated(id, { parentId: undefined }));
    g.set('_objSetTrigger', (id: string, en: boolean) =>
      markUpdated(id, { hasTrigger: en }));
    g.set('_objSetCollision', (id: string, en: boolean) =>
      markUpdated(id, { hasCollision: en }));

    // Apply impulse force by boosting velocity
    g.set('_objApplyForce', (id: string, x: number, y: number, z: number) => {
      const e = w.entities.get(id);
      if (!e) return;
      const v: [number, number, number] = [
        e.velocity[0] + x,
        e.velocity[1] + y,
        e.velocity[2] + z,
      ];
      markUpdated(id, { velocity: v, physics: true, isStatic: false });
    });

    // Transform getters
    g.set('_objGetPos', (id: string) => {
      const e = w.entities.get(id);
      return e ? { x: e.position[0], y: e.position[1], z: e.position[2] } : { x: 0, y: 0, z: 0 };
    });
    g.set('_objGetRot', (id: string) => {
      const e = w.entities.get(id);
      return e ? { x: e.rotation[0], y: e.rotation[1], z: e.rotation[2] } : { x: 0, y: 0, z: 0 };
    });
    g.set('_objGetScale', (id: string) => {
      const e = w.entities.get(id);
      return e ? { x: e.scale[0], y: e.scale[1], z: e.scale[2] } : { x: 1, y: 1, z: 1 };
    });
    g.set('_objGetVel', (id: string) => {
      const e = w.entities.get(id);
      return e ? { x: e.velocity[0], y: e.velocity[1], z: e.velocity[2] } : { x: 0, y: 0, z: 0 };
    });

    // Directional methods using server-side player position
    g.set('_objLookAt', (id: string, tx: number, ty: number, tz: number) => {
      const e = w.entities.get(id);
      if (!e) return;
      const dx = tx - e.position[0];
      const dz = tz - e.position[2];
      const yaw = Math.atan2(dx, dz) * (180 / Math.PI);
      markUpdated(id, { rotation: [e.rotation[0], yaw, e.rotation[2]] });
    });

    g.set('_objLookAtPlayer', (id: string) => {
      const e = w.entities.get(id);
      if (!e) return;
      const p = this._nearestPlayerTo(e.position);
      const dx = p.position[0] - e.position[0];
      const dz = p.position[2] - e.position[2];
      const yaw = Math.atan2(dx, dz) * (180 / Math.PI);
      markUpdated(id, { rotation: [e.rotation[0], yaw, e.rotation[2]] });
    });

    g.set('_objDistPlayer', (id: string): number => {
      const e = w.entities.get(id);
      if (!e) return 0;
      const p = this._nearestPlayerTo(e.position);
      return Math.sqrt(
        (e.position[0] - p.position[0]) ** 2 +
        (e.position[1] - p.position[1]) ** 2 +
        (e.position[2] - p.position[2]) ** 2,
      );
    });

    g.set('_objDistTo', (id: string, otherId: string): number => {
      const a = w.entities.get(id);
      const b = w.entities.get(otherId);
      if (!a || !b) return 0;
      return Math.sqrt(
        (a.position[0] - b.position[0]) ** 2 +
        (a.position[1] - b.position[1]) ** 2 +
        (a.position[2] - b.position[2]) ** 2,
      );
    });

    // ── Player API ──────────────────────────────────────────────────────────
    // Writes land on the ACTING player (see _activePlayer). `pendingPlayerUpdate`
    // only feeds the legacy single-player diff channel, which every client reads
    // as "your player" — so it must only be written when the acting player IS
    // the primary. Otherwise P2 scoring a point would push P2's score into P1's
    // diff. Non-primary players are covered by the per-client state that
    // room-manager assembles from `simPlayers` every tick.
    const markPlayer = (patch: Partial<typeof w.player>) => {
      const target = this._activePlayer();
      Object.assign(target, patch);
      if (target === w.player) {
        this.pendingPlayerUpdate = { ...(this.pendingPlayerUpdate ?? {}), ...patch };
      }
    };

    g.set('_plrSetSpeed', (v: number) => markPlayer({ speed: v }));
    g.set('_plrSetJump', (v: number) => markPlayer({ jumpHeight: v }));
    // Both of these relocate the avatar, so they clear moveIntent as well as
    // velocity — otherwise the acceleration ramp would keep driving the player
    // in their pre-teleport direction the instant they land at the new spot.
    g.set('_plrSetSpawn', (x: number, y: number, z: number) => {
      markPlayer({ spawnPoint: [x, y, z], position: [x, y, z], velocity: [0, 0, 0], moveIntent: [0, 0] });
    });
    g.set('_plrTeleport', (x: number, y: number, z: number) => {
      markPlayer({ position: [x, y, z], velocity: [0, 0, 0], moveIntent: [0, 0] });
    });
    g.set('_plrGetPos', () => {
      const p = this._activePlayer();
      return { x: p.position[0], y: p.position[1], z: p.position[2] };
    });
    g.set('_plrGetVel', () => {
      const p = this._activePlayer();
      return { x: p.velocity[0], y: p.velocity[1], z: p.velocity[2] };
    });
    g.set('_plrIsGrounded', () => this._activePlayer().grounded);
    g.set('_plrGetHealth', () => this._activePlayer().health);
    g.set('_plrSetHealth', (v: number) => {
      const p = this._activePlayer();
      const wasAlive = p.health > 0;
      markPlayer({ health: Math.max(0, Math.min(100, v)) });
      if (wasAlive && p.health <= 0) {
        this._callLua('if _callbacks.playerDied then _callbacks.playerDied() end',
                      this._actingPlayerId).catch(() => {});
      }
    });
    g.set('_plrAddHealth', (v: number) => {
      const p = this._activePlayer();
      if (p.invincible && v < 0) return;
      const wasAlive = p.health > 0;
      const newH = Math.max(0, Math.min(100, p.health + v));
      markPlayer({ health: newH });
      if (wasAlive && newH <= 0) {
        this._callLua('if _callbacks.playerDied then _callbacks.playerDied() end',
                      this._actingPlayerId).catch(() => {});
      }
    });
    g.set('_plrSetInvincible', (en: boolean) => markPlayer({ invincible: en }));
    g.set('_plrAddScore', (pts: number) => markPlayer({ score: this._activePlayer().score + pts }));
    g.set('_plrGetScore', () => this._activePlayer().score);
    g.set('_plrShowMsg', (txt: string, dur: number) =>
      this._queueEvent('message', { text: txt, duration: dur }));
    g.set('_plrShowTitle', (txt: string, sub: string, dur: number) =>
      this._queueEvent('title', { title: txt, subtitle: sub, duration: dur }));
    g.set('_plrDistTo', (objId: string): number => {
      const e = w.entities.get(objId);
      if (!e) return 0;
      const p = this._activePlayer();
      return Math.sqrt(
        (p.position[0] - e.position[0]) ** 2 +
        (p.position[1] - e.position[1]) ** 2 +
        (p.position[2] - e.position[2]) ** 2,
      );
    });

    // ── Scene API ───────────────────────────────────────────────────────────
    const markScene = (patch: Partial<typeof w.scene>) => {
      Object.assign(w.scene, patch);
      this.pendingSceneUpdate = { ...(this.pendingSceneUpdate ?? {}), ...patch };
    };

    g.set('_sceneSetSkybox', (preset: string) => {
      // Store the preset name; Unity client reads world.scene.skybox and
      // calls EnvironmentManager.SetSkybox() to apply the actual HDRI.
      if (preset) markScene({ skybox: preset });
    });

    // Procedural skybox: Claude emits a descriptor table from the generated
    // Lua. The descriptor (color stops, sun, fog, ambient) is stored as-is
    // on the scene state; the Unity client builds a runtime procedural
    // skybox material from it, no HDRI fetch required.
    g.set('_sceneSetSkyboxDescriptor', (json: string) => {
      if (!json) return;
      let d: unknown;
      try { d = JSON.parse(json); } catch { return; }
      if (!d || typeof d !== 'object') return;
      markScene({ skyboxDescriptor: d as Record<string, unknown> });
    });
    g.set('_sceneSetBg', (r: number, gb: number, b: number) =>
      markScene({ backgroundColor: [r, gb, b] }));
    g.set('_sceneSetFog', (r: number, gb: number, b: number, density: number) =>
      markScene({ fogEnabled: true, fogColor: [r, gb, b], fogDensity: density }));
    g.set('_sceneSetAmbient', (r: number, gb: number, b: number, intensity: number) =>
      markScene({ ambientColor: [r, gb, b], ambientIntensity: intensity }));
    g.set('_sceneSetGravity', (v: number) => markScene({ gravity: v }));

    // ── Light API ───────────────────────────────────────────────────────────
    g.set('_lightCreate', (ltype: string, x: number, y: number, z: number): string => {
      const id = randomUUID();
      const e: EntityState = {
        ...createDefaultEntity(id, `light:${ltype}`),
        position: [x, y, z],
        isStatic: true,
        visible: true,
      };
      w.entities.set(id, e);
      this.pendingCreated.push({ ...e });
      return id;
    });
    g.set('_lightSetColor', (id: string, r: number, gb: number, b: number) =>
      markUpdated(id, { color: [r, gb, b] }));
    g.set('_lightSetIntensity', (id: string, v: number) =>
      markUpdated(id, { emissive: [v, v, v, v] }));
    g.set('_lightSetRange', (id: string, v: number) =>
      markUpdated(id, { scale: [v, v, v] }));

    // ── UI / Game API ───────────────────────────────────────────────────────
    g.set('_uiShowHUD', (health: boolean, score: boolean, timer: boolean) =>
      this._queueEvent('hud_config', { health, score, timer }));
    g.set('_uiUpdateHUD', (key: string, value: string) =>
      this._queueEvent('hud_update', { key, value }));
    g.set('_uiShowPopup', (title: string, body: string, btn: string) =>
      this._queueEvent('popup', { title, body, button: btn }));
    g.set('_uiShowCountdown', (secs: number) =>
      this._queueEvent('countdown_start', { seconds: secs }));
    g.set('_uiShowMsg', (txt: string, dur: number) =>
      this._queueEvent('message', { text: txt, duration: dur }));

    // Toolbar — Lua hands us a string of slots separated by record-separator
    // (\x1e) characters; each slot is name|icon|key|cost|color separated by
    // unit-separator (\x1f). This avoids pulling in a JSON encoder on the
    // Lua side and dodges all the table-to-string edge cases.
    g.set('_uiSetToolbar', (encoded: string) => {
      const slots = (encoded ?? '').split('\x1e').filter(s => s.length > 0).map(row => {
        const [name, icon, key, costStr, color] = row.split('\x1f');
        const cost = costStr ? Number(costStr) : NaN;
        return {
          name:  name  ?? '',
          icon:  icon  || undefined,
          key:   key   ?? '',
          cost:  Number.isFinite(cost) ? cost : undefined,
          color: color || undefined,
        };
      });
      w.toolbar = { tools: slots, equipped: w.toolbar?.equipped ?? '' };
      this._toolbarDirty = true;
    });
    g.set('_uiSetEquippedTool', (name: string) => {
      if (!w.toolbar) w.toolbar = { tools: [], equipped: '' };
      w.toolbar.equipped = name ?? '';
      this._toolbarDirty = true;
    });
    g.set('_uiGetEquippedTool', () => w.toolbar?.equipped ?? '');

    g.set('_gameSetObjective', (txt: string) =>
      this._queueEvent('objective', { text: txt }));
    g.set('_gameSetTimeLimit', (s: number) => { w.timeLimitSecs = s; w.timeElapsed = 0; });
    g.set('_gameGetTimeRemaining', () =>
      w.timeLimitSecs > 0 ? Math.max(0, w.timeLimitSecs - w.timeElapsed) : 0);
    g.set('_gameRestart', () => { this.restartRequested = true; });
    g.set('_gameEnd', (result: string) => {
      w.gameRunning = false;
      const msg = result === 'win' ? 'You Win!' : 'Game Over';
      this._queueEvent('game_end', { result, message: msg });
      if (result === 'win') {
        this._callLua('if _callbacks.win then _callbacks.win() end').catch(() => {});
      } else {
        this._callLua('if _callbacks.lose then _callbacks.lose() end').catch(() => {});
      }
    });

    // ── Network API ─────────────────────────────────────────────────────────
    g.set('_netGetAllPlayers', () => Array.from(this.players.values()));

    // ── Physics ─────────────────────────────────────────────────────────────
    g.set('_physRaycast', (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number) => {
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 0.0001) return { hit: false };
      const md = maxDist ?? 100;
      const rdx = dx / len, rdy = dy / len, rdz = dz / len;
      let closestT = md;
      let closestE: EntityState | null = null;
      for (const e of w.entities.values()) {
        if (!e.visible) continue;
        const hx = e.scale[0] * 0.5, hy = e.scale[1] * 0.5, hz = e.scale[2] * 0.5;
        const invX = rdx !== 0 ? 1 / rdx : (dx >= 0 ? Infinity : -Infinity);
        const invY = rdy !== 0 ? 1 / rdy : (dy >= 0 ? Infinity : -Infinity);
        const invZ = rdz !== 0 ? 1 / rdz : (dz >= 0 ? Infinity : -Infinity);
        const tx1 = (e.position[0] - hx - ox) * invX, tx2 = (e.position[0] + hx - ox) * invX;
        const ty1 = (e.position[1] - hy - oy) * invY, ty2 = (e.position[1] + hy - oy) * invY;
        const tz1 = (e.position[2] - hz - oz) * invZ, tz2 = (e.position[2] + hz - oz) * invZ;
        const tmin = Math.max(0, Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
        const tmax = Math.min(md, Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
        if (tmax >= tmin && tmin < closestT) { closestT = tmin; closestE = e; }
      }
      if (closestE) {
        return {
          hit: true,
          x: ox + rdx * closestT, y: oy + rdy * closestT, z: oz + rdz * closestT,
          distance: closestT,
          name: closestE.name ?? closestE.type,
          tag: closestE.tag ?? '',
          normal: { x: 0, y: 1, z: 0 },
        };
      }
      return { hit: false };
    });

    // ── Audio / Effects ─────────────────────────────────────────────────────
    g.set('_audioPlaySound', (p: string) => this._queueEvent('audio', { sound: p }));
    g.set('_audioPlayMusic', (p: string) => this._queueEvent('audio', { music: p }));
    g.set('_audioStopMusic', () => this._queueEvent('audio', { stopMusic: true }));

    g.set('_fxSpawn', (preset: string, x: number, y: number, z: number) =>
      this._queueEvent('effect', { preset, x, y, z }));
    g.set('_fxShake', (i: number, d: number) =>
      this._queueEvent('screen_shake', { intensity: i, duration: d }));
    g.set('_fxFlash', (r: number, gb: number, b: number, dur: number) =>
      this._queueEvent('flash', { r, g: gb, b, duration: dur }));

    // Safe print/warn
    g.set('print', (m: unknown) => console.log(`[Lua] ${m}`));
    g.set('warn', (m: unknown) => console.warn(`[Lua] ${m}`));

    // Math/string/table available via wasmoon's built-in safe libs
  }

  // Most recent ground height under the player as reported by the client's
  // raycast. _stepPhysics uses this as the floor instead of the legacy flat
  // y = max(0.5, spawn.y) plane, so jumps work on any height of terrain.
  // Stays at the legacy default until a client sends a real groundY.
  private _lastClientGroundY: number = 0.5;
  // Most recent epoch-ms at which the player was actually grounded. Read by
  // the jump branch in _applyInput to grant a 150 ms coyote window — without
  // this, a player that briefly leaves the floor (resolving collision against
  // an invisible barrier, walking off a 1-frame edge, hot-reload glitch) loses
  // the jump press and feels unresponsive. Updated in _stepPhysics every tick
  // grounded resolves to true, and zeroed when a jump is consumed so a single
  // press never fires twice.
  private _lastGroundedAt: number = 0;
  // Per-client coyote-window + client-reported ground height, so each player's
  // jump/ground state is independent in a multiplayer room. The singular
  // _lastClientGroundY/_lastGroundedAt above remain as the seed defaults.
  private _lastGroundedAtById:   Map<string, number> = new Map();
  private _lastClientGroundYById: Map<string, number> = new Map();
  // clientId whose sim player aliases world.player (the primary). Null when no
  // clients are connected.
  private _primaryId: string | null = null;
  // True when UI.SetToolbar / UI.SetEquippedTool has run since the last diff
  // flush. _flushDiff includes `toolbar` in the outgoing diff exactly when
  // this is true — without the gate every tick would re-publish the same
  // toolbar JSON to every client and waste bandwidth.
  private _toolbarDirty: boolean = false;

  // Soft world-bounds derived from the AABB of all visible, non-trigger
  // entities each tick. The player is clamped to this box (+ margin) in
  // _stepPhysics so an absent perimeter wall (older games + ones generated
  // before the "perimeter borders" mandate landed in LUAU_FORGE_SYSTEM)
  // doesn't let the avatar walk indefinitely past the last terrain tile.
  // Recomputed every tick — O(N) over entities at 20 Hz is negligible.
  private _worldBoundsMargin = 4;

  private _applyInput(input: ClientInput, dt: number): void {
    // Each client drives its OWN simulated player. Fall back to the primary if
    // a stray input arrives before addPlayer (shouldn't happen in practice).
    const p = this.world.simPlayers.get(input.playerId) ?? this.world.player;
    const speed = p.speed;
    const clientDriven = this._acceptClientMove(input, p);

    // Stash client-reported ground height. The Unity client raycasts straight
    // down from above the player against the loaded terrain mesh and ships
    // the result here every input packet. Used by _stepPhysics for the
    // ground clamp and grounded check (which is what gates jump). Per-client.
    if (typeof input.groundY === 'number' && isFinite(input.groundY)) {
      this._lastClientGroundYById.set(input.playerId, input.groundY);
    }

    // Prefer the camera-relative move vector the client sends in moveX/moveZ.
    // The legacy forward/back/left/right booleans always meant "world +Z / -Z
    // / -X / +X", which made movement feel wrong as soon as the player
    // rotated the orbit camera — pressing W still walked north regardless of
    // where the camera was pointing. The Unity client now resolves the
    // joystick / WASD against Camera.main forward+right and ships the
    // resulting unit vector here, so "forward" actually means "the way the
    // camera is looking". Older clients without moveX/moveZ fall back to the
    // boolean-to-world mapping below so we don't break them.
    let moveX = 0, moveZ = 0;
    const hasVector =
      (typeof input.moveX === 'number' && Math.abs(input.moveX) > 0.001) ||
      (typeof input.moveZ === 'number' && Math.abs(input.moveZ) > 0.001);
    if (hasVector) {
      moveX = input.moveX ?? 0;
      moveZ = input.moveZ ?? 0;
      // Clamp to unit length so a misbehaving client can't sprint by sending
      // a magnified vector.
      const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
      if (mag > 1) { moveX /= mag; moveZ /= mag; }
      moveX *= speed;
      moveZ *= speed;
    } else {
      if (input.forward) moveZ += 1;
      if (input.back)    moveZ -= 1;
      if (input.left)    moveX -= 1;
      if (input.right)   moveX += 1;
      if (moveX !== 0 || moveZ !== 0) {
        const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
        moveX = (moveX / len) * speed;
        moveZ = (moveZ / len) * speed;
      }
    }

    // Record the DESIRED velocity; _stepPlayer ramps actual velocity toward it
    // (Roblox acceleration). Writing p.velocity directly here was the old
    // behaviour and it is why movement felt robotic: full speed on the first
    // tick, dead stop the instant input stopped, and — because this ran while
    // airborne too — all horizontal momentum was destroyed mid-jump.
    if (!p.moveIntent) p.moveIntent = [0, 0];
    p.moveIntent[0] = moveX;
    p.moveIntent[1] = moveZ;

    // Jump — universal across games. Coyote time: a jump press counts as
    // grounded if the player WAS grounded within the last 150 ms. Without
    // this, any game whose script places invisible-but-collidable primitives
    // (boundary walls, cell triggers, pickup volumes) along the path the
    // avatar walks through eats the jump press the moment the avatar's
    // capsule briefly clips off the ground while resolving collision against
    // the primitive — even if the player presses jump on a flat surface a
    // tick later. The coyote window matches a typical platformer (~150 ms)
    // and is short enough that the player can't double-jump off a ledge.
    if (input.jump && !clientDriven) {
      const now = Date.now();
      const recentlyGrounded = (now - (this._lastGroundedAtById.get(input.playerId) ?? 0)) <= 150;
      if (p.grounded || recentlyGrounded) {
        const g = Math.abs(this.world.scene.gravity);
        const jumpV = Math.sqrt(2 * g * Math.max(p.jumpHeight, 0.1));
        p.velocity[1] = jumpV;
        p.grounded = false;
        this._lastGroundedAtById.set(input.playerId, 0); // consume coyote window
      }
    }

    // Input actions → fire into Lua, attributed to the client that pressed them
    // so `Player.*` inside the handler acts on that client's avatar.
    if (input.action) this.fireInputAction(input.playerId);
    for (const [key, pressed] of Object.entries(input.keys)) {
      if (pressed) this.fireInputKey(key, input.playerId);
    }
    if (input.swipe) this.fireSwipe(input.swipe, input.playerId);
  }

  // Client-authoritative movement with server validation. The Unity client
  // runs the Roblox character motor against the real collision geometry (walls,
  // props, platforms — none of which the server models), so its position is
  // the truth for normal walking/jumping. We accept it when it is physically
  // plausible from the last accepted position and the client has applied our
  // latest teleport; otherwise we bump teleportSeq, which makes the client snap
  // to the server position. Any server-side move of the player (Lua teleport,
  // respawn, bounds/void clamp) is detected here as "position changed since the
  // client's last report" and also bumps teleportSeq.
  private _acceptClientMove(input: ClientInput, p: import('./world-state.js').PlayerState): boolean {
    if (!input.pos) return false;
    const now = Date.now();
    p.teleportSeq ??= 0;

    if (p.lastClientPos) {
      const dx = p.position[0] - p.lastClientPos[0];
      const dy = p.position[1] - p.lastClientPos[1];
      const dz = p.position[2] - p.lastClientPos[2];
      if (dx * dx + dy * dy + dz * dz > 1e-4) {
        p.teleportSeq++;
        p.lastClientPos = null;
        // Hold the server's chosen position exactly until the client snaps to
        // it — integrating here would drop it to the server's flat floor.
        p.clientDrivenUntil = now + 500;
        return false;
      }
    }
    if ((input.tpSeq ?? -1) !== p.teleportSeq) return false; // client hasn't caught up yet

    const [x, y, z] = input.pos;
    const ref = p.lastClientPos ?? p.position;
    const elapsed = Math.min(1, Math.max(0.05, (now - (p.lastClientAt ?? now)) / 1000));
    const g = Math.abs(this.world.scene.gravity) || 1;
    const jumpV = Math.sqrt(2 * g * Math.max(p.jumpHeight, 0.1));
    const horiz = Math.hypot(x - ref[0], z - ref[2]);
    const rise  = y - ref[1];
    const maxHoriz = (p.speed * 1.5 + 4) * elapsed + 1.0;
    const maxRise  = jumpV * elapsed + 1.6; // + step-up / slope headroom
    if (horiz > maxHoriz || rise > maxRise) {
      p.teleportSeq++;
      p.lastClientPos = null;
      p.clientDrivenUntil = now + 500;   // freeze at the last good position
      return false;
    }

    p.position = [x, y, z];
    const v = input.vel ?? [0, 0, 0];
    p.velocity = [v[0], v[1], v[2]];
    p.grounded = !!input.grounded;
    if (p.grounded) this._lastGroundedAtById.set(input.playerId, now);
    p.lastClientPos = [x, y, z];
    p.lastClientAt = now;
    p.clientDrivenUntil = now + 500;
    return true;
  }

  private _stepPhysics(dt: number): void {
    const gravity = this.world.scene.gravity; // negative

    // Soft world-bounds AABB, computed ONCE and shared by every player. Derived
    // from visible, non-trigger entities so an older game without perimeter
    // walls still pins avatars inside the playable terrain.
    let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (const e of this.world.entities.values()) {
      if (e.hasTrigger) continue;
      if (e.visible === false) continue;
      const hx = Math.max(0.5, Math.abs(e.scale[0]) / 2);
      const hz = Math.max(0.5, Math.abs(e.scale[2]) / 2);
      if (e.position[0] - hx < xMin) xMin = e.position[0] - hx;
      if (e.position[0] + hx > xMax) xMax = e.position[0] + hx;
      if (e.position[2] - hz < zMin) zMin = e.position[2] - hz;
      if (e.position[2] + hz > zMax) zMax = e.position[2] + hz;
    }
    const bounds = isFinite(xMin) ? { xMin, xMax, zMin, zMax } : null;

    // Step every connected client's player independently. Falls back to the
    // lone primary if no clients are registered (defensive — tick only runs
    // with ≥1 client).
    if (this.world.simPlayers.size > 0) {
      for (const [cid, p] of this.world.simPlayers) this._stepPlayer(cid, p, dt, gravity, bounds);
    } else {
      this._stepPlayer(this._primaryId ?? '', this.world.player, dt, gravity, bounds);
    }

    // Dynamic entities
    for (const [id, e] of this.world.entities) {
      if (e.physics && !e.isStatic) {
        e.velocity[1] += gravity * dt;
        e.position[0] += e.velocity[0] * dt;
        e.position[1] += e.velocity[1] * dt;
        e.position[2] += e.velocity[2] * dt;

        // Simple ground plane
        if (e.position[1] <= 0.5) {
          e.position[1] = 0.5;
          e.velocity[1] = 0;
          e.velocity[0] *= 0.85; // friction
          e.velocity[2] *= 0.85;
        }

        // Mark updated if moved significantly
        const prev = this.pendingUpdated.get(id);
        this.pendingUpdated.set(id, {
          ...(prev ?? {}),
          position: [...e.position] as [number, number, number],
          velocity: [...e.velocity] as [number, number, number],
        });
      }
    }

    // Mark the PRIMARY player dirty for the legacy single-player diff path.
    // (Per-client full state is streamed separately by the room each tick.)
    const prim = this.world.player;
    this.pendingPlayerUpdate = {
      ...(this.pendingPlayerUpdate ?? {}),
      position: [...prim.position] as [number, number, number],
      velocity: [...prim.velocity] as [number, number, number],
      grounded: prim.grounded,
    };
  }

  // Integrate one player for a tick: gravity, move, ground-clamp (per-client
  // raycast height + coyote timestamp), world-bounds clamp, void-fall respawn.
  private _stepPlayer(
    clientId: string,
    p: import('./world-state.js').PlayerState,
    dt: number,
    gravity: number,
    bounds: { xMin: number; xMax: number; zMin: number; zMax: number } | null,
  ): void {
    // Ground clamp against this client's live raycast height (0.5 default until
    // the first groundY arrives / for non-Unity clients). See the long-form
    // rationale that previously lived inline: spawnPoint.y is deliberately not
    // in this max so feet sit on the actual terrain top, not spawn altitude.
    const groundY = Math.max(0.5, this._lastClientGroundYById.get(clientId) ?? this._lastClientGroundY);
    const groundedEpsilon = 0.05;

    // Integrate at a FIXED 60 Hz substep rather than once per 20 Hz room tick.
    // The Unity client predicts this same motion at frame rate; with Roblox's
    // much stronger gravity a single 50 ms Euler step lands a visibly different
    // trajectory than 60 Hz integration, so the two would disagree every jump
    // and the reconciliation would show up as a twitch. Substepping makes both
    // sides integrate identically, so corrections stay sub-centimetre.
    // The client is driving this player (see _acceptClientMove): its motor
    // already integrated gravity/collisions, so only the safety clamps below run.
    let remaining = (p.clientDrivenUntil ?? 0) > Date.now() ? 0 : dt;
    while (remaining > 1e-6) {
      const h = Math.min(PLAYER_SUBSTEP, remaining);
      remaining -= h;

      // Roblox-style horizontal acceleration toward the input's desired velocity.
      const intent = p.moveIntent ?? [0, 0];
      const [vx, vz] = stepHorizontalVelocity(
        p.velocity[0], p.velocity[2], intent[0], intent[1], p.speed, p.grounded, h,
      );
      p.velocity[0] = vx;
      p.velocity[2] = vz;

      if (!p.grounded) p.velocity[1] += gravity * h;

      p.position[0] += p.velocity[0] * h;
      p.position[1] += p.velocity[1] * h;
      p.position[2] += p.velocity[2] * h;

      if (p.position[1] <= groundY + groundedEpsilon) {
        p.position[1] = groundY;
        if (p.velocity[1] <= 0) p.velocity[1] = 0;
        p.grounded = true;
        this._lastGroundedAtById.set(clientId, Date.now());
      } else {
        p.grounded = false;
      }
    }

    if (bounds) {
      const m = this._worldBoundsMargin;
      p.position[0] = Math.max(bounds.xMin - m, Math.min(bounds.xMax + m, p.position[0]));
      p.position[2] = Math.max(bounds.zMin - m, Math.min(bounds.zMax + m, p.position[2]));
    }

    // Void-fall safety net.
    if (p.position[1] < -5) {
      console.warn(`[lua] void-fall respawn — player ${clientId.slice(0, 8)} at (${p.position.join(',')}) → spawn ${p.spawnPoint.join(',')}`);
      p.position[0] = p.spawnPoint[0];
      p.position[1] = Math.max(p.spawnPoint[1], 1);
      p.position[2] = p.spawnPoint[2];
      p.velocity[0] = 0;
      p.velocity[1] = 0;
      p.velocity[2] = 0;
      p.moveIntent = [0, 0]; // don't carry momentum through a teleport
      p.grounded = true;
    }
  }

  // Server-side overlap sweep, run once per tick for EVERY connected player.
  // It used to test only `world.player`, so in a shared room players 2..N could
  // walk through a checkpoint, pickup or damage volume and nothing fired at all.
  // Enter/exit latching lives in fire*Trigger via `_triggerInsideBy`, keyed per
  // (entity, player), so this is a pure "is it overlapping right now" test.
  private _checkTriggers(): void {
    const players: Array<[string, import('./world-state.js').PlayerState]> =
      this.world.simPlayers.size > 0
        ? [...this.world.simPlayers.entries()]
        : [[this._primaryId ?? '', this.world.player]];

    for (const [id, e] of this.world.entities) {
      if (!e.hasTrigger) continue;
      // Visibility is only a meaningful "this pickup is consumed" signal for
      // entities that CAN be visible. `_objCreate` force-hides every primitive
      // and `_objSetVisible` refuses to un-hide one, so an `Object.Create("cube")`
      // trigger volume — the way the system prompt tells Claude to author every
      // pickup pad, checkpoint and kill zone — is invisible from birth and can
      // never become visible. The old blanket `!e.visible` skip therefore
      // disabled this sweep for effectively every trigger in every generated
      // game, leaving all trigger authority with the client's physics report.
      // Models/lights/structural entities keep the original semantics: hiding
      // one is how scripts mark a collected pickup, and re-sweeping it would
      // let a player farm it by stepping off and back on.
      const alwaysInvisible = !e.type.startsWith('model:') &&
                              !e.type.startsWith('light:') &&
                              !e.structural;
      if (!e.visible && !alwaysInvisible) continue;
      // Simple sphere test: entity half-extents ≈ scale/2
      const radius = Math.max(e.scale[0], e.scale[1], e.scale[2]) * 0.6;
      for (const [cid, p] of players) {
        const dx = p.position[0] - e.position[0];
        const dy = p.position[1] - e.position[1];
        const dz = p.position[2] - e.position[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < radius) this.firePlayerEnterTrigger(id, cid);
        else               this.firePlayerExitTrigger(id, cid);
      }
    }

    // Drop latches for entities the script has since destroyed.
    for (const id of this._triggerInsideBy.keys()) {
      if (!this.world.entities.has(id)) this._triggerInsideBy.delete(id);
    }
  }

  private _queueEvent(type: UIEvent['type'], payload: Record<string, unknown>): void {
    // Address personal feedback to whoever caused it (see UIEvent.to). Outside a
    // player-attributed callback `_actingPlayerId` is null and the event is
    // broadcast, which is every OnStart/OnUpdate/timer event — i.e. unchanged.
    // One-shot Audio.PlaySound is 2D UI feedback, not part of the shared
    // soundtrack — see the note on ROOM_WIDE_UI_EVENTS.
    const roomWide = ROOM_WIDE_UI_EVENTS.has(type) &&
                     !(type === 'audio' && typeof payload.sound === 'string');
    const to = (this._actingPlayerId && !roomWide)
      ? this._actingPlayerId
      : undefined;
    this.pendingEvents.push(to ? { type, payload, to } : { type, payload });
  }

  private _flushDiff(): StateDiff {
    const tick = this.world.tickNumber;
    const w = this.world;

    // Resolve every pending-created entry against the current world state, not
    // its creation-time snapshot. _objCreate pushes a `{...e}` clone the moment
    // the entity is born — but Lua scripts almost always immediately follow
    // Object.Create() with SetPosition()/SetScale()/etc. By the time this tick
    // flushes, that clone is stale (position still [0,0,0]) while
    // world.entities holds the up-to-date row. Sending the stale clone, then
    // dropping the matching pendingUpdated entry below ("entity is in created,
    // skip the update"), is exactly the bug that made every freshly-spawned
    // model land at the origin on first-join: the snapshot delivered the
    // correct positions, but this very next diff re-created the same entities
    // at [0,0,0] with no follow-up update to fix them. Pulling current state
    // here means `created` always reflects what the snapshot would have shown.
    const created: EntityState[] = [];
    for (const e of this.pendingCreated) {
      const fresh = w.entities.get(e.id);
      if (fresh) created.push({ ...fresh });
    }
    this.pendingCreated.length = 0;

    const entityDiff: EntityDiff = {
      created,
      destroyed: [...this.pendingDestroyed],
      updated: [],
    };
    this.pendingDestroyed.clear();

    for (const [id, patch] of this.pendingUpdated) {
      if (!entityDiff.created.some(e => e.id === id) &&
          !entityDiff.destroyed.includes(id)) {
        entityDiff.updated.push({ id, ...patch });
      }
    }
    this.pendingUpdated.clear();

    const diff: StateDiff = {
      tick,
      entities: entityDiff,
      events: this.pendingEvents.splice(0),
    };

    if (this.pendingPlayerUpdate) {
      diff.player = this.pendingPlayerUpdate;
      this.pendingPlayerUpdate = null;
    }
    if (this.pendingSceneUpdate) {
      diff.scene = this.pendingSceneUpdate;
      this.pendingSceneUpdate = null;
    }
    if (this._toolbarDirty) {
      // Send a SHALLOW COPY rather than the live state object — the runtime
      // mutates `world.toolbar.equipped` from the equipTool input handler and
      // we don't want clients holding a reference that races with the next
      // tick's mutation.
      const tb = this.world.toolbar ?? { tools: [], equipped: '' };
      diff.toolbar = { tools: [...tb.tools], equipped: tb.equipped };
      this._toolbarDirty = false;
    }

    if (this.restartRequested) {
      this.restartRequested = false;
      this.onRestart?.();
    }

    return diff;
  }

  // Runs `code` against the Lua state with `actingPlayerId` installed as the
  // acting-player context. Serialized: calls queue behind whatever is already
  // running so the context can't leak across an interleaved doString, and so a
  // trigger callback fired earlier in the tick always completes before OnUpdate.
  //
  // Nested calls (a bridge function that itself calls _callLua, e.g. the
  // playerDied hook inside _plrSetHealth) are fire-and-forget by contract —
  // they enqueue and run after the current entry point returns. Awaiting one
  // from inside the chain would deadlock, so don't.
  private _callLua(code: string, actingPlayerId: string | null = null): Promise<void> {
    const run = this._luaChain.then(async () => {
      const prev = this._actingPlayerId;
      this._actingPlayerId = actingPlayerId;
      try {
        await this.lua.doString(code);
      } catch (e) {
        console.warn('[LuaRuntime] Lua error:', e);
      } finally {
        this._actingPlayerId = prev;
      }
    });
    this._luaChain = run.catch(() => {});
    return run;
  }

  // The player the singular `Player.*` API currently refers to. Falls back to
  // the primary (first-joined) player outside any player-attributed callback.
  private _activePlayer(): import('./world-state.js').PlayerState {
    if (this._actingPlayerId) {
      const p = this.world.simPlayers.get(this._actingPlayerId);
      if (p) return p;
    }
    return this.world.player;
  }

  // Nearest connected player to a world position — used by the enemy-AI
  // helpers (`obj:LookAtPlayer()`, `obj:GetDistanceToPlayer()`) when they run
  // outside a player-attributed callback. Chasers used to lock onto the
  // first-joined client and ignore everyone else in the room.
  private _nearestPlayerTo(pos: [number, number, number]): import('./world-state.js').PlayerState {
    if (this._actingPlayerId) {
      const p = this.world.simPlayers.get(this._actingPlayerId);
      if (p) return p;
    }
    let best = this.world.player;
    let bestD = Infinity;
    for (const p of this.world.simPlayers.values()) {
      const d = (p.position[0] - pos[0]) ** 2 +
                (p.position[1] - pos[1]) ** 2 +
                (p.position[2] - pos[2]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // Strip Roblox Luau syntax that's invalid in Lua 5.4
  private _sanitize(code: string): string {
    // Strip --!strict and similar mode comments
    code = code.replace(/^--!.*$/gm, '');
    // Strip type declarations: type X = ...
    code = code.replace(/^(export\s+)?type\s+\w[^\n]*/gm, '');
    // Strip inline type annotations: local x: Type = ...
    code = code.replace(/\s*:\s*[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?[?]?(?:\s*[|&]\s*[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?[?]?)*(?=\s*[,)=\n])/g, '');
    // Strip table type annotations: local x: {string}
    code = code.replace(/\s*:\s*\{[^}\n]*\}[?]?\s*(?=\s*[,)=\n])/g, '');
    // Strip generic type params: foo<T>(args)
    code = code.replace(/(\w)\s*<[A-Za-z0-9_,\s?|&.[\]{}]+>\s*(?=\()/g, '$1');
    // Replace `continue` (Lua 5.4 has it, Lua 5.2 doesn't — wasmoon uses 5.4 so it's fine)
    return code;
  }
}
