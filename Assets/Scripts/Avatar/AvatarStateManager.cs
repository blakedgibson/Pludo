using System;
using System.Collections.Generic;
using UnityEngine;

// Singleton MonoBehaviour — owns all avatar state and drives change events.
// Mirrors the useAvatar hook from the gameforgeai reference:
//   equipItem / unequipItem / setBodyColor / syncEquippedItems / isEquipped
public class AvatarStateManager : MonoBehaviour
{
    private static AvatarStateManager _instance;
    public static AvatarStateManager Instance
    {
        get
        {
            if (_instance == null)
                _instance = FindAnyObjectByType<AvatarStateManager>();
            return _instance;
        }
    }

    private const string StorageKey = "pludo_avatar_config";

    private AvatarConfig _avatar;
    public AvatarConfig Avatar => _avatar;

    private List<AvatarItemData> _allItems = new();
    public IReadOnlyList<AvatarItemData> AllItems => _allItems;

    public event Action<AvatarConfig>       OnAvatarChanged;
    public event Action<List<AvatarItemData>> OnItemsChanged;

    private void Awake()
    {
        if (_instance != null && _instance != this) { Destroy(gameObject); return; }
        _instance = this;
        DontDestroyOnLoad(gameObject);
        LoadAvatar();
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    private void LoadAvatar()
    {
        var raw = PlayerPrefs.GetString(StorageKey, "");
        if (!string.IsNullOrEmpty(raw))
        {
            try { _avatar = JsonUtility.FromJson<AvatarConfig>(raw); }
            catch { _avatar = null; }
        }
        _avatar ??= new AvatarConfig();
    }

    private void PersistAndNotify()
    {
        PlayerPrefs.SetString(StorageKey, JsonUtility.ToJson(_avatar));
        PlayerPrefs.Save();
        OnAvatarChanged?.Invoke(_avatar);
    }

    // ── Item list (received from the shell via GameBridge) ────────────────────

    public void SetItems(List<AvatarItemData> items)
    {
        _allItems = items ?? new List<AvatarItemData>();
        OnItemsChanged?.Invoke(_allItems);
        SyncEquippedItems(_allItems); // pick up fresh modelUrl / imageData
    }

    // ── Equip / Unequip ───────────────────────────────────────────────────────

    public void EquipItem(EquippedItemData item)
    {
        var slotEnum = AvatarSlotDefinitions.NormalizeSlot(item.category);
        var slot     = slotEnum.ToString();
        var dict     = _avatar.GetEquippedDict();

        if (!dict.ContainsKey(slot))
            dict[slot] = new List<EquippedItemData>();

        var current = dict[slot];

        if (AvatarSlotDefinitions.IsStackableSlot(slotEnum))
        {
            int idx = current.FindIndex(c => c.id == item.id);
            if (idx >= 0)
            {
                if (SameRenderInputs(current[idx], item)) return; // no-op — no churn
                current[idx] = item;
            }
            else
            {
                current.Add(item);
                // Cap the stack — trim oldest first.
                if (current.Count > AvatarSlotDefinitions.MaxStackDepth)
                    current.RemoveAt(0);
            }
        }
        else
        {
            dict[slot] = new List<EquippedItemData> { item };
        }

        _avatar.SetEquippedDict(dict);
        PersistAndNotify();
    }

    public void UnequipItem(string slot, int itemId)
    {
        var canonical = AvatarSlotDefinitions.NormalizeSlot(slot).ToString();
        var dict      = _avatar.GetEquippedDict();
        if (!dict.ContainsKey(canonical)) return;

        dict[canonical].RemoveAll(c => c.id == itemId);
        if (dict[canonical].Count == 0)
            dict.Remove(canonical);

        _avatar.SetEquippedDict(dict);
        PersistAndNotify();
    }

    public void UnequipSlot(string slot)
    {
        var canonical = AvatarSlotDefinitions.NormalizeSlot(slot).ToString();
        var dict      = _avatar.GetEquippedDict();
        dict.Remove(canonical);
        _avatar.SetEquippedDict(dict);
        PersistAndNotify();
    }

    public bool IsEquipped(int itemId)
    {
        foreach (var entry in _avatar.equippedSlots)
            foreach (var it in entry.items)
                if (it.id == itemId) return true;
        return false;
    }

    public List<EquippedItemData> GetSlotStack(string slot)
    {
        foreach (var entry in _avatar.equippedSlots)
            if (entry.slot == slot) return entry.items;
        return new List<EquippedItemData>();
    }

    // ── Body color ────────────────────────────────────────────────────────────

    public void SetBodyColor(string hexColor)
    {
        _avatar.bodyColor = hexColor;
        _avatar.headColor = hexColor;
        PersistAndNotify();
    }

    // ── Sync (reconcile equipped items against latest server data) ────────────

    // Non-destructive: equipped items absent from `latest` are kept (pagination).
    // Items that ARE in `latest` get their render fields (imageData, modelUrl, etc.)
    // updated in place so late-arriving Meshy URLs propagate without a re-equip.
    private void SyncEquippedItems(List<AvatarItemData> latest)
    {
        if (latest == null || latest.Count == 0) return;

        var byId = new Dictionary<int, AvatarItemData>();
        foreach (var it in latest) byId[it.id] = it;

        bool changed = false;
        foreach (var entry in _avatar.equippedSlots)
        {
            for (int i = 0; i < entry.items.Count; i++)
            {
                var eq = entry.items[i];
                if (!byId.TryGetValue(eq.id, out var fresh)) continue;

                var updated = new EquippedItemData
                {
                    id            = eq.id,
                    name          = fresh.name           ?? eq.name,
                    category      = fresh.category       ?? eq.category,
                    rarity        = fresh.rarity         ?? eq.rarity,
                    cssStyles     = fresh.cssStyles      ?? eq.cssStyles,
                    imageData     = fresh.imageData      ?? eq.imageData,
                    thumbnailUrl  = fresh.thumbnailUrl   ?? eq.thumbnailUrl,
                    modelUrl      = fresh.modelUrl       ?? eq.modelUrl,
                    dimensionality = fresh.dimensionality ?? eq.dimensionality,
                    imageKind     = fresh.imageKind      ?? eq.imageKind,
                    adjustments   = fresh.adjustments    ?? eq.adjustments,
                };

                if (!SameRenderInputs(entry.items[i], updated))
                {
                    entry.items[i] = updated;
                    changed = true;
                }
            }
        }

        if (changed) PersistAndNotify();
    }

    // Returns true when all fields that affect what's drawn on the avatar match.
    private static bool SameRenderInputs(EquippedItemData a, EquippedItemData b) =>
        a.id            == b.id            &&
        a.category      == b.category      &&
        a.cssStyles     == b.cssStyles     &&
        (a.thumbnailUrl ?? "") == (b.thumbnailUrl ?? "") &&
        (a.imageData    ?? "") == (b.imageData    ?? "") &&
        (a.modelUrl     ?? "") == (b.modelUrl     ?? "") &&
        (a.dimensionality ?? "") == (b.dimensionality ?? "") &&
        (a.imageKind    ?? "") == (b.imageKind    ?? "");

    // ── JSON export for GameBridge ────────────────────────────────────────────

    public string GetAvatarConfigJson() => JsonUtility.ToJson(_avatar);
}
