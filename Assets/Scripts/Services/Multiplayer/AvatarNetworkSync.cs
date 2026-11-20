// Requires Photon Fusion 2 SDK.
// Before first use: create Assets/Resources/Fusion/PlayerAvatarObject.prefab
// (empty GameObject + NetworkObject + PlayerAvatarObject), then add it to the
// Fusion Network Project Config prefab table (Project Settings → Fusion).

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Fusion;
using Newtonsoft.Json;
using Pludo.Services.Core;
using Social = Pludo.Services.Social;
using UnityEngine;

namespace Pludo.Services.Multiplayer
{
    public sealed class AvatarNetworkSync : IAvatarNetworkSync
    {
        private const string PrefabPath = "Fusion/PlayerAvatarObject";

        private readonly PhotonFusionMultiplayerService _multiplayer;
        private PlayerAvatarObject _localAvatarObject;

        public AvatarNetworkSync(PhotonFusionMultiplayerService multiplayer)
        {
            _multiplayer = multiplayer;
        }

        // ── IAvatarNetworkSync ────────────────────────────────────────────────

        public Task SpawnLocalAvatarAsync(
            Social.AvatarConfig config,
            CancellationToken ct = default)
        {
            if (_localAvatarObject != null)
                return SyncAvatarConfigAsync(config, ct);

            var runner = _multiplayer.Runner;
            if (runner == null || !runner.IsRunning)
            {
                Debug.LogError("[AvatarNetworkSync] Cannot spawn: NetworkRunner not running.");
                return Task.CompletedTask;
            }

            var prefab = Resources.Load<NetworkObject>(PrefabPath);
            if (prefab == null)
            {
                Debug.LogError($"[AvatarNetworkSync] Prefab not found at Resources/{PrefabPath}. " +
                               "Create the prefab and register it in the Fusion Network Project Config.");
                return Task.CompletedTask;
            }

            var json             = SerializeConfig(config);
            var localPlayer      = runner.LocalPlayer;
            PlayerAvatarObject captured = null;

            // onBeforeSpawned fires synchronously inside Spawn() — safe to set
            // [Networked] properties here so they're replicated from tick 0.
            runner.Spawn(
                prefab,
                Vector3.zero,
                Quaternion.identity,
                localPlayer,
                (r, obj) =>
                {
                    captured = obj.GetComponent<PlayerAvatarObject>();
                    if (captured != null)
                    {
                        captured.OwnerRef        = localPlayer;
                        captured.AvatarConfigJson = json;
                    }
                });

            _localAvatarObject = captured;
            return Task.CompletedTask;
        }

        public Task SyncAvatarConfigAsync(
            Social.AvatarConfig config,
            CancellationToken ct = default)
        {
            if (_localAvatarObject == null || !_localAvatarObject.Object.HasStateAuthority)
            {
                Debug.LogWarning("[AvatarNetworkSync] SyncAvatarConfig: not spawned or no state authority.");
                return Task.CompletedTask;
            }

            _localAvatarObject.AvatarConfigJson = SerializeConfig(config);
            return Task.CompletedTask;
        }

        // O(1) lookup via PlayerAvatarObject.Registry, populated in Spawned().
        public Social.AvatarConfig GetRemoteAvatarConfig(int actorNumber)
        {
            if (!PlayerAvatarObject.Registry.TryGetValue(actorNumber, out var pao) || pao == null)
                return null;

            var json = pao.AvatarConfigJson.Value;
            if (string.IsNullOrEmpty(json)) return new Social.AvatarConfig();

            try
            {
                var items = JsonConvert.DeserializeObject<Dictionary<string, string>>(
                    json, SupabaseHttp.JsonSettings);
                return new Social.AvatarConfig { EquippedItems = items };
            }
            catch
            {
                return new Social.AvatarConfig();
            }
        }

        public void DespawnLocalAvatar()
        {
            var runner = _multiplayer.Runner;
            if (runner != null && _localAvatarObject != null)
                runner.Despawn(_localAvatarObject.Object);
            _localAvatarObject = null;
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        // Serialise only the inner dict (not the AvatarConfig wrapper) to stay
        // within the NetworkString<_512> cap (~512 ASCII chars).
        private static string SerializeConfig(Social.AvatarConfig config)
        {
            var json = config?.EquippedItems != null
                ? JsonConvert.SerializeObject(config.EquippedItems, SupabaseHttp.JsonSettings)
                : "{}";

            if (json.Length > 500)
                Debug.LogWarning(
                    $"[AvatarNetworkSync] AvatarConfig JSON ({json.Length} chars) is near " +
                    "the NetworkString<_512> limit. Reduce equipped items or increase the cap.");

            return json;
        }
    }
}
