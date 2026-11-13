using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using ReactUnity;
using ReactUnity.Styling;
using ReactUnity.UGUI;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem.UI;
#endif

public static class ReactUISetup
{
    public static bool IsActive { get; private set; }
    public static CanvasScaler MainScaler;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Boot()
    {
        IsActive = true;
        var setupGO = new GameObject("[ReactUnity]");
        Object.DontDestroyOnLoad(setupGO);
        setupGO.AddComponent<ReactBootstrapper>();
    }
}

internal class ReactBootstrapper : MonoBehaviour
{
    private void Start()
    {
        // Kill the old UI Toolkit document if present
        foreach (var doc in FindObjectsByType<UnityEngine.UIElements.UIDocument>())
            doc.gameObject.SetActive(false);

        // ── EventSystem ───────────────────────────────────────────────────────
        // Unity's UGUI needs exactly one EventSystem. With New Input System
        // (activeInputHandler = 1) we must use InputSystemUIInputModule, not
        // StandaloneInputModule, or clicks will never fire.
        var existingES = FindAnyObjectByType<EventSystem>();
        if (existingES == null)
        {
            var esGO = new GameObject("EventSystem");
            esGO.AddComponent<EventSystem>();
#if ENABLE_INPUT_SYSTEM
            esGO.AddComponent<InputSystemUIInputModule>();
#else
            esGO.AddComponent<StandaloneInputModule>();
#endif
        }
        else
        {
#if ENABLE_INPUT_SYSTEM
            // Swap out any old StandaloneInputModule
            var old = existingES.GetComponent<StandaloneInputModule>();
            if (old != null)
            {
                Destroy(old);
                existingES.gameObject.AddComponent<InputSystemUIInputModule>();
            }
#endif
        }

        // ── Canvas ────────────────────────────────────────────────────────────
        // Create the canvas GO INACTIVE so the ReactRendererUGUI component's
        // OnEnable (which auto-renders and snapshots IconSets/DefaultIconSet
        // into the UGUIContext) doesn't fire until after we've populated those
        // fields. Otherwise the snapshot is empty and every <icon> element
        // falls back to LiberationSans with no glyph.
        var canvasGO = new GameObject("ReactCanvas");
        canvasGO.SetActive(false);

        var canvas = canvasGO.AddComponent<Canvas>();
        canvas.renderMode   = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 10;

        var scaler = canvasGO.AddComponent<CanvasScaler>();
        scaler.uiScaleMode         = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.screenMatchMode     = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        // Boot orientation is idiom-dependent: phones land on the portrait
        // lobby, tablets are landscape on every surface (MobileOrientationManager
        // .LandscapeEverywhere). Keep these in lockstep with ApplyCanvasReference
        // there — it swaps the same two fields on every orientation change, and a
        // mismatch means the first painted frame lays out in the wrong space.
        bool landscape = DeviceIdiom.IsTablet;
        scaler.referenceResolution = landscape ? new Vector2(844, 390) : new Vector2(390, 844);
        // Tablet pins the axis the phone-tuned layout code depends on for "not
        // clipping" — width in landscape (edge-docked panels), height in
        // portrait (drag sheets) — and lets the other float as bonus space.
        // Phone keeps the original 0.5 blend untouched.
        scaler.matchWidthOrHeight  = DeviceIdiom.IsTablet ? (landscape ? 0f : 1f) : 0.5f;
        ReactUISetup.MainScaler    = scaler;

        canvasGO.AddComponent<GraphicRaycaster>();
        var renderer = canvasGO.AddComponent<ReactRendererUGUI>();

        var outlined = Resources.Load<IconSet>("Icons/MaterialRounded");
        var filled   = Resources.Load<IconSet>("Icons/MaterialRoundedFilled");
        if (outlined != null && filled != null)
        {
            renderer.DefaultIconSet = outlined;
            renderer.IconSets = new List<IconSet> { outlined, filled };
        }
        else
        {
            Debug.LogWarning("[ReactUISetup] Material Symbols IconSets missing under Resources/Icons — nav icons will not render.");
        }

        canvasGO.SetActive(true);
    }
}
