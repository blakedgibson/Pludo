// Server-authoritative world state model.
// All game logic runs server-side; Unity is a pure render client.

export interface EntityState {
  id: string;
  type: string;                       // "cube", "sphere", "plane", "model:xxx", etc.
  position: [number, number, number];
  rotation: [number, number, number]; // euler angles
  scale: [number, number, number];
  color?: [number, number, number];
  material?: string;
  visible: boolean;
  physics: boolean;                   // has rigidbody physics
  isStatic: boolean;
  velocity: [number, number, number];
  emissive?: [number, number, number, number]; // r,g,b,intensity
  parentId?: string;
  tag?: string;
  name?: string;
  hasTrigger: boolean;
  hasCollision: boolean;
  // True for primitives spawned through the Structure.* API. The visibility
  // lock on _objSetVisible only honors SetVisible(true) when this is set, so
  // a stray `Object.Create("cube"):SetVisible(true)` from a buggy generated
  // script still gets force-hidden, but intentional procedural ground/walls
  // stay visible.
  structural?: boolean;
  // Per-entity PBR material spec for structural primitives. Driven by
  // obj:SetMaterial(materialType, tiling, roughness) in Lua. URLs are
  // populated server-side by the Polyhaven service once the slug resolves.
  // The Unity client builds a Pludo/Terrain (1-layer mode) material from
  // these and applies it to the primitive's MeshRenderer.
  structureMaterial?: StructureMaterial;
  // Slope-blended terrain layers for Structure.CreateTerrain entities.
  // Up to 3 layers; the triplanar shader picks per-pixel weights from the
  // surface slope. URLs filled in async by the Polyhaven service.
  terrainLayers?: TerrainLayer[];
  // Sculpted-terrain fields. Present on entities of type `terrain` only.
  // `terrainSize` is the world XZ extent set at creation (used to map world
  // coords → grid cells). `terrainSculpts` is the authoritative list of
  // raise/pit/flatten ops Claude called — kept server-side for debugging and
  // for potential regen. `terrainHeights` is the row-major NxN height grid
  // (N = TERRAIN_GRID_SIZE) derived from the ops list and shipped to clients
  // each tick that it changes. Heights are in world units (the terrain GO's
  // localScale.y stays at 1, so mesh-local Y == world height).
  terrainSize?: [number, number];
  terrainSculpts?: TerrainSculptOp[];
  terrainHeights?: number[];
}

// Grid resolution for sculpted terrain. 64x64 = 4096 cells per terrain.
// Network payload at this resolution is ~32 KB JSON (or ~16 KB binary), which
// is fine for cold-join snapshots. Sculpt ops are issued by Claude in OnStart
// and don't re-fire each tick, so steady-state diffs don't carry the grid.
export const TERRAIN_GRID_SIZE = 64;

// One sculpt op Claude applied to a terrain. Stored server-side as the
// truth-of-intent record; the client only ever sees the resulting height grid.
export type TerrainSculptOp =
  | { op: 'raise';   x: number; z: number; radius: number; height: number }
  | { op: 'pit';     x: number; z: number; radius: number; depth:  number }
  | { op: 'flatten'; x: number; z: number; sizeX: number; sizeZ: number; height: number };

// One PBR texture set layer used by both Structure.CreateTerrain (slope-
// blended) and obj:SetMaterial (single layer mode). `materialType` is the
// Polyhaven-vocabulary name Claude emits; the URL fields are filled in
// after the slug resolves through `polyhaven.resolveMaterial(...)`.
export interface TerrainLayer {
  materialType: string;
  slopeMin: number; // 0..1, dot(normal,up)→1-dot mapping
  slopeMax: number;
  tiling: number;   // world-space repeats per unit (higher = smaller features)
  albedoUrl?: string;
  normalUrl?: string;
  roughnessUrl?: string;
}

export interface StructureMaterial {
  materialType: string;
  tiling: number;
  roughness: number; // 0..1 multiplier applied on top of the sampled roughness map
  albedoUrl?: string;
  normalUrl?: string;
  roughnessUrl?: string;
}

// Procedural skybox parameters. Claude emits one of these per game in the
// generated Lua via Scene.SetCustomSkybox(...). The Unity client builds a
// Skybox/Procedural material from these values at runtime — no external HDRI
// or preset name is required, every game gets a theme-matched sky.
export interface SkyboxDescriptor {
  topColor?:           [number, number, number];
  bottomColor?:        [number, number, number];
  horizonColor?:       [number, number, number];
  // Color seen below the horizon, e.g. dark earth, lava glow, deep water.
  // Distinct from `bottomColor` (which is the zenith-mirror low-sky tint).
  groundColor?:        [number, number, number];
  sunColor?:           [number, number, number];
  sunDirection?:       [number, number, number]; // euler angles
  sunSize?:            number;                   // 0..0.2
  sunIntensity?:       number;                   // directional light intensity
  exposure?:           number;                   // 0..2
  atmosphereThickness?: number;                  // 0..3
  fogColor?:           [number, number, number];
  fogDensity?:         number;
  ambientColor?:       [number, number, number];
  ambientIntensity?:   number;
  timeOfDay?:          string; // "dawn" | "day" | "dusk" | "night"
  // 0..1 — density of the hash-noise star field rendered above horizon.
  // 0 = no stars (e.g. daytime), 1 = dense (space/deep night). Unity reads.
  starDensity?:        number;
  // 0..1 — density of the procedural cloud band at mid-altitude. 0 = clear,
  // 1 = heavy overcast. Independent of starDensity (foggy night = both off).
  cloudDensity?:       number;
}

// ── Roblox-derived character physics ─────────────────────────────────────────
// Roblox's numbers are in studs, so porting them means porting RATIOS, not raw
// values. A default Roblox character is 5 studs tall, so dividing each constant
// by 5 gives a scale-invariant "per character-height" figure that lands the same
// feel on our 2 m avatar:
//
//   gravity     196.2 studs/s² ÷ 5 = 39.24 heights/s²
//   walk speed   16   studs/s  ÷ 5 =  3.2  heights/s
//   jump height   7.2 studs    ÷ 5 =  1.44 heights
//
// The ratio is robust to whichever stud→metre convention you pick (0.28 m/stud
// or 20 studs/m) because numerator and denominator are both in studs.
//
// The headline consequence: gravity is ~8× stronger relative to character size
// than the Earth-gravity default this project used to ship (9.81 m/s² on a 2 m
// avatar = 4.9 heights/s²). Total airtime for a jump goes 1.28 s → 0.542 s,
// which is the difference between "moon jump" and Roblox's snappy hop.
//
// Mirrored in Assets/Scripts/Game/RobloxPhysics.cs — keep the two in sync.
export const CHARACTER_HEIGHT = 2; // metres; matches the humanoid normalisation target

export const ROBLOX_GRAVITY     = 39.24 * CHARACTER_HEIGHT; // 78.48 m/s²
export const ROBLOX_WALK_SPEED  = 3.2   * CHARACTER_HEIGHT; //  6.40 m/s
export const ROBLOX_JUMP_HEIGHT = 1.44  * CHARACTER_HEIGHT; //  2.88 m
// → jump velocity 21.26 m/s, apex 0.271 s, airtime 0.542 s (matches Roblox)

// Roblox GroundController semantics: seconds to reach full speed from rest, and
// to come to a full stop from full speed. Ground values are deliberately snappy
// (the legacy Humanoid feels near-instant); air acceleration is weaker so you
// steer rather than teleport mid-jump.
export const GROUND_ACCEL_TIME = 0.10;
export const GROUND_DECEL_TIME = 0.10;
export const AIR_ACCEL_TIME    = 0.35;

// Fixed timestep the player integrator runs at, independent of the 20 Hz room
// tick. The Unity client predicts at frame rate, so matching a common 60 Hz
// substep on both sides keeps the two integrations from drifting apart and
// keeps reconciliation corrections invisible.
export const PLAYER_SUBSTEP = 1 / 60;

// One Roblox-style horizontal velocity ramp. Returns the new [vx, vz].
// Airborne with no input conserves momentum outright — that is what makes a
// running jump carry you forward instead of stopping dead the moment you let go
// of the stick. Mirrored by RobloxPhysics.StepHorizontal on the client.
export function stepHorizontalVelocity(
  vx: number, vz: number,
  targetVx: number, targetVz: number,
  speed: number, grounded: boolean, dt: number,
): [number, number] {
  const hasInput = (targetVx * targetVx + targetVz * targetVz) > 1e-6;
  let rampTime: number;
  if (hasInput)      rampTime = grounded ? GROUND_ACCEL_TIME : AIR_ACCEL_TIME;
  else if (grounded) rampTime = GROUND_DECEL_TIME;
  else               return [vx, vz]; // airborne, no input → keep momentum

  if (rampTime <= 1e-4) return [targetVx, targetVz];
  const maxDelta = (Math.max(speed, 0.01) / rampTime) * dt;

  const dx = targetVx - vx, dz = targetVz - vz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist <= maxDelta || dist < 1e-6) return [targetVx, targetVz];
  return [vx + (dx / dist) * maxDelta, vz + (dz / dist) * maxDelta];
}

export interface PlayerState {
  health: number;
  score: number;
  position: [number, number, number];
  velocity: [number, number, number];
  grounded: boolean;
  speed: number;
  jumpHeight: number;
  invincible: boolean;
  spawnPoint: [number, number, number];
  // Desired horizontal velocity from the latest input packet, in world space.
  // Kept separate from `velocity` so _stepPlayer can ramp toward it over time
  // (Roblox acceleration) instead of the old instant snap, which made movement
  // read as robotic — full speed on frame 1, dead stop on release.
  moveIntent: [number, number];
  // Client-authoritative movement (see LuaRuntime._acceptClientMove). The
  // client runs the Roblox character motor against real collision geometry and
  // ships its position; the server validates it. teleportSeq increments
  // whenever the SERVER moves the player (Lua teleport, respawn, bounds/void
  // clamp, or a rejected implausible move) — the client snaps only then.
  teleportSeq?: number;
  lastClientPos?: [number, number, number] | null;
  lastClientAt?: number;
  clientDrivenUntil?: number;
}

export interface SceneConfig {
  skybox?: string;
  // Procedural skybox descriptor from Scene.SetCustomSkybox(...). When
  // present, takes precedence over the preset `skybox` field — the client
  // builds a Skybox/Procedural material from these parameters instead of
  // loading a preset HDRI.
  skyboxDescriptor?: SkyboxDescriptor;
  backgroundColor?: [number, number, number];
  fogEnabled: boolean;
  fogColor?: [number, number, number];
  fogDensity: number;
  gravity: number;
  ambientColor?: [number, number, number];
  ambientIntensity: number;
}

export type UIEventType =
  | 'message' | 'title' | 'popup' | 'countdown_start'
  | 'hud_config' | 'hud_update' | 'screen_shake' | 'flash'
  | 'effect' | 'objective' | 'game_end' | 'game_restart' | 'audio';

export interface UIEvent {
  type: UIEventType;
  payload: Record<string, unknown>;
  // Recipient clientId, or absent for "everyone in the room". Set automatically
  // when the event is queued from inside a player-attributed callback (a trigger
  // the player crossed, a HUD button they tapped) and the event type is personal
  // feedback — a "+10!" toast or a damage flash belongs to the player who earned
  // it, not to everyone watching. Room-scoped events (game_end, countdown,
  // objectives, world audio/FX) stay broadcast regardless of who caused them.
  to?: string;
}

// UI event types that always go to the whole room even when raised from inside
// one player's callback. Everything else is personal feedback and is addressed
// to the acting player when there is one.
//
// `effect` is here because Effects.Spawn carries an explicit x/y/z — a burst of
// particles at a world position is part of the shared scene, and hiding it from
// bystanders would make pickups look like they vanished on their own.
// `audio` is a split case handled in _queueEvent: Audio.PlayMusic/StopMusic set
// the room's soundtrack and stay broadcast, but a one-shot Audio.PlaySound is a
// 2D UI ding that belongs only to the player who earned it — otherwise every
// coin anyone grabs chimes in everyone's headphones.
export const ROOM_WIDE_UI_EVENTS: ReadonlySet<UIEventType> = new Set<UIEventType>([
  'game_end', 'game_restart', 'countdown_start', 'objective', 'effect', 'audio',
]);

// One slot on the bottom-of-screen toolbar. Mobile players have no keyboard,
// so any game whose Lua expects "press 1 / 2 / 3 to switch tools" must register
// a toolbar via UI.SetToolbar so React renders tappable buttons. Each tap fires
// the configured `key` through the existing input.keys pipeline — Lua handles
// it identically to a desktop keypress, so script logic doesn't need a second
// path for mobile.
export interface ToolbarSlot {
  name: string;       // display name on the button
  icon?: string;      // optional emoji or model id (e.g. "sunflower") for thumbnail
  key: string;        // input key fired when this slot is tapped (e.g. "1", "e")
  cost?: number;      // optional cost shown beneath the icon (e.g. sun cost)
  color?: string;     // optional accent color (#rrggbb) for the button border
}

export interface ToolbarState {
  tools: ToolbarSlot[];
  equipped: string;   // name of the currently-equipped tool, or "" if none
}

export interface WorldState {
  entities: Map<string, EntityState>;
  scene: SceneConfig;
  // `player` is the PRIMARY player — the canonical state all existing Lua game
  // logic (triggers, scoring, Player API) acts on. In a multiplayer room it
  // aliases the first-joined client's entry in `simPlayers`.
  player: PlayerState;
  // Per-client simulated players, keyed by clientId. Each connected client owns
  // an independently-stepped avatar so two players in one room no longer share
  // a body. Empty until the first client joins.
  simPlayers: Map<string, PlayerState>;
  // Creator-placed "player spawn" chibi markers (editor tray item), in world
  // space. Populated from editor_state_json by Room._applyEditorStateOverlay.
  // When non-empty, these override the AI-authored Player.SetSpawnPoint literal
  // for every newly-assigned player — see Room._applyEditorStateOverlay and
  // LuaRuntime.addPlayer. Empty for games where the creator never placed one,
  // which keeps the existing single-spawn-point behavior unchanged.
  spawnPoints: [number, number, number][];
  uiEventQueue: UIEvent[];
  gameRunning: boolean;
  tickNumber: number;
  timeLimitSecs: number;
  timeElapsed: number;
  // Bottom-of-screen toolbar (mobile-equivalent of "press 1/2/3" plant pickers).
  // Default empty — only games that opt in via UI.SetToolbar render anything.
  toolbar: ToolbarState;
}

// ── Diff types broadcast to clients each tick ─────────────────────────────────

export interface EntityDiff {
  created: EntityState[];
  updated: Array<{ id: string } & Partial<Omit<EntityState, 'id'>>>;
  destroyed: string[];
}

// Per-tick render state for OTHER players in the room, sent to each client so
// it can render remote avatars. Position-relay only — physics is authoritative
// on the server, this is just what to draw.
export interface RemotePlayerWire {
  clientId: string;
  username: string;
  position: [number, number, number];
  velocity: [number, number, number];
  grounded: boolean;
}

export interface StateDiff {
  tick: number;
  entities: EntityDiff;
  player?: Partial<PlayerState>;
  // Every OTHER player's state, assembled per-recipient by the room. Absent
  // when the recipient is alone in the room.
  remotePlayers?: RemotePlayerWire[];
  scene?: Partial<SceneConfig>;
  events: UIEvent[];
  // Present only when the toolbar shape OR equipped slot changed since the
  // last tick. Sending the full toolbar (rather than partials) keeps the
  // client logic dead simple — replace whatever it has.
  toolbar?: ToolbarState;
}

// ── Input received from clients ───────────────────────────────────────────────

export interface ClientInput {
  playerId: string;
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  action: boolean;         // E key / interact
  keys: Record<string, boolean>;
  // Camera-relative move vector (xz, world-space, |v| ≤ 1) computed by the
  // client against the live camera forward/right. When either component is
  // non-zero, the server uses these floats directly and ignores the
  // forward/back/left/right booleans, so orbiting the camera changes the
  // direction the avatar walks. Older clients that don't send these still
  // get the legacy boolean->world-axes mapping in _applyInput.
  moveX?: number;
  moveZ?: number;
  // Live ground-height beneath the player, computed by the client from a
  // straight-down raycast against terrain colliders. The server clamps the
  // player to this Y in _stepPhysics and treats grounded=true within a
  // small tolerance — so jumping/walking works on hills, platforms and
  // elevated terrain instead of the old flat y=0.5 plane.
  groundY?: number;
  // Client-authoritative movement: the client's motor position/velocity and
  // the last teleportSeq it applied (moves from an older seq are ignored).
  pos?: [number, number, number];
  vel?: [number, number, number];
  grounded?: boolean;
  tpSeq?: number;
  mouseX?: number;
  mouseY?: number;
  swipe?: string;
}

// ── Factory helpers ───────────────────────────────────────────────────────────

export function createDefaultEntity(id: string, type: string): EntityState {
  return {
    id,
    type,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    visible: true,
    physics: false,
    isStatic: true,
    velocity: [0, 0, 0],
    hasTrigger: false,
    hasCollision: false,
  };
}

export function createDefaultPlayer(): PlayerState {
  return {
    health: 100,
    score: 0,
    position: [0, 3, 0],
    velocity: [0, 0, 0],
    grounded: false,
    speed: ROBLOX_WALK_SPEED,
    jumpHeight: ROBLOX_JUMP_HEIGHT,
    invincible: false,
    spawnPoint: [0, 3, 0],
    moveIntent: [0, 0],
  };
}

export function createDefaultScene(): SceneConfig {
  return {
    fogEnabled: false,
    fogDensity: 0.02,
    // Roblox gravity, not Earth gravity — see the ROBLOX_GRAVITY comment above.
    // Scene.SetGravity still overrides this per-game.
    gravity: -ROBLOX_GRAVITY,
    ambientIntensity: 1.0,
  };
}

export function createDefaultWorldState(): WorldState {
  return {
    entities: new Map(),
    scene: createDefaultScene(),
    player: createDefaultPlayer(),
    simPlayers: new Map(),
    spawnPoints: [],
    uiEventQueue: [],
    gameRunning: false,
    tickNumber: 0,
    timeLimitSecs: 0,
    timeElapsed: 0,
    toolbar: { tools: [], equipped: '' },
  };
}
