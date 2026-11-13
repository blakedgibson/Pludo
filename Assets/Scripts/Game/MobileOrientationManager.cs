using System.Collections;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using UnityEngine;

// Manages screen orientation for game sessions.
// Forces landscape when a game launches and restores free rotation when returning to the lobby.
//
// Design (post-2026-05 rewrite):
//   • EnterGameOrientationAsync is SYNCHRONOUS — it sets the orientation, the
//     autorotate flags, and the lock in one shot, then returns CompletedTask.
//     The old coroutine-based fade was the source of every "black screen" bug:
//     it activated an opaque overlay canvas, ran a 700 ms async dance, and if
//     anything failed between fade-in and fade-out (cancelled coroutine, mid-
//     coroutine ExitGameOrientation, race) the overlay stuck and the user saw
//     a black screen forever. GameLauncher.ShowLoadingOverlay already hides
//     the visual transition with a proper loading screen, making the fade
//     redundant.
//   • Update() re-asserts landscape every frame while locked. Both the
//     orientation enum and the screen dimensions are checked — Editor Device
//     Simulator slips back to portrait visually while keeping the enum at
//     LandscapeLeft, and the dimension check is the only reliable signal.
//   • ExitGameOrientation defers by 2 frames and re-checks _enterGeneration.
//     A newer Enter (e.g. React re-mount race) bumps the counter and the
//     deferred exit cancels itself, preventing the snap-back-to-portrait
//     pattern seen during editor re-entry.
public class MobileOrientationManager : MonoBehaviour
{
    public static MobileOrientationManager Instance { get; private set; }

    private bool _orientationLocked;
    private bool _logNextReassert = true;
    // Bumped on every EnterGameOrientationAsync. ExitGameOrientation defers by
    // two frames and re-checks this counter; if a newer Enter has arrived in
    // the meantime, the exit is dropped. Defeats every snap-back race we've
    // seen in the editor flow:
    //   • LaunchAsync.finally cancellation (older launch exits orientation
    //     while a newer launch has already re-entered it).
    //   • React EditorScreen useEffect cleanup firing exitGame() on a
    //     transient unmount while the next mount is about to re-enter.
    //   • GamePreviewScreen unmount firing exitGame() as the user taps a
    //     My Games tile and openGame re-enters in the same frame.
    private int  _enterGeneration;

    // True from the moment a game/editor session asks for landscape until it
    // exits — i.e. "landscape has been REQUESTED", which is not the same as
    // "the OS has finished rotating". GameLauncher pairs this with the live
    // screen dimensions to expose getLandscapeReady() to React, so the editor
    // chrome can hold itself back during the rotation window instead of laying
    // landscape UI out on a still-portrait canvas.
    public bool IsGameOrientationLocked => _orientationLocked;

    // Tablets are landscape on EVERY surface — lobby tabs included — because the
    // iPad tab layouts (left nav rail, avatar split view) are built for a wide
    // canvas. Phones keep the original split: portrait lobby, landscape only
    // for game/editor sessions.
    //
    // Consequence worth knowing: on tablet the canvas reference resolution never
    // changes, so entering/leaving a game is a pure no-op for orientation and
    // the rotation-gate window (getLandscapeReady) is already satisfied on the
    // first frame.
    private static bool LandscapeEverywhere => DeviceIdiom.IsTablet;

    // "Landscape is the correct orientation right now", whether that's because a
    // game session asked for it or because we're on a tablet.
    private bool WantsLandscape => _orientationLocked || LandscapeEverywhere;

#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void PludoOrientation_ForceLandscape();
#endif

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void EnsureInstance()
    {
        if (Instance != null) return;
        var go = new GameObject("[MobileOrientationManager]");
        DontDestroyOnLoad(go);
        go.AddComponent<MobileOrientationManager>();
    }

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        // Pin the lobby orientation immediately so the app boots the right way up
        // (portrait on phone, landscape on tablet) before any launch flow runs.
        LockToLobbyOrientation();
    }

    // While locked to landscape, re-force if the OS slips back to portrait.
    // While unlocked (lobby), we hold portrait via the autorotate-flag mask set
    // by LockToPortrait — no per-frame work needed.
    //
    // Two slip-back paths to catch:
    //   1. Real device / "honest" simulator: Screen.orientation reads Portrait.
    //   2. Unity Editor Device Simulator: the simulator visual flips back to
    //      portrait while Screen.orientation still reports LandscapeLeft. The
    //      enum check misses this — the only reliable signal is screen dims.
    private void Update()
    {
        // Tablets re-assert in the lobby too, not just during game sessions —
        // the OS can still hand us a portrait frame on a cold start or after a
        // task-switch, and the tab layouts have no portrait fallback.
        if (!WantsLandscape) return;
        var o = Screen.orientation;
        bool orientationPortrait = o == ScreenOrientation.Portrait || o == ScreenOrientation.PortraitUpsideDown;
        bool visuallyPortrait    = Screen.height > Screen.width;
        if (orientationPortrait || visuallyPortrait)
        {
            if (_logNextReassert)
            {
                _logNextReassert = false;
                Debug.Log($"[MobileOrientationManager] Re-asserting LandscapeLeft (orientation={o}, w={Screen.width}, h={Screen.height})");
            }
#if UNITY_IOS && !UNITY_EDITOR
            PludoOrientation_ForceLandscape();
#endif
            Screen.orientation = ScreenOrientation.LandscapeLeft;
            // Keep the React canvas in landscape units even if a single frame of
            // portrait slipped through — otherwise the safe-area math reads the
            // wrong refRes for one frame and HUD elements jump.
            ApplyCanvasReference(landscape: true);
        }
        else
        {
            // Arm the log so the next re-assert (if any) prints once. Avoids
            // log spam when steady-state is correct.
            _logNextReassert = true;
        }
    }

    // Called when a game is about to start. Forces landscape — used for both
    // real handheld devices and the Editor Device Simulator (which respects
    // Screen.orientation changes the same way phones do).
    //
    // Idempotent: concurrent callers all receive the same in-flight Task, so the
    // fade coroutine runs exactly once even when React's `enterEditorOrientation`
    // and GameLauncher.LaunchAsync both fire within the same frame. Subsequent
    // calls once already locked to landscape are a no-op (no fade, no flag
    // reshuffle).
    public Task EnterGameOrientationAsync()
    {
        // Bump generation BEFORE anything else so a queued DeferredExit sees
        // the new value and cancels itself.
        _enterGeneration++;

        // Hard-lock IMMEDIATELY. No coroutine, no fade. Everything the fade
        // used to hide is already hidden by GameLauncher.ShowLoadingOverlay,
        // and the fade was the source of the "screen stuck black" bug — if
        // any step between fade-in and fade-out failed, the opaque overlay
        // never came down. Snapping orientation directly is simpler and
        // cannot leave the screen in an unrecoverable state.
        Screen.autorotateToLandscapeLeft      = true;
        Screen.autorotateToLandscapeRight     = true;
        Screen.autorotateToPortrait           = false;
        Screen.autorotateToPortraitUpsideDown = false;
#if UNITY_IOS && !UNITY_EDITOR
        PludoOrientation_ForceLandscape();
#endif
        Screen.orientation = ScreenOrientation.LandscapeLeft;
        _orientationLocked = true;
        ApplyCanvasReference(landscape: true);
        return Task.CompletedTask;
    }

    // Called when returning to the lobby. Locks to portrait (tab screens are
    // portrait-only). Was previously AutoRotation, which let phones flop to
    // landscape on the home tabs — undesired per design.
    //
    // Deferred by two frames so a stale exit (e.g. React EditorScreen cleanup
    // firing during a transient unmount, LaunchAsync.finally taking the
    // !launched path while a newer launch is queued, GamePreviewScreen unmount
    // racing a tile tap) gets cancelled when the next EnterGameOrientationAsync
    // bumps _enterGeneration. Legitimate exits (user truly leaving the editor)
    // pay a ~30 ms portrait-snap delay which is invisible.
    public void ExitGameOrientation()
    {
        int snapshot = _enterGeneration;
        StartCoroutine(DeferredExit(snapshot));
    }

    private IEnumerator DeferredExit(int snapshot)
    {
        // Two frames is enough to absorb both React useEffect cleanup→remount
        // ping-pongs and the await-cycle inside LaunchAsync between Cancel()
        // and the new Enter call.
        yield return null;
        yield return null;
        if (snapshot != _enterGeneration)
        {
            Debug.Log($"[MobileOrientationManager] ExitGameOrientation cancelled — newer Enter arrived (gen {snapshot} → {_enterGeneration})");
            yield break;
        }
        Debug.Log($"[MobileOrientationManager] ExitGameOrientation committing (gen {snapshot}, locked was {_orientationLocked})");
        LockToLobbyOrientation();
        // Tablet lobby is landscape, so the canvas reference must NOT flip back
        // to portrait units here — doing so would relayout every tab screen into
        // a 390-wide space while the screen stays 1366 wide.
        ApplyCanvasReference(landscape: LandscapeEverywhere);
    }

    // Pins the orientation the lobby tabs run in and clears the game-session
    // lock. Used at app boot (Awake) and after every game session ends.
    //
    // Tablet stays landscape here — the tab screens are built for a wide canvas,
    // so "returning to the lobby" is orientation-neutral on iPad. Only the
    // _orientationLocked flag drops, which is what getLandscapeReady reports.
    private void LockToLobbyOrientation()
    {
        _orientationLocked = false;

        if (LandscapeEverywhere)
        {
            Screen.autorotateToLandscapeLeft      = true;
            Screen.autorotateToLandscapeRight     = true;
            Screen.autorotateToPortrait           = false;
            Screen.autorotateToPortraitUpsideDown = false;
#if UNITY_IOS && !UNITY_EDITOR
            PludoOrientation_ForceLandscape();
#endif
            Screen.orientation = ScreenOrientation.LandscapeLeft;
            return;
        }

        Screen.autorotateToPortrait           = true;
        Screen.autorotateToPortraitUpsideDown = false;
        Screen.autorotateToLandscapeLeft      = false;
        Screen.autorotateToLandscapeRight     = false;
        Screen.orientation = ScreenOrientation.Portrait;
    }

    private static void ApplyCanvasReference(bool landscape)
    {
        var scaler = ReactUISetup.MainScaler;
        if (scaler == null) return;
        scaler.referenceResolution = landscape ? new Vector2(844, 390) : new Vector2(390, 844);
        // Phone: unchanged 0.5 blend. Tablet: pin whichever axis the existing
        // (phone-tuned) layout code depends on for "not clipping" — height in
        // portrait (drag sheets), width in landscape (edge-docked editor
        // panels) — and let the other axis float as bonus space. See
        // DeviceIdiom.cs / ReactUISetup.cs for the matching portrait-boot logic.
        scaler.matchWidthOrHeight = DeviceIdiom.IsTablet ? (landscape ? 0f : 1f) : 0.5f;
    }
}
