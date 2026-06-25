using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using ReactUnity.UGUI;
using ReactUnity.UGUI.Behaviours;

// Apple-Maps-style editor camera for the AI game editor preview.
//
// CORE PRINCIPLE — DIRECT MANIPULATION:
// The world point under the gesture (fingertip for one-finger, midpoint for
// two-finger) is captured at touch begin and stays glued to that screen
// position for the rest of the gesture. Each frame, after any pinch / twist
// / tilt deltas are applied to _dist / _yaw / _pitch, the pivot is solved
// analytically (six floats, no raycast) so the anchor projects back to the
// current screen point. Pan emerges naturally — when the gesture point
// moves, the pivot moves with it.
//
// COMPOUND GESTURES:
// Pinch, twist, and tilt apply in parallel. Each axis has its own dead zone
// — pinch 30 px, twist 8°, tilt 35 px — and once cumulative motion since
// the second finger landed crosses that threshold, that axis "engages" and
// applies its per-frame delta for the rest of the session, independently
// of the others. Tilt has an extra parallel-motion guard: it only engages
// when both fingers move Y in the same direction (so a one-finger pivot
// twist doesn't accidentally tilt). When tilt is engaged, the Y component
// of midpoint pan is suppressed.
//
// INERTIA:
// Per-axis exponential decay with framerate-independent damping. Captured
// each frame the gesture is active. Pan velocity is sampled from _pivot
// motion (not raw finger delta), so a small finger nudge at high pitch /
// distance produces an inertia matched to the world glide the user just
// felt. Tap during glide kills all velocities AND captures a fresh anchor
// so the next motion doesn't show a one-frame jump.
//
// FAILSAFE AT EXTREME PITCH:
// When the camera approaches horizontal (or briefly looks up), the y=0
// ray-plane intersection degrades. SolvePivotForAnchor falls back to a
// virtual plane at the camera's forward distance — the user feels a
// slight loss of stickiness rather than a discontinuous freeze.
//
// Select mode: tap to highlight scene objects and report selection to React.
public class EditorCameraController : MonoBehaviour
{
    public static EditorCameraController Instance { get; private set; }
    // Set true while the React bottom sheet is being dragged OR while the user
    // is drag-placing an asset from the horizontal strip — blocks all camera
    // motion. Killing velocities on the false→true transition prevents leftover
    // inertia (or in-flight snap-to-north) from gliding the camera while the
    // React UI owns the gesture.
    private static bool _sheetDragging;
    public static bool SheetDragging
    {
        get => _sheetDragging;
        set
        {
            if (value == _sheetDragging) return;
            _sheetDragging = value;
            if (value)
            {
                var inst = Instance;
                if (inst != null) { inst.KillVelocities(); inst.CancelPendingTap(); }
            }
        }
    }
    // Set true while React's terrain-builder mode is active so single-finger
    // drags route to the brush overlay instead of panning the camera.
    // Two-finger pinch still works (HandleInput's two-finger branch runs
    // before the gate so the user can still frame the sculpt).
    public static bool TerrainModeActive { get; set; }

    public bool SelectActive { get; private set; }

    // True while the user is actively touching the editor camera (any of:
    // one-finger drag, two-finger gesture, mouse drag, or snap-to-north
    // animation playing). React can read this to suppress unrelated UI
    // animations or scroll handlers that would compete with the camera.
    public bool IsInteracting =>
        _pinching || _dragId >= 0 || _mouseDown || _snapToNorthActive;

    private Vector3 _spawn = Vector3.zero;
    private Vector3 _pivot;

    // Orbit state. Pitch 90° = top-down (default); lower values tilt toward the
    // horizon. PitchMax is just under 90° to avoid the LookAt singularity.
    private float _yaw = 0f, _pitch = 89.9f, _dist = 24f;
    // DistMax caps how far the player can zoom out. It's a field (not a const)
    // so the blank-baseplate view can raise it to whatever fully frames the
    // plate, while normal games keep the tighter default.
    private const float PitchMin = 5f, PitchMax = 89.9f, DistMin = 6f;
    private const float DistMaxDefault = 55f;
    private float DistMax = DistMaxDefault;

    // Touch tracking
    private bool    _pinching;
    private float   _pinchDist;
    private Vector2 _pinchMid;
    private float   _pinchAngle;
    private int     _dragId = -1;
    private Vector2 _dragPos;

    // Mouse tracking
    private bool    _mouseDown;
    private Vector3 _lastMouse;

    // UI ownership — a touch that BEGAN over a React UI element belongs
    // to that UI for its entire lifetime, even if the user drags off
    // onto the viewport. This is how asset-strip drag-to-place works:
    // the touch starts on a tile, then the user drags into the 3D scene
    // to choose where to drop the model. The camera must stay still
    // throughout — they're moving the model, not panning the world.
    private readonly HashSet<int> _uiOwnedTouches = new HashSet<int>();
    private bool _uiOwnedMouse;

    // Two-finger session state. Per-axis engagement replaces the old single-
    // gesture lock so pinch / twist / tilt can all apply in parallel once
    // each one's dead zone is crossed. Finger identity is tracked by
    // fingerId (not Input.GetTouch index) so a brief lift-and-replace
    // doesn't swap which finger is which.
    private int     _t0Id = -1, _t1Id = -1;
    private Vector2 _t0Start, _t1Start;
    private float   _startD, _startAng;
    private Vector2 _startMid;
    private bool    _pinchEngaged, _twistEngaged, _tiltEngaged;

    // Per-axis dead zones — cumulative motion since the second finger
    // landed must exceed these before that axis engages. They don't lock
    // out the other axes; the others engage independently.
    private const float PinchDeadZonePx  = 16f;  // was 30 — engages faster, less latency
    private const float TwistDeadZoneDeg = 6f;   // was 8
    private const float TiltDeadZonePx   = 20f;  // was 35 — tilt feels immediate now

    // Tilt sensitivity (degrees of pitch per pixel of vertical finger travel)
    // scales with how close the camera is to the ground. Near top-down the
    // camera sits high, so a gentle gain keeps the overhead view controllable;
    // near the horizon the camera is low to the ground, so the same swipe
    // sweeps more pitch. Interpolated by pitch between these two endpoints.
    private const float TiltGainTopDown = 0.42f; // was 0.3 — more direct tilt feel
    private const float TiltGainGround  = 0.72f; // was 0.6

    // Gesture-midpoint anchor. Captured at touch begin (single-finger
    // fingertip OR two-finger midpoint). Each frame, _pivot is solved
    // analytically so this world point projects back to the current
    // screen point — that's what makes the world feel glued to the
    // gesture. Pan emerges from this; there's no separate pan path.
    private bool    _hasAnchor;
    private Vector3 _anchorWorld;

    // Inertia — velocity is sampled from a ~100 ms ring-buffer window so
    // release momentum reflects the very last instant of the gesture, not
    // an average over a long tail. Damping is per-60fps-frame, scaled to be
    // framerate-independent. Snap-to-rest floors kill the asymptotic tail
    // so the camera comes to a clean stop instead of drifting forever.
    // Pan/yaw carry generous momentum (feels satisfying to throw); zoom/pitch
    // settle quickly (feels precise and controllable).
    private Vector3 _panVelocity;   // world units / sec
    private float   _zoomVelocity;  // distance units / sec
    private float   _yawVelocity;   // degrees / sec
    private float   _pitchVelocity; // degrees / sec
    private const float PanDamping     = 0.93f;  // was 0.92 — slightly more throw
    private const float ZoomDamping    = 0.84f;  // was 0.88 — crisper zoom settle
    private const float YawDamping     = 0.92f;  // was 0.90 — satisfying twist glide
    private const float PitchDamping   = 0.86f;  // was 0.90 — pitch snaps back fast
    private const float PanSnapFloor   = 0.10f;  // u / s    was 0.05 — cleaner stop
    private const float ZoomSnapFloor  = 0.20f;  // dist / s  was 0.10
    private const float YawSnapFloor   = 3.0f;   // deg / s   was 2
    private const float PitchSnapFloor = 2.5f;   // deg / s   was 2

    // Velocity ring buffer — pre-allocated, indexed modulo VelSampleCount.
    // Pushed each frame the gesture is active; release velocity is read as
    // (latest - oldest_within_window) / window_dt. Sampled from _pivot
    // motion (not raw finger delta) so a small finger nudge at high pitch
    // or distance produces an inertia matched to the world glide felt.
    private struct VelSample { public float time; public Vector3 pivot; public float dist; public float yaw; public float pitch; }
    private const int   VelSampleCount  = 8;
    private const float VelSampleWindow = 0.10f;  // was 0.13 — tighter window, cleaner release
    private readonly VelSample[] _velSamples = new VelSample[VelSampleCount];
    private int _velSampleHead, _velSampleFill;

    // ── Input de-jitter (1€ filter) ──────────────────────────────────────────
    // Touch sensors emit ~1-2 px of noise even when a finger is held perfectly
    // still. Fed raw into the gesture math that noise made rotation shimmer,
    // pinch micro-zoom, and a held pan creep — the "glitchy" feel. A 1€
    // (one-euro) low-pass filter smooths near-still / slow motion heavily but
    // raises its cutoff with pointer speed, so a deliberate gesture keeps only
    // ~1 frame of latency and the world still feels glued to the fingers. One
    // filter per tracked pointer; reset at gesture start to avoid a first-frame
    // lurch from stale state.
    private sealed class OneEuroVec2
    {
        private bool    _has;
        private float   _t;
        private Vector2 _x, _dx;
        public void Reset(Vector2 value, float time)
        {
            _has = true; _t = time; _x = value; _dx = Vector2.zero;
        }
        private static float Alpha(float cutoff, float dt)
        {
            float tau = 1f / (2f * Mathf.PI * cutoff);
            return 1f / (1f + tau / dt);
        }
        public Vector2 Filter(Vector2 value, float time, float minCutoff, float beta, float dCutoff)
        {
            if (!_has) { Reset(value, time); return value; }
            float dt = time - _t;
            if (dt < 1e-4f) dt = 1f / 60f;
            _t = time;
            // Filtered derivative drives the speed-adaptive cutoff.
            Vector2 dxRaw = (value - _x) / dt;
            _dx = Vector2.Lerp(_dx, dxRaw, Alpha(dCutoff, dt));
            float cutoff = minCutoff + beta * _dx.magnitude;
            _x = Vector2.Lerp(_x, value, Alpha(cutoff, dt));
            return _x;
        }
    }
    private readonly OneEuroVec2 _filt0   = new OneEuroVec2(); // two-finger A
    private readonly OneEuroVec2 _filt1   = new OneEuroVec2(); // two-finger B
    private readonly OneEuroVec2 _filtPan = new OneEuroVec2(); // single pointer
    // minCutoff sets the smoothing floor when nearly still (lower = smoother,
    // laggier); beta raises the cutoff with pointer speed so fast motion stays
    // responsive. Tuned for screen pixels at ~60 fps.
    // 1.0 minCutoff (was 1.8) — aggressively damps sensor jitter at slow speeds
    // so a still-held finger doesn't shimmer. 0.10 beta (was 0.07) — cutoff climbs
    // faster with speed so a deliberate swipe still feels glued to the finger.
    private const float PointerMinCutoff = 1.0f;
    private const float PointerBeta      = 0.10f;
    private const float PointerDCutoff   = 1.0f;

    // Rubber-band bounds. Pitch and distance are soft-clamped with a small
    // overshoot band; the world position is constrained to a soft AABB
    // around the scene contents (auto-derived from MeshyAssetMarker AABBs,
    // fallback 200×200 around the spawn point). Past any bound, motion
    // compresses; when no gesture is active, an exponential spring pulls
    // the camera back inside.
    private Bounds _softBounds;
    private bool   _softBoundsValid;
    private float  _nextBoundsRecompute;
    private const float BoundsRecomputeInterval = 2f;
    private const float DefaultBoundsHalfSize   = 100f;
    private const float PitchOvershootDeg       = 7f;   // was 5 — more springy pitch limit
    private const float DistOvershoot           = 10f;  // was 8  — more springy zoom limit
    private const float BoundsOvershoot         = 25f;  // was 30 — tighter pan boundary
    private const float SpringSettleTime        = 0.22f; // was 0.35 — snappier spring-back

    // Tap (for select mode)
    private bool    _tapDown;
    private Vector2 _tapScreenPos;
    // Set at touch-down / mouse-down when the pointer is over a ReactUnity UI
    // element. Consumed by ProcessSelectTap so taps on the selection-overlay
    // action buttons (rotate / duplicate / resize) don't fall through to the
    // raycast-and-deselect path on tap release.
    private bool    _tapBeganOverUI;

    // Selection highlight
    private GameObject _selGo;
    private Renderer[] _selRends;
    private Color[]    _selOrigEmit;

    // Drag-to-move (a previously-selected object) — when the user puts a
    // finger down ON the selected object in Select mode and drags, we move
    // the object instead of panning the camera. While this is active we
    // raise `_editorDraggingObject = "true"` on every ReactRendererUGUI so
    // the EditorScreen can swap its asset strip for a centered trash icon.
    private bool    _movingSel;
    private int     _movingTouchId = -1;
    private bool    _movingMouse;
    // Terrain-follow state captured at drag-start. If the object was
    // touching the terrain (bounds.min.y within GroundedToleranceY of
    // terrainY), we keep it grounded — its Y tracks the terrain height as
    // it's moved over uneven ground. If it was floating, we preserve its
    // world Y throughout the drag.
    private bool    _movingSelGrounded;
    private float   _movingSelBottomOffset; // pos.y - bounds.min.y at drag-start
    private float   _movingSelFloatY;       // original pos.y for the floating case
    private const float GroundedToleranceY = 0.15f;
    // Trash drop zone. The React UI renders the trash icon at
    // `bottom: TrashBottomReferenceY` (in React reference units); the C#
    // math computes the matching Unity-pixel center by scaling with the
    // canvas scale. Released within TrashRadiusPx of that point and the
    // dragged object gets destroyed. Keep these constants in sync with
    // CreateScreen.tsx's trash-icon `bottom` value.
    private const float TrashRadiusPx        = 80f;
    // Icon is 72 px tall and sits flush against the bottom safe area in
    // CreateScreen.tsx, so its CENTER y (in React reference units, bottom-
    // origin) is safeAreaBottom + 36. We fetch the live safe-area value
    // from Globals so the drop-zone tracks the device's home-indicator
    // inset instead of hard-coding a portrait-phone number.
    private const float TrashIconHalfHeight  = 36f;

    // Scale caps for the selection-overlay scale handle.
    // Past the hard limit, ScaleSelected applies the delta at reduced strength
    // (soft overshoot band) so the user feels resistance rather than a wall.
    // ApplyScaleSpring then pulls the scale back inside [ScaleMin, ScaleMax]
    // once the user lifts their finger (no ScaleSelected call for 120 ms).
    private const float ScaleMin              = 0.08f;
    private const float ScaleMax              = 12f;
    private const float ScaleOvershoot        = 0.12f; // 12 % past hard limit allowed
    private const float ScaleSpringDelay      = 0.12f; // seconds after last call before spring fires
    private const float ScaleSpringSettleTime = 0.18f; // seconds to settle to ~1 % of overshoot
    private float _lastScaleTime              = -1f;

    private void Awake()
    {
        Instance = this;
    }

    private void OnDestroy()
    {
        ClearHighlight();
        if (Instance == this) Instance = null;
    }

    // Call once after the game script sets its spawn point.
    public void Init(Vector3 spawnPoint)
    {
        DistMax = DistMaxDefault;
        _spawn = spawnPoint;
        _pivot = new Vector3(spawnPoint.x, 0f, spawnPoint.z);
        _yaw   = 0f;
        _pitch = 89.9f;
        _dist  = 24f;
        SelectActive = false;
        KillVelocities();
        RecomputeSoftBounds();
        _nextBoundsRecompute = Time.time + BoundsRecomputeInterval;
        ApplyCamera();
    }

    // Like Init, but frames a brand-new blank game the way Roblox Studio frames
    // its baseplate: a pulled-back 3/4 angle (not top-down) zoomed out far enough
    // that the WHOLE baseplate square fits in frame under the sky. The camera's
    // zoom cap and far-clip are widened to match the (large) plate.
    public void InitBaseplateView(Vector3 spawnPoint)
    {
        _spawn = spawnPoint;
        _pivot = Vector3.zero;   // the baseplate is centred on the world origin
        _yaw   = 0f;
        // Steep, near-top-down angle (90 = straight down). A shallow tilt
        // foreshortens the depth axis so the square baseplate reads as a wide
        // rectangle; at 78° the foreshortening is ~2% so it reads as a square,
        // while keeping a slight 3D tilt so the plate's thickness is still hinted.
        _pitch = 78f;

        // Distance that frames the full plate: fit its bounding-sphere radius
        // (half-diagonal) inside the camera's vertical FOV, so all four corners
        // stay visible regardless of yaw.
        float world  = TerrainBuilder.WorldSize;
        var   cam    = GetComponent<Camera>();
        float fovDeg = cam != null ? cam.fieldOfView : 60f;
        float radius = world * 0.5f * 1.41421356f;
        float fit    = radius / Mathf.Sin(fovDeg * 0.5f * Mathf.Deg2Rad);

        // Raise the zoom-out cap above the framing distance so the spring doesn't
        // immediately pull the camera back in, and extend the far clip so the
        // far edge of a large plate isn't culled.
        DistMax = Mathf.Max(DistMaxDefault, fit * 1.3f);
        _dist   = Mathf.Clamp(fit * 1.05f, DistMin, DistMax);
        if (cam != null) cam.farClipPlane = Mathf.Max(cam.farClipPlane, _dist * 3f);

        SelectActive = false;
        KillVelocities();
        RecomputeSoftBounds();
        _nextBoundsRecompute = Time.time + BoundsRecomputeInterval;
        ApplyCamera();
    }

    // Update spawn without resetting view (called when Lua Player.SetSpawnPoint fires).
    public void SetSpawn(Vector3 sp) => _spawn = sp;

    public void ResetView()
    {
        _pivot = new Vector3(_spawn.x, 0f, _spawn.z);
        _yaw   = 0f;
        _pitch = 89.9f;
        _dist  = 24f;
        KillVelocities();
        ApplyCamera();
    }

    // ── Orbit-cam view persistence ─────────────────────────────────────────────
    // The orbit pose is fully defined by pivot + yaw/pitch/dist. EditorState
    // captures it so reopening the editor returns the user to the exact view they
    // left; otherwise the camera snaps to the default top-down spawn view and the
    // scene looks "empty" even though every edit is still present at its world
    // position. Only ever restored on the load path — never on undo/redo.
    public void GetView(out Vector3 pivot, out float yaw, out float pitch, out float dist)
    {
        pivot = _pivot; yaw = _yaw; pitch = _pitch; dist = _dist;
    }

    public void ApplyView(Vector3 pivot, float yaw, float pitch, float dist)
    {
        _pivot = pivot;
        _yaw   = yaw;
        _pitch = pitch;
        _dist  = dist;
        KillVelocities();
        RecomputeSoftBounds();
        ApplyCamera();
    }

    private void KillVelocities()
    {
        _panVelocity   = Vector3.zero;
        _zoomVelocity  = 0f;
        _yawVelocity   = 0f;
        _pitchVelocity = 0f;
        _velSampleHead = 0;
        _velSampleFill = 0;
        _snapToNorthActive = false;
        // Any direct user gesture (touch/mouse begin) owns the camera —
        // a residual framing return-trip would otherwise yank the pivot
        // out from under them after the panel closed.
        _framingActive       = false;
        _framingHoldAtTarget = false;
        _framingReturning    = false;
    }

    // ── Compass snap-to-north ────────────────────────────────────────────────
    // Animates yaw back to 0° with an ease-out-back curve so the rotation
    // slightly overshoots and settles — the same flourish Apple Maps uses
    // when you tap the compass.
    private bool  _snapToNorthActive;
    private float _snapT, _snapStartYaw, _snapDeltaYaw;
    private const float SnapDuration = 0.4f;

    public void SnapToNorth()
    {
        if (_snapToNorthActive) return;
        _snapToNorthActive = true;
        _snapT             = 0f;
        _snapStartYaw      = _yaw;
        // DeltaAngle(current, target) returns target-current normalized to
        // [-180, 180] — that IS the shortest delta. No negation: yaw should
        // end at _snapStartYaw + _snapDeltaYaw = current + (0-current) = 0.
        _snapDeltaYaw      = Mathf.DeltaAngle(_yaw, 0f);
        _yawVelocity       = 0f;
    }

    private void ApplySnapToNorth()
    {
        if (!_snapToNorthActive) return;
        _snapT += Time.deltaTime;
        float u = Mathf.Clamp01(_snapT / SnapDuration);
        // Ease-out-back — peaks ~10% past target around u=0.8, settles at 1.
        const float c1 = 1.70158f;
        const float c3 = c1 + 1f;
        float k = 1f + c3 * Mathf.Pow(u - 1f, 3f) + c1 * Mathf.Pow(u - 1f, 2f);
        _yaw = _snapStartYaw + _snapDeltaYaw * k;
        if (u >= 1f)
        {
            _yaw = _snapStartYaw + _snapDeltaYaw;
            _snapToNorthActive = false;
        }
    }

    // ── Right-area framing ───────────────────────────────────────────────────
    // When React opens a left-docked panel (Object Settings, Custom Logic) it
    // wants the selected object visible in the centre of the right-of-panel
    // area. We solve for the pivot that puts the selection at the target
    // screen pixel, then ease the camera over there. On close, we reverse the
    // animation so the camera glides back to where it was before opening —
    // makes the panel feel like a non-destructive aside.
    //
    // Runs independently of SheetDragging (the panel sets that to lock user
    // input) and outside ApplyInertia / ApplySpring (both gated when the panel
    // is open), so this is the sole owner of _pivot during the animation.
    private bool    _framingActive;
    private bool    _framingHoldAtTarget;   // settled at target, waiting for End
    private bool    _framingReturning;      // animating back to _framingHomePivot
    private float   _framingT;              // elapsed seconds in current leg
    private Vector3 _framingStartPivot;
    private Vector3 _framingTargetPivot;
    private Vector3 _framingHomePivot;      // pivot at the moment framing began
    private const float FramingDuration = 0.45f;

    public void BeginRightAreaFraming(float panelRightCanvasX)
    {
        if (_selGo == null || _selRends == null) return;
        var cam = Camera.main;
        if (cam == null) return;

        // World AABB centre of the selection — what we want the camera to land
        // on. Skip near-zero-size renderers (their bounds default to origin
        // and would yank the framing target to (0,0,0)).
        bool first = true;
        Bounds box = default;
        foreach (var r in _selRends)
        {
            if (r == null) continue;
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { box = r.bounds; first = false; }
            else        box.Encapsulate(r.bounds);
        }
        if (first) return;
        Vector3 selCenter = box.center;

        // Target pixel: vertical centre, horizontal centre of the free region
        // between the panel's right edge and the screen's right edge. React
        // passes the panel's right edge in canvas reference units; convert to
        // pixels via the same canvas scale used everywhere else.
        float scale = Mathf.Max(GameLauncher.GetReactCanvasScale(), 0.01f);
        float panelRightPx = Mathf.Clamp(panelRightCanvasX * scale, 0f, Screen.width);
        float targetPx     = (panelRightPx + Screen.width) * 0.5f;
        Vector2 targetPixel = new Vector2(targetPx, Screen.height * 0.5f);

        // SolvePivotForAnchor solves for the pivot that makes a world point on
        // the y=0 plane project to the given screen pixel. Pass the selection's
        // (x, z) on y=0 — at near-top-down pitch (default 89.9°) the vertical
        // offset of the actual selection centre is sub-pixel; at lower pitch
        // the object lands slightly above target, which is still well-framed.
        Vector3 anchorXZ = new Vector3(selCenter.x, 0f, selCenter.z);

        // If we're already framing, keep the original home so the return trip
        // still leads back to the camera the user had before any panel opened
        // (covers toggling between Settings ↔ Custom Logic).
        if (!_framingActive) _framingHomePivot = _pivot;

        _framingStartPivot  = _pivot;
        _framingTargetPivot = SoftClampPivot(SolvePivotForAnchor(anchorXZ, targetPixel));
        _framingT           = 0f;
        _framingActive      = true;
        _framingHoldAtTarget = false;
        _framingReturning    = false;
    }

    public void EndRightAreaFraming()
    {
        if (!_framingActive && !_framingHoldAtTarget) return;
        // Animate back to wherever the camera was before the first panel opened.
        _framingStartPivot   = _pivot;
        _framingTargetPivot  = _framingHomePivot;
        _framingT            = 0f;
        _framingActive       = true;
        _framingHoldAtTarget = false;
        _framingReturning    = true;
    }

    private void ApplyFraming()
    {
        if (!_framingActive) return;
        _framingT += Time.unscaledDeltaTime;
        float u = Mathf.Clamp01(_framingT / FramingDuration);
        // Ease-in-out cubic — symmetric, no overshoot, feels like a Maps glide.
        float k = u < 0.5f
            ? 4f * u * u * u
            : 1f - Mathf.Pow(-2f * u + 2f, 3f) * 0.5f;
        _pivot = Vector3.LerpUnclamped(_framingStartPivot, _framingTargetPivot, k);
        if (u >= 1f)
        {
            _pivot = _framingTargetPivot;
            _framingActive = false;
            if (_framingReturning)
            {
                // Settled back at home — drop framing entirely so the next
                // gesture sees a clean slate.
                _framingHoldAtTarget = false;
                _framingReturning    = false;
            }
            else
            {
                // Hold at framed position until React releases.
                _framingHoldAtTarget = true;
            }
        }
    }

    private void PushVelSample()
    {
        _velSamples[_velSampleHead] = new VelSample
        {
            time  = Time.unscaledTime,
            pivot = _pivot,
            dist  = _dist,
            yaw   = _yaw,
            pitch = _pitch,
        };
        _velSampleHead = (_velSampleHead + 1) % VelSampleCount;
        if (_velSampleFill < VelSampleCount) _velSampleFill++;
    }

    // Walk back from the latest sample until we cross the window edge;
    // velocity = (latest - that one) / elapsed. Held-still frames keep
    // pushing the same position, so old samples age out and the windowed
    // velocity decays to zero on its own — no separate "stationary bleed"
    // needed.
    private void ComputeWindowedVelocity()
    {
        if (_velSampleFill < 2) return;
        int latestIdx = (_velSampleHead - 1 + VelSampleCount) % VelSampleCount;
        float now = _velSamples[latestIdx].time;
        int oldestIdx = latestIdx;
        for (int i = 1; i < _velSampleFill; i++)
        {
            int idx = (latestIdx - i + VelSampleCount) % VelSampleCount;
            if (now - _velSamples[idx].time > VelSampleWindow) break;
            oldestIdx = idx;
        }
        var latest = _velSamples[latestIdx];
        var oldest = _velSamples[oldestIdx];
        float dt = latest.time - oldest.time;
        if (dt < 1e-4f) return;
        _panVelocity   = (latest.pivot - oldest.pivot) / dt;
        _zoomVelocity  = (latest.dist  - oldest.dist)  / dt;
        _yawVelocity   = Mathf.DeltaAngle(oldest.yaw, latest.yaw) / dt;
        _pitchVelocity = (latest.pitch - oldest.pitch) / dt;
    }

    // Rubber-band axis: motion past [lo, hi] is compressed asymptotically
    // toward `band` units of overshoot. At small past, returns ≈ raw value
    // (cheap resistance); at past → ∞, returns ≈ limit ± band.
    private static float SoftClamp(float v, float lo, float hi, float band)
    {
        if (v < lo)
        {
            float past = lo - v;
            return lo - past * band / (past + band);
        }
        if (v > hi)
        {
            float past = v - hi;
            return hi + past * band / (past + band);
        }
        return v;
    }

    private Vector3 SoftClampPivot(Vector3 p)
    {
        p.y = 0f;
        if (!_softBoundsValid) return p;
        var center = _softBounds.center;
        var ext    = _softBounds.extents;
        p.x = SoftClamp(p.x, center.x - ext.x, center.x + ext.x, BoundsOvershoot);
        p.z = SoftClamp(p.z, center.z - ext.z, center.z + ext.z, BoundsOvershoot);
        return p;
    }

    // Auto-derive _softBounds from the AABB of all MeshyAssetMarker-tagged
    // objects in the scene. Fallback: 200×200 around the spawn point so the
    // camera is bounded even while Meshy is still streaming assets in. Run
    // periodically because the scene mutates as AI-generated assets arrive.
    public void RecomputeSoftBounds()
    {
        // Always use the baseplate as the pan boundary — placing an asset must
        // never shrink the camera limit to a box around that asset.
        float half = TerrainBuilder.WorldSize * 0.5f;
        _softBounds = new Bounds(Vector3.zero, new Vector3(2f * half, 0f, 2f * half));
        _softBoundsValid = true;
    }

    // Exponential spring back toward the natural [lo, hi] range. Only
    // applies when the corresponding gesture isn't actively being driven;
    // otherwise direct input would fight the spring.
    private void ApplySpring()
    {
        if (Time.deltaTime <= 0f) return;
        // After `t` seconds, the fraction of the overshoot remaining is
        // 0.01^(t / SpringSettleTime) — i.e. settles to 1% in
        // SpringSettleTime. Critically-damped feel without per-step force math.
        float keep = Mathf.Pow(0.01f, Time.deltaTime / SpringSettleTime);

        if (_pitch < PitchMin) _pitch = Mathf.Lerp(PitchMin, _pitch, keep);
        else if (_pitch > PitchMax) _pitch = Mathf.Lerp(PitchMax, _pitch, keep);

        if (_dist < DistMin) _dist = Mathf.Lerp(DistMin, _dist, keep);
        else if (_dist > DistMax) _dist = Mathf.Lerp(DistMax, _dist, keep);

        if (_softBoundsValid)
        {
            var center = _softBounds.center;
            var ext    = _softBounds.extents;
            float xLo = center.x - ext.x, xHi = center.x + ext.x;
            float zLo = center.z - ext.z, zHi = center.z + ext.z;
            Vector3 p = _pivot;
            if      (p.x < xLo) p.x = Mathf.Lerp(xLo, p.x, keep);
            else if (p.x > xHi) p.x = Mathf.Lerp(xHi, p.x, keep);
            if      (p.z < zLo) p.z = Mathf.Lerp(zLo, p.z, keep);
            else if (p.z > zHi) p.z = Mathf.Lerp(zHi, p.z, keep);
            _pivot = p;
        }
    }

    public void SetSelect(bool active)
    {
        SelectActive = active;
        Notify("_editorSelectMode", active ? "true" : "false");
        if (!active)
        {
            ClearHighlight();
            Notify("_selectedObject", "");
            EndMovingSel(deleteIfOverTrash: false);
        }
    }

    // Drop the current selection WITHOUT leaving select mode. Select mode is
    // always on in the editor now (the React Select toggle was removed), so the
    // deselect action — the top-bar X while an object is selected — clears the
    // highlight + _selectedObject but leaves SelectActive true so the next tap
    // still selects. Mirrors the !active branch of SetSelect minus the mode flip.
    public void ClearSelection()
    {
        ClearHighlight();
        Notify("_selectedObject", "");
        EndMovingSel(deleteIfOverTrash: false);
    }

    // Programmatic selection — called by LuauGameRunner immediately after
    // PlaceEditorAsset so the freshly-dropped model is selected without the
    // user having to tap it. Forces SelectActive on as a side effect.
    public void SelectGameObject(GameObject go)
    {
        if (go == null) return;
        go = ResolveTrackedRoot(go);
        SelectActive = true;
        Notify("_editorSelectMode", "true");
        HighlightGo(go);
        var p = go.transform.position;
        Notify("_selectedObject", $"{go.name}|{p.x:F1},{p.y:F1},{p.z:F1}");
    }

    // Resolve a ray-hit / passed-in GameObject UP to the capture-tracked entity:
    // the direct child of the game root. Tap raycasts hit the MeshCollider, which
    // on a Meshy GLB (and most imported models) lives on a NESTED mesh node — but
    // EditorState.Capture/Apply track only DIRECT children of the game root, by
    // name. If the selection (and therefore every move / scale / rotate / vertical
    // / duplicate / delete / logic edit, which all act on _selGo) lands on a nested
    // node, the edit is written to a transform the snapshot never records — so it
    // neither autosaves nor undoes. Walking up to the root child makes all of those
    // edits land on the tracked object. Newly-placed assets already worked because
    // PlaceEditorAsset selects the container directly; this fixes pre-existing,
    // tap-selected objects. Falls back to the original GameObject if it isn't under
    // the game root (e.g. nothing is loaded yet).
    private GameObject ResolveTrackedRoot(GameObject go)
    {
        if (go == null) return null;
        var root = LuauGameRunner.Instance != null ? LuauGameRunner.Instance.GameRoot : null;
        if (root == null) return go;
        var t = go.transform;
        while (t != null && t.parent != null && t.parent != root)
            t = t.parent;
        return (t != null && t.parent == root) ? t.gameObject : go;
    }

    private void LateUpdate()
    {
        // While moving the selected object, drag input drives the object
        // and bypasses the camera + select-tap paths entirely.
        if (_movingSel)
        {
            UpdateMovingSel();
            PublishSelectionBounds();
            ApplyCamera();
            return;
        }
        // Try to claim the gesture for an object-move BEFORE HandleInput so
        // the first frame doesn't simultaneously pan the camera.
        if (SelectActive && TryStartMoveOnSelected())
        {
            PublishSelectionBounds();
            ApplyCamera();
            return;
        }
        // Periodically refresh world bounds — AI-generated assets stream in
        // over the first ~10 s of preview, expanding the playable area.
        if (Time.time >= _nextBoundsRecompute)
        {
            RecomputeSoftBounds();
            _nextBoundsRecompute = Time.time + BoundsRecomputeInterval;
        }

        HandleInput();
        // While React owns the gesture (sheet drag, asset-strip drag-to-place,
        // overlay modals), every motion source is silenced — not just direct
        // input. Otherwise residual inertia from a prior pan, the soft-bounds
        // spring, or an in-flight snap-to-north would keep gliding the camera
        // under the user's finger while they're dragging a UI element.
        if (!SheetDragging)
        {
            ApplyInertia();

            // Spring back to natural ranges when no gesture is active. With
            // input active the gesture would fight the spring; once the user
            // releases, this gently pulls pitch / distance / pivot back inside
            // their soft bounds.
            bool gesturing = _pinching || _dragId >= 0 || _mouseDown;
            if (!gesturing) ApplySpring();

            ApplySnapToNorth();
        }
        // Right-area framing runs OUTSIDE the SheetDragging gate — the panel
        // that triggers it always sets SheetDragging=true, so this is the only
        // motion source allowed to write _pivot while the panel is open.
        ApplyFraming();

        if (SelectActive) ProcessSelectTap();
        ApplyScaleSpring();
        ApplyCamera();
        PublishSelectionBounds();
        TrackCameraPersist();
    }

    // ── Camera positioning ────────────────────────────────────────────────────

    private void ApplyCamera()
    {
        var cam = Camera.main;
        if (!cam) return;
        // Set rotation explicitly instead of using LookAt(pivot, Vector3.up).
        // At our near-top-down default (pitch ≈ 90°) the camera's forward is
        // nearly anti-parallel to world up, so LookAt's cross-product for the
        // right vector is on the order of 1e-3 and its sign is at the mercy
        // of floating-point noise — that's what made twist look like the
        // camera was randomly snapping. Driving rotation straight from the
        // quaternion is well-defined at every pitch.
        var rot = Quaternion.Euler(_pitch, _yaw, 0f);
        cam.transform.rotation = rot;
        cam.transform.position = _pivot - rot * Vector3.forward * _dist;
    }

    // ── Input ─────────────────────────────────────────────────────────────────

    private void HandleInput()
    {
        if (SheetDragging) return;
        int tc = Input.touchCount;

        // ── UI-ownership bookkeeping ─────────────────────────────────────
        // A touch that began over UI is permanently UI-owned. The camera
        // ignores it for its entire lifetime.
        for (int i = 0; i < tc; i++)
        {
            var t = Input.GetTouch(i);
            if (t.phase == TouchPhase.Began && IsPointerOverUI(t.position))
                _uiOwnedTouches.Add(t.fingerId);
            if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
                _uiOwnedTouches.Remove(t.fingerId);
        }
        if (tc == 0 && _uiOwnedTouches.Count > 0) _uiOwnedTouches.Clear();

        if (Input.GetMouseButtonDown(0) && IsPointerOverUI((Vector2)Input.mousePosition)) _uiOwnedMouse = true;
        if (!Input.GetMouseButton(0)) _uiOwnedMouse = false;

        if (tc >= 2)
        {
            // If EITHER finger is UI-owned, the whole two-finger session is
            // off-limits to the camera. End any in-flight session and bail.
            if (_uiOwnedTouches.Contains(Input.GetTouch(0).fingerId) ||
                _uiOwnedTouches.Contains(Input.GetTouch(1).fingerId))
            {
                if (_pinching)
                {
                    _pinching     = false;
                    _pinchEngaged = _twistEngaged = _tiltEngaged = false;
                    _t0Id = _t1Id = -1;
                    _hasAnchor    = false;
                }
                return;
            }
            TwoFingerInput();
            return;
        }

        // Dropped out of two-finger mode (lifted one or both fingers).
        if (_pinching)
        {
            _pinching      = false;
            _pinchEngaged  = false;
            _twistEngaged  = false;
            _tiltEngaged   = false;
            _t0Id = _t1Id  = -1;
            _hasAnchor     = false;
        }

        if (tc == 1)
        {
            // UI-owned single touch — invisible to the camera.
            if (_uiOwnedTouches.Contains(Input.GetTouch(0).fingerId)) return;
            if (TerrainModeActive) { _dragId = -1; _tapDown = false; _hasAnchor = false; return; }
            OneFingerInput();
        }
        else // tc == 0
        {
            if (_dragId >= 0)
            {
                _dragId    = -1;
                _hasAnchor = false;
            }
            if (_uiOwnedMouse) return;
            MouseInput();
        }
    }

    // ── Two-finger gesture (pinch / twist / tilt / pan, all compound) ────────
    private void TwoFingerInput()
    {
        if (!_pinching)
        {
            // Fresh entry: snapshot starts, capture anchor under midpoint.
            var t0 = Input.GetTouch(0);
            var t1 = Input.GetTouch(1);
            _t0Id    = t0.fingerId;
            _t1Id    = t1.fingerId;
            _t0Start = t0.position;
            _t1Start = t1.position;
            _filt0.Reset(t0.position, Time.unscaledTime);
            _filt1.Reset(t1.position, Time.unscaledTime);

            var mid = (t0.position + t1.position) * 0.5f;
            float ang = Mathf.Atan2(t1.position.y - t0.position.y,
                                    t1.position.x - t0.position.x) * Mathf.Rad2Deg;
            float d   = Vector2.Distance(t0.position, t1.position);

            _startMid   = mid;
            _startAng   = ang;
            _startD     = d;
            _pinchDist  = d;
            _pinchAngle = ang;
            _pinchMid   = mid;

            _pinchEngaged = _twistEngaged = _tiltEngaged = false;
            _hasAnchor    = TryPlaneAnchor(mid, out _anchorWorld);
            _pinching     = true;
            _tapDown      = false;
            _dragId       = -1;
            KillVelocities();
            return;
        }

        // Continue the session by fingerId — survives Input.GetTouch index
        // shuffling (e.g. a third finger lands or one briefly lifts).
        if (!TryGetTouchById(_t0Id, out var tA) || !TryGetTouchById(_t1Id, out var tB))
        {
            // Lost one of the original fingers — end the session. The next
            // frame's HandleInput will re-enter with whatever's still down.
            _pinching     = false;
            _pinchEngaged = _twistEngaged = _tiltEngaged = false;
            _hasAnchor    = false;
            _t0Id = _t1Id = -1;
            return;
        }

        // De-jitter both finger signals before deriving the gesture axes, so
        // sensor noise doesn't shimmer the rotation / pinch / tilt.
        float nowT = Time.unscaledTime;
        Vector2 pA = _filt0.Filter(tA.position, nowT, PointerMinCutoff, PointerBeta, PointerDCutoff);
        Vector2 pB = _filt1.Filter(tB.position, nowT, PointerMinCutoff, PointerBeta, PointerDCutoff);

        var midNow = (pA + pB) * 0.5f;
        float dNow = Vector2.Distance(pA, pB);
        float angNow = Mathf.Atan2(pB.y - pA.y, pB.x - pA.x) * Mathf.Rad2Deg;

        // ── Per-axis engagement (cumulative since session start) ────────────
        // Tilt is exclusive: once it engages, pinch and twist cannot engage
        // in the same session (and vice-versa — tilt already requires !_pinchEngaged
        // and !_twistEngaged). This makes the two-finger up/down swipe a pure-tilt
        // gesture with no accidental zoom, rotate, or pan side-effects.
        if (!_pinchEngaged && !_tiltEngaged && Mathf.Abs(dNow - _startD) >= PinchDeadZonePx)
        {
            _pinchEngaged = true;
            _pinchDist    = dNow; // re-baseline so first applied delta is zero
        }
        if (!_twistEngaged && !_tiltEngaged && Mathf.Abs(Mathf.DeltaAngle(_startAng, angNow)) >= TwistDeadZoneDeg)
        {
            _twistEngaged = true;
            _pinchAngle   = angNow;
        }
        if (!_tiltEngaged && !_twistEngaged && !_pinchEngaged)
        {
            // Tilt vs. twist are mutually exclusive. A circular two-finger
            // rotation drifts the midpoint vertically — a wrist-pivot twist
            // moves BOTH fingers the same Y direction — which would otherwise
            // cross the tilt dead zone and change pitch (the "twisting tilts
            // the camera up/down" bug). If the fingers have rotated past the
            // twist dead zone, treat it as a twist and never let it tilt. The
            // rotSinceStart guard also covers the pre-engagement race where the
            // midpoint crosses the tilt threshold a frame before twist formally
            // engages.
            // _pinchEngaged guard: once zoom is recognised, tilt cannot engage
            // in the same session — pitch must not change during pinch-to-zoom.
            float rotSinceStart = Mathf.Abs(Mathf.DeltaAngle(_startAng, angNow));

            // Parallel-motion guard: both fingers must move Y in the same
            // direction. A one-finger-pivot twist would have anti-parallel
            // Y deltas; we don't want that to count as tilt.
            float dy0 = pA.y - _t0Start.y;
            float dy1 = pB.y - _t1Start.y;
            bool parallelY = (dy0 * dy1) >= 0f
                          || Mathf.Abs(dy0) < 2f
                          || Mathf.Abs(dy1) < 2f;
            if (rotSinceStart < TwistDeadZoneDeg
                && parallelY
                && Mathf.Abs(midNow.y - _startMid.y) >= TiltDeadZonePx)
            {
                _tiltEngaged = true;
                _pinchMid    = midNow;
            }
        }

        // ── Apply each engaged axis ─────────────────────────────────────────
        // Tilt is exclusive: when it is engaged, zoom and rotate are suppressed
        // so the two-finger up/down swipe only changes pitch.
        if (_pinchEngaged && !_tiltEngaged)
        {
            Zoom(-(dNow - _pinchDist) * 0.055f); // was 0.04 — more punch per mm of spread
            _pinchDist = dNow;
        }
        if (_twistEngaged && !_tiltEngaged)
        {
            // Sign: atan2 is CCW-positive. A CW finger twist produces
            // dYaw < 0; we want the camera to orbit CCW around the pivot
            // (yaw decreases) so the scene rotates CW with the fingers.
            _yaw       += Mathf.DeltaAngle(_pinchAngle, angNow);
            _pinchAngle = angNow;
        }
        if (_tiltEngaged)
        {
            // Direction: swipe DOWN (dm.y < 0) raises pitch toward top-down;
            // swipe UP (dm.y > 0) tilts toward the horizon.
            // Sensitivity grows as the camera nears the ground (low pitch), so
            // a low-angle view sweeps more pitch per swipe than the overhead one.
            float pitchFrac = Mathf.InverseLerp(PitchMax, PitchMin, _pitch); // 0 = top-down, 1 = ground
            float tiltGain  = Mathf.Lerp(TiltGainTopDown, TiltGainGround, pitchFrac);
            _pitch    = SoftClamp(_pitch - (midNow.y - _pinchMid.y) * tiltGain,
                                  PitchMin, PitchMax, PitchOvershootDeg);
            _pinchMid = new Vector2(_pinchMid.x, midNow.y);
        }

        // ── Anchor compensation — pan emerges from this ─────────────────────
        // Skipped entirely when tilt is engaged: vertical finger motion is
        // pitch input, and we don't want horizontal drift to pan the world
        // either. The pivot stays locked in place for the duration of a tilt.
        if (_hasAnchor && !_tiltEngaged)
        {
            _pivot = SoftClampPivot(SolvePivotForAnchor(_anchorWorld, midNow));
        }

        // Capture windowed velocity for inertia. Sampled from _pivot motion
        // (not raw finger delta) so a small finger nudge at high pitch /
        // distance produces an inertia matched to the world glide the user
        // just felt.
        PushVelSample();
        ComputeWindowedVelocity();

        _tapDown = false;
    }

    // ── One-finger pan (anchor-glued) ────────────────────────────────────────
    private void OneFingerInput()
    {
        var t = Input.GetTouch(0);

        // First frame of one-finger control — either a fresh touch or a
        // transition from a two-finger session whose other finger lifted.
        bool fresh = (_dragId != t.fingerId);
        if (fresh)
        {
            _dragId         = t.fingerId;
            _dragPos        = t.position;
            _tapDown        = (t.phase == TouchPhase.Began);
            _tapScreenPos   = t.position;
            _tapBeganOverUI = _tapDown && IsPointerOverUI(t.position);
            KillVelocities();
            _filtPan.Reset(t.position, Time.unscaledTime);
            _hasAnchor      = TryPlaneAnchor(t.position, out _anchorWorld);
            return; // no motion yet
        }

        if (t.phase == TouchPhase.Moved || t.phase == TouchPhase.Stationary)
        {
            var diff = t.position - _dragPos;
            if (diff.sqrMagnitude > 36f) _tapDown = false;

            if (_hasAnchor)
            {
                Vector2 p = _filtPan.Filter(t.position, Time.unscaledTime,
                                            PointerMinCutoff, PointerBeta, PointerDCutoff);
                _pivot = SoftClampPivot(SolvePivotForAnchor(_anchorWorld, p));
            }

            PushVelSample();
            ComputeWindowedVelocity();
            _dragPos = t.position;
        }
        else if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
        {
            _dragId    = -1;
            _hasAnchor = false;
        }
    }

    // ── Mouse + scroll (desktop) ─────────────────────────────────────────────
    private void MouseInput()
    {
        if (TerrainModeActive)
        {
            _mouseDown = false; _tapDown = false; _hasAnchor = false;
        }
        else
        {
            if (Input.GetMouseButtonDown(0))
            {
                _mouseDown      = true;
                _lastMouse      = Input.mousePosition;
                _tapDown        = true;
                _tapScreenPos   = Input.mousePosition;
                _tapBeganOverUI = IsPointerOverUI((Vector2)Input.mousePosition);
                KillVelocities();
                _filtPan.Reset(Input.mousePosition, Time.unscaledTime);
                _hasAnchor      = TryPlaneAnchor(Input.mousePosition, out _anchorWorld);
            }
            if (!Input.GetMouseButton(0))
            {
                if (_mouseDown) _hasAnchor = false;
                _mouseDown = false;
            }

            if (_mouseDown)
            {
                var diff = Input.mousePosition - _lastMouse;
                if (diff.sqrMagnitude > 9f) _tapDown = false;
                if (_hasAnchor)
                {
                    Vector2 p = _filtPan.Filter(Input.mousePosition, Time.unscaledTime,
                                                PointerMinCutoff, PointerBeta, PointerDCutoff);
                    _pivot = SoftClampPivot(SolvePivotForAnchor(_anchorWorld, p));
                }
                PushVelSample();
                ComputeWindowedVelocity();
                _lastMouse = Input.mousePosition;
            }
        }

        _lastMouse = Input.mousePosition;

        float scroll = Input.mouseScrollDelta.y;
        if (Mathf.Abs(scroll) > 0.001f)
        {
            // Zoom toward whatever's under the cursor — capture a fresh
            // anchor, change _dist, then snap pivot so the same world
            // point stays under the cursor.
            if (TryPlaneAnchor(Input.mousePosition, out var scrollAnchor))
            {
                Zoom(-scroll * 2.5f); // was 1.8 — snappier scroll zoom
                _pivot = SoftClampPivot(SolvePivotForAnchor(scrollAnchor, Input.mousePosition));
            }
            else
            {
                Zoom(-scroll * 2.5f);
            }
            PushVelSample();
            ComputeWindowedVelocity();
        }
    }

    // ── Anchor math ──────────────────────────────────────────────────────────

    // Find the touch with this fingerId in the current Input.touches.
    // Robust against index shuffling when fingers come and go.
    private bool TryGetTouchById(int id, out Touch found)
    {
        for (int i = 0; i < Input.touchCount; i++)
        {
            var t = Input.GetTouch(i);
            if (t.fingerId == id) { found = t; return true; }
        }
        found = default;
        return false;
    }

    // World-space direction of the ray from the camera through a screen
    // pixel, under a hypothetical rotation. Uses cam.ScreenPointToRay with
    // a temporary rotation swap so it respects whatever projection matrix
    // Unity is using (custom aspect, URP overrides, etc.) — much more
    // robust than hand-rolling NDC math when cam.aspect ≠ screen aspect.
    private Vector3 ScreenRayDirection(Vector2 pixel, Quaternion rot)
    {
        var cam = Camera.main;
        if (!cam) return rot * Vector3.forward;
        var saved = cam.transform.rotation;
        cam.transform.rotation = rot;
        var dir = cam.ScreenPointToRay(pixel).direction;
        cam.transform.rotation = saved;
        return dir;
    }

    // Capture the world point on the y=0 plane under a screen pixel. If
    // the ray can't hit the plane forward (camera near-horizontal or
    // looking up), fall back to the virtual plane at the camera's forward
    // distance so we always have a usable anchor — the user feels a slight
    // loss of stickiness, not a discontinuous freeze.
    private bool TryPlaneAnchor(Vector2 pixel, out Vector3 worldXZ)
    {
        var rot     = Quaternion.Euler(_pitch, _yaw, 0f);
        var forward = rot * Vector3.forward;
        var dir     = ScreenRayDirection(pixel, rot);
        var camPos  = _pivot - forward * _dist;

        if (dir.y < -1e-3f)
        {
            float t = -camPos.y / dir.y;
            if (t > 0f && t < 10f * _dist)
            {
                var hit = camPos + dir * t;
                worldXZ = new Vector3(hit.x, 0f, hit.z);
                return true;
            }
        }
        // Fallback: virtual plane perpendicular to forward at _dist ahead.
        var fallback = camPos + dir * _dist;
        worldXZ = new Vector3(fallback.x, 0f, fallback.z);
        return true;
    }

    // Closed-form: given the current _pitch / _yaw / _dist and the target
    // anchor, return the pivot.xz (with pivot.y = 0) that makes the
    // anchor project to the given screen pixel.
    //
    // Derivation:
    //   camera = pivot - forward * dist,  pivot.y = 0  ⇒  camera.y = -forward.y * dist
    //   ray hits y=0 at t = -camera.y / dir.y
    //   anchor = camera + t*dir
    //   ⇒ pivot.x = anchor.x + forward.x*dist - t*dir.x
    //   ⇒ pivot.z = anchor.z + forward.z*dist - t*dir.z
    private Vector3 SolvePivotForAnchor(Vector3 anchor, Vector2 pixel)
    {
        var rot     = Quaternion.Euler(_pitch, _yaw, 0f);
        var forward = rot * Vector3.forward;
        var dir     = ScreenRayDirection(pixel, rot);

        float camY = -forward.y * _dist;
        float t;
        if (dir.y < -1e-3f)
        {
            t = -camY / dir.y;
            // Reject degenerate intersections (behind camera, or absurdly
            // far) and fall back to the virtual plane at _dist ahead.
            if (t < 0f || t > 10f * _dist) t = _dist;
        }
        else
        {
            t = _dist;
        }

        float pivotX = anchor.x + forward.x * _dist - t * dir.x;
        float pivotZ = anchor.z + forward.z * _dist - t * dir.z;
        return new Vector3(pivotX, 0f, pivotZ);
    }

    private void Zoom(float delta)
    {
        _dist = SoftClamp(_dist + delta, DistMin, DistMax, DistOvershoot);
    }

    // ── Inertia ──────────────────────────────────────────────────────────────
    // Each axis carries its windowed velocity past the lift. Velocity is
    // only consumed (and damped) when the corresponding gesture is NOT
    // being actively driven this frame — otherwise the user's direct
    // input would fight the glide. Soft clamps + snap-to-rest floors give
    // the camera a hard stop with rubber-band feel at the limits.
    private void ApplyInertia()
    {
        if (Time.deltaTime <= 0f) return;
        float decayExp = Time.deltaTime * 60f;

        bool oneFinger   = (Input.touchCount == 1 && _dragId >= 0)
                          || (Input.touchCount == 0 && _mouseDown);
        bool pinchActive = _pinching && _pinchEngaged;
        bool twistActive = _pinching && _twistEngaged;
        bool tiltActive  = _pinching && _tiltEngaged;

        if (!oneFinger && _panVelocity.sqrMagnitude > PanSnapFloor * PanSnapFloor)
        {
            _pivot = SoftClampPivot(_pivot + _panVelocity * Time.deltaTime);
            _panVelocity *= Mathf.Pow(PanDamping, decayExp);
            if (_panVelocity.sqrMagnitude < PanSnapFloor * PanSnapFloor)
                _panVelocity = Vector3.zero;
        }
        else _panVelocity = Vector3.zero;

        if (!pinchActive && Mathf.Abs(_zoomVelocity) > ZoomSnapFloor)
        {
            _dist = SoftClamp(_dist + _zoomVelocity * Time.deltaTime,
                              DistMin, DistMax, DistOvershoot);
            _zoomVelocity *= Mathf.Pow(ZoomDamping, decayExp);
            if (Mathf.Abs(_zoomVelocity) < ZoomSnapFloor) _zoomVelocity = 0f;
        }
        else if (!pinchActive) _zoomVelocity = 0f;

        if (!twistActive && Mathf.Abs(_yawVelocity) > YawSnapFloor)
        {
            _yaw += _yawVelocity * Time.deltaTime;
            _yawVelocity *= Mathf.Pow(YawDamping, decayExp);
            if (Mathf.Abs(_yawVelocity) < YawSnapFloor) _yawVelocity = 0f;
        }
        else if (!twistActive) _yawVelocity = 0f;

        if (!tiltActive && Mathf.Abs(_pitchVelocity) > PitchSnapFloor)
        {
            _pitch = SoftClamp(_pitch + _pitchVelocity * Time.deltaTime,
                               PitchMin, PitchMax, PitchOvershootDeg);
            _pitchVelocity *= Mathf.Pow(PitchDamping, decayExp);
            if (Mathf.Abs(_pitchVelocity) < PitchSnapFloor) _pitchVelocity = 0f;
        }
        else if (!tiltActive) _pitchVelocity = 0f;
    }

    // ── Select mode ───────────────────────────────────────────────────────────

    // True when the supplied pointer is currently over a ReactUnity UI element.
    // Touch ID < 0 means "mouse / default pointer". Used to suppress the
    // camera's tap-select / object-drag paths when the user is interacting
    // with overlay buttons (rotate / duplicate / resize / asset shop / etc.).
    // Reused raycast scratch buffer so the per-touch UI test doesn't allocate.
    private static readonly List<RaycastResult> _uiHits = new List<RaycastResult>();

    // True when a *blocking* React UI element sits under `screenPos`. We raycast
    // the UI graph ourselves rather than calling EventSystem.IsPointerOverGameObject:
    // that API reports the PREVIOUS frame's result, so on the touch-began frame it
    // returns false and a press on a button leaks through to the 3D select-tap
    // (the "pressing UI presses assets behind it" bug). A direct RaycastAll at the
    // exact screen position is correct on the began frame.
    //
    // The transparent viewport overlays that exist only to capture gestures (the
    // double-tap area, the root container) are tagged with the `editor-passthrough`
    // class on the React side; they must NOT count as blocking or tapping the
    // viewport could never select an object. So a hit only blocks if it's a real
    // UI element — anything not flagged passthrough.
    private static bool IsPointerOverUI(Vector2 screenPos)
    {
        var es = EventSystem.current;
        if (es == null) return false;
        var ped = new PointerEventData(es) { position = screenPos };
        _uiHits.Clear();
        es.RaycastAll(ped, _uiHits);
        for (int i = 0; i < _uiHits.Count; i++)
        {
            var go = _uiHits[i].gameObject;
            if (go == null) continue;
            if (IsPassthroughUI(go)) continue;
            return true;
        }
        return false;
    }

    // A ReactUnity element flagged with the `editor-passthrough` class — the
    // gesture-capture overlays that sit over the 3D viewport but must let taps
    // reach the camera. Read straight off the element's ReactElement component so
    // it doesn't depend on GameObject-naming being enabled.
    //
    // IMPORTANT: ReactUnity puts the raycast-target graphic on a CHILD GameObject
    // (an internal "[Background]" object), while ReactElement lives on the element's
    // MAIN GameObject — the parent. So a RaycastResult.gameObject won't carry
    // ReactElement itself; we must walk up with GetComponentInParent. (Using
    // GetComponent here was the bug that made every overlay read as blocking UI,
    // which froze asset moves and taps over a selected object.) GetComponentInParent
    // returns the NEAREST element, so a real button nested under the passthrough
    // root still resolves to the button (non-passthrough), not the root.
    private static bool IsPassthroughUI(GameObject go)
    {
        var re = go.GetComponentInParent<ReactElement>();
        var cls = re != null && re.Component != null ? re.Component.ClassName : null;
        return cls != null && cls.Contains("editor-passthrough");
    }

    // Abandon any pending single-tap. Called on the SheetDragging false→true
    // transition: React just took ownership of the gesture (a top-bar button
    // press or a left-dock panel opening). Without this, a tap whose began-frame
    // raced ahead of the lock keeps _tapDown armed, so ProcessSelectTap fires on
    // release — raycasting from the old tap point through the now-reframed scene,
    // missing the model, and clearing the selection. That silently unmounts the
    // open panel and leaves the camera locked (anyLeftPanelOpen stays true with
    // nothing visible to dismiss it). Killing the tap here closes that race.
    private void CancelPendingTap()
    {
        _tapDown        = false;
        _tapBeganOverUI = false;
    }

    private void ProcessSelectTap()
    {
        bool tapped = false;
        if (Input.touchCount == 1 && Input.GetTouch(0).phase == TouchPhase.Ended && _tapDown)
            tapped = true;
        else if (Input.touchCount == 0 && Input.GetMouseButtonUp(0) && _tapDown)
            tapped = true;

        if (!tapped) return;
        _tapDown = false;
        // Tap originated on a React UI element (the selection overlay's
        // rotate / duplicate / resize buttons sit on top of the viewport).
        // The button's onClick already ran; if we raycast from this screen
        // pos we'd miss the model and clear the selection, killing the
        // chained-edit workflow. Bail.
        if (_tapBeganOverUI) { _tapBeganOverUI = false; return; }

        var cam = Camera.main;
        if (!cam) return;
        var ray = cam.ScreenPointToRay(_tapScreenPos);
        if (Physics.Raycast(ray, out var hit, 500f))
        {
            var go = hit.collider.gameObject;
            if (go.name == "_Trigger" && go.transform.parent)
                go = go.transform.parent.gameObject;
            // Treat terrain / ground / editor-managed floor planes as empty
            // space — tapping them deselects, same as a sky-miss. Stops the
            // user from accidentally "selecting" the terrain itself when they
            // were aiming to clear a selection. (Checked on the raw hit — terrain
            // isn't parented under the game root.)
            if (IsTerrainOrGround(go))
            {
                ClearHighlight();
                Notify("_selectedObject", "");
                return;
            }
            // Resolve a hit on a nested mesh node up to the capture-tracked root
            // child so move/scale/rotate/logic edits land on the object the
            // snapshot records (otherwise they never save or undo).
            go = ResolveTrackedRoot(go);
            HighlightGo(go);
            var p = go.transform.position;
            Notify("_selectedObject", $"{go.name}|{p.x:F1},{p.y:F1},{p.z:F1}");
        }
        else
        {
            ClearHighlight();
            Notify("_selectedObject", "");
        }
    }

    // Anything the user shouldn't be able to "select" because it represents the
    // world rather than a placed prop: Meshy terrain tiles, the safety / fallback
    // floor planes, the TerrainBuilder sculpting mesh, and Lua-script terrain
    // primitives (Structure.Plane is the shape used by LuauUnityApi.CreateTerrain).
    private static bool IsTerrainOrGround(GameObject go)
    {
        if (go == null) return true;
        var marker = go.GetComponentInParent<MeshyAssetMarker>();
        if (marker != null && marker.IsTerrain) return true;
        var n = go.name;
        if (n == "_SafetyFloor" || n == "_FallbackGround") return true;
        if (n == "[TerrainBuilder]" || n == "Structure.Plane") return true;
        return false;
    }

    // Returns true if we just took over input as object-drag, in which case
    // ProcessSelectTap should bail (the camera and tap path don't run for the
    // rest of the gesture).
    private bool TryStartMoveOnSelected()
    {
        if (_selGo == null) return false;

        Vector2 screenPos;
        bool   wantsMove;
        int    touchId = -1;
        if (Input.touchCount == 1)
        {
            var t = Input.GetTouch(0);
            if (t.phase != TouchPhase.Began) return false;
            if (IsPointerOverUI(t.position)) return false;
            screenPos = t.position;
            touchId   = t.fingerId;
            wantsMove = true;
        }
        else if (Input.GetMouseButtonDown(0))
        {
            if (IsPointerOverUI((Vector2)Input.mousePosition)) return false;
            screenPos = Input.mousePosition;
            wantsMove = true;
        }
        else return false;

        if (!wantsMove) return false;

        var cam = Camera.main;
        if (!cam) return false;
        var ray = cam.ScreenPointToRay(screenPos);
        if (!Physics.Raycast(ray, out var hit, 500f)) return false;

        // Walk up to the selectable root so picking on a child renderer still
        // counts as "tapped the selected object".
        var hitRoot = hit.collider.gameObject;
        if (hitRoot.name == "_Trigger" && hitRoot.transform.parent)
            hitRoot = hitRoot.transform.parent.gameObject;
        if (hitRoot != _selGo && !hitRoot.transform.IsChildOf(_selGo.transform))
            return false;

        _movingSel     = true;
        _movingTouchId = touchId;
        _movingMouse   = touchId < 0;
        _tapDown       = false;

        // Capture grounded-vs-floating state. If the object's bottom is
        // within GroundedToleranceY of the terrain under it, treat it as
        // grounded and have it follow terrain height during the drag.
        // Otherwise preserve the world-Y throughout.
        CaptureMoveAnchorHeight();

        Notify("_editorDraggingObject", "true");
        return true;
    }

    // Measure the selected object's world AABB and compare its bottom to
    // the terrain height directly under its current pivot. Populates the
    // _movingSelGrounded / _movingSelBottomOffset / _movingSelFloatY
    // fields used by UpdateMovingSel.
    private void CaptureMoveAnchorHeight()
    {
        _movingSelGrounded     = false;
        _movingSelBottomOffset = 0f;
        _movingSelFloatY       = _selGo != null ? _selGo.transform.position.y : 0f;
        if (_selGo == null) return;

        var rends = _selGo.GetComponentsInChildren<Renderer>(false);
        if (rends.Length == 0) return;
        bool first = true;
        Bounds box = default;
        foreach (var r in rends)
        {
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { box = r.bounds; first = false; }
            else        box.Encapsulate(r.bounds);
        }
        if (first) return;

        var pos = _selGo.transform.position;
        float terrainY = ResolveTerrainY(pos.x, pos.z, _selGo);
        float bottomGap = box.min.y - terrainY;
        if (Mathf.Abs(bottomGap) <= GroundedToleranceY)
        {
            _movingSelGrounded     = true;
            _movingSelBottomOffset = pos.y - box.min.y; // distance from pivot to bottom
        }
    }

    private void UpdateMovingSel()
    {
        if (_selGo == null) { EndMovingSel(deleteIfOverTrash: false); return; }
        var cam = Camera.main;
        if (!cam) { EndMovingSel(deleteIfOverTrash: false); return; }

        // Pick up the current pointer position, and detect release.
        Vector2 screenPos;
        bool    released = false;
        if (_movingMouse)
        {
            screenPos = Input.mousePosition;
            if (!Input.GetMouseButton(0)) released = true;
        }
        else
        {
            // Find our finger.
            bool found = false;
            screenPos = default;
            for (int i = 0; i < Input.touchCount; i++)
            {
                var t = Input.GetTouch(i);
                if (t.fingerId != _movingTouchId) continue;
                screenPos = t.position;
                if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled) released = true;
                found = true;
                break;
            }
            if (!found) released = true; // finger went away
        }

        if (!released)
        {
            // Project the cursor onto the terrain (or y=0 plane) and move
            // the object there. Uses the same anchor → terrain-down logic
            // as editorPlaceAsset so initial place and subsequent move feel
            // identical.
            var ray = cam.ScreenPointToRay(screenPos);
            Vector3 anchor;
            if (Physics.Raycast(ray, out var hit, 500f,
                                ~0, QueryTriggerInteraction.Ignore))
            {
                // Ignore self-hits so the ray doesn't catch our own collider.
                if (hit.collider != null &&
                    !hit.collider.transform.IsChildOf(_selGo.transform))
                    anchor = hit.point;
                else
                {
                    var plane = new Plane(Vector3.up, Vector3.zero);
                    if (!plane.Raycast(ray, out float enter)) return;
                    anchor = ray.GetPoint(enter);
                }
            }
            else
            {
                var plane = new Plane(Vector3.up, Vector3.zero);
                if (!plane.Raycast(ray, out float enter)) return;
                anchor = ray.GetPoint(enter);
            }

            // Grounded objects follow the terrain height; floating objects
            // keep the world-Y they had at drag-start. SnapToTerrainIfBelow
            // still acts as a safety net in the floating case so a flying
            // prop dragged over a hill doesn't clip into geometry.
            float newY;
            if (_movingSelGrounded)
            {
                float terrainY = ResolveTerrainY(anchor.x, anchor.z, _selGo);
                newY = terrainY + _movingSelBottomOffset;
            }
            else
            {
                newY = _movingSelFloatY;
            }
            _selGo.transform.position = new Vector3(anchor.x, newY, anchor.z);
            ClampSelectionAboveTerrain();
            return;
        }

        // Released — check trash zone (bottom-center, matched to the React
        // icon position via canvas scale).
        EndMovingSel(deleteIfOverTrash: IsOverTrash(screenPos));
    }

    // Shared trash-zone hit test in Unity-pixel screen space. The React UI
    // renders the trash icon at bottom-center; its CENTER y in React reference
    // units (bottom-origin) is safeAreaBottom + half-icon-height. Multiply by
    // the live canvas scale to get Unity pixels. Used by UpdateMovingSel
    // (delete placed object on drop) and editorPlaceAsset (cancel strip-tile
    // placement on drop) so both paths use identical bounds.
    public static bool IsOverTrash(Vector2 screenPos)
    {
        float scale = Mathf.Max(GameLauncher.GetReactCanvasScale(), 0.01f);
        float safeBottomRef = GameLauncher.SafeAreaBottomRef();
        float trashX = Screen.width * 0.5f;
        float trashY = (safeBottomRef + TrashIconHalfHeight) * scale;
        return Vector2.Distance(screenPos, new Vector2(trashX, trashY)) <= TrashRadiusPx;
    }

    private void EndMovingSel(bool deleteIfOverTrash)
    {
        if (!_movingSel)
        {
            Notify("_editorDraggingObject", "false");
            return;
        }
        _movingSel     = false;
        _movingTouchId = -1;
        _movingMouse   = false;
        Notify("_editorDraggingObject", "false");

        if (deleteIfOverTrash && _selGo != null)
        {
            var doomed = _selGo;
            // Mirror DeleteSelected: a script-created object reappears when the
            // Lua script re-runs (play mode / reload), so record its name for
            // EditorState to re-delete after the run. User-added objects
            // (EditorPlacedObject) aren't tracked — leaving them out of the
            // `added` list is enough to keep them gone. Without this, dragging a
            // script object to the trash looked deleted but came back.
            if (doomed.GetComponent<EditorPlacedObject>() == null && !string.IsNullOrEmpty(doomed.name))
                EditorState.DeletedNames.Add(doomed.name);
            ClearHighlight();
            Notify("_selectedObject", "");
            Destroy(doomed);
        }
        // Drag-move commits (whether finalised in-world or sent to trash) are
        // user-visible edits — bump the dirty rev so autosave picks them up.
        MarkStateDirty();
    }

    private static float ResolveTerrainY(float x, float z, GameObject ignore)
    {
        var origin = new Vector3(x, 500f, z);
        var hits = Physics.RaycastAll(origin, Vector3.down, 1000f, ~0, QueryTriggerInteraction.Ignore);
        float best = float.MinValue;
        foreach (var h in hits)
        {
            if (h.collider == null) continue;
            if (ignore != null && h.collider.transform.IsChildOf(ignore.transform)) continue;
            var mk = h.collider.GetComponentInParent<MeshyAssetMarker>();
            if (mk == null || !mk.IsTerrain) continue;
            if (h.point.y > best) best = h.point.y;
        }
        return best > float.MinValue ? best : 0f;
    }

    private void HighlightGo(GameObject go)
    {
        ClearHighlight();
        _selGo       = go;
        _selRends    = go.GetComponentsInChildren<Renderer>();
        _selOrigEmit = new Color[_selRends.Length];
        for (int i = 0; i < _selRends.Length; i++)
        {
            // glTF / ShaderGraph materials ("Shader Graphs/glTF-pbrMetallicRoughness",
            // used by every Meshy GLB) have no "_EmissionColor" property. Reading it
            // throws, which aborted the whole SelectGameObject call BEFORE it could
            // Notify("_selectedObject", …) — leaving React in select-mode with no
            // selected object, so a freshly-dropped asset couldn't be moved/deleted
            // and the editor looked frozen. Gate on sharedMaterial.HasProperty so we
            // only instantiate (.material) and touch emission on materials that
            // support it; unsupported materials are simply left un-highlighted.
            var shared = _selRends[i].sharedMaterial;
            if (shared == null || !shared.HasProperty("_EmissionColor")) continue;
            var mat = _selRends[i].material;
            _selOrigEmit[i] = mat.GetColor("_EmissionColor");
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.1f, 0.5f, 1f) * 2.5f);
        }
    }

    private void ClearHighlight()
    {
        if (_selRends == null) return;
        for (int i = 0; i < _selRends.Length; i++)
        {
            if (!_selRends[i]) continue;
            // Mirror the HighlightGo gate — only restore emission on materials we
            // actually modified (those exposing "_EmissionColor").
            var shared = _selRends[i].sharedMaterial;
            if (shared == null || !shared.HasProperty("_EmissionColor")) continue;
            var mat = _selRends[i].material;
            mat.SetColor("_EmissionColor", _selOrigEmit[i]);
            if (_selOrigEmit[i] == Color.black) mat.DisableKeyword("_EMISSION");
        }
        _selRends    = null;
        _selOrigEmit = null;
        _selGo       = null;
    }

    // Cache ReactRendererUGUI lookups — PublishSelectionBounds calls
    // Notify every frame, and FindObjectsByType isn't free. Refresh once a
    // second to pick up renderers that come and go (e.g. scene transitions).
    private static ReactRendererUGUI[] _cachedRenderers;
    private static float               _renderersNextRefresh;
    private const  float               RenderersRefreshInterval = 1f;

    private static void Notify(string key, string val)
    {
        if (_cachedRenderers == null || Time.time >= _renderersNextRefresh)
        {
            _cachedRenderers = FindObjectsByType<ReactRendererUGUI>(FindObjectsSortMode.None);
            _renderersNextRefresh = Time.time + RenderersRefreshInterval;
        }
        for (int i = 0; i < _cachedRenderers.Length; i++)
        {
            var r = _cachedRenderers[i];
            if (r != null) r.Globals[key] = val;
        }
    }

    // Editor-state dirty marker. Every concrete edit operation bumps this rev;
    // React's CreateScreen polls _editorStateRev, captures via editorCaptureState
    // when it changes, and POSTs the snapshot debounced (~1.5 s after edits go
    // quiet). Public + static so other systems (terrain brush, asset hot-swap,
    // GameLauncher's editorPlaceAsset path) can bump it without a controller ref.
    private static int _stateRev;
    // Current dirty rev. Read by LuauGameRunner.ReapplyEditorStateLater so it can
    // detect a genuine user edit mid-restore (EditorState.Apply never bumps this,
    // so any change is the user) and stop re-applying the load-time snapshot —
    // otherwise each reapply pass overwrites the user's move/rotate/scale/setting/
    // logic edit back to its saved value and the edit never persists.
    public static int CurrentStateRev => _stateRev;
    public static void MarkStateDirty()
    {
        _stateRev++;
        Notify("_editorStateRev", _stateRev.ToString());
    }

    // ── Camera-pose persistence ────────────────────────────────────────────────
    // Reopening the editor should frame the scene where the user left it. The
    // camera pose is already captured into editor_state's `camera` key, but a
    // pan/orbit/zoom is NOT an "edit" — it must not bump _stateRev (that drives
    // the undo stack; the camera is deliberately excluded from undo). So camera
    // moves bump a SEPARATE rev that the autosave poll also watches: a change to
    // it triggers a debounced save (which re-captures the pose) WITHOUT pushing
    // an undo entry. Throttled to ~5 Hz while moving; the autosave's own 1.5 s
    // debounce then captures the final settled pose.
    private static int _cameraRev;
    public static int CurrentCameraRev => _cameraRev;
    private Vector3 _camPersistPivot = new Vector3(float.NaN, 0f, 0f);
    private float   _camPersistYaw, _camPersistPitch, _camPersistDist;
    private float   _camPersistNextTime;
    private void TrackCameraPersist()
    {
        bool changed = float.IsNaN(_camPersistPivot.x)
            || Mathf.Abs(_yaw   - _camPersistYaw)   > 0.1f
            || Mathf.Abs(_pitch - _camPersistPitch) > 0.1f
            || Mathf.Abs(_dist  - _camPersistDist)  > 0.05f
            || (_pivot - _camPersistPivot).sqrMagnitude > 0.0025f;
        if (!changed || Time.time < _camPersistNextTime) return;
        _camPersistPivot = _pivot; _camPersistYaw = _yaw;
        _camPersistPitch = _pitch; _camPersistDist = _dist;
        _camPersistNextTime = Time.time + 0.2f;
        _cameraRev++;
        Notify("_editorCameraRev", _cameraRev.ToString());
    }

    // ── Selection bounds (for the React overlay UI) ──────────────────────────
    // Projects the selected object's world AABB to screen pixels, then converts
    // to React reference units (top-left origin) and publishes them as a
    // single CSV global `_editorSelBoundsRef = "left,top,right,bottom"`. While
    // the user is dragging the object the global is cleared so the React
    // overlay hides (the trash icon takes over).
    private void PublishSelectionBounds()
    {
        if (!SelectActive || _selGo == null || _selRends == null || _movingSel)
        {
            Notify("_editorSelBoundsRef", "");
            return;
        }
        var cam = Camera.main;
        if (cam == null) return;

        // World AABB from all renderers under the selected GO.
        bool first = true;
        Bounds box = default;
        foreach (var r in _selRends)
        {
            if (r == null) continue;
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { box = r.bounds; first = false; }
            else        box.Encapsulate(r.bounds);
        }
        if (first) { Notify("_editorSelBoundsRef", ""); return; }

        var c = box.center;
        var e = box.extents;
        Vector3[] corners = {
            c + new Vector3(-e.x, -e.y, -e.z),
            c + new Vector3( e.x, -e.y, -e.z),
            c + new Vector3(-e.x,  e.y, -e.z),
            c + new Vector3( e.x,  e.y, -e.z),
            c + new Vector3(-e.x, -e.y,  e.z),
            c + new Vector3( e.x, -e.y,  e.z),
            c + new Vector3(-e.x,  e.y,  e.z),
            c + new Vector3( e.x,  e.y,  e.z),
        };

        float minX = float.MaxValue, maxX = float.MinValue;
        float minY = float.MaxValue, maxY = float.MinValue;
        bool anyFront = false;
        foreach (var w in corners)
        {
            var s = cam.WorldToScreenPoint(w);
            if (s.z <= 0f) continue; // corner is behind the camera
            anyFront = true;
            if (s.x < minX) minX = s.x;
            if (s.x > maxX) maxX = s.x;
            if (s.y < minY) minY = s.y;
            if (s.y > maxY) maxY = s.y;
        }
        if (!anyFront) { Notify("_editorSelBoundsRef", ""); return; }

        float scale = Mathf.Max(GameLauncher.GetReactCanvasScale(), 0.01f);
        float left   = minX / scale;
        float right  = maxX / scale;
        // Unity is bottom-left, React is top-left → flip Y.
        float top    = (Screen.height - maxY) / scale;
        float bottom = (Screen.height - minY) / scale;

        Notify("_editorSelBoundsRef", $"{left:F1},{top:F1},{right:F1},{bottom:F1}");
    }

    // ── React-bridged selection operations ───────────────────────────────────

    public void RotateSelected(float deltaYawDeg)
    {
        // Legacy entry point (still used by older / programmatic callers) —
        // routes to the generic axis rotator with world-up. The selection
        // overlay's three buttons go through RotateSelectedAxis directly so
        // each axis can be camera-relative.
        RotateSelectedAxis("yaw", deltaYawDeg);
    }

    // Rotate the selected object by `deltaDeg` around one of three axes:
    //   "yaw"   — world up (left/right spin on the ground plane).
    //   "pitch" — camera right (object nods up/down as the user sees it).
    //   "roll"  — camera forward (object tumbles sideways from camera POV).
    // Pitch and roll project the camera basis to the horizontal plane so
    // rotating doesn't drift the object off-axis when the camera is
    // mid-pitch — the user-facing direction stays predictable.
    public void RotateSelectedAxis(string axis, float deltaDeg)
    {
        if (_selGo == null) return;
        Vector3 worldAxis;
        switch ((axis ?? "yaw").ToLowerInvariant())
        {
            case "pitch":
            {
                var cam = Camera.main;
                if (cam == null) return;
                var right = cam.transform.right; right.y = 0f;
                if (right.sqrMagnitude < 1e-4f) right = Vector3.right;
                worldAxis = right.normalized;
                break;
            }
            case "roll":
            {
                var cam = Camera.main;
                if (cam == null) return;
                var fwd = cam.transform.forward; fwd.y = 0f;
                if (fwd.sqrMagnitude < 1e-4f) fwd = Vector3.forward;
                worldAxis = fwd.normalized;
                break;
            }
            case "yaw":
            default:
                worldAxis = Vector3.up;
                break;
        }
        _selGo.transform.Rotate(worldAxis, deltaDeg, Space.World);
        GameAssetLoader.SnapToTerrainIfBelow(_selGo);
        MarkStateDirty();
    }

    public void DuplicateSelected()
    {
        if (_selGo == null) return;
        var clone = Instantiate(_selGo, _selGo.transform.parent);
        // Give the clone a stable, unique name and tag it as a user-added object
        // so EditorState persists it (the Lua script never recreates duplicates).
        // Instantiate copies any EditorPlacedObject from the source, so a
        // duplicate of a placed asset inherits its re-spawn recipe for free; a
        // duplicate of a script object gets a clone-of recipe pointing at it.
        clone.name = EditorState.UniqueAddedName(_selGo.name, _selGo.transform.parent);
        var dupMarker = clone.GetComponent<EditorPlacedObject>();
        if (dupMarker == null)
        {
            dupMarker = clone.AddComponent<EditorPlacedObject>();
            dupMarker.cloneOf = _selGo.name;
        }
        // Offset along world-X by roughly one model width so the clone is
        // visible next to the original instead of stacking.
        float offsetX = 1.5f;
        if (_selRends != null && _selRends.Length > 0)
        {
            bool first = true; Bounds b = default;
            foreach (var r in _selRends)
            {
                if (r == null) continue;
                if (first) { b = r.bounds; first = false; }
                else        b.Encapsulate(r.bounds);
            }
            if (!first) offsetX = Mathf.Max(0.5f, b.size.x * 1.1f);
        }
        clone.transform.position = _selGo.transform.position + new Vector3(offsetX, 0f, 0f);
        GameAssetLoader.SnapToTerrainIfBelow(clone);
        // Move selection onto the clone so the next op acts on the new copy
        // (typical "duplicate then nudge" workflow).
        SelectGameObject(clone);
        MarkStateDirty();
    }

    // Deletes the currently-selected object. React's bottom-center trash button
    // taps this when an object is selected (the asset strip is swapped for the
    // trash while a selection is active). Clears the selection so the editor
    // chrome falls back to the asset strip, but stays in select mode so the user
    // can immediately tap another object. No-op if nothing is selected.
    public void DeleteSelected()
    {
        if (_selGo == null) return;
        var doomed = _selGo;
        // A script-created object reappears when the script re-runs, so record
        // its name for EditorState to re-delete after the run. User-added objects
        // (EditorPlacedObject) aren't tracked — leaving them out of the `added`
        // list is enough to keep them gone.
        if (doomed.GetComponent<EditorPlacedObject>() == null && !string.IsNullOrEmpty(doomed.name))
            EditorState.DeletedNames.Add(doomed.name);
        // End any in-progress move first so _editorDraggingObject can't stick.
        EndMovingSel(deleteIfOverTrash: false);
        ClearHighlight();
        Notify("_selectedObject", "");
        Destroy(doomed);
        MarkStateDirty();
    }

    public void ScaleSelected(float factor)
    {
        if (_selGo == null || factor <= 0f) return;
        _lastScaleTime = Time.time;

        var ls = _selGo.transform.localScale;
        var ns = ls * factor;

        // Soft cap: past the hard limit the delta is compressed to the overshoot
        // band asymptotically — the user feels growing resistance, not a wall.
        float softMin = ScaleMin * (1f - ScaleOvershoot);
        float softMax = ScaleMax * (1f + ScaleOvershoot);
        float cur = ls.x; float nv = ns.x;
        if (nv < softMin) nv = softMin;
        if (nv > softMax) nv = softMax;
        float ratio = (cur > 1e-6f) ? nv / cur : 1f;
        _selGo.transform.localScale = ls * ratio;

        ClampSelectionAboveTerrain();
        MarkStateDirty();
    }

    // Pulls the selected object's scale back inside [ScaleMin, ScaleMax] with a
    // critically-damped spring once the user has stopped scaling (no ScaleSelected
    // call for ScaleSpringDelay seconds). The brief spring-back is the tactile
    // signal that a limit was reached — the object stretches then snaps back.
    private void ApplyScaleSpring()
    {
        if (_selGo == null) return;
        if (Time.time - _lastScaleTime < ScaleSpringDelay) return;
        if (Time.deltaTime <= 0f) return;

        var ls = _selGo.transform.localScale;
        bool anyOut = ls.x < ScaleMin || ls.x > ScaleMax ||
                      ls.y < ScaleMin || ls.y > ScaleMax ||
                      ls.z < ScaleMin || ls.z > ScaleMax;
        if (!anyOut) return;

        float keep = Mathf.Pow(0.01f, Time.deltaTime / ScaleSpringSettleTime);
        float nx = Mathf.Lerp(Mathf.Clamp(ls.x, ScaleMin, ScaleMax), ls.x, keep);
        float ny = Mathf.Lerp(Mathf.Clamp(ls.y, ScaleMin, ScaleMax), ls.y, keep);
        float nz = Mathf.Lerp(Mathf.Clamp(ls.z, ScaleMin, ScaleMax), ls.z, keep);
        _selGo.transform.localScale = new Vector3(nx, ny, nz);
        ClampSelectionAboveTerrain();
    }

    // Vertical-move variant for the selection-overlay's right-edge handle. React
    // passes a per-tick signed delta in world units, driven by a vertical swipe —
    // swipe up to lift, swipe down to lower. We translate along world-up, then
    // clamp to terrain so the object can't sink below the ground it stands on.
    public void MoveSelectedVertical(float deltaY)
    {
        if (_selGo == null || deltaY == 0f) return;
        _selGo.transform.position += new Vector3(0f, deltaY, 0f);
        ClampSelectionAboveTerrain();
        MarkStateDirty();
    }

    // Enter object-move state immediately after a programmatic SelectGameObject.
    // Used by the drag-from-strip flow: the asset is spawned and selected, then
    // this is called so the same finger gesture that dragged from the strip
    // continues moving the asset without a lift-and-retap. touchId = -1 for
    // mouse/pointer, >= 0 for touch finger.
    public void BeginMoveSelected(int touchId)
    {
        if (_selGo == null) return;
        _movingSel     = true;
        _movingTouchId = touchId;
        _movingMouse   = touchId < 0;
        _tapDown       = false;
        CaptureMoveAnchorHeight();
        Notify("_editorDraggingObject", "true");
    }

    // Lift the selection so its lowest renderer point never sits below the
    // terrain directly under its footprint. Unlike GameAssetLoader.SnapToTerrainIfBelow,
    // this does NOT require the object to carry a MeshyAssetMarker — the tap-
    // selected GameObject is frequently a child mesh node (the MeshCollider lives
    // on the mesh, the marker on the container), and the marker gate made the
    // vertical-move / scale handles silently no-op, so a prop could be pushed
    // straight into the ground. Samples a 3×3 grid over the world AABB so a wide
    // prop straddling a slope can't poke a corner into a hill either. This is the
    // clamp that stops the vertical handle from lowering a prop past the surface.
    private void ClampSelectionAboveTerrain()
    {
        if (_selGo == null) return;

        var rends = _selGo.GetComponentsInChildren<Renderer>(false);
        if (rends.Length == 0) return;
        bool first = true;
        Bounds box = default;
        foreach (var r in rends)
        {
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { box = r.bounds; first = false; }
            else        box.Encapsulate(r.bounds);
        }
        if (first) return;

        float terrainY = float.MinValue;
        for (int iz = 0; iz <= 2; iz++)
        for (int ix = 0; ix <= 2; ix++)
        {
            float sx = Mathf.Lerp(box.min.x, box.max.x, ix * 0.5f);
            float sz = Mathf.Lerp(box.min.z, box.max.z, iz * 0.5f);
            float y  = ResolveTerrainY(sx, sz, _selGo);
            if (y > terrainY) terrainY = y;
        }
        if (terrainY == float.MinValue) return;

        if (box.min.y < terrainY - 0.001f)
        {
            float lift = terrainY - box.min.y;
            _selGo.transform.position += new Vector3(0f, lift, 0f);
        }
    }

    // React's settings (gear) panel pushes one (key, value) per toggle/input
    // change. We always route to the currently-selected GameObject — the panel
    // is only mounted while a selection is live, so `expectedName` is only
    // used to short-circuit if the selection has changed under us (e.g. the
    // user clicked away between dispatch and arrival). Values arrive as
    // strings so booleans and numbers can share one bridge.
    public void SetObjectSetting(string expectedName, string key, string value)
    {
        if (_selGo == null) return;
        if (!string.IsNullOrEmpty(expectedName) && _selGo.name != expectedName) return;
        var settings = _selGo.GetComponent<EditorObjectSettings>();
        if (settings == null) settings = _selGo.AddComponent<EditorObjectSettings>();
        settings.Set(key, value);
        MarkStateDirty();
    }

    // React's Custom Logic panel pushes the entire LogicGraph JSON on every
    // edit (add node, delete node, parameter change). Same selection gate as
    // SetObjectSetting — the panel is only mounted while a selection is live,
    // so a stale dispatch arriving after a deselection is dropped.
    public void SetObjectLogic(string expectedName, string graphJson)
    {
        if (_selGo == null) return;
        if (!string.IsNullOrEmpty(expectedName) && _selGo.name != expectedName) return;
        var logic = _selGo.GetComponent<EditorObjectLogic>();
        if (logic == null) logic = _selGo.AddComponent<EditorObjectLogic>();
        logic.Set(graphJson);
        MarkStateDirty();
    }
}
