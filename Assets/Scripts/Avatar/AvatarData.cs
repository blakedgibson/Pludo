using System;
using System.Collections.Generic;

[Serializable]
public class AvatarItemAdjustments
{
    public float scale;
    public float offsetX, offsetY, offsetZ;
    public float rotX,    rotY,    rotZ;
}

// Full item record as received from the server/shell.
[Serializable]
public class AvatarItemData
{
    public int    id;
    public string name;
    public string category;
    public string rarity;
    public string description;
    public string creatorName;
    public string cssStyles;
    public string imageData;      // base64 PNG
    public string imageUrl;
    public string thumbnailUrl;
    public string modelUrl;
    public string dimensionality; // "2d" | "3d"
    public string imageKind;      // "template" | "legacy"
    public float  price;
    public bool   hasImageData;
    public List<string> tags = new();
    public AvatarItemAdjustments adjustments;
}

// Lightweight list wrapper for JsonUtility.
[Serializable]
public class AvatarItemDataList
{
    public List<AvatarItemData> items;
}

// Subset stored in the avatar config when an item is equipped.
[Serializable]
public class EquippedItemData
{
    public int    id;
    public string name;
    public string category;
    public string rarity;
    public string cssStyles;
    public string imageData;
    public string thumbnailUrl;
    public string modelUrl;
    public string dimensionality;
    public string imageKind;
    public AvatarItemAdjustments adjustments;
}

// One slot's worth of equipped items (supports stacking for Tops/Bottoms).
[Serializable]
public class SlotEntry
{
    public string              slot;
    public List<EquippedItemData> items = new();
}

// Full avatar config — JsonUtility-serializable (uses List instead of Dictionary).
[Serializable]
public class AvatarConfig
{
    public string         bodyColor     = "#D4A382";
    public string         headColor     = "#D4A382";
    public List<SlotEntry> equippedSlots = new();

    public Dictionary<string, List<EquippedItemData>> GetEquippedDict()
    {
        var d = new Dictionary<string, List<EquippedItemData>>();
        foreach (var e in equippedSlots)
            d[e.slot] = e.items;
        return d;
    }

    public void SetEquippedDict(Dictionary<string, List<EquippedItemData>> dict)
    {
        equippedSlots.Clear();
        foreach (var kv in dict)
            equippedSlots.Add(new SlotEntry { slot = kv.Key, items = kv.Value });
    }
}
