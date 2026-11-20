using System;
using System.Collections.Generic;

namespace Pludo.Services.Games
{
    [Serializable]
    public class GeneratedGame
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public string Description { get; set; }
        public string GenerationPrompt { get; set; }
        public string BundleUrl { get; set; }
        public string ThumbnailUrl { get; set; }
        public string CreatedByUserId { get; set; }
        public int PlayCount { get; set; }
        public bool IsPublic { get; set; }
        public List<string> Tags { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    [Serializable]
    public class GameSession
    {
        public string Id { get; set; }
        public string GameId { get; set; }
        public string HostUserId { get; set; }
        public string PhotonRoomName { get; set; }
        public int PlayerCount { get; set; }
        public DateTime StartedAt { get; set; }
        public DateTime? EndedAt { get; set; }
    }

    [Serializable]
    public class SessionParticipant
    {
        public string SessionId { get; set; }
        public string UserId { get; set; }
        public DateTime JoinedAt { get; set; }
        public DateTime? LeftAt { get; set; }
    }

    public enum SessionEventType { Joined, Left }

    // Controls how SearchByTagsAsync matches tags against the tags[] column.
    // Any → PostgREST "ov" (array overlap, GIN-accelerated)
    // All → PostgREST "cs" (array contains, GIN-accelerated)
    public enum TagMatchMode { Any, All }

    [Serializable]
    public class SessionParticipantEvent
    {
        public string SessionId { get; set; }
        public string UserId { get; set; }
        public SessionEventType EventType { get; set; }
        public DateTime Timestamp { get; set; }
    }
}
