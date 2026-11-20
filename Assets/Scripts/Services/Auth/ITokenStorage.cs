namespace Pludo.Services.Auth
{
    public sealed class StoredSession
    {
        public string AccessToken  { get; set; }
        public string RefreshToken { get; set; }
        public long   ExpiresAtUtc { get; set; }  // Unix seconds (avoids DateTime serialization edge cases)
        public string UserId       { get; set; }
        public string Username     { get; set; }  // from user_metadata; null for anonymous
        public bool   IsAnonymous  { get; set; }
    }

    public interface ITokenStorage
    {
        void           Save(StoredSession session);
        StoredSession  Load();
        void           Clear();
    }
}
