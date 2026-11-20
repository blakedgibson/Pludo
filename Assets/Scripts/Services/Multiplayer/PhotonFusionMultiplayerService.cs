// Requires Photon Fusion 2 SDK. Import the unitypackage from the Photon dashboard
// (https://dashboard.photonengine.com) before compiling this file.
// All players use GameMode.Shared — no dedicated host; each peer has state authority
// over its own NetworkObjects.

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Fusion;
using Fusion.Sockets;
using Pludo.Services.Games;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Pludo.Services.Multiplayer
{
    public sealed class PhotonFusionMultiplayerService : IMultiplayerService, INetworkRunnerCallbacks
    {
        private readonly ISessionService _session;

        // Exposed so AvatarNetworkSync can access the runner without coupling through IMultiplayerService.
        internal NetworkRunner Runner => _runner;

        private NetworkRunner _runner;
        private string _supabaseSessionId;
        private string _currentGameId;
        private bool   _sessionSyncEnabled;

        private readonly Dictionary<PlayerRef, NetworkPlayer> _players = new();

        public event Action<NetworkPlayer> OnPlayerJoined;
        public event Action<NetworkPlayer> OnPlayerLeft;
        public event Action<DisconnectCause> OnDisconnected;
        public event Action OnJoinedRoom;

        public bool   IsConnected      => _runner != null && _runner.IsRunning;
        public bool   IsInRoom         => _runner != null && _runner.SessionInfo?.IsValid == true;
        public string CurrentRoomName  => _runner?.SessionInfo?.Name;
        public int    LocalActorNumber => _runner?.LocalPlayer.PlayerId ?? -1;

        public PhotonFusionMultiplayerService(ISessionService session)
        {
            _session = session;
        }

        // ── Connection ────────────────────────────────────────────────────────

        // In Fusion 2 SharedMode, Photon connection is bundled with StartGame.
        // ConnectAsync creates the runner game object so it's ready for the first room join.
        public Task<bool> ConnectAsync(
            string accessToken,
            string displayName,
            CancellationToken ct = default)
        {
            EnsureRunner();
            return Task.FromResult(true);
        }

        public async Task DisconnectAsync(CancellationToken ct = default)
        {
            if (_runner == null) return;
            await _runner.Shutdown();
            _runner = null;
        }

        // ── Room operations ───────────────────────────────────────────────────

        public Task<bool> CreateRoomAsync(
            string roomName,
            int maxPlayers,
            string gameId,
            CancellationToken ct = default)
        {
            _currentGameId = gameId;
            return StartSessionAsync(GameMode.Shared, roomName, maxPlayers, ct);
        }

        public Task<bool> JoinRoomAsync(
            string roomName,
            CancellationToken ct = default) =>
            StartSessionAsync(GameMode.Shared, roomName, maxPlayers: 0, ct);

        public Task<bool> JoinOrCreateRoomAsync(
            string roomName,
            int maxPlayers,
            string gameId,
            CancellationToken ct = default)
        {
            _currentGameId = gameId;
            return StartSessionAsync(GameMode.Shared, roomName, maxPlayers, ct);
        }

        // Stores the Supabase session id for the lifetime of this room.
        // OnPlayerJoined / OnShutdown callbacks use it to write session_participants.
        public Task EnableSessionSyncAsync(
            string supabaseSessionId,
            CancellationToken ct = default)
        {
            _supabaseSessionId  = supabaseSessionId;
            _sessionSyncEnabled = true;
            return Task.CompletedTask;
        }

        public async Task LeaveRoomAsync(CancellationToken ct = default)
        {
            // End the Supabase session before shutting Fusion down.
            // Clear the sync flag first so OnShutdown (which fires synchronously
            // during Shutdown()) cannot trigger a second EndSessionAsync call.
            if (_sessionSyncEnabled && _supabaseSessionId != null)
            {
                var sid = _supabaseSessionId;
                _sessionSyncEnabled = false;
                _supabaseSessionId  = null;
                await _session.EndSessionAsync(sid, ct);
            }

            _players.Clear();

            if (_runner != null)
            {
                await _runner.Shutdown();
                _runner = null;
            }
        }

        public NetworkPlayer GetPlayer(int actorNumber)
        {
            foreach (var kv in _players)
                if (kv.Value.PhotonActorNumber == actorNumber)
                    return kv.Value;
            return null;
        }

        // ── Internals ─────────────────────────────────────────────────────────

        private void EnsureRunner()
        {
            if (_runner != null) return;
            var go = new GameObject("[NetworkRunner]");
            GameObject.DontDestroyOnLoad(go);
            _runner = go.AddComponent<NetworkRunner>();
            _runner.ProvideInput = true;
            _runner.AddCallbacks(this);
        }

        private async Task<bool> StartSessionAsync(
            GameMode mode,
            string roomName,
            int maxPlayers,
            CancellationToken ct)
        {
            // Fusion 2 forbids reusing a NetworkRunner after StartGame has been called,
            // whether the session is still running or has already shut down.
            // Always clean up before creating a fresh runner.
            if (_runner != null)
            {
                if (_runner.IsRunning) await _runner.Shutdown();
                if (_runner != null && _runner.gameObject != null)
                    GameObject.Destroy(_runner.gameObject);
                _runner = null;
            }

            EnsureRunner();

            var args = new StartGameArgs
            {
                GameMode    = mode,
                SessionName = roomName,
                PlayerCount = maxPlayers > 0 ? maxPlayers : 16,
                // Scene is omitted — Fusion uses the currently loaded scene.
            };

            try
            {
                // StartGame isn't natively cancellable; race it with the caller's token.
                var startTask  = _runner.StartGame(args);
                var cancelTask = Task.Delay(Timeout.Infinite, ct);
                await Task.WhenAny(startTask, cancelTask);
                ct.ThrowIfCancellationRequested();

                var result = await startTask;
                if (!result.Ok)
                    Debug.LogError($"[MultiplayerService] StartGame failed: {result.ErrorMessage}");
                return result.Ok;
            }
            catch (OperationCanceledException)
            {
                // StartGame was abandoned — destroy the runner so it cannot be reused.
                if (_runner != null)
                {
                    if (_runner.gameObject != null) GameObject.Destroy(_runner.gameObject);
                    _runner = null;
                }
                throw;
            }
        }

        // ── INetworkRunnerCallbacks ───────────────────────────────────────────

        void INetworkRunnerCallbacks.OnPlayerJoined(NetworkRunner runner, PlayerRef player)
        {
            var isLocal = player == runner.LocalPlayer;
            var np = new NetworkPlayer
            {
                PhotonActorNumber = player.PlayerId,
                IsLocal           = isLocal,
                IsHost            = runner.IsSharedModeMasterClient,
            };
            _players[player] = np;
            OnPlayerJoined?.Invoke(np);

            if (isLocal)
                OnJoinedRoom?.Invoke();
        }

        void INetworkRunnerCallbacks.OnPlayerLeft(NetworkRunner runner, PlayerRef player)
        {
            if (_players.TryGetValue(player, out var np))
            {
                _players.Remove(player);
                OnPlayerLeft?.Invoke(np);
            }
        }

        void INetworkRunnerCallbacks.OnShutdown(NetworkRunner runner, ShutdownReason shutdownReason)
        {
            // Only fire Supabase cleanup here for unexpected disconnects.
            // User-initiated leaves (LeaveRoomAsync) clear _sessionSyncEnabled before Shutdown().
            if (_sessionSyncEnabled && _supabaseSessionId != null)
            {
                var sid = _supabaseSessionId;
                _sessionSyncEnabled = false;
                _supabaseSessionId  = null;
                _ = _session.EndSessionAsync(sid);
            }

            _players.Clear();
            OnDisconnected?.Invoke(MapShutdownReason(shutdownReason));
        }

        void INetworkRunnerCallbacks.OnConnectedToServer(NetworkRunner runner)    { }
        void INetworkRunnerCallbacks.OnDisconnectedFromServer(NetworkRunner runner, NetDisconnectReason reason)
            => OnDisconnected?.Invoke(DisconnectCause.NetworkError);
        void INetworkRunnerCallbacks.OnConnectFailed(NetworkRunner runner, NetAddress remoteAddress, NetConnectFailedReason reason)
            => OnDisconnected?.Invoke(DisconnectCause.NetworkError);
        void INetworkRunnerCallbacks.OnConnectRequest(NetworkRunner runner, NetworkRunnerCallbackArgs.ConnectRequest request, byte[] token) { }
        void INetworkRunnerCallbacks.OnInput(NetworkRunner runner, NetworkInput input)                                                      { }
        void INetworkRunnerCallbacks.OnInputMissing(NetworkRunner runner, PlayerRef player, NetworkInput input)                             { }
        void INetworkRunnerCallbacks.OnUserSimulationMessage(NetworkRunner runner, SimulationMessagePtr message)                            { }
        void INetworkRunnerCallbacks.OnSessionListUpdated(NetworkRunner runner, List<SessionInfo> sessionList)                              { }
        void INetworkRunnerCallbacks.OnCustomAuthenticationResponse(NetworkRunner runner, Dictionary<string, object> data)                  { }
        void INetworkRunnerCallbacks.OnHostMigration(NetworkRunner runner, HostMigrationToken hostMigrationToken)                          { }
        void INetworkRunnerCallbacks.OnReliableDataReceived(NetworkRunner runner, PlayerRef player, ReliableKey key, ArraySegment<byte> data) { }
        void INetworkRunnerCallbacks.OnReliableDataProgress(NetworkRunner runner, PlayerRef player, ReliableKey key, float progress)        { }
        void INetworkRunnerCallbacks.OnSceneLoadDone(NetworkRunner runner)                                                                  { }
        void INetworkRunnerCallbacks.OnSceneLoadStart(NetworkRunner runner)                                                                 { }
        void INetworkRunnerCallbacks.OnObjectExitAOI(NetworkRunner runner, NetworkObject obj, PlayerRef player)                            { }
        void INetworkRunnerCallbacks.OnObjectEnterAOI(NetworkRunner runner, NetworkObject obj, PlayerRef player)                           { }

        private static DisconnectCause MapShutdownReason(ShutdownReason r) => r switch
        {
            ShutdownReason.Ok                          => DisconnectCause.UserInitiated,
            ShutdownReason.GameNotFound                => DisconnectCause.RoomDoesNotExist,
            ShutdownReason.GameIsFull                  => DisconnectCause.RoomFull,
            ShutdownReason.ServerInRoom                => DisconnectCause.RoomFull,
            ShutdownReason.CustomAuthenticationFailed  => DisconnectCause.AuthenticationFailed,
            ShutdownReason.AuthenticationTicketExpired => DisconnectCause.AuthenticationFailed,
            ShutdownReason.OperationTimeout            => DisconnectCause.ServerTimeout,
            ShutdownReason.PhotonCloudTimeout          => DisconnectCause.ServerTimeout,
            ShutdownReason.MaxCcuReached               => DisconnectCause.ServerTimeout,
            _                                          => DisconnectCause.NetworkError,
        };
    }
}
