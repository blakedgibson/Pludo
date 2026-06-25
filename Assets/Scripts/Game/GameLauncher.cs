using System;
using System.Collections;
using System.Threading;
using System.Threading.Tasks;
using ReactUnity.UGUI;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.UI;

// Orchestrates the full play flow when the user taps Play on a game card.
//
// Flow:
//   1. Show "Joining…" overlay
//   2. Fetch full GameData (script) from API if not cached
//   3. Force landscape on phones (via MobileOrientationManager)
//   4. Join or create a Photon Fusion 2 room keyed to the game ID
//   5. Execute the Luau script via LuauGameRunner
//   6. Hide overlay and signal React to show the in-game HUD
//
// Back / exit flow (ExitAsync):
//   1. Tear down LuauGameRunner environment
//   2. Leave Photon room
//   3. Restore screen orientation
//   4. Signal React to show the lobby
public class GameLauncher : MonoBehaviour
{
    public static GameLauncher Instance { get; private set; }

    private CancellationTokenSource _gameCts;

    // UGUI overlay hierarchy (built programmatically, sortingOrder=200)
    private Canvas      _overlayCanvas;
    private CanvasGroup _overlayGroup;
    private GameObject  _loadingPanel;
    private Image       _thumbnailImage;     // full-screen game thumbnail background
    private Image       _thumbnailFallback;  // solid dark colour shown until thumb arrives
    private Text        _titleLabel;          // game title shown centered
    private RectTransform _progressFillRT;   // progress-bar fill (left-anchored, width animates)
    private GameObject  _toastPanel;
    private Text        _toastLabel;
    private Coroutine   _toastCoroutine;
    private Coroutine   _thumbDownloadCo;

    // ── Escape-menu blur ──────────────────────────────────────────────────────
    private Volume _escapeBlurVolume;
    private bool   _hadPostProcessing;


    // ── Play-return editor state stash ────────────────────────────────────────
    // PlayFromEditorAsync captures the live editor state before entering play
    // and stores it here. When the editor re-opens after play (editMode:true),
    // LaunchAsync injects this instead of the server's potentially-stale
    // autosaved version, so the user returns to exactly the scene they left.
    private static string _playReturnEditorState;
    private static int    _playReturnGameId = -1;

    // ── Build preview Luau script ─────────────────────────────────────────────
    // Runs while Claude generates the real game. Creates a night scene with
    // blocks that pop in progressively so the user sees a 3D world being built.
    private const string PREVIEW_LUAU = @"
Scene.SetSkybox(""night"")
Scene.SetAmbientLight({r=0.1, g=0.2, b=0.5}, 0.4)

local ground = Object.Create(""plane"")
ground:SetScale(20, 1, 20)
ground:SetMaterial(""stone"")
ground:SetStatic(true)

local fill1 = Light.Create(""point"", -8, 10, 5)
fill1:SetColor(0.2, 0.4, 1.0)
fill1:SetIntensity(3.0)
fill1:SetRange(30)

local fill2 = Light.Create(""point"", 8, 8, -8)
fill2:SetColor(0.9, 0.2, 0.7)
fill2:SetIntensity(3.0)
fill2:SetRange(30)

local step = 0
Timer.Every(0.4, function()
  step = step + 1
  if step > 40 then return end

  local x = math.random(-12, 12)
  local z = math.random(-12, 12)
  local y = math.random(1, 10)
  local w = math.random(2, 6)
  local d = math.random(2, 6)

  local block = Object.Create(""cube"")
  block:SetPosition(x, y, z)
  block:SetScale(w, 0.8, d)
  block:SetStatic(true)

  local mat = math.random(1, 5)
  if mat == 1 then block:SetMaterial(""metal"")
  elseif mat == 2 then block:SetMaterial(""ice"")
  elseif mat == 3 then block:SetMaterial(""glass"")
  elseif mat == 4 then block:SetMaterial(""stone"")
  else block:SetMaterial(""wood"") end

  if math.random(1, 3) == 1 then
    Effects.Spawn(""sparkle"", x, y + 0.5, z)
  end
end)
";

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void EnsureInstance()
    {
        if (Instance != null) return;
        var go = new GameObject("[GameLauncher]");
        DontDestroyOnLoad(go);
        go.AddComponent<GameLauncher>();
    }

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        BuildOverlayCanvas();
    }

    private void Start()
    {
        StatusBarManager.Show();
        StartCoroutine(RegisterGlobalsAfterFrame());
    }

    // ── React globals ─────────────────────────────────────────────────────────

    private IEnumerator RegisterGlobalsAfterFrame()
    {
        yield return null;
        var renderers = FindObjectsByType<ReactRendererUGUI>();
        foreach (var r in renderers)
        {
            RegisterGlobals(r);
            r.AdvancedOptions.AfterStart.AddListener(() => RegisterGlobals(r));
        }
        Debug.Log($"[GameLauncher] loadGame/exitGame registered on {renderers.Length} renderer(s).");
    }

    public void RegisterGlobals(ReactRendererUGUI renderer)
    {
        renderer.Globals["loadGame"] = new Action<object>(id =>
            _ = LaunchAsync(Convert.ToInt32(id)));
        renderer.Globals["loadGameForEdit"] = new Action<object>(id =>
        {
            // Clear the restore-complete signal synchronously BEFORE the async load
            // begins, so the editor's autosave gate (which polls this flag) doesn't
            // open on a stale "true" left over from the previous game. LuauGameRunner
            // re-raises it once this game's editor-state restore has actually settled.
            SetGlobal("_editorRestoreComplete", "");
            _ = LaunchAsync(Convert.ToInt32(id), editMode: true);
        });
        // GamePreviewScreen overlay shows an orbit-cam of the game without
        // entering an actual session — same underlying RunGamePreview path as
        // edit mode, but the user is still in the lobby so orientation stays
        // portrait. Real play (loadGame) and real editing (loadGameForEdit)
        // still rotate to landscape.
        renderer.Globals["loadGameForPreview"] = new Action<object>(id =>
            _ = LaunchAsync(Convert.ToInt32(id), editMode: true, skipOrientation: true));
        renderer.Globals["exitGame"] = new Action(() =>
            _ = ExitAsync());
        // Rotate to landscape immediately without kicking off a game launch.
        // Used by the My Games tap-to-edit flow so the screen is already
        // rotated by the time EditorScreen mounts (which then calls
        // loadGameForEdit and runs the full launch).
        renderer.Globals["enterEditorOrientation"] = new Action(() =>
        {
            if (MobileOrientationManager.Instance != null)
                _ = MobileOrientationManager.Instance.EnterGameOrientationAsync();
        });
        renderer.Globals["setEscapeMenuOpen"] = new Action<bool>(SetEscapeBlur);
        renderer.Globals["startBuildPreview"]    = new Action(StartBuildPreview);
        renderer.Globals["runPartialScript"]     = new Action<object>(RunPartialScript);
        renderer.Globals["resetEditorCamera"]       = new Action(() => EditorCameraController.Instance?.ResetView());
        renderer.Globals["snapEditorCameraToNorth"] = new Action(() => EditorCameraController.Instance?.SnapToNorth());
        renderer.Globals["setEditorSelectMode"]    = new Action<string>(v => EditorCameraController.Instance?.SetSelect(v == "true"));
        // Deselect the current object while staying in select mode (the top-bar
        // X). Select mode is always on now, so this clears the highlight without
        // flipping SelectActive off.
        renderer.Globals["editorClearSelection"]   = new Action(() => EditorCameraController.Instance?.ClearSelection());
        renderer.Globals["setEditorSheetDragging"] = new Action<string>(v => EditorCameraController.SheetDragging = v == "true");
        // Left-docked panel framing: React passes the panel's right edge in
        // canvas reference units; Unity solves the pivot that places the
        // current selection at the centre of the visible right region and
        // glides over there. ClearFraming reverses the animation.
        renderer.Globals["editorFrameSelectionRight"] = new Action<object>(panelRightCanvasX =>
        {
            float x = panelRightCanvasX == null ? 0f : Convert.ToSingle(panelRightCanvasX);
            EditorCameraController.Instance?.BeginRightAreaFraming(x);
        });
        renderer.Globals["editorClearSelectionFraming"] = new Action(() =>
            EditorCameraController.Instance?.EndRightAreaFraming());

        // Editor drag-and-drop placement: React drops an asset tile onto the
        // preview viewport and calls this with the release point in raw screen
        // pixels (Unity's bottom-left origin; React reads them via getPointerX/Y).
        // We raycast from Camera.main into the scene; if no collider is hit we
        // intersect the ray with the y = 0 plane so something still spawns
        // (games without explicit terrain still work). The asset tile remains in
        // the strip — that's owned by React state and we never touch it.
        renderer.Globals["editorPlaceAsset"] = new Action<object, object, object, object, object, object>(
            (cacheKey, modelUrl, screenPxX, screenPxY, isHumanoid, sizeHint) =>
        {
            float px = Convert.ToSingle(screenPxX);
            float py = Convert.ToSingle(screenPxY);

            // Drop-on-trash cancels the placement — matches the placed-object
            // delete UX so the same icon means the same thing in both flows.
            // The trash icon is only rendered while a strip tile is armed, so
            // a user who didn't intend this path can't accidentally trigger it.
            if (EditorCameraController.IsOverTrash(new Vector2(px, py))) return;

            PlaceAssetAtScreenPoint(
                Convert.ToString(cacheKey),
                Convert.ToString(modelUrl),
                Convert.ToBoolean(isHumanoid),
                new Vector2(px, py),
                Convert.ToSingle(sizeHint));
        });
        // Tap-to-add: React calls this when the user TAPS a strip tile (a press
        // with no meaningful drag) instead of dragging it. The model drops at
        // the centre of the viewport — i.e. in front of the editor camera — so
        // a quick tap is a fast way to add a model without aiming at a spot.
        // Same terrain-snap + autosave as the drag-to-place path. No trash check
        // because a tap can't land on the (drag-only) trash drop-zone.
        renderer.Globals["editorAddAssetCenter"] = new Action<object, object, object, object>(
            (cacheKey, modelUrl, isHumanoid, sizeHint) =>
        {
            PlaceAssetAtScreenPoint(
                Convert.ToString(cacheKey),
                Convert.ToString(modelUrl),
                Convert.ToBoolean(isHumanoid),
                new Vector2(Screen.width * 0.5f, Screen.height * 0.5f),
                Convert.ToSingle(sizeHint));
        });
        // Raw pointer helpers for the editor. The asset-strip drag-to-place flow
        // reads these to (a) place the model under the finger at release and
        // (b) detect the release itself: ReactUnity's <scroll> hosting the strip
        // can hijack the gesture and fire onPointerCancel before the finger
        // lifts, so React can't rely on its own pointerUp bubbling out of the
        // scroll. Polling isPointerDown gives an event-routing-independent
        // release signal. Coords are raw screen pixels (bottom-left origin),
        // matching what editorPlaceAsset expects.
        renderer.Globals["getPointerX"]   = new Func<float>(() => EditorPointerPos().x);
        renderer.Globals["getPointerY"]   = new Func<float>(() => EditorPointerPos().y);
        renderer.Globals["isPointerDown"] = new Func<string>(() => EditorPointerDown() ? "true" : "false");
        // Drag-to-place: called when the user drags a strip tile past the tap-slop
        // threshold. Spawns the actual asset at the current screen position and
        // immediately enters the move-selected state so the finger that is still
        // down continues moving the asset in world space (same as dragging a
        // placed object). React no longer calls editorPlaceAsset for this gesture.
        renderer.Globals["editorBeginAssetDrag"] = new Action<object, object, object, object, object, object>(
            (cacheKey, modelUrl, isHumanoid, sizeHint, sx, sy) =>
        {
            var runner = LuauGameRunner.Instance;
            if (runner == null) return;
            var world = RaycastToWorldPoint(Convert.ToSingle(sx), Convert.ToSingle(sy));
            if (!world.HasValue) return;
            int touchId = Input.touchCount > 0 ? Input.GetTouch(0).fingerId : -1;
            runner.PlaceEditorAssetForDrag(
                Convert.ToString(cacheKey), Convert.ToString(modelUrl),
                Convert.ToBoolean(isHumanoid), world.Value, touchId, Convert.ToSingle(sizeHint));
        });
        // Safe-area conversion: pixels → React canvas reference units. On a real
        // device Screen.safeArea + Screen.width/height share a coordinate space
        // and the conversion is straightforward. In the Unity Editor the two
        // APIs disagree — Screen.width/height returns the Game View dimensions
        // while Screen.safeArea is reported in the simulated device's native
        // portrait points, regardless of the current orientation. Pixel→ref
        // math against mismatched units lands buttons in the bezel chrome
        // outside the iOS safe rect. The Editor path skips the math entirely
        // and returns iPhone-typical insets in points (which equal React ref
        // units since refRes is in iPhone-point space).
        renderer.Globals["getSafeAreaTop"]    = new Func<float>(SafeAreaTopRef);
        renderer.Globals["getSafeAreaBottom"] = new Func<float>(SafeAreaBottomRef);
        renderer.Globals["getSafeAreaLeft"]   = new Func<float>(SafeAreaLeftRef);
        renderer.Globals["getSafeAreaRight"]  = new Func<float>(SafeAreaRightRef);
        // System color scheme — React reads this from theme.ts at module load
        // so the app background matches the device theme (black in dark mode,
        // white in light mode). Unity does NOT expose a cross-platform dark-mode
        // API; full implementation needs native plugins (iOS UITraitCollection,
        // Android UI_MODE_NIGHT). For now report "dark" so the bg stays #000000
        // (matches the prior #1C1C1E lobby colour). Swap this in when native
        // detection lands.
        renderer.Globals["getColorScheme"] = new Func<string>(() => "dark");
        // Selection action bridges — React's overlay UI (white square + arrow
        // buttons + duplicate/resize) calls these to manipulate whichever
        // GameObject EditorCameraController currently has selected. No-op if
        // nothing is selected.
        renderer.Globals["editorRotateSelected"] = new Action<object>(arg =>
            EditorCameraController.Instance?.RotateSelected(Convert.ToSingle(arg)));
        // Hold-to-rotate variant. React's three selection-overlay rotate buttons
        // pass an axis ("yaw" | "pitch" | "roll") so each one rotates around
        // a different basis (world-up, camera-right, camera-forward).
        renderer.Globals["editorRotateSelectedAxis"] = new Action<object, object>((axis, deg) =>
            EditorCameraController.Instance?.RotateSelectedAxis(
                Convert.ToString(axis), Convert.ToSingle(deg)));
        renderer.Globals["editorDuplicateSelected"] = new Action(() =>
            EditorCameraController.Instance?.DuplicateSelected());
        renderer.Globals["editorDeleteSelected"] = new Action(() =>
            EditorCameraController.Instance?.DeleteSelected());
        renderer.Globals["editorScaleSelected"] = new Action<object>(arg =>
            EditorCameraController.Instance?.ScaleSelected(Convert.ToSingle(arg)));
        // Swipe-to-move-vertical variant. React's right-edge selection-overlay
        // handle passes a per-tick signed delta (world units) so a vertical swipe
        // lifts (+) or lowers (−) the selected object.
        renderer.Globals["editorMoveSelectedVertical"] = new Action<object>(arg =>
            EditorCameraController.Instance?.MoveSelectedVertical(Convert.ToSingle(arg)));
        // Settings (gear) panel — React pushes each toggle/input change as
        // (objectName, key, value) where booleans arrive as "true"/"false"
        // and numbers as their string form. Routed to the currently-selected
        // GameObject; the name is checked so a stale dispatch doesn't write
        // to a different model.
        renderer.Globals["editorSetObjectSetting"] = new Action<object, object, object>((name, key, value) =>
            EditorCameraController.Instance?.SetObjectSetting(
                Convert.ToString(name)  ?? "",
                Convert.ToString(key)   ?? "",
                Convert.ToString(value) ?? ""));
        // Custom Logic (node-graph) panel — React pushes the full graph JSON on
        // every edit. Routed to the currently-selected GameObject so the graph
        // travels with it via the EditorObjectLogic component. EditorObjectLogic
        // is tolerant of malformed JSON so a partially-typed payload from React
        // can't blank out the prior graph.
        renderer.Globals["editorSetObjectLogic"] = new Action<object, object>((name, graphJson) =>
            EditorCameraController.Instance?.SetObjectLogic(
                Convert.ToString(name)      ?? "",
                Convert.ToString(graphJson) ?? ""));
        // Editor-state persistence bridges. React polls _editorStateRev (bumped
        // by every mutation through EditorCameraController.MarkStateDirty) and
        // calls editorCaptureState() to serialise the current scene; the JSON
        // is POSTed to /api/game/:id/editor-state. On load, after the Lua
        // script has executed and all Object.Create calls have returned,
        // React calls editorApplyState(json) to reapply the saved snapshot.
        renderer.Globals["editorCaptureState"] = new Func<string>(() => EditorState.Capture(LuauGameRunner.Instance));
        renderer.Globals["editorApplyState"]   = new Action<object>(json =>
            EditorState.Apply(LuauGameRunner.Instance, Convert.ToString(json) ?? ""));
        // Reconciling apply for session undo/redo: makes the scene match the
        // target snapshot exactly (destroying placed objects it omits, applying
        // its deletions, resetting terrain). Returns "ok" when the in-place
        // revert is complete, or "reload" when React must re-run the script first
        // (to rehydrate a deleted script object) and then editorApplyState on top.
        renderer.Globals["editorApplyStateExact"] = new Func<object, string>(json =>
            EditorState.ApplyExact(LuauGameRunner.Instance, Convert.ToString(json) ?? ""));
        renderer.Globals["playGameFromEditor"]     = new Action<object>(id =>
            _ = PlayFromEditorAsync(Convert.ToInt32(id)));
        // Chat: React calls sendChat(text) from the chat-panel input. Routed
        // straight to the active GameRenderClient, which validates+ships it
        // over the WebSocket. No-op if no game session is active.
        renderer.Globals["sendChat"]               = new Action<object>(text =>
            GameRenderClient.Instance?.SendChat(Convert.ToString(text) ?? ""));
        // Mobile toolbar tap → server equipTool + key pulse. React passes the
        // tool's `name` and the key it's bound to (e.g. "Sunflower", "1"); the
        // server fires the key as one-frame input.keys[key]=true so existing
        // Lua key handlers run identically to a desktop press.
        renderer.Globals["equipTool"] = new Action<object, object>((name, key) =>
            GameRenderClient.Instance?.SendEquipTool(
                Convert.ToString(name) ?? "",
                Convert.ToString(key)  ?? ""));
        // Interface panel: React sends the full HudButton array as JSON whenever
        // the creator adds, edits, or removes a button. The string is stored in
        // SceneSettings and captured by the next autosave.
        renderer.Globals["editorSetHudButtons"] = new Action<object>(json =>
        {
            SceneSettings.HudButtonsJson = Convert.ToString(json) ?? "";
            EditorCameraController.MarkStateDirty();
        });
        // In-game: React fires this when a HudButton with action="event" is tapped.
        // Routes to the active GameRenderClient which ships it over WebSocket so
        // the Lua script can listen via Events.On("hudButton:<name>", fn).
        renderer.Globals["fireHudEvent"] = new Action<object>(name =>
            GameRenderClient.Instance?.FireHudEvent(Convert.ToString(name) ?? ""));

        // ── Terrain Builder bridges ────────────────────────────────────────
        // React (CreateScreen.tsx, terrain-mode top bar) routes its tool taps
        // and brush drags here. The terrain GO is lazily created on first use
        // and lives at the scene root so it persists across LuauGameRunner
        // TearDowns (which only clear that runner's gameRoot children).
        // Suspends/resumes the editor camera's single-finger drag while the
        // user is in terrain-builder mode so the brush gets exclusive touch.
        // Two-finger pinch/tilt still works through the EditorCameraController
        // two-touch branch (which runs before the gate inside HandleInput).
        renderer.Globals["setTerrainModeActive"] = new Action<object>(v =>
        {
            EditorCameraController.TerrainModeActive = Convert.ToBoolean(v);
        });

        renderer.Globals["showTerrainBuilder"] = new Action<object>(v =>
        {
            bool show = Convert.ToBoolean(v);
            var tb = TerrainBuilder.EnsureInstance();
            // First entry into terrain mode lazily creates and shows the mesh.
            // Subsequent exits do NOT hide it — the sculpted heightmap must
            // remain visible in normal editor mode so the user sees their work.
            // The mesh is only hidden when explicitly reset+hidden by other
            // tooling (e.g. the MCP cleanup test).
            if (show) tb.Show(true);

            // Camera gate follows the show state — only block single-finger
            // drags while actively editing.
            EditorCameraController.TerrainModeActive = show;

            // Do NOT reposition the mesh on entry. The TerrainBuilder IS the
            // game's ground plane — LuauGameRunner parks it at origin / y=0 on
            // every load (it's the playable surface, aligned with where objects
            // are placed). The old code lifted it to y=2.5 and re-centered it
            // under the camera pivot the first time the user entered terrain
            // mode; that made an already-visible ground "jump" up into a
            // floating baseplate disconnected from the world, and brush strokes
            // (which raycast to whatever collider is actually under the cursor)
            // landed nowhere near the lifted surface. Leaving the mesh exactly
            // where it already sits keeps the sculpt in-place on the real ground.
            Debug.Log($"[TerrainBridge] showTerrainBuilder({show}) pos={tb.transform.position} visible={tb.gameObject.activeInHierarchy}");
        });

        renderer.Globals["setTerrainTool"] = new Action<object>(tool =>
        {
            var s = Convert.ToString(tool);
            TerrainBuilder.EnsureInstance().SetTool(s);
            Debug.Log($"[TerrainBridge] setTerrainTool('{s}') → {TerrainBuilder.Instance.ActiveTool}");
        });

        renderer.Globals["resetTerrainBuilder"] = new Action(() =>
        {
            TerrainBuilder.EnsureInstance().ResetTerrain(markTouched: true);
            // Persist the cleared terrain — bumps _editorStateRev so React's
            // autosave poll captures the now-flat grid into the draft.
            EditorCameraController.MarkStateDirty();
            Debug.Log("[TerrainBridge] resetTerrainBuilder()");
        });

        // React supplies the brush impact point in raw screen pixels (Unity
        // bottom-left origin — same convention as editorPlaceAsset). We
        // raycast to the active scene first so the brush works on any visible
        // collider (the TerrainBuilder mesh itself, the Lua game's terrain,
        // or _FallbackGround); if nothing's hit, intersect the y=0 plane so
        // sweeps off the mesh still apply somewhere reasonable.
        renderer.Globals["applyTerrainBrush"] =
            new Action<object, object, object, object>((screenPxX, screenPxY, radius, strength) =>
        {
            var cam = Camera.main;
            if (cam == null) { Debug.LogWarning("[TerrainBridge] applyTerrainBrush: no Camera.main"); return; }
            float px = Convert.ToSingle(screenPxX);
            float py = Convert.ToSingle(screenPxY);
            var ray = cam.ScreenPointToRay(new Vector3(px, py, 0));
            Vector3 world;
            bool hitCollider;
            string hitName = "(plane)";
            if (Physics.Raycast(ray, out var hit, 500f))
            {
                world = hit.point;
                hitCollider = true;
                hitName = hit.collider != null ? hit.collider.gameObject.name : "(null)";
            }
            else
            {
                var ground = new Plane(Vector3.up, Vector3.zero);
                if (!ground.Raycast(ray, out float enter)) return;
                world = ray.GetPoint(enter);
                hitCollider = false;
            }
            var tb = TerrainBuilder.EnsureInstance();
            float beforeH = tb.SampleHeightAt(world.x, world.z);
            tb.ApplyBrush(world.x, world.z, Convert.ToSingle(radius), Convert.ToSingle(strength));
            // Sculpt/paint strokes are user-visible game changes — mark the
            // editor state dirty so the autosave debounce captures the updated
            // heightmap into the unpublished draft (terrain block of
            // editor_state_json). Coalesced by React's 1.5 s debounce so a
            // drag of many strokes ships a single snapshot.
            if (tb.Touched) EditorCameraController.MarkStateDirty();
            float afterH = tb.SampleHeightAt(world.x, world.z);
            Debug.Log($"[TerrainBridge] applyTerrainBrush screen=({px:F0},{py:F0}) → world=({world.x:F1},{world.z:F1}) hit={hitName} tool={tb.ActiveTool} h:{beforeH:F2}→{afterH:F2}");
        });

        // ── Tools → Style / Player bridges ─────────────────────────────────
        // React's editor panels route their picks here. Each updates the shared
        // SceneSettings, applies it live to the preview, and marks the editor
        // state dirty so the 1.5 s autosave persists it into editor_state_json
        // (re-applied on reload/play via EditorState).
        renderer.Globals["editorSetSky"] = new Action<object>(preset =>
        {
            SceneSettings.Sky = Convert.ToString(preset) ?? "";
            if (!string.IsNullOrEmpty(SceneSettings.Sky)) EnvironmentManager.SetSkybox(SceneSettings.Sky);
            else EnvironmentManager.SetBaseplateEnvironment(); // back to blank-baseplate sky
            EditorCameraController.MarkStateDirty();
        });
        renderer.Globals["editorSetLighting"] = new Action<object>(preset =>
        {
            SceneSettings.Lighting = Convert.ToString(preset) ?? "";
            if (!string.IsNullOrEmpty(SceneSettings.Lighting)) EnvironmentManager.SetLighting(SceneSettings.Lighting);
            EditorCameraController.MarkStateDirty();
        });
        renderer.Globals["editorSetGround"] = new Action<object>(preset =>
        {
            SceneSettings.Ground = Convert.ToString(preset) ?? "";
            TerrainBuilder.EnsureInstance().SetGroundTheme(SceneSettings.Ground);
            EditorCameraController.MarkStateDirty();
        });
        renderer.Globals["editorSetPlayerSpeed"] = new Action<object>(v =>
        {
            SceneSettings.Speed = Convert.ToSingle(v);
            LuauGameRunner.Instance?.SetPlayerSpeed(SceneSettings.Speed);
            EditorCameraController.MarkStateDirty();
        });
        renderer.Globals["editorSetPlayerJump"] = new Action<object>(v =>
        {
            SceneSettings.Jump = Convert.ToSingle(v);
            LuauGameRunner.Instance?.SetPlayerJumpHeight(SceneSettings.Jump);
            EditorCameraController.MarkStateDirty();
        });
        // Lets React read back the current values to seed its panels on open.
        renderer.Globals["editorGetSceneSettings"] = new Func<string>(() =>
            SceneSettings.ToJson().ToString(Newtonsoft.Json.Formatting.None));
    }

    // Reasonable upper bound for a single safe-area inset, expressed as a
    // fraction of the screen dimension it's measured against. Real iPhone
    // notch/Dynamic Island/home-indicator insets stay well under 12%; values
    // past that are Editor Device Simulator chrome leaking into Screen.height.
    private const float SafeAreaSanityRatio = 0.12f;

    // iPhone-typical safe insets in points (= React reference units, since the
    // canvas reference resolution is 390×844 / 844×390 iPhone-point space).
    // Used in the Editor where Screen.safeArea / Screen.width units don't line
    // up. Tuned for the worst-case iPhone (Dynamic Island + 34pt home
    // indicator) so the editor preview clearly sits inside the yellow safe
    // rect regardless of which iPhone model the Device Simulator emulates.
    private const float EditorInsetLandscapeTop    =  0f;
    private const float EditorInsetLandscapeBottom = 21f;
    private const float EditorInsetLandscapeSide   = 50f;
    private const float EditorInsetPortraitTop     = 47f;
    private const float EditorInsetPortraitBottom  = 34f;

    private static bool IsLandscape() =>
        Screen.orientation == ScreenOrientation.LandscapeLeft  ||
        Screen.orientation == ScreenOrientation.LandscapeRight ||
        Screen.width > Screen.height;

    private static float SafeAreaTopRef()    =>
#if UNITY_EDITOR
        IsLandscape() ? EditorInsetLandscapeTop : EditorInsetPortraitTop;
#else
        SafeAreaInsetRef(Screen.height - Screen.safeArea.yMax, Screen.height);
#endif

    internal static float SafeAreaBottomRef() =>
#if UNITY_EDITOR
        IsLandscape() ? EditorInsetLandscapeBottom : EditorInsetPortraitBottom;
#else
        SafeAreaInsetRef(Screen.safeArea.y, Screen.height);
#endif

    private static float SafeAreaLeftRef()   =>
#if UNITY_EDITOR
        IsLandscape() ? EditorInsetLandscapeSide : 0f;
#else
        SafeAreaInsetRef(Screen.safeArea.x, Screen.width);
#endif

    private static float SafeAreaRightRef()  =>
#if UNITY_EDITOR
        IsLandscape() ? EditorInsetLandscapeSide : 0f;
#else
        SafeAreaInsetRef(Screen.width - Screen.safeArea.xMax, Screen.width);
#endif

    private static float SafeAreaInsetRef(float pxInset, float screenDim)
    {
        if (pxInset <= 0.5f) return 0f;
        if (screenDim > 0 && pxInset > screenDim * SafeAreaSanityRatio) return 0f;
        float scale = Mathf.Max(GetReactCanvasScale(), 0.01f);
        return Mathf.Round(pxInset / scale);
    }

    // Matches Unity's CanvasScaler.ScaleWithScreenSize / MatchWidthOrHeight
    // formula so safe-area pixel insets convert to the same reference units the
    // React HUD positions in. Reading the scaler live (rather than hardcoding
    // ratios) keeps the values correct after MobileOrientationManager swaps
    // the reference resolution between portrait (390×844) and landscape (844×390).
    // Public so EditorCameraController can use it when projecting selection
    // bounds from world → screen → React reference units.
    public static float GetReactCanvasScale()
    {
        var scaler = ReactUISetup.MainScaler;
        if (scaler == null) return 1f;
        var refRes = scaler.referenceResolution;
        if (refRes.x <= 0 || refRes.y <= 0) return 1f;
        float logW = Mathf.Log(Mathf.Max(1, Screen.width)  / refRes.x, 2f);
        float logH = Mathf.Log(Mathf.Max(1, Screen.height) / refRes.y, 2f);
        return Mathf.Pow(2f, Mathf.Lerp(logW, logH, scaler.matchWidthOrHeight));
    }

    // ── Public entry points ───────────────────────────────────────────────────

    // Starts the 3D build-preview scene while Claude generates the real game.
    // Called via React global startBuildPreview(). The real game load via
    // loadGameForEdit will call TearDown and replace this preview cleanly.
    private void StartBuildPreview()
    {
        // Fresh AI-build editing is a game session — go landscape now so the
        // partial-script preview renders in the right orientation from the very
        // first frame. ExitAsync (from React's exitGame) will restore portrait.
        StatusBarManager.Hide();
        if (MobileOrientationManager.Instance != null)
            _ = MobileOrientationManager.Instance.EnterGameOrientationAsync();

        AvatarPreviewController.Instance?.SetVisible(false);
        // Mark streaming so the parse-error catches in LuauGameRunner suppress
        // the red "Preview error: ..." banner for any partials that follow.
        LuauGameRunner.IsStreamingPartialScript = true;
        // Clear any leftover error from a prior session before the banner-poller
        // picks it up and re-shows it on top of the fresh build.
        ClearEditorError();
        var data = new GameData
        {
            id              = -1,
            title           = "Building...",
            description     = "build preview",
            gameCode        = PREVIEW_LUAU,
            assetUrlsJson   = "{}",
            humanoidIdsJson = "[]",
        };
        EnsureLuauRunner().RunGamePreview(data);
    }

    // Replaces the current build preview with a newer partial Luau script.
    // Called every few seconds while Claude is still generating, so the scene
    // materializes incrementally as code arrives.
    //
    // Streaming partials are routinely truncated mid-block (Claude is still
    // generating). Handing them straight to MoonSharp produces "'end' expected
    // near '<eof>'" errors and — because RunScript calls TearDown before parse —
    // wipes the previous valid scene to black until the next chunk arrives.
    // We pre-validate here: balance opener/closer keywords, attempt an auto-
    // complete, and dry-run-parse the result. If it still won't parse we drop
    // this partial entirely and keep the current scene rendering.
    private void RunPartialScript(object codeArg)
    {
        var luau = codeArg?.ToString();
        if (string.IsNullOrWhiteSpace(luau)) return;

        LuauGameRunner.IsStreamingPartialScript = true;

        var sanitized = LuauGameRunner.SanitizeLuauScript(luau);
        if (sanitized.Contains("{{FILL:"))
        {
            Debug.Log("[GameLauncher] Partial has unfilled placeholders — skipping.");
            return;
        }

        if (!LuauGameRunner.IsLuaScriptComplete(sanitized))
        {
            var completed = LuauGameRunner.AutoCompleteLuaScript(sanitized);
            if (LuauGameRunner.TryParseLua(completed))
            {
                sanitized = completed;
                Debug.Log("[GameLauncher] Auto-completed truncated partial script.");
            }
            else
            {
                Debug.Log("[GameLauncher] Partial unrecoverable — keeping prior scene.");
                return;
            }
        }
        else if (!LuauGameRunner.TryParseLua(sanitized))
        {
            // Balanced keyword count but still ungrammatical (e.g. truncated
            // expression). Skip rather than tear down a working scene to render
            // nothing.
            Debug.Log("[GameLauncher] Partial parse failed — keeping prior scene.");
            return;
        }

        AvatarPreviewController.Instance?.SetVisible(false);
        var data = new GameData
        {
            id              = -1,
            title           = "Building...",
            description     = "build preview",
            gameCode        = sanitized,
            assetUrlsJson   = "{}",
            humanoidIdsJson = "[]",
        };
        EnsureLuauRunner().RunGamePreview(data);
    }

    // Wipes _editorError on every connected ReactRendererUGUI so a leftover
    // banner from a prior session doesn't bleed into the new build.
    private void ClearEditorError()
    {
        foreach (var r in FindObjectsByType<ReactUnity.UGUI.ReactRendererUGUI>())
        {
            try { r.Globals["_editorError"] = ""; } catch { }
        }
    }

    // Sets the _editorError banner on every connected ReactRendererUGUI. Used when
    // we still want to enter the editor (so the viewport isn't black) but need to
    // tell the creator something is off — e.g. opening a draft that has no script.
    private void SetEditorError(string message)
    {
        foreach (var r in FindObjectsByType<ReactUnity.UGUI.ReactRendererUGUI>())
        {
            try { r.Globals["_editorError"] = message; } catch { }
        }
    }

    // Called from GamesScreenController with pre-fetched GameData.
    public Task LaunchAsync(GameData data) => LaunchAsync(data, null);

    // Called via React loadGame(id) or loadGameForEdit(id) global.
    // editMode=false (public play) fetches the published snapshot so anyone
    // playing the game sees the version that was last published, not the
    // creator's in-progress draft. editMode=true (editor) fetches the live
    // draft so the creator can iterate without re-publishing.
    public async Task LaunchAsync(int gameId, bool editMode = false, bool skipOrientation = false)
    {
        GameData data  = null;
        string   error = null;

        var tcs = new TaskCompletionSource<bool>();
        StartCoroutine(PludoApiClient.GetGame(gameId,
            d => { data  = d;     tcs.TrySetResult(true); },
            e => { error = e;     tcs.TrySetResult(false); },
            published: !editMode));
        await tcs.Task;

        // Returning from play-test? Restore the exact live state captured when
        // Play was pressed, not the server's potentially-stale autosave.
        // Keep a local copy: if data.gameCode is empty, the private LaunchAsync
        // does a second GetGame fetch and overwrites data entirely, losing our inject.
        string playReturnState = null;
        if (editMode && data != null
            && _playReturnEditorState != null
            && _playReturnGameId == gameId)
        {
            playReturnState        = _playReturnEditorState;
            data.editorStateJson   = _playReturnEditorState;
            _playReturnEditorState = null;
            _playReturnGameId      = -1;
        }

        await LaunchAsync(data, error, editMode, skipOrientation, playReturnState);
    }

    // Transitions from editor preview to local play mode without going through
    // GameRenderClient (which requires a running WebSocket server).
    private async Task PlayFromEditorAsync(int gameId)
    {
        _gameCts?.Cancel();
        _gameCts = new CancellationTokenSource();

        // Fetch game data WITHOUT destroying the preview — the preview stays alive
        // until we confirm the launch can proceed. A failed check just shows a
        // toast and the user never sees a blank screen.
        GameData data  = null;
        string   error = null;
        var tcs = new TaskCompletionSource<bool>();
        StartCoroutine(PludoApiClient.GetGame(gameId,
            d => { data  = d;  tcs.TrySetResult(true); },
            e => { error = e;  tcs.TrySetResult(false); }));
        await tcs.Task;

        if (data == null)
        {
            ShowToast(error ?? "Couldn't load this game. Please try again.");
            return;  // preview untouched
        }
        // A brand-new blank game has no Lua — that's fine. Play it locally on the
        // baseplate (the player walks the editor scene: sculpted terrain + any
        // assets placed from the Add Assets modal, captured below as editor state).
        if (data.gameCode == null) data.gameCode = "";

        // WYSIWYG: capture the CURRENT live editor scene and play THAT, not the
        // last state persisted to the server. React saves editor_state_json on a
        // debounce (see editorCaptureState bridge), so the fetched data.editorStateJson
        // lags any edits made just before Play — leading to objects playing back
        // where they were last saved instead of where they sit on screen.
        // Capture→Apply is a no-op round-trip, so applying this live snapshot on
        // top of the re-run script reproduces the editor scene exactly. Must run
        // BEFORE ExitGame() tears down GameRoot (Capture returns "{}" with no root).
        string liveEditorState = EditorState.Capture(LuauGameRunner.Instance);
        if (!string.IsNullOrWhiteSpace(liveEditorState) && liveEditorState != "{}")
            data.editorStateJson = liveEditorState;

        // Stash the live state so LaunchAsync(editMode:true) can restore it
        // exactly when the user returns from play — the server's autosaved version
        // lags by up to 1.5s and won't have the WYSIWYG scene the player just saw.
        _playReturnEditorState = data.editorStateJson;
        _playReturnGameId      = gameId;

        // All checks passed — commit to the transition.
        LuauGameRunner.Instance?.ExitGame();
        StatusBarManager.Hide();
        if (MobileOrientationManager.Instance != null)
            await MobileOrientationManager.Instance.EnterGameOrientationAsync();

        // RunGame sets _previewMode = false and signals _gameActive = "true" to React.
        LuauGameRunner.IsStreamingPartialScript = false;
        EnsureLuauRunner().RunGame(data);
    }

    public async Task ExitAsync()
    {
        _gameCts?.Cancel();

        // Drop streaming guard so a future build that fails before any partial
        // arrives still surfaces its error to the user.
        LuauGameRunner.IsStreamingPartialScript = false;

        // End server-authoritative render session if active
        GameRenderClient.Instance?.EndSession();

        // End local Lua session if active
        LuauGameRunner.Instance?.ExitGame();

        if (PludoServices.Multiplayer?.IsInRoom == true)
            await PludoServices.Multiplayer.LeaveRoomAsync();

        MobileOrientationManager.Instance?.ExitGameOrientation();
        StatusBarManager.Show();
        SetGlobal("_gameActive", "");
        Debug.Log("[GameLauncher] Game session ended.");
    }

    // ── Internal launch flow ──────────────────────────────────────────────────

    private async Task LaunchAsync(GameData data, string preFetchError, bool editMode = false, bool skipOrientation = false, string playReturnEditorState = null)
    {
        _gameCts?.Cancel();
        _gameCts = new CancellationTokenSource();
        var ct = _gameCts.Token;

        AvatarPreviewController.Instance?.SetVisible(false);

        // Show the loading overlay BEFORE rotating so the user never sees the
        // orbit-cam preview rotate underneath them. EnterGameOrientationAsync
        // fades to black during the rotation; with the overlay already up, the
        // fade-out and fade-in both happen over the loading screen, not over
        // a rotated preview. skipOrientation=true is the GamePreviewScreen
        // overlay path — same code path loads the orbit cam but the lobby stays
        // portrait.
        ShowLoadingOverlay(data);
        SetProgress(0.1f);

        if (!skipOrientation)
        {
            StatusBarManager.Hide();
            if (MobileOrientationManager.Instance != null)
                await MobileOrientationManager.Instance.EnterGameOrientationAsync();
        }
        bool launched = false;

        try
        {
            // Validate data
            if (preFetchError != null || data == null)
            {
                ShowToast($"Could not load game: {preFetchError ?? "no data"}");
                return;
            }

            // Fetch game script if it wasn't already populated
            if (string.IsNullOrEmpty(data.gameCode))
            {
                SetProgress(0.2f);
                var tcs = new TaskCompletionSource<bool>();
                GameData full = null;
                StartCoroutine(PludoApiClient.GetGame(data.id,
                    d => { full = d;       tcs.TrySetResult(true); },
                    e => { tcs.TrySetResult(false); }));
                await tcs.Task;
                if (full != null) data = full;
                // Re-inject the play-return stash: the secondary fetch just overwrote data.
                if (playReturnEditorState != null)
                    data.editorStateJson = playReturnEditorState;
            }

            // A draft with no script yet (still generating, or a generation that
            // never finished) must NOT drop the editor onto a black viewport. In
            // edit mode we fall through to RunGamePreview below: it stands up the
            // camera, skybox and ground baseline even when the script is empty, so
            // the creator lands in the editor world instead of a black screen.
            // Play mode has no editor to fall back into, so it keeps the toast.
            bool missingScript = string.IsNullOrEmpty(data.gameCode);
            if (missingScript && !editMode)
            {
                ShowToast("This game has no script yet.");
                return;
            }

            SetProgress(0.5f);
            ct.ThrowIfCancellationRequested();

            if (editMode)
            {
                // Edit/preview mode: run locally via LuauGameRunner for instant iteration.
                // If a server-authoritative play session is still alive (e.g. user
                // backed out of Play into a preview), tear it down first so its
                // SpawnPlayer-built avatar doesn't survive alongside the new one.
                GameRenderClient.Instance?.EndSession();

                SetProgress(0.7f);
                var runner = EnsureLuauRunner();
                // Full validated script — exit streaming mode so genuine errors
                // surface to the user via the _editorError banner from now on.
                LuauGameRunner.IsStreamingPartialScript = false;
                ClearEditorError();
                // Empty draft → a brand-new blank game. Keep MoonSharp off a null
                // script (SanitizeLuauScript dereferences .Length) and render the
                // blank baseplate editor world. No error banner — an empty game is
                // an intentional starting point now, not a failed generation.
                if (missingScript)
                {
                    data.gameCode = "";
                }
                runner.RunGamePreview(data);
            }
            else
            {
                // Play mode: server-authoritative via GameRenderClient + WebSocket room.
                // Photon stays for NAT traversal awareness, but game state lives on our server.
                //
                // Critical: tear down any active LuauGameRunner preview before joining
                // the server room. Without this, the orbit-cam preview avatar (spawned
                // by RunGamePreview during the GamePreviewScreen) persists alongside
                // the GameRenderClient's SpawnPlayer-built avatar — the user sees two
                // avatars stacked at the same position.
                LuauGameRunner.Instance?.ExitGame();

                SetProgress(0.7f);
                var renderClient = EnsureRenderClient();
                var tcs2 = new TaskCompletionSource<bool>();
                StartCoroutine(RunRenderSession(
                    renderClient, data.id,
                    PludoServices.Auth?.CurrentUser?.Username ?? "Player",
                    data.assetUrlsJson ?? "{}",
                    data.humanoidIdsJson ?? "[]",
                    published: true,
                    () => tcs2.TrySetResult(true)));
                await tcs2.Task;
            }

            SetProgress(1f);
            launched = true;
            HideOverlay();
        }
        catch (OperationCanceledException)
        {
            // User exited while joining — clean up silently
        }
        catch (Exception ex)
        {
            Debug.LogError($"[GameLauncher] Launch failed: {ex}");
            ShowToast("Something went wrong. Please try again.");
        }
        finally
        {
            if (!launched)
            {
                HideOverlay();
                // Only restore portrait if we actually rotated — preview path
                // never left portrait, so calling ExitGameOrientation would be
                // a no-op anyway, but keep it tidy.
                //
                // Also skip when our cancellation token tripped: that means a
                // newer LaunchAsync has already called _gameCts.Cancel() on us
                // and is about to (or already did) call EnterGameOrientationAsync
                // for its own session. Snapping back to portrait here would
                // race the new launch — the user sees "rotates landscape then
                // snaps back" because the old launch's exit fires AFTER the
                // new launch's enter.
                if (!skipOrientation && !ct.IsCancellationRequested)
                    MobileOrientationManager.Instance?.ExitGameOrientation();
                if (PludoServices.Multiplayer?.IsInRoom == true)
                    await PludoServices.Multiplayer.LeaveRoomAsync();
            }
        }
    }

    // ── Escape-menu scene blur ────────────────────────────────────────────────

    private void SetEscapeBlur(bool open)
    {
        var cam     = Camera.main;
        var urpData = cam != null ? cam.GetComponent<UniversalAdditionalCameraData>() : null;

        if (open)
        {
            // Remember whether post-processing was already on so we can restore it.
            _hadPostProcessing = urpData != null && urpData.renderPostProcessing;

            if (urpData != null)
            {
                urpData.renderPostProcessing = true;
                urpData.requiresDepthTexture = true;
            }

            if (_escapeBlurVolume == null)
            {
                var go = new GameObject("[EscapeBlur]");
                go.transform.SetParent(transform);

                _escapeBlurVolume          = go.AddComponent<Volume>();
                _escapeBlurVolume.isGlobal = true;
                _escapeBlurVolume.priority = 150;

                var profile = ScriptableObject.CreateInstance<VolumeProfile>();

                // Bokeh DOF: focus at 5 cm so the entire game world is out-of-focus.
                var dof                      = profile.Add<DepthOfField>(true);
                dof.active                   = true;
                dof.mode.value               = DepthOfFieldMode.Bokeh;
                dof.focusDistance.value      = 0.05f;  // focus at 5 cm — nothing in the game is this close
                dof.focalLength.value        = 300f;   // 300 mm → razor-thin depth of field
                dof.aperture.value           = 32f;    // f/32 → maximum blur
                dof.bladeCount.value         = 5;
                dof.bladeCurvature.value     = 1f;
                dof.bladeRotation.value      = 0f;

                _escapeBlurVolume.profile = profile;
            }

            _escapeBlurVolume.gameObject.SetActive(true);
        }
        else
        {
            _escapeBlurVolume?.gameObject.SetActive(false);

            // Restore post-processing state.
            if (urpData != null && !_hadPostProcessing)
                urpData.renderPostProcessing = false;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Current pointer position in raw screen pixels (bottom-left origin). Mirrors
    // AvatarPreviewController's helper so the editor reports the same convention.
    private static Vector2 EditorPointerPos()
    {
#if ENABLE_INPUT_SYSTEM
        var p = UnityEngine.InputSystem.Pointer.current;
        return p != null ? p.position.ReadValue() : Vector2.zero;
#else
        if (Input.touchCount > 0) return Input.GetTouch(0).position;
        return (Vector2)Input.mousePosition;
#endif
    }

    // Whether the primary pointer (first touch or left mouse) is currently
    // pressed. Used by React to detect the asset-strip drag release.
    private static bool EditorPointerDown()
    {
#if ENABLE_INPUT_SYSTEM
        var p = UnityEngine.InputSystem.Pointer.current;
        return p != null && p.press.isPressed;
#else
        if (Input.touchCount > 0)
        {
            var ph = Input.GetTouch(0).phase;
            return ph != TouchPhase.Ended && ph != TouchPhase.Canceled;
        }
        return Input.GetMouseButton(0);
#endif
    }

    // Shared placement core for editorPlaceAsset (drag release, screen point =
    // finger) and editorAddAssetCenter (tap, screen point = viewport centre).
    // Raycasts the screen point into the scene, snaps to the terrain column,
    // spawns the asset, and bumps the editor-state dirty rev for autosave.
    private void PlaceAssetAtScreenPoint(string cacheKey, string modelUrl, bool isHumanoid, Vector2 screenPx, float sizeHint = 0f)
    {
        var runner = LuauGameRunner.Instance;
        if (runner == null || runner.GameRoot == null)
        {
            Debug.LogWarning("[PlaceAsset] No active runner — ignored.");
            return;
        }
        var world = RaycastToWorldPoint(screenPx.x, screenPx.y);
        if (!world.HasValue)
        {
            Debug.LogWarning("[PlaceAsset] No camera or intersect plane — ignored.");
            return;
        }
        runner.PlaceEditorAsset(cacheKey, modelUrl, isHumanoid, world.Value, sizeHint);
        EditorCameraController.MarkStateDirty();
    }

    // Casts a ray from screen position (sx, sy) into the scene and returns the
    // terrain-snapped world point. Returns null when Camera.main is absent or
    // the ray misses every surface and the y=0 plane.
    private static Vector3? RaycastToWorldPoint(float sx, float sy)
    {
        var cam = Camera.main;
        if (cam == null) return null;

        var ray = cam.ScreenPointToRay(new Vector3(sx, sy, 0));

        // Horizontal anchor: first collider hit, or y=0 plane as fallback.
        Vector3 anchor;
        if (Physics.Raycast(ray, out var hit, 500f))
            anchor = hit.point;
        else
        {
            var ground = new Plane(Vector3.up, Vector3.zero);
            if (!ground.Raycast(ray, out float enter)) return null;
            anchor = ray.GetPoint(enter);
        }

        // Vertical snap: shoot downward from (anchor.x, 500, anchor.z) and keep
        // the highest MeshyAssetMarker.IsTerrain hit. Falls back to y=0 when no
        // terrain exists (e.g. a bare baseplate game).
        var downOrigin = new Vector3(anchor.x, 500f, anchor.z);
        var hits = Physics.RaycastAll(downOrigin, Vector3.down, 1000f, ~0, QueryTriggerInteraction.Ignore);
        float terrainY = float.MinValue;
        foreach (var h in hits)
        {
            if (h.collider == null) continue;
            var mk = h.collider.GetComponentInParent<MeshyAssetMarker>();
            if (mk == null || !mk.IsTerrain) continue;
            if (h.point.y > terrainY) terrainY = h.point.y;
        }
        return new Vector3(anchor.x, terrainY > float.MinValue ? terrainY : 0f, anchor.z);
    }

    private LuauGameRunner EnsureLuauRunner()
    {
        var runner = LuauGameRunner.Instance;
        if (runner != null) return runner;
        var go = new GameObject("LuauGameRunner");
        DontDestroyOnLoad(go);
        return go.AddComponent<LuauGameRunner>();
    }

    private GameRenderClient EnsureRenderClient()
    {
        var client = GameRenderClient.Instance;
        if (client != null) return client;
        var go = new GameObject("GameRenderClient");
        DontDestroyOnLoad(go);
        return go.AddComponent<GameRenderClient>();
    }

    private IEnumerator RunRenderSession(
        GameRenderClient client, int gameId, string username,
        string assetUrlsJson, string humanoidIdsJson,
        bool published,
        Action onReady)
    {
        yield return client.StartSession(gameId, username, assetUrlsJson, humanoidIdsJson, published);
        onReady?.Invoke();
    }

    private void SetGlobal(string key, string value)
    {
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
            r.Globals[key] = value;
    }

    // ── UGUI loading overlay ──────────────────────────────────────────────────

    // Show the loading overlay with the game's thumbnail, title and a progress
    // bar. game is optional — if null, the overlay still appears but with no
    // title/thumbnail (used by error-path early invocations).
    private void ShowLoadingOverlay(GameData game)
    {
        if (_overlayCanvas == null) return;
        _loadingPanel.SetActive(true);
        _toastPanel.SetActive(false);

        // Title
        if (_titleLabel != null)
            _titleLabel.text = game?.title ?? "";

        // Reset progress to 0
        SetProgress(0f);

        // Reset thumbnail to fallback colour, then kick off download
        if (_thumbnailImage != null)
        {
            _thumbnailImage.sprite = null;
            _thumbnailImage.color  = new Color(1f, 1f, 1f, 0f);
        }
        if (_thumbDownloadCo != null) { StopCoroutine(_thumbDownloadCo); _thumbDownloadCo = null; }
        if (!string.IsNullOrEmpty(game?.thumbnailUrl))
            _thumbDownloadCo = StartCoroutine(LoadThumbnail(game.thumbnailUrl));

        _overlayCanvas.gameObject.SetActive(true);
    }

    // Animates the progress bar fill. p is clamped to 0..1.
    private void SetProgress(float p)
    {
        if (_progressFillRT == null) return;
        p = Mathf.Clamp01(p);
        // Right anchor moves from 0 (empty) to 1 (full); anchored 0..1 across
        // the parent track. anchorMin stays at (0,0), only anchorMax.x animates.
        var amax = _progressFillRT.anchorMax;
        amax.x = p;
        _progressFillRT.anchorMax = amax;
        _progressFillRT.offsetMin = _progressFillRT.offsetMax = Vector2.zero;
    }

    private IEnumerator LoadThumbnail(string url)
    {
        using var req = UnityEngine.Networking.UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        _thumbDownloadCo = null;
        if (req.result != UnityEngine.Networking.UnityWebRequest.Result.Success) yield break;
        if (_thumbnailImage == null) yield break;

        var tex = UnityEngine.Networking.DownloadHandlerTexture.GetContent(req);
        var sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f));
        _thumbnailImage.sprite = sprite;
        _thumbnailImage.color  = new Color(1f, 1f, 1f, 1f);
    }

    private void HideOverlay()
    {
        if (_thumbDownloadCo != null) { StopCoroutine(_thumbDownloadCo); _thumbDownloadCo = null; }
        _overlayCanvas?.gameObject.SetActive(false);
    }

    private void ShowToast(string message)
    {
        if (_overlayCanvas == null || _toastPanel == null) return;
        _loadingPanel.SetActive(false);
        _toastPanel.SetActive(true);
        if (_toastLabel != null) _toastLabel.text = message;
        _overlayCanvas.gameObject.SetActive(true);

        if (_toastCoroutine != null) StopCoroutine(_toastCoroutine);
        _toastCoroutine = StartCoroutine(DismissToast(3f));
    }

    private IEnumerator DismissToast(float delay)
    {
        yield return new WaitForSecondsRealtime(delay);
        HideOverlay();
        _toastCoroutine = null;
    }

    private void BuildOverlayCanvas()
    {
        var root = new GameObject("[GameOverlay]");
        root.transform.SetParent(transform); // parent is already DontDestroyOnLoad

        _overlayCanvas = root.AddComponent<Canvas>();
        _overlayCanvas.renderMode  = RenderMode.ScreenSpaceOverlay;
        _overlayCanvas.sortingOrder = 200;
        root.AddComponent<CanvasScaler>();
        root.AddComponent<GraphicRaycaster>();
        _overlayGroup = root.AddComponent<CanvasGroup>();

        // ── Loading panel ──────────────────────────────────────────────────────
        // Explicit RectTransform — children below anchor to this rect, so a
        // plain Transform would leave them unpositioned. (Adding a UI component
        // later would auto-convert, but we have no panel-level component
        // anymore — the thumbnail/vignette/title/bar are all separate children.)
        _loadingPanel = new GameObject("LoadingPanel", typeof(RectTransform));
        _loadingPanel.transform.SetParent(root.transform, false);
        Stretch(_loadingPanel.GetComponent<RectTransform>());

        // Base fallback colour shown until the thumbnail loads (and behind it
        // if the thumbnail download fails). Pure black so the title stays
        // legible without a thumbnail.
        var fallbackGo = new GameObject("Fallback");
        fallbackGo.transform.SetParent(_loadingPanel.transform, false);
        _thumbnailFallback = fallbackGo.AddComponent<Image>();
        _thumbnailFallback.color = new Color(0.05f, 0.05f, 0.05f, 1f);
        Stretch(fallbackGo.GetComponent<RectTransform>());

        // Thumbnail image — fades in from alpha 0 once the texture finishes
        // downloading. preserveAspect = true so different game thumbs aren't
        // squashed; the panel covers the screen and any aspect-mismatch shows
        // the fallback colour behind it.
        var thumbGo = new GameObject("Thumbnail");
        thumbGo.transform.SetParent(_loadingPanel.transform, false);
        _thumbnailImage = thumbGo.AddComponent<Image>();
        _thumbnailImage.color = new Color(1f, 1f, 1f, 0f);
        _thumbnailImage.preserveAspect = true;
        Stretch(thumbGo.GetComponent<RectTransform>());

        // Dark vignette so the title and progress bar stay readable on light
        // thumbnails (sunny landscapes, white skies, etc).
        var vignetteGo = new GameObject("Vignette");
        vignetteGo.transform.SetParent(_loadingPanel.transform, false);
        var vignetteImg = vignetteGo.AddComponent<Image>();
        vignetteImg.color = new Color(0f, 0f, 0f, 0.55f);
        Stretch(vignetteGo.GetComponent<RectTransform>());

        // Game title — centered, bold-ish via size, white.
        var titleGo = new GameObject("TitleLabel");
        titleGo.transform.SetParent(_loadingPanel.transform, false);
        _titleLabel = titleGo.AddComponent<Text>();
        _titleLabel.text      = "";
        _titleLabel.alignment = TextAnchor.MiddleCenter;
        _titleLabel.fontSize  = 44;
        _titleLabel.fontStyle = FontStyle.Bold;
        _titleLabel.color     = Color.white;
        _titleLabel.font      = GetBuiltinFont();
        _titleLabel.horizontalOverflow = HorizontalWrapMode.Wrap;
        var trt = titleGo.GetComponent<RectTransform>();
        trt.anchorMin = new Vector2(0.08f, 0.44f);
        trt.anchorMax = new Vector2(0.92f, 0.58f);
        trt.offsetMin = trt.offsetMax = Vector2.zero;

        // Progress bar track — thin rounded bar centred below the title.
        var barTrackGo = new GameObject("ProgressTrack");
        barTrackGo.transform.SetParent(_loadingPanel.transform, false);
        var trackImg = barTrackGo.AddComponent<Image>();
        trackImg.color = new Color(1f, 1f, 1f, 0.18f);
        var trackRT = barTrackGo.GetComponent<RectTransform>();
        trackRT.anchorMin = new Vector2(0.18f, 0.36f);
        trackRT.anchorMax = new Vector2(0.82f, 0.36f);
        // Give the bar a fixed pixel height regardless of where the anchor
        // lands. sizeDelta.y = 6 means 6 reference px tall.
        trackRT.pivot     = new Vector2(0.5f, 0.5f);
        trackRT.sizeDelta = new Vector2(0f, 6f);

        // Progress bar fill — anchored left, right anchor animates 0..1.
        var fillGo = new GameObject("ProgressFill");
        fillGo.transform.SetParent(barTrackGo.transform, false);
        var fillImg = fillGo.AddComponent<Image>();
        fillImg.color = new Color(0.19f, 0.82f, 0.35f, 1f); // matches React C.green
        _progressFillRT = fillGo.GetComponent<RectTransform>();
        _progressFillRT.anchorMin = new Vector2(0f, 0f);
        _progressFillRT.anchorMax = new Vector2(0f, 1f);
        _progressFillRT.offsetMin = _progressFillRT.offsetMax = Vector2.zero;

        // ── Toast panel ────────────────────────────────────────────────────────
        _toastPanel = new GameObject("ToastPanel");
        _toastPanel.transform.SetParent(root.transform, false);

        var toastBg = _toastPanel.AddComponent<Image>();
        toastBg.color = new Color(0.1f, 0.1f, 0.1f, 0.92f);
        var toastRT = _toastPanel.GetComponent<RectTransform>();
        toastRT.anchorMin = new Vector2(0.08f, 0.07f);
        toastRT.anchorMax = new Vector2(0.92f, 0.16f);
        toastRT.offsetMin = toastRT.offsetMax = Vector2.zero;

        var toastLblGo = new GameObject("ToastLabel");
        toastLblGo.transform.SetParent(_toastPanel.transform, false);
        _toastLabel = toastLblGo.AddComponent<Text>();
        _toastLabel.text      = "";
        _toastLabel.alignment = TextAnchor.MiddleCenter;
        _toastLabel.fontSize  = 22;
        _toastLabel.color     = Color.white;
        _toastLabel.font      = GetBuiltinFont();
        Stretch(toastLblGo.GetComponent<RectTransform>());

        // Start hidden
        root.SetActive(false);
    }

    private static void Stretch(RectTransform rt)
    {
        rt.anchorMin = Vector2.zero;
        rt.anchorMax = Vector2.one;
        rt.offsetMin = rt.offsetMax = Vector2.zero;
    }

    private static Font GetBuiltinFont()
    {
        // LegacyRuntime.ttf is the bundled UI font in Unity 2022+
        var f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        return f != null ? f : Font.CreateDynamicFontFromOSFont("Arial", 16);
    }
}
