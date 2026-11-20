using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Rendering.Universal;
using UnityEngine.UI;
using ReactUnity.UGUI;

[RequireComponent(typeof(Camera))]
public class AvatarPreviewController : MonoBehaviour
{
    public static AvatarPreviewController Instance { get; private set; }

    [Header("Render Target")]
    [SerializeField] private RenderTexture targetTexture;

    private Camera    _cam;
    private Transform _avatarRoot;
    private Material  _skinMat;
    private int       _previewLayer;

    // ── Orbit state ───────────────────────────────────────────────────────────
    private Vector3 _pivot = new(0f, 0.835f, 0f);

    private float _azimuth   = 180f;
    private float _elevation = 8f;
    private float _distance  = 3.2f;

    private const float OrbitSensitivity = 0.35f;
    private const float ZoomSensitivity  = 0.008f;
    private const float MinElevation     = -20f;
    private const float MaxElevation     =  75f;
    private const float MinDistance      =  1.2f;
    private float       _maxDistance     =  4.5f;

    // ── Input-driven orbit ────────────────────────────────────────────────────
    private bool    _orbitActive        = false;
    private bool    _orbitIgnorePress   = false; // true when press started in drawer zone
    private Vector2 _lastMousePos       = Vector2.zero;

    // ── Drawer / camera shift ─────────────────────────────────────────────────
    private float _viewYShift      = 0f;
    private float _currentDrawerH  = 0f;
    private bool  _isAvatarVisible = false;
    private bool  _isPanelMode     = false;

    // ── Split-view column (tablet) ────────────────────────────────────────────
    // On iPad the wardrobe is a right-hand panel instead of a bottom drawer, so
    // the chibi gets a left-hand column rather than the whole screen. React
    // reports that column's edges once and everything downstream — RawImage
    // clip, camera framing, orbit hit-testing — works off these two fractions.
    // Distinct from _isPanelMode (ShowInRect), which freezes orbit and reframes
    // for a small static profile thumbnail.
    private bool  _regionActive = false;
    private float _regionXMin   = 0f;
    private float _regionXMax   = 1f;

    // Reference-pixel constants (must match CanvasScaler referenceResolution.y = 844)
    private const float RefScreenH       = 844f;
    private const float NavHeightPx      = 60f;
    private const float HandleHeightPx   = 28f;

    // Drawer snap heights (must match InventoryDrawer.tsx constants)
    private const float DrawerHalfPx    = 380f;
    private const float DrawerFullPx    = 660f;

    // Camera at drawer = 0: full-body view — set dynamically by FitCameraToAvatar()
    private float _baseDistance    = 3.2f;
    private float _baseViewShift   = 0f;

    // Camera at drawer = HALF: zoom out so full avatar fits in top 50% of screen.
    // Both values are recomputed in FitCameraToAvatar(); these are safe fallbacks.
    private float _portraitDist   = 5.0f;  // distance when drawer is half-open
    private float _halfSheetShift = -0.9f; // view Y shift when drawer is half-open (aim toward feet)

    // ── Blob shadow ───────────────────────────────────────────────────────────
    private Transform _blobShadow;

    // ── Idle pose source ──────────────────────────────────────────────────────
    // idle.fbx has no Armature parent (bones at root level), while torso.fbx
    // puts bones under an Armature node. Animation curves from idle.fbx look for
    // "mixamorig:Hips" at the animator root, but in torso.fbx they live at
    // "Armature/mixamorig:Hips" — path mismatch → T-pose. Fix: drive the
    // Animator on idle.fbx's own hierarchy (where paths DO match), then copy
    // each bone's localRotation to the chibi skeleton by bone name each LateUpdate.
    private GameObject _idlePoseSource;
    private Dictionary<string, Transform> _idleSourceBones;
    private Dictionary<string, Transform> _chibiTargetBones;

    // ── Avatar-specific lights ────────────────────────────────────────────────
    private readonly List<Light> _avatarLights = new();

    // ── Overlay canvas ────────────────────────────────────────────────────────
    private GameObject    _overlayCanvas;
    private RawImage      _overlayRawImage;
    private RectTransform _overlayRawRect;

    // ── Item overlay quads ────────────────────────────────────────────────────
    private readonly Dictionary<string, GameObject> _itemQuads = new();
    private readonly Dictionary<string, Texture2D>  _texCache  = new();

    // Root is rotated Euler(0,90,0): local +X → world -Z (toward camera).
    // Slot offsets use local X for depth (positive = toward camera, negative = behind)
    // and local Z for left/right.
    private static readonly Dictionary<string, Vector3> SlotOffsets = new()
    {
        { "Head",    new Vector3( 0.05f, 1.55f, 0f) },
        { "Hair",    new Vector3( 0.05f, 1.85f, 0f) },
        { "Face",    new Vector3( 0.20f, 1.55f, 0f) },
        { "Faces",   new Vector3( 0.20f, 1.55f, 0f) },
        { "Neck",    new Vector3( 0.10f, 1.18f, 0f) },
        { "Front",   new Vector3( 0.25f, 0.85f, 0f) },
        { "Back",    new Vector3(-0.25f, 0.85f, 0f) },
        { "Waist",   new Vector3( 0.22f, 0.55f, 0f) },
        { "Tops",    new Vector3( 0.22f, 0.85f, 0f) },
        { "Bottoms", new Vector3( 0.20f, 0.28f, 0f) },
        { "Shoes",   new Vector3( 0.18f,-0.18f, 0f) },
    };

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private void Awake()
    {
        Instance = this;
        _cam = GetComponent<Camera>();
        _previewLayer = LayerMask.NameToLayer("AvatarPreview");
        if (_previewLayer < 0) _previewLayer = 0;

        EnsureRenderTexture();
        _cam.targetTexture   = targetTexture;
        _cam.clearFlags      = CameraClearFlags.SolidColor;
        _cam.backgroundColor = new Color(0f, 0f, 0f, 0f); // transparent — React UI bg shows through
        _cam.cullingMask     = (_previewLayer == 0) ? _cam.cullingMask : (1 << _previewLayer);
        _cam.depth           = -10;
        _cam.orthographic    = false;
        _cam.fieldOfView     = 50f;
        _cam.aspect          = (float)targetTexture.width / targetTexture.height;

        var urpData = _cam.gameObject.GetComponent<UniversalAdditionalCameraData>();
        if (urpData == null) urpData = _cam.gameObject.AddComponent<UniversalAdditionalCameraData>();
        urpData.renderType           = CameraRenderType.Base;
        urpData.renderPostProcessing = true;

        ApplyOrbit();
    }

    private IEnumerator Start()
    {
        // Re-acquire _cam in case a domain reload reset it between Awake and Start.
        if (_cam == null)
        {
            _cam = GetComponent<Camera>();
            if (_cam != null)
            {
                EnsureRenderTexture();
                _cam.targetTexture   = targetTexture;
                _cam.clearFlags      = CameraClearFlags.SolidColor;
                _cam.backgroundColor = new Color(0f, 0f, 0f, 0f); // transparent
                _cam.depth           = -10;
                _cam.orthographic    = false;
                _cam.fieldOfView     = 50f;
                _cam.aspect          = (float)targetTexture.width / targetTexture.height;
                var urpData = _cam.gameObject.GetComponent<UnityEngine.Rendering.Universal.UniversalAdditionalCameraData>();
                if (urpData == null) urpData = _cam.gameObject.AddComponent<UnityEngine.Rendering.Universal.UniversalAdditionalCameraData>();
                urpData.renderType           = UnityEngine.Rendering.Universal.CameraRenderType.Base;
                urpData.renderPostProcessing = false;
            }
        }
        if (_previewLayer <= 0)
        {
            _previewLayer = LayerMask.NameToLayer("AvatarPreview");
            if (_previewLayer < 0) _previewLayer = 0;
            if (_cam != null)
                _cam.cullingMask = (_previewLayer == 0) ? _cam.cullingMask : (1 << _previewLayer);
        }

        // Wait two frames for ReactUnity to finish its first render and
        // register its renderer before we try to set Globals.
        yield return null;
        yield return null;

        yield return BuildChibiAvatar();

        SetupAvatarLighting();
        SetupOverlayCanvas();
        RegisterGlobals();

        if (AvatarStateManager.Instance != null)
        {
            AvatarStateManager.Instance.OnAvatarChanged += OnAvatarChanged;
            OnAvatarChanged(AvatarStateManager.Instance.Avatar);
        }
    }

    private void OnEnable()
    {
        if (_cam != null && targetTexture != null)
            _cam.targetTexture = targetTexture;

        // URP does not call MonoBehaviour.OnPreRender/OnPostRender.  Use the
        // render pipeline manager events instead so shadow-distance zeroing works.
        UnityEngine.Rendering.RenderPipelineManager.beginCameraRendering += OnBeginCameraRendering;
        UnityEngine.Rendering.RenderPipelineManager.endCameraRendering   += OnEndCameraRendering;
    }

    private void OnDisable()
    {
        UnityEngine.Rendering.RenderPipelineManager.beginCameraRendering -= OnBeginCameraRendering;
        UnityEngine.Rendering.RenderPipelineManager.endCameraRendering   -= OnEndCameraRendering;
    }

    private void OnDestroy()
    {
        if (Instance == this) Instance = null;
        if (AvatarStateManager.Instance != null)
            AvatarStateManager.Instance.OnAvatarChanged -= OnAvatarChanged;

        if (_idlePoseSource != null) Destroy(_idlePoseSource);
        if (_overlayCanvas != null) Destroy(_overlayCanvas);
        foreach (var l in _avatarLights)
            if (l != null) Destroy(l.gameObject);
        if (_cam != null) _cam.targetTexture = null;
        if (RenderTexture.active == targetTexture) RenderTexture.active = null;
        if (targetTexture != null && !Application.isEditor)
            Destroy(targetTexture);
    }

    // ── Overlay canvas setup ──────────────────────────────────────────────────

    private void SetupOverlayCanvas()
    {
        // Rebuild RT now that Screen.width/height are reliable (Awake runs too early).
        EnsureRenderTexture();
        _cam.targetTexture = targetTexture;
        _cam.aspect        = (float)targetTexture.width / targetTexture.height;

        // Exclude AvatarPreview layer from every other camera so the chibi
        // only appears through the RT overlay, never in the main scene view.
        if (_previewLayer > 0)
        {
            foreach (var cam in FindObjectsByType<Camera>())
            {
                if (cam == _cam) continue;
                cam.cullingMask &= ~(1 << _previewLayer);
            }
        }

        // Screen-space overlay canvas sitting above the React canvas (order 10).
        _overlayCanvas = new GameObject("AvatarPreviewCanvas");
        var canvas = _overlayCanvas.AddComponent<Canvas>();
        canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 11;
        // canvas ref stored in _overlayCanvas GameObject; no separate field needed

        var scaler = _overlayCanvas.AddComponent<CanvasScaler>();
        scaler.uiScaleMode         = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(390, 844);
        scaler.screenMatchMode     = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight  = 0.5f;

        var rawGO = new GameObject("AvatarPreviewImage");
        rawGO.transform.SetParent(_overlayCanvas.transform, false);
        var raw = rawGO.AddComponent<RawImage>();
        raw.texture       = targetTexture;
        raw.raycastTarget = false;
        raw.color         = Color.white;
        _overlayRawImage  = raw;

        var rect = rawGO.GetComponent<RectTransform>();
        rect.anchorMin    = Vector2.zero;
        rect.anchorMax    = Vector2.one;
        rect.offsetMin    = Vector2.zero;
        rect.offsetMax    = Vector2.zero;
        _overlayRawRect   = rect;

        // Overlay canvas hidden by default — React calls setAvatarVisible(true) on the You tab.
        // Camera stays enabled so the RT continues rendering for UI Toolkit background display.
        _overlayCanvas.SetActive(false);
    }

    // ── Avatar-dedicated lighting ─────────────────────────────────────────────
    // Matches the Three.js lighting in gameforgeai/src/components/avatar-3d.tsx:
    //   HemisphereLight sky=#4466bb ground=#331144 @ 0.55
    //   DirectionalLight (key)  pos=[4,8,5]  color=#fff5e0 @ 1.8
    //   DirectionalLight (fill) pos=[-5,3,-6] color=#4488ff @ 0.9
    //   PointLight (rim)        pos=[0,-0.5,2] color=#ffd9b3 @ 0.25

    private void SetupAvatarLighting()
    {
        if (_previewLayer <= 0) return;

        // Exclude all scene lights from the avatar preview layer.
        foreach (var l in FindObjectsByType<Light>())
            l.cullingMask &= ~(1 << _previewLayer);

        // ── Key light: front-left-above, warm white, soft shadows ────────────
        // Shadow strength 0.75 prevents pitch-black shadows (Roblox style).
        var key = MakeAvatarLight("AvatarKeyLight",
            pos:       new Vector3(-3f, 6f, -5f),
            color:     new Color(1.00f, 0.97f, 0.90f),
            intensity: 1.6f,
            shadows:   LightShadows.Soft);
        key.shadowStrength   = 0.72f;
        key.shadowNormalBias = 0.4f;
        key.shadowBias       = 0.05f;
        _avatarLights.Add(key);

        // ── Fill light: front-right, soft blue-grey, lifts dark side ─────────
        _avatarLights.Add(MakeAvatarLight("AvatarFillLight",
            pos:       new Vector3(5f, 3f, -4f),
            color:     new Color(0.82f, 0.88f, 1.00f),
            intensity: 0.55f,
            shadows:   LightShadows.None));

        // ── Rim light: behind, slightly warm, creates edge separation ─────────
        _avatarLights.Add(MakeAvatarLight("AvatarRimLight",
            pos:       new Vector3(0f, 5f, 5f),
            color:     new Color(0.95f, 0.95f, 1.00f),
            intensity: 0.45f,
            shadows:   LightShadows.None));

        // ── Top/under-fill: subtle warm ambient from below to kill black crevices
        _avatarLights.Add(MakeAvatarLight("AvatarUnderFill",
            pos:       new Vector3(0f, -3f, -3f),
            color:     new Color(0.90f, 0.85f, 0.78f),
            intensity: 0.25f,
            shadows:   LightShadows.None));

        SetupAvatarPostProcessing();
    }

    private Light MakeAvatarLight(string name, Vector3 pos, Color color, float intensity, LightShadows shadows)
    {
        var go = new GameObject(name);
        go.transform.position = pos;
        go.transform.LookAt(Vector3.zero);
        var l = go.AddComponent<Light>();
        l.type        = LightType.Directional;
        l.color       = color;
        l.intensity   = intensity;
        l.shadows     = shadows;
        l.cullingMask = 1 << _previewLayer;
        return l;
    }

    private void SetupAvatarPostProcessing()
    {
        var volGO = new GameObject("AvatarPostProcessVolume");
        volGO.layer = _previewLayer;

        var vol = volGO.AddComponent<UnityEngine.Rendering.Volume>();
        vol.isGlobal  = true;
        vol.priority  = 100;
        vol.profile   = ScriptableObject.CreateInstance<UnityEngine.Rendering.VolumeProfile>();

        // ACES Tonemapping — gives the "filmic/clean Roblox pop" to colors.
        var tm = vol.profile.Add<UnityEngine.Rendering.Universal.Tonemapping>(true);
        tm.active      = true;
        tm.mode.value  = UnityEngine.Rendering.Universal.TonemappingMode.ACES;

        // Color Adjustments — mild contrast + saturation, no exposure shift.
        var ca = vol.profile.Add<UnityEngine.Rendering.Universal.ColorAdjustments>(true);
        ca.active              = true;
        ca.contrast.value      = 8f;   // gentle contrast (not black-crushing)
        ca.saturation.value    = 10f;
        ca.postExposure.value  = 0f;

        // Subtle vignette — pulls eye to center.
        var vignette = vol.profile.Add<UnityEngine.Rendering.Universal.Vignette>(true);
        vignette.active           = true;
        vignette.intensity.value  = 0.25f;
        vignette.smoothness.value = 0.6f;

        // Bloom — soft gleam on specular highlights.
        var bloom = vol.profile.Add<UnityEngine.Rendering.Universal.Bloom>(true);
        bloom.active          = true;
        bloom.threshold.value = 0.9f;
        bloom.intensity.value = 0.35f;
        bloom.scatter.value   = 0.4f;

        // RT camera picks up only the avatar volume (not the global one).
        if (_cam != null)
        {
            var urpData = _cam.GetComponent<UniversalAdditionalCameraData>();
            if (urpData != null)
                urpData.volumeLayerMask = 1 << _previewLayer;
        }

        // Prevent main camera from picking up the avatar volume.
        var mainCam = Camera.main;
        if (mainCam != null && mainCam != _cam)
        {
            var mainUrp = mainCam.GetComponent<UniversalAdditionalCameraData>();
            if (mainUrp != null)
                mainUrp.volumeLayerMask &= ~(1 << _previewLayer);
        }
    }

    private void RegisterGlobals()
    {
        var renderers = FindObjectsByType<ReactRendererUGUI>();
        if (renderers.Length == 0)
        {
            Debug.LogWarning("[AvatarPreviewController] No ReactRendererUGUI found — Globals not registered");
            return;
        }

        foreach (var r in renderers)
        {
            RegisterGlobalsOn(r);
            // Re-register after every JS context restart (hot-reload, scene re-enter).
            r.AdvancedOptions.AfterStart.AddListener(() => RegisterGlobalsOn(r));
        }
        Debug.Log($"[AvatarPreviewController] Globals registered on {renderers.Length} renderer(s)");
    }

    private void RegisterGlobalsOn(ReactRendererUGUI r)
    {
        r.Globals["setAvatarVisible"]      = new Action<bool>(SetVisible);
        r.Globals["showAvatarInRect"]      = new Action<float, float, float, float>(ShowInRect);
        r.Globals["resetAvatarFullscreen"] = new Action(ResetToFullscreen);
        r.Globals["orbitAvatar"]           = new Action<float, float>(OrbitDelta);
        r.Globals["setOrbitActive"]        = new Action<bool>(SetOrbitActive);
        r.Globals["setDrawerOpen"]         = new Action<bool>(SetDrawerOpen);
        r.Globals["setDrawerHeight"]       = new Action<float>(SetDrawerHeight);
        r.Globals["setAvatarRegion"]       = new Action<float, float>(SetAvatarRegion);
        r.Globals["clearAvatarRegion"]     = new Action(ClearAvatarRegion);
        // Pointer position helpers — lets React read raw pointer coords for drag math.
        r.Globals["getPointerY"]     = new Func<float>(GetCurrentPointerY);
        r.Globals["getPointerX"]     = new Func<float>(GetCurrentPointerX);
        r.Globals["getScreenHeight"] = new Func<float>(() => Screen.height);
        // Canvas size in React reference units. One axis is pinned by the
        // scaler and the other floats (which axis depends on idiom+orientation),
        // so React cannot derive these from the 390×844 / 844×390 constants —
        // anything sizing or converting against the canvas must read them live.
        r.Globals["getRefScreenWidth"] = new Func<float>(() =>
        {
            float scale = RefToScreenScale();
            return scale > 0f ? Screen.width / scale : 390f;
        });
        r.Globals["getRefScreenHeight"] = new Func<float>(() =>
        {
            float scale = RefToScreenScale();
            return scale > 0f ? Screen.height / scale : 844f;
        });
        r.Globals["getKeyboardHeight"] = new Func<float>(() =>
        {
#if UNITY_EDITOR || UNITY_STANDALONE
            return 0f;
#else
            var kbRect = TouchScreenKeyboard.area;
            if (kbRect.height <= 0f) return 0f;
            float scaleFactor = RefToScreenScale();
            return scaleFactor > 0f ? kbRect.height / scaleFactor : 0f;
#endif
        });
        r.Globals["openUrl"]         = new Action<string>(url => Application.OpenURL(url));
        r.Globals["apiBaseUrl"]      = PludoApiClient.BaseUrl;
    }

    public void SetVisible(bool visible)
    {
        if (visible)
        {
            // Reset to front-facing view every time the avatar tab opens,
            // regardless of how the user left it rotated.
            _azimuth   = 180f;
            _elevation = 8f;
            _distance  = _baseDistance;
            _viewYShift = _baseViewShift;
            RecomputePivot();
        }

        _isAvatarVisible = visible;
        if (_cam != null) _cam.enabled = visible;
        if (_overlayCanvas != null)
        {
            bool show = visible && _currentDrawerH < DrawerFullPx - 30f;
            _overlayCanvas.SetActive(show);
            if (show)
            {
                // Clip the nav bar immediately so it isn't covered on first show.
                // Split view clips sideways instead — nothing sits below the column.
                float yMin = _regionActive
                    ? 0f
                    : Mathf.Clamp01((NavHeightPx + HandleHeightPx + _currentDrawerH) / RefScreenH);
                ApplyRawImageRect(yMin);
            }
        }
        SetOrbitActive(visible);  // calls ApplyOrbit() with the reset azimuth=0
    }

    // Constrains the avatar camera to a normalized screen rectangle so the chibi
    // appears only within the profile-panel avatar frame (not fullscreen).
    // xNorm/yNorm: bottom-left of rect in [0,1] screen-normalized coords (Y-up).
    // wNorm/hNorm: width/height in the same space.
    // Camera distance/framing used when showing in the profile panel rectangle.
    // dist=2.4 fills ~80% of the rect height with the full body at FOV=50°.
    private const float PanelDist      = 2.4f;
    private const float PanelViewShift = 0f;

    private void ShowInRect(float xNorm, float yNorm, float wNorm, float hNorm)
    {
        _isPanelMode     = true;
        _isAvatarVisible = true;
        // Panel mode does its own camera.rect clipping and drives the RawImage
        // back to fullscreen below, so any split-view column must be dropped or
        // the two clip models fight over the same RawImage anchors.
        _regionActive    = false;
        _regionXMin      = 0f;
        _regionXMax      = 1f;

        if (_cam != null)
        {
            // Confine rendering to the rectangle. Unity maps camera.rect into the
            // render target using its normalized [0,1] coordinates.
            _cam.rect    = new Rect(xNorm, yNorm, wNorm, hNorm);
            // Correct aspect: pixel_w/pixel_h = (wNorm * sw) / (hNorm * sh)
            //                                 = (wNorm / hNorm) * (RT.w / RT.h)
            _cam.aspect  = (wNorm / hNorm) * ((float)targetTexture.width / targetTexture.height);
            _cam.enabled = true;

            // Clear the whole RT to transparent so areas outside camera.rect are empty.
            var prev = RenderTexture.active;
            RenderTexture.active = targetTexture;
            GL.Clear(true, true, Color.clear);
            RenderTexture.active = prev;
        }

        // Zoom in to fill the rectangle with the full body, pivot at avatar center.
        RecomputePivot();
        _viewYShift = PanelViewShift;
        _distance   = PanelDist;
        ApplyOrbit();

        // RawImage stays fullscreen — transparent outside the rect because the
        // camera only renders within camera.rect (background is transparent Color).
        if (_overlayRawRect != null)
        {
            _overlayRawRect.anchorMin = Vector2.zero;
            _overlayRawRect.anchorMax = Vector2.one;
            _overlayRawRect.offsetMin = Vector2.zero;
            _overlayRawRect.offsetMax = Vector2.zero;
            if (_overlayRawImage != null)
                _overlayRawImage.uvRect = new Rect(0f, 0f, 1f, 1f);
        }

        if (_overlayCanvas != null) _overlayCanvas.SetActive(true);
        SetOrbitActive(false);
    }

    // Restores fullscreen camera mode after ShowInRect.
    private void ResetToFullscreen()
    {
        _isPanelMode = false;

        if (_cam != null)
        {
            _cam.rect   = new Rect(0f, 0f, 1f, 1f);
            _cam.aspect = (float)targetTexture.width / targetTexture.height;
        }

        SetVisible(false);
    }

    // ── Orbit camera ──────────────────────────────────────────────────────────

    public void OrbitDelta(float dxPx, float dyPx = 0f)
    {
        _azimuth += dxPx * OrbitSensitivity;
        ApplyOrbit();
    }

    public void ZoomDelta(float deltaPx)
    {
        _distance = Mathf.Clamp(_distance - deltaPx * ZoomSensitivity,
                                MinDistance, _maxDistance);
        ApplyOrbit();
    }

    private void ApplyOrbit()
    {
        var rot      = Quaternion.Euler(_elevation, _azimuth, 0f);
        // Aim point and camera position are offset by the SAME vector, so this
        // is a pure translation of the view — LookAt still reproduces `rot`.
        var aimPoint = _pivot
                     + new Vector3(0f, _viewYShift, 0f)
                     + rot * new Vector3(ViewXShift(), 0f, 0f);
        transform.position = aimPoint + rot * new Vector3(0f, 0f, -_distance);
        transform.LookAt(aimPoint, Vector3.up);
        UpdateShadowProjection();
    }

    // World-space sideways offset of the aim point that lands the avatar in the
    // middle of the visible column rather than the middle of the screen.
    // Shifting the aim by -d moves the subject +d in frame — the same
    // relationship _viewYShift relies on for the drawer clip.
    private float ViewXShift()
    {
        if (!_regionActive || _cam == null) return 0f;
        float centerOffset = (_regionXMin + _regionXMax) * 0.5f - 0.5f;
        float tanHalfFov   = Mathf.Tan(_cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float halfWidth    = _distance * tanHalfFov * _cam.aspect;
        return -2f * centerOffset * halfWidth;
    }

    // Place shadow at the avatar's renderer-bounds center XZ, on the floor plane.
    private void UpdateShadowProjection()
    {
        if (_blobShadow == null || _avatarRoot == null) return;
        _blobShadow.position = new Vector3(_pivot.x, 0.01f, _pivot.z);
    }

    // Called by React on every drag-move and animation tick with the current
    // drawer panel height in reference pixels.
    public void SetDrawerHeight(float heightPx)
    {
        // Split view replaces the drawer with a side panel — a stray height push
        // from a stale timer must not re-clip the column or re-aim the camera.
        if (_isPanelMode || _regionActive) return;
        _currentDrawerH = heightPx;

        // Clip RawImage to only cover the screen area above the drawer.
        float yMin = Mathf.Clamp01((NavHeightPx + HandleHeightPx + heightPx) / RefScreenH);
        ApplyRawImageRect(yMin);

        // Enable camera/overlay if the drawer isn't fully covering the screen AND
        // either the drawer is actually open (heightPx > 0) or the user is on the
        // avatar tab (_isAvatarVisible).  The heightPx > 0 arm is needed because
        // React calls setAvatarVisible(false) just before opening the drawer, which
        // would otherwise leave the camera off while the avatar should be visible
        // above the panel.  The _isAvatarVisible arm keeps the full-body view alive
        // when the drawer is fully closed on the avatar tab.
        bool show = (heightPx < DrawerFullPx - 30f) && (heightPx > 0f || _isAvatarVisible);
        if (_cam != null)          _cam.enabled = show;
        if (_overlayCanvas != null) _overlayCanvas.SetActive(show);

        // Phase 0→HALF: interpolate from full-body view to half-sheet portrait view.
        float t     = Mathf.Clamp01(heightPx / DrawerHalfPx);
        _viewYShift = Mathf.Lerp(_baseViewShift, _halfSheetShift, t);
        _distance   = Mathf.Lerp(_baseDistance,  _portraitDist,   t);
        ApplyOrbit();
    }

    // Legacy toggle — kept so old React code that only signals open/closed still
    // works; full height management is now handled by SetDrawerHeight.
    public void SetDrawerOpen(bool drawerOpen)
    {
        SetDrawerHeight(drawerOpen ? 380f : 0f);
    }

    // Reference-px → screen-px scale factor for the React canvas, so React can
    // hand us plain reference pixels and stay ignorant of the real resolution.
    // Delegates to GameLauncher's copy rather than repeating the CanvasScaler
    // formula — the two must agree or safe-area insets and avatar-column edges
    // would land in different coordinate spaces.
    private static float RefToScreenScale() => GameLauncher.GetReactCanvasScale();

    // Confines the chibi to a vertical column of the screen, given as reference-px
    // insets from the left and right screen edges — the tablet split view, where
    // the nav rail eats the left edge and the wardrobe panel the right. Unlike
    // ShowInRect this keeps full-height framing and live orbit; it only narrows
    // the column the avatar is centred in.
    public void SetAvatarRegion(float leftRefPx, float rightRefPx)
    {
        if (_isPanelMode) return;

        float scale = RefToScreenScale();
        float sw    = Mathf.Max(1, Screen.width);
        float xMin  = Mathf.Clamp01(leftRefPx * scale / sw);
        float xMax  = Mathf.Clamp01(1f - rightRefPx * scale / sw);
        // Guard against a first-paint frame where React's width read is still
        // stale — clipping to a sliver would hide the avatar entirely.
        if (xMax - xMin < 0.1f) return;
        if (_regionActive && Mathf.Abs(xMin - _regionXMin) < 0.001f
                          && Mathf.Abs(xMax - _regionXMax) < 0.001f) return;

        _regionActive   = true;
        _regionXMin     = xMin;
        _regionXMax     = xMax;
        _currentDrawerH = 0f;   // the bottom drawer doesn't exist in split view

        ApplyRawImageRect(0f);
        RecomputePivot();
        FitCameraToAvatar();
        ApplyOrbit();
    }

    // Returns the chibi to full-screen framing (phone drawer layout, or the
    // avatar tab being torn down). Safe to call when no region is set.
    public void ClearAvatarRegion()
    {
        if (!_regionActive) return;
        _regionActive = false;
        _regionXMin   = 0f;
        _regionXMax   = 1f;

        ApplyRawImageRect(Mathf.Clamp01((NavHeightPx + HandleHeightPx + _currentDrawerH) / RefScreenH));
        FitCameraToAvatar();
        ApplyOrbit();
    }

    // Called by AvatarScreenController as the wardrobe sheet moves.
    // t=0: sheet peeked (full-body centred view), t=1: sheet at half-open (avatar in top half).
    public void NotifySheetFraction(float t)
    {
        _viewYShift = Mathf.Lerp(_baseViewShift, _halfSheetShift, t);
        _distance   = Mathf.Lerp(_baseDistance,  _portraitDist,   t);
        ApplyOrbit();
    }

    private void ApplyRawImageRect(float yMin)
    {
        if (_overlayRawRect == null || _overlayRawImage == null) return;
        // In split view the visible strip is also narrowed horizontally so the
        // RT can't paint over the wardrobe panel or the nav rail.
        float xMin = _regionActive ? _regionXMin : 0f;
        float xMax = _regionActive ? _regionXMax : 1f;
        _overlayRawRect.anchorMin = new Vector2(xMin, yMin);
        _overlayRawRect.anchorMax = new Vector2(xMax, 1f);
        _overlayRawRect.offsetMin = Vector2.zero;
        _overlayRawRect.offsetMax = Vector2.zero;
        // UV rect: show only the portion of the RT that maps to the visible area
        // (1:1 pixel mapping, no distortion).
        _overlayRawImage.uvRect   = new Rect(xMin, yMin, xMax - xMin, 1f - yMin);
    }

    public void SetOrbitActive(bool active)
    {
        _orbitActive = active;
        if (!active) return;

        RecomputePivot();
        ApplyOrbit();

#if ENABLE_INPUT_SYSTEM
        var pointer = UnityEngine.InputSystem.Pointer.current;
        _lastMousePos = pointer != null ? pointer.position.ReadValue() : Vector2.zero;
#else
        _lastMousePos = Input.mousePosition;
#endif
    }

    private void Update()
    {
        // Sync camera aspect to current screen to prevent vertical squishing.
        // The RT may have been created before Screen dims were reliable (e.g. landscape
        // Game View at Awake time), so we correct it on the first frame it's wrong.
        if (_cam != null && _cam.enabled && !_isPanelMode && Screen.width > 0 && Screen.height > 0)
        {
            float targetAspect = (float)Screen.width / Screen.height;
            if (Mathf.Abs(_cam.aspect - targetAspect) > 0.005f)
            {
                EnsureRenderTexture();
                _cam.targetTexture = targetTexture;
                _cam.aspect        = (float)targetTexture.width / targetTexture.height;
                FitCameraToAvatar(); // reframe for the new viewport aspect ratio
                ApplyOrbit();
            }
        }

        if (!_orbitActive) return;

#if ENABLE_INPUT_SYSTEM
        // Pointer.current covers Mouse, Touchscreen, and Pen — works on all platforms.
        var pointer = UnityEngine.InputSystem.Pointer.current;
        if (pointer == null) return;

        Vector2 current    = pointer.position.ReadValue();
        bool    buttonDown = pointer.press.wasPressedThisFrame;
        bool    buttonHeld = pointer.press.isPressed;
#else
        Vector2 current    = Input.mousePosition;
        bool    buttonDown = Input.GetMouseButtonDown(0);
        bool    buttonHeld = Input.GetMouseButton(0);
#endif

        if (buttonDown)
        {
            if (_regionActive)
            {
                // Split view: only drags starting inside the chibi column orbit,
                // so scrolling the wardrobe grid or tapping the nav rail doesn't
                // spin the avatar behind them.
                float xFrac = current.x / Mathf.Max(1, Screen.width);
                _orbitIgnorePress = xFrac < _regionXMin || xFrac > _regionXMax;
            }
            else
            {
                // Exclude the drawer area (handle + current panel height) from orbit.
                float drawerTopFrac = Mathf.Clamp01(
                    (NavHeightPx + HandleHeightPx + _currentDrawerH) / RefScreenH);
                _orbitIgnorePress = current.y < Screen.height * drawerTopFrac;
            }
            _lastMousePos = current;
            return;
        }

        if (buttonHeld && !_orbitIgnorePress)
        {
            Vector2 delta = current - _lastMousePos;
            if (Mathf.Abs(delta.x) > 0f)
                OrbitDelta(delta.x, 0f);   // horizontal rotation only
            _lastMousePos = current;
        }
    }

    // ── RenderTexture ─────────────────────────────────────────────────────────

    private void EnsureRenderTexture()
    {
        int rtW = 512;
        int rtH = (Screen.height > 0 && Screen.width > 0)
            ? Mathf.Max(512, Mathf.RoundToInt(rtW * (float)Screen.height / Screen.width))
            : 1109;

        if (targetTexture != null &&
            targetTexture.width  == rtW &&
            targetTexture.height == rtH &&
            targetTexture.IsCreated()) return;

        if (targetTexture != null) targetTexture.Release();

        // Ask the GPU what it can actually do. Hard-coding 2x MSAA broke the iOS
        // Simulator: Metal there silently creates the RT with 1 sample while URP
        // still requests 2 ("Attachment 0 was created with 1 samples but 2
        // samples were requested"), so the avatar pass rendered nothing.
        var desc = new RenderTextureDescriptor(rtW, rtH, RenderTextureFormat.ARGB32, 24) { msaaSamples = 2 };
        int samples = Mathf.Max(1, SystemInfo.GetRenderTextureSupportedMSAASampleCount(desc));

        targetTexture = new RenderTexture(rtW, rtH, 24, RenderTextureFormat.ARGB32)
        {
            name         = "AvatarPreviewRT",
            antiAliasing = samples,
        };
        targetTexture.Create();

        // The overlay RawImage must follow the new RT. Update() recreates the
        // RT whenever the screen aspect changes; without this the overlay kept
        // sampling the released texture and showed a blank grey frame (hit in
        // the native shell, where Unity's view starts 1x1 and is then resized).
        if (_overlayRawImage != null) _overlayRawImage.texture = targetTexture;
    }

    public RenderTexture GetRenderTexture() => targetTexture;

    public void ResetView()
    {
        _azimuth   = 180f;
        _elevation = 8f;
        _distance  = _baseDistance;
        RecomputePivot();
        ApplyOrbit();
    }

    // ── Camera fitting ────────────────────────────────────────────────────────

    // Computes _baseDistance and _baseViewShift so the full avatar body fits in the
    // VISIBLE portion of the RT (above the nav bar + drawer handle clip zone).
    // Must be called after AlignFeetToGround() and RecomputePivot() so bounds are settled.
    private void FitCameraToAvatar()
    {
        if (_avatarRoot == null || _cam == null) return;
        bool first = true;
        Bounds combined = default;
        foreach (var r in _avatarRoot.GetComponentsInChildren<Renderer>())
        {
            if (r.gameObject.name.StartsWith("ItemQuad_") || r.gameObject.name == "BlobShadow") continue;
            if (first) { combined = r.bounds; first = false; }
            else combined.Encapsulate(r.bounds);
        }
        if (first) return;

        // The RawImage bottom is clipped at yMin to avoid covering the nav + handle.
        // Scale the padding factor so the avatar fits within the visible area [yMin, 1].
        // Split view has no bottom drawer, so nothing is clipped off the bottom there.
        float clipFrac      = _regionActive ? 0f : (NavHeightPx + HandleHeightPx) / RefScreenH; // ≈ 0.104
        float effectivePad  = 1.35f / (1f - clipFrac); // padding within the visible strip
        float halfFovRad    = _cam.fieldOfView * 0.5f * Mathf.Deg2Rad;
        float tanHalfFov    = Mathf.Tan(halfFovRad);
        float fitDist       = (combined.size.y * 0.5f / tanHalfFov) * effectivePad;

        // In split view the column is only a fraction of the screen wide, so the
        // body can overflow horizontally long before it overflows vertically.
        // Take whichever constraint needs the camera further back.
        if (_regionActive)
        {
            float colAspect = _cam.aspect * Mathf.Max(0.01f, _regionXMax - _regionXMin);
            float widthDist = (combined.size.x * 0.5f / (tanHalfFov * colAspect)) * effectivePad;
            fitDist = Mathf.Max(fitDist, widthDist);
        }

        _baseDistance       = Mathf.Max(fitDist, 1.5f);
        _distance           = _baseDistance;

        // Half-sheet: avatar must fit in top 50% with ~10% headroom at top.
        // Aim at feet (NDC 0.5), head at NDC 0.9 → d = H / (2 * tanHalfFov * 0.4)
        _portraitDist   = Mathf.Max(combined.size.y / (2f * tanHalfFov * 0.4f), _baseDistance * 1.1f);
        _halfSheetShift = -(combined.size.y * 0.5f); // offset from pivot (center) down to feet
        _maxDistance    = _portraitDist * 1.15f;

        // Shift the aim point down so the avatar is centered in [yMin, 1] rather than [0, 1].
        // Negative _viewYShift lowers the aim → avatar moves upward in the frame.
        float halfVis       = _baseDistance * tanHalfFov;
        _baseViewShift      = -(clipFrac * halfVis);
        _viewYShift         = _baseViewShift;

        // Used to spew this every frame because FitCameraToAvatar runs from
        // the Update aspect-correction guard whenever the screen aspect drifts
        // by 0.005 (which happens constantly in landscape due to rounding).
        // The fit values are diagnostic, not load-bearing — log once per
        // distinct trio of values so we can still spot regressions without
        // drowning the Unity console at 30 lines/sec.
        var fitKey = $"{_baseDistance:F2}|{_portraitDist:F2}|{_baseViewShift:F2}";
        if (fitKey != _lastFitLogKey)
        {
            _lastFitLogKey = fitKey;
            Debug.Log($"[AvatarPreview] h={combined.size.y:F2} baseDist={_baseDistance:F2} shift={_baseViewShift:F2} portraitDist={_portraitDist:F2} halfShift={_halfSheetShift:F2}");
        }
    }
    private string _lastFitLogKey = "";

    // ── Chibi body assembly ───────────────────────────────────────────────────

    private static readonly string[] BodyPartNames = { "torso", "head", "left-arm", "right-arm", "left-leg", "right-leg" };

    private IEnumerator BuildChibiAvatar()
    {
        if (_avatarRoot != null) { Destroy(_avatarRoot.gameObject); _avatarRoot = null; }
        if (_idlePoseSource != null) { Destroy(_idlePoseSource); _idlePoseSource = null; }
        _idleSourceBones = null;
        _chibiTargetBones = null;

        var rootGO = new GameObject("ChibiRoot");
        rootGO.transform.position = Vector3.zero;
        rootGO.transform.rotation = Quaternion.identity;
        _avatarRoot = rootGO.transform;

        // Load all 6 body-part prefabs; fall back to chibi-base if any are missing.
        var prefabs = new GameObject[BodyPartNames.Length];
        bool allFound = true;
        for (int i = 0; i < BodyPartNames.Length; i++)
        {
            prefabs[i] = Resources.Load<GameObject>($"Avatar/{BodyPartNames[i]}");
            if (prefabs[i] != null) continue;
            Debug.LogWarning($"[AvatarPreview] Avatar/{BodyPartNames[i]} not found — falling back");
            allFound = false;
            break;
        }

        if (allFound)
            yield return BuildMultiPartAvatar(prefabs);
        else
            BuildChibiBaseFallback();

        yield return null;
        yield return null; // second frame: bone-driven bounds settle before pivot calc
        CreateSkinMaterial();
        AlignFeetToGround();
        CreateBlobShadow();
        DisableAvatarShadows();
        RecomputePivot();
        FitCameraToAvatar();
        ApplyOrbit();
    }

    // Instantiates all 6 body parts with shared skeleton (bone retargeting).
    // torso provides the master 65-bone Mixamo skeleton + Animator.
    // The remaining 5 parts have their SMR.bones remapped to the master skeleton
    // by name, then their duplicate skeletons are destroyed.
    private IEnumerator BuildMultiPartAvatar(GameObject[] prefabs)
    {
        // ── Master skeleton (torso, 65 Mixamo bones) ─────────────────────────
        var masterGO = Instantiate(prefabs[0], _avatarRoot);
        masterGO.name = "ChibiSkeleton";
        masterGO.transform.localPosition = Vector3.zero;
        masterGO.transform.localScale    = Vector3.one;
        SetLayer(masterGO, _previewLayer);

        var boneMap = new Dictionary<string, Transform>();
        foreach (var t in masterGO.GetComponentsInChildren<Transform>(true))
            if (!boneMap.ContainsKey(t.name)) boneMap[t.name] = t;

        // Save bone map for LateUpdate idle-pose copying.
        _chibiTargetBones = boneMap;

        // Disable the chibi's own Animator — pose is driven by _idlePoseSource via LateUpdate.
        var existingAnim = masterGO.GetComponent<Animator>();
        if (existingAnim != null) existingAnim.enabled = false;

        yield return SetupIdlePoseSource();

        // Master skeleton's own SMRs: mark updateWhenOffscreen so bounds stay current.
        foreach (var smr in masterGO.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            smr.updateWhenOffscreen = true;

        // ── Retarget remaining 5 parts onto master skeleton ──────────────────
        for (int i = 1; i < prefabs.Length; i++)
        {
            var partGO = Instantiate(prefabs[i]);
            partGO.transform.SetParent(_avatarRoot, false);
            partGO.transform.localPosition = Vector3.zero;

            foreach (var smr in partGO.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                var newBones = new Transform[smr.bones.Length];
                for (int b = 0; b < smr.bones.Length; b++)
                    newBones[b] = smr.bones[b] != null && boneMap.TryGetValue(smr.bones[b].name, out var mb) ? mb : smr.bones[b];
                smr.bones = newBones;

                if (smr.rootBone != null && boneMap.TryGetValue(smr.rootBone.name, out var mr))
                    smr.rootBone = mr;

                smr.transform.SetParent(masterGO.transform, false);
                smr.transform.localPosition = Vector3.zero;
                smr.updateWhenOffscreen = true;
                SetLayer(smr.gameObject, _previewLayer);
            }

            Destroy(partGO);
        }

        yield break;
    }

    private void BuildChibiBaseFallback()
    {
        var basePrefab = Resources.Load<GameObject>("Avatar/chibi-base");
        if (basePrefab != null)
        {
            var go = Instantiate(basePrefab, _avatarRoot);
            go.transform.localPosition = Vector3.zero;
            go.transform.localScale    = Vector3.one;
            SetLayer(go, _previewLayer);

            _chibiTargetBones = new Dictionary<string, Transform>();
            foreach (var t in go.GetComponentsInChildren<Transform>(true))
                if (!_chibiTargetBones.ContainsKey(t.name)) _chibiTargetBones[t.name] = t;

            var anim = go.GetComponent<Animator>();
            if (anim != null) anim.enabled = false;

            StartCoroutine(SetupIdlePoseSource());
        }
        else BuildPrimitiveFallback();
    }

    // Instantiates idle.fbx out-of-view, runs the idle Animator on its own
    // skeleton (where the animation curves match perfectly), and registers its
    // bone transforms for LateUpdate copying.
    private IEnumerator SetupIdlePoseSource()
    {
        if (_idlePoseSource != null) { Destroy(_idlePoseSource); _idlePoseSource = null; }

        var idlePrefab = Resources.Load<GameObject>("Avatar/idle");
        if (idlePrefab == null) yield break;

        _idlePoseSource = Instantiate(idlePrefab);
        _idlePoseSource.name = "IdleAnimSource";
        // Move far below the world — well outside any camera frustum.
        _idlePoseSource.transform.position = new Vector3(0f, -9000f, 0f);

        // Disable renderers so nothing is drawn; keep GameObjects active so Animator ticks.
        foreach (var r in _idlePoseSource.GetComponentsInChildren<Renderer>(true))
            r.enabled = false;

        foreach (var c in Resources.LoadAll<AnimationClip>("Avatar/idle"))
            if (c != null) c.wrapMode = WrapMode.Loop;

        var animCtrl = Resources.Load<RuntimeAnimatorController>("Avatar/AvatarIdleController");
        var anim = _idlePoseSource.GetComponent<Animator>();
        if (anim == null) anim = _idlePoseSource.AddComponent<Animator>();
        if (animCtrl != null) anim.runtimeAnimatorController = animCtrl;

        _idleSourceBones = new Dictionary<string, Transform>();
        foreach (var t in _idlePoseSource.GetComponentsInChildren<Transform>(true))
            if (!_idleSourceBones.ContainsKey(t.name)) _idleSourceBones[t.name] = t;

        yield break;
    }

    // Copy bone rotations from the idle source to the chibi skeleton by bone name.
    // Hips is the skeleton root. In idle.fbx it sits directly under the FBX root
    // (no Armature parent), so its localRotation is effectively a world rotation.
    // In torso.fbx an "Armature" node sits between the root and Hips and carries
    // a rotation offset (Blender→FBX Y-up correction). Copying localRotation for
    // Hips therefore brings that offset in and tips the whole body 90°.
    // Fix: convert Hips to world-space first, then back into torso.fbx's parent
    // space. For all bones below Hips the parent chain is identical in both FBX
    // files, so plain localRotation copying is correct.
    private void LateUpdate()
    {
        if (_idlePoseSource == null || _idleSourceBones == null || _chibiTargetBones == null) return;

        // ── Hips: world-rotation copy (cancels the Armature offset) ─────────
        const string hipsName = "mixamorig:Hips";
        if (_chibiTargetBones.TryGetValue(hipsName, out var hipsTarget) &&
            _idleSourceBones.TryGetValue(hipsName, out var hipsSrc) &&
            hipsTarget != null && hipsSrc != null)
        {
            var par = hipsTarget.parent;
            hipsTarget.localRotation = par != null
                ? Quaternion.Inverse(par.rotation) * hipsSrc.rotation
                : hipsSrc.rotation;
        }

        // ── All other bones: localRotation (same parent chain in both FBX files) ─
        foreach (var kv in _chibiTargetBones)
        {
            if (kv.Value == null || kv.Key == hipsName) continue;
            if (_idleSourceBones.TryGetValue(kv.Key, out var src) && src != null)
                kv.Value.localRotation = src.localRotation;
        }
    }

    private void DisableAvatarShadows()
    {
        if (_avatarRoot == null) return;
        foreach (var r in _avatarRoot.GetComponentsInChildren<Renderer>())
        {
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows    = false;
        }
    }

    private void RecomputePivot()
    {
        if (_avatarRoot == null) return;
        bool first = true;
        Bounds combined = default;
        foreach (var r in _avatarRoot.GetComponentsInChildren<Renderer>())
        {
            if (r.gameObject.name.StartsWith("ItemQuad_") ||
                r.gameObject.name == "BlobShadow") continue;
            if (first) { combined = r.bounds; first = false; }
            else combined.Encapsulate(r.bounds);
        }
        if (first) return;

        _pivot = combined.center;
    }

    private void BuildPrimitiveFallback()
    {
        var body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        body.layer = _previewLayer;
        body.transform.SetParent(_avatarRoot, false);
        body.transform.localPosition = new Vector3(0f, 0.6f, 0f);
        body.transform.localScale    = new Vector3(0.55f, 0.55f, 0.55f);
        Destroy(body.GetComponent<CapsuleCollider>());

        var head = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        head.layer = _previewLayer;
        head.transform.SetParent(_avatarRoot, false);
        head.transform.localPosition = new Vector3(0f, 1.55f, 0f);
        head.transform.localScale    = new Vector3(0.50f, 0.50f, 0.50f);
        Destroy(head.GetComponent<SphereCollider>());
    }

    // ── Feet alignment ───────────────────────────────────────────────────────

    private void AlignFeetToGround()
    {
        if (_avatarRoot == null) return;
        float minY = float.MaxValue;
        foreach (var r in _avatarRoot.GetComponentsInChildren<Renderer>())
        {
            if (r.gameObject.name == "BlobShadow" || r.gameObject.name.StartsWith("ItemQuad_")) continue;
            minY = Mathf.Min(minY, r.bounds.min.y);
        }
        if (minY < float.MaxValue && minY < 0f)
            _avatarRoot.position += Vector3.up * (-minY);
    }

    // ── Blob shadow ───────────────────────────────────────────────────────────

    private void CreateBlobShadow()
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
        go.name  = "BlobShadow";
        go.layer = _previewLayer;
        Destroy(go.GetComponent<MeshCollider>());

        // Unparented from avatarRoot so AlignFeetToGround lifting the root
        // doesn't carry the shadow up with it.  Position is set each frame
        // in ApplyOrbit via UpdateShadowProjection.
        go.transform.SetParent(null);
        go.transform.position  = new Vector3(0f, 0.01f, 0f);
        go.transform.rotation  = Quaternion.Euler(90f, 0f, 0f);
        go.transform.localScale = new Vector3(0.7f, 0.7f, 1f);
        _blobShadow = go.transform;

        var shader = Shader.Find("Universal Render Pipeline/Unlit")
                  ?? Shader.Find("Unlit/Transparent")
                  ?? Shader.Find("Sprites/Default");
        var mat = new Material(shader);

        // Enable alpha-blend transparency on URP Unlit
        if (mat.HasProperty("_Surface"))
        {
            mat.SetFloat("_Surface", 1f);
            mat.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            mat.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            mat.SetInt("_ZWrite", 0);
            mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
        }
        mat.renderQueue = 3000;

        var tex = CreateBlobTexture();
        if (mat.HasProperty("_BaseMap"))  mat.SetTexture("_BaseMap", tex);
        else                              mat.mainTexture = tex;

        var shadowColor = new Color(0f, 0f, 0f, 0.65f);
        if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", shadowColor);
        else                               mat.color = shadowColor;

        var rend = go.GetComponent<Renderer>();
        rend.material          = mat;
        rend.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        rend.receiveShadows    = false;
    }

    private static Texture2D CreateBlobTexture()
    {
        const int size = 64;
        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false)
        {
            filterMode = FilterMode.Bilinear,
            wrapMode   = TextureWrapMode.Clamp,
        };

        float half = size * 0.5f;
        for (int y = 0; y < size; y++)
        for (int x = 0; x < size; x++)
        {
            float dx   = (x - half) / half;
            float dy   = (y - half) / half;
            float dist = Mathf.Sqrt(dx * dx + dy * dy);
            // Quadratic falloff: fully opaque at centre, zero at radius 1
            float a = Mathf.Clamp01(1f - dist);
            a = a * a;
            tex.SetPixel(x, y, new Color(1f, 1f, 1f, a));
        }
        tex.Apply();
        return tex;
    }

    // ── Skin material ─────────────────────────────────────────────────────────

    private void CreateSkinMaterial()
    {
        // Physically-based lit: roughness ~0.92 (very matte skin), no metallic.
        var shader = Shader.Find("Universal Render Pipeline/Lit")
                  ?? Shader.Find("Standard");
        _skinMat = new Material(shader) { name = "ChibiSkinMat" };
        if (_skinMat.HasProperty("_Smoothness"))
            _skinMat.SetFloat("_Smoothness", 0.35f); // enough gloss for specular highlights
        if (_skinMat.HasProperty("_Metallic"))
            _skinMat.SetFloat("_Metallic", 0f);
        // Force opaque surface type on URP Lit
        if (_skinMat.HasProperty("_Surface"))
            _skinMat.SetFloat("_Surface", 0f);
        ApplyBodyColor("#D4A382");
    }

    public void ApplyBodyColor(string hex)
    {
        if (!ColorUtility.TryParseHtmlString(hex, out var c)) return;
        if (_skinMat != null)
        {
            _skinMat.color = c;
            if (_skinMat.HasProperty("_BaseColor")) _skinMat.SetColor("_BaseColor", c);
        }
        if (_avatarRoot == null) return;
        foreach (var r in _avatarRoot.GetComponentsInChildren<Renderer>())
        {
            if (r.gameObject.name.StartsWith("ItemQuad_") ||
                r.gameObject.name == "BlobShadow") continue;
            r.material = _skinMat;
        }
    }

    // ── Per-camera render callbacks (URP) ────────────────────────────────────

    private float                             _savedShadowDistance;
    private UnityEngine.Rendering.AmbientMode _savedAmbientMode;
    private Color                             _savedAmbientSky;
    private Color                             _savedAmbientEquator;
    private Color                             _savedAmbientGround;
    private Color                             _savedAmbientLight;

    private void OnBeginCameraRendering(
        UnityEngine.Rendering.ScriptableRenderContext ctx, Camera cam)
    {
        if (cam != _cam) return;
        _savedShadowDistance           = QualitySettings.shadowDistance;
        QualitySettings.shadowDistance = 0f;

        // Soft ambient lift: light grey-blue fills crevices so shadows never go pitch-black.
        // Matches the "atmosphere" fill used in the Roblox avatar editor.
        _savedAmbientMode    = RenderSettings.ambientMode;
        _savedAmbientSky     = RenderSettings.ambientSkyColor;
        _savedAmbientEquator = RenderSettings.ambientEquatorColor;
        _savedAmbientGround  = RenderSettings.ambientGroundColor;
        _savedAmbientLight   = RenderSettings.ambientLight;
        RenderSettings.ambientMode  = UnityEngine.Rendering.AmbientMode.Trilight;
        RenderSettings.ambientSkyColor     = new Color(0.28f, 0.30f, 0.38f); // cool sky
        RenderSettings.ambientEquatorColor = new Color(0.22f, 0.20f, 0.18f); // neutral mid
        RenderSettings.ambientGroundColor  = new Color(0.12f, 0.10f, 0.08f); // warm ground
    }

    private void OnEndCameraRendering(
        UnityEngine.Rendering.ScriptableRenderContext ctx, Camera cam)
    {
        if (cam != _cam) return;
        QualitySettings.shadowDistance     = _savedShadowDistance;
        RenderSettings.ambientMode         = _savedAmbientMode;
        RenderSettings.ambientLight        = _savedAmbientLight;
        RenderSettings.ambientSkyColor     = _savedAmbientSky;
        RenderSettings.ambientEquatorColor = _savedAmbientEquator;
        RenderSettings.ambientGroundColor  = _savedAmbientGround;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public void UpdateEquippedItems(AvatarConfig config)
    {
        if (config == null) return;
        ApplyBodyColor(config.bodyColor ?? "#D4A382");

        var slotsInConfig = new HashSet<string>();
        foreach (var entry in config.equippedSlots)
            slotsInConfig.Add(entry.slot);

        var toRemove = new List<string>();
        foreach (var kv in _itemQuads)
            if (!slotsInConfig.Contains(kv.Key)) toRemove.Add(kv.Key);
        foreach (var s in toRemove)
        {
            if (_itemQuads[s] != null) Destroy(_itemQuads[s]);
            _itemQuads.Remove(s);
        }

        foreach (var entry in config.equippedSlots)
        {
            if (entry.items == null || entry.items.Count == 0) continue;
            EnsureItemQuad(entry.slot, entry.items[0]);
        }
    }

    // ── Item overlay quads ────────────────────────────────────────────────────

    private void EnsureItemQuad(string slot, EquippedItemData item)
    {
        if (!SlotOffsets.TryGetValue(slot, out var offset)) return;
        if (!_itemQuads.TryGetValue(slot, out var go) || go == null)
        {
            go = CreateQuad(slot, offset);
            _itemQuads[slot] = go;
        }
        var mat = go.GetComponent<Renderer>()?.material;
        if (mat == null) return;

        if (!string.IsNullOrEmpty(item.thumbnailUrl))
            StartCoroutine(FetchAndApply(item.thumbnailUrl, mat));
        else if (!string.IsNullOrEmpty(item.imageData))
            ApplyBase64(item.imageData, mat);
        else
            ApplyCssColor(item.cssStyles, mat);
    }

    private GameObject CreateQuad(string slot, Vector3 localOffset)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
        go.name  = $"ItemQuad_{slot}";
        go.layer = _previewLayer;
        Destroy(go.GetComponent<MeshCollider>());
        if (_avatarRoot != null) go.transform.SetParent(_avatarRoot, false);
        go.transform.localPosition = localOffset;
        go.transform.localScale    = QuadScaleForSlot(slot);
        go.transform.localRotation = Quaternion.identity;

        var shader = Shader.Find("Universal Render Pipeline/Unlit") ??
                     Shader.Find("Unlit/Transparent") ?? Shader.Find("Standard");
        var mat = new Material(shader);
        mat.SetFloat("_Surface", 1);
        mat.renderQueue = 3000;
        var rend = go.GetComponent<Renderer>();
        rend.material         = mat;
        rend.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        rend.receiveShadows    = false;
        return go;
    }

    private static Vector3 QuadScaleForSlot(string slot) => slot switch
    {
        "Head"    => new Vector3(0.40f, 0.40f, 1f),
        "Hair"    => new Vector3(0.44f, 0.30f, 1f),
        "Face"    => new Vector3(0.34f, 0.34f, 1f),
        "Faces"   => new Vector3(0.36f, 0.36f, 1f),
        "Neck"    => new Vector3(0.24f, 0.24f, 1f),
        "Front"   => new Vector3(0.44f, 0.44f, 1f),
        "Back"    => new Vector3(0.44f, 0.44f, 1f),
        "Waist"   => new Vector3(0.40f, 0.22f, 1f),
        "Tops"    => new Vector3(0.56f, 0.56f, 1f),
        "Bottoms" => new Vector3(0.52f, 0.56f, 1f),
        "Shoes"   => new Vector3(0.36f, 0.22f, 1f),
        _         => new Vector3(0.44f, 0.44f, 1f),
    };

    // ── Texture helpers ───────────────────────────────────────────────────────

    private IEnumerator FetchAndApply(string url, Material mat)
    {
        if (_texCache.TryGetValue(url, out var cached)) { SetMatTex(mat, cached); yield break; }
        using var req = UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success)
        {
            var tex = DownloadHandlerTexture.GetContent(req);
            _texCache[url] = tex;
            SetMatTex(mat, tex);
        }
    }

    private static void SetMatTex(Material mat, Texture2D tex)
    {
        if (mat == null || tex == null) return;
        mat.mainTexture = tex;
        mat.color       = Color.white;
    }

    private static void ApplyBase64(string base64, Material mat)
    {
        try
        {
            int idx = base64.IndexOf(',');
            if (idx >= 0) base64 = base64[(idx + 1)..];
            var bytes = Convert.FromBase64String(base64);
            var tex   = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            tex.LoadImage(bytes);
            SetMatTex(mat, tex);
        }
        catch { }
    }

    private static void ApplyCssColor(string cssStyles, Material mat)
    {
        if (mat == null || string.IsNullOrEmpty(cssStyles) || cssStyles == "{}") return;
        const string key = "\"background\":\"";
        int start = cssStyles.IndexOf(key, StringComparison.Ordinal);
        if (start < 0) return;
        start += key.Length;
        int end = cssStyles.IndexOf('"', start);
        if (end <= start) return;
        if (ColorUtility.TryParseHtmlString(cssStyles[start..end], out var c))
            mat.color = c;
    }

    private static void SetLayer(GameObject go, int layer)
    {
        go.layer = layer;
        foreach (Transform child in go.transform)
            SetLayer(child.gameObject, layer);
    }

    private static float GetCurrentPointerY()
    {
#if ENABLE_INPUT_SYSTEM
        var pointer = UnityEngine.InputSystem.Pointer.current;
        return pointer != null ? pointer.position.ReadValue().y : 0f;
#else
        return UnityEngine.Input.mousePosition.y;
#endif
    }

    private static float GetCurrentPointerX()
    {
#if ENABLE_INPUT_SYSTEM
        var pointer = UnityEngine.InputSystem.Pointer.current;
        return pointer != null ? pointer.position.ReadValue().x : 0f;
#else
        return UnityEngine.Input.mousePosition.x;
#endif
    }

    private void OnAvatarChanged(AvatarConfig config) => UpdateEquippedItems(config);
}
