using System;
using System.Collections.Generic;

[Serializable]
public class GameData
{
    public int    id;
    public string title;
    public string description;
    public string genre;
    public string thumbnailUrl;
    public string gameConfig;
    public string gameCode;
    public string creatorName;
    public int    likes;
    public int    plays;
    public bool   isHot;
    public List<string> tags = new();
    // JSON-serialized Dictionary<string,string> mapping model id → R2 GLB URL.
    // Empty string / "{}" means no Meshy assets for this game.
    public string assetUrlsJson;
    // JSON-serialized List<string> of asset IDs that are humanoid (get walk/idle animator).
    public string humanoidIdsJson;
    // EditorState.Capture JSON — per-object transform tweaks, gear-panel
    // Settings, and Custom Logic graphs that the creator authored on top of
    // the AI-generated Lua script. RunGame / RunGamePreview applies this after
    // the script has spawned objects so the creator's edits actually play.
    // Empty / "{}" = no edits beyond the script.
    public string editorStateJson;
    // JSON-serialized Dictionary<string,float> mapping asset id → real-world
    // target size in meters. Non-humanoids: longest dimension. Humanoids: height.
    // Used by GameAssetLoader.NormalizeScale instead of the flat 1.5m default.
    public string sizeHintsJson;
}

[Serializable]
public class GameListResponse
{
    public List<GameData> games;
    public int total;
}

[Serializable]
public class CreateGameRequest
{
    public string prompt;
    public string creatorName;
}

[Serializable]
public class CreateAvatarItemRequest
{
    public string prompt;
    public string creatorName;
}

[Serializable]
public class CreateLuauGameRequest
{
    public string prompt;
    public string creatorName;
}

[Serializable]
public class LuauJobStartResponse
{
    public string jobId;
}

[Serializable]
public class LuauGameResult
{
    public string title;
    public string description;
    public string genre;
    public string gameCode;
    public string serverScript;
    public string localScript;
    public string gameConfig;
    public string thumbnailPrompt;
    public string assetUrlsJson;
    public List<string> tags;
}

[Serializable]
public class LuauGameStatusResponse
{
    public string status;   // "pending" | "done" | "error"
    public LuauGameResult result;
    public string error;
}

[Serializable]
public class SaveGameRequest
{
    public string title;
    public string description;
    public string genre;
    public string gameCode;
    public string creatorName;
    public string assetUrlsJson;
    public List<string> tags;
}

[Serializable]
public class UserRecord
{
    public string id;
    public string username;
    public string handle;
}

[Serializable]
public class UserSearchResponse
{
    public List<UserRecord> users = new();
}

[Serializable]
public class FriendData
{
    public string id;
    public string name;
    public string handle;
    public long   addedAt;
}

[Serializable]
public class FriendDataList
{
    public List<FriendData> friends = new();
}

[Serializable]
public class ChatMessageData
{
    public string id;
    public string from; // "me" | "them"
    public string text;
    public long   ts;
}

[Serializable]
public class ChatMessageList
{
    public List<ChatMessageData> messages = new();
}
