using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Rendering.Universal;
using MoonSharp.Interpreter;
using ReactUnity.UGUI;
using GLTFast;

// Executes Luau game scripts via MoonSharp and wires their API calls to Unity.
// GameLauncher is the entry point — call RunGame(GameData) to start a session.
public partial class LuauGameRunner : MonoBehaviour
{
    [Header("Scene")]
    [SerializeField] private Transform gameRoot;
    [SerializeField] private Transform playerSpawn;

    // ── State ─────────────────────────────────────────────────────────────────

    private Script       _lua;
    private GameProxy    _gameProxy;
    private InputProxy   _inputProxy;
    private bool         _running;
    private int          _score;
    private float        _health        = 100f;
    private float        _speed         = RobloxPhysics.WalkSpeed;
    private float        _jumpHeight    = RobloxPhysics.JumpHeight;
    private float        _timeLimitSecs = 0f;
    private float        _timeElapsed   = 0f;
    private bool         _hasTimeLimit;
    private bool         _playerInvincible;
    private GameObject   _playerInstance;
    private Vector3      _lastSpawnPos = new Vector3(0f, 3f, 0f);
    private string       _lastPrompt;
    private string       _gameGenre;
    private bool         _previewMode;     // true = editor preview, skip HUD globals + mobile controls
    public  bool         IsPreviewMode => _previewMode;
    // Exposed so EditorCameraController can reveal the (normally hidden-in-preview)
    // avatar while the Assign pick-mode flow is active — there's otherwise nothing
    // visible for the creator to tap to name "the player" as a variable.
    public  GameObject   PlayerInstance => _playerInstance;
    // True when this load has no Lua script (a brand-new blank game). Drives the
    // Roblox-style baseplate look: light-blue sky + gray checkerboard ground.
    private bool         _blankBaseplate;
    private int          _previewGameId;   // game ID when in preview mode; -1 = build preview (no upload)
    private int          _activeGameId;    // game ID for the running session (preview OR play); 0 = none
    private GameAssetLoader _assetLoader;

    // Spawn-point camera pose recorded one frame after OnStart fires. Used to lock the
    // capture camera back to the player's first-frame view even after the user has
    // orbited the editor camera or the play camera has followed the chibi away.
    private struct SpawnCameraState
    {
        public Vector3    position;
        public Quaternion rotation;
        public float      fieldOfView;
        public bool       recorded;
    }
    private SpawnCameraState _spawnCameraState;
    private string       _lastAssetUrlsJson    = "{}";
    private string       _lastHumanoidIdsJson  = "[]";

    // Cross-thread dispatch: Lua API calls made from the background DoString thread
    // are queued here and serviced by the main thread in the pump loop below.
    // Non-null only while the script background thread is running.
    internal System.Collections.Concurrent.ConcurrentQueue<MainThreadOp> MainThreadOps;

    // Captured at Awake so RunOnMainThread can detect re-entrancy. Without this,
    // a wrapped method that internally calls another wrapped method (e.g.
    // SetPlayerHealth → NotifyReact) would queue a second op and Wait() on a
    // pump that can't run because the main thread is already executing op #1.
    private static int _mainThreadId;

    internal sealed class MainThreadOp
    {
        internal readonly Func<object> Factory;
        internal object Result;
        internal Exception Error;
        internal readonly System.Threading.ManualResetEventSlim Done = new(false);
        internal MainThreadOp(Func<object> f) { Factory = f; }
    }

    internal T RunOnMainThread<T>(Func<T> factory)
    {
        // Already on the main thread: run inline. Critical to avoid the
        // re-entrancy deadlock when a queued op itself calls a wrapped method.
        if (System.Threading.Thread.CurrentThread.ManagedThreadId == _mainThreadId)
            return factory();
        var q = MainThreadOps;
        if (q == null) return factory(); // bg thread, no DoString in flight
        var op = new MainThreadOp(() => factory());
        q.Enqueue(op);
        op.Done.Wait();
        if (op.Error != null) throw op.Error;
        return (T)op.Result;
    }

    private void DrainMainThreadOps()
    {
        var q = MainThreadOps;
        if (q == null) return;
        while (q.TryDequeue(out var op))
        {
            try   { op.Result = op.Factory(); }
            catch (Exception ex) { op.Error = ex; }
            op.Done.Set();
        }
    }

    public Transform GameRoot => gameRoot;

    private readonly Dictionary<int, UnityEngine.Coroutine> _timers = new();
    private int _nextTimerId;
    private string _lastScript;

    // ── Animation pose source (same bone-path-mismatch fix as AvatarPreviewController) ─
    // idle.fbx has no Armature parent; torso.fbx does. Curves won't match across the
    // hierarchy difference, so we run each animation on idle.fbx's own skeleton and copy
    // bone rotations by name to the chibi skeleton every LateUpdate.
    private GameObject _poseSrc;
    private Dictionary<string, Transform>      _poseSourceBones;
    private Dictionary<string, Transform>      _chibiTargetBones;
    private readonly Dictionary<string, AnimationClip> _animClips      = new();
    private readonly Dictionary<string, float>         _animNormTimes  = new();
    private readonly Dictionary<string, bool>          _animClipLoops  = new();
    private string _currentAnimState = "";
    private float  _animPlayTime     = 0f;

    public static LuauGameRunner Instance { get; private set; }

    [UnityEngine.RuntimeInitializeOnLoadMethod(UnityEngine.RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void EnsureInstance()
    {
        if (Instance != null) return;
        var go = new GameObject("LuauGameRunner");
        go.AddComponent<LuauGameRunner>();
        Debug.Log("[LuauGameRunner] Auto-created via RuntimeInitializeOnLoad.");
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        // Awake always runs on the Unity main thread. Capture id so RunOnMainThread
        // can short-circuit re-entrant main-thread calls from queued ops.
        _mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
        UserData.RegisterType<SceneProxy>();
        UserData.RegisterType<LuaObject>();
        UserData.RegisterType<ObjectFactory>();
        UserData.RegisterType<StructureFactory>();
        UserData.RegisterType<PlayerProxy>();
        UserData.RegisterType<LightFactory>();
        UserData.RegisterType<LuaLight>();
        UserData.RegisterType<AudioProxy>();
        UserData.RegisterType<UIProxy>();
        UserData.RegisterType<GameProxy>();
        UserData.RegisterType<NetworkProxy>();
        UserData.RegisterType<EffectsProxy>();
        UserData.RegisterType<TimerProxy>();
        UserData.RegisterType<EnvironmentProxy>();
        UserData.RegisterType<WorkspaceLegacy>();
        UserData.RegisterType<PhysicsLegacy>();
        UserData.RegisterType<PhysicsProxy>();
        UserData.RegisterType<PlayersLegacy>();
        UserData.RegisterType<InputProxy>();
    }

    private void OnDestroy() { _running = false; Instance = null; }

    // ── Public entry point (called by GameLauncher) ───────────────────────────

    // Editor-state JSON captured by EditorState.Capture and shipped on
    // GameData.editorStateJson. Applied once Lua finishes spawning objects so
    // the creator's transform / settings / logic edits actually play. Null /
    // empty / "{}" means the game has no edits beyond the script.
    private string _pendingEditorStateJson;
    private string _pendingSizeHintsJson;

    // Runs a pre-fetched game script directly, bypassing the API fetch step.
    public void RunGame(GameData data)
    {
        _previewMode  = false;
        _activeGameId = data.id;
        _lastPrompt   = data.description;
        _gameGenre    = data.genre ?? "";
        _pendingEditorStateJson = data.editorStateJson;
        _pendingSizeHintsJson   = data.sizeHintsJson;
        StartCoroutine(LoadAssetsAndRun(data.assetUrlsJson, data.gameCode, data.humanoidIdsJson));
    }

    // Editor preview: game world renders but no mobile controls or _gameActive signal.
    public void RunGamePreview(GameData data)
    {
        _previewMode   = true;
        _previewGameId = data.id;
        _activeGameId  = data.id;
        _lastPrompt    = data.description;
        _gameGenre     = data.genre ?? "";
        _pendingEditorStateJson = data.editorStateJson;
        _pendingSizeHintsJson   = data.sizeHintsJson;
        StartCoroutine(LoadAssetsAndRun(data.assetUrlsJson, data.gameCode, data.humanoidIdsJson));
    }

    private IEnumerator LoadAssetsAndRun(string assetUrlsJson, string luauCode, string humanoidIdsJson = null)
    {
        // Persist for restart via Game.Restart() / "Play Again"
        _lastAssetUrlsJson   = assetUrlsJson   ?? "{}";
        _lastHumanoidIdsJson = humanoidIdsJson ?? "[]";

        // Tear down the previous session FIRST. The previous arrangement
        // called TearDown() from RunScript() — which fired AFTER LoadAssets
        // had already populated the freshly-built _assetLoader, nulling the
        // field one beat before the Lua thread started. Every
        // Object.Create("model:…") then took the ObjectFactory cube-fallback
        // path because _runner.SpawnAsset returned null, and the
        // AssetSwapRetryCoroutine — which polls the loader at 2s/4s/6s —
        // also observed null on every retry and yield-broke. Whether each
        // session ended up showing real GLBs, cubes, or a partial mix
        // depended on whether a previous session's retry happened to fire
        // during the brief window when the new loader existed; that's the
        // visible inconsistency between joins (cubes everywhere → some real
        // → mostly real → cubes again). Doing TearDown here clears the
        // previous session's gameRoot/_playerInstance/etc. and ALSO
        // destroys the previous _assetLoader, leaving the field null. Then
        // we create the new loader and call LoadAssets, and by the time
        // RunScript starts the Lua thread the loader is alive and
        // populated.
        TearDown();

        // A brand-new game ships no Lua. Render it like a Roblox Studio
        // baseplate: light-blue sky + ambient skyline lighting + gray
        // checkerboard ground (applied to the TerrainBuilder below).
        _blankBaseplate = string.IsNullOrWhiteSpace(luauCode);

        // Reset scene style/player settings to defaults; EditorState.Apply will
        // restore the creator's saved choices (if any) after the script runs.
        SceneSettings.Reset();

        // Immediately stand up a camera + baseline skybox/ambient light so the
        // viewport renders SOMETHING while LoadAssets blocks on the network.
        // Without this the editor preview is black for the entire asset-load
        // window (often several seconds on a fresh game), which reads as a
        // broken editor. EnsureGameCamera/EnvironmentManager are both
        // idempotent — RunScript calls them again once the script is ready,
        // and any Scene.SetSkybox call from Lua overrides the baseline.
        EnsureGameCamera();
        if (_blankBaseplate) EnvironmentManager.SetBaseplateEnvironment();
        else                 EnvironmentManager.SetEnvironment(_gameGenre);

        // Stand up gameRoot + invisible safety floor BEFORE LoadAssets so the
        // editor preview is walkable for the entire asset-load window. Meshy
        // GLB downloads can take 5–15 s on a fresh game with no R2 cache.
        if (gameRoot == null)
        {
            var rootGo = new GameObject("LuauGameRoot");
            gameRoot = rootGo.transform;
        }
        EnsureSafetyFloor();

        // Default ground = the editable TerrainBuilder baseplate, parked at
        // origin / y=0. New games no longer ship terrain (Lua scripts are
        // forbidden from CreateTerrain and the asset manifest from "terrain")
        // — this is the playable surface the player sculpts via the Terrain
        // Builder UI. Legacy games that still call Structure.CreateTerrain or
        // Object.Create("model:terrain") simply layer their geometry on top
        // of this baseplate. Reset its heightmap on each load so a fresh
        // session starts flat (persistence will land in a follow-up).
        var tb = TerrainBuilder.EnsureInstance();
        tb.ResetTerrain();
        tb.transform.position = Vector3.zero;
        tb.Show(true);
        tb.SetBaseplateStyle(_blankBaseplate);

        // Build a fresh GameAssetLoader for this session.
        _assetLoader = gameObject.AddComponent<GameAssetLoader>();

        if (!string.IsNullOrEmpty(assetUrlsJson) && assetUrlsJson != "{}")
        {
            Debug.Log("[LuauGameRunner] Pre-loading game assets…");
            yield return _assetLoader.LoadAssets(assetUrlsJson, humanoidIdsJson, sizeHintsJson: _pendingSizeHintsJson);
            Debug.Log("[LuauGameRunner] Assets loaded, starting script.");

            if (!assetUrlsJson.Contains("\"terrain\""))
                Debug.LogWarning("[LuauGameRunner] No terrain asset found in manifest — ground will be missing. Add {\"id\":\"terrain\",...} as first manifest entry.");
        }

        yield return StartCoroutine(RunScript(luauCode));
    }

    // ── Load + Execute ────────────────────────────────────────────────────────

    public IEnumerator LoadAndRunGame(int gameId)
    {
        Debug.Log($"[LuauGameRunner] Loading game {gameId}");

        GameData data = null;
        string error  = null;
        yield return PludoApiClient.GetGame(gameId, d => data = d, e => error = e);

        if (error != null)
        {
            Debug.LogError($"[LuauGameRunner] Failed to fetch game {gameId}: {error}");
            yield break;
        }

        if (string.IsNullOrEmpty(data?.gameCode))
        {
            Debug.LogWarning($"[LuauGameRunner] Game {gameId} has no script.");
            yield break;
        }

        _lastPrompt = data.description;
        _gameGenre  = data.genre ?? "";
        yield return LoadAssetsAndRun(data.assetUrlsJson, data.gameCode, data.humanoidIdsJson);
    }

    // ── Partial-script streaming guard ────────────────────────────────────────

    // True while React is feeding incremental partials from runPartialScript.
    // Causes parse-error catches to silence _editorError and skip TearDown so
    // the previously-rendered scene survives a mid-stream truncation. Toggled
    // by GameLauncher (see RunPartialScript / StartBuildPreview / LaunchAsync).
    public static bool IsStreamingPartialScript;

    // Block-balance check used to detect Lua scripts that were truncated mid-
    // function/if/for/while. Counts opener vs closer keywords AFTER stripping
    // strings + comments so keywords inside literals don't skew the count.
    // Returned int is (openers - closers): >0 means N missing `end`s.
    private static readonly Regex _luaOpenerRx = new(@"\b(function|if|for|while|repeat)\b");
    private static readonly Regex _luaCloserRx = new(@"\b(end|until)\b");

    public static int LuaBlockBalance(string script)
    {
        if (string.IsNullOrEmpty(script)) return 0;
        var stripped = StripLuaStringsAndComments(script);
        return _luaOpenerRx.Matches(stripped).Count - _luaCloserRx.Matches(stripped).Count;
    }

    public static bool IsLuaScriptComplete(string script) => LuaBlockBalance(script) <= 0;

    public static string AutoCompleteLuaScript(string script)
    {
        int depth = LuaBlockBalance(script);
        if (depth <= 0) return script;
        var sb = new StringBuilder(script);
        if (script.Length > 0 && script[script.Length - 1] != '\n') sb.AppendLine();
        for (int i = 0; i < depth; i++) sb.AppendLine("end");
        return sb.ToString();
    }

    // Pure-syntax check: feeds the script to a throwaway MoonSharp Script with
    // LoadString. No globals are needed for parsing, so this never executes the
    // script — it just validates that the grammar is well-formed.
    public static bool TryParseLua(string script)
    {
        try
        {
            var s = new Script(CoreModules.Preset_SoftSandbox & ~CoreModules.Coroutine);
            s.LoadString(script);
            return true;
        }
        catch (SyntaxErrorException) { return false; }
        catch (Exception)             { return false; }
    }

    // Walks the script and replaces string contents + comments with spaces so
    // they don't contribute keyword matches. Handles short strings ("..." / '...'),
    // long strings/comments ([[...]], [=[...]=]), and line comments (-- ...).
    private static string StripLuaStringsAndComments(string src)
    {
        var sb = new StringBuilder(src.Length);
        int i = 0;
        while (i < src.Length)
        {
            char c = src[i];
            if (c == '-' && i + 1 < src.Length && src[i + 1] == '-')
            {
                i += 2;
                if (i < src.Length && src[i] == '[')
                {
                    int eq = 0; int j = i + 1;
                    while (j < src.Length && src[j] == '=') { eq++; j++; }
                    if (j < src.Length && src[j] == '[')
                    {
                        string close = "]" + new string('=', eq) + "]";
                        int end = src.IndexOf(close, j + 1, StringComparison.Ordinal);
                        if (end < 0) return sb.ToString(); // unterminated block comment
                        i = end + close.Length;
                        continue;
                    }
                }
                while (i < src.Length && src[i] != '\n') i++;
                continue;
            }
            if (c == '"' || c == '\'')
            {
                char q = c; i++;
                while (i < src.Length)
                {
                    if (src[i] == '\\' && i + 1 < src.Length) { i += 2; continue; }
                    if (src[i] == q) { i++; break; }
                    if (src[i] == '\n') { i++; break; }
                    i++;
                }
                continue;
            }
            if (c == '[')
            {
                int eq = 0; int j = i + 1;
                while (j < src.Length && src[j] == '=') { eq++; j++; }
                if (j < src.Length && src[j] == '[')
                {
                    string close = "]" + new string('=', eq) + "]";
                    int end = src.IndexOf(close, j + 1, StringComparison.Ordinal);
                    if (end < 0) return sb.ToString(); // unterminated long string
                    i = end + close.Length;
                    continue;
                }
            }
            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }

    // ── Luau sanitizer ────────────────────────────────────────────────────────

    // Null-sink proxy for Roblox globals — makes workspace.X.Y:Connect(fn) a no-op
    // instead of a parse/runtime error. Numeric key access returns nil so ipairs stops.
    private const string LuauCompatPreamble =
        "local function __ns() local t={} setmetatable(t,{__index=function(s,k) if type(k)=='number' then return nil end return __ns() end,__newindex=function()end,__call=function()return __ns()end}) return t end\n" +
        "local workspace=__ns() local script=__ns() local Instance={new=function()return __ns()end}\n" +
        "local task={wait=function()end,spawn=function(f)if type(f)=='function'then pcall(f)end end,delay=function()end,cancel=function()end}\n" +
        "local RunService=__ns() local Players=__ns() local ReplicatedStorage=__ns() local CollectionService=__ns() local TweenService=__ns()\n";

    public static string SanitizeLuauScript(string code)
    {
        // ── Strip Roblox Luau type declarations and mode comments ─────────────
        // In standard Lua, `type` is a built-in function. Roblox Luau uses it as a
        // keyword: `type Triggers = {...}` → "unexpected symbol near 'Triggers'".
        // Strip these blocks before MoonSharp sees them.
        {
            var typeRx = new Regex(@"^(export\s+)?type\s+\w");
            var sb = new StringBuilder(code.Length);
            int depth = 0;
            bool inBlock = false;
            foreach (var raw in code.Split('\n'))
            {
                var t = raw.TrimStart();
                if (t.StartsWith("--!")) { sb.AppendLine(); continue; }   // --!strict etc.
                if (!inBlock && typeRx.IsMatch(t))
                {
                    foreach (char c in raw) { if (c == '{') depth++; else if (c == '}') depth--; }
                    if (depth > 0) inBlock = true; else depth = 0;
                    sb.AppendLine();
                    continue;
                }
                if (inBlock)
                {
                    foreach (char c in raw) { if (c == '{') depth++; else if (c == '}') depth--; }
                    if (depth <= 0) { depth = 0; inBlock = false; }
                    sb.AppendLine();
                    continue;
                }
                sb.AppendLine(raw);
            }
            code = sb.ToString();
        }

        // ── Safety-net: catch any type declaration that survived the first pass ─
        // Handles edge-cases (e.g. `type\nName`, weird whitespace, unforeseen AI output).
        code = Regex.Replace(code, @"(?m)^[ \t]*(export[ \t]+)?type[ \t]+\w[^\n]*", "");

        // ── Strip Luau type annotations ───────────────────────────────────────
        // Roblox Luau allows `local x: Type = v` and `function f(x: Type): Ret`.
        // MoonSharp fails on the colon. Strip `: TypeName` (with optional `?`/`|`/`&` union).
        // Safe to use lookahead alone: `:method(` never matches because `(` is not in [,)=\n].
        code = Regex.Replace(code,
            @"\s*:\s*[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?[?]?(?:\s*[|&]\s*[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?[?]?)*(?=\s*[,)=\n])",
            "");

        // ── Strip table/dict type annotations ────────────────────────────────
        // e.g. `local x: {string} = {}` or `local x: {[string]: number} = {}`
        // The identifier-based regex above misses these because `{` is not [A-Za-z_].
        code = Regex.Replace(code, @"\s*:\s*\{[^}\n]*\}[?]?\s*(?=\s*[,)=\n])", "");

        // ── Strip Luau function-type annotations: `: (T) -> R` ───────────────
        // e.g. `local f: (number) -> string` or `callback: (string) -> ()`.
        // The identifier-based regex above requires the type to start with [A-Za-z_];
        // function types start with `(` and previously passed through unstripped,
        // causing MoonSharp SyntaxErrorException on the colon.
        code = Regex.Replace(code,
            @"\s*:\s*(?:\([^)\n]*\)\s*->\s*(?:\([^)\n]*\)|[^\n,)={]+)|\([^)\n]*\))(?=\s*[,)=\n{])",
            "");

        // ── Strip Luau generic type parameters on function defs / calls ───────
        // e.g. `function foo<T>(args)` or `obj:method<string>(args)`.
        // MoonSharp would parse `foo<T>` as `foo < T` (comparison) then >(args)
        // causing "function arguments expected". Strip `<...>` that sit between
        // an identifier and `(`. Only targets type-looking content (letters/commas/spaces).
        code = Regex.Replace(code, @"(\w)\s*<[A-Za-z0-9_,\s\?\|\&\.\[\]\{\}]+>\s*(?=\()", "$1");

        // ── Replace Luau `continue` with a no-op ─────────────────────────────
        // Standard Lua has no `continue`; MoonSharp treats it as an identifier,
        // leaving the loop body to finish normally rather than skipping to the next
        // iteration. That's semantically wrong but prevents a parse/runtime crash.
        code = Regex.Replace(code, @"\bcontinue\b", "--[[continue]]");

        // Fix missing commas in table constructors.
        // Only applies when inside a { } table constructor (braceDepth > 0).
        // In Lua, {} is always a table — function/if/for blocks use end, not } — so
        // depth > 0 reliably means "inside a table constructor, not a bare statement".
        var keywordRx = new System.Text.RegularExpressions.Regex(
            @"^(local\b|function\b|if\b|for\b|while\b|repeat\b|end\b|else\b|elseif\b|return\b|do\b|break\b|then\b|until\b)");
        var entryRx  = new System.Text.RegularExpressions.Regex(@"^[A-Za-z_]\w*\s*=(?!=)");
        var valueRx  = new System.Text.RegularExpressions.Regex(@"[\w}\]'""]$");

        var lines      = code.Split('\n');
        var result     = new System.Collections.Generic.List<string>(lines.Length);
        string prev    = "";
        bool prevKw    = false;
        int braceDepth = 0;

        foreach (var line in lines)
        {
            var trimmed = line.TrimStart();

            // Track brace depth BEFORE this line to know if we're inside a table.
            int depthBefore = braceDepth;
            foreach (char c in line)
            {
                if      (c == '{') braceDepth++;
                else if (c == '}') braceDepth--;
            }

            if (trimmed.Length > 0 && prev.Length > 0
                && depthBefore > 0              // only inside { } table constructors
                && !prevKw
                && !prev.EndsWith(",") && !prev.EndsWith("{")
                && !prev.EndsWith("(") && !prev.EndsWith("[")
                && !prev.StartsWith("--")
                && entryRx.IsMatch(trimmed) && valueRx.IsMatch(prev)
                && result.Count > 0)
            {
                result[result.Count - 1] = result[result.Count - 1].TrimEnd() + ",";
            }
            result.Add(line);
            if (trimmed.Length > 0 && !trimmed.StartsWith("--"))
            {
                prev   = trimmed;
                prevKw = keywordRx.IsMatch(trimmed);
            }
        }
        return LuauCompatPreamble + "\n" + string.Join("\n", result);
    }

    private IEnumerator RunScript(string luauCode)
    {
        _lastScript = luauCode;
        // TearDown() is called at the start of LoadAssetsAndRun (the only
        // path that reaches RunScript). Calling it here would re-destroy
        // the _assetLoader that LoadAssets just populated, sending every
        // Lua Object.Create("model:…") down the cube-placeholder path.

        if (_previewMode)
            Debug.Log($"[LuauGameRunner] Preview script ({luauCode?.Length ?? 0} chars, first 500):\n{luauCode?.Substring(0, Mathf.Min(500, luauCode?.Length ?? 0))}");
        else
            Debug.Log($"[LuauGameRunner] Raw script ({luauCode?.Length ?? 0} chars):\n{luauCode?.Substring(0, Mathf.Min(800, luauCode?.Length ?? 0))}");

        // SoftSandbox minus Coroutine (coroutines not needed by game scripts and
        // can be misused for resource-exhaustion attacks; 10-s timeout is a backup).
        _lua        = new Script(CoreModules.Preset_SoftSandbox & ~CoreModules.Coroutine);
        _gameProxy  = new GameProxy(this);
        _inputProxy = new InputProxy(this);

        // Ensure game root
        if (gameRoot == null)
        {
            var go = new GameObject("LuauGameRoot");
            gameRoot = go.transform;
        }

        var objFactory       = new ObjectFactory(gameRoot, this);
        var structureFactory = new StructureFactory(gameRoot, this);

        // ── Register all globals ──────────────────────────────────────────────
        var sceneProxy = new SceneProxy();
        _lua.Globals["Scene"]       = sceneProxy;
        _lua.Globals["Object"]      = objFactory;
        _lua.Globals["Structure"]   = structureFactory;
        _lua.Globals["Player"]      = new PlayerProxy(this);
        _lua.Globals["Light"]       = new LightFactory(gameRoot, this);
        _lua.Globals["Audio"]       = new AudioProxy(this);
        _lua.Globals["UI"]          = new UIProxy(this);
        _lua.Globals["Game"]        = _gameProxy;
        _lua.Globals["Network"]     = new NetworkProxy(this);
        _lua.Globals["Effects"]     = new EffectsProxy(this);
        _lua.Globals["Timer"]       = new TimerProxy(this);
        _lua.Globals["Environment"] = new EnvironmentProxy(objFactory, this);
        _lua.Globals["Input"]       = _inputProxy;

        // Legacy aliases (for scripts generated with old prompt)
        _lua.Globals["workspace"]   = new WorkspaceLegacy(gameRoot, this);
        _lua.Globals["Physics"]     = new PhysicsProxy(this);
        _lua.Globals["game"]        = _gameProxy;
        _lua.Globals["Players"]     = new PlayersLegacy(this);

        _lua.Globals["print"] = (Action<object>)(m => Debug.Log($"[Luau] {m}"));
        _lua.Globals["warn"]  = (Action<object>)(m => Debug.LogWarning($"[Luau] {m}"));

        // Ensure camera background is dark before anything renders, preventing gray flash
        // between TearDown and the new script creating its first objects.
        EnsureGameCamera();

        // Apply genre-appropriate skybox and lighting as a baseline before the script runs.
        // Lua's Scene.SetSkybox / Scene.SetEnvironment deferred calls will override this.
        // A blank game keeps the Roblox-style baseplate sky set in LoadAssetsAndRun.
        if (_blankBaseplate) EnvironmentManager.SetBaseplateEnvironment();
        else                 EnvironmentManager.SetEnvironment(_gameGenre);

        // Safety floor + visible ground are now set up in LoadAssetsAndRun
        // before the asset-load coroutine yields (the editable TerrainBuilder
        // baseplate is the default ground). EnsureSafetyFloor is still
        // idempotent if anything calls into RunScript directly without going
        // through LoadAssetsAndRun.
        EnsureSafetyFloor();

        // Register restartGame global so React popups can trigger a restart.
        var renderers = FindObjectsByType<ReactRendererUGUI>();
        foreach (var r in renderers)
            r.Globals["restartGame"] = (Action)(() => { NotifyReact("_popupTitle", ""); RestartGame(); });

        // Run DoString on a background thread so an infinite loop in Lua cannot
        // hang the Unity main thread. Join with a 10-second timeout; if it exceeds
        // that, bail out — the background thread is a daemon and dies on app exit.
        var sanitized = SanitizeLuauScript(luauCode);

        if (sanitized.Contains("{{FILL:"))
        {
            Debug.LogError("[LuauGameRunner] Script contains unfilled template placeholders — generation was incomplete.");
            EnsureGameCamera();
            if (_previewMode)
            {
                EnsureEditorCameraForPreview();
                if (!IsStreamingPartialScript)
                    NotifyReact("_editorError", "Generation incomplete — unfilled placeholders. Please wait or retry.");
            }
            else
            {
                NotifyReact("_gameMessage", "Game generation was incomplete. Please try again.");
            }
            yield break;
        }

        // Arm deferred mode: any RenderSettings/Physics/Camera call made during DoString
        // (on the background thread) is queued here and flushed on the main thread below.
        var deferredSceneActions = new System.Collections.Concurrent.ConcurrentQueue<Action>();
        sceneProxy.BeginDeferredMode(deferredSceneActions);

        Exception scriptLoadEx = null;
        var luaRef = _lua; // capture before thread so a restart can't swap _lua underneath
        var scriptThread = new Thread(() => {
            try   { luaRef.DoString(sanitized); }
            catch (Exception ex) { scriptLoadEx = ex; }
        });
        scriptThread.IsBackground = true;
        MainThreadOps = new System.Collections.Concurrent.ConcurrentQueue<MainThreadOp>();
        scriptThread.Start();

        // Coroutine pump loop: service main-thread ops from the background Lua thread.
        //
        // OLD approach: yield one Unity frame per drain pass → 1 op/frame → 16 ms/op at 60fps.
        // A script creating 600+ objects (9 terrain tiles × platforms × enemies × 4 calls each)
        // could take >10 s and hit the timeout.
        //
        // NEW approach: drain ops in a tight burst and yield to Unity only every ~16 ms.
        // This processes many ops per frame instead of one, so complex scenes load in 1-3 s.
        // The hard timeout is raised to 30 s to catch genuine infinite loops at script load time.
        const long FRAME_MS   = 16L;
        const long TIMEOUT_MS = 30_000L;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        long lastYieldMs = 0L;
        while (scriptThread.IsAlive)
        {
            DrainMainThreadOps();
            long nowMs = sw.ElapsedMilliseconds;
            if (nowMs > TIMEOUT_MS)
            {
                MainThreadOps = null;
                sceneProxy.EndDeferredMode();
                Debug.LogError("[LuauGameRunner] Script timed out (>30 s) — infinite loop or excessive object creation.");
                EnsureGameCamera();
                if (_previewMode)
                {
                    EnsureEditorCameraForPreview();
                    if (!IsStreamingPartialScript)
                        NotifyReact("_editorError", "Script timed out (>30 s). The code may contain an infinite loop.");
                }
                else
                {
                    NotifyReact("_gameMessage", "Script error: timed out (infinite loop?)");
                }
                yield break;
            }
            if (nowMs - lastYieldMs >= FRAME_MS)
            {
                yield return null; // yield to Unity ~60 fps so rendering/MCP stays live
                lastYieldMs = sw.ElapsedMilliseconds;
            }
        }
        DrainMainThreadOps(); // final drain after thread exits
        MainThreadOps = null;

        sceneProxy.EndDeferredMode();
        // Flush deferred Scene calls (SetSkybox, SetAmbientLight, etc.) on main thread.
        while (deferredSceneActions.TryDequeue(out var act)) act();

        try
        {
            if (scriptLoadEx != null) throw scriptLoadEx;
            _running = true;
            _gameProxy.FireStart();
            // Apply the creator's editor-session edits AFTER the script has
            // spawned objects but BEFORE the player is positioned, so a tweaked
            // spawn-point object's transform is the one that gets read. Apply
            // again at +1 s and +3 s so late-arriving Meshy GLB swaps inherit
            // their saved transforms / settings / logic. EditorState.Apply is
            // idempotent (missing objects skipped, present objects overwritten
            // with the same values), so re-runs are safe and cheap.
            if (!string.IsNullOrWhiteSpace(_pendingEditorStateJson) && _pendingEditorStateJson != "{}")
            {
                // One shared set so every object/terrain is restored exactly once
                // across the initial Apply and all the reconcile passes below — a
                // re-Apply must never overwrite an edit the user made after restore.
                var restoreOnce = new HashSet<string>(StringComparer.Ordinal);
                EditorState.Apply(this, _pendingEditorStateJson, restoreCamera: true, restoreOnce: restoreOnce);
                StartCoroutine(ReapplyEditorStateLater(_pendingEditorStateJson, restoreOnce));
            }
            else if (_previewMode)
            {
                // Nothing to restore — tell the editor its autosave gate can open
                // immediately so early edits aren't dropped waiting on a blind timer.
                NotifyReact("_editorRestoreComplete", "true");
            }
            // Only spawn player if the Luau script didn't call Player.SetSpawnPoint.
            if (_playerInstance == null)
                SpawnPlayer(playerSpawn != null ? playerSpawn.position : new Vector3(0, 3f, 0));
            // Creator-placed spawn markers (chibi tray item) win over the AI-authored
            // Player.SetSpawnPoint literal, same as Roblox SpawnLocations override a
            // script default. Markers are user-added objects (EditorPlacedObject),
            // so they materialize asynchronously via EditorState.Apply — wait for
            // them before deciding whether to override.
            StartCoroutine(ApplySpawnMarkerOverride(_pendingEditorStateJson));
            // In preview mode attach the orbital EditorCameraController; in play mode
            // just ensure the raw camera exists with correct clear flags.
            if (_previewMode) EnsureEditorCameraForPreview();
            else              EnsureGameCamera();
            if (!_previewMode)
            {
                // Editor-authored HUD (Interface Builder elements/workflows and
                // legacy HUD buttons). EditorState.Apply above restored them into
                // SceneSettings; publish them for the game HUD exactly as
                // GameRenderClient does for server sessions — without this, a
                // local play-test (Play from the editor) never showed them.
                NotifyReact("_hudButtons",          SceneSettings.HudButtonsJson ?? "");
                NotifyReact("_interfaceElements",   SceneSettings.InterfaceElementsJson ?? "");
                NotifyReact("_interfaceWorkflows",  SceneSettings.InterfaceWorkflowsJson ?? "");
                NotifyReact("_gameActive", "true");
            }
            // Custom Logic: fire each placed object's "On Game Start" workflows
            // now that the player and editor-state-restored objects both exist.
            // Never in preview — the editor shows the world, not running behavior.
            if (!_previewMode) RunGameStartWorkflows();
            // Two-phase spawn-point thumbnail. Camera state is recorded one frame after
            // OnStart so EnsureEditorCameraForPreview/EnsureGameCamera have settled, then:
            //   - placeholder capture at +3 s (early upload so My Games shows something)
            //   - final capture at +8 s (lets Meshy-loaded models render fully)
            // Both lock Camera.main back to the recorded spawn pose for capture, then restore.
            // id > 0 skips the build-preview placeholder.
            if (_activeGameId > 0)
                StartCoroutine(SpawnPointThumbnailFlow(_activeGameId));
            // Re-run one frame later: Luau OnStart/Timer callbacks may create cameras
            // after this frame, so we need to patch them too.
            StartCoroutine(DeferredCameraCheck());
        }
        catch (ScriptRuntimeException ex)
        {
            EnsureGameCamera();
            if (_previewMode)
            {
                Debug.LogWarning($"[LuauGameRunner] Preview script error (partial code): {ex.Message}");
                EnsureEditorCameraForPreview();
                if (IsStreamingPartialScript)
                    Debug.Log($"[LuauGameRunner] Streaming runtime error suppressed: {ex.Message}");
                else
                    NotifyReact("_editorError", $"Script error: {ex.Message}");
            }
            else
            {
                Debug.LogError($"[LuauGameRunner] Script error: {ex.DecoratedMessage}");
                NotifyReact("_gameMessage", $"Script error: {ex.Message}");
            }
        }
        catch (Exception ex)
        {
            EnsureGameCamera();
            if (_previewMode)
            {
                Debug.LogWarning($"[LuauGameRunner] Preview parse error (partial code): {ex.Message}");
                EnsureEditorCameraForPreview();
                if (IsStreamingPartialScript)
                    Debug.Log($"[LuauGameRunner] Streaming parse error suppressed: {ex.Message}");
                else
                    NotifyReact("_editorError", $"Preview error: {ex.Message}");
            }
            else
            {
                Debug.LogError($"[LuauGameRunner] Error: {ex.Message}");
                NotifyReact("_gameMessage", $"Error: {ex.Message}");
            }
        }
    }

    // ── Update ────────────────────────────────────────────────────────────────

    // World-fall threshold. If the player drops below this y, we teleport them
    // back to the most recent spawn point. Prevents the avatar from "falling off
    // the world" forever when the AI script forgets ground collision or the
    // spawn point is positioned outside the ground bounds.
    private const float FallThresholdY = -30f;

    private void Update()
    {
        if (!_running || _gameProxy == null) return;

        float dt = Time.deltaTime;

        // Fall-safety net: respawn at the last spawn point if the player has
        // dropped through the world. Cheap (one transform read per frame).
        if (_playerInstance != null && _playerInstance.transform.position.y < FallThresholdY)
        {
            Debug.LogWarning($"[LuauGameRunner] Player fell below {FallThresholdY} (was at {_playerInstance.transform.position.y:F1}).");
            RespawnPlayer("fell off");
        }

        if (_hasTimeLimit)
        {
            _timeElapsed += dt;
            float remaining = Mathf.Max(0f, _timeLimitSecs - _timeElapsed);
            NotifyReact("_gameTimer", Mathf.CeilToInt(remaining).ToString());
            if (remaining <= 0f)
            {
                _hasTimeLimit = false;
                RequestEndGame("Time's up!");
                return;
            }
        }

        // In editor/preview mode the scene must stay STATIC so the user can edit
        // it: run the script's OnStart once to build the world, but do NOT pump
        // the per-frame gameplay loop. Otherwise Game.OnUpdate keeps driving the
        // objects (moving/repositioning them) and overwrites the user's edits
        // frame-by-frame — which is exactly why terrain (untouched by the script)
        // persisted while move/scale/rotate/etc. did not. Real play (RunGame,
        // _previewMode=false) pumps it normally.
        if (!_previewMode)
        {
            try { _gameProxy.FireUpdate(dt); }
            catch (ScriptRuntimeException ex) { Debug.LogWarning($"[LuauGameRunner] Update: {ex.DecoratedMessage}"); }
        }
        try { _inputProxy?.CheckInput(); }
        catch (ScriptRuntimeException ex) { Debug.LogWarning($"[LuauGameRunner] Input: {ex.DecoratedMessage}"); }
    }

    // ── Public API called by proxy objects ────────────────────────────────────

    public void CallLua(DynValue fn, params DynValue[] args)
    {
        if (_lua == null || fn == null || fn.Type != DataType.Function) return;
        try { _lua.Call(fn, args); }
        catch (ScriptRuntimeException ex) { Debug.LogWarning($"[LuauGameRunner] Callback: {ex.DecoratedMessage}"); }
    }

    public void RequestSpawnPlayer(Vector3 pos)
    {
        // Reachable from PlayerProxy.SetSpawnPoint / PlayersLegacy.SpawnAt during
        // DoString on the bg thread. SpawnPlayer creates GameObjects + components,
        // which throw Internal_CreateGameObject off the main thread. Dispatch.
        RunOnMainThread<object>(() =>
        {
            _lastSpawnPos = pos;
            if (_playerInstance != null)
            {
                _playerInstance.transform.position = pos;
                // Zero velocity so a teleport from a falling state doesn't keep falling.
                var rb = _playerInstance.GetComponent<Rigidbody>();
                if (rb != null && !rb.isKinematic) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
            }
            else SpawnPlayer(pos);
            if (_previewMode) EditorCameraController.Instance?.SetSpawn(pos);
            return null;
        });
    }

    // Waits (bounded) for the editor-state overlay's added objects — including
    // any placed "player spawn" chibi markers — to finish spawning, then, if at
    // least one marker is present, teleports the player to a randomly-chosen
    // one and makes it the spawn used for fall-recovery/reset. No-op when the
    // creator hasn't placed any marker (existing Player.SetSpawnPoint behavior
    // is untouched). Multiple markers are supported so a game can offer several
    // spawn spots; single-player picks one at random on load.
    private IEnumerator ApplySpawnMarkerOverride(string pendingEditorStateJson)
    {
        float deadline = Time.realtimeSinceStartup + 5f;
        while (!EditorState.AddedAllPresent(this, pendingEditorStateJson) && Time.realtimeSinceStartup < deadline)
            yield return null;

        var markers = CollectSpawnMarkerPositions();
        if (markers.Count == 0) yield break;

        var pos = markers[UnityEngine.Random.Range(0, markers.Count)];
        _lastSpawnPos = pos;
        if (_playerInstance != null)
        {
            _playerInstance.transform.position = pos;
            var rb = _playerInstance.GetComponent<Rigidbody>();
            if (rb != null && !rb.isKinematic) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
        }
        if (_previewMode) EditorCameraController.Instance?.SetSpawn(pos);
    }

    private System.Collections.Generic.List<Vector3> CollectSpawnMarkerPositions()
    {
        var list = new System.Collections.Generic.List<Vector3>();
        if (gameRoot == null) return list;
        for (int i = 0; i < gameRoot.childCount; i++)
        {
            var child = gameRoot.GetChild(i);
            var marker = child.GetComponent<MeshyAssetMarker>();
            if (marker != null && marker.AssetId == GameAssetLoader.SpawnMarkerCacheKey)
                list.Add(child.position);
        }
        return list;
    }

    // Helper — every public method below is reachable from the DoString bg thread
    // via Lua proxy calls. RunOnMainThread short-circuits when already on the main
    // thread (callbacks, post-script main coroutine), so the wrap is a no-op there.
    private void MT(Action a) => RunOnMainThread<object>(() => { a(); return null; });
    private T MT<T>(Func<T> f) => RunOnMainThread(f);

    public void SetPlayerSpeed(float v) => MT(() =>
    {
        _speed = v;
        _playerInstance?.GetComponent<LuauPlayerController>()?.Init(v, _jumpHeight);
    });

    public void SetPlayerJumpHeight(float v) => MT(() =>
    {
        _jumpHeight = v;
        _playerInstance?.GetComponent<LuauPlayerController>()?.Init(_speed, v);
    });

    // Instantiates a pre-loaded Meshy GLB asset by id. Called by ObjectFactory.
    public GameObject SpawnAsset(string id, Transform parent)
    {
        if (_assetLoader == null) return null;
        return _assetLoader.Spawn(id, parent);
    }

    // Lazy-load + spawn an asset under the active gameRoot at a world position.
    // Used by the editor drag-and-drop placement bridge (GameLauncher's
    // editorPlaceAsset global). Safe to call repeatedly with the same cacheKey
    // — the loader dedupes the download.
    public void PlaceEditorAsset(string cacheKey, string modelUrl, bool isHumanoid, Vector3 worldPos, float sizeHint = 0f)
    {
        if (_assetLoader == null || gameRoot == null)
        {
            Debug.LogWarning("[LuauGameRunner] PlaceEditorAsset: no asset loader or game root.");
            return;
        }
        MT(() => StartCoroutine(PlaceEditorAssetCoroutine(cacheKey, modelUrl, isHumanoid, worldPos, sizeHint)));
    }

    private System.Collections.IEnumerator PlaceEditorAssetCoroutine(string cacheKey, string modelUrl, bool isHumanoid, Vector3 worldPos, float sizeHint = 0f)
    {
        yield return _assetLoader.EnsureLoaded(cacheKey, modelUrl, isHumanoid, sizeHint);
        var go = _assetLoader.Spawn(cacheKey, gameRoot);
        if (go == null)
        {
            Debug.LogWarning($"[LuauGameRunner] PlaceEditorAsset: spawn failed for '{cacheKey}'.");
            yield break;
        }
        go.transform.position = worldPos;
        GameAssetLoader.SnapToTerrainIfBelow(go);

        // Give the placement a stable unique name and tag it as a user-added
        // object so EditorState persists it and re-spawns it on Play / reload —
        // the Lua script doesn't create drag-placed assets.
        go.name = EditorState.UniqueAddedName(go.name, gameRoot);
        var marker = go.GetComponent<EditorPlacedObject>() ?? go.AddComponent<EditorPlacedObject>();
        marker.cacheKey = cacheKey; marker.modelUrl = modelUrl; marker.isHumanoid = isHumanoid;
        EditorCameraController.MarkStateDirty();

        // Auto-select the freshly-placed object so the user can immediately
        // move/delete it. Enters select mode in the camera controller (which
        // also reports `_selectedObject` and `_editorSelectMode` to React so
        // the EditorScreen flips its selectMode state).
        EditorCameraController.Instance?.SelectGameObject(go);
    }

    // Drag-to-place variant of PlaceEditorAsset. After the asset loads it is
    // selected AND move mode is entered immediately, so the same gesture that
    // dragged from the strip continues moving the object in world space.
    // touchId = -1 for mouse/pointer, >= 0 for the touch finger that is still down.
    public void PlaceEditorAssetForDrag(string cacheKey, string modelUrl, bool isHumanoid, Vector3 worldPos, int touchId, float sizeHint = 0f)
    {
        if (_assetLoader == null || gameRoot == null) return;
        MT(() => StartCoroutine(PlaceEditorAssetDragCoroutine(cacheKey, modelUrl, isHumanoid, worldPos, touchId, sizeHint)));
    }

    private System.Collections.IEnumerator PlaceEditorAssetDragCoroutine(
        string cacheKey, string modelUrl, bool isHumanoid, Vector3 worldPos, int touchId, float sizeHint = 0f)
    {
        yield return _assetLoader.EnsureLoaded(cacheKey, modelUrl, isHumanoid, sizeHint);
        var go = _assetLoader.Spawn(cacheKey, gameRoot);
        if (go == null) yield break;

        go.transform.position = worldPos;
        GameAssetLoader.SnapToTerrainIfBelow(go);
        go.name = EditorState.UniqueAddedName(go.name, gameRoot);
        var epo = go.GetComponent<EditorPlacedObject>() ?? go.AddComponent<EditorPlacedObject>();
        epo.cacheKey = cacheKey; epo.modelUrl = modelUrl; epo.isHumanoid = isHumanoid;
        EditorCameraController.MarkStateDirty();

        // Select then immediately enter the move-selected state so the finger
        // that's still down continues dragging the real asset.
        var controller = EditorCameraController.Instance;
        if (controller != null)
        {
            controller.SelectGameObject(go);
            controller.BeginMoveSelected(touchId);
        }
    }

    // Set of added-asset names currently being re-spawned by EditorState.Apply.
    // Apply runs up to 3× per load (immediate + delayed re-applies for late
    // Meshy swaps); without this guard each pass would queue another async spawn
    // before the first finished, producing duplicate copies. Cleared by TearDown.
    private readonly System.Collections.Generic.HashSet<string> _editorRespawnInFlight =
        new System.Collections.Generic.HashSet<string>(System.StringComparer.Ordinal);

    // Re-spawns a user-added asset (drag-placed, or a duplicate of one) that the
    // Lua script doesn't create. Called by EditorState.Apply after the script
    // runs. De-duped against both the live scene and in-flight spawns.
    public void RespawnEditorAsset(string name, string cacheKey, string modelUrl, bool isHumanoid,
        Vector3 pos, Vector3 rot, Vector3 scale, string settingsJson, string logicJson)
    {
        if (_assetLoader == null || gameRoot == null || string.IsNullOrEmpty(name)) return;
        // Slash-safe: placed-asset names embed the R2 cache key (contains '/'),
        // which Transform.Find would misinterpret as a child path. Scan direct
        // children by exact name so the "already in the scene" guard actually fires.
        if (EditorState.FindDirectChildByName(gameRoot, name) != null) return;  // already in the scene
        if (!_editorRespawnInFlight.Add(name)) return;      // a spawn is already running
        MT(() => StartCoroutine(RespawnEditorAssetCoroutine(
            name, cacheKey, modelUrl, isHumanoid, pos, rot, scale, settingsJson, logicJson)));
    }

    private System.Collections.IEnumerator RespawnEditorAssetCoroutine(
        string name, string cacheKey, string modelUrl, bool isHumanoid,
        Vector3 pos, Vector3 rot, Vector3 scale, string settingsJson, string logicJson)
    {
        yield return _assetLoader.EnsureLoaded(cacheKey, modelUrl, isHumanoid);
        var go = gameRoot != null ? _assetLoader.Spawn(cacheKey, gameRoot) : null;
        if (go == null) { _editorRespawnInFlight.Remove(name); yield break; }

        go.name = name;
        go.transform.localPosition    = pos;
        go.transform.localEulerAngles = rot;
        go.transform.localScale       = scale;
        var marker = go.GetComponent<EditorPlacedObject>() ?? go.AddComponent<EditorPlacedObject>();
        marker.cacheKey = cacheKey; marker.modelUrl = modelUrl; marker.isHumanoid = isHumanoid; marker.cloneOf = "";
        EditorState.ApplySettingsJson(go, settingsJson);
        EditorState.ApplyLogicJson(go, logicJson);
        GameAssetLoader.SnapToTerrainIfBelow(go);
        _editorRespawnInFlight.Remove(name);
    }

    // Background retry: when Object.Create("model:<id>") fires before the GLB
    // has finished loading, ObjectFactory returns a colored cube and calls this
    // hook. We poll the loader 3× at 2/4/6 s; on success we disable the cube's
    // visible mesh and parent the real GLB under it so the LuaObject handle the
    // script captured stays valid. On final failure the cube remains as-is.
    public void StartAssetSwapRetry(string assetId, GameObject placeholder)
    {
        if (placeholder == null) return;
        MT(() => StartCoroutine(AssetSwapRetryCoroutine(assetId, placeholder)));
    }

    private System.Collections.IEnumerator AssetSwapRetryCoroutine(string assetId, GameObject placeholder)
    {
        int[] backoffMs = { 2000, 4000, 6000 };
        for (int attempt = 1; attempt <= backoffMs.Length; attempt++)
        {
            yield return new WaitForSeconds(backoffMs[attempt - 1] / 1000f);
            if (placeholder == null) yield break; // Lua destroyed the object — give up
            if (_assetLoader == null) yield break;

            var real = _assetLoader.Spawn(assetId, placeholder.transform);
            if (real != null)
            {
                // Disable the placeholder's visible cube mesh but keep the
                // GameObject (and any colliders/transform) so existing LuaObject
                // calls keep targeting the same node.
                var ren = placeholder.GetComponent<Renderer>();
                if (ren != null) ren.enabled = false;

                // Re-snap to terrain — the cube placeholder's bounds were a 1m
                // unit cube, but the real GLB may be taller/shorter. Now that
                // the real renderers are live, recompute and lift if it's
                // clipping into the ground.
                GameAssetLoader.SnapToTerrainIfBelow(placeholder);

                Debug.Log($"[ObjectFactory] '{assetId}' — swapped in real GLB on retry attempt {attempt}");
                yield break;
            }
            Debug.LogWarning($"[ObjectFactory] '{assetId}' — retry attempt {attempt}/{backoffMs.Length} still not loaded");
        }
        Debug.LogError($"[ObjectFactory] '{assetId}' — all retry attempts failed; keeping placeholder cube");
    }

    public Vector3 GetPlayerPosition() => MT(() =>
        _playerInstance != null ? _playerInstance.transform.position : Vector3.zero);

    public float GetPlayerHealth() => _health;
    public void  SetPlayerHealth(float v) => MT(() =>
    {
        if (_playerInvincible && v < _health) return;
        float prev = _health;
        _health = Mathf.Clamp(v, 0f, 100f);
        NotifyReact("_gameHealth", _health.ToString("F0"));
        if (prev > 0f && _health <= 0f)
        {
            // Fire user's OnPlayerDied callback first so it can play sounds,
            // shake the screen, end the game, etc. After it returns, if the
            // game is still running and the script didn't restore HP, respawn.
            _gameProxy?.FirePlayerDied();
            if (_running && _health <= 0f) RespawnPlayer("died");
        }
    });
    public void SetPlayerInvincible(bool v) => _playerInvincible = v;

    // Teleport the player back to the most recent spawn point, zero velocity,
    // and refill HP. Shared by the death path (SetPlayerHealth → 0) and the
    // fall-safety path (Update → y < FallThresholdY).
    private void RespawnPlayer(string reason)
    {
        if (_playerInstance == null) return;
        _playerInstance.transform.position = _lastSpawnPos;
        var rb = _playerInstance.GetComponent<Rigidbody>();
        if (rb != null && !rb.isKinematic) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
        _health = 100f;
        NotifyReact("_gameHealth", "100");
        Debug.Log($"[LuauGameRunner] Respawned ({reason}) at {_lastSpawnPos}.");
    }

    public int  GetScore() => _score;
    public void RequestSetScore(int s)    => MT(() => { _score = s;  NotifyReact("_gameScore", _score.ToString()); });
    public void RequestAddScore(int d)    => MT(() => { _score += d; NotifyReact("_gameScore", _score.ToString()); });
    public void RequestShowMessage(string text, float dur)  => MT(() => StartCoroutine(MessageCoroutine("_gameMessage",  text, dur)));
    public void RequestShowTitle(string text, string sub, float dur) => MT(() => StartCoroutine(TitleCoroutine(text, sub, dur)));
    private bool _popupShown;   // set whenever a popup is explicitly requested

    public void RequestShowPopup(string title, string body, string btn) => MT(() =>
    {
        _popupShown = true;
        NotifyReact("_popupTitle", title);
        NotifyReact("_popupBody",  body);
        NotifyReact("_popupBtn",   btn);
    });
    public void RequestShowCountdown(float secs, DynValue cb) => MT(() => StartCoroutine(CountdownCoroutine(secs, cb)));
    public void RequestEndGame(string msg) => MT(() => { _running = false; StartCoroutine(EndGameCoroutine(msg)); });

    // Re-apply editor state at +1 s and +3 s after script start. This catches
    // Meshy GLB swaps (placeholder cube → real model) that happen on a delay —
    // the swap preserves the GameObject and its name, so re-applying restores
    // the saved transform/scale/rotation onto the newly-loaded model.
    private IEnumerator ReapplyEditorStateLater(string json, HashSet<string> restoreOnce)
    {
        // Snapshot the dirty rev NOW, before any reapply. EditorState.Apply and the
        // Lua script never bump it, so it stays constant through the whole restore
        // unless the USER edits — which is exactly the signal we use below to stop
        // clobbering. Captured up here (not after the first Apply) so an edit made
        // during the initial load window is still detected.
        int baselineRev = EditorCameraController.CurrentStateRev;

        // First reconcile pass restores everything, including the camera.
        yield return new WaitForSeconds(1f);
        if (!_running) yield break;
        if (EditorCameraController.CurrentStateRev != baselineRev)
        {
            // User already edited during the initial load — don't reapply over it.
            if (_previewMode) NotifyReact("_editorRestoreComplete", "true");
            yield break;
        }
        EditorState.Apply(this, json, restoreCamera: true, restoreOnce: restoreOnce);

        // Then keep reconciling until every placed asset is actually back in the
        // scene. Async GLB spawns (even from the disk cache) land on later frames,
        // so the old "+1s, +3s then stop" approach gave up while spawns were still
        // in flight — leaving placed models missing on reopen even though terrain
        // (which restores synchronously) always came back. Polling until present
        // makes added-object / object-edit restore as reliable as terrain. The
        // camera is NOT re-restored on these passes (it would fight the user
        // panning); the cap stops a permanently-failed asset looping forever.
        //
        // CRITICAL: stop reapplying the moment the user edits. EditorState.Apply
        // re-writes the LOAD-TIME transform/settings/logic onto every named object,
        // so a reapply pass that runs after the user has moved/rotated/scaled/etc.
        // an existing object silently REVERTS that edit (the autosave poll then
        // captures the reverted state and persists it — the edit never saves). A
        // freshly *added* object isn't in this snapshot so it survives, which is
        // exactly why "add saves but edit doesn't". Apply never bumps the dirty
        // rev, so any change to it during this loop is a genuine user edit → bail
        // out, leave their change intact, and signal the gate so the poll saves it.
        float deadline = Time.realtimeSinceStartup + 20f;
        while (_running && Time.realtimeSinceStartup < deadline)
        {
            if (EditorState.AddedAllPresent(this, json)) break;
            if (EditorCameraController.CurrentStateRev != baselineRev) break;   // user edited — stop clobbering
            yield return new WaitForSeconds(0.75f);
            if (EditorCameraController.CurrentStateRev != baselineRev) break;   // edited during the wait
            if (_running) EditorState.Apply(this, json, restoreOnce: restoreOnce);
        }
        // Restore has settled (all placed assets present, the user started editing,
        // or the cap elapsed) — let the editor open its autosave gate now instead of
        // after a fixed 6.8 s. No further reapply runs, so subsequent edits persist.
        if (_running && _previewMode) NotifyReact("_editorRestoreComplete", "true");
    }

    private IEnumerator EndGameCoroutine(string msg)
    {
        NotifyReact("_gameMessage", msg);
        // Wait long enough for any Timer.After callbacks (e.g. Timer.After(0.5, showPopup))
        // to have fired and called RequestShowPopup themselves.
        yield return new WaitForSeconds(2f);
        NotifyReact("_gameMessage", "");

        // If the script never called UI.ShowPopup, show a default so the player isn't stuck.
        if (!_popupShown)
        {
            bool win = msg.ToLowerInvariant().Contains("win") || msg.ToLowerInvariant().Contains("complete");
            string title = win ? "You Win!" : "Game Over";
            string body  = _score > 0 ? $"Score: {_score}" : "";
            NotifyReact("_popupTitle", title);
            NotifyReact("_popupBody",  body);
            NotifyReact("_popupBtn",   "Play Again");
        }
    }
    public void RequestScreenShake(float intensity, float dur) => MT(() => StartCoroutine(ShakeCoroutine(intensity, dur)));
    public void RequestFlash(Color col, float dur) => MT(() => StartCoroutine(FlashCoroutine(col, dur)));
    public void UpdateHUDValue(string key, DynValue val) => MT(() => NotifyReact("_hud_" + key, val.ToPrintString()));
    public void SetTimeLimit(float secs)  { _timeLimitSecs = secs; _timeElapsed = 0f; _hasTimeLimit = true; }
    public float GetTimeRemaining()       => _hasTimeLimit ? Mathf.Max(0f, _timeLimitSecs - _timeElapsed) : 0f;

    public void TeleportPlayer(float x, float y, float z) => MT(() =>
    {
        if (_playerInstance == null) return;
        _playerInstance.transform.position = new Vector3(x, y, z);
        var rb = _playerInstance.GetComponent<Rigidbody>();
        if (rb != null && !rb.isKinematic) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
    });

    public Vector3 GetPlayerVelocity() => MT(() =>
    {
        var pc = _playerInstance != null ? _playerInstance.GetComponent<LuauPlayerController>() : null;
        if (pc != null) return pc.Velocity;
        var rb = _playerInstance?.GetComponent<Rigidbody>();
        return rb != null ? rb.linearVelocity : Vector3.zero;
    });

    public bool GetPlayerGrounded() => MT(() =>
        _playerInstance?.GetComponent<LuauPlayerController>()?.IsGrounded ?? false);

    public void RestartGame() => MT(() =>
    {
        if (!string.IsNullOrEmpty(_lastPrompt)) StartCoroutine(ReloadCoroutine());
    });

    public void SpawnEffect(string preset, Vector3 pos) => MT(() => StartCoroutine(EffectCoroutine(preset, pos)));

    public int RegisterTimerAfter(float secs, DynValue cb) => MT(() =>
    {
        int id = _nextTimerId++;
        _timers[id] = StartCoroutine(TimerAfterCoroutine(id, secs, cb));
        return id;
    });

    public int RegisterTimerEvery(float secs, DynValue cb) => MT(() =>
    {
        int id = _nextTimerId++;
        _timers[id] = StartCoroutine(TimerEveryCoroutine(id, secs, cb));
        return id;
    });

    public void CancelTimer(int id) => MT(() =>
    {
        if (_timers.TryGetValue(id, out var co)) { StopCoroutine(co); _timers.Remove(id); }
    });

    // ── Avatar spawn ──────────────────────────────────────────────────────────

    private void SpawnPlayer(Vector3 pos)
    {
        if (_playerInstance != null) { Destroy(_playerInstance); _playerInstance = null; }

        _lastSpawnPos = pos;
        // Distinct name so GameRenderClient can sweep any preview leftovers when
        // entering server-authoritative play. Tag stays "Player" because other
        // gameplay code (camera follow, trigger zones) finds the player by tag.
        _playerInstance = new GameObject(_previewMode ? "LuauPreviewPlayer" : "LuauLocalPlayer");
        _playerInstance.transform.position = pos;
        _playerInstance.tag = "Player";

        // Physics capsule on the root — visual is a separate child
        // Kinematic: LuauPlayerController moves the player with the shared
        // RobloxCharacterMotor. The body stays so trigger volumes still fire.
        var rb = _playerInstance.AddComponent<Rigidbody>();
        rb.isKinematic            = true;
        rb.useGravity             = false;
        rb.constraints            = RigidbodyConstraints.FreezeRotation;
        var col = _playerInstance.AddComponent<CapsuleCollider>();
        col.center = new Vector3(0f, 1f, 0f);
        col.height = 2f;
        col.radius = 0.4f;

        // Chibi visual — returns placeholder pivot; DeferredAvatarScale corrects size next frame
        var pivotOffset = BuildChibiVisual(_playerInstance.transform);
        StartCoroutine(DeferredAvatarScale(_playerInstance.transform));
        if (!_previewMode) StartCoroutine(AttachAvatarItems(_playerInstance.transform));

        // Player controller — added after visual so Awake() can GetComponentInChildren<Animator>
        var ctrl = _playerInstance.AddComponent<LuauPlayerController>();
        ctrl.Init(_speed, _jumpHeight);

        var cam = EnsureGameCamera();
        if (cam.TryGetComponent<LuauOrbitCamera>(out var existingOrbit)) Destroy(existingOrbit);

        if (_previewMode)
        {
            // Hide player visual — editor shows the world, not the avatar.
            foreach (var r in _playerInstance.GetComponentsInChildren<Renderer>(true))
                r.enabled = false;

            // Attach editor camera controller above the spawn point.
            if (cam.TryGetComponent<LuauOrbitCamera>(out var oldOrbit)) Destroy(oldOrbit);
            var editorCam = cam.GetComponent<EditorCameraController>() ?? cam.gameObject.AddComponent<EditorCameraController>();
            if (_blankBaseplate) editorCam.InitBaseplateView(pos);
            else                 editorCam.Init(pos);
        }
        else
        {
            // Play mode: orbit camera follows the chibi avatar.
            var orbit = cam.gameObject.AddComponent<LuauOrbitCamera>();
            orbit.SetTarget(_playerInstance.transform);
            orbit.SetPivotOffset(pivotOffset);

            // Pass live renderers so the camera aims at the animated bounds center each frame.
            var chibiVisual = _playerInstance.transform.Find("ChibiVisual");
            if (chibiVisual != null)
                orbit.SetAvatarRenderers(chibiVisual.GetComponentsInChildren<Renderer>());
        }

        // Show mobile input overlay (suppressed in editor preview mode)
        if (!_previewMode) MobileGameInput.Instance?.SetVisible(true);

        // Subscribe to swipe gestures; register React Globals for HUD actions
        MobileGameInput.PauseRequested -= HandleMobilePause;
        MobileGameInput.PauseRequested += HandleMobilePause;
        var renderers = FindObjectsByType<ReactRendererUGUI>();
        foreach (var r in renderers)
        {
            // pauseGame is the tap-driven twin of the swipe-from-left gesture —
            // React's main-menu button calls it so the joystick hides while the
            // menu is up. Mirrors GameRenderClient's registration.
            r.Globals["pauseGame"]       = (Action)HandleMobilePause;
            r.Globals["resumeGame"]      = (Action)ResumeFromPause;
            r.Globals["resetPlayer"]     = (Action)ResetPlayerToSpawn;
            r.Globals["toggleShiftLock"] = (Action)ToggleShiftLockGlobal;
        }

        OnPlayerSpawned?.Invoke("local");
        Debug.Log("[LuauGameRunner] Player spawned with chibi avatar.");
    }

    // ── Custom Logic (workflow) execution ───────────────────────────────────────
    // Entry point only — the interpreter itself lives in WorkflowInterpreter.cs
    // (this class is `partial`) purely to keep this file's size sane. See that
    // file's header comment for exactly what's implemented vs. structurally
    // inert vs. impossible without new game systems.
    private void RunGameStartWorkflows()
    {
        if (GameRoot == null) return;
        var logics = GameRoot.GetComponentsInChildren<EditorObjectLogic>(true);
        foreach (var logic in logics)
        {
            if (logic == null || logic.Workflows == null) continue;
            foreach (var wf in logic.Workflows)
            {
                if (!wf.Enabled || wf.EventType != "gameStart") continue;
                var vars = BuildVariableMap(logic);
                if (!EvaluateGuards(wf.Guards, logic.gameObject, vars)) continue;
                StartCoroutine(RunWorkflowSteps(wf.Steps, logic.gameObject, vars));
            }
        }
    }

    private static readonly string[] BodyPartNames = { "torso", "head", "left-arm", "right-arm", "left-leg", "right-leg" };

    // Returns pivot offset (chibi visual centre relative to player root) for camera centering.
    private Vector3 BuildChibiVisual(Transform parent)
    {
        Color bodyCol = new Color(0.83f, 0.64f, 0.51f);
        var mgr = AvatarStateManager.Instance;
        if (mgr?.Avatar != null && !string.IsNullOrEmpty(mgr.Avatar.bodyColor))
            ColorUtility.TryParseHtmlString(mgr.Avatar.bodyColor, out bodyCol);

        var wrapper = new GameObject("ChibiVisual");
        wrapper.transform.SetParent(parent, false);
        wrapper.transform.localPosition = Vector3.zero;
        wrapper.transform.localRotation = Quaternion.identity;
        wrapper.transform.localScale    = Vector3.one;

        // Load all 6 body-part prefabs; fall back to chibi-base if any are missing.
        var prefabs = new GameObject[BodyPartNames.Length];
        bool allFound = true;
        for (int i = 0; i < BodyPartNames.Length; i++)
        {
            prefabs[i] = Resources.Load<GameObject>($"Avatar/{BodyPartNames[i]}");
            if (prefabs[i] != null) continue;
            allFound = false;
            break;
        }

        if (!allFound)
        {
            var basePrefab = Resources.Load<GameObject>("Avatar/chibi-base");
            if (basePrefab == null)
                return BuildPrimitiveFallbackVisual(wrapper.transform, bodyCol, parent.position);

            var baseGO = Instantiate(basePrefab, wrapper.transform);
            baseGO.transform.localPosition = Vector3.zero;
            baseGO.transform.localScale    = Vector3.one;
            foreach (var c in baseGO.GetComponentsInChildren<Collider>()) Destroy(c);
            _chibiTargetBones = new Dictionary<string, Transform>();
            foreach (var t in baseGO.GetComponentsInChildren<Transform>(true))
                if (!_chibiTargetBones.ContainsKey(t.name)) _chibiTargetBones[t.name] = t;
            var anim0 = baseGO.GetComponent<Animator>();
            if (anim0 != null) { anim0.enabled = false; anim0.applyRootMotion = false; }
            SetupPoseSource();
        }
        else
        {
            // ── Master skeleton (torso, 65 Mixamo bones) ─────────────────────
            var masterGO = Instantiate(prefabs[0], wrapper.transform);
            masterGO.name = "ChibiSkeleton";
            // The torso.fbx skeleton's Hips bone bind pose is offset ~0.302 in Z from
            // the FBX's own root, off-centering the mesh from the player's rotation
            // pivot (transform.rotation is set directly in gameplay) and making turns
            // look like a swing instead of a spin-in-place. Same fix as
            // GameRenderClient.BuildChibiVisual.
            masterGO.transform.localPosition = new Vector3(0f, 0f, -0.302f);
            masterGO.transform.localScale    = Vector3.one;
            foreach (var c in masterGO.GetComponentsInChildren<Collider>()) Destroy(c);

            var boneMap = new Dictionary<string, Transform>();
            foreach (var t in masterGO.GetComponentsInChildren<Transform>(true))
                if (!boneMap.ContainsKey(t.name)) boneMap[t.name] = t;

            // Save bone map for idle pose copying; disable chibi's own Animator.
            _chibiTargetBones = boneMap;
            var animator = masterGO.GetComponent<Animator>();
            if (animator != null) { animator.enabled = false; animator.applyRootMotion = false; }
            SetupPoseSource();

            // ── Retarget remaining 5 parts onto master skeleton ───────────────
            for (int i = 1; i < prefabs.Length; i++)
            {
                var partGO = Instantiate(prefabs[i]);
                partGO.transform.SetParent(wrapper.transform, false);
                partGO.transform.localPosition = Vector3.zero;

                foreach (var smr in partGO.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                {
                    var newBones = new Transform[smr.bones.Length];
                    for (int b = 0; b < smr.bones.Length; b++)
                        newBones[b] = smr.bones[b] != null && boneMap.TryGetValue(smr.bones[b].name, out var mb) ? mb : smr.bones[b];
                    smr.bones = newBones;

                    if (smr.rootBone != null && boneMap.TryGetValue(smr.rootBone.name, out var mr))
                        smr.rootBone = mr;

                    smr.transform.SetParent(wrapper.transform, false);
                    smr.transform.localPosition = Vector3.zero;
                }

                foreach (var c in partGO.GetComponentsInChildren<Collider>()) Destroy(c);
                Destroy(partGO);
            }
        }

        // ── Apply skin material ───────────────────────────────────────────────
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var skinMat = new Material(shader) { name = "PlayerSkinMat" };
        skinMat.SetColor("_BaseColor", bodyCol);
        skinMat.SetColor("_Color",     bodyCol);
        foreach (var r in wrapper.GetComponentsInChildren<Renderer>())
            if (r.enabled) r.material = skinMat;

        // SkinnedMeshRenderer.bounds are only populated after the skinning pass.
        // Force them to update every frame regardless of camera visibility so the
        // deferred coroutine can read valid world-space bounds on the next frame.
        foreach (var smr in wrapper.GetComponentsInChildren<SkinnedMeshRenderer>())
            smr.updateWhenOffscreen = true;

        // Scale and foot-alignment happen in DeferredAvatarScale (started by SpawnPlayer).
        return new Vector3(0f, 1f, 0f);
    }

    private Vector3 BuildPrimitiveFallbackVisual(Transform wrapperTr, Color bodyCol, Vector3 parentPos)
    {
        // Unity capsule default: 2 units tall (Y: -1 to +1), 1 unit diameter in local space.
        // Scale (0.45, 0.9, 0.45) → world height = 1.8, world width = 0.45.
        // Center at y=0.9 → body spans y=0 to y=1.8.
        var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        body.transform.SetParent(wrapperTr, false);
        body.transform.localPosition = new Vector3(0f, 0.9f, 0f);
        body.transform.localScale    = new Vector3(0.45f, 0.9f, 0.45f);
        foreach (var c in body.GetComponents<Collider>()) Destroy(c);
        ApplyColor(body, bodyCol);

        // Sphere diameter 0.4 → sits on top of body (y=1.8) with center at y=2.0.
        var head = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        head.transform.SetParent(wrapperTr, false);
        head.transform.localPosition = new Vector3(0f, 2.0f, 0f);
        head.transform.localScale    = Vector3.one * 0.4f;
        foreach (var c in head.GetComponents<Collider>()) Destroy(c);
        ApplyColor(head, bodyCol);

        return new Vector3(0f, 1.0f, 0f); // visual centre for orbit camera aim
    }

    // Measures SkinnedMeshRenderer world-space bounds AFTER the first skinning pass
    // (SkinnedMeshRenderer.bounds is zero at instantiation; updateWhenOffscreen = true
    // and one WaitForEndOfFrame guarantees at least one CPU skinning evaluation).
    private IEnumerator DeferredAvatarScale(Transform playerRoot)
    {
        var chibi = playerRoot.Find("ChibiVisual");
        if (chibi == null) yield break;

        float renderedH = 0f, lo = 0f;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            yield return new WaitForEndOfFrame();

            if (chibi == null) yield break;

            float minY = float.MaxValue, maxY = float.MinValue;
            foreach (var r in chibi.GetComponentsInChildren<Renderer>())
            {
                if (!r.enabled) continue;
                minY = Mathf.Min(minY, r.bounds.min.y);
                maxY = Mathf.Max(maxY, r.bounds.max.y);
            }
            if (minY >= float.MaxValue) continue;
            renderedH = maxY - minY;
            lo = minY;
            if (renderedH >= 0.001f) break;
        }

        if (renderedH < 0.001f)
        {
            Debug.LogWarning("[LuauGameRunner] Avatar bounds still zero after 5 frames — scale not applied.");
            yield break;
        }

        if (chibi == null) yield break;

        const float TargetH = 2f;
        float s = TargetH / renderedH;
        chibi.localScale = Vector3.one * s;

        // After scaling, the feet shift proportionally relative to the chibi origin.
        // Compute new foot world-Y analytically, then lift to align with the player root.
        float newLo = chibi.position.y + (lo - chibi.position.y) * s;
        if (newLo < playerRoot.position.y)
            chibi.position += Vector3.up * (playerRoot.position.y - newLo);

        Debug.Log($"[LuauGameRunner] Avatar scaled: renderedH={renderedH:F3} → scale={s:F3}");
    }

    // Small event forwarded from legacy PlayersLegacy proxy
    internal event Action<string> OnPlayerSpawned;

    // ── Avatar item attachment ─────────────────────────────────────────────────

    private static readonly Dictionary<string, string> SlotToBone = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Head"]    = "mixamorig:Head",
        ["Hair"]    = "mixamorig:Head",
        ["Face"]    = "mixamorig:Head",
        ["Neck"]    = "mixamorig:Neck",
        ["Front"]   = "mixamorig:Spine2",
        ["Back"]    = "mixamorig:Spine2",
        ["Waist"]   = "mixamorig:Hips",
        ["Tops"]    = "mixamorig:Spine1",
        ["Bottoms"] = "mixamorig:Hips",
        ["Shoes"]   = "mixamorig:LeftFoot",
    };

    private IEnumerator AttachAvatarItems(Transform playerRoot)
    {
        // Local-mode wrapper that uses this runner's chibi bones.
        yield return AttachAvatarItemsCoroutine(_chibiTargetBones);
    }

    // Public so the server-authoritative GameRenderClient can attach the same
    // equipped items to its own player chibi (different bones dictionary).
    // Reads AvatarStateManager.Instance.Avatar.equippedSlots — the same source
    // the avatar editor writes to — so the in-game player matches the editor.
    public static IEnumerator AttachAvatarItemsCoroutine(Dictionary<string, Transform> chibiBones)
    {
        yield return null; // wait for bones to populate

        var mgr = AvatarStateManager.Instance;
        if (mgr?.Avatar?.equippedSlots == null) yield break;
        if (chibiBones == null) yield break;

        foreach (var slotEntry in mgr.Avatar.equippedSlots)
        {
            if (slotEntry?.items == null) continue;
            foreach (var item in slotEntry.items)
            {
                if (item == null
                    || !"3d".Equals(item.dimensionality, StringComparison.OrdinalIgnoreCase)
                    || string.IsNullOrEmpty(item.modelUrl))
                    continue;

                if (!SlotToBone.TryGetValue(slotEntry.slot, out var boneName)) continue;
                if (!chibiBones.TryGetValue(boneName, out var bone) || bone == null)
                {
                    Debug.LogWarning($"[AvatarItems] Bone '{boneName}' not found for slot '{slotEntry.slot}'");
                    continue;
                }

                Debug.Log($"[AvatarItems] Loading '{item.name}' → bone '{boneName}'");
                using var req = UnityWebRequest.Get(item.modelUrl);
                req.downloadHandler = new DownloadHandlerBuffer();
                yield return req.SendWebRequest();

                if (req.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning($"[AvatarItems] Download failed for '{item.name}': {req.error}");
                    continue;
                }

                var bytes = req.downloadHandler.data;
                if (bytes == null || bytes.Length == 0) continue;

                var gltf     = new GltfImport();
                var loadTask = gltf.Load(bytes, new Uri(item.modelUrl));
                yield return new WaitUntil(() => loadTask.IsCompleted);
                if (!loadTask.Result) continue;

                var itemGo = new GameObject($"AvatarItem_{item.name}");
                itemGo.transform.SetParent(bone, false);
                var adj = item.adjustments;
                itemGo.transform.localPosition    = adj != null ? new Vector3(adj.offsetX, adj.offsetY, adj.offsetZ) : Vector3.zero;
                itemGo.transform.localEulerAngles = adj != null ? new Vector3(adj.rotX,    adj.rotY,    adj.rotZ)    : Vector3.zero;

                var instTask = gltf.InstantiateMainSceneAsync(itemGo.transform);
                yield return new WaitUntil(() => instTask.IsCompleted);

                float targetSize = (adj != null && adj.scale > 0.001f) ? 0.4f * adj.scale : 0.4f;
                NormalizeAvatarItemScale(itemGo, targetSize);

                // Mirror shoes to the right foot
                if (slotEntry.slot.Equals("Shoes", StringComparison.OrdinalIgnoreCase) &&
                    chibiBones.TryGetValue("mixamorig:RightFoot", out var rightFoot) && rightFoot != null)
                {
                    var mirror = Instantiate(itemGo, rightFoot);
                    mirror.transform.localPosition    = itemGo.transform.localPosition;
                    mirror.transform.localEulerAngles = itemGo.transform.localEulerAngles;
                    mirror.transform.localScale       = itemGo.transform.localScale;
                }

                Debug.Log($"[AvatarItems] Attached '{item.name}' to '{boneName}'");
            }
        }
    }

    private static void NormalizeAvatarItemScale(GameObject root, float targetSize)
    {
        Bounds b = default;
        bool first = true;
        foreach (var r in root.GetComponentsInChildren<Renderer>())
        {
            if (first) { b = r.bounds; first = false; }
            else b.Encapsulate(r.bounds);
        }
        if (first) return;
        float maxDim = Mathf.Max(b.size.x, b.size.y, b.size.z);
        if (maxDim < 0.001f) return;
        float s = targetSize / maxDim;
        for (int i = 0; i < root.transform.childCount; i++)
            root.transform.GetChild(i).localScale *= s;
    }

    private static void ApplyColor(GameObject go, Color col)
    {
        var ren = go.GetComponent<Renderer>();
        if (!ren) return;
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var mat = new Material(shader);
        mat.SetColor("_BaseColor", col); // URP Lit
        mat.SetColor("_Color",     col); // Standard fallback
        ren.material = mat;
    }

    // Invisible large box collider that acts as an absolute backstop against
    // the player falling through the world if terrain has gaps or the Meshy
    // terrain model loads late. Always present in both preview and play mode.
    private void EnsureSafetyFloor()
    {
        if (gameRoot == null)
        {
            var go = new GameObject("LuauGameRoot");
            gameRoot = go.transform;
        }

        // Idempotent — LoadAssetsAndRun calls this before LoadAssets so the
        // safety net is in place during the asset-load window, and RunScript
        // calls it again after the script is ready. Second call must not stack
        // duplicate colliders.
        if (gameRoot.Find("_SafetyFloor") != null) return;

        var floor = new GameObject("_SafetyFloor");
        floor.transform.SetParent(gameRoot, false);
        // Sits below FallThresholdY so the Update respawn fires first; this
        // collider is just a hard backstop for the rare case of teleport racing.
        floor.transform.localPosition = new Vector3(0f, -50f, 0f);
        var bc = floor.AddComponent<BoxCollider>();
        bc.size = new Vector3(4000f, 1f, 4000f);
        // No Renderer attached → invisible. Player capsule still collides.
    }

    // Creates a visible neutral-grey ground plane as a baseline when Meshy terrain
    // hasn't loaded yet (or the game has no terrain asset). The Lua script can later
    // replace or hide it via Object.Create / Object.Destroy.
    private void EnsureFallbackGround()
    {
        if (gameRoot == null) return;

        var existing = gameRoot.Find("_FallbackGround");
        if (existing != null) return; // already present (e.g. restart)

        var go = GameObject.CreatePrimitive(PrimitiveType.Plane);
        go.name = "_FallbackGround";
        go.transform.SetParent(gameRoot, false);
        go.transform.localPosition = Vector3.zero;
        // Sized to fully cover the 80×80 play area with overlap on every side
        // (Plane primitive is 10×10 base, so localScale=20 → 200×200 m). When
        // a Meshy terrain GLB does load, the script's tile grid renders on top.
        go.transform.localScale    = new Vector3(20f, 1f, 20f); // 200×200 m

        var renderer = go.GetComponent<Renderer>();
        if (renderer != null)
        {
            var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            var mat    = new Material(shader);
            var grey = new Color(0.35f, 0.37f, 0.40f);
            mat.SetColor("_BaseColor", grey); // URP/Lit
            mat.SetColor("_Color",     grey); // built-in RP fallback
            renderer.material = mat;
        }
    }

    // ── Thumbnail capture ─────────────────────────────────────────────────────
    //
    // Two-phase pipeline that captures the spawn-point view (the same view the
    // player sees when first loading the game):
    //   1. Record Camera.main pose one frame after OnStart fires.
    //   2. After +3 s, lock the camera back to that pose, render once, blank-detect,
    //      upload as the placeholder thumbnail.
    //   3. After +8 s (≈ +5 s after placeholder), repeat the capture and upload as
    //      the final thumbnail. This second pass picks up Meshy-loaded models that
    //      may not have rendered yet at +3 s.
    // Camera position/rotation/FOV are restored after each capture so editor orbit
    // and play-mode follow camera continue working normally.

    [Serializable]
    private class ThumbnailPayload { public string imageBase64; public bool isFinal; }

    // Output dimensions: 512×288 = 16:9 landscape. UI displays squares but the source
    // is 16:9 so cropping in CSS gives a clean centered fit on either layout.
    private const int  THUMB_W = 512;
    private const int  THUMB_H = 288;
    private const float PLACEHOLDER_DELAY = 3f;  // seconds after OnStart
    private const float FINAL_DELAY       = 8f;  // seconds after OnStart

    private IEnumerator SpawnPointThumbnailFlow(int gameId)
    {
        // Wait one frame so EnsureEditorCameraForPreview / EnsureGameCamera have applied
        // their initial transforms (the spawn camera pose). Then snapshot.
        yield return null;
        if (!_running) yield break;
        RecordSpawnCameraState();
        if (!_spawnCameraState.recorded) yield break;

        // Phase 1: placeholder at +3 s (one frame already elapsed → wait the rest).
        yield return new WaitForSeconds(PLACEHOLDER_DELAY);
        if (!_running || _activeGameId != gameId) yield break;
        yield return CaptureAndUpload(gameId, isFinal: false, allowRetry: true);

        // Phase 2: final capture at +8 s — gives Meshy-loaded models time to render.
        // We also wait for GameAssetLoader.IsLoadingComplete so play-paths that load
        // assets after OnStart still wait until everything is in.
        var elapsed = 0f;
        while (elapsed < (FINAL_DELAY - PLACEHOLDER_DELAY))
        {
            yield return null;
            elapsed += Time.unscaledDeltaTime;
            if (!_running || _activeGameId != gameId) yield break;
        }
        if (_assetLoader != null)
        {
            // Cap the extra wait at 10 s so a stuck GLTFast load can't hold the final forever.
            float assetWait = 0f;
            while (!_assetLoader.IsLoadingComplete && assetWait < 10f)
            {
                yield return null;
                assetWait += Time.unscaledDeltaTime;
            }
        }
        if (!_running || _activeGameId != gameId) yield break;
        yield return CaptureAndUpload(gameId, isFinal: true, allowRetry: true);
    }

    private void RecordSpawnCameraState()
    {
        var cam = Camera.main;
        if (cam == null) return;
        _spawnCameraState = new SpawnCameraState
        {
            position    = cam.transform.position,
            rotation    = cam.transform.rotation,
            fieldOfView = cam.fieldOfView,
            recorded    = true,
        };
        Debug.Log($"[LuauGameRunner] Spawn camera state recorded: pos={_spawnCameraState.position} " +
                  $"rot={_spawnCameraState.rotation.eulerAngles} fov={_spawnCameraState.fieldOfView:F1} " +
                  $"spawn={_lastSpawnPos} game={_activeGameId} preview={_previewMode}");
    }

    // Locks Camera.main back to the recorded spawn pose, renders one frame to a 512×288
    // RT, blank-detects, optionally retries once, encodes JPEG, restores the camera, and
    // uploads. Returns when upload completes or capture is abandoned.
    private IEnumerator CaptureAndUpload(int gameId, bool isFinal, bool allowRetry)
    {
        var cam = Camera.main;
        if (cam == null || !_spawnCameraState.recorded) yield break;

        // Snapshot original pose + freeze any controller that drives the camera during capture.
        var origPos    = cam.transform.position;
        var origRot    = cam.transform.rotation;
        var origFov    = cam.fieldOfView;
        var origTarget = cam.targetTexture;

        var editorCtrl = cam.GetComponent<EditorCameraController>();
        bool editorWasEnabled = editorCtrl != null && editorCtrl.enabled;
        if (editorCtrl != null) editorCtrl.enabled = false;

        var orbitCtrl = cam.GetComponent<LuauOrbitCamera>();
        bool orbitWasEnabled = orbitCtrl != null && orbitCtrl.enabled;
        if (orbitCtrl != null) orbitCtrl.enabled = false;

        // Apply the recorded spawn pose for the capture.
        cam.transform.position = _spawnCameraState.position;
        cam.transform.rotation = _spawnCameraState.rotation;
        cam.fieldOfView        = _spawnCameraState.fieldOfView;

        var rt = new RenderTexture(THUMB_W, THUMB_H, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;
        // One frame so URP/lights/post-processing all get a tick at the new pose before Render.
        yield return new WaitForEndOfFrame();
        cam.Render();

        var prevActive = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(THUMB_W, THUMB_H, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, THUMB_W, THUMB_H), 0, 0);
        tex.Apply();
        RenderTexture.active = prevActive;

        bool blank = IsBlankImage(tex);

        // Always restore camera before yielding for upload so the user's view isn't held hostage.
        cam.targetTexture      = origTarget;
        cam.transform.position = origPos;
        cam.transform.rotation = origRot;
        cam.fieldOfView        = origFov;
        if (editorCtrl != null) editorCtrl.enabled = editorWasEnabled;
        if (orbitCtrl  != null) orbitCtrl.enabled  = orbitWasEnabled;
        rt.Release();
        Destroy(rt);

        if (blank)
        {
            Destroy(tex);
            Debug.LogWarning($"[LuauGameRunner] Thumbnail capture blank (gameId={gameId} isFinal={isFinal} " +
                             $"retry={allowRetry})");
            if (allowRetry)
            {
                yield return new WaitForSeconds(3f);
                if (_running && _activeGameId == gameId)
                    yield return CaptureAndUpload(gameId, isFinal, allowRetry: false);
            }
            yield break;
        }

        var jpg = tex.EncodeToJPG(80);
        Destroy(tex);
        var b64 = System.Convert.ToBase64String(jpg);
        yield return UploadThumbnail(gameId, b64, isFinal);
    }

    // Samples 20 evenly-spaced pixels and returns true when ≥ 90 % of them match the
    // first sample within a small color tolerance. Catches solid-fill captures (camera
    // pointed at a skybox edge, scene not yet rendered, RT not yet bound, etc.).
    private static bool IsBlankImage(Texture2D texture)
    {
        var pixels = texture.GetPixels();
        if (pixels.Length == 0) return true;

        var first = pixels[0];
        int step  = Mathf.Max(1, pixels.Length / 20);
        int matchCount = 0;
        int sampleCount = 0;
        for (int i = 0; i < pixels.Length; i += step)
        {
            sampleCount++;
            float mag = Mathf.Abs(pixels[i].r - first.r) +
                        Mathf.Abs(pixels[i].g - first.g) +
                        Mathf.Abs(pixels[i].b - first.b);
            if (mag < 0.05f) matchCount++;
        }
        // Treat ≥ 90 % flat as blank. With 20 samples the threshold is 18.
        return sampleCount > 0 && matchCount * 10 >= sampleCount * 9;
    }

    private IEnumerator UploadThumbnail(int gameId, string b64, bool isFinal)
    {
        var payload = JsonUtility.ToJson(new ThumbnailPayload { imageBase64 = b64, isFinal = isFinal });
        var url     = $"{PludoApiClient.BaseUrl}/api/game/{gameId}/thumbnail";
        using var req = new UnityWebRequest(url, "POST");
        req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(payload));
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "application/json");
        // Forward the user's JWT so the server can satisfy the forge_games UPDATE
        // RLS policy (created_by_user_id = auth.uid()) when patching thumbnail_url.
        // Without this the PATCH silently affects 0 rows and the URL is never persisted.
        var token = PludoServices.Auth?.GetAccessToken();
        if (!string.IsNullOrEmpty(token))
            req.SetRequestHeader("Authorization", $"Bearer {token}");
        yield return req.SendWebRequest();
        var phase = isFinal ? "final" : "placeholder";
        if (req.result == UnityWebRequest.Result.Success)
            Debug.Log($"[LuauGameRunner] Thumbnail ({phase}) uploaded for game {gameId}");
        else
            Debug.LogWarning($"[LuauGameRunner] Thumbnail ({phase}) upload failed for game {gameId}: {req.error}");
    }

    // Attaches EditorCameraController to Camera.main in preview mode (called on both success
    // and error paths). Without it the camera is frozen and the scene renders black.
    private void EnsureEditorCameraForPreview()
    {
        var cam = EnsureGameCamera();
        if (cam.GetComponent<EditorCameraController>() != null) return;
        var edCam = cam.gameObject.AddComponent<EditorCameraController>();
        Vector3 pos = playerSpawn != null ? playerSpawn.position : new Vector3(0f, 3f, 0f);
        edCam.Init(pos);
    }

    private static Camera EnsureGameCamera()
    {
        var cam = Camera.main;

        if (cam == null)
        {
            var go = new GameObject("MainCamera");
            go.tag = "MainCamera";
            cam = go.AddComponent<Camera>();
            cam.transform.position = new Vector3(0f, 10f, -20f);
            cam.transform.rotation = Quaternion.Euler(15f, 0f, 0f);
        }

        // Only use SolidColor when no skybox is active. If EnvironmentManager has already
        // applied a skybox material, preserve Skybox clear flags so the sky renders.
        // (SolidColor was previously forced here, which caused black sky every game.)
        if (RenderSettings.skybox == null)
        {
            cam.clearFlags      = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.08f, 0.08f, 0.12f);
        }
        else
        {
            cam.clearFlags = CameraClearFlags.Skybox;
        }

        // A zero culling mask renders nothing
        if (cam.cullingMask == 0)
            cam.cullingMask = ~0;

        // URP requires this component or the camera outputs solid white
        if (cam.GetComponent<UniversalAdditionalCameraData>() == null)
            cam.gameObject.AddComponent<UniversalAdditionalCameraData>();

        Debug.Log($"[LuauGameRunner] Camera: {cam.name} | ClearFlags: {cam.clearFlags} | CullingMask: {cam.cullingMask} | URP: true");
        return cam;
    }

    // ── Coroutines ─────────────────────────────────────────────────────────────

    // Runs one frame after game start to patch any camera the Luau script created
    // inside an OnStart / Timer callback (which execute after EnsureGameCamera).
    private IEnumerator DeferredCameraCheck()
    {
        yield return null;
        if (_previewMode) EnsureEditorCameraForPreview();
        else              EnsureGameCamera();

        // Disable any extra active cameras that aren't the MainCamera or AvatarPreview
        // (depth -10). An untouched extra camera with Skybox clear flags renders white.
        foreach (var cam in Camera.allCameras)
        {
            if (cam == Camera.main) continue;
            if (cam.depth == -10)   continue; // AvatarPreviewCamera — leave it alone
            // Extra camera: force SolidColor + dark so it never shows white if enabled
            cam.clearFlags      = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.08f, 0.08f, 0.12f);
            cam.enabled         = false; // disable unknown cameras entirely
        }
    }

    private IEnumerator MessageCoroutine(string key, string text, float dur)
    {
        NotifyReact(key, text);
        yield return new WaitForSeconds(dur);
        NotifyReact(key, "");
    }

    private IEnumerator TitleCoroutine(string title, string subtitle, float dur)
    {
        NotifyReact("_gameTitle",    title);
        NotifyReact("_gameSubtitle", subtitle);
        yield return new WaitForSeconds(dur);
        NotifyReact("_gameTitle",    "");
        NotifyReact("_gameSubtitle", "");
    }

    private IEnumerator CountdownCoroutine(float secs, DynValue cb)
    {
        for (int i = (int)secs; i > 0; i--)
        {
            NotifyReact("_gameMessage", i.ToString());
            yield return new WaitForSeconds(1f);
        }
        NotifyReact("_gameMessage", "");
        if (_running) CallLua(cb);
    }

    private IEnumerator ShakeCoroutine(float intensity, float dur)
    {
        var shakeCam = Camera.main;
        if (shakeCam == null) yield break;
        var orig = shakeCam.transform.localPosition;
        float t = 0f;
        while (t < dur)
        {
            t += Time.deltaTime;
            shakeCam.transform.localPosition = orig + UnityEngine.Random.insideUnitSphere * intensity * 0.12f;
            yield return null;
        }
        shakeCam.transform.localPosition = orig;
    }

    private IEnumerator FlashCoroutine(Color col, float dur)
    {
        NotifyReact("_flashColor", "#" + ColorUtility.ToHtmlStringRGB(col));
        yield return new WaitForSeconds(dur);
        NotifyReact("_flashColor", "");
    }

    private IEnumerator EffectCoroutine(string preset, Vector3 pos)
    {
        Color col = preset switch
        {
            "explosion"    => new Color(1f, 0.5f, 0f),
            "sparkle" or "collect_burst" => new Color(1f, 0.95f, 0.2f),
            "confetti"     => new Color(0.3f, 1f, 0.5f),
            "fire"         => new Color(1f, 0.3f, 0f),
            "portal"       => new Color(0.5f, 0.2f, 1f),
            _              => Color.white,
        };
        var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        go.transform.position = pos;
        go.transform.localScale = Vector3.one * 0.1f;
        var ren = go.GetComponent<Renderer>();
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var mat = new Material(shader);
        mat.SetColor("_BaseColor",     col);     // URP Lit
        mat.SetColor("_Color",         col);     // Standard fallback
        mat.EnableKeyword("_EMISSION");
        mat.SetColor("_EmissionColor", col * 3f);
        ren.material = mat;
        foreach (var c in go.GetComponents<Collider>()) Destroy(c);

        float t = 0f;
        while (t < 0.45f)
        {
            t += Time.deltaTime;
            float s = Mathf.Lerp(0.1f, 2f, t / 0.45f);
            if (go != null) go.transform.localScale = Vector3.one * s;
            yield return null;
        }
        if (go != null) Destroy(go);
    }

    private IEnumerator TimerAfterCoroutine(int id, float secs, DynValue cb)
    {
        yield return new WaitForSeconds(secs);
        _timers.Remove(id);
        CallLua(cb); // always fire — one-shot timers committed before Game.End() must still execute
    }

    private IEnumerator TimerEveryCoroutine(int id, float secs, DynValue cb)
    {
        while (_running && _timers.ContainsKey(id))
        {
            yield return new WaitForSeconds(secs);
            if (!_running || !_timers.ContainsKey(id)) break;
            // Don't pump repeating (gameplay) timers in the editor — like
            // Game.OnUpdate they continuously drive objects and would overwrite
            // the user's edits. They resume on real play. One-shot Timer.After
            // (scene setup) still fires.
            if (!_previewMode) CallLua(cb);
        }
    }

    private IEnumerator ReloadCoroutine()
    {
        yield return null; // let current frame finish
        // Re-run through the full asset pipeline so 3D models are reloaded on restart.
        yield return LoadAssetsAndRun(_lastAssetUrlsJson, _lastScript ?? "", _lastHumanoidIdsJson);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void NotifyReact(string key, string value) => RunOnMainThread<object>(() =>
    {
        var renderers = FindObjectsByType<ReactRendererUGUI>();
        foreach (var r in renderers) r.Globals[key] = value;
        return null;
    });

    // Instantiates idle.fbx as a hidden pose source (its bone hierarchy matches its own
    // animation curves), loads each AnimationClip, and samples them directly each LateUpdate
    // via PoseSampler (a manual PlayableGraph — SampleAnimation is Editor-only for these clips).
    private void SetupPoseSource()
    {
        if (_poseSrc != null) { Destroy(_poseSrc); _poseSrc = null; }
        _animClips.Clear();
        _animNormTimes.Clear();
        _animClipLoops.Clear();
        _currentAnimState = "";
        _animPlayTime     = 0f;

        var idlePrefab = Resources.Load<GameObject>("Avatar/idle");
        if (idlePrefab == null) { Debug.LogWarning("[LuauGameRunner] Avatar/idle not found"); return; }

        _poseSrc = Instantiate(idlePrefab);
        _poseSrc.name = "PoseAnimSource";
        _poseSrc.transform.position = new Vector3(0f, -9000f, 0f);
        foreach (var r in _poseSrc.GetComponentsInChildren<Renderer>(true))
            r.enabled = false;
        // Disable any Animator — PoseSampler re-enables the root one as the graph's only driver.
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
            if (loaded.Length == 0) { Debug.LogWarning($"[LuauGameRunner] Clip not found: {path}"); continue; }
            _animClips[state]     = loaded[0];
            _animClipLoops[state] = loop;
        }

        SwitchAnim("idle");
    }

    private void SwitchAnim(string state)
    {
        if (_currentAnimState == state) return;
        if (!_animClips.ContainsKey(state)) return;

        if (!string.IsNullOrEmpty(_currentAnimState))
            _animNormTimes[_currentAnimState] = _animPlayTime;

        _currentAnimState = state;
        bool loops = _animClipLoops.TryGetValue(state, out var l) && l;
        // Non-looping states (jump-up, jump-down) always restart from 0.
        _animPlayTime = (loops && _animNormTimes.TryGetValue(state, out var saved)) ? saved : 0f;
    }

    private void LateUpdate()
    {
        if (_poseSrc == null || _poseSourceBones == null || _chibiTargetBones == null) return;

        // Choose animation based on player physics state.
        if (_playerInstance != null)
        {
            var pc = _playerInstance.GetComponent<LuauPlayerController>();
            if (pc != null)
            {
                var   v      = pc.Velocity;
                float vy     = v.y;
                float hSpeed = new Vector2(v.x, v.z).magnitude;
                // The motor's grounded flag is exact (sphere-swept floor), so
                // animation follows it directly instead of guessing from vy.
                bool  inAir  = !pc.IsGrounded;

                string next;
                if (inAir)
                {
                    next = vy > 0f ? "jumping-up" : "jumping-down";
                }
                else
                {
                    // Hysteresis: use lower exit threshold when already in a state to
                    // prevent rapid oscillation at the boundary speed.
                    float runThresh  = _currentAnimState == "running"  ? 2.5f : 3.5f;
                    float walkThresh = _currentAnimState == "walking"  ? 0.2f : 0.5f;
                    next = hSpeed > runThresh  ? "running"
                         : hSpeed > walkThresh ? "walking"
                         : "idle";
                }
                SwitchAnim(next);
            }
        }

        // Sample the current animation clip directly onto the pose-source transforms.
        // PoseSampler.Sample(clip, go, time) writes bone transforms immediately, on device too.
        if (_poseSrc != null && !string.IsNullOrEmpty(_currentAnimState)
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
        // while torso.fbx places bones under an Armature node with its own rotation.
        // Multiply by playerRootRot so the avatar faces the direction the player is moving.
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
    }

    private void TearDown()
    {
        if (_poseSrc != null) { Destroy(_poseSrc); _poseSrc = null; }
        _poseSourceBones = null;
        _chibiTargetBones = null;
        _animClips.Clear();
        _animNormTimes.Clear();
        _animClipLoops.Clear();
        _currentAnimState = "";
        _animPlayTime     = 0f;

        _running    = false;
        _lua        = null;
        _score      = 0;
        _health     = 100f;
        _popupShown = false;
        _hasTimeLimit = false;
        NotifyReact("_popupTitle", "");
        NotifyReact("_popupBody",  "");
        NotifyReact("_popupBtn",   "");

        // Silence any lingering SFX tail and looping music started by the Lua script.
        GameAudio.StopAll();

        // Drop the spawn-camera snapshot so the next session re-records its own pose
        // rather than re-using the previous game's view.
        _spawnCameraState = default;

        if (_assetLoader != null) { Destroy(_assetLoader); _assetLoader = null; }

        foreach (var co in _timers.Values) if (co != null) StopCoroutine(co);
        _timers.Clear();

        // Editor-state session scratch: in-flight added-asset re-spawns belong to
        // the session being torn down, and the deleted-name set must start empty
        // so it can't leak into the next game (Apply re-seeds it from the
        // snapshot once the new script runs).
        _editorRespawnInFlight.Clear();
        EditorState.DeletedNames.Clear();
        EditorState.DeletionsApplied = false;

        if (_playerInstance != null) { Destroy(_playerInstance); _playerInstance = null; }
        if (Camera.main != null)
        {
            if (Camera.main.TryGetComponent<LuauOrbitCamera>(out var orbit)) Destroy(orbit);
            if (Camera.main.TryGetComponent<EditorCameraController>(out var edCam)) Destroy(edCam);
            // Reset clear flags so the HDRI skybox from the last session isn't visible
            // between TearDown and the next EnsureGameCamera call (causes grass flash in editor).
            Camera.main.clearFlags      = CameraClearFlags.SolidColor;
            Camera.main.backgroundColor = new Color(0.08f, 0.08f, 0.12f);
        }
        RenderSettings.skybox = null;
        DynamicGI.UpdateEnvironment();
        MobileGameInput.Instance?.SetVisible(false);
        MobileGameInput.PauseRequested -= HandleMobilePause;

        if (gameRoot != null)
            for (int i = gameRoot.childCount - 1; i >= 0; i--)
                Destroy(gameRoot.GetChild(i).gameObject);

        Resources.UnloadUnusedAssets();
        GC.Collect();
    }

    private void HandleMobilePause()
    {
        // Hide the joystick while the menu is up so the player can't walk off
        // behind the pause dim. ResumeFromPause puts it back.
        MobileGameInput.Instance?.SetVisible(false);
        NotifyReact("_showEscape", "true");
    }

    public void ResumeFromPause()
    {
        MobileGameInput.Instance?.SetVisible(true);
        NotifyReact("_showEscape", "");
    }

    public void ResetPlayerToSpawn()
    {
        if (_playerInstance == null) return;
        var pos = playerSpawn != null ? playerSpawn.position : new Vector3(0f, 3f, 0f);
        _playerInstance.transform.position = pos;
        var rb = _playerInstance.GetComponent<Rigidbody>();
        if (rb != null && !rb.isKinematic) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
    }

    private void ToggleShiftLockGlobal()
    {
        LuauOrbitCamera.ToggleShiftLock();
        NotifyReact("_shiftLock", LuauOrbitCamera.ShiftLock ? "true" : "");
    }

    public void ExitGame() { _previewMode = false; NotifyReact("_gameActive", ""); TearDown(); Debug.Log("[LuauGameRunner] Session ended."); }
}

// ── Legacy shims — keep scripts from old prompt working ───────────────────────

[MoonSharpUserData]
public class WorkspaceLegacy
{
    private readonly Transform _root;
    private readonly LuauGameRunner _runner;
    private readonly Dictionary<string, GameObject> _parts = new();
    private int _n;

    public WorkspaceLegacy(Transform root, LuauGameRunner runner) { _root = root; _runner = runner; }

    // All Unity calls below are dispatched to the main thread. This proxy is
    // normally shadowed by `local workspace=__ns()` in the preamble, but a
    // script that bypasses the local (e.g. `_G.workspace`) would otherwise hit
    // CreatePrimitive on the bg DoString thread.
    public string CreatePart(Table opts) => _runner.RunOnMainThread(() =>
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.transform.SetParent(_root, false);
        go.transform.localPosition = Vec3(opts, "position", 0, 0, 0);
        go.transform.localScale    = Vec3(opts, "size", 1, 1, 1);
        var rb = go.GetComponent<Rigidbody>(); if (rb) rb.isKinematic = true;
        var id = $"part_{_n++}"; _parts[id] = go; return id;
    });

    public string CreateSphere(Table opts) => _runner.RunOnMainThread(() =>
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        go.transform.SetParent(_root, false);
        go.transform.localPosition = Vec3(opts, "position", 0, 0, 0);
        float r = Flt(opts, "radius", 0.5f); go.transform.localScale = Vector3.one * r * 2f;
        var id = $"sphere_{_n++}"; _parts[id] = go; return id;
    });

    public string CreateCylinder(Table opts) => _runner.RunOnMainThread(() =>
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
        go.transform.SetParent(_root, false);
        go.transform.localPosition = Vec3(opts, "position", 0, 0, 0);
        var id = $"cyl_{_n++}"; _parts[id] = go; return id;
    });

    public void SetPosition(string id, Table pos) => _runner.RunOnMainThread<object>(() =>
    { if (_parts.TryGetValue(id, out var g)) g.transform.localPosition = Vec3f(pos); return null; });

    public void Destroy(string id) => _runner.RunOnMainThread<object>(() =>
    { if (_parts.TryGetValue(id, out var g)) { UnityEngine.Object.Destroy(g); _parts.Remove(id); } return null; });

    private static Vector3 Vec3(Table t, string key, float dx, float dy, float dz)
    { var sub = t?.Get(key).Table; return sub == null ? new Vector3(dx, dy, dz) : Vec3f(sub); }
    private static Vector3 Vec3f(Table t) => new(Flt(t,"x",0), Flt(t,"y",0), Flt(t,"z",0));
    private static float   Flt(Table t, string k, float def)
    { var v = t?.Get(k); return (v == null || v.IsNil()) ? def : (float)(v.Type == DataType.Number ? v.Number : def); }
}

[MoonSharpUserData]
public class PhysicsLegacy
{
    private readonly LuauGameRunner _runner;
    public PhysicsLegacy(LuauGameRunner r) { _runner = r; }
    public void SetGravity(float g) => _runner.RunOnMainThread<object>(() =>
    { Physics.gravity = new Vector3(0, g, 0); return null; });
}

[MoonSharpUserData]
public class PlayersLegacy
{
    private readonly LuauGameRunner _runner;
    private DynValue _onSpawned = DynValue.Nil;
    public PlayersLegacy(LuauGameRunner r) { _runner = r; r.OnPlayerSpawned += id => Fire(id); }
    public void SpawnAt(Table pos) => _runner.RequestSpawnPlayer(new Vector3(
        SafeFloat(pos,"x"), SafeFloat(pos,"y"), SafeFloat(pos,"z")));
    public void OnSpawned(DynValue cb) => _onSpawned = cb;
    private void Fire(string id) { if (_onSpawned.Type == DataType.Function) _runner.CallLua(_onSpawned, DynValue.NewString(id)); }
    private static float SafeFloat(Table t, string k)
    { var v = t?.Get(k); return (v == null || v.IsNil()) ? 0f : v.Type == DataType.Number ? (float)v.Number : 0f; }
    public void FireSpawned(string id) => Fire(id);
}
