using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Core;
using UnityEngine.Networking;

namespace Pludo.Services.Auth
{
    public sealed class AuthService : IAuthService
    {
        private readonly string              _authBaseUrl;   // e.g. "https://xyz.supabase.co/auth/v1"
        private readonly string              _anonKey;
        private readonly ISupabaseHttpClient _restClient;   // REST client to keep in sync with token
        private readonly ITokenStorage       _tokenStorage;

        // Refresh loop fires 60 s before JWT expiry. Replaced on each successful sign-in.
        // Never replaced from inside the loop itself to avoid cancelling the running task's CTS.
        private CancellationTokenSource _refreshLoopCts;

        private AuthUser _currentUser;

        public AuthUser CurrentUser     => _currentUser;
        public bool     IsAuthenticated => _currentUser != null;
        public bool     IsAnonymous     => _currentUser?.IsAnonymous ?? false;

        public event Action<AuthUser> OnSignedIn;
        public event Action           OnSignedOut;

        public AuthService(
            SupabaseConfig       config,
            ISupabaseHttpClient  restClient,
            ITokenStorage        tokenStorage)
        {
            _authBaseUrl  = config.ProjectUrl.TrimEnd('/') + "/auth/v1";
            _anonKey      = config.AnonKey;
            _restClient   = restClient;
            _tokenStorage = tokenStorage;
        }

        // ── Bootstrap ────────────────────────────────────────────────────────

        // Call once from the game bootstrap before the first frame that requires auth.
        // Restores a persisted session, refreshing proactively if within 60 s of expiry.
        // Fires OnSignedIn before returning if successful. Returns without error when no
        // session is stored (new user / cold start).
        public async Task InitializeAsync(CancellationToken ct = default)
        {
            var stored = _tokenStorage.Load();
            if (stored == null) return;

            var expiresAt = DateTimeOffset.FromUnixTimeSeconds(stored.ExpiresAtUtc).UtcDateTime;

            if (DateTime.UtcNow >= expiresAt - TimeSpan.FromSeconds(60))
            {
                var result = await ExchangeRefreshTokenAsync(stored.RefreshToken, ct);
                if (!result.IsSuccess)
                {
                    _tokenStorage.Clear();
                    return;
                }
                ApplySession(result.Value);
                return;
            }

            // Token still valid — restore without a network round-trip.
            _currentUser = new AuthUser
            {
                Id           = stored.UserId,
                Username     = stored.Username,
                IsAnonymous  = stored.IsAnonymous,
                AccessToken  = stored.AccessToken,
                RefreshToken = stored.RefreshToken,
                ExpiresAt    = expiresAt,
            };
            _restClient.SetAccessToken(stored.AccessToken);
            StartRefreshLoop(expiresAt);
            OnSignedIn?.Invoke(_currentUser);

            // Backfill username from user_metadata for sessions persisted before this field existed.
            if (string.IsNullOrEmpty(_currentUser.Username) && !_currentUser.IsAnonymous)
                _ = BackfillUsernameAsync(ct);
        }

        // ── Sign-up / Sign-in ─────────────────────────────────────────────────

        public async Task<ServiceResult<AuthUser>> SignUpAsync(
            string email,
            string password,
            string username,
            CancellationToken ct = default)
        {
            var body   = new { email, password, data = new { username } };
            var result = await PostAuthAsync<AuthResponse>("/signup", body, bearerToken: null, ct);
            if (!result.IsSuccess) return ServiceResult<AuthUser>.Fail(result.Error);
            return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
        }

        public async Task<ServiceResult<AuthUser>> SignUpWithDetailsAsync(
            string email,
            string password,
            string username,
            string birthday,
            CancellationToken ct = default)
        {
            var body   = new { email, password, data = new { username, birthday } };
            var result = await PostAuthAsync<AuthResponse>("/signup", body, bearerToken: null, ct);
            if (!result.IsSuccess) return ServiceResult<AuthUser>.Fail(result.Error);
            return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
        }

        // Resolves a username to its email via the get_email_for_login RPC,
        // then signs in with the resolved email and password.
        public async Task<ServiceResult<AuthUser>> SignInWithUsernameOrEmailAsync(
            string usernameOrEmail,
            string password,
            CancellationToken ct = default)
        {
            string email = usernameOrEmail;

            // If it doesn't look like an email, resolve via RPC.
            if (!usernameOrEmail.Contains("@"))
            {
                var rpcUrl = _authBaseUrl.Replace("/auth/v1", "/rest/v1") + "/rpc/get_email_for_login";
                var rpcReq = SupabaseHttp.BuildJsonRequest("POST", rpcUrl, new { p_username_or_email = usernameOrEmail });
                rpcReq.SetRequestHeader("apikey", _anonKey);

                string resolved = null;
                using (rpcReq)
                {
                    var sendErr = await SupabaseHttp.TrySendAsync(rpcReq, ct);
                    if (sendErr.HasValue)
                        return ServiceResult<AuthUser>.Fail(sendErr.Value);

                    if (!SupabaseHttp.IsHttpSuccess(rpcReq))
                        return ServiceResult<AuthUser>.Fail(SupabaseHttp.ParseHttpError(rpcReq));

                    var raw = rpcReq.downloadHandler?.text?.Trim().Trim('"');
                    if (!string.IsNullOrEmpty(raw) && raw != "null")
                        resolved = raw;
                }

                if (string.IsNullOrEmpty(resolved))
                    return ServiceResult<AuthUser>.Fail(
                        ServiceError.Auth("No account found for that username."));

                email = resolved;
            }

            return await SignInWithEmailAsync(email, password, ct);
        }

        public async Task<ServiceResult<AuthUser>> SignInWithEmailAsync(
            string email,
            string password,
            CancellationToken ct = default)
        {
            var body   = new { email, password };
            var result = await PostAuthAsync<AuthResponse>(
                "/token?grant_type=password", body, bearerToken: null, ct);
            if (!result.IsSuccess) return ServiceResult<AuthUser>.Fail(result.Error);
            return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
        }

        public async Task<ServiceResult<AuthUser>> SignInAnonymouslyAsync(
            CancellationToken ct = default)
        {
            var result = await PostAuthAsync<AuthResponse>("/signup", new { }, bearerToken: null, ct);
            if (!result.IsSuccess)
            {
                // No credentials to reject on anonymous sign-in; remap Auth → Server so
                // callers never surface "invalid credentials" to a user who has none.
                var err = result.Error;
                if (err.Category == ServiceErrorCategory.Auth)
                    err = ServiceError.Server(err.Message, err.StatusCode);
                return ServiceResult<AuthUser>.Fail(err);
            }
            return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
        }

        // Exchanges a native SDK identity token (Apple/Google) for a Supabase session.
        // The caller obtains the identity token from the native SDK and passes it here.
        public async Task<ServiceResult<AuthUser>> SignInWithOAuthAsync(
            string provider,
            string identityToken,
            string nonce = null,
            CancellationToken ct = default)
        {
            var body   = nonce != null
                ? (object)new { provider, id_token = identityToken, nonce }
                : new { provider, id_token = identityToken };
            var result = await PostAuthAsync<AuthResponse>(
                "/token?grant_type=id_token", body, bearerToken: null, ct);
            if (!result.IsSuccess) return ServiceResult<AuthUser>.Fail(result.Error);
            return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
        }

        // Upgrades an anonymous account to a full account, preserving auth.uid().
        // Sends the anonymous access token in the Authorization header so Supabase links
        // the credentials to the existing anonymous user rather than creating a new one.
        public async Task<ServiceResult<AuthUser>> LinkAnonymousAccountAsync(
            LinkRequest request,
            CancellationToken ct = default)
        {
            if (!IsAnonymous)
                return ServiceResult<AuthUser>.Fail(
                    ServiceError.Validation("Current session is not anonymous"));

            var anonToken = _currentUser.AccessToken;

            if (request.Method == LinkMethod.Email)
            {
                var body   = new { email = request.Email, password = request.Password };
                var result = await PutAuthAsync<AuthResponse>("/user", body, anonToken, ct);
                if (!result.IsSuccess) return ServiceResult<AuthUser>.Fail(result.Error);
                return ServiceResult<AuthUser>.Ok(ApplySession(result.Value));
            }

            // OAuth link: v1 stub. The id_token endpoint can upgrade an anonymous session
            // when called with an active anonymous token, but requires the native OAuth
            // integration to be in place first.
            return ServiceResult<AuthUser>.Fail(
                ServiceError.Validation("OAuth account linking not yet implemented"));
        }

        // ── Refresh ───────────────────────────────────────────────────────────

        public async Task<ServiceResult<AuthSession>> RefreshSessionAsync(
            CancellationToken ct = default)
        {
            if (_currentUser == null)
                return ServiceResult<AuthSession>.Fail(
                    ServiceError.Auth("No active session to refresh"));

            var result = await ExchangeRefreshTokenAsync(_currentUser.RefreshToken, ct);
            if (!result.IsSuccess) return ServiceResult<AuthSession>.Fail(result.Error);

            var user = ApplySession(result.Value);
            return ServiceResult<AuthSession>.Ok(new AuthSession
            {
                AccessToken  = user.AccessToken,
                RefreshToken = user.RefreshToken,
                ExpiresAt    = user.ExpiresAt,
                User         = user,
            });
        }

        // ── Sign-out ──────────────────────────────────────────────────────────

        public async Task<ServiceResult> SignOutAsync(CancellationToken ct = default)
        {
            var token = _currentUser?.AccessToken;

            // Clear local state before the network call so the session is gone
            // even if the server request fails.
            StopRefreshLoop();
            ClearSessionState();
            OnSignedOut?.Invoke();

            if (token != null)
                await PostAuthVoidAsync("/logout", new { }, token, ct);

            return ServiceResult.Ok();
        }

        public string GetAccessToken() => _currentUser?.AccessToken;

        // ── Session state helpers ─────────────────────────────────────────────

        // ── Host-owned session (React Native shell) ───────────────────────────
        // In the native shell the host app signs in and owns refreshing. Unity
        // adopts the tokens it is handed but never refreshes or persists them:
        // two refreshers on one Supabase session would trip refresh-token
        // rotation and revoke it. The host re-sends after every refresh.
        public void AdoptHostSession(string userId, string username, string accessToken, string refreshToken, long expiresAtUnix)
        {
            StopRefreshLoop();
            _currentUser = new AuthUser
            {
                Id           = userId,
                Username     = username,
                IsAnonymous  = false,
                AccessToken  = accessToken,
                RefreshToken = refreshToken,
                ExpiresAt    = DateTimeOffset.FromUnixTimeSeconds(expiresAtUnix).UtcDateTime,
            };
            _restClient.SetAccessToken(accessToken);
            OnSignedIn?.Invoke(_currentUser);
        }

        public void ClearHostSession()
        {
            StopRefreshLoop();
            if (_currentUser == null) return;
            _currentUser = null;
            _restClient.ClearAccessToken();
            OnSignedOut?.Invoke();
        }

        // Full session apply: updates _currentUser, persists token, syncs REST client,
        // starts (or restarts) the background refresh loop, fires OnSignedIn.
        // Only called from sign-in methods and InitializeAsync — never from inside the
        // refresh loop, to avoid cancelling the running loop's CTS mid-execution.
        private AuthUser ApplySession(AuthResponse response)
        {
            var expiresAt = ParseExpiresAt(response);

            _currentUser = new AuthUser
            {
                Id           = response.User?.Id,
                Email        = response.User?.Email,
                Username     = response.User?.UserMetadata?.Username,
                IsAnonymous  = response.User?.IsAnonymous ?? false,
                AccessToken  = response.AccessToken,
                RefreshToken = response.RefreshToken,
                ExpiresAt    = expiresAt,
            };

            _tokenStorage.Save(new StoredSession
            {
                AccessToken  = response.AccessToken,
                RefreshToken = response.RefreshToken,
                ExpiresAtUtc = new DateTimeOffset(expiresAt).ToUnixTimeSeconds(),
                UserId       = _currentUser.Id,
                Username     = _currentUser.Username,
                IsAnonymous  = _currentUser.IsAnonymous,
            });

            _restClient.SetAccessToken(response.AccessToken);
            StartRefreshLoop(expiresAt);
            OnSignedIn?.Invoke(_currentUser);
            return _currentUser;
        }

        // Lightweight update used only by the refresh loop: updates token fields without
        // restarting the loop (which would cancel the running task's own CTS).
        private DateTime ApplyRefreshResponse(AuthResponse response)
        {
            var expiresAt = ParseExpiresAt(response);

            _currentUser = new AuthUser
            {
                Id           = _currentUser?.Id,
                Email        = _currentUser?.Email ?? response.User?.Email,
                Username     = _currentUser?.Username ?? response.User?.UserMetadata?.Username,
                IsAnonymous  = _currentUser?.IsAnonymous ?? false,
                AccessToken  = response.AccessToken,
                RefreshToken = response.RefreshToken,
                ExpiresAt    = expiresAt,
            };

            _tokenStorage.Save(new StoredSession
            {
                AccessToken  = response.AccessToken,
                RefreshToken = response.RefreshToken,
                ExpiresAtUtc = new DateTimeOffset(expiresAt).ToUnixTimeSeconds(),
                UserId       = _currentUser.Id,
                Username     = _currentUser.Username,
                IsAnonymous  = _currentUser.IsAnonymous,
            });

            _restClient.SetAccessToken(response.AccessToken);
            OnSignedIn?.Invoke(_currentUser);
            return expiresAt;
        }

        private void ClearSessionState()
        {
            _currentUser = null;
            _restClient.ClearAccessToken();
            _tokenStorage.Clear();
        }

        private static DateTime ParseExpiresAt(AuthResponse response) =>
            response.ExpiresAt.HasValue
                ? DateTimeOffset.FromUnixTimeSeconds(response.ExpiresAt.Value).UtcDateTime
                : DateTime.UtcNow.AddSeconds(response.ExpiresIn > 0 ? response.ExpiresIn : 3600);

        // ── Background refresh loop ───────────────────────────────────────────

        private void StartRefreshLoop(DateTime expiresAt)
        {
            StopRefreshLoop();
            _refreshLoopCts = new CancellationTokenSource();
            _ = RunRefreshLoopAsync(expiresAt, _refreshLoopCts.Token);
        }

        private void StopRefreshLoop()
        {
            _refreshLoopCts?.Cancel();
            _refreshLoopCts?.Dispose();
            _refreshLoopCts = null;
        }

        // Uses ApplyRefreshResponse instead of ApplySession to avoid the StartRefreshLoop
        // call that would cancel and dispose the CTS this task is running under.
        private async Task RunRefreshLoopAsync(DateTime expiresAt, CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var delay = expiresAt - DateTime.UtcNow - TimeSpan.FromSeconds(60);
                    if (delay > TimeSpan.Zero)
                        await Task.Delay(delay, ct);

                    if (ct.IsCancellationRequested) return;

                    var result = await ExchangeRefreshTokenAsync(
                        _currentUser?.RefreshToken, ct);

                    if (!result.IsSuccess)
                    {
                        // Session is unrecoverable. Clear state without calling StopRefreshLoop
                        // (we are the loop), then notify and exit.
                        ClearSessionState();
                        OnSignedOut?.Invoke();
                        return;
                    }

                    expiresAt = ApplyRefreshResponse(result.Value);
                }
            }
            catch (OperationCanceledException) { }
        }

        // ── Username backfill ─────────────────────────────────────────────────

        // Fetches full user record from the auth API to populate Username from
        // user_metadata for sessions that were persisted before this field was added.
        private async Task BackfillUsernameAsync(CancellationToken ct)
        {
            try
            {
                var req = UnityWebRequest.Get(_authBaseUrl + "/user");
                AttachAuthHeaders(req, _currentUser?.AccessToken);
                var result = await SendAuthAsync<AuthUserDto>(req, ct);
                if (!result.IsSuccess || _currentUser == null) return;

                var username = result.Value.UserMetadata?.Username;
                if (string.IsNullOrEmpty(username)) return;

                _currentUser = new AuthUser
                {
                    Id           = _currentUser.Id,
                    Email        = _currentUser.Email ?? result.Value.Email,
                    Username     = username,
                    IsAnonymous  = _currentUser.IsAnonymous,
                    AccessToken  = _currentUser.AccessToken,
                    RefreshToken = _currentUser.RefreshToken,
                    ExpiresAt    = _currentUser.ExpiresAt,
                };
                _tokenStorage.Save(new StoredSession
                {
                    AccessToken  = _currentUser.AccessToken,
                    RefreshToken = _currentUser.RefreshToken,
                    ExpiresAtUtc = new DateTimeOffset(_currentUser.ExpiresAt).ToUnixTimeSeconds(),
                    UserId       = _currentUser.Id,
                    Username     = _currentUser.Username,
                    IsAnonymous  = _currentUser.IsAnonymous,
                });
            }
            catch { /* non-critical; username will be backfilled next sign-in */ }
        }

        // ── Raw refresh exchange ──────────────────────────────────────────────

        private async Task<ServiceResult<AuthResponse>> ExchangeRefreshTokenAsync(
            string refreshToken,
            CancellationToken ct)
        {
            if (string.IsNullOrEmpty(refreshToken))
                return ServiceResult<AuthResponse>.Fail(
                    ServiceError.Auth("No refresh token available"));

            var body = new { refresh_token = refreshToken };
            return await PostAuthAsync<AuthResponse>(
                "/token?grant_type=refresh_token", body, bearerToken: null, ct);
        }

        // ── Auth HTTP helpers ─────────────────────────────────────────────────

        private async Task<ServiceResult<T>> PostAuthAsync<T>(
            string endpoint,
            object body,
            string bearerToken,
            CancellationToken ct)
        {
            var req = SupabaseHttp.BuildJsonRequest("POST", _authBaseUrl + endpoint, body);
            AttachAuthHeaders(req, bearerToken);
            return await SendAuthAsync<T>(req, ct);
        }

        private async Task<ServiceResult<T>> PutAuthAsync<T>(
            string endpoint,
            object body,
            string bearerToken,
            CancellationToken ct)
        {
            var req = SupabaseHttp.BuildJsonRequest("PUT", _authBaseUrl + endpoint, body);
            AttachAuthHeaders(req, bearerToken);
            return await SendAuthAsync<T>(req, ct);
        }

        private async Task PostAuthVoidAsync(
            string endpoint,
            object body,
            string bearerToken,
            CancellationToken ct)
        {
            var req = SupabaseHttp.BuildJsonRequest("POST", _authBaseUrl + endpoint, body);
            AttachAuthHeaders(req, bearerToken);
            using (req)
                await SupabaseHttp.TrySendAsync(req, ct);
        }

        private void AttachAuthHeaders(UnityWebRequest req, string bearerToken)
        {
            req.SetRequestHeader("apikey", _anonKey);
            if (!string.IsNullOrEmpty(bearerToken))
                req.SetRequestHeader("Authorization", "Bearer " + bearerToken);
        }

        private static async Task<ServiceResult<T>> SendAuthAsync<T>(
            UnityWebRequest req,
            CancellationToken ct)
        {
            using (req)
            {
                var sendErr = await SupabaseHttp.TrySendAsync(req, ct);
                if (sendErr.HasValue)
                    return ServiceResult<T>.Fail(sendErr.Value);

                if (SupabaseHttp.IsNetworkError(req))
                    return ServiceResult<T>.Fail(ServiceError.Network(req.error));

                if (!SupabaseHttp.IsHttpSuccess(req))
                    return ServiceResult<T>.Fail(SupabaseHttp.ParseHttpError(req));

                try
                {
                    var value = JsonConvert.DeserializeObject<T>(
                        req.downloadHandler.text, SupabaseHttp.JsonSettings);
                    return ServiceResult<T>.Ok(value);
                }
                catch (Exception ex)
                {
                    return ServiceResult<T>.Fail(
                        ServiceError.Server($"Deserialize failed: {ex.Message}"));
                }
            }
        }

        // ── JWT expiry parser ─────────────────────────────────────────────────

        // Parses the 'exp' claim from a JWT without a third-party library.
        // Returns DateTime.MinValue if the token is malformed (treated as already expired).
        internal static DateTime ParseJwtExpiry(string token)
        {
            if (string.IsNullOrEmpty(token)) return DateTime.MinValue;

            var parts = token.Split('.');
            if (parts.Length != 3) return DateTime.MinValue;

            try
            {
                var payload = parts[1]
                    .Replace('-', '+')
                    .Replace('_', '/');
                var pad = (4 - payload.Length % 4) % 4;
                if (pad > 0) payload += new string('=', pad);

                var json = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
                var jwt  = JsonConvert.DeserializeObject<JwtPayload>(json);
                return jwt?.Exp > 0
                    ? DateTimeOffset.FromUnixTimeSeconds(jwt.Exp).UtcDateTime
                    : DateTime.MinValue;
            }
            catch
            {
                return DateTime.MinValue;
            }
        }

        // ── Private DTOs ──────────────────────────────────────────────────────

        private sealed class AuthResponse
        {
            [JsonProperty("access_token")]  public string AccessToken  { get; set; }
            [JsonProperty("refresh_token")] public string RefreshToken { get; set; }
            [JsonProperty("expires_in")]    public int    ExpiresIn    { get; set; }
            // expires_at (Unix seconds) is preferred over expires_in to avoid drift
            // from network latency between the server timestamp and client receipt.
            [JsonProperty("expires_at")]    public long?  ExpiresAt    { get; set; }
            [JsonProperty("user")]          public AuthUserDto User    { get; set; }
        }

        private sealed class AuthUserDto
        {
            [JsonProperty("id")]            public string          Id           { get; set; }
            [JsonProperty("email")]         public string          Email        { get; set; }
            [JsonProperty("is_anonymous")]  public bool            IsAnonymous  { get; set; }
            [JsonProperty("user_metadata")] public UserMetadataDto UserMetadata { get; set; }
        }

        private sealed class UserMetadataDto
        {
            [JsonProperty("username")] public string Username { get; set; }
        }

        private sealed class JwtPayload
        {
            [JsonProperty("exp")] public long Exp { get; set; }
        }
    }
}
