using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Auth;
using Pludo.Services.Core;
using Pludo.Services.Core.Realtime;

namespace Pludo.Services.Social
{
    public sealed class FriendService : IFriendService
    {
        private readonly ISupabaseHttpClient _http;
        private readonly IRealtimeClient     _realtime;
        private readonly IAuthService        _auth;

        // Topic used for all presence tracking. All authenticated users join this
        // single channel; each user's key is their user ID. FriendService filters
        // incoming presence events by the caller's friend list.
        private const string PresenceChannelName = "presence:online_users";

        public FriendService(
            ISupabaseHttpClient http,
            IRealtimeClient     realtime,
            IAuthService        auth)
        {
            _http     = http;
            _realtime = realtime;
            _auth     = auth;
        }

        // ── Friend list ───────────────────────────────────────────────────────

        public async Task<ServiceResult<PagedResult<FriendEntry>>> GetFriendsAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var uid = RequireUid();
            if (uid == null)
                return ServiceResult<PagedResult<FriendEntry>>.Fail(ServiceError.Auth("Not authenticated"));

            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<FriendshipRow>(
                "friendships",
                new Dictionary<string, string>
                {
                    // user_id = auth.uid() is enforced by RLS; the explicit filter is for
                    // the select so PostgREST can plan efficiently and for clarity.
                    ["user_id"] = $"eq.{uid}",
                    ["status"]  = "eq.accepted",
                    ["select"]  = FriendSelect,
                    ["order"]   = "accepted_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<FriendEntry>(
                    MapFriendEntries(paged.Items), paged.TotalCount, paged.HasMore));
        }

        public async Task<ServiceResult<PagedResult<FriendRequest>>> GetPendingRequestsAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var uid = RequireUid();
            if (uid == null)
                return ServiceResult<PagedResult<FriendRequest>>.Fail(ServiceError.Auth("Not authenticated"));

            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<PendingRequestRow>(
                "friendships",
                new Dictionary<string, string>
                {
                    ["friend_id"] = $"eq.{uid}",
                    ["status"]    = "eq.pending",
                    ["select"]    = PendingSelect,
                    ["order"]     = "created_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<FriendRequest>(
                    MapPendingRequests(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // ── Mutations (all via SECURITY DEFINER RPCs) ─────────────────────────

        public Task<ServiceResult> SendFriendRequestAsync(
            string recipientId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("send_friend_request",
                new { p_recipient_id = recipientId }, ct: ct);

        public Task<ServiceResult> AcceptFriendRequestAsync(
            string requesterId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("accept_friend_request",
                new { p_requester_id = requesterId }, ct: ct);

        public Task<ServiceResult> DeclineFriendRequestAsync(
            string requesterId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("decline_friend_request",
                new { p_requester_id = requesterId }, ct: ct);

        public Task<ServiceResult> BlockUserAsync(
            string userId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("block_user",
                new { p_user_id = userId }, ct: ct);

        public Task<ServiceResult> UnblockUserAsync(
            string userId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("unblock_user",
                new { p_user_id = userId }, ct: ct);

        public Task<ServiceResult> RemoveFriendAsync(
            string friendId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("remove_friend",
                new { p_friend_id = friendId }, ct: ct);

        // ── Presence (Supabase Realtime presence API) ─────────────────────────

        // Uses the Realtime presence channel, not a database column. All online users
        // join the shared channel with their user ID as the key. The write load stays
        // in the Realtime layer, not in PostgreSQL.
        public async Task<ServiceResult> SetOnlineStatusAsync(
            bool isOnline,
            CancellationToken ct = default)
        {
            var uid = RequireUid();
            if (uid == null) return ServiceResult.Fail(ServiceError.Auth("Not authenticated"));

            if (isOnline)
            {
                await _realtime.TrackPresenceAsync(
                    PresenceChannelName,
                    key:     uid,
                    payload: new { user_id = uid, online_at = DateTime.UtcNow.ToString("o") },
                    ct:      ct);
            }
            else
            {
                await _realtime.UntrackPresenceAsync(PresenceChannelName, ct);
            }

            return ServiceResult.Ok();
        }

        // Subscribes to friend presence changes. Fetches the friend list at subscription
        // start to filter events; the filter is static for the lifetime of this subscription.
        // If the friend list changes while subscribed (new friendship accepted or removed),
        // the caller should restart the subscription to pick up the new filter.
        public async IAsyncEnumerable<FriendPresenceEvent> SubscribeToFriendPresenceAsync(
            [EnumeratorCancellation] CancellationToken ct)
        {
            var friendIds = await FetchFriendIdsAsync(ct);

            await foreach (var evt in _realtime.SubscribeToPresenceAsync(PresenceChannelName, ct))
            {
                if (!friendIds.Contains(evt.Key)) continue;

                yield return new FriendPresenceEvent
                {
                    UserId    = evt.Key,
                    IsOnline  = evt.ChangeType != PresenceChangeType.Leave,
                    Timestamp = DateTime.UtcNow,
                };
            }
            // The channel is left in the SubscribeToPresenceAsync finally block.
        }

        // Subscribes to incoming friend requests (INSERT events on the friendships table
        // where friend_id = auth.uid() and status = pending).
        // The phx_leave is sent in the SubscribeToTableChangesAsync finally block when
        // ct is cancelled, cleaning up the WebSocket channel before the iterator exits.
        public async IAsyncEnumerable<FriendRequest> SubscribeToFriendRequestsAsync(
            [EnumeratorCancellation] CancellationToken ct)
        {
            var uid = RequireUid();
            if (uid == null) yield break;

            await foreach (var change in _realtime.SubscribeToTableChangesAsync(
                schema:      "public",
                table:       "friendships",
                eventFilter: "INSERT",
                rowFilter:   $"friend_id=eq.{uid}",
                ct:          ct))
            {
                if (string.IsNullOrEmpty(change.RawRecord)) continue;

                var row = JsonConvert.DeserializeObject<NewFriendshipRow>(
                    change.RawRecord, SupabaseHttp.JsonSettings);

                // The subscription filter catches all inserts where friend_id = uid.
                // Guard against non-pending statuses (block inserts, accepted inserts
                // from the reverse row in accept_friend_request) reaching this handler.
                if (row?.Status != "pending") continue;

                var profileResult = await FetchProfileDtoAsync(row.UserId, ct);
                if (profileResult == null) continue;

                yield return new FriendRequest
                {
                    Requester  = profileResult.ToModel(),
                    CreatedAt  = row.CreatedAt,
                };
            }
        }

        // ── Internal helpers ──────────────────────────────────────────────────

        private string RequireUid() => _auth.CurrentUser?.Id;

        private async Task<HashSet<string>> FetchFriendIdsAsync(CancellationToken ct)
        {
            var uid = RequireUid();
            if (uid == null) return new HashSet<string>();

            var result = await _http.GetAsync<FriendIdRow[]>(
                "friendships",
                new Dictionary<string, string>
                {
                    ["user_id"] = $"eq.{uid}",
                    ["status"]  = "eq.accepted",
                    ["select"]  = "friend_id",
                },
                ct: ct);

            if (!result.IsSuccess) return new HashSet<string>();

            var ids = new HashSet<string>(result.Value?.Length ?? 0);
            if (result.Value != null)
                foreach (var row in result.Value)
                    if (row?.FriendId != null)
                        ids.Add(row.FriendId);
            return ids;
        }

        private async Task<ProfileDto> FetchProfileDtoAsync(string userId, CancellationToken ct)
        {
            var result = await _http.GetAsync<ProfileDto[]>(
                "users",
                new Dictionary<string, string>
                {
                    ["id"]     = $"eq.{userId}",
                    ["limit"]  = "1",
                    ["select"] = "id,username,display_name,avatar_config",
                },
                ct: ct);

            return result.IsSuccess && result.Value?.Length > 0 ? result.Value[0] : null;
        }

        // ── PostgREST select strings ──────────────────────────────────────────

        // Embeds the friend's profile via the friend_id FK, disambiguated with !friend_id
        // because friendships has two FKs to users (user_id and friend_id).
        private const string FriendSelect =
            "accepted_at,profile:users!friend_id(id,username,display_name,avatar_config,last_active_at)";

        private const string PendingSelect =
            "created_at,requester:users!user_id(id,username,display_name,avatar_config)";

        // ── Model mappers ─────────────────────────────────────────────────────

        private static IReadOnlyList<FriendEntry> MapFriendEntries(
            IReadOnlyList<FriendshipRow> rows)
        {
            var result = new FriendEntry[rows.Count];
            for (int i = 0; i < rows.Count; i++)
            {
                var row = rows[i];
                result[i] = new FriendEntry
                {
                    Profile    = row.Profile?.ToModel(),
                    Status     = FriendshipStatus.Accepted,
                    AcceptedAt = row.AcceptedAt,
                };
            }
            return result;
        }

        private static IReadOnlyList<FriendRequest> MapPendingRequests(
            IReadOnlyList<PendingRequestRow> rows)
        {
            var result = new FriendRequest[rows.Count];
            for (int i = 0; i < rows.Count; i++)
                result[i] = new FriendRequest
                {
                    Requester = rows[i].Requester?.ToModel(),
                    CreatedAt = rows[i].CreatedAt,
                };
            return result;
        }

        // ── Private DTOs ──────────────────────────────────────────────────────

        private sealed class ProfileDto
        {
            [JsonProperty("id")]             public string                     Id           { get; set; }
            [JsonProperty("username")]       public string                     Username     { get; set; }
            [JsonProperty("display_name")]   public string                     DisplayName  { get; set; }
            [JsonProperty("avatar_config")]  public Dictionary<string, string> AvatarConfig { get; set; }
            [JsonProperty("last_active_at")] public DateTime                   LastActiveAt { get; set; }

            public UserProfile ToModel() => new UserProfile
            {
                Id           = Id,
                Username     = Username,
                DisplayName  = DisplayName,
                AvatarConfig = new AvatarConfig { EquippedItems = AvatarConfig },
                LastActiveAt = LastActiveAt,
            };
        }

        // Embedded join result from GET /friendships?select=accepted_at,profile:users!friend_id(...)
        private sealed class FriendshipRow
        {
            [JsonProperty("accepted_at")] public DateTime   AcceptedAt { get; set; }
            [JsonProperty("profile")]     public ProfileDto Profile    { get; set; }
        }

        // Embedded join result from GET /friendships?select=created_at,requester:users!user_id(...)
        private sealed class PendingRequestRow
        {
            [JsonProperty("created_at")] public DateTime   CreatedAt { get; set; }
            [JsonProperty("requester")]  public ProfileDto Requester { get; set; }
        }

        // Minimal projection for friend ID fetch used by SubscribeToFriendPresenceAsync.
        private sealed class FriendIdRow
        {
            [JsonProperty("friend_id")] public string FriendId { get; set; }
        }

        // Incoming Postgres change record for a new friendship row.
        private sealed class NewFriendshipRow
        {
            [JsonProperty("user_id")]    public string   UserId    { get; set; }
            [JsonProperty("friend_id")]  public string   FriendId  { get; set; }
            [JsonProperty("status")]     public string   Status    { get; set; }
            [JsonProperty("created_at")] public DateTime CreatedAt { get; set; }
        }
    }
}
