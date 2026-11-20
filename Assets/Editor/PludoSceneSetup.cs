using UnityEngine;
using UnityEngine.UIElements;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

// Run via: Pludo → Setup Scene
// Wires all screen controllers, UXML assets, and singletons into the scene.
public static class PludoSceneSetup
{
    [MenuItem("Pludo/Setup Scene")]
    public static void Run()
    {
        // ── UIManager ─────────────────────────────────────────────────────────
        var uiManager = GameObject.Find("UIManager");
        if (uiManager == null)
        {
            Debug.LogError("[PludoSetup] UIManager not found in scene.");
            return;
        }

        // Remove stale AvatarScreenController that lived directly on UIManager
        // (old single-UIDocument design, replaced by MainAppController pattern)
        var comps = uiManager.GetComponents<MonoBehaviour>();
        foreach (var c in comps)
        {
            if (c != null && c.GetType().Name == "AvatarScreenController"
                          && c.GetType().Assembly.GetName().Name == "Assembly-CSharp")
            {
                Object.DestroyImmediate(c);
                Debug.Log("[PludoSetup] Removed old AvatarScreenController from UIManager");
            }
        }

        // MainAppController
        var mac = uiManager.GetComponent<MainAppController>();
        if (mac == null)
        {
            mac = uiManager.AddComponent<MainAppController>();
            Debug.Log("[PludoSetup] Added MainAppController");
        }

        // UIDocument → MainApp.uxml
        var uidoc = uiManager.GetComponent<UIDocument>();
        var mainAsset = Load("Assets/UI/UXML/MainApp.uxml");
        if (uidoc != null && mainAsset != null)
        {
            uidoc.visualTreeAsset = mainAsset;
            Debug.Log("[PludoSetup] UIDocument set to MainApp.uxml");
        }

        // ── UXML assets ───────────────────────────────────────────────────────
        var discoverAsset = Load("Assets/UI/UXML/DiscoverScreen.uxml");
        var gamesAsset    = Load("Assets/UI/UXML/GamesScreen.uxml");
        var avatarAsset   = Load("Assets/UI/UXML/AvatarScreen.uxml");
        var chatAsset     = Load("Assets/UI/UXML/ChatScreen.uxml");
        var createAsset   = Load("Assets/UI/UXML/CreateScreen.uxml");
        var marketAsset   = Load("Assets/UI/UXML/MarketScreen.uxml");
        var forgeAsset    = Load("Assets/UI/UXML/ForgeScreen.uxml");

        // ── Child controller GameObjects ───────────────────────────────────────
        var discoverCtrl = EnsureChild<DiscoverScreenController>(uiManager, "DiscoverCtrl");
        var gamesCtrl    = EnsureChild<GamesScreenController>(uiManager,    "GamesCtrl");
        var avatarCtrl   = EnsureChild<AvatarScreenController>(uiManager,   "AvatarCtrl");
        var chatCtrl     = EnsureChild<ChatScreenController>(uiManager,     "ChatCtrl");
        var createCtrl   = EnsureChild<CreateScreenController>(uiManager,   "CreateCtrl");
        var marketCtrl   = EnsureChild<MarketScreenController>(uiManager,   "MarketCtrl");
        var forgeCtrl    = EnsureChild<ForgeScreenController>(uiManager,    "ForgeCtrl");

        // ── Wire SerializedFields on MainAppController ────────────────────────
        var so = new SerializedObject(mac);

        SetField(so, "discoverScreenAsset", discoverAsset);
        SetField(so, "gamesScreenAsset",    gamesAsset);
        SetField(so, "avatarScreenAsset",   avatarAsset);
        SetField(so, "chatScreenAsset",     chatAsset);
        SetField(so, "createScreenAsset",   createAsset);
        SetField(so, "marketScreenAsset",   marketAsset);
        SetField(so, "forgeScreenAsset",    forgeAsset);

        SetField(so, "discoverCtrl", discoverCtrl);
        SetField(so, "gamesCtrl",    gamesCtrl);
        SetField(so, "avatarCtrl",   avatarCtrl);
        SetField(so, "chatCtrl",     chatCtrl);
        SetField(so, "createCtrl",   createCtrl);
        SetField(so, "marketCtrl",   marketCtrl);
        SetField(so, "forgeCtrl",    forgeCtrl);

        so.ApplyModifiedProperties();

        // ── FriendsManager singleton GO ───────────────────────────────────────
        if (GameObject.Find("FriendsManager") == null)
        {
            var go = new GameObject("FriendsManager");
            go.AddComponent<FriendsManager>();
            Debug.Log("[PludoSetup] Created FriendsManager GO");
        }

        // ── Save ──────────────────────────────────────────────────────────────
        EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        EditorSceneManager.SaveScene(SceneManager.GetActiveScene());
        Debug.Log("[PludoSetup] Done — scene saved.");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    static VisualTreeAsset Load(string path) =>
        AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(path);

    static T EnsureChild<T>(GameObject parent, string childName) where T : MonoBehaviour
    {
        var t = parent.transform.Find(childName);
        GameObject go;
        if (t != null)
        {
            go = t.gameObject;
        }
        else
        {
            go = new GameObject(childName);
            go.transform.SetParent(parent.transform, false);
            Debug.Log($"[PludoSetup] Created {childName}");
        }
        var comp = go.GetComponent<T>();
        if (comp == null)
        {
            comp = go.AddComponent<T>();
            Debug.Log($"[PludoSetup] Added {typeof(T).Name} to {childName}");
        }
        return comp;
    }

    static void SetField(SerializedObject so, string field, Object value)
    {
        var prop = so.FindProperty(field);
        if (prop != null)
            prop.objectReferenceValue = value;
        else
            Debug.LogWarning($"[PludoSetup] Field '{field}' not found on {so.targetObject.GetType().Name}");
    }
}
