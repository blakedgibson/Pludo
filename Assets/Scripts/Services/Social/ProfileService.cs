using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Auth;
using Pludo.Services.Core;
using UnityEngine;

namespace Pludo.Services.Social
{
    public sealed class ProfileService : IProfileService
    {
        private readonly ISupabaseHttpClient _http;
        private readonly IAuthService        _auth;

        public ProfileService(ISupabaseHttpClient http, IAuthService auth)
        {
            _http = http;
            _auth = auth;
        }

        // ── Profile reads ─────────────────────────────────────────────────────

        public async Task<ServiceResult<UserProfile>> GetProfileAsync(
            string userId,
            CancellationToken ct = default)
        {
            var result = await _http.GetAsync<ProfileDto[]>(
                "users",
                new Dictionary<string, string>
                {
                    ["id"]     = $"eq.{userId}",
                    ["limit"]  = "1",
                    ["select"] = ProfileColumns,
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<UserProfile>.Fail(result.Error);
            if (result.Value == null || result.Value.Length == 0)
                return ServiceResult<UserProfile>.Fail(ServiceError.Domain("Profile not found"));

            return ServiceResult<UserProfile>.Ok(result.Value[0].ToModel());
        }

        public Task<ServiceResult<UserProfile>> GetMyProfileAsync(
            CancellationToken ct = default)
        {
            var uid = _auth.CurrentUser?.Id;
            if (uid == null)
                return Task.FromResult(
                    ServiceResult<UserProfile>.Fail(ServiceError.Auth("Not authenticated")));

            return GetProfileAsync(uid, ct);
        }

        public async Task<ServiceResult<PagedResult<UserProfile>>> SearchByUsernameAsync(
            string query,
            PageRequest page = default,
            CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(query))
                return ServiceResult<PagedResult<UserProfile>>.Ok(
                    new PagedResult<UserProfile>(Array.Empty<UserProfile>(), 0, false));

            // Escape PostgREST ilike wildcards embedded in user input.
            // PostgREST maps * → % in SQL; % and _ are raw SQL wildcards that must
            // be escaped so the user's literal characters are matched, not patterns.
            var escaped = EscapeIlike(query.Trim());

            var options = new RequestOptions
            {
                Range = RangeHeader.ForPage(page.Offset, page.Limit > 0 ? page.Limit : 20),
            };

            return (await _http.GetPagedAsync<ProfileDto>(
                "users",
                new Dictionary<string, string>
                {
                    ["username"] = $"ilike.*{escaped}*",
                    ["order"]    = "username",
                    ["select"]   = ProfileColumns,
                },
                options,
                ct))
                .Map(paged => new PagedResult<UserProfile>(
                    MapItems(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // ── Profile writes ────────────────────────────────────────────────────

        public async Task<ServiceResult<UserProfile>> UpdateProfileAsync(
            ProfileUpdateRequest update,
            CancellationToken ct = default)
        {
            if (!string.IsNullOrWhiteSpace(update.DisplayName))
            {
                var r = await _http.RpcVoidAsync(
                    "update_user_profile",
                    new { p_username = (string)null, p_display_name = update.DisplayName },
                    ct: ct);
                if (!r.IsSuccess) return ServiceResult<UserProfile>.Fail(r.Error);
            }

            if (update.AvatarConfig?.EquippedItems != null)
            {
                var r = await _http.RpcVoidAsync(
                    "update_avatar_config",
                    new { p_config = update.AvatarConfig.EquippedItems },
                    ct: ct);
                if (!r.IsSuccess) return ServiceResult<UserProfile>.Fail(r.Error);
            }

            return await GetMyProfileAsync(ct);
        }

        // Fire-and-forget from call sites (callers use `_ = service.TouchLastActiveAsync()`).
        // The method still returns a ServiceResult so callers CAN check if they need to.
        // Failures are logged here rather than propagated, per the fire-and-forget contract.
        public async Task<ServiceResult> TouchLastActiveAsync(
            CancellationToken ct = default)
        {
            var result = await _http.RpcVoidAsync("touch_last_active", new { }, ct: ct);
            if (!result.IsSuccess)
                Debug.LogWarning($"[ProfileService] touch_last_active failed: {result.Error}");
            return result;
        }

        public async Task<ServiceResult<bool>> CheckUsernameAvailableAsync(
            string username,
            CancellationToken ct = default)
        {
            if (string.IsNullOrWhiteSpace(username))
                return ServiceResult<bool>.Ok(false);

            return await _http.RpcAsync<bool>(
                "check_username_available",
                new { p_username = username.Trim() },
                ct: ct);
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        private const string ProfileColumns =
            "id,username,display_name,avatar_config,created_at,last_active_at";

        // Escape user input for PostgREST ilike queries.
        // PostgREST passes % and _ through to PostgreSQL ILIKE unchanged where they act
        // as wildcards. Prefix them with \ so PostgreSQL treats them as literals.
        // The \ itself must be doubled first to avoid escaping the escape character.
        private static string EscapeIlike(string term) =>
            term.Replace("\\", "\\\\")
                .Replace("%",  "\\%")
                .Replace("_",  "\\_");

        private static IReadOnlyList<UserProfile> MapItems(
            System.Collections.Generic.IReadOnlyList<ProfileDto> dtos)
        {
            var result = new UserProfile[dtos.Count];
            for (int i = 0; i < dtos.Count; i++)
                result[i] = dtos[i].ToModel();
            return result;
        }

        // ── Private DTO ───────────────────────────────────────────────────────

        // avatar_config in PostgreSQL is a flat JSON object {"head": "uuid", ...}.
        // AvatarConfig.EquippedItems is Dictionary<string,string> which maps to that
        // shape directly. The outer AvatarConfig wrapper is not in the database JSON.
        private sealed class ProfileDto
        {
            [JsonProperty("id")]             public string                     Id           { get; set; }
            [JsonProperty("username")]       public string                     Username     { get; set; }
            [JsonProperty("display_name")]   public string                     DisplayName  { get; set; }
            [JsonProperty("avatar_config")]  public Dictionary<string, string> AvatarConfig { get; set; }
            [JsonProperty("created_at")]     public DateTime                   CreatedAt    { get; set; }
            [JsonProperty("last_active_at")] public DateTime                   LastActiveAt { get; set; }

            public UserProfile ToModel() => new UserProfile
            {
                Id           = Id,
                Username     = Username,
                DisplayName  = DisplayName,
                AvatarConfig = new AvatarConfig { EquippedItems = AvatarConfig },
                CreatedAt    = CreatedAt,
                LastActiveAt = LastActiveAt,
            };
        }
    }
}
