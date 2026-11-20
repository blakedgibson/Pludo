using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UIElements;

// Mirrors the avatar.tsx wardrobe page from gameforgeai.
// State is owned by AvatarStateManager (singleton); this class is pure UI.
public class AvatarScreenController : MonoBehaviour
{
    private static readonly string[] Slots =
        { "All", "Head", "Face", "Hair", "Neck", "Front", "Back", "Waist", "Tops", "Bottoms", "Shoes" };

    private VisualElement        _root;
    private MainAppController    _app;
    private AvatarPreviewController _preview;

    // Avatar viewport
    private VisualElement _avatarViewport;
    private Label         _avatarHint;
    private VisualElement _equippedOverlay;
    private VisualElement _equippedChips;

    // Wardrobe panel
    private VisualElement _wardrobePanel;
    private Label         _wardrobeCount;
    private VisualElement _slotsInner;
    private VisualElement _itemsLoading, _itemsEmpty, _itemsScroll;
    private VisualElement _itemsGrid;

    private string               _activeSlot = "All";
    private List<AvatarItemData> _allItems   = new();
    private bool                 _dataLoaded;

    private readonly Dictionary<string, Texture2D> _texCache = new();

    // ── Orbit / pinch input state ─────────────────────────────────────────────
    private int     _dragPointerId = -1;
    private Vector2 _dragLast;
    private int     _pinchPointerId = -1;
    private Vector2 _pinchLast;
    private float   _pinchLastDist;

    // ── Wardrobe bottom-sheet state ───────────────────────────────────────────
    private enum SheetState { Hidden, Peeked, Half, Full }
    private SheetState _sheetState = SheetState.Hidden;

    private VisualElement               _dragHandle;
    private IVisualElementScheduledItem _animSchedule;
    private float _headerHeight  = 68f;   // measured from GeometryChangedEvent
    private float _parentHeight;          // measured from GeometryChangedEvent

    private int   _sheetPointer      = -1;
    private float _sheetDragStartY;
    private float _sheetDragStartTop;

    // Height of visible panel strip in Peeked state (handle + top border only)
    private const float PeekHeight    = 48f;
    private const float AnimDurationS = 0.22f;

    // ── Setup / teardown ──────────────────────────────────────────────────────

    public void Setup(VisualElement root, MainAppController app, AvatarPreviewController preview = null)
    {
        _root    = root;
        _app     = app;
        _preview = preview;

        BindUI();
        BindPreviewTexture();
        BuildSlotPills();

        if (AvatarStateManager.Instance != null)
            AvatarStateManager.Instance.OnAvatarChanged += OnAvatarChanged;
    }

    public void OnShow()
    {
        ResetDragState();
        RefreshPreview();
        BindPreviewTexture();
        _preview?.ResetView();
        _preview?.NotifySheetFraction(0f);

        // Always show the panel peeking from the bottom when the tab opens.
        // If the parent hasn't laid out yet (first open), defer one frame.
        MeasureParent();
        _wardrobePanel?.SetDisplayed(true);
        _root.Q<Button>("btn-customize")?.RemoveFromClassList("customize-active");

        if (_parentHeight > 0)
        {
            _sheetState = SheetState.Peeked;
            if (_wardrobePanel != null)
                _wardrobePanel.style.top = TopForState(SheetState.Peeked);
        }
        else
        {
            _wardrobePanel?.schedule.Execute(() =>
            {
                MeasureParent();
                _sheetState = SheetState.Peeked;
                if (_wardrobePanel != null)
                    _wardrobePanel.style.top = TopForState(SheetState.Peeked);
            }).ExecuteLater(1);
        }
    }

    private void ResetDragState()
    {
        if (_avatarViewport != null)
        {
            for (int id = 0; id <= 20; id++)
                if (_avatarViewport.HasPointerCapture(id))
                    _avatarViewport.ReleasePointer(id);
        }
        _dragPointerId  = -1;
        _pinchPointerId = -1;
        _pinchLastDist  = 0f;

        if (_dragHandle != null && _sheetPointer >= 0 && _dragHandle.HasPointerCapture(_sheetPointer))
            _dragHandle.ReleasePointer(_sheetPointer);
        _sheetPointer = -1;
    }

    private void OnDestroy()
    {
        if (AvatarStateManager.Instance != null)
            AvatarStateManager.Instance.OnAvatarChanged -= OnAvatarChanged;
    }

    // ── UI Binding ────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _avatarViewport  = _root.Q("avatar-viewport");
        _avatarHint      = _root.Q<Label>("avatar-hint");
        _equippedOverlay = _root.Q("equipped-overlay");
        _equippedChips   = _root.Q("equipped-chips");

        _wardrobePanel   = _root.Q("wardrobe-panel");
        _wardrobeCount   = _root.Q<Label>("wardrobe-count");
        _slotsInner      = _root.Q("slots-inner");
        _itemsLoading    = _root.Q("items-loading");
        _itemsEmpty      = _root.Q("items-empty");
        _itemsScroll     = _root.Q("items-scroll");
        _itemsGrid       = _root.Q("items-grid");

        _dragHandle = _wardrobePanel?.Q("drag-handle");

        _root.Q<Button>("btn-customize")?.RegisterCallback<ClickEvent>(_ => OpenWardrobe());
        _root.Q<Button>("btn-marketplace")?.RegisterCallback<ClickEvent>(_ => _app?.NavigateToMarket());
        _root.Q<Button>("btn-close-wardrobe")?.RegisterCallback<ClickEvent>(_ => CloseWardrobe());

        // Measure header height for the "Full" state top clamp
        _root.Q(className: "screen-header")?.RegisterCallback<GeometryChangedEvent>(e =>
        {
            if (e.newRect.height > 0) _headerHeight = e.newRect.height;
        });

        // Keep parentHeight current; reposition peeked panel on resize
        _wardrobePanel?.parent?.RegisterCallback<GeometryChangedEvent>(e =>
        {
            if (e.newRect.height <= 0) return;
            _parentHeight = e.newRect.height;
            if (_sheetState == SheetState.Peeked && _wardrobePanel != null)
                _wardrobePanel.style.top = TopForState(SheetState.Peeked);
        });

        RegisterOrbitEvents();
        RegisterSheetDragEvents();
    }

    // ── Sheet drag / tap gestures ─────────────────────────────────────────────

    private void RegisterSheetDragEvents()
    {
        if (_dragHandle == null) return;
        _dragHandle.RegisterCallback<PointerDownEvent>(OnSheetDown,   TrickleDown.TrickleDown);
        _dragHandle.RegisterCallback<PointerMoveEvent>(OnSheetMove,   TrickleDown.TrickleDown);
        _dragHandle.RegisterCallback<PointerUpEvent>(OnSheetUp,       TrickleDown.TrickleDown);
        _dragHandle.RegisterCallback<PointerCancelEvent>(e => ReleaseSheetPointer(e.pointerId));
    }

    private void OnSheetDown(PointerDownEvent e)
    {
        if (_sheetPointer >= 0) return;
        MeasureParent();
        _sheetPointer      = e.pointerId;
        _sheetDragStartY   = e.position.y;
        _sheetDragStartTop = _wardrobePanel.resolvedStyle.top;
        _animSchedule?.Pause();
        _dragHandle.CapturePointer(e.pointerId);
        e.StopPropagation();
    }

    private void OnSheetMove(PointerMoveEvent e)
    {
        if (e.pointerId != _sheetPointer) return;
        float delta  = e.position.y - _sheetDragStartY;
        float newTop = Mathf.Clamp(
            _sheetDragStartTop + delta,
            _headerHeight,
            _parentHeight - PeekHeight);
        _wardrobePanel.style.top = newTop;
        _preview?.NotifySheetFraction(Mathf.Clamp01(TopToFraction(newTop)));
        e.StopPropagation();
    }

    private void OnSheetUp(PointerUpEvent e)
    {
        if (e.pointerId != _sheetPointer) return;
        float totalDelta = e.position.y - _sheetDragStartY;
        ReleaseSheetPointer(e.pointerId);

        SheetState target;
        if (Mathf.Abs(totalDelta) < 12f)
        {
            // Tap: cycle Peeked → Half → Full → Peeked
            target = _sheetState switch
            {
                SheetState.Peeked => SheetState.Half,
                SheetState.Half   => SheetState.Full,
                _                 => SheetState.Peeked,
            };
        }
        else
        {
            // Snap to the nearest of the three positions
            float cur     = _wardrobePanel.resolvedStyle.top;
            float peekTop = _parentHeight - PeekHeight;
            float halfTop = _parentHeight * 0.5f;
            float fullTop = _headerHeight;

            float dPeek = Mathf.Abs(cur - peekTop);
            float dHalf = Mathf.Abs(cur - halfTop);
            float dFull = Mathf.Abs(cur - fullTop);

            target = dFull <= dHalf && dFull <= dPeek ? SheetState.Full
                   : dHalf <= dPeek                   ? SheetState.Half
                   :                                    SheetState.Peeked;
        }

        SetSheetState(target);
        e.StopPropagation();
    }

    private void ReleaseSheetPointer(int id)
    {
        if (id != _sheetPointer) return;
        if (_dragHandle != null && _dragHandle.HasPointerCapture(id))
            _dragHandle.ReleasePointer(id);
        _sheetPointer = -1;
    }

    // ── Sheet state management ────────────────────────────────────────────────

    private void SetSheetState(SheetState state, bool animate = true)
    {
        _sheetState = state;

        if (state == SheetState.Hidden)
        {
            _animSchedule?.Pause();
            _wardrobePanel?.SetDisplayed(false);
            _root.Q<Button>("btn-customize")?.RemoveFromClassList("customize-active");
            return;
        }

        MeasureParent();
        _wardrobePanel?.SetDisplayed(true);
        float targetTop  = TopForState(state);
        float targetFrac = Mathf.Clamp01(TopToFraction(targetTop));

        if (animate)
            AnimateSheetTo(targetTop, targetFrac);
        else
        {
            if (_wardrobePanel != null)
                _wardrobePanel.style.top = targetTop;
            _preview?.NotifySheetFraction(targetFrac);
        }

        bool open = state != SheetState.Peeked;
        _root.Q<Button>("btn-customize")?.EnableInClassList("customize-active", open);

        if (open)
        {
            if (!_dataLoaded) LoadItems();
            else RenderItems();
        }
    }

    private float TopForState(SheetState state)
    {
        float h = _parentHeight > 0 ? _parentHeight : 600f;
        return state switch
        {
            SheetState.Peeked => h - PeekHeight,
            SheetState.Half   => h * 0.5f,
            SheetState.Full   => _headerHeight,
            _                 => h,
        };
    }

    private void AnimateSheetTo(float targetTop, float targetFrac)
    {
        _animSchedule?.Pause();
        if (_wardrobePanel == null) return;

        float startTop  = _wardrobePanel.resolvedStyle.top;
        if (float.IsNaN(startTop) || float.IsInfinity(startTop) || startTop <= 0f)
            startTop = TopForState(_sheetState);
        float startFrac = Mathf.Clamp01(TopToFraction(startTop));

        float startTime = Time.realtimeSinceStartup;

        _animSchedule = _wardrobePanel.schedule.Execute(() =>
        {
            float t    = Mathf.Clamp01((Time.realtimeSinceStartup - startTime) / AnimDurationS);
            float ease = 1f - (1f - t) * (1f - t); // ease-out quad
            float top  = Mathf.Lerp(startTop, targetTop, ease);
            _wardrobePanel.style.top = top;
            _preview?.NotifySheetFraction(Mathf.Lerp(startFrac, targetFrac, ease));
            if (t >= 1f) _animSchedule?.Pause();
        }).Every(16);
    }

    // Converts panel top-position to a 0→1 fraction (0=peeked, 1=half-open).
    private float TopToFraction(float top)
    {
        if (_parentHeight <= 0f) return 0f;
        float peekTop = _parentHeight - PeekHeight;
        float halfTop = _parentHeight * 0.5f;
        // Linear: 0 at peekTop, 1 at halfTop, >1 approaching fullTop
        return (peekTop - top) / (peekTop - halfTop);
    }

    private void MeasureParent()
    {
        if (_wardrobePanel?.parent == null) return;
        float h = _wardrobePanel.parent.resolvedStyle.height;
        if (h > 0) _parentHeight = h;
    }

    // ── Wardrobe open / close (Customize button + × button) ──────────────────

    public void OpenWardrobe()   => SetSheetState(SheetState.Half);
    private void CloseWardrobe() => SetSheetState(SheetState.Peeked);

    // ── Orbit / zoom pointer handling ─────────────────────────────────────────

    private void RegisterOrbitEvents()
    {
        if (_avatarViewport == null) return;

        _avatarViewport.RegisterCallback<PointerDownEvent>(OnViewportPointerDown,   TrickleDown.TrickleDown);
        _avatarViewport.RegisterCallback<PointerMoveEvent>(OnViewportPointerMove,   TrickleDown.TrickleDown);
        _avatarViewport.RegisterCallback<PointerUpEvent>(OnViewportPointerUp,       TrickleDown.TrickleDown);
        _avatarViewport.RegisterCallback<PointerCancelEvent>(OnViewportPointerCancel, TrickleDown.TrickleDown);
        _avatarViewport.RegisterCallback<WheelEvent>(OnViewportWheel);
    }

    private void OnViewportPointerDown(PointerDownEvent e)
    {
        if (_preview == null) return;

        if (_dragPointerId < 0)
        {
            _dragPointerId = e.pointerId;
            _dragLast      = e.position;
            _avatarViewport.CapturePointer(e.pointerId);
            e.StopPropagation();
        }
        else if (_pinchPointerId < 0 && e.pointerId != _dragPointerId)
        {
            _pinchPointerId  = e.pointerId;
            _pinchLast       = e.position;
            _pinchLastDist   = Vector2.Distance(_dragLast, _pinchLast);
            _avatarViewport.CapturePointer(e.pointerId);
            e.StopPropagation();
        }
    }

    private void OnViewportPointerMove(PointerMoveEvent e)
    {
        if (_preview == null) return;

        if (e.pointerId == _dragPointerId)
        {
            var cur = (Vector2)e.position;

            if (_pinchPointerId >= 0)
            {
                var newDist = Vector2.Distance(cur, _pinchLast);
                _preview.ZoomDelta(newDist - _pinchLastDist);
                _pinchLastDist = newDist;
            }
            else
            {
                var delta = cur - _dragLast;
                _preview.OrbitDelta(delta.x, delta.y);
            }

            _dragLast = cur;
            e.StopPropagation();
        }
        else if (e.pointerId == _pinchPointerId)
        {
            var cur     = (Vector2)e.position;
            var newDist = Vector2.Distance(_dragLast, cur);
            _preview.ZoomDelta(newDist - _pinchLastDist);
            _pinchLastDist = newDist;
            _pinchLast     = cur;
            e.StopPropagation();
        }
    }

    private void OnViewportPointerUp(PointerUpEvent e)
    {
        ReleaseOrbitPointer(e.pointerId);
        e.StopPropagation();
    }

    private void OnViewportPointerCancel(PointerCancelEvent e) => ReleaseOrbitPointer(e.pointerId);

    private void ReleaseOrbitPointer(int id)
    {
        if (id == _dragPointerId)
        {
            if (_avatarViewport.HasPointerCapture(id))
                _avatarViewport.ReleasePointer(id);
            _dragPointerId = -1;

            if (_pinchPointerId >= 0)
            {
                _dragPointerId  = _pinchPointerId;
                _dragLast       = _pinchLast;
                _pinchPointerId = -1;
            }
        }
        else if (id == _pinchPointerId)
        {
            if (_avatarViewport.HasPointerCapture(id))
                _avatarViewport.ReleasePointer(id);
            _pinchPointerId = -1;
            _pinchLastDist  = 0f;
        }
    }

    private void OnViewportWheel(WheelEvent e)
    {
        if (_preview == null) return;
        float zoom = Mathf.Clamp(-e.delta.y * 2f, -30f, 30f);
        _preview.ZoomDelta(zoom);
        e.StopPropagation();
    }

    private void BindPreviewTexture()
    {
        if (_avatarViewport == null || _preview == null) return;
        var rt = _preview.GetRenderTexture();
        if (rt == null) return;
        _avatarViewport.style.backgroundImage =
            new StyleBackground(Background.FromRenderTexture(rt));
        _avatarViewport.style.backgroundSize =
            new StyleBackgroundSize(new BackgroundSize(BackgroundSizeType.Cover));
    }

    // ── Slot pills ────────────────────────────────────────────────────────────

    private void BuildSlotPills()
    {
        if (_slotsInner == null) return;
        _slotsInner.Clear();
        foreach (var slot in Slots)
        {
            var pill = new Button();
            pill.AddToClassList("slot-pill");
            if (slot == _activeSlot) pill.AddToClassList("slot-active");

            var lbl = new Label(slot);
            lbl.AddToClassList("slot-pill-text");
            pill.Add(lbl);

            var captured = slot;
            pill.clicked += () =>
            {
                _activeSlot = captured;
                BuildSlotPills();
                RenderItems();
            };
            _slotsInner.Add(pill);
        }
    }

    // ── Item loading ──────────────────────────────────────────────────────────

    private void LoadItems()
    {
        _dataLoaded = true;
        SetItemsState("loading");

        StartCoroutine(PludoApiClient.ListAvatarItems(50, null,
            result =>
            {
                _allItems = result?.items ?? new List<AvatarItemData>();
                AvatarStateManager.Instance?.SetItems(_allItems);
                RenderItems();
            },
            _ =>
            {
                _allItems = new List<AvatarItemData>();
                SetItemsState("empty");
            }));
    }

    // ── Item grid ─────────────────────────────────────────────────────────────

    private void RenderItems()
    {
        if (_itemsGrid == null) return;
        _itemsGrid.Clear();

        var filtered = _activeSlot == "All"
            ? _allItems
            : _allItems.FindAll(i =>
                string.Equals(i.category, _activeSlot, StringComparison.OrdinalIgnoreCase));

        UpdateWardrobeCount(filtered.Count);

        if (filtered.Count == 0) { SetItemsState("empty"); return; }
        SetItemsState("list");
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
        thumb.style.backgroundColor = CssStyleToColor(item.cssStyles);

        if (!string.IsNullOrEmpty(item.thumbnailUrl))
            StartCoroutine(LoadThumb(item.thumbnailUrl, thumb));
        else if (!string.IsNullOrEmpty(item.imageData))
            ApplyBase64Thumb(item.imageData, thumb);

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
        card.RegisterCallback<ClickEvent>(_ => ToggleEquip(captured));
        return card;
    }

    // ── Equip / Unequip ───────────────────────────────────────────────────────

    private void ToggleEquip(AvatarItemData item)
    {
        var mgr = AvatarStateManager.Instance;
        if (mgr == null) return;

        if (mgr.IsEquipped(item.id))
        {
            mgr.UnequipItem(item.category, item.id);
        }
        else
        {
            mgr.EquipItem(new EquippedItemData
            {
                id            = item.id,
                name          = item.name,
                category      = item.category,
                rarity        = item.rarity,
                cssStyles     = item.cssStyles,
                imageData     = item.imageData,
                thumbnailUrl  = item.thumbnailUrl,
                modelUrl      = item.modelUrl,
                dimensionality = item.dimensionality,
                imageKind     = item.imageKind,
                adjustments   = item.adjustments,
            });
        }
    }

    public void EquipItemFromMarket(AvatarItemData item) => ToggleEquip(item);

    // ── Avatar changed callback ───────────────────────────────────────────────

    private void OnAvatarChanged(AvatarConfig config)
    {
        RefreshPreview();
        if (_wardrobePanel != null && _wardrobePanel.style.display == DisplayStyle.Flex
            && _sheetState != SheetState.Peeked)
            RenderItems();
        _preview?.UpdateEquippedItems(config);
    }

    // ── Preview overlay ───────────────────────────────────────────────────────

    private void RefreshPreview()
    {
        if (_equippedChips == null) return;
        _equippedChips.Clear();

        var mgr    = AvatarStateManager.Instance;
        bool hasAny = false;

        if (mgr != null)
        {
            foreach (var entry in mgr.Avatar.equippedSlots)
            {
                foreach (var item in entry.items)
                {
                    hasAny = true;
                    _equippedChips.Add(BuildEquippedChip(item, entry.slot));
                }
            }
        }

        _avatarHint?.SetDisplayed(!hasAny);
        _equippedOverlay?.SetDisplayed(hasAny);
    }

    private VisualElement BuildEquippedChip(EquippedItemData item, string slot)
    {
        var chip = new VisualElement();
        chip.AddToClassList("equipped-chip");

        var slotLabel = new Label(slot);
        slotLabel.AddToClassList("equipped-chip-slot");
        chip.Add(slotLabel);

        var sepLabel = new Label(" · ");
        sepLabel.AddToClassList("equipped-chip-sep");
        chip.Add(sepLabel);

        var nameLabel = new Label(item.name ?? "");
        nameLabel.AddToClassList("equipped-chip-name");
        chip.Add(nameLabel);

        var removeBtn = new Label("  ×");
        removeBtn.AddToClassList("equipped-chip-remove");
        chip.Add(removeBtn);

        var capturedSlot = slot;
        var capturedId   = item.id;
        chip.RegisterCallback<ClickEvent>(_ =>
            AvatarStateManager.Instance?.UnequipItem(capturedSlot, capturedId));

        return chip;
    }

    // ── Thumbnail loading ─────────────────────────────────────────────────────

    private IEnumerator LoadThumb(string url, VisualElement target)
    {
        if (_texCache.TryGetValue(url, out var cached))
        {
            ApplyTexToElement(cached, target);
            yield break;
        }
        using var req = UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success)
        {
            var tex = DownloadHandlerTexture.GetContent(req);
            _texCache[url] = tex;
            ApplyTexToElement(tex, target);
        }
    }

    private void ApplyBase64Thumb(string base64, VisualElement target)
    {
        try
        {
            int idx = base64.IndexOf(',');
            if (idx >= 0) base64 = base64[(idx + 1)..];
            var bytes = Convert.FromBase64String(base64);
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            tex.LoadImage(bytes);
            ApplyTexToElement(tex, target);
        }
        catch { }
    }

    private static void ApplyTexToElement(Texture2D tex, VisualElement el)
    {
        if (tex == null || el == null) return;
        el.style.backgroundImage = new StyleBackground(tex);
        el.style.backgroundSize  = new StyleBackgroundSize(new BackgroundSize(BackgroundSizeType.Cover));
    }

    private static StyleColor CssStyleToColor(string cssStyles)
    {
        if (string.IsNullOrEmpty(cssStyles) || cssStyles == "{}") return new StyleColor(new Color(0.122f, 0.133f, 0.2f));
        try
        {
            var key = "\"background\":\"";
            int start = cssStyles.IndexOf(key, StringComparison.Ordinal);
            if (start >= 0)
            {
                start += key.Length;
                int end = cssStyles.IndexOf('"', start);
                if (end > start)
                {
                    var hex = cssStyles[start..end];
                    if (ColorUtility.TryParseHtmlString(hex, out var c))
                        return new StyleColor(c);
                }
            }
        }
        catch { }
        return new StyleColor(new Color(0.122f, 0.133f, 0.2f));
    }

    // ── State helpers ─────────────────────────────────────────────────────────

    private void SetItemsState(string state)
    {
        _itemsLoading?.SetDisplayed(state == "loading");
        _itemsEmpty?.SetDisplayed(state   == "empty");
        _itemsScroll?.SetDisplayed(state  == "list");
    }

    private void UpdateWardrobeCount(int count)
    {
        if (_wardrobeCount == null) return;
        _wardrobeCount.text = count == 0 ? "" :
            $"{count} item{(count == 1 ? "" : "s")}";
    }
}
