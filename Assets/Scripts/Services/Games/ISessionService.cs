using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;

namespace Pludo.Services.Games
{
    public interface ISessionService
    {
        // photon_room_name is generated server-side and returned in GameSession.PhotonRoomName.
        // Pass that value directly to IMultiplayerService.CreateRoomAsync — no second fetch needed.
        Task<ServiceResult<GameSession>> CreateSessionAsync(
            string gameId,
            CancellationToken ct = default);

        Task<ServiceResult> JoinSessionAsync(
            string sessionId,
            CancellationToken ct = default);

        // Stamps left_at for the caller, closes the session if caller is host or last participant,
        // then calls increment_play_count if the session was closed by this call.
        // Callers do not need to call IncrementPlayCountAsync separately.
        Task<ServiceResult> EndSessionAsync(
            string sessionId,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<GameSession>>> GetActiveSessionsAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        Task<ServiceResult<List<SessionParticipant>>> GetSessionParticipantsAsync(
            string sessionId,
            CancellationToken ct = default);

        // Exposed for IMultiplayerService to call in cases where the Photon session
        // lifecycle diverges from the Supabase session lifecycle (e.g., host migration,
        // Photon-level disconnect recovery). EndSessionAsync calls this automatically
        // for the normal path; callers should not duplicate the call.
        // Both gameId and sessionId are required — the RPC cross-validates them to
        // prevent a session from incrementing play_count on the wrong game.
        Task<ServiceResult> IncrementPlayCountAsync(
            string gameId,
            string sessionId,
            CancellationToken ct = default);

        /// <summary>
        /// Subscribes to INSERT (joined) and UPDATE (left) events on session_participants
        /// for the given session. Yields one event per row change until ct is cancelled,
        /// at which point the channel is left cleanly.
        ///
        /// IMPORTANT: Events that occur during a WebSocket reconnection gap are not
        /// buffered and will not be delivered. For a complete, consistent view after
        /// a reconnect, call GetSessionParticipantsAsync to refresh the participant
        /// list rather than relying solely on the subscription event stream.
        /// </summary>
        IAsyncEnumerable<SessionParticipantEvent> SubscribeToSessionParticipantsAsync(
            string sessionId,
            CancellationToken ct = default);
    }
}
