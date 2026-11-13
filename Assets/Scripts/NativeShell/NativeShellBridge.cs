// Unity-as-a-Library bridge for the React Native shell (native-shell/).
//
// Only compiled into builds made with the PLUDO_NATIVE_SHELL define (see
// Assets/Editor/NativeShellBuild.cs). In that mode the native app owns the lobby
// (Home, Explore, Chat, You…) and Unity is only shown for playing a game, the
// editor, and the avatar. ReactUnity still runs for the in-game HUD; App.tsx
// reads the "getHostMode" global and skips its own auth gate and lobby.
//
//   Shell → Unity : UnitySendMessage("NativeShell", <Method>, <arg>)
//                   Configure("{\"apiBaseUrl\":\"…\"}") · LaunchGame("<gameId>")
//                   ShowAvatar("{\"background\":\"#RRGGBB\"}") · HideAvatar("") · ExitGame("")
//                   RenderHeadshot("") · SetSession("{…}") · OpenCreator("") · EditorCommand("play|tools|publish|leave|undo|redo")
//   Unity → Shell : sendMessageToMobileApp(json)
//                   {"type":"ready"} · {"type":"gameStarted","gameId":N} · {"type":"gameExited"}
//                   {"type":"headshot","dataUri":"data:image/png;base64,…"} · {"type":"creatorClosed"}
//                   {"type":"editorState",active,atRest,canUndo,canRedo,playLabel,playEnabled,published,picking}
#if PLUDO_NATIVE_SHELL
using System;
using System.Collections;
using System.Runtime.InteropServices;
using ReactUnity.UGUI;
using UnityEngine;
using UnityEngine.Rendering.Universal;

public class NativeShellBridge : MonoBehaviour
{
    public static NativeShellBridge Instance { get; private set; }

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void sendMessageToMobileApp(string message);
#endif

    private bool _gameActive;
    private int  _currentGameId = -1;
    // The host owns the environment: it tells Unity which API to use. Release
    // builds otherwise resolve to the (empty) production URL.
    private static string _apiBaseUrlOverride;

    [Serializable] private class ShellConfig { public string apiBaseUrl; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Boot()
    {
        if (Instance != null) return;
        // The on-screen Development Console would cover the native app.
        Debug.developerConsoleEnabled = false;
        Debug.developerConsoleVisible = false;
        // Joystick + jump are native glass controls in the shell (see
        // MobileGameInput.HostDriven); Unity's UGUI ones stay hidden.
        MobileGameInput.HostDriven = true;
        var go = new GameObject("NativeShell");   // UnitySendMessage target name
        DontDestroyOnLoad(go);
        Instance = go.AddComponent<NativeShellBridge>();
    }

    private IEnumerator Start()
    {
        // Same timing GameLauncher uses: renderers exist after the first frame.
        yield return null;
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
        {
            RegisterGlobals(r);
            r.AdvancedOptions.AfterStart.AddListener(() => RegisterGlobals(r));
        }
        // The lobby is native now — keep the chibi hidden until the You tab asks.
        AvatarPreviewController.Instance?.SetVisible(false);
        Send("{\"type\":\"ready\"}");
    }

    // Which ReactUnity screen the host asked for ("" = none, "create" = the
    // game creator). App.tsx polls getHostRoute; the creator's close button
    // calls closeHostRoute, which hands control back to the native app.
    private static string _hostRoute = "";
    // Optional game (CreateScreen GameStub JSON) to open straight in the editor;
    // taken once by App.tsx when the creator mounts.
    private static string _hostEditGame = "";
    private static readonly System.Collections.Generic.Queue<string> _editorCommands = new();
    // In-game HUD commands (pause / resume / reset / shiftLock / chat / leave),
    // kept apart from the editor's queue: the editor stays mounted under a
    // play-test and would otherwise drain them.
    private static readonly System.Collections.Generic.Queue<string> _hudCommands = new();

    private static void RegisterGlobals(ReactRendererUGUI r)
    {
        r.Globals["getHostMode"]    = new Func<string>(() => "native");
        r.Globals["getHostRoute"]   = new Func<string>(() => _hostRoute);
        // Editor chrome channel (native toolbar): ReactUnity reports editor state
        // with notifyHost(json) → forwarded to the host; the host queues commands
        // with EditorCommand(cmd) → ReactUnity drains them via takeEditorCommand.
        r.Globals["notifyHost"] = new Action<object>(json => { if (json != null) Send(json.ToString()); });
        r.Globals["takeEditorCommand"] = new Func<string>(() =>
            _editorCommands.Count > 0 ? _editorCommands.Dequeue() : "");
        r.Globals["takeHudCommand"] = new Func<string>(() =>
            _hudCommands.Count > 0 ? _hudCommands.Dequeue() : "");
        r.Globals["takeHostEditGame"] = new Func<string>(() =>
        {
            var g = _hostEditGame;
            _hostEditGame = "";
            return g;
        });
        r.Globals["closeHostRoute"] = new Action(() =>
        {
            var closed = _hostRoute;
            _hostRoute = "";
            if (closed == "create") Send("{\"type\":\"creatorClosed\"}");
        });
    }

    private float _nextPoll;

    private void LateUpdate()
    {
        if (_backdrop.HasValue && AvatarPreviewController.Instance != null)
            SetBackdrop(AvatarPreviewController.Instance.GetComponent<Camera>(), _backdrop.Value);
    }

    private void Update()
    {
        // ServiceBootstrap may (re)assign BaseUrl after Configure arrives; keep ours.
        if (!string.IsNullOrEmpty(_apiBaseUrlOverride) && PludoApiClient.BaseUrl != _apiBaseUrlOverride)
            ApplyApiBaseUrl();
        if (Time.unscaledTime < _nextPoll) return;
        _nextPoll = Time.unscaledTime + 0.25f;
        bool active = ReadGameActive();
        if (active == _gameActive) return;
        _gameActive = active;
        if (active) Send($"{{\"type\":\"gameStarted\",\"gameId\":{_currentGameId}}}");
        else
        {
            _currentGameId = -1;
            Send("{\"type\":\"gameExited\"}");
        }
    }

    private static bool ReadGameActive()
    {
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
        {
            try
            {
                var v = r.Globals["_gameActive"];
                return v != null && v.ToString() == "true";
            }
            catch { /* key not set yet */ }
        }
        return false;
    }

    // ── Shell → Unity ─────────────────────────────────────────────────────────

    public void Configure(string json)
    {
        var cfg = JsonUtility.FromJson<ShellConfig>(json);
        if (cfg == null || string.IsNullOrEmpty(cfg.apiBaseUrl)) return;
        _apiBaseUrlOverride = cfg.apiBaseUrl.TrimEnd('/');
        ApplyApiBaseUrl();
        Debug.Log($"[NativeShell] API base URL set by host: {_apiBaseUrlOverride}");
    }

    private static void ApplyApiBaseUrl()
    {
        PludoApiClient.BaseUrl = _apiBaseUrlOverride;
        foreach (var r in FindObjectsByType<ReactRendererUGUI>())
            r.Globals["apiBaseUrl"] = _apiBaseUrlOverride;
    }

    public void LaunchGame(string id)
    {
        if (!int.TryParse(id, out var gameId) || GameLauncher.Instance == null) return;
        _currentGameId = gameId;
        AvatarPreviewController.Instance?.SetVisible(false);
        RestoreBackdrop();   // games set up their own sky/cameras
        _ = GameLauncher.Instance.LaunchAsync(gameId);
    }

    // ── Session (host-owned) ─────────────────────────────────────────────────
    // {"userId","username","accessToken","refreshToken","expiresAt"} adopts the
    // native app's Supabase session (it refreshes and re-sends); "" signs out.
    [Serializable] private class HostSession
    {
        public string userId, username, accessToken, refreshToken;
        public long   expiresAt;
    }

    public void SetSession(string json)
    {
        if (!(PludoServices.Auth is Pludo.Services.Auth.AuthService auth)) return;
        HostSession s = null;
        if (!string.IsNullOrEmpty(json)) { try { s = JsonUtility.FromJson<HostSession>(json); } catch { } }
        if (s == null || string.IsNullOrEmpty(s.accessToken)) { auth.ClearHostSession(); return; }
        auth.AdoptHostSession(s.userId, s.username, s.accessToken, s.refreshToken, s.expiresAt);
    }

    // Shows the ReactUnity game editor full screen. arg: "new" (blank game straight
    // into the editor — the "+" button) or
    // a GameStub JSON {id,title,description,genre,plays,hasCode,thumbnailUrl} to
    // open directly in the editor (the drawer's owner-only "Edit").
    public void OpenCreator(string arg)
    {
        _hostEditGame = arg ?? "";
        AvatarPreviewController.Instance?.SetVisible(false);
        RestoreBackdrop();
        _hostRoute = "create";
    }

    // ── Model Studio (hand-built 3D models, no AI) ───────────────────────────
    public void OpenModelStudio(string arg)
    {
        AvatarPreviewController.Instance?.SetVisible(false);
        RestoreBackdrop();
        ModelStudio.Ensure().Open();
    }

    public void CloseModelStudio(string arg) => ModelStudio.Instance?.Close();

    // "add:block" · "tool:move" · "set:{json}" · "publish:{json}" …
    public void StudioCommand(string cmd) => ModelStudio.Instance?.Command(cmd);

    // Native editor toolbar → ReactUnity editor: play / tools / publish / leave / undo / redo.
    public void EditorCommand(string cmd)
    {
        if (!string.IsNullOrEmpty(cmd)) _editorCommands.Enqueue(cmd);
    }

    // Native in-game HUD → ReactUnity GameHUD.
    public void HudCommand(string cmd)
    {
        if (!string.IsNullOrEmpty(cmd)) _hudCommands.Enqueue(cmd);
    }

    // Native joystick: "x,y" in -1..1 (x right, y forward); "0,0" on release.
    public void SetMove(string xy)
    {
        var parts = (xy ?? "").Split(',');
        if (parts.Length == 2 &&
            float.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var x) &&
            float.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var y))
            MobileGameInput.SetHostMove(new Vector2(x, y));
        else
            MobileGameInput.SetHostMove(Vector2.zero);
    }

    // Native jump button.
    public void Jump(string arg) { MobileGameInput.HostJump(); MobileGameInput.SetHostJumpHeld(true); }
    // Native jump button released ("0") — ends hold-to-keep-jumping.
    public void JumpHold(string arg) => MobileGameInput.SetHostJumpHeld(arg == "1");

    public void ExitGame(string arg)
    {
        if (GameLauncher.Instance != null) _ = GameLauncher.Instance.ExitAsync();
    }

    [Serializable] private class AvatarOptions { public string background; }

    // Scene cameras whose clear colour was overridden for the avatar backdrop.
    private readonly System.Collections.Generic.Dictionary<Camera, (CameraClearFlags, Color, bool, int)> _backdropOverrides = new();

    // arg (optional): {"background":"#RRGGBB"} — the backdrop behind the chibi,
    // so the native card around Unity's view can use the same colour.
    public void ShowAvatar(string arg)
    {
        var avatar = AvatarPreviewController.Instance;
        if (avatar == null) return;
        avatar.SetVisible(true);
        // Unity's view IS the avatar frame here (the native You tab sizes it), so
        // use the whole view: no bottom crop for the old React nav bar/drawer,
        // and framing that fits the full body into this view's aspect.
        avatar.SetAvatarRegion(0f, 0f);

        AvatarOptions opts = null;
        if (!string.IsNullOrEmpty(arg)) { try { opts = JsonUtility.FromJson<AvatarOptions>(arg); } catch { } }
        if (opts != null && ColorUtility.TryParseHtmlString(opts.background ?? "", out var bg))
        {
            _backdrop = bg;
            SetBackdrop(avatar.GetComponent<Camera>(), bg);
        }
        LogSceneCameras();
    }

    // One line per active camera, so backdrop problems are diagnosable from the
    // device console (xcrun simctl launch --console-pty …).
    private static void LogSceneCameras()
    {
        var sb = new System.Text.StringBuilder("[NativeShell] cameras:");
        foreach (var cam in FindObjectsByType<Camera>())
        {
            var urp = cam.GetComponent<UniversalAdditionalCameraData>();
            sb.Append($" | {cam.name} on={cam.isActiveAndEnabled} rt={(cam.targetTexture != null)} clear={cam.clearFlags} bg={cam.backgroundColor} pp={(urp != null && urp.renderPostProcessing)} mask={cam.cullingMask}");
        }
        sb.Append($" | sky={(RenderSettings.skybox != null ? RenderSettings.skybox.name : "none")} fog={RenderSettings.fog}");
        Debug.Log(sb.ToString());
    }

    // Backdrop colour to keep while the avatar is shown. Cameras can be
    // re-enabled or reset after ShowAvatar (eg. the editor tearing down its
    // world when the host returns to the profile), so it's re-applied each frame.
    private Color? _backdrop;

    public void HideAvatar(string arg)
    {
        AvatarPreviewController.Instance?.SetVisible(false);
        RestoreBackdrop();
    }

    // The chibi is drawn (via a render texture) over whatever the scene cameras
    // clear to, so the backdrop is their clear colour.
    private void SetBackdrop(Camera avatarCam, Color color)
    {
        foreach (var cam in FindObjectsByType<Camera>())
        {
            if (cam == avatarCam || cam.targetTexture != null || !cam.isActiveAndEnabled) continue;
            var urp = cam.GetComponent<UniversalAdditionalCameraData>();
            if (!_backdropOverrides.ContainsKey(cam))
                _backdropOverrides[cam] = (cam.clearFlags, cam.backgroundColor, urp != null && urp.renderPostProcessing, cam.cullingMask);
            cam.clearFlags      = CameraClearFlags.SolidColor;
            cam.backgroundColor = color;
            // A game/editor's post-processing (exposure, bloom…) outlives it and
            // would wash the flat backdrop out to white behind the chibi.
            if (urp != null) urp.renderPostProcessing = false;
            // Behind the avatar the scene cameras only need to clear to the
            // backdrop colour. Rendering nothing also hides whatever a game or
            // the editor left in the scene (sky dome, terrain…), which otherwise
            // showed through as a white wall behind the chibi.
            cam.cullingMask = 0;
        }
    }

    private void RestoreBackdrop()
    {
        _backdrop = null;
        foreach (var kv in _backdropOverrides)
        {
            if (kv.Key == null) continue;
            kv.Key.clearFlags      = kv.Value.Item1;
            kv.Key.backgroundColor = kv.Value.Item2;
            var urp = kv.Key.GetComponent<UniversalAdditionalCameraData>();
            if (urp != null) urp.renderPostProcessing = kv.Value.Item3;
            kv.Key.cullingMask = kv.Value.Item4;
        }
        _backdropOverrides.Clear();
    }

    // Renders a close-up of the chibi's head (the profile picture) and sends it
    // back as {"type":"headshot","dataUri":"data:image/png;base64,…"}. Uses its
    // own camera on the avatar layer, so the live preview isn't disturbed.
    public void RenderHeadshot(string arg) => StartCoroutine(HeadshotRoutine());

    private IEnumerator HeadshotRoutine()
    {
        // The chibi is built asynchronously at startup — wait for it (≤ 10 s).
        Renderer head = null;
        for (float t = 0; t < 10f && head == null; t += 0.25f)
        {
            var root = GameObject.Find("ChibiRoot");
            if (root != null)
                foreach (var r in root.GetComponentsInChildren<Renderer>())
                    if (r.name == "Head" && r.bounds.size.sqrMagnitude > 0.0001f) { head = r; break; }
            if (head == null) yield return new WaitForSecondsRealtime(0.25f);
        }
        if (head == null) { Send("{\"type\":\"headshot\",\"error\":\"no avatar\"}"); yield break; }

        yield return new WaitForEndOfFrame();

        const int size = 256;
        var b      = head.bounds;
        var camGO  = new GameObject("[HeadshotCam]");
        var cam    = camGO.AddComponent<Camera>();
        cam.enabled         = false;
        cam.cullingMask     = 1 << head.gameObject.layer;
        cam.clearFlags      = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0f, 0f, 0f, 0f);
        cam.fieldOfView     = 30f;
        // The head mesh's bounds reach down past the chin (skinned bounds), so
        // frame on its upper ~75%: the visible head. The preview camera looks
        // at the chibi from +Z (its front), so do the same.
        var   aim  = new Vector3(b.center.x, b.max.y - 0.37f * b.size.y, b.center.z);
        float half = 0.42f * b.size.y;
        float dist = half / Mathf.Tan(15f * Mathf.Deg2Rad);
        cam.transform.position = aim + new Vector3(0f, 0f, dist + b.extents.z);
        cam.transform.LookAt(aim);
        cam.nearClipPlane = 0.01f;
        cam.farClipPlane  = dist * 3f;

        var rt = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 1 };
        cam.targetTexture = rt;
        cam.Render();

        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
        tex.ReadPixels(new Rect(0, 0, size, size), 0, 0);
        tex.Apply();
        RenderTexture.active = prev;

        var png = tex.EncodeToPNG();
        cam.targetTexture = null;
        rt.Release();
        Destroy(rt);
        Destroy(tex);
        Destroy(camGO);

        Send("{\"type\":\"headshot\",\"dataUri\":\"data:image/png;base64," + Convert.ToBase64String(png) + "\"}");
    }

    // ── Unity → Shell ─────────────────────────────────────────────────────────

    private static void Send(string json)
    {
        Debug.Log($"[NativeShell] → host: {json}");
#if UNITY_IOS && !UNITY_EDITOR
        sendMessageToMobileApp(json);
#endif
    }
}
#endif
