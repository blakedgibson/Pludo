using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Core;
using Pludo.Services.Core.Realtime;

namespace Pludo.Services.Games
{
    public sealed class SessionService : ISessionService
    {
        private readonly ISupabaseHttpClient _http;
        private readonly IRealtimeClient     _realtime;

        public SessionService(ISupabaseHttpClient http, IRealtimeClient realtime)
        {
            _http     = http;
            _realtime = realtime;
        }

        // ── Session lifecycle ─────────────────────────────────────────────────

        // The create_game_session RPC returns both session_id and photon_room_name.
        // PhotonRoomName is the pre-generated room name to pass to IMultiplayerService.CreateRoomAsync.
        public async Task<ServiceResult<GameSession>> CreateSessionAsync(
            string gameId,
            CancellationToken ct = default)
        {
            var rpcResult = await _http.RpcAsync<CreateSessionResult>(
                "create_game_session",
                new { p_game_id = gameId },
                ct: ct);

            if (!rpcResult.IsSuccess)
                return ServiceResult<GameSession>.Fail(rpcResult.Error);

            if (rpcResult.Value == null)
                return ServiceResult<GameSession>.Fail(ServiceError.Domain("create_game_session returned null"));

            // Fetch the full session row so the caller gets all fields, not just id + room_name.
            var sessionResult = await FetchSessionAsync(rpcResult.Value.SessionId, ct);
            if (!sessionResult.IsSuccess)
                return sessionResult;

            // Overwrite PhotonRoomName from the RPC result — the sessions row may not yet
            // have the photon_room_name column populated when this read races with the INSERT.
            var session = sessionResult.Value;
            session.PhotonRoomName = rpcResult.Value.RoomName;
            return ServiceResult<GameSession>.Ok(session);
        }

        public Task<ServiceResult> JoinSessionAsync(
            string sessionId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("join_game_session", new { p_session_id = sessionId }, ct: ct);

        // Stamps left_at for the caller; closes the session if caller is host or last participant.
        // Calls increment_play_count automatically if the session was closed by this call.
        // Callers do NOT need to call IncrementPlayCountAsync separately for the normal path.
        public async Task<ServiceResult> EndSessionAsync(
            string sessionId,
            CancellationToken ct = default)
        {
            // Fetch game_id before ending the session — needed for increment_play_count.
            var gameIdResult = await FetchGameIdForSessionAsync(sessionId, ct);
            if (!gameIdResult.IsSuccess) return ServiceResult.Fail(gameIdResult.Error);

            var endResult = await _http.RpcVoidAsync(
                "end_game_session", new { p_session_id = sessionId }, ct: ct);
            if (!endResult.IsSuccess) return endResult;

            // increment_play_count is idempotent (play_count_incremented guard). If this caller
            // did not close the session the RPC is a no-op; if they did close it, it fires once.
            return await IncrementPlayCountAsync(gameIdResult.Value, sessionId, ct);
        }

        public async Task<ServiceResult<PagedResult<GameSession>>> GetActiveSessionsAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<GameSessionDto>(
                "game_sessions",
                new Dictionary<string, string>
                {
                    ["ended_at"] = "is.null",
                    ["select"]   = SessionColumns,
                    ["order"]    = "started_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<GameSession>(
                    MapSessions(paged.Items), paged.TotalCount, paged.HasMore));
        }

        public async Task<ServiceResult<List<SessionParticipant>>> GetSessionParticipantsAsync(
            string sessionId,
            CancellationToken ct = default)
        {
            var result = await _http.GetAsync<SessionParticipantDto[]>(
                "session_participants",
                new Dictionary<string, string>
                {
                    ["session_id"] = $"eq.{sessionId}",
                    ["select"]     = "session_id,user_id,joined_at,left_at",
                    ["order"]      = "joined_at.asc",
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<List<SessionParticipant>>.Fail(result.Error);

            var participants = new List<SessionParticipant>(result.Value?.Length ?? 0);
            if (result.Value != null)
                foreach (var dto in result.Value)
                    participants.Add(dto.ToModel());

            return ServiceResult<List<SessionParticipant>>.Ok(participants);
        }

        // Exposed for IMultiplayerService for Photon lifecycle divergence (host migration,
        // disconnect recovery). EndSessionAsync covers the normal path; callers should not
        // duplicate the call.
        public Task<ServiceResult> IncrementPlayCountAsync(
            string gameId,
            string sessionId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync(
                "increment_play_count",
                new { p_game_id = gameId, p_session_id = sessionId },
                ct: ct);

        // ── Realtime subscription ─────────────────────────────────────────────

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
        public async IAsyncEnumerable<SessionParticipantEvent> SubscribeToSessionParticipantsAsync(
            string sessionId,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var change in _realtime.SubscribeToTableChangesAsync(
                schema:      "public",
                table:       "session_participants",
                eventFilter: "*",
                rowFilter:   $"session_id=eq.{sessionId}",
                ct:          ct))
            {
                if (string.IsNullOrEmpty(change.RawRecord)) continue;

                var dto = JsonConvert.DeserializeObject<SessionParticipantDto>(
                    change.RawRecord, SupabaseHttp.JsonSettings);
                if (dto == null) continue;

                var eventType = change.ChangeType == PostgresChangeType.Insert
                    ? SessionEventType.Joined
                    : SessionEventType.Left;

                yield return new SessionParticipantEvent
                {
                    SessionId = dto.SessionId,
                    UserId    = dto.UserId,
                    EventType = eventType,
                    Timestamp = DateTime.UtcNow,
                };
            }
        }

        // ── Internal helpers ──────────────────────────────────────────────────

        private async Task<ServiceResult<GameSession>> FetchSessionAsync(
            string sessionId,
            CancellationToken ct)
        {
            var result = await _http.GetAsync<GameSessionDto[]>(
                "game_sessions",
                new Dictionary<string, string>
                {
                    ["id"]    = $"eq.{sessionId}",
                    ["limit"] = "1",
                    ["select"] = SessionColumns,
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<GameSession>.Fail(result.Error);
            if (result.Value == null || result.Value.Length == 0)
                return ServiceResult<GameSession>.Fail(ServiceError.Domain("Session not found"));

            return ServiceResult<GameSession>.Ok(result.Value[0].ToModel());
        }

        private async Task<ServiceResult<string>> FetchGameIdForSessionAsync(
            string sessionId,
            CancellationToken ct)
        {
            var result = await _http.GetAsync<GameIdRow[]>(
                "game_sessions",
                new Dictionary<string, string>
                {
                    ["id"]    = $"eq.{sessionId}",
                    ["limit"] = "1",
                    ["select"] = "game_id",
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<string>.Fail(result.Error);
            if (result.Value == null || result.Value.Length == 0 || result.Value[0]?.GameId == null)
                return ServiceResult<string>.Fail(ServiceError.Domain("Session not found"));

            return ServiceResult<string>.Ok(result.Value[0].GameId);
        }

        private const string SessionColumns =
            "id,game_id,host_user_id,photon_room_name,player_count,started_at,ended_at";

        private static IReadOnlyList<GameSession> MapSessions(IReadOnlyList<GameSessionDto> dtos)
        {
            var result = new GameSession[dtos.Count];
            for (int i = 0; i < dtos.Count; i++)
                result[i] = dtos[i].ToModel();
            return result;
        }

        // ── Private DTOs ──────────────────────────────────────────────────────

        // RPC result shape from create_game_session(p_game_id uuid)
        private sealed class CreateSessionResult
        {
            [JsonProperty("session_id")]  public string SessionId { get; set; }
            [JsonProperty("room_name")]   public string RoomName  { get; set; }
        }

        private sealed class GameSessionDto
        {
            [JsonProperty("id")]               public string    Id            { get; set; }
            [JsonProperty("game_id")]          public string    GameId        { get; set; }
            [JsonProperty("host_user_id")]     public string    HostUserId    { get; set; }
            [JsonProperty("photon_room_name")] public string    PhotonRoomName { get; set; }
            [JsonProperty("player_count")]     public int       PlayerCount   { get; set; }
            [JsonProperty("started_at")]       public DateTime  StartedAt     { get; set; }
            [JsonProperty("ended_at")]         public DateTime? EndedAt       { get; set; }

            public GameSession ToModel() => new GameSession
            {
                Id            = Id,
                GameId        = GameId,
                HostUserId    = HostUserId,
                PhotonRoomName = PhotonRoomName,
                PlayerCount   = PlayerCount,
                StartedAt     = StartedAt,
                EndedAt       = EndedAt,
            };
        }

        private sealed class SessionParticipantDto
        {
            [JsonProperty("session_id")] public string    SessionId { get; set; }
            [JsonProperty("user_id")]    public string    UserId    { get; set; }
            [JsonProperty("joined_at")]  public DateTime  JoinedAt  { get; set; }
            [JsonProperty("left_at")]    public DateTime? LeftAt    { get; set; }

            public SessionParticipant ToModel() => new SessionParticipant
            {
                SessionId = SessionId,
                UserId    = UserId,
                JoinedAt  = JoinedAt,
                LeftAt    = LeftAt,
            };
        }

        private sealed class GameIdRow
        {
            [JsonProperty("game_id")] public string GameId { get; set; }
        }
    }
}
