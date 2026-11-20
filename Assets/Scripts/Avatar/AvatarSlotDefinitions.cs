using System;
using System.Collections.Generic;

public enum AvatarItemSlot
{
    // Canonical slots
    Head, Face, Neck,
    Front, Back, Waist,
    Tops, Bottoms, Shoes,
    Hair, Faces,
    // Legacy aliases kept for save-state migration
    Hat, Shirt, Pants, Accessory, Shoulders
}

public static class AvatarSlotDefinitions
{
    public const int MaxStackDepth = 4;

    public static readonly Dictionary<string, AvatarItemSlot[]> SlotGroups = new()
    {
        ["Accessories"] = new[]
        {
            AvatarItemSlot.Head, AvatarItemSlot.Face, AvatarItemSlot.Neck,
            AvatarItemSlot.Front, AvatarItemSlot.Back, AvatarItemSlot.Waist,
            AvatarItemSlot.Shoes, AvatarItemSlot.Hair
        },
        ["Clothing"] = new[] { AvatarItemSlot.Tops, AvatarItemSlot.Bottoms },
        ["Body"]      = new[] { AvatarItemSlot.Faces }
    };

    private static readonly HashSet<AvatarItemSlot> _stackable = new()
    {
        AvatarItemSlot.Tops, AvatarItemSlot.Bottoms,
        AvatarItemSlot.Shirt, AvatarItemSlot.Pants
    };

    // Maps a raw category string (DB value or legacy alias) onto the canonical slot.
    public static AvatarItemSlot NormalizeSlot(string category)
    {
        if (string.IsNullOrEmpty(category)) return AvatarItemSlot.Accessory;
        return category.ToLowerInvariant() switch
        {
            "hat"        => AvatarItemSlot.Head,
            "shirt"      => AvatarItemSlot.Tops,
            "pants"      => AvatarItemSlot.Bottoms,
            "accessory"  => AvatarItemSlot.Front,
            "shoulders"  => AvatarItemSlot.Tops,
            _ => Enum.TryParse<AvatarItemSlot>(category, true, out var s)
                    ? s
                    : AvatarItemSlot.Accessory
        };
    }

    public static bool IsStackableSlot(AvatarItemSlot slot) => _stackable.Contains(slot);
}
