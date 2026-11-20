using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using System.Collections;
using System;
using UnityEngine.UIElements;

// Mirrors the marketplace.tsx from gameforgeai.
// All equip state flows through AvatarStateManager.
public class MarketScreenController : MonoBehaviour
{
    // Slot-based categories matching the 11 canonical avatar slots
    private static readonly string[] Categories =
        { "All", "Head", "Face", "Hair", "Neck", "Front", "Back", "Waist", "Tops", "Bottoms", "Shoes" };

    private static readonly string[] Rarities =
        { "All", "Common", "Uncommon", "Rare", "Epic", "Legendary" };

    private VisualElement     _root;
    private MainAppController _app;
    private VisualElement     _container;
    private VisualTreeAsset   _asset;

    private VisualElement _marketRoot;
    private VisualElement _listView, _detailView;
    private TextField     _searchField;
    private Button        _searchClear;
    private VisualElement _categoryInner, _rarityInner;
    private VisualElement _itemsLoading, _itemsEmpty, _itemsScroll;
    private VisualElement _itemsGrid;

    // Detail panel
    private Label         _detailTitle, _detailCat, _detailDesc, _detailCreator, _detailPrice;
    private Label         _detailRarityText;
    private VisualElement _detailRarityBadge, _detailTagsWrap;
    private VisualElement _detailImg;
    private Button        _detailBack;
    private Button        _btnEquip;
    private Label         _btnEquipLabel;

    private List<AvatarItemData> _allItems = new();
    private AvatarItemData       _selectedItem;
    private string _query           = "";
    private string _activeCategory  = "All";
    private string _activeRarity    = "All";

    private readonly Dictionary<string, Texture2D> _texCache = new();

    public void Setup(VisualTreeAsset asset, VisualElement container, MainAppController app)
    {
        _asset     = asset;
        _container = container;
        _app       = app;
    }

    public void OpenMarket()
    {
        if (_marketRoot == null)
        {
            _marketRoot = _asset.CloneTree();
            _marketRoot.style.display  = DisplayStyle.Flex;
            _marketRoot.style.flexGrow = 1;
            _marketRoot.style.position = Position.Absolute;
            _marketRoot.style.left  = 0; _marketRoot.style.right  = 0;
            _marketRoot.style.top   = 0; _marketRoot.style.bottom = 0;
            _container.Add(_marketRoot);
            BindUI();
        }
        _marketRoot.SetDisplayed(true);
        LoadData();

        // Subscribe to state changes so equip button updates in real time
        if (AvatarStateManager.Instance != null)
            AvatarStateManager.Instance.OnAvatarChanged += OnAvatarChanged;
    }

    public void CloseMarket()
    {
        _marketRoot?.SetDisplayed(false);
        if (AvatarStateManager.Instance != null)
            AvatarStateManager.Instance.OnAvatarChanged -= OnAvatarChanged;
    }

    // ── Binding ───────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _listView   = _marketRoot.Q("market-list-view");
        _detailView = _marketRoot.Q("detail-view");

        _searchField   = _marketRoot.Q<TextField>("search-field");
        _searchClear   = _marketRoot.Q<Button>("search-clear");
        _categoryInner = _marketRoot.Q("category-inner");
        _rarityInner   = _marketRoot.Q("rarity-inner");
        _itemsLoading  = _marketRoot.Q("items-loading");
        _itemsEmpty    = _marketRoot.Q("items-empty");
        _itemsScroll   = _marketRoot.Q("items-scroll");
        _itemsGrid     = _marketRoot.Q("items-grid");

        _detailBack      = _marketRoot.Q<Button>("detail-back");
        _detailTitle     = _marketRoot.Q<Label>("detail-title");
        _detailCat       = _marketRoot.Q<Label>("detail-category");
        _detailDesc      = _marketRoot.Q<Label>("detail-desc");
        _detailCreator   = _marketRoot.Q<Label>("detail-creator");
        _detailPrice     = _marketRoot.Q<Label>("detail-price");
        _detailRarityText  = _marketRoot.Q<Label>("detail-rarity-text");
        _detailRarityBadge = _marketRoot.Q("detail-rarity-badge");
        _detailTagsWrap    = _marketRoot.Q("detail-tags-wrap");
        _detailImg         = _marketRoot.Q("detail-img");
        _btnEquip          = _marketRoot.Q<Button>("btn-equip");
        _btnEquipLabel     = _marketRoot.Q<Label>("btn-equip-label");

        _marketRoot.Q<Button>("btn-close-market")
            ?.RegisterCallback<ClickEvent>(_ => CloseMarket());

        _searchField?.RegisterValueChangedCallback(e =>
        {
            _query = e.newValue ?? "";
            _searchClear?.SetDisplayed(!string.IsNullOrEmpty(_query));
            ApplyFilter();
        });

        _searchClear?.RegisterCallback<ClickEvent>(_ =>
        {
            if (_searchField != null) _searchField.value = "";
        });

        _detailBack?.RegisterCallback<ClickEvent>(_ => ShowDetail(false));

        _btnEquip?.RegisterCallback<ClickEvent>(_ => ToggleEquipSelected());

        BuildFilterPills(_categoryInner, Categories, true);
        BuildFilterPills(_rarityInner,   Rarities,   false);
    }

    private void BuildFilterPills(VisualElement inner, string[] options, bool isCategory)
    {
        if (inner == null) return;
        inner.Clear();
        var currentActive = isCategory ? _activeCategory : _activeRarity;
        foreach (var opt in options)
        {
            var pill = new Button();
            pill.AddToClassList("filter-pill");
            if (opt == currentActive) pill.AddToClassList("active");
            var lbl = new Label(opt);
            lbl.AddToClassList("filter-pill-text");
            pill.Add(lbl);
            var o = opt;
            pill.clicked += () =>
            {
                if (isCategory) _activeCategory = o;
                else            _activeRarity   = o;
                BuildFilterPills(_categoryInner, Categories, true);
                BuildFilterPills(_rarityInner,   Rarities,   false);
                ApplyFilter();
            };
            inner.Add(pill);
        }
    }

    // ── Data loading ──────────────────────────────────────────────────────────

    private void LoadData()
    {
        SetState("loading");
        StartCoroutine(PludoApiClient.ListAvatarItems(50, null,
            result =>
            {
                _allItems = result?.items ?? new List<AvatarItemData>();
                // Sync into avatar state manager so thumbnails/modelUrls propagate
                AvatarStateManager.Instance?.SetItems(_allItems);
                ApplyFilter();
            },
            _ => SetState("empty")));
    }

    // ── Filtering + rendering ─────────────────────────────────────────────────

    private void ApplyFilter()
    {
        if (_itemsGrid == null) return;
        _itemsGrid.Clear();

        var filtered = _allItems.FindAll(i =>
        {
            bool catMatch    = _activeCategory == "All" || (i.category?.Equals(_activeCategory, StringComparison.OrdinalIgnoreCase) ?? false);
            bool rarityMatch = _activeRarity   == "All" || (i.rarity?.Equals(_activeRarity,   StringComparison.OrdinalIgnoreCase) ?? false);
            bool queryMatch  = string.IsNullOrWhiteSpace(_query)          ||
                               (i.name?.ToLower().Contains(_query.ToLower()) ?? false) ||
                               (i.category?.ToLower().Contains(_query.ToLower()) ?? false);
            return catMatch && rarityMatch && queryMatch;
        });

        if (filtered.Count == 0) { SetState("empty"); return; }
        SetState("list");
        foreach (var item in filtered)
            _itemsGrid.Add(BuildItemCard(item));
    }

    private VisualElement BuildItemCard(AvatarItemData item)
    {
        bool equipped = AvatarStateManager.Instance?.IsEquipped(item.id) ?? false;

        var card = new VisualElement();
        card.AddToClassList("item-card");
        if (equipped) card.AddToClassList("equipped");

        var thumb = new VisualElement();
        thumb.AddToClassList("item-thumb");

        if (!string.IsNullOrEmpty(item.thumbnailUrl))
            StartCoroutine(LoadThumb(item.thumbnailUrl, thumb));

        var dot = new VisualElement();
        dot.AddToClassList("rarity-dot");
        dot.AddToClassList("dot-" + (item.rarity?.ToLower() ?? "common"));
        thumb.Add(dot);

        if (equipped)
        {
            var badge = new VisualElement();
            badge.AddToClassList("check-badge");
            var checkIcon = new Label("&#x2714;");
            checkIcon.AddToClassList("check-badge-icon");
            badge.Add(checkIcon);
            thumb.Add(badge);
        }

        card.Add(thumb);

        var info   = new VisualElement(); info.AddToClassList("item-info");
        var name   = new Label(item.name ?? "");     name.AddToClassList("item-name");
        var cat    = new Label(item.category ?? "");  cat.AddToClassList("item-category");
        var bot    = new VisualElement();             bot.AddToClassList("item-bottom-row");
        var rarity = new Label(item.rarity ?? "");
        rarity.AddToClassList("item-rarity");
        rarity.AddToClassList("rarity-" + (item.rarity?.ToLower() ?? "common"));
        var price  = new Label(item.price > 0 ? $"{item.price} coins" : "Free");
        price.AddToClassList("item-price");
        bot.Add(rarity); bot.Add(price);
        info.Add(name); info.Add(cat); info.Add(bot);
        card.Add(info);

        var captured = item;
        card.RegisterCallback<ClickEvent>(_ => ShowDetailView(captured));
        return card;
    }

    // ── Detail view ───────────────────────────────────────────────────────────

    private void ShowDetailView(AvatarItemData item)
    {
        _selectedItem = item;

        if (_detailTitle      != null) _detailTitle.text    = item.name ?? "";
        if (_detailCat        != null) _detailCat.text      = item.category ?? "";
        if (_detailDesc       != null) _detailDesc.text     = item.description ?? "";
        if (_detailCreator    != null) _detailCreator.text  = item.creatorName ?? "";
        if (_detailPrice      != null) _detailPrice.text    = item.price > 0 ? $"{item.price} coins" : "Free";
        if (_detailRarityText != null) _detailRarityText.text = item.rarity ?? "";

        if (_detailRarityBadge != null)
        {
            _detailRarityBadge.ClearClassList();
            _detailRarityBadge.AddToClassList("rarity-badge");
            _detailRarityBadge.AddToClassList("rarity-" + (item.rarity?.ToLower() ?? "common"));
        }

        if (_detailImg != null && !string.IsNullOrEmpty(item.thumbnailUrl))
            StartCoroutine(LoadThumb(item.thumbnailUrl, _detailImg));

        if (_detailTagsWrap != null)
        {
            _detailTagsWrap.Clear();
            foreach (var tag in item.tags ?? new List<string>())
            {
                var t = new VisualElement();
                t.AddToClassList("tag-chip");
                var tl = new Label(tag);
                tl.AddToClassList("tag-chip-text");
                t.Add(tl);
                _detailTagsWrap.Add(t);
            }
        }

        UpdateEquipButton();
        ShowDetail(true);
    }

    private void ToggleEquipSelected()
    {
        if (_selectedItem == null) return;
        var mgr = AvatarStateManager.Instance;
        if (mgr == null) return;

        if (mgr.IsEquipped(_selectedItem.id))
        {
            mgr.UnequipItem(_selectedItem.category, _selectedItem.id);
        }
        else
        {
            mgr.EquipItem(new EquippedItemData
            {
                id            = _selectedItem.id,
                name          = _selectedItem.name,
                category      = _selectedItem.category,
                rarity        = _selectedItem.rarity,
                cssStyles     = _selectedItem.cssStyles,
                imageData     = _selectedItem.imageData,
                thumbnailUrl  = _selectedItem.thumbnailUrl,
                modelUrl      = _selectedItem.modelUrl,
                dimensionality = _selectedItem.dimensionality,
                imageKind     = _selectedItem.imageKind,
                adjustments   = _selectedItem.adjustments,
            });
        }
        UpdateEquipButton();
        // Refresh list so card equipped badges update
        ApplyFilter();
    }

    private void UpdateEquipButton()
    {
        if (_btnEquipLabel == null || _selectedItem == null) return;
        bool equipped = AvatarStateManager.Instance?.IsEquipped(_selectedItem.id) ?? false;
        _btnEquipLabel.text = equipped ? "Unequip Item" : "Equip Item";
        _btnEquip?.EnableInClassList("disabled", false);
    }

    private void OnAvatarChanged(AvatarConfig _)
    {
        UpdateEquipButton();
        ApplyFilter(); // refresh equipped badges in grid
    }

    private void ShowDetail(bool show)
    {
        _listView?.SetDisplayed(!show);
        _detailView?.SetDisplayed(show);
    }

    // ── Thumbnail loading ─────────────────────────────────────────────────────

    private IEnumerator LoadThumb(string url, VisualElement target)
    {
        if (_texCache.TryGetValue(url, out var cached))
        {
            ApplyTex(cached, target);
            yield break;
        }
        using var req = UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success)
        {
            var tex = DownloadHandlerTexture.GetContent(req);
            _texCache[url] = tex;
            ApplyTex(tex, target);
        }
    }

    private static void ApplyTex(Texture2D tex, VisualElement el)
    {
        if (tex == null || el == null) return;
        el.style.backgroundImage = new StyleBackground(tex);
        el.style.backgroundSize  = new StyleBackgroundSize(new BackgroundSize(BackgroundSizeType.Cover));
    }

    // ── State ─────────────────────────────────────────────────────────────────

    private void SetState(string state)
    {
        _itemsLoading?.SetDisplayed(state == "loading");
        _itemsEmpty?.SetDisplayed(state   == "empty");
        _itemsScroll?.SetDisplayed(state  == "list");
    }
}
