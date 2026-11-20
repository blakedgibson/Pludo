using System.Globalization;
using UnityEngine;

// Per-object settings authored in the React editor's Settings (gear) panel.
// React owns the UI state and pushes every change through
// editorSetObjectSetting(name, key, value); EditorCameraController.SetObjectSetting
// routes that to this component on the currently-selected GameObject so the
// values travel with the object (clone, save, etc.).
//
// Most fields are passive storage today — they'll be picked up by the
// runtime as those behaviors land. Invisible is applied live so the user
// immediately sees the result while still in the editor preview.
public class EditorObjectSettings : MonoBehaviour
{
    // ── Destroyable ──────────────────────────────────────────────────────────
    public bool  destroyable;
    public bool  healthRegen;
    public bool  infiniteLives;
    public bool  explode;
    public float healthPoints   = 100f;
    public int   extraLives;

    // ── Invisible ────────────────────────────────────────────────────────────
    public bool  invisible;

    // ── Physics ──────────────────────────────────────────────────────────────
    public bool  physics;
    public float weight = 1f;

    // ── Move ─────────────────────────────────────────────────────────────────
    public bool  move;
    public bool  horizontal;
    public float horizontalSpeed;
    public float horizontalDistance;
    public bool  vertical;
    public float verticalSpeed;
    public float verticalDistance;

    // Cache of the renderers we toggled so flipping Invisible off can restore
    // them without re-walking the hierarchy. Captured on first apply because
    // Renderer hierarchies are stable for a given placed asset.
    private Renderer[] _cachedRends;

    public void Set(string key, string value)
    {
        if (string.IsNullOrEmpty(key)) return;
        switch (key)
        {
            case "destroyable":   destroyable   = ParseBool(value); break;
            case "healthRegen":   healthRegen   = ParseBool(value); break;
            case "infiniteLives": infiniteLives = ParseBool(value); break;
            case "explode":       explode       = ParseBool(value); break;
            case "healthPoints":  healthPoints  = ParseFloat(value, healthPoints); break;
            case "extraLives":    extraLives    = ParseInt(value, extraLives); break;

            case "invisible":
                ApplyInvisible(ParseBool(value));
                break;

            case "physics": physics = ParseBool(value); break;
            case "weight":  weight  = ParseFloat(value, weight); break;

            case "move":               move               = ParseBool(value); break;
            case "horizontal":         horizontal         = ParseBool(value); break;
            case "horizontalSpeed":    horizontalSpeed    = ParseFloat(value, horizontalSpeed); break;
            case "horizontalDistance": horizontalDistance = ParseFloat(value, horizontalDistance); break;
            case "vertical":           vertical           = ParseBool(value); break;
            case "verticalSpeed":      verticalSpeed      = ParseFloat(value, verticalSpeed); break;
            case "verticalDistance":   verticalDistance   = ParseFloat(value, verticalDistance); break;

            default:
                Debug.LogWarning($"[EditorObjectSettings] Unknown setting key '{key}' on '{name}'.");
                break;
        }
    }

    private void ApplyInvisible(bool value)
    {
        if (_cachedRends == null || _cachedRends.Length == 0)
            _cachedRends = GetComponentsInChildren<Renderer>(true);
        foreach (var r in _cachedRends)
        {
            if (r != null) r.enabled = !value;
        }
        invisible = value;
    }

    private static bool ParseBool(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        return s == "true" || s == "1" || s.Equals("yes", System.StringComparison.OrdinalIgnoreCase);
    }
    private static float ParseFloat(string s, float fallback)
    {
        if (string.IsNullOrWhiteSpace(s)) return 0f;
        return float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;
    }
    private static int ParseInt(string s, int fallback)
    {
        if (string.IsNullOrWhiteSpace(s)) return 0;
        return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
    }
}
