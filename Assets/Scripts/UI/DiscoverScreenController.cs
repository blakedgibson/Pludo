using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

public class DiscoverScreenController : MonoBehaviour
{
    private enum FriendStatus { Offline, Online, Playing, Building }

    private VisualElement    _root;
    private MainAppController _app;

    private VisualElement _friendsInner;
    private VisualElement _gamesList;
    private VisualElement _gamesLoading, _gamesError, _gamesEmpty;
    private VisualElement _itemsGrid;
    private VisualElement _itemsLoading, _itemsEmpty;
    private VisualElement _addFriendModal;
    private TextField     _addSearchField;
    private VisualElement _addSearchIdle, _addSearchLoading, _addSearchEmpty, _addSearchResults;
    private VisualElement _addResultsList;

    private float  _searchDebounce;
    private string _pendingQuery;

    private List<GameData>       _games = new();
    private List<AvatarItemData> _items = new();

    private bool _dataLoaded;

    public void Setup(VisualElement root, MainAppController app)
    {
        _root       = root;
        _app        = app;
        _dataLoaded = false;
        BindUI();
    }

    public void OnShow()
    {
        if (!_dataLoaded) LoadData();
        RefreshFriends();
    }

    private void BindUI()
    {
        _friendsInner     = _root.Q("friends-inner");
        _gamesList        = _root.Q("games-list");
        _gamesLoading     = _root.Q("games-loading");
        _gamesError       = _root.Q("games-error");
        _gamesEmpty       = _root.Q("games-empty");
        _itemsGrid        = _root.Q("items-grid");
        _itemsLoading     = _root.Q("items-loading");
        _itemsEmpty       = _root.Q("items-empty");
        _addFriendModal   = _root.Q("add-friend-modal");
        _addSearchField   = _root.Q<TextField>("add-search-field");
        _addSearchIdle    = _root.Q("add-search-idle");
        _addSearchLoading = _root.Q("add-search-loading");
        _addSearchEmpty   = _root.Q("add-search-empty");
        _addSearchResults = _root.Q("add-search-results");
        _addResultsList   = _root.Q("add-results-list");

        _root.Q<Button>("games-see-all")?.RegisterCallback<ClickEvent>(_ =>
            _app?.NavigateToTab(1));

        _root.Q<Button>("items-see-all")?.RegisterCallback<ClickEvent>(_ =>
            _app?.NavigateToTab(2));

        _root.Q<Button>("games-retry")?.RegisterCallback<ClickEvent>(_ => LoadData());

        _root.Q("modal-backdrop-dismiss")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(false));

        _root.Q<Button>("modal-cancel")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(false));

        _addSearchField?.RegisterValueChangedCallback(e =>
        {
            _pendingQuery   = e.newValue?.Trim() ?? "";
            _searchDebounce = 0.4f;
            SetSearchState("loading");
        });
    }

    private void Update()
    {
        if (_searchDebounce <= 0f) return;
        _searchDebounce -= Time.unscaledDeltaTime;
        if (_searchDebounce > 0f) return;
        _searchDebounce = 0f;

        var q = _pendingQuery ?? "";
        if (string.IsNullOrWhiteSpace(q)) { SetSearchState("idle"); return; }
        StartCoroutine(RunUserSearch(q));
    }

    private IEnumerator RunUserSearch(string query)
    {
        SetSearchState("loading");
        UserSearchResponse result = null;
        string err = null;
        yield return StartCoroutine(PludoApiClient.SearchUsers(query, r => result = r, e => err = e));

        var users = result?.users;
        if (users == null || users.Count == 0)
        {
            SetSearchState("empty");
            yield break;
        }

        _addResultsList?.Clear();
        foreach (var u in users)
            _addResultsList?.Add(BuildUserResultRow(u));
        SetSearchState("results");
    }

    private VisualElement BuildUserResultRow(UserRecord user)
    {
        var row = new VisualElement();
        row.AddToClassList("add-result-row");

        var circle = new VisualElement();
        circle.AddToClassList("friend-circle");
        if (ColorUtility.TryParseHtmlString(FriendsManager.AvatarColor(user.username), out var col))
            circle.style.backgroundColor = col;
        var init = new Label(FriendsManager.Initials(user.username));
        init.AddToClassList("friend-initials");
        circle.Add(init);

        var info = new VisualElement();
        info.AddToClassList("add-result-info");
        var name = new Label(user.username ?? "");
        name.AddToClassList("add-result-name");
        var handle = new Label(string.IsNullOrEmpty(user.handle) ? "" : $"@{user.handle}");
        handle.AddToClassList("add-result-handle");
        info.Add(name); info.Add(handle);

        bool alreadyAdded = FriendsManager.Instance?.IsFriend(user.id) ?? false;
        var btn = new Button();
        btn.AddToClassList("add-result-btn");
        if (alreadyAdded) btn.AddToClassList("added");
        var btnText = new Label(alreadyAdded ? "Added" : "Add");
        btnText.AddToClassList("add-result-btn-text");
        btn.Add(btnText);

        if (!alreadyAdded)
        {
            var captured = user;
            btn.clicked += () =>
            {
                FriendsManager.Instance?.AddFriend(captured);
                btnText.text = "Added";
                btn.AddToClassList("added");
                RefreshFriends();
            };
        }

        row.Add(circle); row.Add(info); row.Add(btn);
        return row;
    }

    private void SetSearchState(string state)
    {
        _addSearchIdle?.SetDisplayed(state == "idle");
        _addSearchLoading?.SetDisplayed(state == "loading");
        _addSearchEmpty?.SetDisplayed(state == "empty");
        _addSearchResults?.SetDisplayed(state == "results");
    }

    // ── Data loading ─────────────────────────────────────────────────────────

    private void LoadData()
    {
        _dataLoaded = true;
        SetGamesState("loading");
        SetItemsState("loading");

        StartCoroutine(PludoApiClient.ListGames(10, null,
            result =>
            {
                _games = result?.games ?? new List<GameData>();
                RenderGames();
            },
            err =>
            {
                Debug.LogWarning($"[Discover] Games error: {err}");
                _games = new List<GameData>();
                RenderGames();
            }));

        StartCoroutine(PludoApiClient.ListAvatarItems(6, null,
            result =>
            {
                _items = result?.items ?? new List<AvatarItemData>();
                RenderItems();
            },
            _ =>
            {
                _items = new List<AvatarItemData>();
                RenderItems();
            }));
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private void RenderGames()
    {
        if (_games.Count == 0) _games = DemoGames();
        SetGamesState("list");
        _gamesList.Clear();
        foreach (var g in _games)
            _gamesList.Add(BuildGameCard(g));
    }

    private void RenderItems()
    {
        if (_items.Count == 0) _items = DemoItems();
        SetItemsState("list");
        _itemsGrid.Clear();
        foreach (var item in _items)
            _itemsGrid.Add(BuildItemCard(item));
    }

    private static List<GameData> DemoGames() => new()
    {
        new GameData { title = "Void Runner",  plays = 12400, creatorName = "pludo",  genre = "Action",    isHot = true  },
        new GameData { title = "Star Forge",   plays = 8100,  creatorName = "pludo",  genre = "Adventure", isHot = false },
        new GameData { title = "Neon Drift",   plays = 5300,  creatorName = "pludo",  genre = "Racing",    isHot = false },
    };

    private static List<AvatarItemData> DemoItems() => new()
    {
        new AvatarItemData { name = "Neon Jacket",  category = "Top",     rarity = "Epic",   price = 200 },
        new AvatarItemData { name = "Holo Visor",   category = "Head",    rarity = "Rare",   price = 150 },
        new AvatarItemData { name = "Spark Boots",  category = "Shoes",   rarity = "Uncommon", price = 80 },
    };

    private VisualElement BuildGameCard(GameData g)
    {
        var card = new VisualElement();
        card.AddToClassList("game-card");

        // Thumbnail
        var thumb = new VisualElement();
        thumb.AddToClassList("game-card-thumb");
        var icon = new Label("🎮");
        icon.AddToClassList("game-card-thumb-icon");
        thumb.Add(icon);
        card.Add(thumb);

        // Info
        var info = new VisualElement();
        info.AddToClassList("game-card-info");

        // Title row with optional "Hot" badge
        var titleRow = new VisualElement();
        titleRow.style.flexDirection = UnityEngine.UIElements.FlexDirection.Row;
        titleRow.style.alignItems    = UnityEngine.UIElements.Align.Center;
        titleRow.style.flexWrap      = UnityEngine.UIElements.Wrap.Wrap;
        var title = new Label(g.title ?? "");
        title.AddToClassList("game-card-title");
        title.style.flexGrow = 1;
        titleRow.Add(title);
        if (g.isHot)
        {
            var hotBadge = new VisualElement();
            hotBadge.AddToClassList("trending-badge");
            var hotText = new Label("Hot");
            hotText.AddToClassList("trending-badge-text");
            hotBadge.Add(hotText);
            titleRow.Add(hotBadge);
        }
        info.Add(titleRow);

        // Play count
        var playsLabel = new Label(FormatCount(g.plays) + " plays");
        playsLabel.AddToClassList("meta-creator");
        info.Add(playsLabel);

        card.Add(info);
        card.RegisterCallback<ClickEvent>(_ => _app?.NavigateToTab(1));
        return card;
    }

    private static string FormatCount(int n)
    {
        if (n >= 1000) return (n / 100 / 10f).ToString("0.#") + "k";
        return n.ToString();
    }

    private VisualElement BuildItemCard(AvatarItemData item)
    {
        var card = new VisualElement();
        card.AddToClassList("item-card");

        var thumb = new VisualElement();
        thumb.AddToClassList("item-thumb");
        var icon = new Label("📦");
        icon.AddToClassList("item-thumb-icon");
        thumb.Add(icon);

        var dot = new VisualElement();
        dot.AddToClassList("rarity-dot");
        dot.AddToClassList("dot-" + (item.rarity?.ToLower() ?? "common"));
        thumb.Add(dot);
        card.Add(thumb);

        var info = new VisualElement();
        info.AddToClassList("item-info");
        var name = new Label(item.name ?? "");
        name.AddToClassList("item-name");
        var cat  = new Label(item.category ?? "");
        cat.AddToClassList("item-category");
        var bot  = new VisualElement();
        bot.AddToClassList("item-bottom-row");
        var rarity = new Label(item.rarity ?? "");
        rarity.AddToClassList("item-rarity");
        rarity.AddToClassList("rarity-" + (item.rarity?.ToLower() ?? "common"));
        var price = new Label(item.price > 0 ? $"{item.price} 🪙" : "Free");
        price.AddToClassList("item-price");
        bot.Add(rarity); bot.Add(price);
        info.Add(name); info.Add(cat); info.Add(bot);
        card.Add(info);

        card.RegisterCallback<ClickEvent>(_ => _app?.NavigateToTab(2));
        return card;
    }

    // ── Friends ───────────────────────────────────────────────────────────────

    private void RefreshFriends()
    {
        if (_friendsInner == null) return;
        _friendsInner.Clear();

        // 1. Player's own bubble — always first, always green (playing)
        _friendsInner.Add(BuildFriendBubble("You", FriendStatus.Playing, isPlayer: true));

        // 2. Add-friend button
        _friendsInner.Add(BuildAddBubble());

        // 3. Friends with simulated statuses
        var friends = FriendsManager.Instance?.Friends;
        if (friends != null)
        {
            for (int i = 0; i < friends.Count; i++)
            {
                var f      = friends[i];
                var status = SimulateStatus(f.name, i);
                _friendsInner.Add(BuildFriendBubble(f.name, status, isPlayer: false));
            }
        }
    }

    private VisualElement BuildFriendBubble(string name, FriendStatus status, bool isPlayer)
    {
        var wrap = new VisualElement();
        wrap.AddToClassList("friend-bubble-wrap");

        // Ring outer (status colour)
        var ring = new VisualElement();
        ring.AddToClassList("friend-ring-outer");
        ring.AddToClassList(status switch
        {
            FriendStatus.Playing  => "ring-playing",
            FriendStatus.Online   => "ring-online",
            FriendStatus.Building => "ring-building",
            _                     => "ring-offline",
        });

        // Black gap between ring and avatar
        var gap = new VisualElement();
        gap.AddToClassList("friend-ring-gap");

        // Avatar circle with initials
        var circle = new VisualElement();
        circle.AddToClassList("friend-circle");
        circle.style.backgroundColor = isPlayer
            ? new Color(58f/255f, 58f/255f, 60f/255f)
            : ParseHex(FriendsManager.AvatarColor(name));

        var init = new Label(isPlayer ? "Y" : FriendsManager.Initials(name));
        init.AddToClassList("friend-initials");
        circle.Add(init);

        gap.Add(circle);
        ring.Add(gap);
        wrap.Add(ring);

        var display = isPlayer ? "You" : name.Split(' ')[0];
        var nameLabel = new Label(display);
        nameLabel.AddToClassList("friend-name-label");
        wrap.Add(nameLabel);

        if (!isPlayer)
            wrap.RegisterCallback<ClickEvent>(_ => _app?.NavigateToTab(3));

        return wrap;
    }

    private VisualElement BuildAddBubble()
    {
        var btn = new Button();
        btn.AddToClassList("friend-bubble-wrap");

        var circle = new VisualElement();
        circle.AddToClassList("add-friend-circle");
        var icon = new Label("+");
        icon.AddToClassList("friend-add-icon");
        circle.Add(icon);

        var lbl = new Label("Add");
        lbl.AddToClassList("friend-name-label");

        btn.Add(circle);
        btn.Add(lbl);
        btn.clicked += () => ShowAddFriendModal(true);
        return btn;
    }

    // Deterministically assigns a status based on name hash so the demo always
    // shows a mix of statuses for any friends list.
    private static FriendStatus SimulateStatus(string name, int index)
    {
        int h = index;
        foreach (char c in name) h = h * 31 + c;
        return (Mathf.Abs(h) % 4) switch
        {
            0 => FriendStatus.Playing,
            1 => FriendStatus.Online,
            2 => FriendStatus.Building,
            _ => FriendStatus.Offline,
        };
    }

    // ── Add Friend modal ───────────────────────────────────────────────────────

    private void ShowAddFriendModal(bool show)
    {
        _addFriendModal?.SetDisplayed(show);
        if (!show)
        {
            if (_addSearchField != null) _addSearchField.value = "";
            _searchDebounce = 0f;
            _pendingQuery   = "";
            _addResultsList?.Clear();
            SetSearchState("idle");
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void SetGamesState(string state)
    {
        _gamesLoading?.SetDisplayed(state == "loading");
        _gamesError?.SetDisplayed(state == "error");
        _gamesEmpty?.SetDisplayed(state == "empty");
        _gamesList?.SetDisplayed(state == "list");
    }

    private void SetItemsState(string state)
    {
        _itemsLoading?.SetDisplayed(state == "loading");
        _itemsEmpty?.SetDisplayed(state == "empty");
        _itemsGrid?.SetDisplayed(state == "list");
    }

    private static VisualElement MakeMetaItem(string icon, string text, string colorHex)
    {
        var row  = new VisualElement(); row.AddToClassList("meta-item");
        var ico  = new Label(icon);    ico.AddToClassList("meta-icon");
        ico.style.color = ParseHex(colorHex);
        var lbl  = new Label(text);    lbl.AddToClassList("meta-text");
        row.Add(ico); row.Add(lbl);
        return row;
    }

    private static Color ParseHex(string hex)
    {
        if (ColorUtility.TryParseHtmlString(hex, out var c)) return c;
        return Color.gray;
    }
}
