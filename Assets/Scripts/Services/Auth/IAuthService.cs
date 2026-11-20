using System;
using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;

namespace Pludo.Services.Auth
{
    public interface IAuthService
    {
        AuthUser CurrentUser    { get; }
        bool     IsAuthenticated { get; }
        bool     IsAnonymous     { get; }

        // Raised on the Unity main thread after any successful sign-in or token refresh.
        event Action<AuthUser> OnSignedIn;
        // Raised on the Unity main thread after sign-out or unrecoverable session expiry.
        event Action OnSignedOut;

        // Call once from the game bootstrap before the first frame that requires auth.
        // Loads a persisted session, refreshes it if needed, and fires OnSignedIn if
        // successful. Returns without error if no session is stored (cold start / new user).
        Task InitializeAsync(CancellationToken ct = default);

        Task<ServiceResult<AuthUser>> SignUpAsync(
            string email,
            string password,
            string username,
            CancellationToken ct = default);

        Task<ServiceResult<AuthUser>> SignUpWithDetailsAsync(
            string email,
            string password,
            string username,
            string birthday,
            CancellationToken ct = default);

        // Accepts a username or email. Resolves username → email via the
        // get_email_for_login RPC before calling Supabase Auth.
        Task<ServiceResult<AuthUser>> SignInWithUsernameOrEmailAsync(
            string usernameOrEmail,
            string password,
            CancellationToken ct = default);

        Task<ServiceResult<AuthUser>> SignInWithEmailAsync(
            string email,
            string password,
            CancellationToken ct = default);

        // Exchange a native SDK identity token (Apple, Google) for a Supabase session.
        // The native sign-in flow (Sign in with Apple, Google Sign-In SDK) runs in the
        // presentation layer and passes the resulting identity token here. AuthService
        // never calls native SDKs directly.
        Task<ServiceResult<AuthUser>> SignInWithOAuthAsync(
            string provider,
            string identityToken,
            string nonce = null,
            CancellationToken ct = default);

        // Creates an anonymous session. Errors are always Network or Server category —
        // there are no credentials to reject for an anonymous user.
        Task<ServiceResult<AuthUser>> SignInAnonymouslyAsync(
            CancellationToken ct = default);

        // Upgrades an anonymous account to a full account, preserving auth.uid().
        // The current anonymous session token is used in the Authorization header so
        // Supabase links the credentials to the existing anonymous user rather than
        // creating a new one.
        Task<ServiceResult<AuthUser>> LinkAnonymousAccountAsync(
            LinkRequest request,
            CancellationToken ct = default);

        // Exchanges the stored refresh token for a new session. Called automatically
        // by the background refresh loop; callers rarely need to invoke this directly.
        Task<ServiceResult<AuthSession>> RefreshSessionAsync(
            CancellationToken ct = default);

        Task<ServiceResult> SignOutAsync(
            CancellationToken ct = default);

        string GetAccessToken();
    }
}
