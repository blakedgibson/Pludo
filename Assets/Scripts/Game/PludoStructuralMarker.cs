using UnityEngine;

// Tag component attached to GameObjects spawned for server-side Structure.*
// entities (those with `structural: true` in the EntityState diff). Used by
// GameRenderClient to:
//   • Release the primitive-visibility lock so procedural ground/walls/ramps
//     actually render (default for primitives is renderer-disabled to keep
//     stray cubes from leaking into gameplay).
//   • Identify which entities should receive the Pludo/Terrain PBR shader
//     when `structureMaterial` or `terrainLayers` arrives in the diff.
// No fields — the component's presence is the signal.
public class PludoStructuralMarker : MonoBehaviour { }
