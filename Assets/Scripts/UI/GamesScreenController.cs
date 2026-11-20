using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UIElements;

// Drives the Explore tab: browse mode shows trending games; search mode runs
// parallel queries for users, avatar items, and games, displaying each in its
// own section. A 400ms debounce prevents a request on every keystroke.
public class GamesScreenController : MonoBehaviour
{
    private VisualElement    _root;
    private MainAppController _app;

    // Search bar
    private TextField     _searchField;
    private Button        _searchClear;

    // Browse view
    private VisualElement _browseView;
    private VisualElement _gamesLoading, _gamesEmpty, _gamesScroll;
    private VisualElement _gamesList;

    // Search view
    private VisualElement _searchView;
    private VisualElement _searchLoading, _noResults, _searchScroll;
    private VisualElement _peopleSection, _peopleList;
    private VisualElement _itemsSection,  _itemsList;
    private VisualElement _gamesSection,  _searchGamesList;

    // Game bottom sheet
    private VisualElement _sheetLayer, _sheetBackdrop, _bottomSheet;
    private VisualElement _sheetThumb;
    private Label         _sheetThumbIcon;
    private Button        _sheetClose, _sheetPlay;
    private Label         _sheetTitle, _sheetLikes, _sheetPlays, _sheetCreator, _sheetDesc;
    private Label         _sheetCreatorInit;
    private VisualElement _sheetCreatorAvatar;
    private VisualElement _sheetScriptsPanel, _sheetScriptsScroll;
    private Button        _sheetScriptsToggle;
    private Label         _sheetScriptsToggleLabel, _sheetScriptsText;
    private bool          _scriptsExpanded;
    private GameData      _activeGame;
    private Coroutine     _thumbCoroutine;
    private static readonly Dictionary<string, Texture2D> _thumbCache = new();

    // State
    private List<GameData>   _allGames  = new();
    private bool             _dataLoaded;
    private string           _query     = "";
    private float            _debounce  = 0f;
    private const float      DebounceDelay = 0.4f;
    private Coroutine        _searchCoroutine;

    // ── Setup ─────────────────────────────────────────────────────────────────

    public void Setup(VisualElement root, MainAppController app)
    {
        _root = root;
        _app  = app;
        BindUI();
    }

    public void OnShow()
    {
        if (!_dataLoaded) LoadBrowseData();
    }

    // ── Debounce tick ─────────────────────────────────────────────────────────

    private void Update()
    {
        if (_debounce <= 0f) return;
        _debounce -= Time.unscaledDeltaTime;
        if (_debounce <= 0f)
        {
            _debounce = 0f;
            RunSearch(_query);
        }
    }

    // ── UI binding ────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _searchField  = _root.Q<TextField>("search-field");
        _searchClear  = _root.Q<Button>("search-clear");

        _browseView   = _root.Q("browse-view");
        _gamesLoading = _root.Q("games-loading");
        _gamesEmpty   = _root.Q("games-empty");
        _gamesScroll  = _root.Q("games-scroll");
        _gamesList    = _root.Q("games-list");

        _searchView    = _root.Q("search-view");
        _searchLoading = _root.Q("search-loading");
        _noResults     = _root.Q("no-results");
        _searchScroll  = _root.Q("search-scroll");
        _peopleSection = _root.Q("people-section");
        _peopleList    = _root.Q("people-list");
        _itemsSection  = _root.Q("items-section");
        _itemsList     = _root.Q("items-list");
        _gamesSection  = _root.Q("search-games-section");
        _searchGamesList = _root.Q("search-games-list");

        _sheetLayer         = _root.Q("bottom-sheet-layer");
        _sheetBackdrop      = _root.Q("sheet-backdrop");
        _bottomSheet        = _root.Q("bottom-sheet");
        _sheetThumb         = _root.Q("sheet-thumb");
        _sheetThumbIcon     = _root.Q<Label>("sheet-thumb-icon");
        _sheetClose         = _root.Q<Button>("sheet-close");
        _sheetPlay          = _root.Q<Button>("sheet-play-btn");
        _sheetTitle         = _root.Q<Label>("sheet-title");
        _sheetLikes         = _root.Q<Label>("sheet-likes");
        _sheetPlays         = _root.Q<Label>("sheet-plays");
        _sheetCreator       = _root.Q<Label>("sheet-creator");
        _sheetDesc          = _root.Q<Label>("sheet-desc");
        _sheetCreatorInit   = _root.Q<Label>("sheet-creator-init");
        _sheetCreatorAvatar = _root.Q("sheet-creator-avatar");
        _sheetScriptsPanel  = _root.Q("sheet-scripts-panel");
        _sheetScriptsToggle = _root.Q<Button>("sheet-scripts-toggle");
        _sheetScriptsToggleLabel = _root.Q<Label>("sheet-scripts-toggle-label");
        _sheetScriptsScroll = _root.Q("sheet-scripts-scroll");
        _sheetScriptsText   = _root.Q<Label>("sheet-scripts-text");

        _searchField?.RegisterValueChangedCallback(e =>
        {
            _query = e.newValue ?? "";
            _searchClear?.SetDisplayed(!string.IsNullOrEmpty(_query));

            if (string.IsNullOrWhiteSpace(_query))
            {
                // Immediately return to browse mode; cancel any pending search
                _debounce = 0f;
                ShowBrowseMode();
            }
            else
            {
                // Kick off debounce timer
                _debounce = DebounceDelay;
            }
        });

        _searchClear?.RegisterCallback<ClickEvent>(_ =>
        {
            if (_searchField != null) _searchField.value = "";
        });

        _sheetClose?.RegisterCallback<ClickEvent>(_ => HideSheet());
        _sheetBackdrop?.RegisterCallback<ClickEvent>(_ => HideSheet());
        _sheetPlay?.RegisterCallback<ClickEvent>(_ => OnPlayTapped());
        _sheetScriptsToggle?.RegisterCallback<ClickEvent>(_ => ToggleScripts());
    }

    // ── Browse mode (trending games) ──────────────────────────────────────────

    private void LoadBrowseData()
    {
        _dataLoaded = true;
        SetBrowseState("loading");
        Debug.Log($"[GamesScreen] LoadBrowseData fired (BaseUrl={PludoApiClient.BaseUrl})");
        StartCoroutine(PludoApiClient.ListGames(20, null,
            result =>
            {
                _allGames = result?.games ?? new List<GameData>();
                Debug.Log($"[GamesScreen] api success — {_allGames.Count} games");
                RebuildBrowseList();
            },
            err =>
            {
                Debug.LogWarning($"[GamesScreen] api error: {err}");
                _dataLoaded = false;
                SetBrowseState("empty");
            }));
    }

    private void RebuildBrowseList()
    {
        Debug.Log($"[GamesScreen] RebuildBrowseList: _gamesList={(_gamesList==null?"null":"ok")} count={_allGames.Count}");
        if (_gamesList == null) { SetBrowseState("empty"); return; }
        _gamesList.Clear();
        if (_allGames.Count == 0) { SetBrowseState("empty"); return; }
        SetBrowseState("list");
        foreach (var g in _allGames)
            _gamesList.Add(BuildGameCard(g));
    }

    private void SetBrowseState(string state)
    {
        ToggleVisibility(_gamesLoading, state == "loading");
        ToggleVisibility(_gamesEmpty,   state == "empty");
        ToggleVisibility(_gamesScroll,  state == "list");
        Debug.Log($"[GamesScreen] SetBrowseState({state})");
    }

    private static void ToggleVisibility(VisualElement ve, bool visible)
    {
        if (ve == null) return;
        ve.SetDisplayed(visible);
        if (visible) ve.RemoveFromClassList("hidden");
        else if (!ve.ClassListContains("hidden")) ve.AddToClassList("hidden");
    }

    private void ShowBrowseMode()
    {
        _browseView?.SetDisplayed(true);
        _searchView?.SetDisplayed(false);
    }

    private void ShowSearchMode()
    {
        _browseView?.SetDisplayed(false);
        _searchView?.SetDisplayed(true);
    }

    // ── Search mode (users + items + games) ───────────────────────────────────

    private void RunSearch(string q)
    {
        if (_searchCoroutine != null) StopCoroutine(_searchCoroutine);
        _searchCoroutine = StartCoroutine(SearchCoroutine(q));
    }

    private IEnumerator SearchCoroutine(string q)
    {
        ShowSearchMode();
        _searchLoading?.SetDisplayed(true);
        _noResults?.SetDisplayed(false);
        _searchScroll?.SetDisplayed(false);
        _peopleSection?.SetDisplayed(false);
        _itemsSection?.SetDisplayed(false);
        _gamesSection?.SetDisplayed(false);

        // Fire all three requests in parallel using sub-coroutines.
        List<UserRecord>  users = null;
        List<AvatarItemData> items = null;
        List<GameData>    games = null;

        bool usersReady = false, itemsReady = false, gamesReady = false;

        StartCoroutine(PludoApiClient.SearchUsers(q,
            r => { users = r?.users;                                 usersReady = true; },
            _ => { users = new List<UserRecord>();                   usersReady = true; }));

        StartCoroutine(PludoApiClient.ListAvatarItems(50, null,
            r => { items = r?.items;                                 itemsReady = true; },
            _ => { items = new List<AvatarItemData>();               itemsReady = true; }));

        StartCoroutine(PludoApiClient.ListGames(50, null,
            r => { games = r?.games;                                 gamesReady = true; },
            _ => { games = new List<GameData>();                     gamesReady = true; }));

        // Wait for all three
        yield return new WaitUntil(() => usersReady && itemsReady && gamesReady);

        // Client-side filter items and games by query
        var ql = q.ToLower();
        var filteredItems = (items ?? new List<AvatarItemData>()).FindAll(i =>
            (i.name?.ToLower().Contains(ql) ?? false) ||
            (i.category?.ToLower().Contains(ql) ?? false) ||
            (i.description?.ToLower().Contains(ql) ?? false));
        var filteredGames = (games ?? new List<GameData>()).FindAll(g =>
            (g.title?.ToLower().Contains(ql) ?? false) ||
            (g.description?.ToLower().Contains(ql) ?? false) ||
            (g.genre?.ToLower().Contains(ql) ?? false) ||
            (g.creatorName?.ToLower().Contains(ql) ?? false));

        _searchLoading?.SetDisplayed(false);

        bool anyResults = (users?.Count > 0) || (filteredItems.Count > 0) || (filteredGames.Count > 0);

        if (!anyResults)
        {
            _noResults?.SetDisplayed(true);
            yield break;
        }

        _searchScroll?.SetDisplayed(true);

        // People
        if (users != null && users.Count > 0)
        {
            _peopleList?.Clear();
            foreach (var u in users)
                _peopleList?.Add(BuildPersonRow(u));
            _peopleSection?.SetDisplayed(true);
        }

        // Items
        if (filteredItems.Count > 0)
        {
            _itemsList?.Clear();
            foreach (var i in filteredItems)
                _itemsList?.Add(BuildItemRow(i));
            _itemsSection?.SetDisplayed(true);
        }

        // Games
        if (filteredGames.Count > 0)
        {
            _searchGamesList?.Clear();
            foreach (var g in filteredGames)
                _searchGamesList?.Add(BuildSearchGameRow(g));
            _gamesSection?.SetDisplayed(true);
        }
    }

    // ── Card / row builders ───────────────────────────────────────────────────

    private VisualElement BuildPersonRow(UserRecord u)
    {
        var row = new VisualElement();
        row.AddToClassList("explore-person-row");

        var avatar = new VisualElement();
        avatar.AddToClassList("explore-person-avatar");
        if (ColorUtility.TryParseHtmlString(PaletteColor(u.username ?? ""), out var c))
            avatar.style.backgroundColor = c;
        var init = new Label(Initials(u.username));
        init.AddToClassList("explore-person-initials");
        avatar.Add(init);

        var info = new VisualElement();
        info.style.flexGrow = 1;
        var name = new Label(u.username ?? "");
        name.AddToClassList("explore-person-name");
        var handle = new Label($"@{u.handle ?? u.username?.ToLower() ?? ""}");
        handle.AddToClassList("explore-person-handle");
        info.Add(name);
        info.Add(handle);

        row.Add(avatar);
        row.Add(info);
        return row;
    }

    private VisualElement BuildItemRow(AvatarItemData item)
    {
        var row = new VisualElement();
        row.AddToClassList("explore-item-row");

        var thumb = new VisualElement();
        thumb.AddToClassList("explore-item-thumb");
        var icon = new Label("👕");
        icon.AddToClassList("explore-item-icon");
        thumb.Add(icon);

        var info = new VisualElement();
        info.style.flexGrow = 1;
        var name = new Label(item.name ?? "");
        name.AddToClassList("explore-item-name");
        var cat = new Label(item.category ?? "");
        cat.AddToClassList("explore-item-category");
        info.Add(name);
        info.Add(cat);

        row.Add(thumb);
        row.Add(info);
        return row;
    }

    private VisualElement BuildSearchGameRow(GameData g)
    {
        var row = new VisualElement();
        row.AddToClassList("explore-game-row");

        var thumb = new VisualElement();
        thumb.AddToClassList("explore-game-thumb");
        var icon = new Label("🎮");
        icon.AddToClassList("explore-game-icon");
        thumb.Add(icon);

        var info = new VisualElement();
        info.style.flexGrow = 1;
        var title = new Label(g.title ?? "");
        title.AddToClassList("explore-game-title");
        var desc = new Label(g.description ?? "");
        desc.AddToClassList("explore-game-desc");
        var creator = new Label($"by {g.creatorName}");
        creator.AddToClassList("explore-game-creator");
        info.Add(title);
        info.Add(desc);
        info.Add(creator);

        row.Add(thumb);
        row.Add(info);
        row.RegisterCallback<ClickEvent>(_ => ShowSheet(g));
        return row;
    }

    // Browse-mode grid card (2-column)
    private VisualElement BuildGameCard(GameData g)
    {
        var card = new VisualElement();
        card.AddToClassList("game-card");

        var thumb = new VisualElement();
        thumb.AddToClassList("game-card-thumb");
        var icon = new Label("🎮");
        icon.AddToClassList("game-card-thumb-icon");
        thumb.Add(icon);

        var badge = new VisualElement();
        badge.AddToClassList("genre-badge");
        badge.AddToClassList("genre-" + (g.genre?.ToLower() ?? "default"));
        var badgeText = new Label(g.genre ?? "");
        badgeText.AddToClassList("genre-badge-text");
        badge.Add(badgeText);
        thumb.Add(badge);
        card.Add(thumb);

        var info = new VisualElement();
        info.AddToClassList("game-card-info");
        var title = new Label(g.title ?? "");
        title.AddToClassList("game-card-title");
        var desc = new Label(g.description ?? "");
        desc.AddToClassList("game-card-desc");

        var meta = new VisualElement();
        meta.AddToClassList("game-card-meta");
        meta.Add(MakeMeta("♥", g.likes.ToString(), new Color(1f, 0.1f, 0.7f)));
        meta.Add(MakeMeta("▶", g.plays.ToString(), new Color(0f, 0.83f, 1f)));
        var creator = new Label($"by {g.creatorName}");
        creator.AddToClassList("meta-creator");
        meta.Add(creator);

        info.Add(title); info.Add(desc); info.Add(meta);
        card.Add(info);
        card.RegisterCallback<ClickEvent>(_ => ShowSheet(g));
        return card;
    }

    private static VisualElement MakeMeta(string icon, string text, Color color)
    {
        var row = new VisualElement(); row.AddToClassList("meta-item");
        var ico = new Label(icon);    ico.AddToClassList("meta-icon");
        ico.style.color = color;
        var lbl = new Label(text);    lbl.AddToClassList("meta-text");
        row.Add(ico); row.Add(lbl);
        return row;
    }

    // ── Bottom sheet ──────────────────────────────────────────────────────────

    private void ShowSheet(GameData g)
    {
        _activeGame      = g;
        _scriptsExpanded = false;

        if (_sheetTitle  != null) _sheetTitle.text  = g.title ?? "";
        if (_sheetLikes  != null) _sheetLikes.text  = g.likes.ToString();
        if (_sheetPlays  != null) _sheetPlays.text  = g.plays.ToString();
        if (_sheetCreator!= null) _sheetCreator.text= g.creatorName ?? "";
        if (_sheetDesc   != null) _sheetDesc.text   = g.description ?? "";

        ApplySheetThumb(g);

        var name = g.creatorName ?? "?";
        if (_sheetCreatorInit != null) _sheetCreatorInit.text = Initials(name);
        if (_sheetCreatorAvatar != null &&
            ColorUtility.TryParseHtmlString(PaletteColor(name), out var c))
            _sheetCreatorAvatar.style.backgroundColor = c;

        _sheetScriptsPanel?.SetDisplayed(true);
        _sheetScriptsScroll?.AddToClassList("hidden");
        if (_sheetScriptsToggleLabel != null)
            _sheetScriptsToggleLabel.text = "View Luau Scripts";
        if (!string.IsNullOrEmpty(g.gameCode) && _sheetScriptsText != null)
            _sheetScriptsText.text = g.gameCode;

        _sheetLayer?.SetDisplayed(true);
    }

    private void HideSheet()
    {
        _sheetLayer?.SetDisplayed(false);
        _activeGame = null;
        if (_thumbCoroutine != null) { StopCoroutine(_thumbCoroutine); _thumbCoroutine = null; }
    }

    private void ApplySheetThumb(GameData g)
    {
        if (_sheetThumb == null) return;

        if (_thumbCoroutine != null) { StopCoroutine(_thumbCoroutine); _thumbCoroutine = null; }
        _sheetThumb.style.backgroundImage = StyleKeyword.Null;

        // Tint the placeholder background per-game so it isn't a flat black/gray block
        // when no thumbnail is available yet.
        if (ColorUtility.TryParseHtmlString(PaletteColor(g.title ?? g.creatorName ?? ""), out var tint))
            _sheetThumb.style.backgroundColor = new Color(tint.r * 0.45f, tint.g * 0.45f, tint.b * 0.45f, 1f);

        _sheetThumbIcon?.SetDisplayed(true);

        if (string.IsNullOrEmpty(g.thumbnailUrl)) return;

        if (_thumbCache.TryGetValue(g.thumbnailUrl, out var cached) && cached != null)
        {
            ApplyThumbTexture(cached);
            return;
        }

        _thumbCoroutine = StartCoroutine(LoadSheetThumb(g.thumbnailUrl));
    }

    private IEnumerator LoadSheetThumb(string url)
    {
        using var req = UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        _thumbCoroutine = null;
        if (req.result != UnityWebRequest.Result.Success) yield break;
        if (_activeGame == null || _activeGame.thumbnailUrl != url) yield break;

        var tex = DownloadHandlerTexture.GetContent(req);
        _thumbCache[url] = tex;
        ApplyThumbTexture(tex);
    }

    private void ApplyThumbTexture(Texture2D tex)
    {
        if (tex == null || _sheetThumb == null) return;
        _sheetThumb.style.backgroundImage = new StyleBackground(tex);
        _sheetThumb.style.backgroundSize  = new StyleBackgroundSize(new BackgroundSize(BackgroundSizeType.Cover));
        _sheetThumbIcon?.SetDisplayed(false);
    }

    private void OnPlayTapped()
    {
        if (_activeGame == null) return;
        HideSheet();
        var launcher = GameLauncher.Instance;
        if (launcher != null)
            _ = launcher.LaunchAsync(_activeGame);
        else
            Debug.LogWarning("[ExploreScreen] GameLauncher not ready — tap Play again.");
    }

    private void ToggleScripts()
    {
        if (_sheetScriptsScroll == null) return;
        _scriptsExpanded = !_scriptsExpanded;

        if (_scriptsExpanded)
        {
            _sheetScriptsScroll.RemoveFromClassList("hidden");
            if (_sheetScriptsToggleLabel != null)
                _sheetScriptsToggleLabel.text = "Hide Scripts";

            if (_activeGame != null && string.IsNullOrEmpty(_activeGame.gameCode))
            {
                if (_sheetScriptsText != null) _sheetScriptsText.text = "Loading...";
                StartCoroutine(PludoApiClient.GetGame(_activeGame.id,
                    full =>
                    {
                        _activeGame.gameCode = full.gameCode;
                        if (_sheetScriptsText != null)
                            _sheetScriptsText.text = string.IsNullOrEmpty(full.gameCode)
                                ? "(No code available)"
                                : full.gameCode;
                    },
                    err =>
                    {
                        if (_sheetScriptsText != null) _sheetScriptsText.text = $"Error: {err}";
                    }));
            }
        }
        else
        {
            _sheetScriptsScroll.AddToClassList("hidden");
            if (_sheetScriptsToggleLabel != null)
                _sheetScriptsToggleLabel.text = "View Luau Scripts";
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string Initials(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "?";
        var parts = name.Trim().Split(' ');
        return parts.Length >= 2
            ? $"{parts[0][0]}{parts[1][0]}".ToUpper()
            : name[0].ToString().ToUpper();
    }

    private static readonly string[] Palette = { "#aa33ff", "#00d4ff", "#ff1ab3", "#33ff88", "#ff8c00" };
    private static string PaletteColor(string name)
    {
        int h = 0;
        foreach (char c in name ?? "") h = (h * 31 + c) % Palette.Length;
        return Palette[Mathf.Abs(h) % Palette.Length];
    }
}
