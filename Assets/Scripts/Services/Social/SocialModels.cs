using System;
using System.Collections.Generic;

namespace Pludo.Services.Social
{
    [Serializable]
    public class UserProfile
    {
        public string Id { get; set; }
        public string Username { get; set; }
        public string DisplayName { get; set; }
        public AvatarConfig AvatarConfig { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime LastActiveAt { get; set; }
    }

    // Denormalized onto users row for fast lobby reads.
    // Source of truth for mutations is IInventoryService.
    [Serializable]
    public class AvatarConfig
    {
        public Dictionary<string, string> EquippedItems { get; set; }
    }

    [Serializable]
    public class FriendEntry
    {
        public UserProfile Profile { get; set; }
        public FriendshipStatus Status { get; set; }
        public DateTime AcceptedAt { get; set; }
    }

    [Serializable]
    public class FriendRequest
    {
        public UserProfile Requester { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    [Serializable]
    public class FriendPresenceEvent
    {
        public string UserId { get; set; }
        public bool IsOnline { get; set; }
        public DateTime Timestamp { get; set; }
    }

    public enum FriendshipStatus { Pending, Accepted, Blocked }

    [Serializable]
    public class ProfileUpdateRequest
    {
        public string DisplayName { get; set; }
        public AvatarConfig AvatarConfig { get; set; }
    }
}
