using System.Threading;
using System.Threading.Tasks;
using Social = Pludo.Services.Social;

namespace Pludo.Services.Multiplayer
{
    public interface IAvatarNetworkSync
    {
        Task SpawnLocalAvatarAsync(
            Social.AvatarConfig config,
            CancellationToken ct = default);

        Task SyncAvatarConfigAsync(
            Social.AvatarConfig config,
            CancellationToken ct = default);

        Social.AvatarConfig GetRemoteAvatarConfig(int actorNumber);

        void DespawnLocalAvatar();
    }
}
