// Room manager — one LuaRuntime instance per active game session.
// Rooms spin up when the first player joins and tear down when the last one leaves.
// Multiple simultaneous rooms per gameId are supported (like Roblox's server list).

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { LuaRuntime } from './lua-runtime.js';
import type { StateDiff, ClientInput, EntityState, RemotePlayerWire, ToolbarState } from './world-state.js';
import { check as moderationCheck, strike as moderationStrike, strikes, duplicates, createReport, reportAllowed, logEvent } from './moderation/index.js';
import { REPORT_REASONS, type ReportReason } from './moderation/store.js';

// Sentinel cache-key for the "player spawn" chibi tray item (editor's bottom
// strip). Must match the identical literal in Assets/Scripts/Services/
// GameAssetLoader.cs (SpawnMarkerCacheKey) and react/src/App.tsx
// (PLAYER_SPAWN_ASSET.cacheKey) exactly — three independent runtimes agreeing
// on one string, no shared constant to import across them.
const PLAYER_SPAWN_MARKER_CACHE_KEY = '__player_spawn__';

const TICK_HZ         = 20;
const TICK_MS         = 1000 / TICK_HZ;
const IDLE_TIMEOUT_MS = 30_000; // tear down after 30s with no players
const MAX_ROOMS       = 50;     // hard cap on concurrent rooms per process

// Chat constants
const CHAT_MAX_LEN          = 200;   // hard cap on a single message
const CHAT_RATE_WINDOW_MS   = 10_000; // rolling window for rate-limit
const CHAT_RATE_MAX_IN_WIN  = 6;     // max messages per window per client
const CHAT_HISTORY_KEEP     = 50;    // last N messages cached for new joiners

// ── RoomClient ────────────────────────────────────────────────────────────────

const MAX_WS_MESSAGE_BYTES = 64 * 1024; // 64KB inbound message limit

interface RoomClient {
  id: string;
  ws: WebSocket;
  username: string;
  latestInput: ClientInput;
  lastSeen: number;
  lastInputSeq: number; // for deduplication
  chatTimestamps: number[]; // sliding window of recent chat send times
  // Moderation identity for strikes/mutes. ip+name so a mute survives a
  // reconnect but one player on a shared school/home NAT doesn't mute everyone.
  chatKey: string;
  // Sticky jump-edge latch: client SendInput pushes a jump=true packet for
  // exactly one frame (Input.GetKeyDown / MobileGameInput.JumpPressed both
  // last one Update frame), then the next ~3-4 frames send jump=false
  // before the next 50 ms server tick fires. Without this latch, the
  // server would routinely see latestInput.jump=false on the tick after a
  // press and silently eat the jump. Set whenever any inbound message has
  // jump=true; cleared once _tick has consumed it.
  jumpLatched: boolean;
  // Sticky key-pulse latch for toolbar taps, same problem as jumpLatched but
  // worse: handleMessage('equipTool') wrote the configured key straight into
  // latestInput.keys, and the client sends a fresh input packet EVERY FRAME
  // (~16 ms) which replaces `keys` wholesale. A server tick is 50 ms apart, so
  // the pulse was usually overwritten before any tick ever saw it and the tap
  // silently did nothing. Keys land here instead, are merged in at tick time,
  // and are cleared once the tick has consumed them.
  pulsedKeys: string[];
  // Same latch for the interact action. Desktop maps E to `action` (see
  // GameRenderClient.SendInput: `act = Input.GetKeyDown(KeyCode.E)`) and "e" is
  // deliberately NOT in the `keys` list, so generated scripts register interact
  // via Input.OnAction and never Input.OnKey("e"). Mobile has no interact
  // button — a toolbar slot is the only way in — but a tap used to pulse only
  // keys["e"], which nothing listens for. Mobile players therefore could not
  // interact at all in any game using the canonical Input.OnAction pattern.
  actionLatched: boolean;
  // Which toolbar slot THIS client has equipped. Equipping used to write to the
  // shared world toolbar, so one player tapping "shovel" flipped every other
  // player's UI to shovel too.
  equippedTool: string | null;
  // Set when this client's equipped slot changes, so the next tick sends it the
  // toolbar even though the shared toolbar state didn't change.
  toolbarDirty: boolean;
}

interface ChatMessage {
  type: 'chat';
  id: string;            // "<roomId>:<clientId>:<ts>" — used to report a message
  clientId: string;
  username: string;
  text: string;
  ts: number;
  censored?: boolean;
}

// ── Room ──────────────────────────────────────────────────────────────────────

export class Room {
  readonly id: string;
  readonly gameId: string;

  private lua: LuaRuntime;
  private clients: Map<string, RoomClient> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = Date.now();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private gameScript: string;
  // EditorState.Capture JSON authored in Unity's editor. Overlays per-entity
  // transform tweaks (and a subset of gear-panel settings) onto the world that
  // the Lua script produced — keyed by EntityState.name, which the Lua API
  // sets to a stable value (Object.Create("model:Zombie") → "model:Zombie";
  // obj:SetName("Boss") → "Boss"). Applied after _waitForInitialObjectPlacement
  // so every script-spawned entity exists. Empty / "{}" means no overlay.
  private editorStateJson: string;
  private destroying = false;

  // ── Game-ready gating ─────────────────────────────────────────────────────
  // The first client used to receive a snapshot the moment Lua's OnStart
  // returned. For scripts that place objects synchronously this is fine, but
  // any post-OnStart placement driven by Timer.After / coroutines / asset
  // resolution would not yet be in the world — the first client saw a
  // partial scene, while a second client connecting seconds later saw the
  // settled state. We now wait for object count to stabilise before flipping
  // gameReady, then send the snapshot. Subsequent joins are unaffected.
  private gameReady = false;
  private gameReadyAt: number = 0;
  private readyCallbacks: (() => void)[] = [];

  // Rolling chat history for the room. New joiners receive these as a
  // 'chat_history' message so they don't open the chat panel to a blank slate.
  private chatHistory: ChatMessage[] = [];
  // Pre-censor text per message id, kept server-side only for moderator review.
  private chatRaw = new Map<string, string>();

  onEmpty?: (room: Room) => void;

  constructor(gameId: string, gameScript: string, editorStateJson: string = '') {
    this.id       = randomUUID();
    this.gameId   = gameId;
    this.gameScript = gameScript;
    this.editorStateJson = editorStateJson || '';
    this.lua = new LuaRuntime();

    this.lua.onRestart  = () => this._handleRestart();
    this.lua.onGameEnd  = (result) => this._handleGameEnd(result);
  }

  async init(): Promise<void> {
    const t0 = Date.now();
    await this.lua.init(this.gameScript);
    const tOnStart = Date.now();
    console.log(`[Room ${this.id.slice(0, 8)}] OnStart complete in ${tOnStart - t0}ms — entity count ${this.lua.getWorldState().entities.size}`);

    // Belt-and-braces: wait for entity count to stabilize. Catches any tail of
    // post-OnStart placement (timers, async asset resolution) before clients
    // can sample the world.
    await this._waitForInitialObjectPlacement();

    // Overlay the creator's editor-session edits on top of the script-built
    // world BEFORE clients receive their initial snapshot, so first-paint is
    // already correct (no visible "snap from script position to authored
    // position" on cold-join).
    this._applyEditorStateOverlay();

    this._startTick();
    this._markGameReady();
    console.log(`[Room ${this.id.slice(0, 8)}] initialized for game ${this.gameId} — total init ${Date.now() - t0}ms, ${this.lua.getWorldState().entities.size} entities`);
  }

  // Pulls per-object transform + a subset of gear-panel Settings out of the
  // EditorState JSON shipped from Unity and applies them to matching entities
  // in the world. Match is by EntityState.name (which the Lua API sets to a
  // stable, script-defined value). Missing names are silently skipped — a
  // snapshot taken before the script was edited may reference objects that no
  // longer exist; the rest still applies.
  //
  // What is mapped:
  //   - position / rotation / scale  → entity transform fields
  //   - settings.invisible           → entity.visible = false
  //   - settings.physics             → entity.physics = true
  //
  // Not mapped (yet — would need server-side runtime support):
  //   - settings.destroyable/healthRegen/healthPoints/extraLives/explode
  //   - settings.move (auto-move) — there is no auto-move worker on the server
  //   - logic graphs (Custom Logic) — graph evaluator lives only client-side
  // These persist verbatim in editor_state_json so a future server-side
  // implementation can pick them up without a schema migration.
  private _applyEditorStateOverlay(): void {
    const raw = this.editorStateJson;
    if (!raw || raw === '{}') return;
    let parsed: {
      objects?: Array<{
        name?: string;
        position?: [number, number, number];
        rotation?: [number, number, number];
        scale?:    [number, number, number];
        settings?: Record<string, unknown>;
      }>;
      added?: Array<{
        position?: [number, number, number];
        recipe?: { cacheKey?: string };
      }>;
    };
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.warn(`[Room ${this.id.slice(0, 8)}] editor_state_json parse failed: ${(e as Error).message}`);
      return;
    }

    // Creator-placed spawn markers override the AI-authored Player.SetSpawnPoint
    // literal — same override relationship as Unity's LuauGameRunner (client-side
    // preview) applies, kept in sync here so real multiplayer rooms match. Read
    // from `added` (user-placed objects the Lua script never creates) BEFORE the
    // `objects` early-return below, since a game with only a spawn marker and no
    // other tweaks would otherwise skip this entirely.
    if (Array.isArray(parsed?.added)) {
      const markers: [number, number, number][] = [];
      for (const item of parsed.added) {
        if (item?.recipe?.cacheKey !== PLAYER_SPAWN_MARKER_CACHE_KEY) continue;
        if (Array.isArray(item.position) && item.position.length === 3) {
          markers.push([Number(item.position[0]) || 0, Number(item.position[1]) || 0, Number(item.position[2]) || 0]);
        }
      }
      if (markers.length > 0) {
        const world = this.lua.getWorldState();
        world.spawnPoints = markers;
        const pick = markers[Math.floor(Math.random() * markers.length)];
        world.player.spawnPoint = [...pick];
        world.player.position   = [pick[0], Math.max(pick[1], 1), pick[2]];
        console.log(`[Room ${this.id.slice(0, 8)}] ${markers.length} spawn marker(s) found — overriding Player.SetSpawnPoint.`);
      }
    }

    if (!Array.isArray(parsed?.objects)) return;

    // O(N+M) lookup. The Unity side keys snapshots on `transform.name`, which
    // resolves in this order on the C# side:
    //   1. value passed to obj:SetName(...) → server-side entity.name
    //   2. fallback to entity.type ("model:Zombie", "Structure.Cube", ...)
    // We mirror that here so an entry like "model:Zombie" still matches an
    // entity that the Lua never explicitly renamed. Name-keyed wins over
    // type-keyed when both exist (a `SetName` call overrides the default).
    const byKey = new Map<string, EntityState>();
    for (const [, e] of this.lua.getWorldState().entities) {
      if (e.type && !byKey.has(e.type)) byKey.set(e.type, e);     // fallback
    }
    for (const [, e] of this.lua.getWorldState().entities) {
      if (e.name) byKey.set(e.name, e);                            // primary
    }

    let applied = 0, missing = 0;
    for (const tweak of parsed.objects) {
      const name = tweak?.name;
      if (!name) continue;
      const e = byKey.get(name);
      if (!e) { missing++; continue; }
      if (Array.isArray(tweak.position) && tweak.position.length === 3) e.position = [Number(tweak.position[0]) || 0, Number(tweak.position[1]) || 0, Number(tweak.position[2]) || 0];
      if (Array.isArray(tweak.rotation) && tweak.rotation.length === 3) e.rotation = [Number(tweak.rotation[0]) || 0, Number(tweak.rotation[1]) || 0, Number(tweak.rotation[2]) || 0];
      if (Array.isArray(tweak.scale)    && tweak.scale.length    === 3) e.scale    = [Number(tweak.scale[0])    || 1, Number(tweak.scale[1])    || 1, Number(tweak.scale[2])    || 1];
      const s = tweak.settings;
      if (s && typeof s === 'object') {
        if (s.invisible === true || s.invisible === 'true') e.visible = false;
        if (s.physics   === true || s.physics   === 'true') e.physics = true;
      }
      applied++;
    }
    if (applied > 0 || missing > 0) {
      console.log(`[Room ${this.id.slice(0, 8)}] editor-state overlay: ${applied} applied, ${missing} skipped (script removed)`);
    }
  }

  private _markGameReady(): void {
    if (this.gameReady) return;
    this.gameReady   = true;
    this.gameReadyAt = Date.now();
    const cbs = this.readyCallbacks;
    this.readyCallbacks = [];
    if (cbs.length > 0) {
      console.log(`[Room ${this.id.slice(0, 8)}] gameReady → notifying ${cbs.length} waiting client(s)`);
    }
    for (const cb of cbs) { try { cb(); } catch {} }
  }

  // Polls entity count every 100ms; treats it as settled when the count holds
  // steady for 500ms. Capped at 10s total so a buggy script can't hang init.
  // After entities settle, also awaits Polyhaven texture resolutions (capped
  // at 3s) so the cold-join snapshot already carries every texture URL —
  // first frame paints with materials, no async pop-in on structurals.
  private async _waitForInitialObjectPlacement(timeoutMs = 10_000): Promise<void> {
    let lastCount = -1;
    let stableMs  = 0;
    const start   = Date.now();
    while (Date.now() - start < timeoutMs) {
      const n = this.lua.getWorldState().entities.size;
      if (n === lastCount) {
        stableMs += 100;
        if (stableMs >= 500) {
          console.log(`[Room ${this.id.slice(0, 8)}] object placement stable at ${n} entities (${Date.now() - start}ms)`);
          const tex0 = Date.now();
          await this.lua.awaitPendingTextures();
          if (Date.now() - tex0 > 5) {
            console.log(`[Room ${this.id.slice(0, 8)}] textures resolved in ${Date.now() - tex0}ms`);
          }
          return;
        }
      } else {
        stableMs = 0;
        lastCount = n;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    console.warn(`[Room ${this.id.slice(0, 8)}] object placement timeout — proceeding with ${this.lua.getWorldState().entities.size} entities`);
    await this.lua.awaitPendingTextures();
  }

  // Used by addClient() — never resolves until the Lua scene is fully built.
  private async _awaitGameReady(): Promise<void> {
    if (this.gameReady) return;
    await new Promise<void>(resolve => this.readyCallbacks.push(resolve));
  }

  // Called by RoomManager when a player connects to this room
  addClient(ws: WebSocket, username: string, ip = ''): string {
    const clientId  = randomUUID();
    const joinedAt  = Date.now();
    const wasReady  = this.gameReady;
    const wasEmpty  = this.clients.size === 0;

    // Room stays alive for IDLE_TIMEOUT_MS after the last client leaves, so
    // world.player keeps whatever position the previous occupant left it at.
    // A fresh joiner expects to spawn at the game's spawn point, not at the
    // previous player's footprint. Only reset on empty→occupied transitions
    // so an in-progress multiplayer session is never disrupted.
    if (wasEmpty && this.gameReady) this.lua.respawnPlayerToSpawn();

    // Broadcast presence join to all existing clients before adding the new one
    this._broadcastAll({ type: 'player_join', clientId, username });

    const client: RoomClient = {
      id: clientId,
      ws,
      username,
      lastSeen: joinedAt,
      latestInput: this._emptyInput(clientId),
      lastInputSeq: -1,
      chatTimestamps: [],
      chatKey: `${ip || 'noip'}|${username.toLowerCase()}`,
      jumpLatched: false,
      pulsedKeys: [],
      actionLatched: false,
      equippedTool: null,
      toolbarDirty: false,
    };
    this.clients.set(clientId, client);

    // Give this client its own server-simulated avatar so players in the same
    // room no longer share one body.
    this.lua.addPlayer(clientId);

    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    const entityCount = this.lua.getWorldState().entities.size;
    console.log(`[Room ${this.id.slice(0, 8)}] join ${clientId.slice(0, 8)} (${username}) — gameReady=${this.gameReady} entities=${entityCount}`);

    // Defer the snapshot until the room is fully initialized. Resolves
    // immediately for any second-or-later joiner since gameReady is already true.
    this._sendSnapshotWhenReady(client, joinedAt, wasReady);

    // Also send current presence list to the new client (this is independent
    // of game-ready; players can already see each other before scene is built).
    const others = Array.from(this.clients.values())
      .filter(c => c.id !== clientId)
      .map(c => ({ clientId: c.id, username: c.username }));
    if (others.length > 0) {
      this._sendTo(client, { type: 'presence', players: others });
    }

    // Replay recent chat history to the new joiner so they see ongoing
    // conversation when they enter the room. Older messages above the
    // CHAT_HISTORY_KEEP cap are dropped.
    if (this.chatHistory.length > 0) {
      this._sendTo(client, { type: 'chat_history', messages: this.chatHistory });
    }

    // Notify Lua of new player
    this.lua.firePlayerJoined(clientId, client.username);

    return clientId;
  }

  private async _sendSnapshotWhenReady(
    client: RoomClient,
    joinedAt: number,
    wasReady: boolean,
  ): Promise<void> {
    if (!this.gameReady) {
      console.log(`[Room ${this.id.slice(0, 8)}] holding snapshot for ${client.username} until gameReady`);
      await this._awaitGameReady();
    }
    // Client may have disconnected while waiting
    if (!this.clients.has(client.id) || client.ws.readyState !== WebSocket.OPEN) return;

    const world = this.lua.getWorldState();
    this._sendSnapshot(client);
    const waited = wasReady ? 0 : (Date.now() - joinedAt);
    console.log(`[Room ${this.id.slice(0, 8)}] snapshot → ${client.username} ` +
      `entities=${world.entities.size} player=${world.player.position.join(',')} ` +
      `${waited > 0 ? `waited=${waited}ms` : '(immediate)'}`);
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    this.lua.removePlayer(clientId);
    this.lua.firePlayerLeft(clientId);
    console.log(`[Room ${this.id.slice(0, 8)}] -player ${clientId.slice(0, 8)}`);

    // Broadcast presence leave to all remaining clients
    this._broadcastAll({ type: 'player_leave', clientId });

    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => this.onEmpty?.(this), IDLE_TIMEOUT_MS);
    }
  }

  handleMessage(clientId: string, msg: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeen = Date.now();

    if (msg.type === 'input') {
      // Sequence-number deduplication: discard packets older than last processed
      const seq = typeof msg.seq === 'number' ? msg.seq : -1;
      if (seq !== -1 && seq <= client.lastInputSeq) return; // duplicate or out-of-order
      if (seq !== -1) client.lastInputSeq = seq;

      // Latch any jump=true: it takes ~3-5 client frames between successive
      // server ticks, so a one-frame Input.GetKeyDown burst would otherwise
      // be overwritten by the next jump=false packet before _tick fires.
      if (!!msg.jump) client.jumpLatched = true;

      client.latestInput = {
        playerId: clientId,
        forward:  !!msg.forward,
        back:     !!msg.back,
        left:     !!msg.left,
        right:    !!msg.right,
        jump:     client.jumpLatched, // sticky until _tick consumes it
        action:   !!msg.action,
        keys:     (msg.keys as Record<string, boolean>) ?? {},
        moveX:    typeof msg.moveX === 'number' ? msg.moveX : undefined,
        moveZ:    typeof msg.moveZ === 'number' ? msg.moveZ : undefined,
        groundY:  typeof msg.groundY === 'number' ? msg.groundY : undefined,
        pos:      vec3(msg.pos),
        vel:      vec3(msg.vel),
        grounded: typeof msg.grounded === 'boolean' ? msg.grounded : undefined,
        tpSeq:    typeof msg.tpSeq === 'number' ? msg.tpSeq : undefined,
        mouseX:   Number(msg.mouseX ?? 0),
        mouseY:   Number(msg.mouseY ?? 0),
        swipe:    msg.swipe ? String(msg.swipe) : undefined,
      };
    } else if (msg.type === 'resync') {
      // Client detected a gap in diffs and requests a fresh snapshot
      this._sendSnapshot(client);
    } else if (msg.type === 'respawn') {
      // Client noticed it fell below the void threshold and is asking the
      // server to teleport it back to spawn. The server already auto-respawns
      // any player below y=-5 each tick, but echoing it lets us re-broadcast
      // the position immediately instead of waiting for the next physics step.
      this.lua.respawnPlayerToSpawn(clientId);
    } else if (msg.type === 'trigger_enter') {
      // Client reports trigger overlap (physics callback). The sending socket
      // identifies the player, so pass it through — the runtime makes it the
      // acting player for the callback and dedupes against its own AABB sweep.
      const entityId = String(msg.entityId ?? '');
      if (entityId) this.lua.firePlayerEnterTrigger(entityId, clientId);
    } else if (msg.type === 'trigger_exit') {
      const entityId = String(msg.entityId ?? '');
      if (entityId) this.lua.firePlayerExitTrigger(entityId, clientId);
    } else if (msg.type === 'collision') {
      const entityId = String(msg.entityId ?? '');
      const otherName = String(msg.otherName ?? '');
      if (entityId) this.lua.fireCollision(entityId, otherName, clientId);
    } else if (msg.type === 'hud_event') {
      const eventName = String(msg.eventName ?? '').trim();
      if (eventName) this.lua.fireHudEvent(eventName, clientId);
    } else if (msg.type === 'chat') {
      this._handleChat(client, msg);
    } else if (msg.type === 'report') {
      this._handleReport(client, msg);
    } else if (msg.type === 'equipTool') {
      // Mobile player tapped a toolbar button. Two things happen:
      //   1) Record the equipped slot for THIS client only, and mark its
      //      toolbar dirty so the next tick echoes the highlight back to it.
      //      Other players keep whatever they had equipped.
      //   2) Latch the configured key so the script's existing key handler
      //      runs identically to a desktop "1"/"2"/"E" keypress. The latch is
      //      consumed by exactly one tick — writing straight into
      //      latestInput.keys lost the press to the next per-frame input packet.
      const name = String(msg.name ?? '');
      const key  = String(msg.key  ?? '').toLowerCase();
      client.equippedTool = name;
      client.toolbarDirty = true;
      if (key && !client.pulsedKeys.includes(key)) client.pulsedKeys.push(key);
      // "e" is the interact convention — mirror the desktop mapping so the tap
      // reaches Input.OnAction handlers too, not just Input.OnKey("e").
      if (key === 'e') client.actionLatched = true;
    }
  }

  // Validate, moderate, throttle and broadcast a chat message from a client.
  // Three layers of defence: length cap, profanity/hate filter (`moderateChat`)
  // and a per-client rolling-window rate limiter. Any rejection is reported
  // back to just the sender as a {type:'chat_rejected'} so the UI can show a
  // toast or shake the input — other clients never see the failed attempt.
  private _handleChat(client: RoomClient, msg: Record<string, unknown>): void {
    const raw = String(msg.text ?? '').trim();
    if (!raw) return;
    if (raw.length > CHAT_MAX_LEN) {
      this._sendTo(client, { type: 'chat_rejected', reason: `Message too long (max ${CHAT_MAX_LEN}).` });
      return;
    }

    // Rate limit: drop oldest timestamps outside the rolling window, then
    // count what remains. We don't track per-IP because a single user can
    // legitimately have multiple tabs open — per-clientId is the right grain.
    const now = Date.now();
    client.chatTimestamps = client.chatTimestamps.filter(t => now - t < CHAT_RATE_WINDOW_MS);
    if (client.chatTimestamps.length >= CHAT_RATE_MAX_IN_WIN) {
      this._sendTo(client, { type: 'chat_rejected', reason: 'You’re sending messages too fast.' });
      return;
    }

    const mutedMs = strikes.mutedFor(client.chatKey, now);
    if (mutedMs > 0) {
      this._sendTo(client, { type: 'chat_rejected', reason: `You’re muted for ${Math.ceil(mutedMs / 1000)}s.`, mutedMs });
      return;
    }

    if (duplicates.isRepeat(client.chatKey, raw, now)) {
      this._sendTo(client, { type: 'chat_rejected', reason: 'Please don’t repeat the same message.' });
      return;
    }

    const mod = moderationCheck(raw, 'chat', { id: client.chatKey, name: client.username }, { targetType: 'room', targetId: this.id });
    if (!mod.ok) {
      const muteFor = moderationStrike(client.chatKey, mod);
      this._sendTo(client, {
        type: 'chat_rejected',
        reason: muteFor > 0 ? `${mod.userMessage ?? 'Message blocked.'} You’re muted for ${Math.ceil(muteFor / 1000)}s.` : (mod.userMessage ?? 'Message blocked by moderation.'),
        ...(muteFor > 0 ? { mutedMs: muteFor } : {}),
      });
      return;
    }
    const censored = mod.violations.some(v => v.action === 'censor');

    client.chatTimestamps.push(now);
    const id = `${this.id}:${client.id}:${now}`;
    const out: ChatMessage = {
      type: 'chat',
      id,
      clientId: client.id,
      username: client.username,
      text: mod.text,
      ts: now,
      ...(censored ? { censored: true } : {}),
    };
    this.chatRaw.set(id, raw);

    // Append to history (cap length) and broadcast to all clients including
    // the sender so their UI reflects the canonical (possibly censored) text.
    this.chatHistory.push(out);
    if (this.chatHistory.length > CHAT_HISTORY_KEEP) {
      for (const old of this.chatHistory.splice(0, this.chatHistory.length - CHAT_HISTORY_KEEP)) this.chatRaw.delete(old.id);
    }
    this._broadcastAll(out);
  }

  /** Server-verified copy of a chat message for moderator review (null if expired). */
  findChat(clientId: string, ts: number): string | null {
    const m = this.chatHistory.find(c => c.clientId === clientId && c.ts === ts);
    if (!m) return null;
    return `${m.username}: ${this.chatRaw.get(m.id) ?? m.text}`;
  }

  // { type:'report', messageId?, targetClientId?, reason, details? }
  // Reports a chat message (preferred — snapshot is taken from server history)
  // or a player. The reporter only gets an ack; the target is never told.
  private _handleReport(client: RoomClient, msg: Record<string, unknown>): void {
    const reason = String(msg.reason ?? 'other') as ReportReason;
    if (!REPORT_REASONS.includes(reason)) { this._sendTo(client, { type: 'report_ack', ok: false, error: 'invalid reason' }); return; }
    if (!reportAllowed(client.chatKey)) { this._sendTo(client, { type: 'report_ack', ok: false, error: 'Too many reports — try again later.' }); return; }
    const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
    const chat = messageId ? this.chatHistory.find(c => c.id === messageId) : undefined;
    const targetClientId = chat?.clientId ?? String(msg.targetClientId ?? '');
    const target = this.clients.get(targetClientId);
    if (!chat && !target) { this._sendTo(client, { type: 'report_ack', ok: false, error: 'Message or player not found.' }); return; }

    const recent = this.chatHistory.filter(c => c.clientId === targetClientId).slice(-5)
      .map(c => `${c.username}: ${this.chatRaw.get(c.id) ?? c.text}`).join('\n');
    const report = createReport({
      reporterId: `room:${client.chatKey}`,
      targetType: chat ? 'chat' : 'user',
      targetId: chat ? chat.id : `room:${target!.chatKey}`,
      reason,
      details: String(msg.details ?? '').slice(0, 500),
      snapshot: chat ? `${chat.username}: ${this.chatRaw.get(chat.id) ?? chat.text}\n--- recent ---\n${recent}` : `player ${target!.username}\n--- recent ---\n${recent}`,
      verified: true,
    });
    logEvent({ context: 'report', action: 'report', actorId: client.chatKey, targetType: report.targetType, targetId: report.targetId, excerpt: `${reason}: ${report.snapshot}`, categories: [], matches: [], source: 'lexicon' });
    this._sendTo(client, { type: 'report_ack', ok: true });
  }

  async hot_reload(newScript: string): Promise<void> {
    console.log(`[Room ${this.id.slice(0, 8)}] hot-reloading game script`);
    this.gameScript = newScript;
    try {
      await this.lua.hot_reload(newScript);
      // Re-overlay the editor session — the new script will have rebuilt
      // entities from scratch, so the previously-applied transforms are gone
      // and must be reapplied before clients receive their reload snapshot.
      this._applyEditorStateOverlay();
      // Notify clients to clear their scene and receive fresh snapshot next tick
      this._broadcastAll({ type: 'reload' });
      for (const client of this.clients.values()) {
        this._sendSnapshot(client);
      }
    } catch (e) {
      console.error(`[Room ${this.id.slice(0, 8)}] hot-reload failed:`, e);
    }
  }

  // Server-side editor-state updates from the live editor (so PATCH
  // /api/game/:id/editor-state can push the latest overlay into any active
  // room without rebuilding the world). Called by RoomManager.hot_reload_state.
  applyNewEditorState(json: string): void {
    this.editorStateJson = json || '';
    this._applyEditorStateOverlay();
    // Snapshots are sent at the next tick automatically — clients will see the
    // refreshed positions then. No explicit broadcast needed because the diff
    // system already emits the per-entity updates.
  }

  destroy(): void {
    if (this.destroying) return;
    this.destroying = true;
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.idleTimer)    clearTimeout(this.idleTimer);
    this.lua.destroy();
    for (const c of this.clients.values()) {
      try { c.ws.close(); } catch {}
    }
    this.clients.clear();
    console.log(`[Room ${this.id.slice(0, 8)}] destroyed`);
  }

  get playerCount(): number { return this.clients.size; }

  // ── Private ──────────────────────────────────────────────────────────────

  private _startTick(): void {
    this.tickInterval = setInterval(() => void this._tick(), TICK_MS);
  }

  private async _tick(): Promise<void> {
    if (this.destroying) return;
    const now = Date.now();
    const dt  = Math.min((now - this.lastTickTime) / 1000, 0.1); // cap at 100ms
    this.lastTickTime = now;

    if (this.clients.size === 0) return;

    // Collect latest inputs from all clients, folding in any toolbar-tap key
    // pulses latched since the previous tick.
    const inputs = Array.from(this.clients.values()).map(c =>
      (c.pulsedKeys.length === 0 && !c.actionLatched)
        ? c.latestInput
        : {
            ...c.latestInput,
            action: c.latestInput.action || c.actionLatched,
            keys: { ...c.latestInput.keys, ...Object.fromEntries(c.pulsedKeys.map(k => [k, true])) },
          },
    );

    let diff: StateDiff;
    try {
      diff = await this.lua.tick(dt, inputs);
    } catch (e) {
      console.error(`[Room ${this.id.slice(0, 8)}] tick error:`, e);
      return;
    }

    // Clear jumpLatched on every client now that the tick has consumed it.
    // The next jump=true input message re-arms it. We do this AFTER tick
    // succeeds so a thrown exception doesn't silently swallow the jump.
    for (const c of this.clients.values()) {
      if (c.jumpLatched) {
        c.jumpLatched = false;
        c.latestInput.jump = false;
      }
      if (c.pulsedKeys.length > 0) c.pulsedKeys.length = 0;
      c.actionLatched = false;
    }

    // Assemble a PER-CLIENT diff: shared world changes (entities/scene/events/
    // toolbar) plus that client's OWN full player state and everyone else's as
    // remotePlayers. Each player owns its avatar now, so diff.player must be the
    // recipient's own state — not the primary's.
    const sim   = this.lua.getWorldState().simPlayers;
    const multi = this.clients.size > 1;
    const baseMeaningful = this._hasMeaningfulDiff(diff);
    for (const c of this.clients.values()) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      const own     = sim.get(c.id);
      const remotes = multi ? this._remotePlayersFor(c.id) : [];
      // Personal-feedback events (a "+10" toast, a damage flash) carry the
      // clientId that earned them; everything else is room-wide. Without this,
      // every player saw every other player's score popups and screen shakes.
      const events = diff.events.filter(e => e.to == null || e.to === c.id);
      // Nothing to say to this client: no shared changes, alone in the room,
      // and (when we have its state) it isn't moving. Stream player state while
      // there are peers so remote avatars interpolate smoothly.
      if (!baseMeaningful && !multi && own == null && !c.toolbarDirty) continue;
      const data: StateDiff = {
        ...diff,
        events,
        player: own
          ? { position: [...own.position], velocity: [...own.velocity], grounded: own.grounded,
              score: own.score, health: own.health, teleportSeq: own.teleportSeq ?? 0 }
          : diff.player,
        ...(remotes.length ? { remotePlayers: remotes } : {}),
      };
      // Equipped slot is per-client; the tool LIST is shared. Send this client's
      // own highlight whenever either changed.
      if (diff.toolbar || c.toolbarDirty) {
        data.toolbar = this._toolbarFor(c, diff.toolbar);
        c.toolbarDirty = false;
      }
      this._sendTo(c, { type: 'diff', data });
    }
  }

  // Shared tool list + this client's own equipped slot. Falls back to the
  // world-level equipped value (what UI.SetToolbar declared) until the player
  // has tapped something themselves.
  private _toolbarFor(client: RoomClient, shared?: ToolbarState): ToolbarState {
    const base = shared ?? this.lua.getWorldState().toolbar ?? { tools: [], equipped: '' };
    return {
      tools: [...base.tools],
      equipped: client.equippedTool ?? base.equipped,
    };
  }

  // Build the remote-player render list for one recipient (everyone else).
  private _remotePlayersFor(excludeId: string): RemotePlayerWire[] {
    const sim = this.lua.getWorldState().simPlayers;
    const out: RemotePlayerWire[] = [];
    for (const c of this.clients.values()) {
      if (c.id === excludeId) continue;
      const p = sim.get(c.id);
      if (!p) continue;
      out.push({
        clientId: c.id,
        username: c.username,
        position: [...p.position] as [number, number, number],
        velocity: [...p.velocity] as [number, number, number],
        grounded: p.grounded,
      });
    }
    return out;
  }

  private _hasMeaningfulDiff(diff: StateDiff): boolean {
    return (
      diff.entities.created.length > 0 ||
      diff.entities.updated.length > 0 ||
      diff.entities.destroyed.length > 0 ||
      diff.events.length > 0 ||
      diff.player != null ||
      diff.scene != null
    );
  }

  private _sendSnapshot(client: RoomClient): void {
    const world = this.lua.getWorldState();
    const own     = world.simPlayers.get(client.id) ?? world.player;
    const remotes = this._remotePlayersFor(client.id);
    const snapshot = {
      type: 'snapshot',
      world: {
        entities: Array.from(world.entities.values()),
        player:   own,
        ...(remotes.length ? { remotePlayers: remotes } : {}),
        scene:    world.scene,
        tick:     world.tickNumber,
        // Toolbar is part of the cold-join snapshot so a mobile player who
        // joins after Lua's OnStart already ran sees the buttons immediately,
        // without waiting for the next UI.SetToolbar diff (which never fires
        // again — most games register the toolbar exactly once at startup).
        toolbar:  this._toolbarFor(client),
      },
    };
    this._sendTo(client, snapshot);
  }

  private _broadcastAll(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try { client.ws.send(payload); } catch {}
      }
    }
  }

  private _sendTo(client: RoomClient, msg: unknown): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try { client.ws.send(JSON.stringify(msg)); } catch {}
  }

  private _handleRestart(): void {
    // Reinitialize Lua with same script
    this.lua.destroy();
    this.lua = new LuaRuntime();
    this.lua.onRestart = () => this._handleRestart();
    this.lua.onGameEnd = (r) => this._handleGameEnd(r);
    this.lua.init(this.gameScript).then(() => {
      // Same as init() — re-overlay the editor state on the freshly-built
      // world so a restart preserves the creator's tweaks.
      this._applyEditorStateOverlay();
      // The fresh runtime has no sim players — re-register everyone still here.
      for (const c of this.clients.values()) this.lua.addPlayer(c.id);
      this._broadcastAll({ type: 'reload' });
      for (const c of this.clients.values()) this._sendSnapshot(c);
    }).catch(e => console.error('[Room] restart failed:', e));
  }

  private _handleGameEnd(result: string): void {
    // Restart after 5s
    setTimeout(() => this._handleRestart(), 5000);
  }

  private _emptyInput(playerId: string): ClientInput {
    return {
      playerId,
      forward: false, back: false, left: false, right: false,
      jump: false, action: false, keys: {},
    };
  }
}

// ── RoomManager ───────────────────────────────────────────────────────────────

export class RoomManager {
  // rooms maps roomId → Room
  private rooms: Map<string, Room> = new Map();
  // gameRooms maps gameId → Set<roomId>
  private gameRooms: Map<string, Set<string>> = new Map();

  // Get or create a room for a game (creates one if all existing rooms are full).
  // `editorStateJson` is the EditorState.Capture overlay shipped by the editor —
  // pass the published version for public play (forge_games.published_editor_state_json)
  // and the live draft for editor-preview rooms.
  async getOrCreateRoom(gameId: string, gameScript: string, editorStateJson: string = '', maxPlayersPerRoom = 16): Promise<Room> {
    // Find an existing room with space
    const roomIds = this.gameRooms.get(gameId) ?? new Set();
    for (const roomId of roomIds) {
      const room = this.rooms.get(roomId);
      if (room && room.playerCount < maxPlayersPerRoom) return room;
    }

    // Create a new room
    if (this.rooms.size >= MAX_ROOMS) {
      throw new Error('Server at capacity — please try again shortly');
    }

    const room = new Room(gameId, gameScript, editorStateJson);
    room.onEmpty = (r) => this._destroyRoom(r.id);

    await room.init();

    this.rooms.set(room.id, room);
    if (!this.gameRooms.has(gameId)) this.gameRooms.set(gameId, new Set());
    this.gameRooms.get(gameId)!.add(room.id);

    return room;
  }

  // Re-apply a fresh editor-state overlay to every active room for a game
  // without rebuilding it. Triggered by PATCH /api/game/:id/editor-state so
  // the creator's tweaks land in active multiplayer sessions immediately,
  // not just on the next room creation.
  hot_reload_editor_state(gameId: string, editorStateJson: string): number {
    const roomIds = this.gameRooms.get(gameId) ?? new Set();
    let n = 0;
    for (const roomId of roomIds) {
      const room = this.rooms.get(roomId);
      if (room) { room.applyNewEditorState(editorStateJson); n++; }
    }
    return n;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  // Hot-reload all active rooms for a gameId when /api/edit-game is called
  async hot_reload_game(gameId: string, newScript: string): Promise<number> {
    const roomIds = this.gameRooms.get(gameId) ?? new Set();
    let reloaded = 0;
    for (const roomId of roomIds) {
      const room = this.rooms.get(roomId);
      if (room) {
        await room.hot_reload(newScript);
        reloaded++;
      }
    }
    return reloaded;
  }

  getRoomsForGame(gameId: string): Room[] {
    const ids = this.gameRooms.get(gameId) ?? new Set();
    return [...ids].map(id => this.rooms.get(id)).filter(Boolean) as Room[];
  }

  stats() {
    return {
      totalRooms:   this.rooms.size,
      totalPlayers: Array.from(this.rooms.values()).reduce((s, r) => s + r.playerCount, 0),
    };
  }

  private _destroyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.destroy();
    this.rooms.delete(roomId);
    const gameRoomIds = this.gameRooms.get(room.gameId);
    if (gameRoomIds) {
      gameRoomIds.delete(roomId);
      if (gameRoomIds.size === 0) this.gameRooms.delete(room.gameId);
    }
    console.log(`[RoomManager] Room ${roomId.slice(0, 8)} removed. Total rooms: ${this.rooms.size}`);
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
    this.gameRooms.clear();
  }
}

export const roomManager = new RoomManager();

// Parse a finite [x, y, z] from an untrusted client message, else undefined.
function vec3(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const out = v.map(Number);
  return out.every(n => Number.isFinite(n) && Math.abs(n) < 1e6) ? out as [number, number, number] : undefined;
}
