# Roblox-feel: editor-side implementation plan

This documents the features from the "make it feel more like Roblox" pass that are
**deferred to the game editor / data model**, plus the two multiplayer follow-ups
that were intentionally scoped out of the first implementation. The runtime
foundations they build on are already shipped (see "Already implemented" at the
bottom).

Each item lists the concrete files + insertion points discovered during research
so the next pass can go straight to implementation.

---

## 1. Editor-chosen sounds (footstep / jump / land / ambient music)

**Why editor:** the playback engine exists (`Assets/Scripts/Game/GameAudio.cs`,
synth presets) and is already driven at runtime (footstep cadence + jump/land in
`GameRenderClient.LateUpdate`/`SwitchAnim`; ambient music via
`ApplySceneConfig` reading `scene.music`). What's missing is letting the creator
**pick** the sounds and (optionally) upload custom clips.

**Server / data model:**
- `api-server/src/world-state.ts` → `SceneConfig`: add
  `music?: string` (already read by the client), plus optional
  `footstepSound?: string`, `jumpSound?: string`, `landSound?: string`
  (preset name or URL).
- Lua bridge (`lua-runtime.ts`, preamble + `_registerBridge`): add
  `Scene.SetMusic(name)`, `Scene.SetSounds({...})` → write into `world.scene`,
  mark `pendingSceneUpdate` dirty so it ships in the diff.

**Client:**
- `GameRenderClient.ApplySceneConfig` already starts `scene.music`. Extend the
  footstep/jump/land calls to read the configured preset names instead of the
  hardcoded `"step"`/`"jump"`/`"land"`.
- For **custom uploaded clips**: add URL loading to `GameAudio`
  (`UnityWebRequestMultimedia.GetAudioClip` + the same R2 disk-cache pattern
  `GameAssetLoader` uses), keyed by URL.

**Editor UI (React):** a "Sound" panel — dropdowns for footstep/jump/land/music
from the preset list, plus an upload control that stores the clip in R2 and writes
the URL into the scene config. Persist through the existing EditorState overlay.

---

## 2. Proximity prompts ("Press E" interactables)

**Why editor:** which objects are interactable, the prompt text, and the action
are authored per-game.

**Server / data model:**
- `EntityState` (`world-state.ts`): add `prompt?: { text: string; key?: string;
  radius?: number }`.
- Lua: `Object.SetPrompt(obj, "Open chest", "e", 6)` → sets the field; register a
  `prompt_<id>` callback like the existing `trigger_enter_<id>` pattern in
  `lua-runtime.ts` (`firePlayerEnterTrigger` is the template).
- Server fires the prompt callback when the (primary or per-client) player is
  within `radius` AND the action key arrives — reuse the `input.action` (E) path
  in `_applyInput`.

**Client:**
- Render a world-space "Press E" billboard over the nearest in-range prompt
  entity (reuse `RemotePlayerAvatar.MakeWorldLabel` / `ChatBubbleBillboard`).
- On mobile, surface it as a toolbar/action button (the `equipTool`/toolbar
  pipeline already exists for tappable actions).

---

## 3. Spawn locations + spawn FX

**Why editor:** spawn points are placed in the scene by the creator; today there's
a single `PlayerState.spawnPoint` (default `[0,3,0]`).

**Server / data model:**
- Support multiple spawns: a `spawns: [number,number,number][]` on the world (set
  via Lua `Player.AddSpawn(x,y,z)` or by tagging placed entities as spawns).
- `addPlayer(clientId)` (already added in `lua-runtime.ts`) should pick a spawn
  (round-robin or random) instead of always the primary's spawnPoint.
- On respawn (`respawnPlayerToSpawn`), reuse the player's assigned spawn.

**Client:** optional spawn FX — reuse `EffectCoroutine` (`GameRenderClient`,
the `explosion`/`confetti` presets) at the spawn position on (re)spawn.

**Editor UI:** a placeable "Spawn point" object type; persists via EditorState.

---

## 4. Per-game movement tunables (walkSpeed / jumpPower)

**Why editor:** these are balance knobs the creator should own. The runtime
already reads `player.speed` and `player.jumpHeight` server-side.

**Server / data model:**
- Lua already can set these; expose them cleanly as
  `Player.SetWalkSpeed(n)` / `Player.SetJumpPower(n)` writing `world.player.speed`
  / `jumpHeight` (and propagate to each `simPlayers` entry on `addPlayer`, which
  already copies `speed`/`jumpHeight` from the primary).
- Add an optional movement **acceleration curve** (ramp-up/down) in `_applyInput`
  instead of instant velocity set — small, lerp `velocity` toward the target XZ.

**Editor UI:** sliders for walk speed / jump power / (optional) acceleration.

---

## 5. Topbar / HUD chrome

**Why editor:** parts (leaderstats columns, objective text, branding) are
per-game; the React UI layer owns layout.

**Plan:** extend the existing React HUD (the same layer that renders chat + the
toolbar). Add:
- Player list / leaderstats (top-right) — fed by the `presence` + per-client
  `score`/`health` already in the diff `player` field and `remotePlayers`.
- Configurable objective/title strip — already partially present via the
  `title`/`objective` UI events.

---

## 6. Multiplayer follow-ups (scoped out of first pass — need their own testing)

The first pass shipped **per-client physics simulation** (each player owns their
avatar) + **remote rendering / nametags / chat bubbles**. Two deeper pieces remain:

### 6a. Per-player avatar customization over the wire
Today remote avatars use the default tan chibi (no per-player body color / equipped
items). To fix:
- Carry each client's avatar descriptor (body color + equipped item URLs) into the
  room — send it on join (extend the join handshake / `presence` / `player_join`
  message in `room-manager.ts`).
- Include it in `RemotePlayerWire` (or a one-time `remoteAvatar` message).
- `RemotePlayerAvatar.Init` already takes a color; thread the real value in and
  call `LuauGameRunner.AttachAvatarItemsCoroutine` with the remote's equipped list.

### 6b. Per-player game-logic semantics (independent triggers / scoring)
The Lua API (`Player.GetPosition`, `Player.AddScore`, `OnPlayerEnter`, trigger
callbacks) is written around the single primary `world.player`. Today:
- Physics is per-client (`world.simPlayers`), but `_checkTriggers` and the Lua
  Player API still act on the **primary** only.
To make each player independently hit triggers / score:
- Thread a `playerId` through `_checkTriggers`, the `trigger_*`/`collision`/
  `action` callbacks, and the Lua `Player.*` API (breaking change — every existing
  game script's player references must resolve per-caller).
- This is a large, semantics-changing refactor and must be load-tested with
  multiple live clients before trusting it. Recommend doing it as its own project.

---

## Already implemented (runtime foundations — no editor work needed)

- **Camera spring + first-person zoom** — `LuauUnityApi.cs` `LuauOrbitCamera`
  (position smoothing in third-person; first-person hides the avatar + locks body
  to camera yaw when zoomed all the way in).
- **Footstep / jump / land SFX + ambient music** — `GameRenderClient` +
  `GameAudio` (cadence scales with speed; music from `scene.music`).
- **R-to-respawn (+ mobile `MobileGameInput.RequestReset`)** — client sends
  `{type:"respawn"}`; server `respawnPlayerToSpawn(clientId)` + the existing
  `y < -5` auto-respawn net.
- **Per-client server simulation** — `world.simPlayers`, `addPlayer`/`removePlayer`,
  `_stepPlayer`, per-client diffs with `remotePlayers` (`room-manager.ts`).
- **Remote-player rendering + nametags + chat bubbles** — `RemotePlayerAvatar.cs`
  + `GameRenderClient.ReconcileRemotePlayers`.
- **Avatar rotation/pivot + camera aim fixes** — `DeferredAvatarScale` horizontal
  centering; camera aims at root + fixed height.
