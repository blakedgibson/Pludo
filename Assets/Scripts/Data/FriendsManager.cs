using System;
using System.Collections.Generic;
using UnityEngine;

// Mirrors useFriends + useChat hooks from the React Native app.
// Persists friends list and per-friend chat history in PlayerPrefs (JSON).
public class FriendsManager : MonoBehaviour
{
    public static FriendsManager Instance { get; private set; }

    private const string FriendsKey  = "@pludo_friends";
    private string MessagesKey(string friendId) => $"@pludo_chat_{friendId}";

    private List<FriendData> _friends = new();
    public IReadOnlyList<FriendData> Friends => _friends;

    public event Action OnFriendsChanged;

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        LoadFriends();
    }

    // ── Friends ───────────────────────────────────────────────────────────────

    private void LoadFriends()
    {
        var raw = PlayerPrefs.GetString(FriendsKey, "");
        if (string.IsNullOrEmpty(raw)) return;
        try
        {
            var wrapper = JsonUtility.FromJson<FriendDataList>(raw);
            _friends = wrapper?.friends ?? new List<FriendData>();
        }
        catch { _friends = new List<FriendData>(); }
    }

    private void SaveFriends()
    {
        var wrapper = new FriendDataList { friends = _friends };
        PlayerPrefs.SetString(FriendsKey, JsonUtility.ToJson(wrapper));
        PlayerPrefs.Save();
        OnFriendsChanged?.Invoke();
    }

    public FriendData AddFriend(string name, string handle)
    {
        var f = new FriendData
        {
            id       = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString() + UnityEngine.Random.Range(1000, 9999),
            name     = name,
            handle   = string.IsNullOrWhiteSpace(handle)
                           ? name.ToLower().Replace(" ", "")
                           : handle.TrimStart('@'),
            addedAt  = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        _friends.Add(f);
        SaveFriends();
        return f;
    }

    // Adds a real account from the database; uses the Supabase user id to prevent duplicates.
    public FriendData AddFriend(UserRecord user)
    {
        if (_friends.Exists(f => f.id == user.id)) return _friends.Find(f => f.id == user.id);
        var f = new FriendData
        {
            id      = user.id,
            name    = user.username,
            handle  = user.handle?.TrimStart('@') ?? user.username,
            addedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        _friends.Add(f);
        SaveFriends();
        return f;
    }

    public bool IsFriend(string userId) => _friends.Exists(f => f.id == userId);

    public void RemoveFriend(string id)
    {
        _friends.RemoveAll(f => f.id == id);
        PlayerPrefs.DeleteKey(MessagesKey(id));
        SaveFriends();
    }

    // ── Chat ──────────────────────────────────────────────────────────────────

    public List<ChatMessageData> GetMessages(string friendId)
    {
        var raw = PlayerPrefs.GetString(MessagesKey(friendId), "");
        if (string.IsNullOrEmpty(raw)) return new List<ChatMessageData>();
        try
        {
            var wrapper = JsonUtility.FromJson<ChatMessageList>(raw);
            return wrapper?.messages ?? new List<ChatMessageData>();
        }
        catch { return new List<ChatMessageData>(); }
    }

    public ChatMessageData SendMessage(string friendId, string text)
    {
        var msg = new ChatMessageData
        {
            id   = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString() + UnityEngine.Random.Range(1000, 9999),
            from = "me",
            text = text,
            ts   = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        var list = GetMessages(friendId);
        list.Add(msg);
        var wrapper = new ChatMessageList { messages = list };
        PlayerPrefs.SetString(MessagesKey(friendId), JsonUtility.ToJson(wrapper));
        PlayerPrefs.Save();
        return msg;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    public static string Initials(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "?";
        var parts = name.Trim().Split(' ');
        var init  = "";
        foreach (var p in parts)
            if (p.Length > 0) init += char.ToUpper(p[0]);
        return init.Length > 2 ? init[..2] : init;
    }

    // Deterministic color from a palette based on name hash.
    private static readonly string[] AvatarPalette = { "#aa33ff", "#00d4ff", "#ff1ab3", "#33ff88", "#ff8c00" };
    public static string AvatarColor(string name)
    {
        int h = 0;
        foreach (char c in (name ?? "")) h = (h * 31 + c) % AvatarPalette.Length;
        return AvatarPalette[Mathf.Abs(h) % AvatarPalette.Length];
    }
}
