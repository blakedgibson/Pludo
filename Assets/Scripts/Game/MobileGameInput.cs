using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

// Runtime UGUI virtual joystick + jump button rendered at sortingOrder 15.
// Swipe right from the upper-left corner → fires PauseRequested (opens escape menu).
// Upper-left zone avoids the joystick (bottom-left) and iOS system edge gestures.
//
// DefaultExecutionOrder(-100) ensures Update() runs before LuauPlayerController
// so JumpPressed is set before it is consumed.
[DefaultExecutionOrder(-100)]
public class MobileGameInput : MonoBehaviour
{
    public static MobileGameInput Instance { get; private set; }

    public static Vector2 MoveInput   { get; private set; }
    public static bool    JumpPressed  { get; private set; }

    // Latch for a "reset to spawn" affordance. Desktop uses the R key directly;
    // a mobile reset button can call RequestReset(). ConsumeReset() reads and
    // clears it so it fires exactly once regardless of script execution order.
    private static bool _resetPressed;
    public static void RequestReset() => _resetPressed = true;
    public static bool ConsumeReset() { bool v = _resetPressed; _resetPressed = false; return v; }

    // Finger IDs currently claimed by this script — LuauOrbitCamera checks this
    // to avoid starting an orbit on a finger already used for joystick / jump.
    public static readonly HashSet<int> ClaimedFingerIds = new();

    public static event Action PauseRequested;

    // ── Host-driven mode (native shell) ──────────────────────────────────────
    // Inside the React Native app the joystick and jump button are native
    // Liquid Glass controls drawn over Unity's view; they feed movement here
    // through NativeShellBridge instead of this script's UGUI canvas, which
    // then stays hidden. SetVisible still gates whether input is live (the
    // pause menu hides the controls), so gameplay sees the same contract.
    public static bool HostDriven;
    private static Vector2 _hostMove;
    private static bool    _hostJump;
    private bool           _hostActive;
    public static void SetHostMove(Vector2 v) => _hostMove = Vector2.ClampMagnitude(v, 1f);
    public static void HostJump() => _hostJump = true;
    /// <summary>True while gameplay input is live (between game start and pause/exit).</summary>
    public bool ControlsActive => HostDriven ? _hostActive : _canvas.gameObject.activeSelf;

    private Canvas        _canvas;
    private RectTransform _canvasRT;
    private RectTransform _safeAreaRT;
    private Rect          _lastSafeArea;
    private Vector2Int    _lastScreenSize;
    private RectTransform _joyBgRT;
    private RectTransform _joyKnobRT;
    private RectTransform _jumpBtnRT;

    private bool    _joyActive;
    private int     _joyFingerId  = -1;   // -99 = mouse sentinel
    private Vector2 _joyOriginSS;
    private int     _jumpFingerId = -1;

    // Upper-left swipe tracking — touch top-left corner and drag right → opens escape menu
    private int     _swipeFingerId = -1;   // -99 = mouse sentinel
    private Vector2 _swipeStart;
    private const float SwipeEdgeX = 0.08f; // left 8% of screen width
    private const float SwipeEdgeY = 0.50f; // upper 50% of screen height (y > 50%)
    // 5% of screen width gives ~5 mm of physical distance on any phone DPI — avoids
    // a hardcoded pixel value that is too tight on high-DPI (460 ppi) devices.
    private static float SwipeMin => Screen.width * 0.05f;

    private const float JoyRadius  = 70f;
    private const float JoyBgSize  = 140f;
    private const float KnobSize   = 64f;
    private const float JumpSize   = 150f; // larger hit target, matches Roblox mobile button size

    // Idle resting position of the joystick (bottom-left of safe area, in
    // reference UI units). Used both on first build and to reset the floating
    // joystick after release so it doesn't drift into the chat panel area.
    // Anchored so the JoyBg's bottom-left edge touches the safe-area corner
    // (anchored pos = radius = JoyBgSize/2).
    private static readonly Vector2 JoyIdlePos = new(JoyBgSize * 0.5f, JoyBgSize * 0.5f);

    // Joystick activation zone — bottom-left only. The right boundary is now
    // computed from the React HUD panel's right edge (safeAreaLeft +
    // ChatWidthRef) via JoyZoneMaxScreenX() so the joystick can never trigger
    // past the visible chat UI. JoyZoneMaxY caps it to the bottom 60% of the
    // screen so taps near the top half are always free for the chat / HUD.
    // Keep in lockstep with the drop-down width in App.tsx's GameHUD (the
    // quick-actions tray and chat window both render at 240 ref units).
    private const float ChatWidthRef = 240f;
    private const float JoyZoneFallbackMaxX = 0.40f;
    private const float JoyZoneMaxY = 0.60f;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void AutoCreate()
    {
        if (Instance != null) return;
        var go = new GameObject("[MobileGameInput]");
        DontDestroyOnLoad(go);
        go.AddComponent<MobileGameInput>();
    }

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        BuildUI();
    }

    public void SetVisible(bool on)
    {
        if (HostDriven)
        {
            _hostActive = on;
            _canvas.gameObject.SetActive(false);
            _hostMove = Vector2.zero; _hostJump = false;
            MoveInput = Vector2.zero; JumpPressed = false;
            ClaimedFingerIds.Clear();
            return;
        }
        _canvas.gameObject.SetActive(on);
        if (!on)
        {
            ResetJoystick();
            if (_jumpFingerId >= 0) ClaimedFingerIds.Remove(_jumpFingerId);
            _jumpFingerId  = -1;
            _swipeFingerId = -1;
            ClaimedFingerIds.Clear();
        }
    }

    // ── UI construction ───────────────────────────────────────────────────────

    private void BuildUI()
    {
        var root = new GameObject("MobileInputCanvas");
        root.transform.SetParent(transform);

        _canvas = root.AddComponent<Canvas>();
        _canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
        _canvas.sortingOrder = 15;

        var scaler = root.AddComponent<CanvasScaler>();
        scaler.uiScaleMode         = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(926f, 428f);
        scaler.screenMatchMode     = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight  = 0.5f;

        root.AddComponent<GraphicRaycaster>();
        _canvasRT = root.GetComponent<RectTransform>();

        // Safe-area container — fills Screen.safeArea so the joystick and
        // jump button always sit inside the iOS yellow safe rect (clear of
        // the notch, Dynamic Island and home-indicator bezel). Updated each
        // frame in Update() so orientation changes are picked up live.
        var safeGO = new GameObject("SafeArea");
        safeGO.transform.SetParent(root.transform, false);
        _safeAreaRT = safeGO.AddComponent<RectTransform>();
        // Pivot at bottom-left so its local space matches the canvas
        // convention (origin at bottom-left). Without this, the joystick
        // repositioning math — which converts touches to local coords and
        // assigns anchoredPosition for children anchored at (0,0) — would
        // be off by half the safe-area size.
        _safeAreaRT.pivot = Vector2.zero;
        ApplySafeArea();

        // Joystick — bottom-left of the safe area, repositioned on touch
        _joyBgRT   = Circle("JoyBg",   safeGO.transform, JoyBgSize, new Color(1,1,1,0.12f), circular: true);
        _joyKnobRT = Circle("JoyKnob", safeGO.transform, KnobSize,  new Color(1,1,1,0.45f), circular: true);
        foreach (var rt in new[] { _joyBgRT, _joyKnobRT })
        {
            rt.anchorMin = rt.anchorMax = Vector2.zero;
            rt.pivot     = new Vector2(0.5f, 0.5f);
            rt.anchoredPosition = JoyIdlePos;
        }

        // Jump button — bottom-right of the safe area. Anchored so the button's
        // bottom-right edge touches the safe-area corner (anchored pos = radius).
        _jumpBtnRT = Circle("JumpBtn", safeGO.transform, JumpSize, new Color(0.4f, 0.85f, 1f, 0.45f), circular: true);
        _jumpBtnRT.anchorMin = _jumpBtnRT.anchorMax = new Vector2(1f, 0f);
        _jumpBtnRT.pivot     = new Vector2(0.5f, 0.5f);
        _jumpBtnRT.anchoredPosition = new Vector2(-JumpSize * 0.5f, JumpSize * 0.5f);
        AddLabel(_jumpBtnRT, "↑");

        root.SetActive(false);
    }

    // Anchors _safeAreaRT to Screen.safeArea using normalized anchors so
    // children pinned to its corners land inside the iOS safe rect. Called
    // from BuildUI and re-applied in Update() when safeArea or screen size
    // changes (orientation flip, foreground after rotation lock, etc.).
    //
    // Each axis is floored to MinInsetPx because iOS landscape with the status
    // bar hidden often reports 0 px on the axis opposite the notch — without
    // the floor the joystick / jump button land flush with the device frame
    // instead of the visible safe rect.
    private void ApplySafeArea()
    {
        if (_safeAreaRT == null) return;
        var sa = Screen.safeArea;
        int w = Mathf.Max(1, Screen.width);
        int h = Mathf.Max(1, Screen.height);
        // Reference resolution is 926×428 (landscape). Pin a minimum inset of
        // ~30 ref units, scaled to actual pixels by the canvas scale factor.
        float scale = _canvas != null ? Mathf.Max(_canvas.scaleFactor, 0.01f) : 1f;
        float minInsetPx = 30f * scale;
        float xMin = Mathf.Max(sa.xMin, minInsetPx);
        float yMin = Mathf.Max(sa.yMin, minInsetPx);
        float xMax = Mathf.Min(sa.xMax, w - minInsetPx);
        float yMax = Mathf.Min(sa.yMax, h - minInsetPx);
        _safeAreaRT.anchorMin = new Vector2(xMin / w, yMin / h);
        _safeAreaRT.anchorMax = new Vector2(xMax / w, yMax / h);
        _safeAreaRT.offsetMin = Vector2.zero;
        _safeAreaRT.offsetMax = Vector2.zero;
        _lastSafeArea   = sa;
        _lastScreenSize = new Vector2Int(w, h);
    }

    // ── Update ────────────────────────────────────────────────────────────────

    private void Update()
    {
        if (HostDriven)
        {
            if (_canvas.gameObject.activeSelf) _canvas.gameObject.SetActive(false);
            MoveInput   = _hostActive ? _hostMove : Vector2.zero;
            JumpPressed = _hostActive && _hostJump;
            _hostJump   = false;
            return;
        }
        if (!_canvas.gameObject.activeSelf) { MoveInput = Vector2.zero; JumpPressed = false; return; }
        JumpPressed = false;

        // Re-apply safe area if orientation / device window changed since the
        // last frame so the joystick & jump button stay inside the iOS safe
        // rect after rotations.
        if (Screen.safeArea != _lastSafeArea ||
            _lastScreenSize.x != Screen.width || _lastScreenSize.y != Screen.height)
            ApplySafeArea();

        if (Input.touchCount > 0)
            ProcessTouches();
        else
            ProcessMouseInput();
    }

    private void ProcessTouches()
    {
        bool joyTracked = false;

        for (int i = 0; i < Input.touchCount; i++)
        {
            var t = Input.GetTouch(i);

            // ── Existing swipe finger ─────────────────────────────────────────
            if (_swipeFingerId >= 0 && t.fingerId == _swipeFingerId)
            {
                if (t.phase == TouchPhase.Moved || t.phase == TouchPhase.Stationary)
                {
                    if (t.position.x - _swipeStart.x > SwipeMin)
                    {
                        _swipeFingerId = -1;
                        SetVisible(false);
                        PauseRequested?.Invoke();
                        return;
                    }
                }
                else if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
                    _swipeFingerId = -1;
                continue;
            }

            // ── Existing joystick finger ──────────────────────────────────────
            if (_joyActive && t.fingerId == _joyFingerId)
            {
                joyTracked = true;
                if (t.phase == TouchPhase.Moved || t.phase == TouchPhase.Stationary)
                {
                    var deltaSS = t.position - _joyOriginSS;
                    float scale = Mathf.Max(_canvas.scaleFactor, 0.01f);
                    var clamped = Vector2.ClampMagnitude(deltaSS / scale, JoyRadius);
                    MoveInput = clamped / JoyRadius;
                    ScreenToCanvas(_joyOriginSS, out var origin);
                    _joyKnobRT.anchoredPosition = origin + clamped;
                }
                else if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
                    ResetJoystick();
                continue;
            }

            // ── Existing jump finger ──────────────────────────────────────────
            if (_jumpFingerId >= 0 && t.fingerId == _jumpFingerId)
            {
                if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
                {
                    ClaimedFingerIds.Remove(_jumpFingerId);
                    _jumpFingerId = -1;
                }
                continue;
            }

            // ── New touch ─────────────────────────────────────────────────────
            if (t.phase != TouchPhase.Began) continue;

            // Upper-left swipe zone — claim before joystick
            if (t.position.x < Screen.width * SwipeEdgeX &&
                t.position.y > Screen.height * SwipeEdgeY &&
                _swipeFingerId < 0)
            {
                _swipeFingerId = t.fingerId;
                _swipeStart    = t.position;
                continue;
            }

            if (_jumpFingerId < 0 && HitsJump(t.position))
            {
                _jumpFingerId = t.fingerId;
                JumpPressed   = true;
                ClaimedFingerIds.Add(t.fingerId);
            }
            else if (!_joyActive &&
                     t.position.x < JoyZoneMaxScreenX() &&
                     t.position.y < Screen.height * JoyZoneMaxY &&
                     !IsPointerOverReactUI(t.fingerId, t.position))
            {
                _joyActive    = true;
                _joyFingerId  = t.fingerId;
                _joyOriginSS  = t.position;
                ScreenToCanvas(_joyOriginSS, out var p);
                _joyBgRT.anchoredPosition   = p;
                _joyKnobRT.anchoredPosition = p;
                ClaimedFingerIds.Add(t.fingerId);
                joyTracked = true;
            }
        }

        if (!joyTracked)
        {
            if (_joyActive && Input.touchCount == 0) ResetJoystick();
            else if (!_joyActive) MoveInput = Vector2.zero;
        }
    }

    // Mouse fallback — joystick / jump / swipe in Unity Editor and iOS Simulator
    private void ProcessMouseInput()
    {
        if (Input.GetMouseButtonDown(0))
        {
            var pos = (Vector2)Input.mousePosition;

            // Upper-left swipe zone
            if (pos.x < Screen.width * SwipeEdgeX &&
                pos.y > Screen.height * SwipeEdgeY &&
                _swipeFingerId < 0)
            {
                _swipeFingerId = -99;
                _swipeStart    = pos;
                return;
            }

            if (HitsJump(pos))
            {
                JumpPressed = true;
            }
            else if (!_joyActive &&
                     pos.x < JoyZoneMaxScreenX() &&
                     pos.y < Screen.height * JoyZoneMaxY &&
                     !IsPointerOverReactUI(-1, pos))
            {
                _joyActive    = true;
                _joyFingerId  = -99;
                _joyOriginSS  = pos;
                ScreenToCanvas(_joyOriginSS, out var p);
                _joyBgRT.anchoredPosition   = p;
                _joyKnobRT.anchoredPosition = p;
            }
        }

        // Swipe drag
        if (_swipeFingerId == -99)
        {
            if (Input.GetMouseButton(0))
            {
                if ((float)Input.mousePosition.x - _swipeStart.x > SwipeMin)
                {
                    _swipeFingerId = -1;
                    SetVisible(false);
                    PauseRequested?.Invoke();
                }
            }
            else if (Input.GetMouseButtonUp(0))
                _swipeFingerId = -1;
            return;
        }

        // Joystick drag / release
        if (_joyActive && _joyFingerId == -99)
        {
            if (Input.GetMouseButton(0))
            {
                var pos = (Vector2)Input.mousePosition;
                var clamped = Vector2.ClampMagnitude(
                    (pos - _joyOriginSS) / Mathf.Max(_canvas.scaleFactor, 0.01f), JoyRadius);
                MoveInput = clamped / JoyRadius;
                ScreenToCanvas(_joyOriginSS, out var origin);
                _joyKnobRT.anchoredPosition = origin + clamped;
            }
            else if (!Input.GetMouseButton(0))
                ResetJoystick();
        }
    }

    private void ResetJoystick()
    {
        if (_joyFingerId >= 0) ClaimedFingerIds.Remove(_joyFingerId);
        _joyActive   = false;
        _joyFingerId = -1;
        MoveInput    = Vector2.zero;
        _joyKnobRT.anchoredPosition = _joyBgRT.anchoredPosition;
    }

    private bool HitsJump(Vector2 screenPos)
        => RectTransformUtility.RectangleContainsScreenPoint(
            _jumpBtnRT, screenPos,
            _canvas.renderMode == RenderMode.ScreenSpaceOverlay ? null : Camera.main);

    // The right boundary of the joystick activation zone, in screen pixels.
    // Matches the React chat panel's right edge — Screen.safeArea.x is the
    // left inset in pixels, and ChatWidthRef converts to pixels through the
    // React canvas scaler (same formula as GameLauncher.GetReactCanvasScale).
    // Falls back to JoyZoneFallbackMaxX of screen width when the scaler isn't
    // ready yet.
    private static float JoyZoneMaxScreenX()
    {
        var scaler = ReactUISetup.MainScaler;
        if (scaler == null) return Screen.width * JoyZoneFallbackMaxX;
        var refRes = scaler.referenceResolution;
        if (refRes.x <= 0 || refRes.y <= 0) return Screen.width * JoyZoneFallbackMaxX;
        float logW = Mathf.Log(Mathf.Max(1, Screen.width)  / refRes.x, 2f);
        float logH = Mathf.Log(Mathf.Max(1, Screen.height) / refRes.y, 2f);
        float reactScale = Mathf.Pow(2f, Mathf.Lerp(logW, logH, scaler.matchWidthOrHeight));
        if (reactScale <= 0.001f) return Screen.width * JoyZoneFallbackMaxX;
        return Screen.safeArea.x + ChatWidthRef * reactScale;
    }

    // Returns true if the touch / mouse position is over a higher-priority
    // UGUI element from a DIFFERENT canvas (e.g. the React chat panel on
    // sortingOrder 10). Touches over the joystick / jump button's own canvas
    // (sortingOrder 15) don't count — those are handled inline.
    //
    // Uses a fresh EventSystem raycast each call so the result is correct on
    // the SAME frame the touch begins (Input.GetTouch's EventSystem state for
    // a brand-new fingerId can lag by a frame, which would briefly activate
    // the joystick when the user taps the chat input).
    private static readonly List<RaycastResult> _raycastBuf = new();
    private bool IsPointerOverReactUI(int fingerId, Vector2 screenPos)
    {
        var es = EventSystem.current;
        if (es == null) return false;
        var ped = new PointerEventData(es) { position = screenPos, pointerId = fingerId };
        _raycastBuf.Clear();
        es.RaycastAll(ped, _raycastBuf);
        for (int i = 0; i < _raycastBuf.Count; i++)
        {
            var hit = _raycastBuf[i].gameObject;
            if (hit == null) continue;
            // Skip elements from our own joystick canvas — only chat/score/etc.
            // from the React canvas (or any other canvas) should block the joy.
            if (hit.transform.IsChildOf(_canvas.transform)) continue;
            return true;
        }
        return false;
    }

    // Converts a screen-pixel touch into local space of the SafeArea rect so
    // the result can be assigned directly to children anchored at the
    // safe area's bottom-left corner (joystick BG + knob).
    private void ScreenToCanvas(Vector2 screenPos, out Vector2 canvasPos)
        => RectTransformUtility.ScreenPointToLocalPointInRectangle(
            _safeAreaRT, screenPos,
            _canvas.renderMode == RenderMode.ScreenSpaceOverlay ? null : Camera.main,
            out canvasPos);

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static Sprite _circleSprite;

    // Generates a soft-edged circle sprite once and reuses it.
    // Does not depend on any built-in resource path — works on all Unity/URP versions.
    private static Sprite CircleSprite()
    {
        if (_circleSprite != null) return _circleSprite;
        const int S = 128;
        var tex  = new Texture2D(S, S, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear };
        float half = S * 0.5f;
        float r    = half - 1f;
        for (int y = 0; y < S; y++)
        for (int x = 0; x < S; x++)
        {
            float dx   = x - half + 0.5f;
            float dy   = y - half + 0.5f;
            float dist = Mathf.Sqrt(dx * dx + dy * dy);
            float a    = Mathf.Clamp01((r - dist) / 1.5f);   // 1.5 px soft edge
            tex.SetPixel(x, y, new Color(1f, 1f, 1f, a));
        }
        tex.Apply();
        _circleSprite = Sprite.Create(tex, new Rect(0, 0, S, S), new Vector2(0.5f, 0.5f), S);
        return _circleSprite;
    }

    private static RectTransform Circle(string name, Transform parent, float size, Color col, bool circular = false)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        var img = go.AddComponent<Image>();
        img.color = col;
        img.raycastTarget = true;
        if (circular)
        {
            img.sprite = CircleSprite();
            img.type   = Image.Type.Simple;
        }
        var rt = go.GetComponent<RectTransform>();
        rt.sizeDelta = new Vector2(size, size);
        rt.pivot     = new Vector2(0.5f, 0.5f);
        return rt;
    }

    private static void AddLabel(RectTransform parent, string text)
    {
        var lbl = new GameObject("Lbl");
        lbl.transform.SetParent(parent, false);
        var txt = lbl.AddComponent<Text>();
        txt.text      = text;
        txt.font      = BuiltinFont();
        txt.fontSize  = 28;
        txt.fontStyle = FontStyle.Bold;
        txt.alignment = TextAnchor.MiddleCenter;
        txt.color     = Color.white;
        var rt = lbl.GetComponent<RectTransform>();
        rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one;
        rt.offsetMin = rt.offsetMax = Vector2.zero;
    }

    private static Font BuiltinFont()
    {
        var f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        return f != null ? f : Font.CreateDynamicFontFromOSFont("Arial", 16);
    }
}
