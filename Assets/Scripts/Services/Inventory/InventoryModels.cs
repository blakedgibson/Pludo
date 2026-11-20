using System;

namespace Pludo.Services.Inventory
{
    public enum AvatarItemType
    {
        Head, Hair, Face, Neck, Top, Bottom,
        Shoes, Accessory, Back, Front, Waist
    }

    [Serializable]
    public class AvatarItem
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Description { get; set; }
        public AvatarItemType ItemType { get; set; }
        public string MeshUrl { get; set; }
        public string ThumbnailUrl { get; set; }
        public string GenerationPrompt { get; set; }
        public bool IsPublic { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    [Serializable]
    public class InventoryEntry
    {
        public AvatarItem Item { get; set; }
        public bool Equipped { get; set; }
        public DateTime AcquiredAt { get; set; }
    }
}
