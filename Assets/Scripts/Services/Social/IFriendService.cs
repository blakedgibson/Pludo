using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;

namespace Pludo.Services.Social
{
    public interface IFriendService
    {
        Task<ServiceResult<PagedResult<FriendEntry>>> GetFriendsAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<FriendRequest>>> GetPendingRequestsAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        Task<ServiceResult> SendFriendRequestAsync(
            string recipientId,
            CancellationToken ct = default);

        Task<ServiceResult> AcceptFriendRequestAsync(
            string requesterId,
            CancellationToken ct = default);

        Task<ServiceResult> DeclineFriendRequestAsync(
            string requesterId,
            CancellationToken ct = default);

        Task<ServiceResult> BlockUserAsync(
            string userId,
            CancellationToken ct = default);

        Task<ServiceResult> UnblockUserAsync(
            string userId,
            CancellationToken ct = default);

        Task<ServiceResult> RemoveFriendAsync(
            string friendId,
            CancellationToken ct = default);

        Task<ServiceResult> SetOnlineStatusAsync(
            bool isOnline,
            CancellationToken ct = default);

        /// <summary>
        /// Subscribes to presence join/leave events for the caller's current friends.
        /// The friend list is fetched once at subscription start and held as a static
        /// filter for the lifetime of this subscription.
        ///
        /// IMPORTANT: Callers MUST cancel and re-subscribe after any friendship change
        /// (new friend accepted, friend removed) to update the filter. This is a
        /// correctness requirement, not a performance note — a newly added friend's
        /// presence events are silently dropped until re-subscription.
        /// </summary>
        IAsyncEnumerable<FriendPresenceEvent> SubscribeToFriendPresenceAsync(
            CancellationToken ct = default);

        IAsyncEnumerable<FriendRequest> SubscribeToFriendRequestsAsync(
            CancellationToken ct = default);
    }
}
