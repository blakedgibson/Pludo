using UnityEngine;

// Tags a GameObject the user ADDED in the editor that the Lua `game_code` does
// NOT recreate when the script re-runs (on Play, or on editor reload). Two
// flavours:
//   • Asset-backed  — drag-placed Meshy assets (and duplicates of them): the
//                     {cacheKey, modelUrl, isHumanoid} recipe re-spawns the
//                     exact same model via LuauGameRunner.RespawnEditorAsset.
//   • Clone-of      — a duplicate of a *script-created* object that has no
//                     asset recipe: `cloneOf` names the live object to clone at
//                     restore time (the source is re-created by the script run).
//
// EditorState.Capture records these under the snapshot's `added` array (separate
// from `objects`, which only carries per-object property tweaks for things the
// script already creates). Without this marker, structural additions vanish the
// moment the script re-runs, because EditorState.Apply only restores properties
// of name-matched objects — it never instantiates. Instantiate() copies the
// component, so a duplicate of a placed asset inherits its recipe for free.
public class EditorPlacedObject : MonoBehaviour
{
    public string cacheKey   = "";
    public string modelUrl   = "";
    public bool   isHumanoid;
    public string cloneOf    = "";

    public bool HasAssetRecipe => !string.IsNullOrEmpty(cacheKey);
    public bool HasCloneSource => !string.IsNullOrEmpty(cloneOf);
}
