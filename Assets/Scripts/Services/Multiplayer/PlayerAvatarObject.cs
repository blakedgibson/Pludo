// NetworkBehaviour spawned once per player to carry avatar config across the network.
// Place this component on a prefab at Assets/Resources/Fusion/PlayerAvatarObject.prefab
// alongside a NetworkObject component, then register it in the Fusion Network Project Config.

using System.Collections.Generic;
using Fusion;

namespace Pludo.Services.Multiplayer
{
    public sealed class PlayerAvatarObject : NetworkBehaviour
    {
        // Actor-number → PlayerAvatarObject. Populated in Spawned / cleared in Despawned.
        // Keyed by PlayerId so AvatarNetworkSync can do O(1) remote lookups.
        internal static readonly Dictionary<int, PlayerAvatarObject> Registry = new();

        // AvatarConfig serialised as a compact JSON dict (EquippedItems only).
        // NetworkString<_512> holds up to 512 bytes; enough for ~10 equipped UUID-keyed slots.
        [Networked] public NetworkString<_512> AvatarConfigJson { get; set; }

        // Owning player — set in onBeforeSpawned so it's available from the first tick.
        [Networked] public PlayerRef OwnerRef { get; set; }

        public override void Spawned()
        {
            Registry[OwnerRef.PlayerId] = this;
            name = $"[PlayerAvatar] Actor={OwnerRef.PlayerId}";
        }

        public override void Despawned(NetworkRunner runner, bool hasState)
        {
            Registry.Remove(OwnerRef.PlayerId);
        }
    }
}
