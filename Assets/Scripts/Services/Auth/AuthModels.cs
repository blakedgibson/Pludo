using System;

namespace Pludo.Services.Auth
{
    [Serializable]
    public class AuthUser
    {
        public string Id { get; set; }
        public string Email { get; set; }
        public string Username { get; set; }   // from user_metadata set at sign-up
        public bool IsAnonymous { get; set; }
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public DateTime ExpiresAt { get; set; }
    }

    [Serializable]
    public class AuthSession
    {
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public DateTime ExpiresAt { get; set; }
        public AuthUser User { get; set; }
    }

    public enum LinkMethod { Email, OAuth }

    public class LinkRequest
    {
        public LinkMethod Method { get; set; }
        public string Email { get; set; }          // Method = Email
        public string Password { get; set; }       // Method = Email
        public string OAuthProvider { get; set; }  // Method = OAuth
    }
}
