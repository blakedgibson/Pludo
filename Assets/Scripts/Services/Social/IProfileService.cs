using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;

namespace Pludo.Services.Social
{
    public interface IProfileService
    {
        Task<ServiceResult<UserProfile>> GetProfileAsync(
            string userId,
            CancellationToken ct = default);

        Task<ServiceResult<UserProfile>> GetMyProfileAsync(
            CancellationToken ct = default);

        Task<ServiceResult<UserProfile>> UpdateProfileAsync(
            ProfileUpdateRequest update,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<UserProfile>>> SearchByUsernameAsync(
            string query,
            PageRequest page = default,
            CancellationToken ct = default);

        // Returns true if the username is not already taken (case-insensitive).
        // Callable before sign-in — uses a SECURITY DEFINER RPC to bypass RLS.
        Task<ServiceResult<bool>> CheckUsernameAvailableAsync(
            string username,
            CancellationToken ct = default);

        Task<ServiceResult> TouchLastActiveAsync(
            CancellationToken ct = default);
    }
}
