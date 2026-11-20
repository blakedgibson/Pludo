using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;
using ReactUnity.UGUI;

// GameBridge is the two-way message bus between Unity and the React/Expo shell.
//
//   Shell → Unity  :  SendMessage("GameBridge", "HandleGameData", json)
//   Unity → Shell  :  SendToApp(json)  via the WebBridge.jslib plug-in
//
// On mobile (iOS / Android) the shell may call HandleGameData via a WebView
// bridge or a similar mechanism — the C# API is the same.
public class GameBridge : MonoBehaviour
{
    public static GameBridge Instance { get; private set; }

    [DllImport("__Internal")]
    private static extern void SendToApp(string message);

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    // ── Outbound (Unity → Shell) ──────────────────────────────────────────────

    // Generic send — call from any script that needs to push a message.
    public void SendToShell(string json)
    {
#if !UNITY_EDITOR && (UNITY_WEBGL || UNITY_IOS || UNITY_ANDROID)
        SendToApp(json);
#endif
        Debug.Log($"[GameBridge] → Shell: {json}");
    }

    // Called once when Unity finishes loading so the shell knows it can push data.
    public void SignalReady()
    {
        SendToShell("{\"type\":\"UNITY_READY\"}");
    }

    public void LeaveGame()
    {
        SendToShell("{\"type\":\"LEAVE_GAME\"}");
    }

    // ── Inbound (Shell → Unity via SendMessage) ──────────────────────────────

    // Primary data handshake — called by the shell after UNITY_READY.
    // Expected JSON shape:
    // {
    //   "gameId":      "...",
    //   "title":       "...",
    //   "gameConfig":  "...",
    //   "avatarConfig": "<AvatarConfig JSON>",
    //   "itemsJson":   "<AvatarItemDataList JSON>",
    //   "sessionCode": "...",
    //   "apiBaseUrl":  "https://..."
    // }
    public void HandleGameData(string json)
    {
        Debug.Log($"[GameBridge] ← Shell HandleGameData: {json}");

        GameConfigData data;
        try { data = JsonUtility.FromJson<GameConfigData>(json); }
        catch (System.Exception e)
        {
            Debug.LogError($"[GameBridge] Failed to parse GameConfigData: {e.Message}");
            return;
        }

        // Set API base URL so all PludoApiClient calls hit the right server.
        if (!string.IsNullOrEmpty(data.apiBaseUrl))
            PludoApiClient.BaseUrl = data.apiBaseUrl;

        // Restore avatar config from shell (overrides local PlayerPrefs if provided).
        if (!string.IsNullOrEmpty(data.avatarConfig))
            ApplyAvatarConfig(data.avatarConfig);

        // Load wardrobe items so the UI can display them.
        if (!string.IsNullOrEmpty(data.itemsJson))
            ApplyItems(data.itemsJson);
    }

    // Shell can also push an updated avatar config independently (e.g. cross-device sync).
    public void HandleAvatarConfig(string avatarConfigJson)
    {
        Debug.Log($"[GameBridge] ← Shell HandleAvatarConfig");
        ApplyAvatarConfig(avatarConfigJson);
    }

    // Shell can push a fresh items list independently (e.g. after a new item is forged).
    public void HandleItemsData(string itemsJson)
    {
        Debug.Log($"[GameBridge] ← Shell HandleItemsData");
        ApplyItems(itemsJson);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static void ApplyAvatarConfig(string json)
    {
        var mgr = AvatarStateManager.Instance;
        if (mgr == null) { Debug.LogWarning("[GameBridge] AvatarStateManager not found"); return; }

        try
        {
            var config = JsonUtility.FromJson<AvatarConfig>(json);
            if (config == null) return;

            mgr.SetBodyColor(config.bodyColor);
            foreach (var entry in config.equippedSlots)
                foreach (var item in entry.items)
                    mgr.EquipItem(item);
        }
        catch (System.Exception e)
        {
            Debug.LogError($"[GameBridge] Failed to apply avatar config: {e.Message}");
        }
    }

    private static void ApplyItems(string json)
    {
        var mgr = AvatarStateManager.Instance;
        if (mgr == null) { Debug.LogWarning("[GameBridge] AvatarStateManager not found"); return; }

        try
        {
            var list = JsonUtility.FromJson<AvatarItemDataList>(json);
            mgr.SetItems(list?.items ?? new List<AvatarItemData>());

            // Push to React so InventoryDrawer renders real owned items.
            var renderers = UnityEngine.Object.FindObjectsByType<ReactRendererUGUI>();
            foreach (var r in renderers) r.Globals["_inventoryJson"] = json;
        }
        catch (System.Exception e)
        {
            Debug.LogError($"[GameBridge] Failed to apply items: {e.Message}");
        }
    }

    // ── Unity lifecycle ───────────────────────────────────────────────────────

    private void Start()
    {
        SignalReady();
    }
}

// ── Serialisable data contract ────────────────────────────────────────────────

[System.Serializable]
public class GameConfigData
{
    public string gameId;
    public string title;
    public string gameConfig;
    public string avatarConfig; // JSON-encoded AvatarConfig
    public string itemsJson;    // JSON-encoded AvatarItemDataList
    public string sessionCode;
    public string apiBaseUrl;   // e.g. "https://api.pludo.io"
}
