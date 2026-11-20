using UnityEngine;
using UnityEngine.UIElements;

// Top-level controller — owns the UIDocument, manages tab switching, and
// creates all screen controllers.  Attach to the UIManager GameObject.
[RequireComponent(typeof(UIDocument))]
public class MainAppController : MonoBehaviour
{
    [Header("Screen Assets")]
    [SerializeField] private VisualTreeAsset discoverScreenAsset;
    [SerializeField] private VisualTreeAsset gamesScreenAsset;
    [SerializeField] private VisualTreeAsset avatarScreenAsset;
    [SerializeField] private VisualTreeAsset chatScreenAsset;
    [SerializeField] private VisualTreeAsset createScreenAsset;
    [SerializeField] private VisualTreeAsset marketScreenAsset;
    [SerializeField] private VisualTreeAsset forgeScreenAsset;

    // Screen controllers (MonoBehaviours on child GameObjects)
    [Header("Screen Controllers")]
    [SerializeField] private DiscoverScreenController   discoverCtrl;
    [SerializeField] private GamesScreenController      gamesCtrl;
    [SerializeField] private AvatarScreenController     avatarCtrl;
    [SerializeField] private ChatScreenController       chatCtrl;
    [SerializeField] private CreateScreenController     createCtrl;
    [SerializeField] private MarketScreenController     marketCtrl;
    [SerializeField] private ForgeScreenController      forgeCtrl;
    [SerializeField] private AvatarPreviewController    avatarPreviewCtrl;

    private UIDocument _doc;

    // Tab buttons
    private Button _tabDiscover, _tabGames, _tabAvatar, _tabChat, _tabCreate;

    // Screen root elements (cloned from assets)
    private VisualElement _screenDiscover, _screenGames, _screenAvatar;
    private VisualElement _screenChat,     _screenCreate;

    private int _activeTab = 0;

    // Public so GameBridge / other scripts can deep-link
    public void NavigateToTab(int tab)     => SwitchTab(tab);
    public void NavigateToMarket()         => marketCtrl?.OpenMarket();
    public void NavigateToForge()          => forgeCtrl?.OpenForge();

    private void Awake()
    {
        _doc = GetComponent<UIDocument>();
        // ReactUnity owns the UI — disable this controller so they don't conflict.
        if (ReactUISetup.IsActive) { enabled = false; return; }
    }

    private void Start() => InitializeUI();

    // OnEnable re-runs after domain reload (Start is skipped on hot-reload).
    // The guard on container.childCount prevents double-init on first Start.
    private void OnEnable()
    {
        if (_doc == null) return;
        var container = _doc.rootVisualElement?.Q<VisualElement>("screen-container");
        if (container != null && container.childCount == 0)
            InitializeUI();
    }

    private void InitializeUI()
    {
        if (_doc == null) return;
        var root      = _doc.rootVisualElement;
        var container = root.Q<VisualElement>("screen-container");
        if (root == null || container == null) return;

        ApplyPlatformFont(root);

        // Clear any stale children from a previous init cycle
        container.Clear();

        // Clone and mount each screen
        _screenDiscover = Clone(discoverScreenAsset, container);
        _screenGames    = Clone(gamesScreenAsset,    container);
        _screenAvatar   = Clone(avatarScreenAsset,   container);
        _screenChat     = Clone(chatScreenAsset,     container);
        _screenCreate   = Clone(createScreenAsset,   container);

        // Give each controller its root element
        discoverCtrl?.Setup(_screenDiscover, this);
        gamesCtrl?.Setup(_screenGames, this);
        avatarCtrl?.Setup(_screenAvatar, this, avatarPreviewCtrl);
        chatCtrl?.Setup(_screenChat);
        createCtrl?.Setup(_screenCreate, this);
        marketCtrl?.Setup(marketScreenAsset, container, this);
        forgeCtrl?.Setup(forgeScreenAsset, container, this);

        // Bottom nav — re-query each time because UXML tree is rebuilt after domain reload
        _tabDiscover = root.Q<Button>("tab-discover");
        _tabGames    = root.Q<Button>("tab-games");
        _tabAvatar   = root.Q<Button>("tab-avatar");
        _tabChat     = root.Q<Button>("tab-chat");
        _tabCreate   = root.Q<Button>("tab-create");

        _tabDiscover.clicked += () => SwitchTab(0);
        _tabGames.clicked    += () => SwitchTab(1);
        _tabAvatar.clicked   += () => SwitchTab(2);
        _tabChat.clicked     += () => SwitchTab(3);
        _tabCreate.clicked   += () => SwitchTab(4);

        SwitchTab(_activeTab);
    }

    private void SwitchTab(int tab)
    {
        _activeTab = tab;

        _screenDiscover?.SetDisplayed(tab == 0);
        _screenGames?.SetDisplayed(tab == 1);
        _screenAvatar?.SetDisplayed(tab == 2);
        _screenChat?.SetDisplayed(tab == 3);
        _screenCreate?.SetDisplayed(tab == 4);

        SetTabActive(_tabDiscover, tab == 0);
        SetTabActive(_tabGames,    tab == 1);
        SetTabActive(_tabAvatar,   tab == 2);
        SetTabActive(_tabChat,     tab == 3);
        SetTabActive(_tabCreate,   tab == 4);

        // Notify controllers on show
        if (tab == 0) discoverCtrl?.OnShow();
        if (tab == 1) gamesCtrl?.OnShow();
        if (tab == 2) avatarCtrl?.OnShow();
        if (tab == 3) chatCtrl?.OnShow();
        if (tab == 4) createCtrl?.OnShow();
    }

    private static void SetTabActive(Button btn, bool active)
    {
        if (btn == null) return;
        btn.EnableInClassList("tab-active", active);
    }

    private static VisualElement Clone(VisualTreeAsset asset, VisualElement parent)
    {
        if (asset == null) return null;
        var ve = asset.CloneTree();
        ve.style.display  = DisplayStyle.None;
        ve.style.flexGrow = 1;
        parent?.Add(ve);
        return ve;
    }

    // On a real iOS device ".AppleSystemUIFont" resolves to San Francisco.
    // No injection happens in the Editor — avoids font-lookup warnings.
    private static void ApplyPlatformFont(VisualElement root)
    {
#if UNITY_IOS && !UNITY_EDITOR
        TryApplyOSFont(root, ".AppleSystemUIFont");
#endif
    }

    private static void TryApplyOSFont(VisualElement root, string fontName)
    {
        var font = Font.CreateDynamicFontFromOSFont(fontName, 16);
        if (font == null) return;
        root.style.unityFontDefinition =
            new StyleFontDefinition(FontDefinition.FromFont(font));
    }
}

// Extension so callers can write element.SetDisplayed(bool)
public static class VisualElementExtensions
{
    public static void SetDisplayed(this VisualElement ve, bool visible)
    {
        if (ve != null)
            ve.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
    }
}
