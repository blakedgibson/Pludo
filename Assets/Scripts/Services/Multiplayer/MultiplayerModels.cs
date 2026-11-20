using System.Collections.Generic;
using Pludo.Services.Social;

namespace Pludo.Services.Multiplayer
{
    public class NetworkPlayer
    {
        public int PhotonActorNumber { get; set; }
        public string UserId { get; set; }
        public string DisplayName { get; set; }
        public AvatarConfig AvatarConfig { get; set; }
        public bool IsLocal { get; set; }
        public bool IsHost { get; set; }
    }

    public class RoomInfo
    {
        public string Name { get; set; }
        public int PlayerCount { get; set; }
        public int MaxPlayers { get; set; }
        public bool IsOpen { get; set; }
        public string GameId { get; set; }
    }

    public enum DisconnectCause
    {
        None,
        UserInitiated,
        ServerTimeout,
        AuthenticationFailed,
        NetworkError,
        RoomFull,
        RoomDoesNotExist,
    }
}
