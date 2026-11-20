using System;
using System.Collections;
using System.Threading;
using Pludo.Services.Auth;
using Pludo.Services.Core;
using Pludo.Services.Core.Realtime;
using Pludo.Services.Games;
using Pludo.Services.Inventory;
using Pludo.Services.Multiplayer;
using Pludo.Services.Social;
using ReactUnity.UGUI;
using UnityEngine;

// Boots all Pludo services at runtime, before the first scene frame.
// Lives on a DontDestroyOnLoad GameObject so services survive scene transitions.
// Globals are registered on the ReactRendererUGUI one frame after Start so
// the renderer is guaranteed to exist by then.
public sealed class ServiceBootstrap : MonoBehaviour
{
    public static ServiceBootstrap Instance { get; private set; }

    private CancellationTokenSource _lifetimeCts;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Boot()
    {
        var go = new GameObject("[ServiceBootstrap]");
        DontDestroyOnLoad(go);
        go.AddComponent<ServiceBootstrap>();
    }

    private void Awake()
    {
        if (Instance != null) { Destroy(gameObject); return; }
        Instance = this;

        _lifetimeCts = new CancellationTokenSource();
        BuildServices();
    }

    private void Start()
    {
        StartCoroutine(RegisterGlobalsNextFrame());
    }

    private void OnDestroy()
    {
        _lifetimeCts?.Cancel();
        _lifetimeCts?.Dispose();
    }

    // ── Service construction ──────────────────────────────────────────────────

    private void BuildServices()
    {
        var envConfig = Resources.Load<PludoEnvironmentConfig>("Config/PludoEnvironmentConfig");
        if (envConfig == null)
        {
            Debug.LogError("[ServiceBootstrap] PludoEnvironmentConfig not found at Resources/Config/PludoEnvironmentConfig — Supabase and Photon will not work.");
            return;
        }

        var supaConfig = envConfig.ActiveSupabase;
        if (supaConfig == null || string.IsNullOrEmpty(supaConfig.ProjectUrl))
        {
            Debug.LogError("[ServiceBootstrap] No active SupabaseConfig or ProjectUrl is empty — fill in the Inspector asset.");
            return;
        }

        if (string.IsNullOrEmpty(supaConfig.AnonKey))
            Debug.LogWarning("[ServiceBootstrap] SupabaseConfig.AnonKey is empty — REST calls will be rejected by Supabase.");

        // Core Supabase
        var tokenStorage = new PlayerPrefsTokenStorage();
        var httpClient   = new SupabaseHttpClient(supaConfig);
        var authService  = new AuthService(supaConfig, httpClient, tokenStorage);
        var realtime     = new SupabaseRealtimeClient(supaConfig, () => authService.GetAccessToken());

        // Cloudflare R2
        var r2Config = envConfig.R2;
        IR2StorageService storage = r2Config != null
            ? new CloudflareR2Service(r2Config)
            : null;

        if (storage == null)
            Debug.LogWarning("[ServiceBootstrap] CloudflareR2Config missing from PludoEnvironmentConfig — R2 uploads and URL resolution disabled.");

        // Data services
        var games       = new GameCatalogService(httpClient, storage);
        var inventory   = new InventoryService(httpClient, storage);
        var friends     = new FriendService(httpClient, realtime, authService);
        var profile     = new ProfileService(httpClient, authService);
        var session     = new SessionService(httpClient, realtime);
        var multiplayer = new PhotonFusionMultiplayerService(session);

        // Publish to static accessor
        PludoServices.Auth        = authService;
        PludoServices.Games       = games;
        PludoServices.Inventory   = inventory;
        PludoServices.Friends     = friends;
        PludoServices.Profile     = profile;
        PludoServices.Session     = session;
        PludoServices.Multiplayer = multiplayer;
        PludoServices.Storage     = storage;

        // Restore any persisted Supabase session (non-blocking)
        _ = authService.InitializeAsync(_lifetimeCts.Token);

        // Wire the API client to the environment-appropriate server URL.
        PludoApiClient.BaseUrl = envConfig.ActiveApiUrl;

        PludoServices.IsReady = true;
        Debug.Log($"[ServiceBootstrap] All services ready. Env={PludoEnvironmentConfig.ActiveEnvironment} API={PludoApiClient.BaseUrl}");
    }

    // ── ReactUnity Globals ────────────────────────────────────────────────────

    // Polls every frame until ReactRendererUGUI exists (it may take several frames to
    // initialize), then registers all globals. Gives up after 10 seconds and logs an error.
    private IEnumerator RegisterGlobalsNextFrame()
    {
        const float timeout = 10f;
        float elapsed = 0f;

        while (elapsed < timeout)
        {
            yield return null;
            elapsed += Time.unscaledDeltaTime;

            var renderers = FindObjectsByType<ReactRendererUGUI>();
            if (renderers.Length == 0) continue;

            foreach (var r in renderers)
            {
                RegisterGlobals(r);
                // Re-register whenever the JS context restarts (hot-reload, scene re-enter).
                r.AdvancedOptions.AfterStart.AddListener(() => RegisterGlobals(r));
            }

            Debug.Log($"[ServiceBootstrap] Globals registered on {renderers.Length} renderer(s) after {elapsed:F2}s.");
            yield break;
        }

        Debug.LogError("[ServiceBootstrap] ReactRendererUGUI not found after 10s — signIn/signUp/isAuthenticated globals are NOT registered. Check that ReactBootstrapper is in the scene.");
    }

    private void RegisterGlobals(ReactRendererUGUI renderer)
    {
        if (!PludoServices.IsReady)
        {
            Debug.LogError("[ServiceBootstrap] RegisterGlobals called before services are ready — globals NOT set.");
            return;
        }
        Debug.Log($"[ServiceBootstrap] RegisterGlobals → setting signIn/signUp on renderer '{renderer.name}'.");

        var auth        = PludoServices.Auth;
        var games       = PludoServices.Games;
        var inventory   = PludoServices.Inventory;
        var multiplayer = PludoServices.Multiplayer;
        var profile     = PludoServices.Profile;
        var friends     = PludoServices.Friends;
        var ct          = _lifetimeCts.Token;

        // ── Auth ──────────────────────────────────────────────────────────────

        renderer.Globals["isAuthenticated"]  = new Func<bool>(() => auth.IsAuthenticated);
        renderer.Globals["isAnonymousUser"]  = new Func<bool>(() => auth.IsAnonymous);
        renderer.Globals["currentUserId"]    = new Func<string>(() => auth.CurrentUser?.Id);
        renderer.Globals["currentUserEmail"] = new Func<string>(() => auth.CurrentUser?.Email);
        renderer.Globals["currentUsername"]  = new Func<string>(() => auth.CurrentUser?.Username);
        renderer.Globals["getAccessToken"]   = new Func<string>(() => auth.GetAccessToken());

        renderer.Globals["signInAnonymously"] = new Func<System.Threading.Tasks.Task<bool>>(async () =>
        {
            var result = await auth.SignInAnonymouslyAsync(ct);
            if (!result.IsSuccess)
                Debug.LogWarning($"[Auth] Anonymous sign-in failed: {result.Error.Message}");
            return result.IsSuccess;
        });

        // Login: accepts username OR email + password
        renderer.Globals["signIn"] = new Func<string, string, System.Threading.Tasks.Task<string>>(async (usernameOrEmail, password) =>
        {
            var result = await auth.SignInWithUsernameOrEmailAsync(usernameOrEmail, password, ct);
            return result.IsSuccess ? null : result.Error.Message;
        });

        // Sign-up: email, password, username, birthday (YYYY-MM-DD)
        renderer.Globals["signUp"] = new Func<string, string, string, string, System.Threading.Tasks.Task<string>>(async (email, password, username, birthday) =>
        {
            var result = await auth.SignUpWithDetailsAsync(email, password, username, birthday, ct);
            return result.IsSuccess ? null : result.Error.Message;
        });

        renderer.Globals["signOut"] = new Func<System.Threading.Tasks.Task>(async () =>
        {
            await auth.SignOutAsync(ct);
        });

        // ── Profile ───────────────────────────────────────────────────────────

        // Callable before sign-in (anon role + SECURITY DEFINER RPC).
        // Returns "available", "taken", or null on network error.
        renderer.Globals["checkUsername"] = new Func<string, System.Threading.Tasks.Task<string>>(async (username) =>
        {
            var result = await profile.CheckUsernameAvailableAsync(username, ct);
            if (!result.IsSuccess) return null;
            return result.Value ? "available" : "taken";
        });

        // Update the signed-in user's display name. Returns null on success,
        // or a human-readable error string. Username changes are intentionally
        // not supported here — they require a separate availability check flow.
        renderer.Globals["updateMyProfile"] = new Func<string, System.Threading.Tasks.Task<string>>(async (displayName) =>
        {
            var req = new Pludo.Services.Social.ProfileUpdateRequest { DisplayName = displayName };
            var result = await profile.UpdateProfileAsync(req, ct);
            return result.IsSuccess ? null : result.Error.Message;
        });

        renderer.Globals["fetchMyProfile"] = new Func<System.Threading.Tasks.Task<string>>(async () =>
        {
            var profileResult  = await profile.GetMyProfileAsync(ct);
            var gamesResult    = await games.GetMyGamesAsync(Pludo.Services.Core.PageRequest.First(1), ct);
            var friendsResult  = await friends.GetFriendsAsync(Pludo.Services.Core.PageRequest.First(1), ct);

            // Username priority: profiles table → user_metadata (set at sign-up) → email prefix → truncated userId
            string username;
            if (profileResult.IsSuccess && !string.IsNullOrEmpty(profileResult.Value.Username))
                username = profileResult.Value.Username;
            else if (!string.IsNullOrEmpty(auth.CurrentUser?.Username))
                username = auth.CurrentUser.Username;
            else if (!string.IsNullOrEmpty(auth.CurrentUser?.Email))
                username = auth.CurrentUser.Email.Split('@')[0];
            else
            {
                var uid = auth.CurrentUser?.Id ?? string.Empty;
                username = uid.Length > 0 ? uid.Substring(0, Math.Min(8, uid.Length)) : "User";
            }
            var displayName  = profileResult.IsSuccess && !string.IsNullOrEmpty(profileResult.Value.DisplayName)
                ? profileResult.Value.DisplayName : username;
            var gamesCount   = gamesResult.IsSuccess    ? (gamesResult.Value.TotalCount   ?? 0)     : 0;
            var friendsCount = friendsResult.IsSuccess  ? (friendsResult.Value.TotalCount ?? 0)     : 0;

            return Newtonsoft.Json.JsonConvert.SerializeObject(new
            {
                username,
                displayName,
                gamesCount,
                friendsCount,
            });
        });

        // ── Games ─────────────────────────────────────────────────────────────

        renderer.Globals["fetchMyGames"] = new Func<System.Threading.Tasks.Task<string>>(async () =>
        {
            var result = await games.GetMyGamesAsync(ct: ct);
            return result.IsSuccess
                ? Newtonsoft.Json.JsonConvert.SerializeObject(result.Value)
                : null;
        });

        renderer.Globals["fetchPublicGames"] = new Func<System.Threading.Tasks.Task<string>>(async () =>
        {
            var result = await games.GetPublicGamesAsync(ct: ct);
            return result.IsSuccess
                ? Newtonsoft.Json.JsonConvert.SerializeObject(result.Value)
                : null;
        });

        // ── Inventory ─────────────────────────────────────────────────────────

        renderer.Globals["fetchInventory"] = new Func<System.Threading.Tasks.Task<string>>(async () =>
        {
            var result = await inventory.GetInventoryAsync(ct: ct);
            return result.IsSuccess
                ? Newtonsoft.Json.JsonConvert.SerializeObject(result.Value)
                : null;
        });

        // ── Multiplayer ───────────────────────────────────────────────────────

        renderer.Globals["joinOrCreateRoom"] = new Func<string, string, System.Threading.Tasks.Task<bool>>(async (roomName, gameId) =>
        {
            var result = await multiplayer.JoinOrCreateRoomAsync(roomName, maxPlayers: 16, gameId, ct);
            return result;
        });

        renderer.Globals["leaveRoom"] = new Func<System.Threading.Tasks.Task>(async () =>
        {
            await multiplayer.LeaveRoomAsync(ct);
        });

        renderer.Globals["isInRoom"]       = new Func<bool>(() => multiplayer.IsInRoom);
        renderer.Globals["currentRoomName"] = new Func<string>(() => multiplayer.CurrentRoomName);

        // ── Preferences (PlayerPrefs string KV) ──────────────────────────────
        // The settings sub-screens (Notifications, Privacy, Display, etc.)
        // store their toggles/sliders as strings under "pref:<key>" so the
        // namespace can't collide with anything PlayerPrefs already holds.

        renderer.Globals["getPref"] = new Func<string, string, string>((key, defaultValue) =>
        {
            try { return PlayerPrefs.GetString("pref:" + key, defaultValue ?? string.Empty); }
            catch { return defaultValue ?? string.Empty; }
        });

        renderer.Globals["setPref"] = new Action<string, string>((key, value) =>
        {
            try
            {
                PlayerPrefs.SetString("pref:" + key, value ?? string.Empty);
                PlayerPrefs.Save();
            }
            catch { /* PlayerPrefs unavailable — ignore */ }
        });

        // ── App / audio metadata used by Settings ────────────────────────────

        renderer.Globals["getAppVersion"] = new Func<string>(() =>
        {
            try { return Application.version; } catch { return string.Empty; }
        });

        renderer.Globals["getMasterVolume"] = new Func<float>(() =>
        {
            try { return AudioListener.volume; } catch { return 1f; }
        });

        renderer.Globals["setMasterVolume"] = new Action<float>(v =>
        {
            try
            {
                var clamped = Mathf.Clamp01(v);
                AudioListener.volume = clamped;
                PlayerPrefs.SetFloat("pref:masterVolume", clamped);
                PlayerPrefs.Save();
            }
            catch { /* ignore */ }
        });
    }
}
