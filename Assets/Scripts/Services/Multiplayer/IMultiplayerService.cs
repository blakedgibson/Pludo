using System;
using System.Threading;
using System.Threading.Tasks;

namespace Pludo.Services.Multiplayer
{
    // Implemented by PhotonFusionMultiplayerService.
    // Takes ISessionService via constructor injection to write Supabase session state
    // (session_participants joined_at/left_at, game_sessions ended_at, play count)
    // in response to Photon room events.
    public interface IMultiplayerService
    {
        bool IsConnected { get; }
        bool IsInRoom { get; }
        string CurrentRoomName { get; }
        int LocalActorNumber { get; }

        event Action<NetworkPlayer> OnPlayerJoined;
        event Action<NetworkPlayer> OnPlayerLeft;
        event Action<DisconnectCause> OnDisconnected;
        event Action OnJoinedRoom;

        Task<bool> ConnectAsync(
            string accessToken,
            string displayName,
            CancellationToken ct = default);

        Task DisconnectAsync(
            CancellationToken ct = default);

        Task<bool> CreateRoomAsync(
            string roomName,
            int maxPlayers,
            string gameId,
            CancellationToken ct = default);

        Task<bool> JoinRoomAsync(
            string roomName,
            CancellationToken ct = default);

        Task<bool> JoinOrCreateRoomAsync(
            string roomName,
            int maxPlayers,
            string gameId,
            CancellationToken ct = default);

        // Called after joining a Photon room with the corresponding Supabase session id.
        // The implementation wires up OnPlayerJoined/Left to write session_participants rows
        // and calls ISessionService.EndSessionAsync + IncrementPlayCountAsync on room close.
        Task EnableSessionSyncAsync(
            string supabaseSessionId,
            CancellationToken ct = default);

        Task LeaveRoomAsync(
            CancellationToken ct = default);

        NetworkPlayer GetPlayer(int actorNumber);
    }
}
