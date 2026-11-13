// Server-authoritative game render client.
// Connects to /api/game-ws, receives world state diffs, and renders them in Unity.
// Unity is a pure render client — no game logic runs locally in play mode.
// Edit mode still uses LuauGameRunner for fast local iteration.
//
// WebSocket: uses System.Net.WebSockets.ClientWebSocket (same as SupabaseRealtimeClient).
// JSON:      uses Newtonsoft.Json (com.unity.nuget.newtonsoft-json 3.0.2).

using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering.Universal;
using ReactUnity.UGUI;

public class GameRenderClient : MonoBehaviour
{
    public static GameRenderClient Instance { get; private set; }

    [SerializeField] private Transform gameRoot;
    [SerializeField] private Transform playerSpawn;

    // ── Network state ─────────────────────────────────────────────────────────

    private ClientWebSocket _ws;
    private CancellationTokenSource _cts;
    private string  _clientId;
    private string  _roomId;
    private bool    _connected;
    private int     _gameId;
    private string  _username;
    private bool    _active;

    // Reconnection state — exponential backoff with a hard cap of 5 attempts.
    // Schedule: 1s, 2s, 4s, 8s, 16s. Only after all five fail do we surface
    // "Disconnected from server." — transient drops are silently recovered.
    private const int    ReconnectMaxAttempts = 5;
    private int          _reconnectAttempt;
    private bool         _reconnecting;
    private string       _assetUrlsJson;
    private string       _humanoidIdsJson;
    // Sticky across reconnects so the published session reconnects to the
    // published room, not the draft. Defaults to false (draft) for callers
    // that pre-date the published-snapshot feature.
    private bool         _published;

    // Ping/pong heartbeat — send {type:"ping"} every 15s; if the server doesn't
    // pong within 5s, treat the connection as dead and force a reconnect before
    // the OS-level TCP keepalive notices (which can take 60+ seconds).
    private const float  PingIntervalSec   = 15f;
    private const float  PongTimeoutSec    = 5f;
    private float        _nextPingAt;
    private float        _pongDeadline;
    private bool         _awaitingPong;

    // Messages received from server (thread-safe queue, dispatched on main thread)
    private readonly ConcurrentQueue<string> _inboundQueue = new();

    // ── Scene state ───────────────────────────────────────────────────────────

    private GameObject _playerInstance;
    private LuauPlayerController _playerCtrl;
    private float _speed      = RobloxPhysics.WalkSpeed;
    private float _jumpHeight = RobloxPhysics.JumpHeight;
    // Server-authoritative velocity for the local player. We can't read it from
    // the client Rigidbody because it's kinematic (no client-side physics) —
    // ApplyPlayerState fills this from each diff's velocity field, and
    // LateUpdate reads it to pick the right walk/run/jump animation state.
    private Vector3 _playerServerVelocity;
    private bool    _playerServerGrounded = true;

    // ── Client-side prediction ───────────────────────────────────────────────
    // The local player is simulated HERE, every frame, using the same Roblox
    // constants and the same integrator as the server (RobloxPhysics +
    // world-state.ts). The server stays authoritative — its diffs are folded
    // back in by ReconcilePlayerState below — but the avatar responds to input
    // on the frame you press it instead of waiting a network round-trip.
    //
    // Before this existed, the local player's transform was written ONLY inside
    // ApplyPlayerState, i.e. once per server diff at 20 Hz, while world entities
    // were lerped every frame in Update. So your own avatar visibly stepped at
    // 20 Hz and every jump/turn lagged by a round-trip — the biggest single
    // contributor to the movement feeling cheap.
    private Vector3 _predPos;
    private Vector3 _predVel;
    private bool    _predGrounded = true;
    private bool    _predReady;
    // Input sampled once per frame in Update and reused by both the predictor
    // and SendInput, so the packet the server integrates can never disagree with
    // what we just predicted locally.
    private Vector2 _frameMove;
    private bool    _frameJump;
    // Beyond this much positional disagreement we assume the server did
    // something we cannot predict (teleport, spawn reset, world-bounds clamp,
    // void respawn) and hard-snap instead of easing, which would otherwise
    // visibly slide the avatar across the map.
    private const float ReconcileSnapDistance = 3f;
    // Fraction of the remaining error absorbed per second while easing. High
    // enough to converge quickly, low enough that routine sub-centimetre
    // integration differences are invisible.
    private const float ReconcileRate = 6f;
    // Fixed simulation step, matching PLAYER_SUBSTEP in world-state.ts so client
    // and server integrate the same trajectory. Leftover time is carried in
    // _predAccum and extrapolated at render time.
    private const float PredictionSubstep = 1f / 60f;
    private float _predAccum;
    // Mirrors the server's 150 ms coyote window (_lastGroundedAtById in
    // lua-runtime.ts). Without it the predictor would refuse a jump the server
    // then grants — the server's avatar rises, ours doesn't, and reconciliation
    // has to drag us upward, which reads as a mushy or swallowed jump right at
    // the edge of a platform.
    private const float CoyoteTime = 0.15f;
    private float _predLastGroundedAt = -999f;

    // Client-authoritative movement. The predictor now runs the shared
    // RobloxCharacterMotor (real capsule collisions against the loaded world,
    // which the server can't see) and ships its position to the server, which
    // validates it for plausibility. The server only overrides us by bumping
    // teleportSeq (Lua Player.SetPosition, respawn, void/world-bounds clamp),
    // so routine diffs no longer tug the avatar mid-jump — that tug was the
    // camera "shake" on every jump. A server that predates teleportSeq gets
    // the old easing reconcile instead.
    private RobloxCharacterMotor.State _motor;
    private Vector3 _predPrevPos;
    private int     _teleportSeq = -1;   // last server teleport we applied
    private bool    _serverHasTeleportSeq;
    private CapsuleCollider _playerCol;

    private readonly Dictionary<string, GameObject> _entities     = new();
    // Other players in the room, keyed by clientId. Spawned/updated/despawned
    // from the server's per-tick `remotePlayers` list.
    private readonly Dictionary<string, RemotePlayerAvatar> _remotePlayers = new();
    private readonly Dictionary<string, Vector3>    _targetPos    = new();
    // Per-entity bookkeeping for AI-driven humanoid animation. We compute
    // movement speed each frame from the lerped transform delta, drive the
    // Animator's IsWalking parameter, and rotate the model to face the travel
    // direction so zombies actually walk forward instead of sliding sideways.
    private readonly Dictionary<string, Vector3>  _entityPrevPos    = new();
    private readonly Dictionary<string, Animator> _entityAnimators  = new();
    // Hold IsWalking=true for this many seconds after the last detected motion.
    // Server's lua-runtime caps tick-Lua at 8ms (MAX_TICK_MS) and skips
    // OnUpdate when the rest of the tick already used the budget — so for a
    // 56-entity scene, position diffs for zombies actually arrive every
    // ~1.5–2.5 s rather than every 50ms. We hold the walk-anim flag for 3s
    // after each motion event so the walk pose stays continuous between
    // sparse diffs. Idle entities never trigger the threshold so they remain
    // in the Idle state.
    private const float WalkAnimHoldSec = 3f;
    private readonly Dictionary<string, float>    _entityLastMovedAt = new();
    private static readonly int IsWalkingHash = Animator.StringToHash("IsWalking");

    private GameAssetLoader _assetLoader;

    // ── Entity ground snapping ───────────────────────────────────────────────
    // IDs of non-terrain meshy entities that need their Y corrected to sit on
    // top of the terrain. Server-side lua scripts often place props at fixed
    // y values like 0 or 1, but the meshy chibi terrain is 0.5–1.5 m thick,
    // so those props end up partially submerged. We track which entities
    // need correction here and re-apply the snap whenever ApplyEntityData
    // sets their position from a fresh server diff.
    private readonly HashSet<string> _groundSnapIds = new();

    // ── Ground following ─────────────────────────────────────────────────────
    // The server's _stepPhysics historically clamped the player to a flat
    // y = max(0.5, spawn.y) plane, which fought every meshy terrain hill or
    // elevated platform: the avatar either sank into the surface (target.y
    // < surface.y) or hovered above (target.y > surface.y) and could never
    // jump because the server thought "y > 0.5 ≠ ground". We now raycast
    // straight down each frame from above the player, find the highest
    // collider underneath, and pass that ground height to the server in
    // every input packet. The server clamps to the client-supplied groundY
    // and calls grounded=true within a small tolerance — so jumps trigger
    // correctly on any height of terrain.
    private const int GroundRayMask = ~0; // all layers; we filter own collider

    // Must match TERRAIN_GRID_SIZE on the server (api-server/src/world-state.ts).
    // 64x64 segments per terrain — every Structure.CreateTerrain entity builds
    // a deformable mesh of this resolution, and every diff carrying
    // terrainHeights ships exactly TERRAIN_GRID_SIZE^2 floats.
    private const int TERRAIN_GRID_SIZE = 64;
    private float _lastGroundY = 0f;

    // Cast straight down from a point well above the target xz to find the
    // top of any collider beneath. Excludes any collider attached to the
    // player so we don't self-hit. Returns the original fallbackY if nothing
    // is hit (e.g. terrain not yet loaded).
    private float ProbeGroundY(float x, float z, float fallbackY)
    {
        // Start just above the feet (fallbackY is passed as feetY - 5 by the
        // callers) so a bridge, tree canopy or roof overhead is never mistaken
        // for the floor — starting 50 m up teleported the avatar onto anything
        // it walked under.
        const float ProbeStartHeight = 5f + RobloxCharacterMotor.StepHeight;
        const float ProbeMaxDistance = 200f;
        var origin = new Vector3(x, fallbackY + ProbeStartHeight, z);
        var hits = Physics.RaycastAll(origin, Vector3.down, ProbeMaxDistance, GroundRayMask, QueryTriggerInteraction.Ignore);
        if (hits == null || hits.Length == 0) return fallbackY;
        float best = float.NegativeInfinity;
        bool found = false;
        var playerRoot = _playerInstance != null ? _playerInstance.transform : null;
        foreach (var h in hits)
        {
            // Skip the player's own colliders so we never raycast into the capsule we're trying to ground.
            if (playerRoot != null && h.collider != null && h.collider.transform.IsChildOf(playerRoot)) continue;
            if (!found || h.point.y > best) { best = h.point.y; found = true; }
        }
        if (!found) return fallbackY;
        _lastGroundY = best;
        return best;
    }

    // ── Chat ─────────────────────────────────────────────────────────────────
    // Rolling log of recent chat messages received from the server. Capped at
    // ChatLogMax — older messages are evicted on insert. Pushed to React via
    // Globals._chatLog (JSON-serialized) so the HUD overlay can render the
    // top-left chat panel without owning any state itself.
    private const int ChatLogMax = 50;
    private readonly List<ChatLogEntry> _chatLog = new();
    private GameObject _localBubble;
    private float _localBubbleHideAt;

    [Serializable]
    private class ChatLogEntry
    {
        public string clientId;
        public string username;
        public string text;
        public long   ts;
    }

    // ── Animation ─────────────────────────────────────────────────────────────
    private GameObject _poseSrc;
    private Dictionary<string, Transform> _poseSourceBones;
    private Dictionary<string, Transform> _chibiTargetBones;
    private readonly Dictionary<string, AnimationClip> _animClips     = new();
    private readonly Dictionary<string, float>         _animNormTimes = new();
    private readonly Dictionary<string, bool>          _animClipLoops = new();
    private string _currentAnimState = "";
    private float  _animPlayTime     = 0f;
    private float  _stepTimer        = 0f;  // footstep SFX cadence

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
    }

    private void OnDestroy()
    {
        Instance = null;
        CloseConnection();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    // Called by GameLauncher to start a server-authoritative play session.
    // published=true asks the server to spin up (or join) the room running the
    // frozen published snapshot of the script. The public play feed uses this
    // so post-publish draft edits don't bleed into other players' sessions.
    public IEnumerator StartSession(int gameId, string username, string assetUrlsJson, string humanoidIdsJson, bool published = false)
    {
        _gameId          = gameId;
        _username        = username;
        _assetUrlsJson   = assetUrlsJson;
        _humanoidIdsJson = humanoidIdsJson;
        _published       = published;
        _reconnectAttempt = 0;
        _reconnecting     = false;

        // Chat is per-session. Drop the previous session's chat log AND
        // republish an empty array to React so its panel clears immediately —
        // without the empty publish, React's dedup guard (lastChatJSON) holds
        // the prior session's serialized log and the user sees stale messages
        // ("hi" from a previous game) until the next chat arrives.
        _chatLog.Clear();
        NotifyReact("_chatLog", "[]");
        // Roster is per-session for the same reason — clear the dedup guard so
        // the first diff of the new session always publishes.
        _playerListJson = "";
        NotifyReact("_playerList", "");
        // Toolbar is also per-session — same dedup-guard concern. Server's
        // snapshot will repopulate this once the new game's UI.SetToolbar runs.
        NotifyReact("_gameToolbar", "");
        // HUD buttons are editor-authored (SceneSettings) and static per session.
        // Push once at session start so React renders them for the whole game.
        NotifyReact("_hudButtons", SceneSettings.HudButtonsJson ?? "");
        // Interface Builder elements/workflows — same static-per-session push.
        NotifyReact("_interfaceElements", SceneSettings.InterfaceElementsJson ?? "");
        NotifyReact("_interfaceWorkflows", SceneSettings.InterfaceWorkflowsJson ?? "");

        // Belt-and-suspenders: kill the wardrobe-screen avatar preview before
        // the gameplay session starts. GameLauncher.LaunchAsync already calls
        // SetVisible(false) before reaching here, but in some flows (direct
        // StartSession, recovery after disconnect, hot-reload) the launcher
        // path is bypassed. Without this, the AvatarPreviewController camera
        // keeps rendering the chibi parts onto its render texture and React's
        // overlay paints them on top of the live game — the user sees their
        // wardrobe avatar floating alongside the in-game player ("double
        // avatar" bug). Idempotent — safe to call when already hidden.
        try { AvatarPreviewController.Instance?.SetVisible(false); } catch {}
        // Also tear down any LuauGameRunner orbit-preview spawned by the
        // GamePreviewScreen — the original double-avatar source. Calling
        // ExitGame here means even tests / programmatic StartSession (which
        // skips GameLauncher entirely) get the same teardown the launcher's
        // play-mode branch performs at line ~439.
        try { LuauGameRunner.Instance?.ExitGame(); } catch {}
        // Mark the session active up-front. ConnectCoroutine's "wait for join
        // ack" loop has `&& _active` as an early-abort guard so the user can
        // cancel a hanging connect — but if we leave _active=false here, the
        // loop bails out before iterating once, and the "Timed out waiting for
        // join ack" error fires at t=0 with no actual wait. EndSession sets
        // _active=false to abort cleanly.
        _active = true;

        if (gameRoot == null)
        {
            var go = new GameObject("ServerGameRoot");
            gameRoot = go.transform;
        }

        // Pre-load Meshy GLB assets so they're ready when the snapshot arrives.
        if (_assetLoader != null) Destroy(_assetLoader);
        _assetLoader = gameObject.AddComponent<GameAssetLoader>();
        if (!string.IsNullOrEmpty(assetUrlsJson) && assetUrlsJson != "{}")
            yield return _assetLoader.LoadAssets(assetUrlsJson, humanoidIdsJson ?? "[]");

        SpawnPlayer();
        EnsureGameCamera();

        // Open WebSocket and start background receive loop.
        _cts = new CancellationTokenSource();
        yield return ConnectCoroutine();
    }

    public void EndSession()
    {
        _active = false;
        CloseConnection();
        TearDownScene();
        TearDownAnimations();
        if (_playerInstance != null) { Destroy(_playerInstance); _playerInstance = null; }
        if (_assetLoader  != null) { Destroy(_assetLoader);  _assetLoader  = null; }
        MobileGameInput.Instance?.SetVisible(false);
        // Drop chat history when leaving the session so the next game starts
        // with an empty panel. Mirrors StartSession's clear so either entry
        // point keeps the per-session invariant.
        _chatLog.Clear();
        NotifyReact("_chatLog", "[]");
        _playerListJson = "";
        NotifyReact("_playerList", "");
        NotifyReact("_gameToolbar", "");
        NotifyReact("_gameActive", "");
        Debug.Log("[GameRenderClient] Session ended.");
    }

    // ── Update ────────────────────────────────────────────────────────────────

    private void Update()
    {
        // Drain the inbound queue on the main thread.
        while (_inboundQueue.TryDequeue(out var raw))
            HandleServerMessage(raw);

        if (!_active || !_connected) return;

        // Void-fall safety net. If the player's local transform somehow ends up
        // far below the world (transient physics, server lag, broken script),
        // ask the server to respawn us. Server-side already does this on its
        // own state, but this ensures the visible capsule snaps back instantly
        // rather than waiting for a server diff.
        if (_playerInstance != null && _playerInstance.transform.position.y < -10f)
        {
            Debug.LogWarning($"[GameRenderClient] Player below void threshold (y={_playerInstance.transform.position.y:F1}) — requesting respawn.");
            SendJson(new { type = "respawn" });
            _playerInstance.transform.position = new Vector3(0, 1, 0);
            var rb = _playerInstance.GetComponent<Rigidbody>();
            if (rb != null && !rb.isKinematic)
            {
                rb.linearVelocity   = Vector3.zero;
                rb.angularVelocity  = Vector3.zero;
            }
        }

        // Heartbeat: ping every 15 s, expect pong within 5 s. A missed pong
        // means the server-side socket is wedged; trigger reconnect proactively.
        if (Time.unscaledTime >= _nextPingAt)
        {
            _nextPingAt   = Time.unscaledTime + PingIntervalSec;
            _pongDeadline = Time.unscaledTime + PongTimeoutSec;
            _awaitingPong = true;
            SendJson(new { type = "ping", t = (long)(Time.unscaledTime * 1000) });
        }
        if (_awaitingPong && Time.unscaledTime > _pongDeadline)
        {
            Debug.LogWarning("[GameRenderClient] Pong timeout — forcing reconnect.");
            _awaitingPong = false;
            _connected    = false;
            _inboundQueue.Enqueue("{\"type\":\"disconnected\"}"); // routed through reconnect path
        }

        // Sample input once, predict locally from it, then ship the same numbers
        // to the server. Order matters: the predictor and the packet must agree.
        SampleFrameInput();
        StepPrediction(Time.deltaTime);

        // Send one input packet per frame.
        SendInput();

        // Hide local chat bubble after its display window elapses. We don't
        // destroy the GameObject — the next chat send re-uses the same canvas
        // to avoid the per-message allocation of a fresh world-space UI tree.
        if (_localBubble != null && _localBubble.activeSelf && Time.unscaledTime > _localBubbleHideAt)
            _localBubble.SetActive(false);

        // Smoothly interpolate entity positions toward server-authoritative targets.
        foreach (var kv in _targetPos)
        {
            if (!_entities.TryGetValue(kv.Key, out var go) || go == null) continue;
            go.transform.localPosition = Vector3.Lerp(
                go.transform.localPosition, kv.Value, Time.deltaTime * 15f);
        }

        // Face the player avatar toward its travel direction. In
        // server-authoritative play the Rigidbody is kinematic, so
        // LuauPlayerController.Update returns before its rotation slerp can
        // run; without this block the avatar's root transform stays at its
        // spawn rotation forever, which LateUpdate then bakes into every
        // bone via `playerRootRot * hipsSrc.rotation` — the symptom is a
        // chibi that walks/strafes in any direction but visually only ever
        // faces world-forward. We use the server-authoritative velocity (set
        // by ApplyPlayerState) rather than the local transform delta because
        // the client transform is just a lerp of server positions and reads
        // back as nearly-zero motion between diffs. Shift lock is the one
        // case where rotation is owned elsewhere (LuauOrbitCamera), so let
        // that path keep authority.
        if (_playerInstance != null && !LuauOrbitCamera.ShiftLock)
        {
            Vector3 horiz = _playerServerVelocity;
            horiz.y = 0f;
            // 0.04 = (0.2 m/s)^2 — above lerp/diff jitter, below walking pace.
            if (horiz.sqrMagnitude > 0.04f)
            {
                var look = Quaternion.LookRotation(horiz.normalized, Vector3.up);
                _playerInstance.transform.rotation = Quaternion.Slerp(
                    _playerInstance.transform.rotation, look, Time.deltaTime * 30f);
            }
        }

        // ── Drive AI-humanoid animations from observed motion ───────────────
        // Server-driven zombies (and any other entity whose GLB came in with
        // is_humanoid=true) get an Animator wired to PlayerAnimController in
        // GameAssetLoader.TryAttachAnimator. Nothing was driving that
        // Animator's IsWalking parameter though — they just slid across the
        // ground in a default Idle pose. Here we compute movement speed from
        // the per-frame transform delta and toggle IsWalking + face the entity
        // toward the travel direction so the zombie genuinely walks.
        if (_entities.Count > 0 && Time.deltaTime > 0.0001f)
        {
            float dt = Time.deltaTime;
            foreach (var (id, go) in _entities)
            {
                if (go == null) continue;
                // Resolve the Animator once per entity (lazy cache)
                if (!_entityAnimators.TryGetValue(id, out var anim))
                {
                    anim = go.GetComponentInChildren<Animator>();
                    _entityAnimators[id] = anim;
                }
                Vector3 cur = go.transform.position;
                if (_entityPrevPos.TryGetValue(id, out var prev))
                {
                    Vector3 delta = cur - prev;
                    delta.y = 0f; // ignore vertical bob from terrain mesh
                    // Threshold of 0.5 u/s squared = effectively "real" position
                    // delta from a server diff, ignoring lerp noise.
                    if (delta.magnitude / dt > 0.5f)
                        _entityLastMovedAt[id] = Time.time;

                    bool walking = _entityLastMovedAt.TryGetValue(id, out var last)
                                   && (Time.time - last) < WalkAnimHoldSec;

                    if (anim != null && anim.runtimeAnimatorController != null)
                        anim.SetBool(IsWalkingHash, walking);

                    if (delta.sqrMagnitude > 0.0001f)
                    {
                        var look = Quaternion.LookRotation(delta.normalized, Vector3.up);
                        go.transform.rotation = Quaternion.Slerp(go.transform.rotation, look, dt * 8f);
                    }
                }
                _entityPrevPos[id] = cur;
            }
        }
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────

    private IEnumerator ConnectCoroutine()
    {
        var baseUrl = PludoApiClient.BaseUrl
            .Replace("https://", "wss://")
            .Replace("http://",  "ws://")
            .TrimEnd('/');
        var wsUrl = _published
            ? $"{baseUrl}/api/game-ws?gameId={_gameId}&published=true"
            : $"{baseUrl}/api/game-ws?gameId={_gameId}";
        Debug.Log($"[GameRenderClient] Connecting → {wsUrl}");

        _ws = new ClientWebSocket();
        var connectTask = _ws.ConnectAsync(new Uri(wsUrl), _cts.Token);

        // Wait for connect (yield each frame)
        while (!connectTask.IsCompleted) yield return null;

        if (connectTask.IsFaulted || _ws.State != WebSocketState.Open)
        {
            Debug.LogError("[GameRenderClient] WebSocket connect failed.");
            NotifyReact("_gameMessage", "Could not connect to game server.");
            yield break;
        }

        // Start background receive loop.
        _ = ReceiveLoopAsync(_cts.Token);

        // Send join message.
        SendJson(new { type = "join", username = _username, gameId = _gameId.ToString() });

        // Wait up to 8 s for server to acknowledge.
        float waited = 0f;
        while (!_connected && waited < 8f && _active)
        {
            waited += Time.deltaTime;
            yield return null;
        }

        if (!_connected)
        {
            NotifyReact("_gameMessage", "Server did not respond.");
            Debug.LogError("[GameRenderClient] Timed out waiting for join ack.");
        }
    }

    // Exponential-backoff reconnect: 1s, 2s, 4s, 8s, 16s. Only after all five
    // attempts fail do we surface the user-facing "Disconnected from server."
    // message — transient drops never reach the user.
    private IEnumerator ReconnectCoroutine()
    {
        _reconnecting = true;
        int[] backoffSec = { 1, 2, 4, 8, 16 };

        while (_reconnectAttempt < ReconnectMaxAttempts && _active)
        {
            int delaySec = backoffSec[_reconnectAttempt];
            _reconnectAttempt++;
            Debug.Log($"[GameRenderClient] Reconnect attempt {_reconnectAttempt}/{ReconnectMaxAttempts} in {delaySec}s…");
            float t0 = Time.unscaledTime;
            while (Time.unscaledTime - t0 < delaySec && _active) yield return null;
            if (!_active) break;

            // Tear down the dead socket (if any) before opening a new one.
            try { _ws?.Abort(); } catch {}
            _ws = null;
            _connected = false;
            if (_cts == null || _cts.IsCancellationRequested)
                _cts = new CancellationTokenSource();

            yield return ConnectCoroutine();

            if (_connected)
            {
                Debug.Log($"[GameRenderClient] Reconnected on attempt {_reconnectAttempt}.");
                _reconnecting = false;
                yield break; // success — _reconnectAttempt is reset by the "joined" handler
            }
        }

        // All attempts exhausted — now show the user.
        _reconnecting = false;
        if (_active)
        {
            Debug.LogError($"[GameRenderClient] Reconnect failed after {ReconnectMaxAttempts} attempts.");
            NotifyReact("_gameMessage", "Disconnected from server.");
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buf = new byte[65536];
        var sb  = new StringBuilder();
        try
        {
            while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                WebSocketReceiveResult result;
                sb.Clear();
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), ct);
                    sb.Append(Encoding.UTF8.GetString(buf, 0, result.Count));
                } while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                    break;
                }

                _inboundQueue.Enqueue(sb.ToString());
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { Debug.LogWarning($"[GameRenderClient] ReceiveLoop: {e.Message}"); }
        finally
        {
            _connected = false;
            if (_active) _inboundQueue.Enqueue("{\"type\":\"disconnected\"}");
        }
    }

    private void SendJson(object obj)
    {
        if (_ws?.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(obj));
        _ = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts?.Token ?? CancellationToken.None);
    }

    // Samples this frame's movement + jump input into _frameMove / _frameJump.
    // Called once per frame BEFORE both StepPrediction and SendInput so the
    // motion we predict locally and the packet the server integrates are driven
    // by the exact same numbers — if these two ever diverged, the reconciler
    // would fight the predictor on every frame.
    private void SampleFrameInput()
    {
        var joy   = MobileGameInput.MoveInput;
        bool fwd  = Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)    || joy.y > 0.2f;
        bool back = Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)  || joy.y < -0.2f;
        bool left = Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)  || joy.x < -0.2f;
        bool right= Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow) || joy.x > 0.2f;

        float h = Mathf.Abs(joy.x) > 0.05f ? joy.x : ((right ? 1f : 0f) - (left ? 1f : 0f));
        float v = Mathf.Abs(joy.y) > 0.05f ? joy.y : ((fwd   ? 1f : 0f) - (back ? 1f : 0f));

        _frameMove = Vector2.zero;
        if (Mathf.Abs(h) > 0.01f || Mathf.Abs(v) > 0.01f)
        {
            Vector3 camFwd = Vector3.forward, camRight = Vector3.right;
            if (Camera.main != null)
            {
                camFwd   = Camera.main.transform.forward; camFwd.y   = 0f;
                if (camFwd.sqrMagnitude > 0.0001f)   camFwd.Normalize();   else camFwd   = Vector3.forward;
                camRight = Camera.main.transform.right;   camRight.y = 0f;
                if (camRight.sqrMagnitude > 0.0001f) camRight.Normalize(); else camRight = Vector3.right;
            }
            Vector3 move = camFwd * v + camRight * h;
            // Don't normalize — preserve joystick magnitude for analog feel,
            // but cap to length 1 so a diagonal keypress doesn't go √2 faster.
            float mag = move.magnitude;
            if (mag > 1f) move /= mag;
            _frameMove = new Vector2(move.x, move.z);
        }

        _frameJump = Input.GetKeyDown(KeyCode.Space) || MobileGameInput.JumpPressed;
    }

    // Integrates the local player, mirroring the server's _stepPlayer exactly —
    // same ramp, same gravity, same ground clamp, and critically the same FIXED
    // timestep. Integrating on raw frame time instead would make a 120 fps
    // client and a 30 fps client compute measurably different jump arcs (Euler
    // discretisation error scales with step size), so each would disagree with
    // the server by a different amount and reconciliation would be visible on
    // some machines and not others. Fixed steps make every client and the server
    // produce bit-comparable trajectories.
    private void StepPrediction(float dt)
    {
        if (_playerInstance == null || dt <= 0f) return;

        // Seed from wherever the avatar currently is on the first frame, so
        // prediction starts from the server's spawn rather than the origin.
        if (!_predReady)
        {
            _predPos      = _playerInstance.transform.position;
            _predVel      = Vector3.zero;
            _predGrounded = false;
            _predReady    = true;
            _predAccum    = 0f;
            _predPrevPos  = _predPos;
            _motor = new RobloxCharacterMotor.State { Pos = _predPos, LastGroundedAt = -999f };
        }
        if (_playerCol == null) _playerCol = _playerInstance.GetComponent<CapsuleCollider>();

        // Read live Physics.gravity so Scene.SetGravity (incl. zero-g) applies.
        float gravity = Physics.gravity.y;

        // Clamp the accumulator so a long hitch (asset load, GC spike) doesn't
        // spiral into hundreds of catch-up substeps in one frame.
        _predAccum = Mathf.Min(_predAccum + dt, 0.25f);

        // Consume the jump on a LOCAL copy; _frameJump still goes out in
        // SendInput so server-side Lua jump hooks keep firing.
        bool jumpPending = _frameJump;
        bool held = MobileGameInput.JumpHeld || Input.GetKey(KeyCode.Space);

        _motor.Pos = _predPos; _motor.Vel = _predVel; _motor.Grounded = _predGrounded;
        while (_predAccum >= PredictionSubstep)
        {
            _predAccum  -= PredictionSubstep;
            _predPrevPos = _motor.Pos;
            bool want = jumpPending || (held && _motor.Grounded);
            RobloxCharacterMotor.Step(ref _motor, _frameMove, want, _speed, _jumpHeight,
                                      gravity, Time.time, _playerInstance.transform, _playerCol);
            jumpPending = false;
        }
        _predPos = _motor.Pos; _predVel = _motor.Vel; _predGrounded = _motor.Grounded;
        if (_predGrounded) _predLastGroundedAt = Time.time;

        // Render between the last two substeps — smooth at 120 Hz and never
        // ahead of the collision-checked position.
        _playerInstance.transform.position =
            Vector3.Lerp(_predPrevPos, _predPos, _predAccum / PredictionSubstep);

        // Drive rotation + animation from PREDICTED motion so both react on the
        // input frame.
        _playerServerVelocity = _predVel;
        _playerServerGrounded = _predGrounded;
    }

    // Folds an authoritative server position back into the prediction. Small
    // disagreements (integration rounding, a tick of latency) are eased away;
    // large ones mean the server did something unpredictable — a teleport,
    // spawn reset, world-bounds clamp or void respawn — and are snapped.
    private void ReconcilePlayerState(Vector3 serverPos, Vector3 serverVel)
    {
        if (!_predReady)
        {
            _predPos      = serverPos;
            _predVel      = serverVel;
            _predPrevPos  = serverPos;
            _motor = new RobloxCharacterMotor.State { Pos = serverPos, Vel = serverVel, LastGroundedAt = -999f };
            _predReady    = true;
            return;
        }

        if (Vector3.Distance(_predPos, serverPos) > ReconcileSnapDistance)
        {
            _predPos = serverPos;
            _predVel = serverVel;
            return;
        }

        float a = 1f - Mathf.Exp(-ReconcileRate * Time.deltaTime);
        _predPos = Vector3.Lerp(_predPos, serverPos, a);
    }

    private void SendInput()
    {
        var joy   = MobileGameInput.MoveInput;
        bool fwd  = Input.GetKey(KeyCode.W) || Input.GetKey(KeyCode.UpArrow)    || joy.y > 0.2f;
        bool back = Input.GetKey(KeyCode.S) || Input.GetKey(KeyCode.DownArrow)  || joy.y < -0.2f;
        bool left = Input.GetKey(KeyCode.A) || Input.GetKey(KeyCode.LeftArrow)  || joy.x < -0.2f;
        bool right= Input.GetKey(KeyCode.D) || Input.GetKey(KeyCode.RightArrow) || joy.x > 0.2f;
        bool jump = _frameJump;
        bool act  = Input.GetKeyDown(KeyCode.E);

        // R resets the avatar to its spawn point (Roblox-style). The server is
        // authoritative on position, so we just ask it to teleport; the diff
        // that follows lerps the rendered avatar back to spawn.
        if (Input.GetKeyDown(KeyCode.R) || MobileGameInput.ConsumeReset())
            SendJson(new { type = "respawn" });

        var keys = new Dictionary<string, bool>();
        foreach (var k in new[] { "f","r","q","1","2","3","shift","ctrl","tab","enter" })
            if (IsKeyDown(k)) keys[k] = true;

        // Camera-relative move vector, sampled once per frame by
        // SampleFrameInput and shared with the local predictor. The server's
        // _applyInput used to take raw forward/back/left/right booleans and
        // resolve them in world axes, so "forward" was always +Z regardless of
        // where the camera was looking — orbiting the camera 90° still drove the
        // avatar north. Booleans are still sent for backwards compatibility but
        // the server prefers moveX/moveZ when either is non-zero.
        float moveX = _frameMove.x, moveZ = _frameMove.y;

        // Tell the server the live ground height beneath the player. Lets it
        // clamp the player to the actual terrain surface (instead of the old
        // flat y = 0.5 plane) so jumping works on any platform/hill, and the
        // capsule never sinks into a meshy slope. Computed against the
        // CURRENT rendered position so it matches what the camera shows.
        float groundY = 0f;
        if (_playerInstance != null)
        {
            var pp = _playerInstance.transform.position;
            groundY = ProbeGroundY(pp.x, pp.z, pp.y - 5f);
        }

        if (_serverHasTeleportSeq && _predReady)
        {
            var pv = _predPos; var vv = _predVel;
            SendJson(new { type="input", forward=fwd, back, left, right, jump, action=act, keys, moveX, moveZ, groundY,
                           pos = new[] { pv.x, pv.y, pv.z }, vel = new[] { vv.x, vv.y, vv.z },
                           grounded = _predGrounded, tpSeq = _teleportSeq });
        }
        else
            SendJson(new { type="input", forward=fwd, back, left, right, jump, action=act, keys, moveX, moveZ, groundY });
    }

    private static bool IsKeyDown(string key) => key switch
    {
        "f"     => Input.GetKeyDown(KeyCode.F),
        "r"     => Input.GetKeyDown(KeyCode.R),
        "q"     => Input.GetKeyDown(KeyCode.Q),
        "1"     => Input.GetKeyDown(KeyCode.Alpha1),
        "2"     => Input.GetKeyDown(KeyCode.Alpha2),
        "3"     => Input.GetKeyDown(KeyCode.Alpha3),
        "shift" => Input.GetKeyDown(KeyCode.LeftShift),
        "ctrl"  => Input.GetKeyDown(KeyCode.LeftControl),
        "tab"   => Input.GetKeyDown(KeyCode.Tab),
        "enter" => Input.GetKeyDown(KeyCode.Return),
        _       => false,
    };

    private void CloseConnection()
    {
        _cts?.Cancel();
        _cts = null;
        if (_ws?.State == WebSocketState.Open)
            _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "session ended", CancellationToken.None);
        _ws = null;
        _connected = false;
    }

    // ── Message handling ──────────────────────────────────────────────────────

    private void HandleServerMessage(string raw)
    {
        JObject msg;
        try { msg = JObject.Parse(raw); }
        catch { return; }

        switch (msg["type"]?.Value<string>() ?? "")
        {
            case "joined":
                _clientId  = msg["clientId"]?.Value<string>() ?? "";
                _roomId    = msg["roomId"]?.Value<string>()   ?? "";
                _connected = true;
                _active    = true;
                _reconnectAttempt = 0; // healthy join resets the backoff counter
                _nextPingAt       = Time.unscaledTime + PingIntervalSec;
                _awaitingPong     = false;
                NotifyReact("_gameActive", "true");
                MobileGameInput.Instance?.SetVisible(true);
                Debug.Log($"[GameRenderClient] Joined room {_roomId?.Substring(0, Math.Min(8, _roomId?.Length ?? 0))}");
                break;

            case "pong":
                _awaitingPong = false;
                break;

            case "snapshot":
                ApplySnapshot(msg["world"] as JObject);
                break;

            case "diff":
                ApplyDiff(msg["data"] as JObject);
                break;

            case "reload":
                TearDownScene();
                break;

            case "disconnected":
                _connected = false;
                if (_active && !_reconnecting) StartCoroutine(ReconnectCoroutine());
                break;

            case "error":
                var errMsg = msg["message"]?.Value<string>() ?? "Server error";
                Debug.LogError($"[GameRenderClient] Server: {errMsg}");
                NotifyReact("_gameMessage", errMsg);
                break;

            case "chat":
                HandleIncomingChat(msg);
                break;

            case "chat_history":
                if (msg["messages"] is JArray hist)
                {
                    foreach (var m in hist) HandleIncomingChat(m as JObject);
                }
                break;

            case "chat_rejected":
                NotifyReact("_chatError", msg["reason"]?.Value<string>() ?? "Message blocked.");
                break;
        }
    }

    // Append a server-broadcast chat message to the rolling log, push it to
    // React via Globals._chatLog, and pop a world-space bubble above the
    // speaker — the local avatar for our own messages, or the matching remote
    // player's avatar when we're rendering them.
    private void HandleIncomingChat(JObject msg)
    {
        if (msg == null) return;
        var entry = new ChatLogEntry
        {
            clientId = msg["clientId"]?.Value<string>() ?? "",
            username = msg["username"]?.Value<string>() ?? "Player",
            text     = msg["text"]?.Value<string>()     ?? "",
            ts       = msg["ts"]?.Value<long>()         ?? 0,
        };
        if (string.IsNullOrEmpty(entry.text)) return;
        _chatLog.Add(entry);
        if (_chatLog.Count > ChatLogMax) _chatLog.RemoveRange(0, _chatLog.Count - ChatLogMax);
        // React polls _chatLog at 100ms; we just publish the latest JSON here.
        NotifyReact("_chatLog", JsonConvert.SerializeObject(_chatLog));
        if (!string.IsNullOrEmpty(_clientId) && entry.clientId == _clientId)
            ShowLocalBubble(entry.text);
        else if (_remotePlayers.TryGetValue(entry.clientId, out var remote) && remote != null)
            remote.ShowBubble(entry.text);
    }

    // Fires a named game event from a HudButton (action="event"). The server
    // receives it and fires Lua Events.On("hudButton:<name>", fn) so creators
    // can script custom reactions without writing any button code.
    public void FireHudEvent(string eventName)
    {
        if (string.IsNullOrEmpty(eventName)) return;
        SendJson(new { type = "hud_event", eventName });
    }

    // React calls this via the sendChat global. We trim, length-cap-mirror the
    // server's CHAT_MAX_LEN, and ship to the room. The server is the
    // authoritative source for moderation/rate-limit; this is purely an early
    // exit so we don't spam the socket with empty packets.
    public void SendChat(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        var trimmed = text.Trim();
        if (trimmed.Length > 200) trimmed = trimmed.Substring(0, 200);
        SendJson(new { type = "chat", text = trimmed });
    }

    // World-space chat bubble that floats above the local player's avatar for
    // 3 seconds after they send a message. Built lazily as a child of
    // _playerInstance so it inherits position automatically and is destroyed
    // along with the avatar when the session ends. Uses a billboard via a
    // LateUpdate face-camera step in the helper component below.
    private void ShowLocalBubble(string text)
    {
        if (_playerInstance == null) return;
        if (_localBubble == null)
        {
            var go = new GameObject("[ChatBubble]");
            go.transform.SetParent(_playerInstance.transform, false);
            go.transform.localPosition = new Vector3(0f, 2.6f, 0f);
            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.sortingOrder = 100;
            var cs = go.AddComponent<UnityEngine.UI.CanvasScaler>();
            cs.dynamicPixelsPerUnit = 30;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = new Vector2(2.4f, 0.8f);
            rt.localScale = new Vector3(0.01f, 0.01f, 0.01f); // canvas units → world meters

            var bg = new GameObject("Bg");
            bg.transform.SetParent(go.transform, false);
            var bgImg = bg.AddComponent<UnityEngine.UI.Image>();
            bgImg.color = new Color(0f, 0f, 0f, 0.78f);
            var bgRT = bg.GetComponent<RectTransform>();
            bgRT.anchorMin = Vector2.zero; bgRT.anchorMax = Vector2.one;
            bgRT.offsetMin = new Vector2(-12f, -8f);
            bgRT.offsetMax = new Vector2( 12f,  8f);

            var label = new GameObject("Text");
            label.transform.SetParent(go.transform, false);
            var t = label.AddComponent<UnityEngine.UI.Text>();
            t.text = text;
            t.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            t.alignment = TextAnchor.MiddleCenter;
            t.color = Color.white;
            t.fontSize = 28;
            t.horizontalOverflow = HorizontalWrapMode.Wrap;
            t.verticalOverflow   = VerticalWrapMode.Overflow;
            var tRT = label.GetComponent<RectTransform>();
            tRT.anchorMin = Vector2.zero; tRT.anchorMax = Vector2.one;
            tRT.offsetMin = tRT.offsetMax = Vector2.zero;

            go.AddComponent<ChatBubbleBillboard>();
            _localBubble = go;
        }
        else
        {
            var t = _localBubble.GetComponentInChildren<UnityEngine.UI.Text>();
            if (t != null) t.text = text;
            _localBubble.SetActive(true);
        }
        _localBubbleHideAt = Time.unscaledTime + 3f;
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    private void ApplySnapshot(JObject world)
    {
        if (world == null) return;
        TearDownScene();

        if (world["scene"] is JObject scene) ApplySceneConfig(scene);
        if (world["player"] is JObject player) ApplyPlayerState(player);
        if (world["entities"] is JArray entities)
            foreach (var e in entities) CreateEntity(e as JObject);
        if (world["toolbar"] is JObject toolbar) PublishToolbar(toolbar);
        ReconcileRemotePlayers(world["remotePlayers"]);
    }

    // ── Diff ──────────────────────────────────────────────────────────────────

    private void ApplyDiff(JObject diff)
    {
        if (diff == null) return;

        if (diff["entities"] is JObject ents)
        {
            if (ents["created"] is JArray created)
                foreach (var e in created) CreateEntity(e as JObject);
            if (ents["updated"] is JArray updated)
                foreach (var e in updated) UpdateEntity(e as JObject);
            if (ents["destroyed"] is JArray destroyed)
                foreach (var id in destroyed) DestroyEntity(id?.Value<string>() ?? "");
        }

        if (diff["player"] is JObject player) ApplyPlayerState(player);
        if (diff["scene"]  is JObject scene)  ApplySceneConfig(scene);
        if (diff["events"] is JArray events)
            foreach (var ev in events) HandleUIEvent(ev as JObject);
        if (diff["toolbar"] is JObject toolbar) PublishToolbar(toolbar);
        // remotePlayers is present every tick while ≥2 players are in the room,
        // and absent once the recipient is alone — so a missing field means
        // "despawn everyone else". Always reconcile (null token → despawn all).
        ReconcileRemotePlayers(diff["remotePlayers"]);
    }

    // Spawn/update/despawn remote-player avatars from the server's full
    // remotePlayers list. A null/empty token despawns all of them.
    private void ReconcileRemotePlayers(JToken token)
    {
        var seen = _remotePlayersSeen;
        seen.Clear();

        if (token is JArray arr)
        {
            foreach (var rpTok in arr)
            {
                if (!(rpTok is JObject rp)) continue;
                var id = rp["clientId"]?.Value<string>();
                if (string.IsNullOrEmpty(id) || id == _clientId) continue;

                Vector3 pos = ReadVec3(rp["position"]);
                Vector3 vel = ReadVec3(rp["velocity"]);
                bool grounded = rp["grounded"]?.Value<bool>() ?? true;

                if (!_remotePlayers.TryGetValue(id, out var avatar) || avatar == null)
                {
                    var go = new GameObject($"RemotePlayer_{id.Substring(0, Math.Min(8, id.Length))}");
                    if (gameRoot != null) go.transform.SetParent(gameRoot, false);
                    avatar = go.AddComponent<RemotePlayerAvatar>();
                    avatar.Init(id, rp["username"]?.Value<string>() ?? "Player", pos);
                    _remotePlayers[id] = avatar;
                }
                avatar.SetNetState(pos, vel, grounded);
                seen.Add(id);
            }
        }

        // Despawn any remote player no longer present.
        if (_remotePlayers.Count > 0)
        {
            _remotePlayersToRemove.Clear();
            foreach (var kv in _remotePlayers)
                if (!seen.Contains(kv.Key)) _remotePlayersToRemove.Add(kv.Key);
            foreach (var id in _remotePlayersToRemove)
            {
                if (_remotePlayers.TryGetValue(id, out var a) && a != null) Destroy(a.gameObject);
                _remotePlayers.Remove(id);
            }
        }

        PublishPlayerList(token as JArray);
    }

    // Publishes the session roster (local player first, then everyone else) to
    // Globals._playerList for the HUD's player list. This runs on every diff,
    // so it only pushes when the serialized roster actually changed — React
    // dedupes on the raw string too, but there is no point burning a
    // FindObjectsByType sweep 20×/sec on an unchanged list.
    private void PublishPlayerList(JArray remotes)
    {
        _playerListBuf.Clear();
        _playerListBuf.Add(new PlayerListEntry { username = _username ?? "You", local = true });
        if (remotes != null)
        {
            foreach (var rpTok in remotes)
            {
                if (!(rpTok is JObject rp)) continue;
                var id = rp["clientId"]?.Value<string>();
                if (string.IsNullOrEmpty(id) || id == _clientId) continue;
                _playerListBuf.Add(new PlayerListEntry
                {
                    username = rp["username"]?.Value<string>() ?? "Player",
                    local    = false,
                });
            }
        }

        var json = JsonConvert.SerializeObject(_playerListBuf);
        if (json == _playerListJson) return;
        _playerListJson = json;
        NotifyReact("_playerList", json);
    }

    [Serializable]
    private class PlayerListEntry
    {
        public string username;
        public bool   local;
    }

    private readonly List<PlayerListEntry> _playerListBuf = new();
    private string _playerListJson = "";

    private readonly HashSet<string>  _remotePlayersSeen     = new();
    private readonly List<string>     _remotePlayersToRemove = new();

    private static Vector3 ReadVec3(JToken t)
    {
        if (t is JArray a && a.Count == 3)
            return new Vector3(a[0].Value<float>(), a[1].Value<float>(), a[2].Value<float>());
        return Vector3.zero;
    }

    // Forward the server's current toolbar to React via Globals._gameToolbar.
    // React polls this string and (re-)renders bottom-of-screen tool buttons.
    // Pass-through — React owns layout entirely; this side just publishes the
    // JSON payload verbatim so the format stays in lockstep with what the
    // Lua-side UI.SetToolbar produced (the names, icons, keys, costs, color).
    private void PublishToolbar(JObject toolbar)
    {
        try { NotifyReact("_gameToolbar", toolbar.ToString(Newtonsoft.Json.Formatting.None)); }
        catch { /* never block diff handling on UI publish */ }
    }

    // Mobile player tapped a toolbar button. React calls this through the
    // `equipTool` global registered in GameLauncher; we forward to the server
    // so latch-into-keys behaviour matches a real desktop keypress.
    public void SendEquipTool(string name, string key)
    {
        SendJson(new { type = "equipTool", name = name ?? "", key = key ?? "" });
    }

    // ── Entity CRUD ───────────────────────────────────────────────────────────

    private void CreateEntity(JObject data)
    {
        if (data == null) return;
        var id   = data["id"]?.Value<string>()  ?? "";
        var type = data["type"]?.Value<string>() ?? "cube";
        if (string.IsNullOrEmpty(id)) return;

        if (_entities.TryGetValue(id, out var old) && old) Destroy(old);

        var go = BuildEntityGO(id, type);
        if (go == null) return;

        go.name = id;
        go.transform.SetParent(gameRoot, false);
        _entities[id] = go;

        // Mark for ground-snap before ApplyEntityData runs so the very first
        // position write already gets corrected. Terrain itself is excluded —
        // it IS the ground, lifting it would just float it. Lights and pure
        // primitives have no visible mesh that needs to sit on a surface.
        if (type.StartsWith("model:") && type != "model:terrain")
            _groundSnapIds.Add(id);

        ApplyEntityData(go, data);

        // The synchronous snap in ApplyEntityData runs against the renderer
        // bounds Unity has cached from the LAST render pass — for a freshly
        // spawned model that's still the staging position at y=-1000, so the
        // first snap typically over-lifts by a full mesh height. Re-run the
        // snap on the next 1-3 frames once Unity's render pass has updated
        // bounds for the live transform. Static entities never receive a
        // server diff that would correct this on its own.
        if (_groundSnapIds.Contains(id) && data["position"] is JArray pos2 && pos2.Count == 3)
        {
            var serverPos = new Vector3(pos2[0].Value<float>(), pos2[1].Value<float>(), pos2[2].Value<float>());
            StartCoroutine(DeferredEntitySnap(go, serverPos));
        }
    }

    private void UpdateEntity(JObject data)
    {
        if (data == null) return;
        var id = data["id"]?.Value<string>() ?? "";
        if (!_entities.TryGetValue(id, out var go) || !go) return;
        ApplyEntityData(go, data);

        // Record smooth target position. We post-correct lerp targets the
        // same way ApplyEntityData does so dynamic entities (zombies walking
        // on a slope) glide along the surface instead of clipping into it.
        if (data["position"] is JArray p && p.Count == 3)
        {
            var t = new Vector3(p[0].Value<float>(), p[1].Value<float>(), p[2].Value<float>());
            if (_groundSnapIds.Contains(id))
                t.y = SnapEntityYToGround(go, t.y);
            _targetPos[id] = t;
        }
    }

    private void DestroyEntity(string id)
    {
        if (_entities.TryGetValue(id, out var go) && go) Destroy(go);
        _entities.Remove(id);
        _targetPos.Remove(id);
        _entityPrevPos.Remove(id);
        _entityAnimators.Remove(id);
        _entityLastMovedAt.Remove(id);
        _groundSnapIds.Remove(id);
    }

    // For a meshy entity at xz, find the highest non-self collider beneath
    // and return a corrected Y so the entity's RENDERER bounds bottom
    // matches that surface. Renderer.bounds (vs. sharedMesh.bounds) reflects
    // the actual rendered extent at the entity's current world transform,
    // including any intermediate scale baked into the GLTFast hierarchy that
    // sharedMesh.bounds × transform.TransformPoint would over-count.
    //
    // Renderer.bounds for a SkinnedMeshRenderer can lag the transform until
    // the next render pass — that's mitigated by ApplyEntityData calling us
    // AFTER transform.position has been set, plus EnsureGroundSnapDeferred
    // re-runs the snap one frame later for newly-created entities so the
    // first snap also sees post-render bounds.
    private float SnapEntityYToGround(GameObject go, float fallbackY)
    {
        if (go == null) return fallbackY;
        var renderers = go.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length == 0) return fallbackY;
        Bounds b = default; bool any = false;
        foreach (var r in renderers)
        {
            if (!r.enabled) continue;
            if (!any) { b = r.bounds; any = true; }
            else b.Encapsulate(r.bounds);
        }
        if (!any || b.size.y < 0.01f) return fallbackY;

        var origin = new Vector3(b.center.x, b.max.y + 50f, b.center.z);
        var hits = Physics.RaycastAll(origin, Vector3.down, 200f, GroundRayMask, QueryTriggerInteraction.Ignore);
        float terrainY = float.NegativeInfinity;
        foreach (var h in hits)
        {
            if (h.collider != null && h.collider.transform.IsChildOf(go.transform)) continue;
            if (h.point.y > terrainY) terrainY = h.point.y;
        }
        if (float.IsNegativeInfinity(terrainY)) return fallbackY;
        // Only LIFT entities up, never push them down. A flying platform or
        // a treetop collectible the lua deliberately placed at Y=8 must stay
        // there even if terrain beneath it is at Y=1; the snap is meant to
        // rescue submerged props, not flatten everything to the ground.
        float lift = Mathf.Max(0f, terrainY - b.min.y);
        return fallbackY + lift;
    }

    // Re-run the snap on a meshy entity one frame after creation so the
    // first snap sees post-render Renderer.bounds (which only update after
    // a render pass). Without this, the very first snap on a freshly-spawned
    // SMR-based prop reads the renderer's last cached bounds from when the
    // template was at staging y=-1000, and the lift over-corrects by a
    // mesh-height. Tries up to 3 frames to handle terrain-collider load lag.
    private System.Collections.IEnumerator DeferredEntitySnap(GameObject go, Vector3 serverPos)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            yield return null; // wait one render frame
            if (go == null) yield break;
            float snappedY = SnapEntityYToGround(go, serverPos.y);
            if (Mathf.Abs(snappedY - go.transform.localPosition.y) > 0.001f)
                go.transform.localPosition = new Vector3(serverPos.x, snappedY, serverPos.z);
            // If we successfully lifted past fallback, we're done.
            if (snappedY != serverPos.y) yield break;
        }
    }

    private GameObject BuildEntityGO(string id, string type)
    {
        // Light
        if (type.StartsWith("light:"))
        {
            var go  = new GameObject(id);
            var l   = go.AddComponent<Light>();
            l.type  = type.Substring(6) switch
            {
                "spot"        => LightType.Spot,
                "directional" => LightType.Directional,
                _             => LightType.Point,
            };
            l.intensity = 1.5f;
            l.range     = 15f;
            return go;
        }

        // Meshy model
        if (type.StartsWith("model:"))
        {
            var assetId = type.Substring(6);
            var spawned = _assetLoader?.Spawn(assetId, gameRoot);
            if (spawned != null) return spawned;
            // Meshy load failed (download error, parse error, asset missing
            // from the manifest). Previously we dropped a colored cube here
            // "so the scene is never blank" — but those cubes are exactly the
            // placeholder geometry users complain about when a generation
            // partially fails. A missing model is a hole; a placeholder cube
            // is misleading. Return null so CreateEntity skips the entity
            // entirely and the scene is honest about what loaded.
            Debug.LogWarning($"[GameRenderClient] '{assetId}' not loaded — entity '{id}' skipped (no placeholder).");
            return null;
        }

        // Primitive
        var prim = type.ToLower() switch
        {
            "sphere"   => GameObject.CreatePrimitive(PrimitiveType.Sphere),
            "cylinder" => GameObject.CreatePrimitive(PrimitiveType.Cylinder),
            "capsule"  => GameObject.CreatePrimitive(PrimitiveType.Capsule),
            "plane"    => GameObject.CreatePrimitive(PrimitiveType.Plane),
            // Sculptable terrain: a 64-segment-per-side procedural plane.
            // GameRenderClient deforms its vertex Y from the server's
            // terrainHeights grid (ApplyTerrainHeights below), and the
            // Pludo/Terrain shader uses the resulting world-space normal
            // for slope-blended PBR layers. The MeshCollider lives on the
            // same GO so the existing groundY raycast pipeline picks up
            // hills and pits automatically.
            "terrain"  => PludoTerrainMesh.Create(TERRAIN_GRID_SIZE),
            _          => GameObject.CreatePrimitive(PrimitiveType.Cube),
        };
        if (type is "ramp" or "wedge")
            prim.transform.localEulerAngles = new Vector3(30f, 0f, 0f);

        var ren = prim.GetComponent<Renderer>();
        if (ren)
        {
            var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
            mat.SetColor("_BaseColor", new Color(0.8f, 0.8f, 0.8f));
            ren.material = mat;
            // Default-invisible. Primitives in this engine are exclusively
            // collision/trigger geometry — boundary walls, kill planes, cell
            // triggers, projectile templates. The lua-runtime force-hides
            // them at creation, but that only helps if the entity diff
            // actually carries `visible: false` to the client. Belt-and-
            // suspenders: every freshly-built primitive starts with its
            // renderer DISABLED here so even a snapshot that omits the
            // visible flag (older client cache, mid-flight tick, edit-mode
            // hot-reload race) can never paint a stray placeholder cube/
            // sphere on top of the gameplay. ApplyEntityData re-enables the
            // renderer only when the script explicitly sets visible=true on
            // a `model:` or `light:` entity (those types short-circuit
            // earlier in BuildEntityGO).
            ren.enabled = false;
        }
        var rb = prim.GetComponent<Rigidbody>();
        if (rb) rb.isKinematic = true;
        return prim;
    }

    private void ApplyEntityData(GameObject go, JObject data)
    {
        if (!go) return;

        // Position
        if (data["position"] is JArray pos && pos.Count == 3)
        {
            var p = new Vector3(pos[0].Value<float>(), pos[1].Value<float>(), pos[2].Value<float>());
            // Put the entity at the server's authoritative xy/z FIRST so the
            // snap below reads bounds at the correct world location. Without
            // this, the snap would raycast at the entity's previous xz (often
            // (0,0,0) for a freshly-created prop, or its last server xz mid-
            // diff) and compute a lift against bounds that don't match where
            // the model is supposed to be — giving 3+ meter spurious lifts
            // on freshly-spawned static props.
            go.transform.localPosition = p;
            // For meshy non-terrain entities, lift the Y so the model's
            // visible bottom sits on top of the terrain surface beneath it.
            // Lua scripts often place props at fixed y values like 0 or 1
            // that don't account for the terrain mesh thickness, so without
            // this every chibi house, plant or NPC ends up partially buried.
            // SnapEntityYToGround returns the original y if the snap can't
            // resolve yet (e.g. before bounds settle), so the next diff
            // re-tries — and we only mutate localPosition.y if the snap
            // actually changes it, so the rest of the transform stays
            // server-authoritative.
            if (!string.IsNullOrEmpty(go.name) && _groundSnapIds.Contains(go.name))
            {
                float snappedY = SnapEntityYToGround(go, p.y);
                if (Mathf.Abs(snappedY - p.y) > 0.001f)
                    go.transform.localPosition = new Vector3(p.x, snappedY, p.z);
            }
        }

        // Rotation. Subtract the auto-yaw applied to Meshy templates at load
        // time so the script's intended VISUAL yaw (e.g. "face -X = west = 270°
        // in Unity convention") composes correctly with the bake-in. Without
        // this, every LookAt / LookAtPlayer / SetRotation on a humanoid was
        // 180° off — zombies pointed away from the house, NPCs faced backwards,
        // turrets aimed at empty sky. Non-Meshy entities (primitives, lights)
        // have no marker and pass through unchanged.
        if (data["rotation"] is JArray rot && rot.Count == 3)
        {
            var marker = go.GetComponent<MeshyAssetMarker>();
            float yawOffset = marker != null ? marker.YawCorrection : 0f;
            go.transform.localEulerAngles = new Vector3(
                rot[0].Value<float>(),
                rot[1].Value<float>() - yawOffset,
                rot[2].Value<float>());
        }

        // Scale
        if (data["scale"] is JArray sc && sc.Count == 3)
            go.transform.localScale = new Vector3(sc[0].Value<float>(), sc[1].Value<float>(), sc[2].Value<float>());

        // Visibility — toggles renderers ONLY. Colliders stay enabled
        // regardless of visible state, because:
        //   • Terrain models occasionally come through with visible=false in
        //     edge cases (lua tweaks, hot-reload), and we never want the
        //     ground to lose collision under the avatar.
        //   • Primitives are force-hidden by the lua-runtime so stray Claude
        //     placeholders don't render — but they're still meant to act as
        //     INVISIBLE collision (kill zones, boundary walls, triggers),
        //     which is the whole reason a generated script would create
        //     them. Disabling colliders here used to delete that behavior
        //     and let the player walk straight through.
        // Triggers (`hasTrigger`) keep their isTrigger flag through the
        // separate ServerTriggerZone wiring below; nothing here affects it.
        var vis = data["visible"];
        if (vis != null)
        {
            bool v = vis.Value<bool>();
            // Mirror the lua-runtime's `_objSetVisible` lock client-side:
            // primitives can NEVER be made visible. The server-side guard
            // already drops `SetVisible(true)` on non-model/non-light
            // entities, but the cold-join snapshot can still carry
            // `visible: true` on a primitive (the field is set on
            // `createDefaultEntity` before `_objCreate` overrides it for
            // primitives, and stale snapshots from earlier server builds
            // could ship that default through the wire). Without this
            // client-side filter, the synthetic-test case `{type:"cube",
            // visible:true}` re-enabled the renderer at line 1088 and the
            // user saw a placeholder cube on top of gameplay. Allow `false`
            // through unconditionally — only the `true` direction needs
            // gating, since hiding a primitive is always safe.
            bool isMeshyOrLight = go.GetComponent<MeshyAssetMarker>() != null
                                 || go.GetComponent<Light>() != null;
            // Structure.*-spawned primitives carry a server-side `structural`
            // flag. We mirror it client-side via PludoStructuralMarker so the
            // visibility lock above doesn't kill procedural ground/walls.
            // Without this, every Structure entity would be force-hidden.
            bool isStructural = go.GetComponent<PludoStructuralMarker>() != null;
            if (v && !isMeshyOrLight && !isStructural) {
                // Primitive trying to become visible — ignore.
            } else {
                foreach (var r in go.GetComponentsInChildren<Renderer>()) r.enabled = v;
            }
        }

        // Color
        if (data["color"] is JArray col && col.Count == 3)
        {
            var c = new Color(col[0].Value<float>(), col[1].Value<float>(), col[2].Value<float>());
            SetAllRendererColor(go, c);
        }

        // Material preset
        var mat = data["material"]?.Value<string>();
        if (!string.IsNullOrEmpty(mat)) ApplyMaterialPreset(go, mat);

        // Structural tag — released the primitive-visibility lock above and
        // tells the PBR-material path below that this entity is a candidate
        // for the Pludo/Terrain shader. Tagging is idempotent: marker is
        // added once per GameObject, never duplicated by subsequent diffs.
        if (data["structural"]?.Value<bool>() ?? false)
        {
            if (go.GetComponent<PludoStructuralMarker>() == null)
                go.AddComponent<PludoStructuralMarker>();
            // Structurals spawn renderer-enabled — the visibility block above
            // already lets them through, but BuildEntityGO defaults primitives
            // to renderer.enabled=false. Flip them on now that we've confirmed
            // structural intent.
            foreach (var r in go.GetComponentsInChildren<Renderer>()) r.enabled = true;
        }

        // PBR material via Pludo/Terrain shader (single-layer mode for
        // structureMaterial, multi-layer slope-blended for terrainLayers).
        // Texture URLs come pre-resolved by the server's Polyhaven service
        // and arrive on the very first snapshot (room init waits on them).
        var structMat = data["structureMaterial"] as JObject;
        if (structMat != null) ApplyPludoStructureMaterial(go, structMat);
        var terrainLayers = data["terrainLayers"] as JArray;
        if (terrainLayers != null && terrainLayers.Count > 0)
            ApplyPludoTerrainLayers(go, terrainLayers);

        // Sculpted terrain: re-deform the procedural mesh from the server's
        // height grid whenever it arrives on a diff. The grid is row-major,
        // length TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE; values are world
        // units (mesh-local Y, applied before the GO's localScale flattens
        // the vertical axis — which is why CreateTerrain keeps scale.y = 1).
        var terrainHeights = data["terrainHeights"] as JArray;
        if (terrainHeights != null && terrainHeights.Count >= TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE)
        {
            var heights = new float[TERRAIN_GRID_SIZE * TERRAIN_GRID_SIZE];
            for (int i = 0; i < heights.Length; i++)
                heights[i] = terrainHeights[i].Value<float>();
            PludoTerrainMesh.ApplyHeights(go, heights, TERRAIN_GRID_SIZE);
        }

        // Emissive
        if (data["emissive"] is JArray em && em.Count == 4)
        {
            var ec = new Color(em[0].Value<float>(), em[1].Value<float>(), em[2].Value<float>());
            foreach (var r in go.GetComponentsInChildren<Renderer>())
            {
                if (r.material == null) continue;
                r.material.EnableKeyword("_EMISSION");
                r.material.SetColor("_EmissionColor", ec * em[3].Value<float>());
            }
        }

        // Physics
        var physics  = data["physics"];
        var isStatic = data["isStatic"];
        if (physics != null || isStatic != null)
        {
            bool hasPhy = physics?.Value<bool>() ?? false;
            bool stat   = isStatic?.Value<bool>() ?? true;
            var rigidbody = go.GetComponent<Rigidbody>();
            if (hasPhy && rigidbody == null) rigidbody = go.AddComponent<Rigidbody>();
            if (rigidbody != null) rigidbody.isKinematic = !hasPhy || stat;
        }

        // Light-specific
        var light = go.GetComponent<Light>();
        if (light != null && data["color"] is JArray lc && lc.Count == 3)
            light.color = new Color(lc[0].Value<float>(), lc[1].Value<float>(), lc[2].Value<float>());

        // Trigger zone (server reports overlaps back via WebSocket)
        if (data["hasTrigger"]?.Value<bool>() ?? false)
        {
            var trigger = go.GetComponent<ServerTriggerZone>() ?? go.AddComponent<ServerTriggerZone>();
            trigger.Init(go.name, this);
        }

        // Parent re-assignment
        var parentId = data["parentId"]?.Value<string>();
        if (!string.IsNullOrEmpty(parentId) && _entities.TryGetValue(parentId, out var parentGO) && parentGO)
            go.transform.SetParent(parentGO.transform, true);
        else if (string.IsNullOrEmpty(parentId))
            go.transform.SetParent(gameRoot, true);
    }

    private static void SetAllRendererColor(GameObject go, Color col)
    {
        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            if (r.material == null) continue;
            r.material.SetColor("_BaseColor", col);
            r.material.SetColor("_Color",     col);
        }
    }

    private static readonly Dictionary<string, (Color col, bool emissive, bool transparent)> MaterialPresets = new()
    {
        ["metal"]  = (new Color(0.72f, 0.72f, 0.78f), false, false),
        ["wood"]   = (new Color(0.60f, 0.40f, 0.20f), false, false),
        ["stone"]  = (new Color(0.52f, 0.52f, 0.52f), false, false),
        ["grass"]  = (new Color(0.28f, 0.62f, 0.20f), false, false),
        ["ice"]    = (new Color(0.68f, 0.85f, 1.00f), false, true),
        ["lava"]   = (new Color(1.00f, 0.28f, 0.00f), true,  false),
        ["glass"]  = (new Color(0.60f, 0.85f, 0.95f), false, true),
        ["sand"]   = (new Color(0.86f, 0.76f, 0.52f), false, false),
    };

    private static void ApplyMaterialPreset(GameObject go, string preset)
    {
        if (!MaterialPresets.TryGetValue(preset, out var p)) return;
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            var m = new Material(shader);
            var c = p.transparent ? new Color(p.col.r, p.col.g, p.col.b, 0.5f) : p.col;
            m.SetColor("_BaseColor", c);
            m.SetColor("_Color",     c);
            if (p.emissive) { m.EnableKeyword("_EMISSION"); m.SetColor("_EmissionColor", p.col * 2f); }
            r.material = m;
        }
    }

    // Single-layer Pludo/Terrain material for `structureMaterial` entities.
    // Sets _LayerCount=1 so the shader collapses to layer-0 sampling — no
    // slope blending, no extra texture fetches. Texture URLs come straight
    // from the JObject (Polyhaven-resolved server-side); TextureLoader caches
    // every URL globally so re-applying the same material is free.
    private void ApplyPludoStructureMaterial(GameObject go, JObject sm)
    {
        var shader = Shader.Find("Pludo/Terrain");
        if (shader == null) { Debug.LogWarning("[GameRenderClient] Pludo/Terrain shader missing"); return; }

        var tiling    = sm["tiling"]?.Value<float>() ?? 4f;
        var roughness = sm["roughness"]?.Value<float>() ?? 0.7f;
        var albedoUrl    = sm["albedoUrl"]?.Value<string>();
        var normalUrl    = sm["normalUrl"]?.Value<string>();
        var roughnessUrl = sm["roughnessUrl"]?.Value<string>();

        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            var m = new Material(shader);
            m.SetFloat("_LayerCount",     1f);
            m.SetFloat("_Layer0_Tiling",  tiling);
            m.SetFloat("_RoughnessScale", roughness);
            r.material = m;
        }
        // Kick off async texture loads; the existing material reference on
        // each Renderer gets _Layer0_* assigned once each map arrives.
        StartCoroutine(TextureLoader.LoadTexture(this, albedoUrl,    t => AssignLayerMap(go, 0, "_Layer0_Albedo",    t)));
        StartCoroutine(TextureLoader.LoadTexture(this, normalUrl,    t => AssignLayerMap(go, 0, "_Layer0_Normal",    t)));
        StartCoroutine(TextureLoader.LoadTexture(this, roughnessUrl, t => AssignLayerMap(go, 0, "_Layer0_Roughness", t)));
    }

    // Multi-layer Pludo/Terrain material with slope-blended PBR. Up to 3
    // layers; extra layers in the diff are silently ignored. Slope bands
    // default to even thirds when the server hasn't filled them in.
    private void ApplyPludoTerrainLayers(GameObject go, JArray layers)
    {
        var shader = Shader.Find("Pludo/Terrain");
        if (shader == null) { Debug.LogWarning("[GameRenderClient] Pludo/Terrain shader missing"); return; }

        int n = Mathf.Min(layers.Count, 3);
        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            var m = new Material(shader);
            m.SetFloat("_LayerCount", n);
            r.material = m;
        }

        for (int i = 0; i < n; i++)
        {
            var layer = layers[i] as JObject;
            if (layer == null) continue;
            var tiling   = layer["tiling"]?.Value<float>()   ?? (8f - i * 1.5f);
            var slopeMin = layer["slopeMin"]?.Value<float>() ?? (i / 3f);
            var slopeMax = layer["slopeMax"]?.Value<float>() ?? ((i + 1) / 3f);
            int idx = i; // close over loop var

            foreach (var r in go.GetComponentsInChildren<Renderer>())
            {
                var m = r.material;
                m.SetFloat($"_Layer{idx}_Tiling",   tiling);
                m.SetFloat($"_Layer{idx}_SlopeMin", slopeMin);
                m.SetFloat($"_Layer{idx}_SlopeMax", slopeMax);
            }

            StartCoroutine(TextureLoader.LoadTexture(this, layer["albedoUrl"]?.Value<string>(),    t => AssignLayerMap(go, idx, "_Albedo",    t)));
            StartCoroutine(TextureLoader.LoadTexture(this, layer["normalUrl"]?.Value<string>(),    t => AssignLayerMap(go, idx, "_Normal",    t)));
            StartCoroutine(TextureLoader.LoadTexture(this, layer["roughnessUrl"]?.Value<string>(), t => AssignLayerMap(go, idx, "_Roughness", t)));
        }
    }

    // Once a texture finishes downloading, find every renderer on the entity
    // and patch the property. Guards against the entity having been destroyed
    // between dispatch and arrival (a hot-reload or scene swap).
    private static void AssignLayerMap(GameObject go, int layerIndex, string mapSuffix, Texture2D tex)
    {
        if (go == null || tex == null) return;
        // mapSuffix may be either "_Layer0_Albedo" (full name) or "_Albedo" (suffix).
        // Single-layer path passes the full name; multi-layer path passes the suffix.
        var prop = mapSuffix.StartsWith("_Layer") ? mapSuffix : $"_Layer{layerIndex}{mapSuffix}";
        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            if (r.material == null) continue;
            r.material.SetTexture(prop, tex);
        }
    }

    // ── Player state ──────────────────────────────────────────────────────────

    private void ApplyPlayerState(JObject data)
    {
        if (data == null || _playerInstance == null) return;

        // The local avatar is driven by StepPrediction every frame; the server's
        // position/velocity are folded in as a CORRECTION rather than written
        // straight to the transform. Writing the transform here (the old
        // behaviour) meant the player only ever moved at the ~20 Hz diff rate
        // and every input waited a network round-trip.
        var serverVel = _playerServerVelocity;
        if (data["velocity"] is JArray vel && vel.Count == 3)
            serverVel = new Vector3(vel[0].Value<float>(), vel[1].Value<float>(), vel[2].Value<float>());

        if (data["position"] is JArray pos && pos.Count == 3)
        {
            var target = new Vector3(pos[0].Value<float>(), pos[1].Value<float>(), pos[2].Value<float>());
            var seqTok = data["teleportSeq"];
            if (seqTok != null)
            {
                // Client-authoritative server: positions in diffs are just our
                // own echoed back. Only a NEW teleportSeq means the server moved
                // us (Lua teleport, respawn, bounds/void clamp, rejected move).
                _serverHasTeleportSeq = true;
                int seq = seqTok.Value<int>();
                if (!_predReady || seq != _teleportSeq)
                {
                    _teleportSeq  = seq;
                    _predPos      = target;
                    _predPrevPos  = target;
                    _predVel      = Vector3.zero;
                    _predGrounded = false;
                    _predAccum    = 0f;
                    _predReady    = true;
                    _motor = new RobloxCharacterMotor.State { Pos = target, LastGroundedAt = -999f };
                    _playerInstance.transform.position = target;
                }
            }
            else
            {
                // Legacy server: ease toward its integrated position. Lift Y to
                // the live ground so the capsule sits on the terrain mesh.
                target.y = Mathf.Max(target.y, ProbeGroundY(target.x, target.z, target.y - 5f));
                ReconcilePlayerState(target, serverVel);
            }
        }

        var health = data["health"];
        if (health != null) NotifyReact("_gameHealth", Mathf.RoundToInt(health.Value<float>()).ToString());

        var score = data["score"];
        if (score != null) NotifyReact("_gameScore", score.Value<int>().ToString());

        var spd = data["speed"];
        if (spd != null && _playerCtrl != null) { _speed = spd.Value<float>(); _playerCtrl.Init(_speed, _jumpHeight); }

        var jmp = data["jumpHeight"];
        if (jmp != null && _playerCtrl != null) { _jumpHeight = jmp.Value<float>(); _playerCtrl.Init(_speed, _jumpHeight); }
    }

    // ── Scene config ──────────────────────────────────────────────────────────

    private static void ApplySceneConfig(JObject data)
    {
        if (data == null) return;

        // Procedural skybox descriptor takes precedence over the preset
        // `skybox` field. New games emit a `skyboxDescriptor` per the
        // Scene.SetCustomSkybox API; the preset path stays for legacy games.
        if (data["skyboxDescriptor"] is JObject desc)
        {
            EnvironmentManager.SetSkyboxFromDescriptor(desc);
        }
        else
        {
            var skybox = data["skybox"]?.Value<string>();
            if (!string.IsNullOrEmpty(skybox))
            {
                EnvironmentManager.SetSkybox(skybox);
                var lightPreset = skybox switch
                {
                    "golden_hour" => "golden_hour",
                    "night"       => "night",
                    "stormy"      => "stormy",
                    "overcast"    => "overcast",
                    _             => "day",
                };
                EnvironmentManager.SetLighting(lightPreset);
            }
        }

        if (data["backgroundColor"] is JArray bg && bg.Count == 3)
        {
            var col = new Color(bg[0].Value<float>(), bg[1].Value<float>(), bg[2].Value<float>());
            RenderSettings.ambientLight = col * 0.4f;
            if (Camera.main != null) { Camera.main.clearFlags = CameraClearFlags.SolidColor; Camera.main.backgroundColor = col; }
        }

        var fog = data["fogEnabled"];
        if (fog != null)
        {
            RenderSettings.fog = fog.Value<bool>();
            var fd = data["fogDensity"];
            if (fd != null) RenderSettings.fogDensity = fd.Value<float>();
        }

        var grav = data["gravity"];
        if (grav != null) Physics.gravity = new Vector3(0f, grav.Value<float>(), 0f);

        // Ambient background music. The track is selected per-game (in the
        // editor → scene.music); we only (re)start it when it actually changes
        // so diffs don't restart the loop every tick. Empty string stops it.
        var music = data["music"]?.Value<string>();
        if (music != null && music != _activeMusic)
        {
            _activeMusic = music;
            if (string.IsNullOrEmpty(music)) GameAudio.StopMusic();
            else                             GameAudio.PlayMusic(music);
        }
    }
    private static string _activeMusic;

    // ── UI events ─────────────────────────────────────────────────────────────

    private void HandleUIEvent(JObject ev)
    {
        if (ev == null) return;
        var type    = ev["type"]?.Value<string>() ?? "";
        var payload = ev["payload"] as JObject;
        if (payload == null) return;

        switch (type)
        {
            case "message":
                StartCoroutine(MessageCoroutine("_gameMessage",
                    payload["text"]?.Value<string>() ?? "",
                    payload["duration"]?.Value<float>() ?? 3f));
                break;

            case "title":
                StartCoroutine(TitleCoroutine(
                    payload["title"]?.Value<string>()    ?? "",
                    payload["subtitle"]?.Value<string>() ?? "",
                    payload["duration"]?.Value<float>()  ?? 3f));
                break;

            case "popup":
                NotifyReact("_popupTitle", payload["title"]?.Value<string>()  ?? "");
                NotifyReact("_popupBody",  payload["body"]?.Value<string>()   ?? "");
                NotifyReact("_popupBtn",   payload["button"]?.Value<string>() ?? "OK");
                break;

            case "countdown_start":
                StartCoroutine(CountdownCoroutine(payload["seconds"]?.Value<int>() ?? 3));
                break;

            case "hud_update":
                var k = payload["key"]?.Value<string>()   ?? "";
                var v = payload["value"]?.Value<string>() ?? "";
                if (!string.IsNullOrEmpty(k)) NotifyReact("_hud_" + k, v);
                break;

            case "objective":
                StartCoroutine(MessageCoroutine("_gameMessage",
                    payload["text"]?.Value<string>() ?? "", 6f));
                break;

            case "screen_shake":
                StartCoroutine(ShakeCoroutine(
                    payload["intensity"]?.Value<float>() ?? 0.3f,
                    payload["duration"]?.Value<float>()  ?? 0.3f));
                break;

            case "flash":
                StartCoroutine(FlashCoroutine(new Color(
                    payload["r"]?.Value<float>() ?? 1f,
                    payload["g"]?.Value<float>() ?? 0f,
                    payload["b"]?.Value<float>() ?? 0f),
                    payload["duration"]?.Value<float>() ?? 0.3f));
                break;

            case "effect":
                StartCoroutine(EffectCoroutine(
                    payload["preset"]?.Value<string>() ?? "sparkle",
                    new Vector3(
                        payload["x"]?.Value<float>() ?? 0f,
                        payload["y"]?.Value<float>() ?? 0f,
                        payload["z"]?.Value<float>() ?? 0f)));
                break;

            case "game_end":
                var result = payload["result"]?.Value<string>() ?? "lose";
                StartCoroutine(MessageCoroutine("_gameMessage",
                    payload["message"]?.Value<string>() ?? "Game Over", 4f));
                if (result == "win")
                    StartCoroutine(EffectCoroutine("confetti",
                        _playerInstance?.transform.position ?? Vector3.zero));
                break;
        }
    }

    // ── Player spawn ──────────────────────────────────────────────────────────

    private void SpawnPlayer()
    {
        if (_playerInstance != null) { Destroy(_playerInstance); _playerInstance = null; }

        // Sweep any local-only avatar GameObjects that may have survived the
        // preview→play transition (e.g. LuauGameRunner's preview chibi). The
        // teardown chain in GameLauncher should already have killed these, but
        // this is a hard guarantee: when we enter server-authoritative play
        // there is exactly ONE player avatar in the scene.
        foreach (var name in new[] { "LuauPreviewPlayer", "LuauLocalPlayer", "ServerRenderPlayer" })
        {
            var leftover = GameObject.Find(name);
            if (leftover != null)
            {
                Debug.LogWarning($"[GameRenderClient] Destroying leftover avatar '{name}' before spawning server player.");
                Destroy(leftover);
            }
        }

        _playerInstance = new GameObject("ServerRenderPlayer");
        _playerInstance.transform.position = playerSpawn != null
            ? playerSpawn.position : new Vector3(0, 3, 0);
        _playerInstance.tag = "Player";
        // Re-seed prediction from this fresh spawn rather than the previous
        // session's last predicted position.
        _predReady = false;

        var rb = _playerInstance.AddComponent<Rigidbody>();
        // Server is authoritative for position — disable client-side gravity and
        // make the body kinematic so Unity physics doesn't fight the per-frame
        // ApplyPlayerState lerp. With useGravity=true the rigidbody was being
        // pulled into the terrain mesh between server updates, then the collider
        // resolution pushed the capsule sideways, which the user perceived as
        // "the ground keeps pushing me into the void."
        rb.useGravity             = false;
        rb.isKinematic            = true;
        rb.interpolation          = RigidbodyInterpolation.None; // transform written per frame
        rb.constraints            = RigidbodyConstraints.FreezeRotation;
        var col = _playerInstance.AddComponent<CapsuleCollider>();
        col.center = new Vector3(0f, 1f, 0f);
        col.height = 2f;
        col.radius = 0.4f;

        // Build the player visual using the SAME multi-part avatar pipeline that
        // AvatarPreviewController + LuauGameRunner.BuildChibiVisual use, so the
        // in-game player matches the user's profile chibi (tan skin tone +
        // configured body color) instead of showing the unstyled white
        // chibi-base prefab. The 6 body parts share a single master skeleton
        // (torso) by bone-name retargeting; chibi-base is only loaded as a
        // fallback when one of the parts is missing.
        BuildPlayerChibiVisual(_playerInstance.transform);

        StartCoroutine(DeferredAvatarScale(_playerInstance.transform));

        _playerCtrl = _playerInstance.AddComponent<LuauPlayerController>();
        _playerCtrl.ExternallyDriven = true;   // StepPrediction runs the motor here
        _playerCtrl.Init(_speed, _jumpHeight);
        _serverHasTeleportSeq = false;
        _teleportSeq = -1;

        var cam = EnsureGameCamera();
        if (cam.TryGetComponent<LuauOrbitCamera>(out var oldOrbit)) Destroy(oldOrbit);
        var orbit = cam.gameObject.AddComponent<LuauOrbitCamera>();
        orbit.SetTarget(_playerInstance.transform);
        var chibiV = _playerInstance.transform.Find("ChibiVisual");
        if (chibiV != null) orbit.SetAvatarRenderers(chibiV.GetComponentsInChildren<Renderer>());

        MobileGameInput.PauseRequested -= HandlePause;
        MobileGameInput.PauseRequested += HandlePause;

        // Register React globals so the escape menu buttons work in server mode.
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
        {
            // pauseGame is the tap-driven twin of the swipe-from-left gesture:
            // React's main-menu button calls it so opening the menu hides the
            // joystick exactly like MobileGameInput.PauseRequested does.
            r.Globals["pauseGame"]       = (Action)HandlePause;
            r.Globals["resumeGame"]      = (Action)ResumeFromPause;
            r.Globals["resetPlayer"]     = (Action)ResetPlayerToSpawn;
            r.Globals["toggleShiftLock"] = (Action)ToggleShiftLock;
        }

        MobileGameInput.Instance?.SetVisible(true);
    }

    private void ResumeFromPause()
    {
        MobileGameInput.Instance?.SetVisible(true);
        NotifyReact("_showEscape", "");
    }

    private void ResetPlayerToSpawn()
    {
        if (_playerInstance == null) return;
        var pos = playerSpawn != null ? playerSpawn.position : new Vector3(0f, 3f, 0f);
        _playerInstance.transform.position = pos;
        var rb = _playerInstance.GetComponent<Rigidbody>();
        if (rb != null) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
    }

    private void ToggleShiftLock()
    {
        LuauOrbitCamera.ToggleShiftLock();
        NotifyReact("_shiftLock", LuauOrbitCamera.ShiftLock ? "true" : "");
    }

    // Builds the multi-part chibi visual for the in-game player. Mirrors
    // LuauGameRunner.BuildChibiVisual so the server-authoritative play avatar
    // matches the user's profile chibi: same 6 body parts, same bone
    // retargeting onto the torso master skeleton, same skin material tinted by
    // AvatarStateManager.bodyColor (default tan #D4A382). Without this the
    // GameRenderClient was loading the raw chibi-base prefab and skipping the
    // skin tint, which is why the in-game avatar appeared white instead of
    // tan like the profile preview.
    private static readonly string[] PlayerBodyPartNames = { "torso", "head", "left-arm", "right-arm", "left-leg", "right-leg" };

    private void BuildPlayerChibiVisual(Transform parent)
    {
        Color bodyCol = new Color(0.83f, 0.64f, 0.51f); // default tan
        var mgr = AvatarStateManager.Instance;
        if (mgr != null && mgr.Avatar != null && !string.IsNullOrEmpty(mgr.Avatar.bodyColor))
            ColorUtility.TryParseHtmlString(mgr.Avatar.bodyColor, out bodyCol);

        var wrapper = BuildChibiVisual(parent, bodyCol, out _chibiTargetBones);
        if (wrapper == null) return;

        SetupAnimations();

        // Attach equipped items from the avatar editor (hats, weapons, accessories,
        // shoes, etc.) onto the master skeleton's bones — same code path that
        // LuauGameRunner uses for local play, so the server-authoritative
        // in-game avatar visually matches what the user sees in the You tab.
        StartCoroutine(LuauGameRunner.AttachAvatarItemsCoroutine(_chibiTargetBones));
    }

    // Builds the multi-part chibi mesh (or chibi-base fallback) under `parent`,
    // tinted with `bodyCol`, and returns the wrapper GameObject plus the bone
    // name→Transform map. Pure mesh assembly — no animation/item attachment — so
    // it can be reused for both the local player and remote-player avatars.
    // Returns null if no avatar assets are available.
    public static GameObject BuildChibiVisual(Transform parent, Color bodyCol, out Dictionary<string, Transform> bones)
    {
        bones = new Dictionary<string, Transform>();

        var wrapper = new GameObject("ChibiVisual");
        wrapper.transform.SetParent(parent, false);
        wrapper.transform.localPosition = Vector3.zero;
        wrapper.transform.localRotation = Quaternion.identity;
        wrapper.transform.localScale    = Vector3.one;

        // Try to load the 6 body parts; fall back to chibi-base if any are missing.
        var prefabs = new GameObject[PlayerBodyPartNames.Length];
        bool allFound = true;
        for (int i = 0; i < PlayerBodyPartNames.Length; i++)
        {
            prefabs[i] = Resources.Load<GameObject>($"Avatar/{PlayerBodyPartNames[i]}");
            if (prefabs[i] == null) { allFound = false; break; }
        }

        if (!allFound)
        {
            var basePrefab = Resources.Load<GameObject>("Avatar/chibi-base");
            if (basePrefab == null) { Destroy(wrapper); return null; }
            var baseGO = Instantiate(basePrefab, wrapper.transform);
            baseGO.transform.localPosition = Vector3.zero;
            foreach (var c in baseGO.GetComponentsInChildren<Collider>()) Destroy(c);
            var anim0 = baseGO.GetComponent<Animator>();
            if (anim0 != null) { anim0.enabled = false; anim0.applyRootMotion = false; }
            foreach (var t in baseGO.GetComponentsInChildren<Transform>(true))
                if (!bones.ContainsKey(t.name)) bones[t.name] = t;
        }
        else
        {
            // Master skeleton from torso (65 Mixamo bones)
            var masterGO = Instantiate(prefabs[0], wrapper.transform);
            masterGO.name = "ChibiSkeleton";
            // All 6 body-part FBXs are authored ~0.302 units forward of their
            // pivot in Z (chibi-base.fbx is centered correctly at Z=0). Shift
            // the skeleton back so the mesh sits on the pivot immediately —
            // before DeferredAvatarScale runs — eliminating the few-frame
            // window where the avatar appears off-center on spawn and turn.
            masterGO.transform.localPosition = new Vector3(0f, 0f, -0.302f);
            foreach (var c in masterGO.GetComponentsInChildren<Collider>()) Destroy(c);

            foreach (var t in masterGO.GetComponentsInChildren<Transform>(true))
                if (!bones.ContainsKey(t.name)) bones[t.name] = t;

            var animator = masterGO.GetComponent<Animator>();
            if (animator != null) { animator.enabled = false; animator.applyRootMotion = false; }

            // Retarget the other 5 parts onto the master skeleton by bone name
            for (int i = 1; i < prefabs.Length; i++)
            {
                var partGO = Instantiate(prefabs[i]);
                partGO.transform.SetParent(wrapper.transform, false);
                partGO.transform.localPosition = Vector3.zero;

                foreach (var smr in partGO.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                {
                    var newBones = new Transform[smr.bones.Length];
                    for (int b = 0; b < smr.bones.Length; b++)
                        newBones[b] = smr.bones[b] != null && bones.TryGetValue(smr.bones[b].name, out var mb) ? mb : smr.bones[b];
                    smr.bones = newBones;
                    if (smr.rootBone != null && bones.TryGetValue(smr.rootBone.name, out var mr))
                        smr.rootBone = mr;
                    smr.transform.SetParent(wrapper.transform, false);
                    smr.transform.localPosition = Vector3.zero;
                }
                foreach (var c in partGO.GetComponentsInChildren<Collider>()) Destroy(c);
                Destroy(partGO);
            }
        }

        // Apply the tan/customized skin material to every renderer in the visual.
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var skinMat = new Material(shader) { name = "PlayerSkinMat" };
        skinMat.SetColor("_BaseColor", bodyCol);
        skinMat.SetColor("_Color",     bodyCol);
        if (skinMat.HasProperty("_Metallic"))   skinMat.SetFloat("_Metallic", 0f);
        if (skinMat.HasProperty("_Smoothness")) skinMat.SetFloat("_Smoothness", 0.35f);
        foreach (var r in wrapper.GetComponentsInChildren<Renderer>())
            if (r.enabled) r.material = skinMat;

        // SkinnedMeshRenderer.bounds need to update every frame so the deferred
        // scale pass can read valid bounds the frame after spawn.
        foreach (var smr in wrapper.GetComponentsInChildren<SkinnedMeshRenderer>())
            smr.updateWhenOffscreen = true;

        return wrapper;
    }

    // Shared, immutable animation clips loaded once from Resources. Remote
    // avatars reuse these (clips are read-only — only the pose source they're
    // sampled onto is per-instance).
    private static Dictionary<string, AnimationClip> _sharedClips;
    private static Dictionary<string, bool>          _sharedClipLoops;
    public static readonly (string state, string path, bool loop)[] AnimDefs =
    {
        ("idle",            "Avatar/idle",            true),
        ("walking",         "Avatar/walking",         true),
        ("running",         "Avatar/running",         true),
        ("jumping-up",      "Avatar/jumping-up",      false),
        ("jumping-down",    "Avatar/jumping-down",    false),
        ("swimming",        "Avatar/swimming",        true),
        ("climbing-ladder", "Avatar/climbing-ladder", true),
        ("treading-water",  "Avatar/treading-water",  true),
    };

    public static void GetSharedClips(out Dictionary<string, AnimationClip> clips, out Dictionary<string, bool> loops)
    {
        if (_sharedClips == null)
        {
            _sharedClips     = new Dictionary<string, AnimationClip>();
            _sharedClipLoops = new Dictionary<string, bool>();
            foreach (var (state, path, loop) in AnimDefs)
            {
                var loaded = Resources.LoadAll<AnimationClip>(path);
                if (loaded.Length == 0) continue;
                _sharedClips[state]     = loaded[0];
                _sharedClipLoops[state] = loop;
            }
        }
        clips = _sharedClips;
        loops = _sharedClipLoops;
    }

    // Instantiates a hidden idle skeleton used purely as a sampling target for
    // AnimationClip.SampleAnimation, returning it plus its bone name→Transform
    // map. One per avatar (local or remote). Returns null if Avatar/idle missing.
    public static GameObject BuildPoseSource(out Dictionary<string, Transform> poseBones)
    {
        poseBones = new Dictionary<string, Transform>();
        var idlePrefab = Resources.Load<GameObject>("Avatar/idle");
        if (idlePrefab == null) return null;
        var poseSrc = Instantiate(idlePrefab);
        poseSrc.name = "PoseAnimSource";
        poseSrc.transform.position = new Vector3(0f, -9000f, 0f);
        foreach (var r in poseSrc.GetComponentsInChildren<Renderer>(true)) r.enabled = false;
        foreach (var a in poseSrc.GetComponentsInChildren<Animator>(true)) a.enabled = false;
        foreach (var t in poseSrc.GetComponentsInChildren<Transform>(true))
            if (!poseBones.ContainsKey(t.name)) poseBones[t.name] = t;
        return poseSrc;
    }

    private static Camera EnsureGameCamera()
    {
        var cam = Camera.main;
        if (cam == null)
        {
            var go = new GameObject("MainCamera"); go.tag = "MainCamera";
            cam = go.AddComponent<Camera>();
            cam.transform.position = new Vector3(0f, 10f, -20f);
        }
        cam.clearFlags      = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.08f, 0.08f, 0.12f);
        if (cam.cullingMask == 0) cam.cullingMask = ~0;
        if (cam.GetComponent<UniversalAdditionalCameraData>() == null)
            cam.gameObject.AddComponent<UniversalAdditionalCameraData>();
        return cam;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Called by ServerTriggerZone when player enters/exits — sends event to server
    internal void SendTriggerEnter(string entityId) =>
        SendJson(new { type = "trigger_enter", entityId });
    internal void SendTriggerExit(string entityId) =>
        SendJson(new { type = "trigger_exit",  entityId });
    internal void SendCollision(string entityId, string otherName) =>
        SendJson(new { type = "collision", entityId, otherName });

    private void TearDownScene()
    {
        foreach (var go in _entities.Values) if (go) Destroy(go);
        _entities.Clear();
        _targetPos.Clear();
        // Remote players are parented to gameRoot and get destroyed in the child
        // sweep below; clear the lookup so stale entries don't linger.
        _remotePlayers.Clear();
        if (gameRoot != null)
            for (int i = gameRoot.childCount - 1; i >= 0; i--)
                Destroy(gameRoot.GetChild(i).gameObject);
        NotifyReact("_popupTitle",   "");
        NotifyReact("_popupBody",    "");
        NotifyReact("_gameMessage",  "");
        NotifyReact("_gameTitle",    "");
        NotifyReact("_gameSubtitle", "");
    }

    private void HandlePause()
    {
        MobileGameInput.Instance?.SetVisible(false);
        NotifyReact("_showEscape", "true");
    }

    private void NotifyReact(string key, string value)
    {
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
            r.Globals[key] = value;
    }

    // ── Coroutines ────────────────────────────────────────────────────────────

    private IEnumerator MessageCoroutine(string key, string text, float dur)
    {
        NotifyReact(key, text);
        yield return new WaitForSeconds(dur);
        NotifyReact(key, "");
    }

    private IEnumerator TitleCoroutine(string title, string sub, float dur)
    {
        NotifyReact("_gameTitle", title); NotifyReact("_gameSubtitle", sub);
        yield return new WaitForSeconds(dur);
        NotifyReact("_gameTitle", "");   NotifyReact("_gameSubtitle", "");
    }

    private IEnumerator CountdownCoroutine(int secs)
    {
        for (int i = secs; i > 0; i--)
        {
            NotifyReact("_gameMessage", i.ToString());
            yield return new WaitForSeconds(1f);
        }
        NotifyReact("_gameMessage", "");
    }

    private IEnumerator ShakeCoroutine(float intensity, float dur)
    {
        var cam = Camera.main;
        if (!cam) yield break;
        var orig = cam.transform.localPosition;
        for (float t = 0; t < dur; t += Time.deltaTime)
        {
            cam.transform.localPosition = orig + UnityEngine.Random.insideUnitSphere * intensity * 0.12f;
            yield return null;
        }
        cam.transform.localPosition = orig;
    }

    private IEnumerator FlashCoroutine(Color col, float dur)
    {
        NotifyReact("_flashColor", "#" + ColorUtility.ToHtmlStringRGB(col));
        yield return new WaitForSeconds(dur);
        NotifyReact("_flashColor", "");
    }

    // ── Animation ─────────────────────────────────────────────────────────────

    private void SetupAnimations()
    {
        TearDownAnimations();

        var idlePrefab = Resources.Load<GameObject>("Avatar/idle");
        if (idlePrefab == null) { Debug.LogWarning("[GameRenderClient] Avatar/idle not found — no animations"); return; }

        _poseSrc = Instantiate(idlePrefab);
        _poseSrc.name = "PoseAnimSource";
        _poseSrc.transform.position = new Vector3(0f, -9000f, 0f);
        foreach (var r in _poseSrc.GetComponentsInChildren<Renderer>(true))
            r.enabled = false;
        foreach (var a in _poseSrc.GetComponentsInChildren<Animator>(true))
            a.enabled = false;

        _poseSourceBones = new Dictionary<string, Transform>();
        foreach (var t in _poseSrc.GetComponentsInChildren<Transform>(true))
            if (!_poseSourceBones.ContainsKey(t.name)) _poseSourceBones[t.name] = t;

        var defs = new (string state, string path, bool loop)[]
        {
            ("idle",            "Avatar/idle",            true),
            ("walking",         "Avatar/walking",         true),
            ("running",         "Avatar/running",         true),
            ("jumping-up",      "Avatar/jumping-up",      false),
            ("jumping-down",    "Avatar/jumping-down",    false),
            ("swimming",        "Avatar/swimming",        true),
            ("climbing-ladder", "Avatar/climbing-ladder", true),
            ("treading-water",  "Avatar/treading-water",  true),
        };

        foreach (var (state, path, loop) in defs)
        {
            var loaded = Resources.LoadAll<AnimationClip>(path);
            if (loaded.Length == 0) { Debug.LogWarning($"[GameRenderClient] Clip not found: {path}"); continue; }
            _animClips[state]     = loaded[0];
            _animClipLoops[state] = loop;
        }

        SwitchAnim("idle");
    }

    private void TearDownAnimations()
    {
        if (_poseSrc != null) { Destroy(_poseSrc); _poseSrc = null; }
        _poseSourceBones = null;
        // _chibiTargetBones is owned by SpawnPlayer — cleared there, not here.
        _animClips.Clear();
        _animNormTimes.Clear();
        _animClipLoops.Clear();
        _currentAnimState = "";
        _animPlayTime     = 0f;
    }

    private void SwitchAnim(string state)
    {
        if (_currentAnimState == state) return;
        if (!_animClips.ContainsKey(state)) return;

        // Audio cues on state transitions: a jump push-off when leaving the
        // ground upward, and a thud whenever returning from any airborne state.
        bool wasAir = _currentAnimState == "jumping-up" || _currentAnimState == "jumping-down";
        bool nowAir = state == "jumping-up" || state == "jumping-down";
        if (!wasAir && state == "jumping-up")      GameAudio.PlaySound("jump");
        else if (wasAir && !nowAir && !string.IsNullOrEmpty(_currentAnimState))
                                                   GameAudio.PlaySound("land");

        if (!string.IsNullOrEmpty(_currentAnimState))
            _animNormTimes[_currentAnimState] = _animPlayTime;
        _currentAnimState = state;
        bool loops = _animClipLoops.TryGetValue(state, out var l) && l;
        _animPlayTime = (loops && _animNormTimes.TryGetValue(state, out var saved)) ? saved : 0f;
    }

    private void LateUpdate()
    {
        if (_poseSrc == null || _poseSourceBones == null || _chibiTargetBones == null) return;

        if (_playerInstance != null)
        {
            // Use the server-authoritative velocity captured in ApplyPlayerState.
            // The client-side Rigidbody is kinematic so its linearVelocity is
            // always zero and reading it would lock the animator on "idle".
            float vy     = _playerServerVelocity.y;
            float hSpeed = new Vector2(_playerServerVelocity.x, _playerServerVelocity.z).magnitude;
            bool  inAir  = !_playerServerGrounded;

            string next;
            if (inAir)
                next = vy > 0f ? "jumping-up" : "jumping-down";
            else
                next = hSpeed > (_currentAnimState == "running" ? 2.5f : 3.5f) ? "running"
                     : hSpeed > (_currentAnimState == "walking" ? 0.2f : 0.5f) ? "walking"
                     : "idle";

            SwitchAnim(next);

            // Footstep cadence: steps land faster the quicker you move. Reset
            // the timer when stopped/airborne so the first step fires promptly
            // when you start walking again.
            if (!inAir && hSpeed > 0.3f)
            {
                _stepTimer -= Time.deltaTime;
                if (_stepTimer <= 0f)
                {
                    GameAudio.PlaySound("step");
                    _stepTimer = Mathf.Clamp(2.2f / Mathf.Max(hSpeed, 0.5f), 0.22f, 0.5f);
                }
            }
            else _stepTimer = 0f;
        }

        if (!string.IsNullOrEmpty(_currentAnimState)
            && _animClips.TryGetValue(_currentAnimState, out var activeClip))
        {
            bool loops = _animClipLoops.TryGetValue(_currentAnimState, out var lp) && lp;
            _animPlayTime += Time.deltaTime / activeClip.length;
            if (loops) _animPlayTime %= 1f;
            else       _animPlayTime  = Mathf.Min(_animPlayTime, 1f);
            PoseSampler.Sample(activeClip, _poseSrc, _animPlayTime * activeClip.length);
        }

        // Copy bone rotations from pose source to chibi skeleton.
        // Hips needs world-rotation conversion because idle.fbx has no Armature parent
        // while chibi-base.fbx may place bones under an Armature node.
        const string hipsName = "mixamorig:Hips";
        if (_chibiTargetBones.TryGetValue(hipsName, out var hipsTarget) &&
            _poseSourceBones.TryGetValue(hipsName, out var hipsSrc) &&
            hipsTarget != null && hipsSrc != null)
        {
            var playerRootRot = _playerInstance != null
                ? _playerInstance.transform.rotation
                : Quaternion.identity;
            var par = hipsTarget.parent;
            hipsTarget.localRotation = par != null
                ? Quaternion.Inverse(par.rotation) * playerRootRot * hipsSrc.rotation
                : playerRootRot * hipsSrc.rotation;
        }

        foreach (var kv in _chibiTargetBones)
        {
            if (kv.Value == null || kv.Key == hipsName) continue;
            if (_poseSourceBones.TryGetValue(kv.Key, out var src) && src != null)
                kv.Value.localRotation = src.localRotation;
        }

        // GroundChibiToTerrain used to live here. Its purpose was to fight a
        // ~0.5 m visible float caused by the server clamping the player to
        // groundY = max(0.5, spawnY=1.0) while the terrain mesh top was at
        // Y=0.5. The server now follows the live client raycast (no spawnY
        // floor) and DeferredAvatarScale anchors chibi.localPosition.y so
        // the chibi feet land exactly at playerRoot.y — both adjustments
        // are deterministic and parent-child, so nothing else needs to
        // chase the visual every frame. The previous routine's "if gap is
        // 0.05–1.5 m, lower chibi by gap" logic ALSO had no symmetric
        // raise-when-too-low branch, so any moment during the initial
        // spawn-fall when the chibi happened to be 0.05–1.5 m above terrain
        // permanently buried it (chibi.localPosition.y drifted to -1.82 m
        // in testing, sinking the entire avatar through the ground).
    }

    private void GroundChibiToTerrain()
    {
        if (_playerInstance == null) return;
        var chibi = _playerInstance.transform.Find("ChibiVisual");
        if (chibi == null) return;

        float feetY = float.MaxValue;
        foreach (var r in chibi.GetComponentsInChildren<Renderer>(false))
            if (r.enabled && r.bounds.size.sqrMagnitude > 0f)
                feetY = Mathf.Min(feetY, r.bounds.min.y);
        if (feetY >= float.MaxValue) return;

        // Temporarily disable the player's own collider so the downward raycast
        // doesn't hit it — the origin is inside the capsule (capsule.center.y=1).
        var ownCol = _playerInstance.GetComponent<Collider>();
        bool wasEnabled = ownCol != null && ownCol.enabled;
        if (ownCol != null) ownCol.enabled = false;
        try
        {
            var origin = _playerInstance.transform.position + Vector3.up * 0.1f;
            if (Physics.Raycast(origin, Vector3.down, out var hit, 3f, ~0, QueryTriggerInteraction.Ignore))
            {
                float gap = feetY - hit.point.y;
                // Only anchor when meaningfully off (> 5 cm to avoid jitter) and
                // not airborne (< 1.5 m → likely standing or stair-stepping).
                if (gap > 0.05f && gap < 1.5f)
                    chibi.position -= Vector3.up * gap;
            }
        }
        finally
        {
            if (ownCol != null && wasEnabled) ownCol.enabled = true;
        }
    }

    private IEnumerator DeferredAvatarScale(Transform playerRoot)
    {
        var chibi = playerRoot.Find("ChibiVisual");
        if (chibi == null) yield break;

        // Reset chibi to a known starting state so this routine is idempotent
        // even if it runs more than once (re-spawns, hot-reloads, edge cases
        // around two GameRenderClient singletons existing briefly): if a
        // previous run already lifted/scaled the chibi, the bounds we
        // measure below would reflect THAT lifted-and-scaled state, and the
        // new lift would stack on top — which is exactly how the avatar
        // ended up with localPosition.y = -2.84 in testing. Starting from
        // identity localPos+localScale makes every run produce the same
        // canonical output.
        chibi.localScale = Vector3.one;
        chibi.localPosition = Vector3.zero;

        float renderedH = 0f, lo = 0f;
        float centerX = 0f, centerZ = 0f;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            yield return new WaitForEndOfFrame();
            if (chibi == null) yield break;

            float minY = float.MaxValue, maxY = float.MinValue;
            float minX = float.MaxValue, maxX = float.MinValue;
            float minZ = float.MaxValue, maxZ = float.MinValue;
            foreach (var r in chibi.GetComponentsInChildren<Renderer>())
            {
                if (!r.enabled) continue;
                minY = Mathf.Min(minY, r.bounds.min.y);
                maxY = Mathf.Max(maxY, r.bounds.max.y);
                minX = Mathf.Min(minX, r.bounds.min.x);
                maxX = Mathf.Max(maxX, r.bounds.max.x);
                minZ = Mathf.Min(minZ, r.bounds.min.z);
                maxZ = Mathf.Max(maxZ, r.bounds.max.z);
            }
            if (minY >= float.MaxValue) continue;
            renderedH = maxY - minY;
            lo = minY;
            // Horizontal center of the rendered mesh in world space. Many Meshy
            // GLBs are authored off to one side of their root node, so the body
            // stands next to the pivot, not on it — rotating the root then
            // orbits the body in a wide arc. Capture the center so we can cancel
            // that horizontal offset below.
            centerX = (minX + maxX) * 0.5f;
            centerZ = (minZ + maxZ) * 0.5f;
            if (renderedH >= 0.001f) break;
        }

        if (renderedH < 0.001f)
        {
            Debug.LogWarning("[GameRenderClient] Avatar bounds still zero after 5 frames — scale not applied.");
            yield break;
        }

        if (chibi == null) yield break;

        const float TargetH = 2f;
        float s = TargetH / renderedH;
        chibi.localScale = Vector3.one * s;

        // Distance from chibi pivot to mesh-bottom AFTER the new scale, in
        // world units. Both pivot and lo were sampled BEFORE we modified
        // localScale (chibi.localPosition was reset to 0 above so chibi.world
        // == playerRoot.world for this calculation), so the pre-scale gap
        // chibi.position.y - lo is the half-height we need to multiply by s.
        float halfHeight = (chibi.position.y - lo) * s;
        // Horizontal gap from the rotation pivot (chibi/playerRoot world XZ,
        // sampled pre-scale with localPos==0) to the mesh's horizontal center.
        // Scaled by s like halfHeight, then negated so the body recenters over
        // the pivot. This kills the "wide arc" turn: rotation now spins the
        // avatar in place instead of orbiting an off-center body.
        float offX = (centerX - chibi.position.x) * s;
        float offZ = (centerZ - chibi.position.z) * s;
        // Convert the world-space XZ offset to playerRoot local space before
        // negating. Storing a raw world-space delta as a local-space offset
        // only cancels the mesh-center shift when the root faces the same
        // direction as at measurement time — a 180° turn flips local X,
        // so the offset adds instead of subtracts and the avatar orbits an
        // off-center pivot rather than spinning in place.
        Vector3 localOff = chibi.parent != null
            ? chibi.parent.InverseTransformDirection(new Vector3(offX, 0f, offZ))
            : new Vector3(offX, 0f, offZ);
        chibi.localPosition = new Vector3(-localOff.x, halfHeight, -localOff.z);

        Debug.Log($"[GameRenderClient] Avatar scaled: renderedH={renderedH:F3} → scale={s:F3} halfHeight={halfHeight:F2} localOff=({-localOff.x:F2},{-localOff.z:F2})");
    }

    private IEnumerator EffectCoroutine(string preset, Vector3 pos)
    {
        Color col = preset switch
        {
            "explosion" => new Color(1f, 0.5f, 0f),
            "confetti"  => new Color(0.3f, 1f,  0.5f),
            "fire"      => new Color(1f, 0.3f, 0f),
            _           => new Color(1f, 0.95f, 0.2f),
        };
        var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        go.transform.position = pos;
        go.transform.localScale = Vector3.one * 0.1f;
        var ren = go.GetComponent<Renderer>();
        var m = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        m.SetColor("_BaseColor", col);
        m.EnableKeyword("_EMISSION"); m.SetColor("_EmissionColor", col * 3f);
        ren.material = m;
        foreach (var c in go.GetComponents<Collider>()) Destroy(c);
        for (float t = 0; t < 0.45f; t += Time.deltaTime)
        {
            if (go) go.transform.localScale = Vector3.one * Mathf.Lerp(0.1f, 2f, t / 0.45f);
            yield return null;
        }
        if (go) Destroy(go);
    }

    private static Color PlaceholderColor(string id)
    {
        var l = id.ToLower();
        if (Contains(l, "grass", "terrain", "ground", "island", "land"))   return new Color(0.35f, 0.65f, 0.25f);
        if (Contains(l, "water", "ocean", "lake", "river", "pool"))         return new Color(0.20f, 0.45f, 0.80f);
        if (Contains(l, "lava", "magma", "fire", "volcano"))                return new Color(0.90f, 0.30f, 0.05f);
        if (Contains(l, "stone", "rock", "cliff", "boulder", "wall"))       return new Color(0.55f, 0.52f, 0.48f);
        if (Contains(l, "ice", "snow", "frost", "glacier"))                 return new Color(0.80f, 0.92f, 1.00f);
        if (Contains(l, "cloud", "sky"))                                     return new Color(0.90f, 0.90f, 0.95f);
        if (Contains(l, "portal", "finish", "goal", "end"))                 return new Color(1.00f, 0.85f, 0.10f);
        if (Contains(l, "coin", "gold", "gem", "treasure"))                 return new Color(1.00f, 0.80f, 0.00f);
        if (Contains(l, "wood", "tree", "log", "plank", "platform"))        return new Color(0.58f, 0.38f, 0.18f);
        if (Contains(l, "sand", "desert", "beach", "dune"))                 return new Color(0.90f, 0.82f, 0.55f);
        if (Contains(l, "enemy", "monster", "zombie", "boss"))              return new Color(0.75f, 0.15f, 0.15f);
        if (Contains(l, "mushroom", "plant", "flower", "bush"))             return new Color(0.60f, 0.25f, 0.50f);
        return new Color(0.55f, 0.60f, 0.70f);
    }
    private static bool Contains(string s, params string[] terms)
    {
        foreach (var t in terms) if (s.Contains(t)) return true;
        return false;
    }
}

// ── ServerTriggerZone ─────────────────────────────────────────────────────────
// Detects player overlap and reports it to the server (which fires Lua callbacks).
public class ServerTriggerZone : MonoBehaviour
{
    private string _entityId;
    private GameRenderClient _client;

    public void Init(string entityId, GameRenderClient client)
    {
        _entityId = entityId;
        _client   = client;
        var col = GetComponent<Collider>();
        if (!col) col = gameObject.AddComponent<BoxCollider>();
        col.isTrigger = true;
    }

    private void OnTriggerEnter(Collider other)
    {
        if (other.CompareTag("Player") && _client != null)
            _client.SendTriggerEnter(_entityId);
    }

    private void OnTriggerExit(Collider other)
    {
        if (other.CompareTag("Player") && _client != null)
            _client.SendTriggerExit(_entityId);
    }

    private void OnCollisionEnter(Collision c)
    {
        if (_client != null) _client.SendCollision(_entityId, c.gameObject.name);
    }
}

// ── ChatBubbleBillboard ──────────────────────────────────────────────────────
// Keeps a world-space chat-bubble canvas facing the active camera each frame.
// Without this the bubble would be readable only from one angle, since the
// orbit camera continuously circles the player.
public class ChatBubbleBillboard : MonoBehaviour
{
    private void LateUpdate()
    {
        var cam = Camera.main;
        if (cam == null) return;
        // Face the camera but lock roll so the text never tilts sideways.
        var look = transform.position - cam.transform.position;
        look.y = 0f;
        if (look.sqrMagnitude < 0.0001f) return;
        transform.rotation = Quaternion.LookRotation(look.normalized, Vector3.up);
    }
}
