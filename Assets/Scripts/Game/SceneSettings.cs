using Newtonsoft.Json.Linq;
using UnityEngine;

// Persisted "scene style" settings driven by the editor's Tools → Style and
// Tools → Player panels: skybox, lighting, ground theme, player speed/jump.
// Captured into forge_games.editor_state_json by EditorState and re-applied on
// load/play so the creator's choices survive.
//
// An empty preset string means "leave the default" — a blank baseplate keeps its
// light-blue sky and gray checker ground; a non-empty key overrides it.
public static class SceneSettings
{
    public const float DefaultSpeed = 5f;
    public const float DefaultJump  = 2f;

    public static string Sky            = "";
    public static string Lighting       = "";
    public static string Ground         = "";
    public static float  Speed          = DefaultSpeed;
    public static float  Jump           = DefaultJump;
    // JSON array of HudButton objects authored in the editor Interface panel.
    // Serialized as a raw JSON string so SceneSettings stays dependency-free.
    public static string HudButtonsJson = "";
    // JSON array of IfaceElement objects and JSON array of IfaceWorkflow objects
    // authored in the editor's Interface Builder (Design / Logic tabs). Same
    // raw-string convention as HudButtonsJson.
    public static string InterfaceElementsJson = "";
    public static string InterfaceWorkflowsJson = "";

    public static bool IsDefault =>
        string.IsNullOrEmpty(Sky) && string.IsNullOrEmpty(Lighting) &&
        string.IsNullOrEmpty(Ground) && string.IsNullOrEmpty(HudButtonsJson) &&
        string.IsNullOrEmpty(InterfaceElementsJson) && string.IsNullOrEmpty(InterfaceWorkflowsJson) &&
        Mathf.Approximately(Speed, DefaultSpeed) && Mathf.Approximately(Jump, DefaultJump);

    public static void Reset()
    {
        Sky = ""; Lighting = ""; Ground = "";
        Speed = DefaultSpeed; Jump = DefaultJump;
        HudButtonsJson = "";
        InterfaceElementsJson = "";
        InterfaceWorkflowsJson = "";
    }

    public static JObject ToJson()
    {
        JToken hudButtons;
        try { hudButtons = string.IsNullOrEmpty(HudButtonsJson) ? new JArray() : JArray.Parse(HudButtonsJson); }
        catch { hudButtons = new JArray(); }
        JToken ifaceElements;
        try { ifaceElements = string.IsNullOrEmpty(InterfaceElementsJson) ? new JArray() : JArray.Parse(InterfaceElementsJson); }
        catch { ifaceElements = new JArray(); }
        JToken ifaceWorkflows;
        try { ifaceWorkflows = string.IsNullOrEmpty(InterfaceWorkflowsJson) ? new JArray() : JArray.Parse(InterfaceWorkflowsJson); }
        catch { ifaceWorkflows = new JArray(); }
        return new JObject
        {
            ["sky"]              = Sky,
            ["lighting"]         = Lighting,
            ["ground"]           = Ground,
            ["speed"]            = Speed,
            ["jump"]             = Jump,
            ["hudButtons"]       = hudButtons,
            ["interfaceElements"]  = ifaceElements,
            ["interfaceWorkflows"] = ifaceWorkflows,
        };
    }

    public static void FromJson(JObject o)
    {
        if (o == null) return;
        Sky      = (string)o["sky"]      ?? "";
        Lighting = (string)o["lighting"] ?? "";
        Ground   = (string)o["ground"]   ?? "";
        Speed    = o["speed"] != null && o["speed"].Type != JTokenType.Null ? (float)o["speed"] : DefaultSpeed;
        Jump     = o["jump"]  != null && o["jump"].Type  != JTokenType.Null ? (float)o["jump"]  : DefaultJump;
        var hb   = o["hudButtons"];
        HudButtonsJson = (hb != null && hb.Type != JTokenType.Null && hb.HasValues)
            ? hb.ToString(Newtonsoft.Json.Formatting.None) : "";
        var ie   = o["interfaceElements"];
        InterfaceElementsJson = (ie != null && ie.Type != JTokenType.Null && ie.HasValues)
            ? ie.ToString(Newtonsoft.Json.Formatting.None) : "";
        var iw   = o["interfaceWorkflows"];
        InterfaceWorkflowsJson = (iw != null && iw.Type != JTokenType.Null && iw.HasValues)
            ? iw.ToString(Newtonsoft.Json.Formatting.None) : "";
    }

    // Push the current settings onto the live scene. Safe to call repeatedly.
    // Always applies ALL fields — when a field is the empty-string default, reset
    // to the blank-baseplate default rather than leaving whatever was there before.
    // This matters for undo/redo: reverting to a state where Sky was "" must
    // actually restore the default sky, not leave the previously-set "Space" sky.
    public static void ApplyToScene(LuauGameRunner runner)
    {
        if (!string.IsNullOrEmpty(Sky))      EnvironmentManager.SetSkybox(Sky);
        else                                 EnvironmentManager.SetBaseplateEnvironment();
        if (!string.IsNullOrEmpty(Lighting)) EnvironmentManager.SetLighting(Lighting);
        ApplyGround();
        if (runner != null)
        {
            runner.SetPlayerSpeed(Speed);
            runner.SetPlayerJumpHeight(Jump);
        }
    }

    public static void ApplyGround()
    {
        var tb = TerrainBuilder.Instance;
        if (tb != null) tb.SetGroundTheme(Ground);
    }
}
