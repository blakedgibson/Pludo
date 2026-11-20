using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

public class ChatScreenController : MonoBehaviour
{
    private VisualElement _root;

    private VisualElement _friendsView, _threadView;
    private VisualElement _friendsEmpty, _friendsScroll, _friendsList;
    private VisualElement _threadEmpty, _messagesScroll, _messagesList;
    private VisualElement _threadAvatar;
    private Label         _threadAvatarInit, _threadName, _threadHandle;
    private TextField     _chatInput;
    private Button        _chatSend, _threadBack;

    private VisualElement _addFriendModal;
    private TextField     _addSearchField;
    private VisualElement _addSearchIdle, _addSearchLoading, _addSearchEmpty, _addSearchResults;
    private VisualElement _addResultsList;

    private float  _searchDebounce;
    private string _pendingQuery;

    private FriendData _activeFriend;

    public void Setup(VisualElement root)
    {
        _root = root;
        BindUI();
    }

    public void OnShow()
    {
        RefreshFriendsList();
    }

    // ── Binding ───────────────────────────────────────────────────────────────

    private void BindUI()
    {
        _friendsView      = _root.Q("friends-view");
        _threadView       = _root.Q("thread-view");
        _friendsEmpty     = _root.Q("friends-empty");
        _friendsScroll    = _root.Q("friends-scroll");
        _friendsList      = _root.Q("friends-list");
        _threadEmpty      = _root.Q("thread-empty");
        _messagesScroll   = _root.Q("messages-scroll");
        _messagesList     = _root.Q("messages-list");
        _threadAvatar     = _root.Q("thread-avatar");
        _threadAvatarInit = _root.Q<Label>("thread-avatar-init");
        _threadName       = _root.Q<Label>("thread-name");
        _threadHandle     = _root.Q<Label>("thread-handle");
        _chatInput        = _root.Q<TextField>("chat-input");
        _chatSend         = _root.Q<Button>("chat-send");
        _threadBack       = _root.Q<Button>("thread-back");

        _addFriendModal   = _root.Q("add-friend-modal");
        _addSearchField   = _root.Q<TextField>("add-search-field");
        _addSearchIdle    = _root.Q("add-search-idle");
        _addSearchLoading = _root.Q("add-search-loading");
        _addSearchEmpty   = _root.Q("add-search-empty");
        _addSearchResults = _root.Q("add-search-results");
        _addResultsList   = _root.Q("add-results-list");

        _root.Q<Button>("add-friend-btn")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(true));

        _root.Q<Button>("add-first-btn")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(true));

        _root.Q("modal-backdrop-dismiss")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(false));

        _root.Q<Button>("modal-cancel")?.RegisterCallback<ClickEvent>(_ =>
            ShowAddFriendModal(false));

        _addSearchField?.RegisterValueChangedCallback(e =>
        {
            _pendingQuery   = e.newValue?.Trim() ?? "";
            _searchDebounce = 0.4f;
            SetSearchState("loading");
        });

        _threadBack?.RegisterCallback<ClickEvent>(_ => ShowThread(false));

        _chatSend?.RegisterCallback<ClickEvent>(_ => SendMessage());
        _chatInput?.RegisterCallback<KeyDownEvent>(e =>
        {
            if (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter)
                SendMessage();
        });
    }

    private void Update()
    {
        if (_searchDebounce <= 0f) return;
        _searchDebounce -= Time.unscaledDeltaTime;
        if (_searchDebounce > 0f) return;
        _searchDebounce = 0f;

        var q = _pendingQuery ?? "";
        if (string.IsNullOrWhiteSpace(q)) { SetSearchState("idle"); return; }
        StartCoroutine(RunUserSearch(q));
    }

    private IEnumerator RunUserSearch(string query)
    {
        SetSearchState("loading");
        UserSearchResponse result = null;
        string err = null;
        yield return StartCoroutine(PludoApiClient.SearchUsers(query, r => result = r, e => err = e));

        var users = result?.users;
        if (users == null || users.Count == 0)
        {
            SetSearchState("empty");
            yield break;
        }

        _addResultsList?.Clear();
        foreach (var u in users)
            _addResultsList?.Add(BuildUserResultRow(u));
        SetSearchState("results");
    }

    private VisualElement BuildUserResultRow(UserRecord user)
    {
        var row = new VisualElement();
        row.AddToClassList("add-result-row");

        var circle = new VisualElement();
        circle.AddToClassList("friend-circle");
        if (ColorUtility.TryParseHtmlString(FriendsManager.AvatarColor(user.username), out var col))
            circle.style.backgroundColor = col;
        var init = new Label(FriendsManager.Initials(user.username));
        init.AddToClassList("friend-initials");
        circle.Add(init);

        var info = new VisualElement();
        info.AddToClassList("add-result-info");
        var name = new Label(user.username ?? "");
        name.AddToClassList("add-result-name");
        var handle = new Label(string.IsNullOrEmpty(user.handle) ? "" : $"@{user.handle}");
        handle.AddToClassList("add-result-handle");
        info.Add(name); info.Add(handle);

        bool alreadyAdded = FriendsManager.Instance?.IsFriend(user.id) ?? false;
        var btn = new Button();
        btn.AddToClassList("add-result-btn");
        if (alreadyAdded) btn.AddToClassList("added");
        var btnText = new Label(alreadyAdded ? "Added" : "Add");
        btnText.AddToClassList("add-result-btn-text");
        btn.Add(btnText);

        if (!alreadyAdded)
        {
            var captured = user;
            btn.clicked += () =>
            {
                FriendsManager.Instance?.AddFriend(captured);
                btnText.text = "Added";
                btn.AddToClassList("added");
                RefreshFriendsList();
            };
        }

        row.Add(circle); row.Add(info); row.Add(btn);
        return row;
    }

    private void SetSearchState(string state)
    {
        _addSearchIdle?.SetDisplayed(state == "idle");
        _addSearchLoading?.SetDisplayed(state == "loading");
        _addSearchEmpty?.SetDisplayed(state == "empty");
        _addSearchResults?.SetDisplayed(state == "results");
    }

    // ── Friends list ──────────────────────────────────────────────────────────

    private void RefreshFriendsList()
    {
        if (_friendsList == null) return;
        _friendsList.Clear();

        var friends = FriendsManager.Instance?.Friends;
        bool empty  = friends == null || friends.Count == 0;
        _friendsEmpty?.SetDisplayed(empty);
        _friendsScroll?.SetDisplayed(!empty);

        if (empty) return;

        foreach (var f in friends)
        {
            var row = BuildFriendRow(f);
            _friendsList.Add(row);
        }
    }

    private VisualElement BuildFriendRow(FriendData f)
    {
        var row = new VisualElement();
        row.AddToClassList("friend-row");

        var circle = new VisualElement();
        circle.AddToClassList("friend-circle");
        var color = FriendsManager.AvatarColor(f.name);
        if (ColorUtility.TryParseHtmlString(color, out var c))
            circle.style.backgroundColor = c;

        var init = new Label(FriendsManager.Initials(f.name));
        init.AddToClassList("friend-initials");
        circle.Add(init);
        row.Add(circle);

        var info = new VisualElement();
        info.AddToClassList("friend-row-info");
        var name = new Label(f.name);
        name.AddToClassList("friend-row-name");
        var handle = new Label(string.IsNullOrEmpty(f.handle) ? "" : $"@{f.handle}");
        handle.AddToClassList("friend-row-handle");
        info.Add(name); info.Add(handle);
        row.Add(info);

        var preview = FriendsManager.Instance?.GetMessages(f.id);
        if (preview != null && preview.Count > 0)
        {
            var last = new Label(preview[preview.Count - 1].text);
            last.AddToClassList("friend-row-preview");
            row.Add(last);
        }

        var captured = f;
        row.RegisterCallback<ClickEvent>(_ => OpenThread(captured));
        return row;
    }

    // ── Thread view ───────────────────────────────────────────────────────────

    private void OpenThread(FriendData f)
    {
        _activeFriend = f;

        if (_threadName   != null) _threadName.text   = f.name;
        if (_threadHandle != null) _threadHandle.text  = string.IsNullOrEmpty(f.handle) ? "" : $"@{f.handle}";

        if (_threadAvatarInit != null) _threadAvatarInit.text = FriendsManager.Initials(f.name);
        if (_threadAvatar != null)
        {
            var color = FriendsManager.AvatarColor(f.name);
            if (ColorUtility.TryParseHtmlString(color, out var c))
                _threadAvatar.style.backgroundColor = c;
        }

        ShowThread(true);
        RenderMessages();
    }

    private void ShowThread(bool show)
    {
        _friendsView?.SetDisplayed(!show);
        _threadView?.SetDisplayed(show);
        if (!show) _activeFriend = null;
    }

    private void RenderMessages()
    {
        if (_messagesList == null || _activeFriend == null) return;
        _messagesList.Clear();

        var msgs = FriendsManager.Instance?.GetMessages(_activeFriend.id);
        bool empty = msgs == null || msgs.Count == 0;
        _threadEmpty?.SetDisplayed(empty);
        _messagesScroll?.SetDisplayed(!empty);

        if (empty) return;

        foreach (var m in msgs)
            _messagesList.Add(BuildBubble(m));
    }

    private static VisualElement BuildBubble(ChatMessageData m)
    {
        bool mine = m.from == "me";
        var row = new VisualElement();
        row.AddToClassList(mine ? "bubble-row-mine" : "bubble-row-theirs");

        var bubble = new Label(m.text);
        bubble.AddToClassList("chat-bubble");
        bubble.AddToClassList(mine ? "bubble-mine" : "bubble-theirs");
        row.Add(bubble);
        return row;
    }

    private void SendMessage()
    {
        if (_activeFriend == null) return;
        var text = _chatInput?.value?.Trim() ?? "";
        if (string.IsNullOrEmpty(text)) return;

        FriendsManager.Instance?.SendMessage(_activeFriend.id, text);
        if (_chatInput != null) _chatInput.value = "";
        RenderMessages();
    }

    // ── Add Friend modal ───────────────────────────────────────────────────────

    private void ShowAddFriendModal(bool show)
    {
        _addFriendModal?.SetDisplayed(show);
        if (!show)
        {
            if (_addSearchField != null) _addSearchField.value = "";
            _searchDebounce = 0f;
            _pendingQuery   = "";
            _addResultsList?.Clear();
            SetSearchState("idle");
        }
    }
}
