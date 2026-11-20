using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;
using Social = Pludo.Services.Social;

namespace Pludo.Services.Inventory
{
    public interface IInventoryService
    {
        Task<ServiceResult<PagedResult<InventoryEntry>>> GetInventoryAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        // Returns the equipped loadout as AvatarConfig without going through IProfileService.
        // This is the authoritative write path; UserProfile.AvatarConfig is a denormalized read.
        Task<ServiceResult<Social.AvatarConfig>> GetEquippedConfigAsync(
            CancellationToken ct = default);

        Task<ServiceResult> EquipItemAsync(
            string itemId,
            CancellationToken ct = default);

        Task<ServiceResult> UnequipItemAsync(
            string itemId,
            CancellationToken ct = default);

        Task<ServiceResult<AvatarItem>> GetAvatarItemAsync(
            string itemId,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<AvatarItem>>> GetPublicItemsAsync(
            AvatarItemType? itemType = null,
            PageRequest page = default,
            CancellationToken ct = default);
    }
}
