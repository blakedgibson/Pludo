using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;

// Runtime-editable heightmap-backed terrain mesh for the editor's Terrain
// Builder mode. Sculpt tools (Raise/Lower/Flatten/Smooth) edit a 129×129 grid
// of heights over a 512×512 m world span (4 m per cell/tile); Paint writes a
// per-vertex color band the URP/Lit shader displays via vertex colors. Brush
// ops accept world (x, z) and a radius in meters; falloff is linear from center
// to edge. A 4 m-thick slab under the surface gives the baseplate edge depth.
[RequireComponent(typeof(MeshFilter), typeof(MeshRenderer), typeof(MeshCollider))]
public class TerrainBuilder : MonoBehaviour
{
    public static TerrainBuilder Instance { get; private set; }

    public enum Tool { None, Raise, Lower, Flatten, Smooth, Paint }
    public Tool ActiveTool { get; private set; } = Tool.None;

    // True once the user has sculpted/painted/reset the terrain (or a saved
    // terrain was restored) in this session. Drives EditorState.Capture: a
    // brand-new game with the default flat baseplate never emits a `terrain`
    // block, keeping the typical snapshot small; once touched it always does so
    // a later flatten/reset still overwrites the previously-saved heightmap.
    public bool Touched { get; private set; }

    // 129×129 verts = 128×128 cells over 512 m → exactly 4 m per cell/tile.
    // Acts as the default playable baseplate for every new game (the Lua scripts
    // are forbidden from creating their own terrain).
    private const int   RES       = 129;
    private const float SIZE      = 512f;
    private const float CELL      = SIZE / (RES - 1);  // = 4 m
    private const float THICKNESS = 4f;                // baseplate slab depth (m)

    // World-space side length of the baseplate (m). Exposed so the editor camera
    // can frame and bound itself to the plate's edges.
    public static float WorldSize => SIZE;

    private float[,]  _height;
    private byte[,]   _paint;
    private Mesh      _mesh;
    private Vector3[] _verts;
    private Vector2[] _uvs;
    private int[]     _tris;
    private Color[]   _colors;

    private MeshFilter   _mf;
    private MeshRenderer _mr;
    private MeshCollider _mc;

    private void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        _mf = GetComponent<MeshFilter>();
        _mr = GetComponent<MeshRenderer>();
        _mc = GetComponent<MeshCollider>();

        // Tag the sculpted mesh as terrain so the shared snap logic
        // (GameAssetLoader.SnapToTerrainIfBelow / EditorCameraController's
        // ResolveTerrainY) recognises this collider as ground. Without it those
        // raycasts skip the editor terrain entirely and fall back to y=0, so a
        // prop dragged onto raised terrain sinks straight into it.
        var marker = GetComponent<MeshyAssetMarker>();
        if (marker == null) marker = gameObject.AddComponent<MeshyAssetMarker>();
        marker.AssetId   = "terrain";
        marker.IsTerrain = true;

        BuildMesh();
    }

    private void OnDestroy() { if (Instance == this) Instance = null; }

    // Lazy create: caller doesn't have to pre-place the GO in the scene. Top-
    // level so it survives game-session TearDowns (LuauGameRunner clears its
    // own gameRoot but never touches "[TerrainBuilder]").
    public static TerrainBuilder EnsureInstance()
    {
        if (Instance != null) return Instance;
        var go = new GameObject("[TerrainBuilder]");
        return go.AddComponent<TerrainBuilder>();
    }

    public void SetTool(string tool)
    {
        switch ((tool ?? "").Trim().ToLower())
        {
            case "raise":   ActiveTool = Tool.Raise;   break;
            case "lower":   ActiveTool = Tool.Lower;   break;
            case "flatten": ActiveTool = Tool.Flatten; break;
            case "smooth":  ActiveTool = Tool.Smooth;  break;
            case "paint":   ActiveTool = Tool.Paint;   break;
            default:        ActiveTool = Tool.None;    break;
        }
    }

    public void Show(bool visible) => gameObject.SetActive(visible);

    // Toggle the baseplate's look between the default greenish ground (used by
    // games that ship/sculpt real terrain) and a Roblox-style gray checkerboard
    // (used for a brand-new blank game). Drives the _Checker* params on the
    // Pludo/TerrainBuilder material; both are no-ops on the URP/Lit fallback.
    private static readonly Color GrassA = new Color(0.22f, 0.40f, 0.16f);
    private static readonly Color GrassB = new Color(0.28f, 0.48f, 0.20f);

    public void SetBaseplateStyle(bool checker)
    {
        if (_mr == null) _mr = GetComponent<MeshRenderer>();
        var mat = _mr != null ? _mr.sharedMaterial : null;
        if (mat == null) return;
        if (checker)
        {
            mat.SetColor("_BaseColor", Color.white);            // checker shows through untinted
            // New games start on a grass baseplate (same tones as the "grass"
            // ground theme, so picking Grass in Style changes nothing).
            mat.SetColor("_CheckerColorA", GrassA);
            mat.SetColor("_CheckerColorB", GrassB);
            mat.SetFloat("_CheckerSize", 4f);   // 4 m × 4 m tiles
            mat.SetFloat("_CheckerStrength", 1f);
        }
        else
        {
            mat.SetColor("_BaseColor", new Color(0.42f, 0.55f, 0.32f)); // default greenish
            mat.SetFloat("_CheckerStrength", 0f);
        }
    }

    // Recolor the checker baseplate to a themed ground (Tools → Style → Textures).
    // Keeps the 4 m checker grid + slab so nothing else in the baseplate system
    // changes — only the two tile colors. "" / "default" restores the grass plate.
    public void SetGroundTheme(string type)
    {
        if (_mr == null) _mr = GetComponent<MeshRenderer>();
        var mat = _mr != null ? _mr.sharedMaterial : null;
        if (mat == null) return;

        Color a, b;
        switch ((type ?? "").Trim().ToLower())
        {
            case "grass":   a = GrassA; b = GrassB; break;
            case "dirt":    a = new Color(0.34f,0.24f,0.14f); b = new Color(0.42f,0.30f,0.18f); break;
            case "sand":    a = new Color(0.74f,0.66f,0.45f); b = new Color(0.82f,0.74f,0.52f); break;
            case "stone":   a = new Color(0.34f,0.34f,0.36f); b = new Color(0.44f,0.44f,0.47f); break;
            case "snow":    a = new Color(0.80f,0.83f,0.88f); b = new Color(0.90f,0.93f,0.97f); break;
            case "wood":    a = new Color(0.42f,0.28f,0.16f); b = new Color(0.50f,0.34f,0.20f); break;
            case "asphalt": a = new Color(0.16f,0.16f,0.18f); b = new Color(0.22f,0.22f,0.24f); break;
            case "gray":    a = new Color(0.20f,0.21f,0.23f); b = new Color(0.31f,0.32f,0.35f); break;
            default:        a = GrassA; b = GrassB; break; // default baseplate is grass
        }
        mat.SetColor("_BaseColor", Color.white);
        mat.SetColor("_CheckerColorA", a);
        mat.SetColor("_CheckerColorB", b);
        mat.SetFloat("_CheckerSize", 4f);
        mat.SetFloat("_CheckerStrength", 1f);
    }

    // markTouched distinguishes a USER reset (the Terrain Builder "reset" button,
    // which must persist so it overwrites a prior sculpt) from the SYSTEM reset
    // LuauGameRunner.LoadAssetsAndRun fires on every load to establish a flat
    // baseline (which must NOT mark the terrain touched, or every game — even
    // ones that never sculpt — would start persisting a 41 KB flat grid).
    public void ResetTerrain(bool markTouched = false)
    {
        if (_height == null) return;
        Array.Clear(_height, 0, _height.Length);
        Array.Clear(_paint,  0, _paint.Length);
        if (markTouched) Touched = true;
        RebuildMesh();
    }

    // ── Editor-state persistence ───────────────────────────────────────────────
    // Compact, self-describing snapshot of the heightmap + paint grid embedded
    // under the `terrain` key of forge_games.editor_state_json. Heights are
    // quantised to millimetres as little-endian Int16 (±32.7 m range, 1 mm
    // resolution) and base64-encoded; paint is one raw byte per vertex. A full
    // 129×129 grid serialises to ~66 KB base64 — well inside the 256 KB editor-
    // state budget, and only present when the terrain was actually edited.
    public string SerializeState()
    {
        if (_height == null || _paint == null) return "";
        int n = RES * RES;
        var hb = new byte[n * 2];
        var pb = new byte[n];
        int hi = 0, pi = 0;
        for (int y = 0; y < RES; y++)
        for (int x = 0; x < RES; x++)
        {
            int mm = Mathf.Clamp(Mathf.RoundToInt(_height[x, y] * 1000f), short.MinValue, short.MaxValue);
            hb[hi++] = (byte)(mm & 0xFF);
            hb[hi++] = (byte)((mm >> 8) & 0xFF);
            pb[pi++] = _paint[x, y];
        }
        var doc = new JObject
        {
            ["res"]     = RES,
            ["heights"] = Convert.ToBase64String(hb),
            ["paint"]   = Convert.ToBase64String(pb),
        };
        return doc.ToString(Formatting.None);
    }

    // Inverse of SerializeState. Restores heights + paint and rebuilds the mesh.
    // Tolerant: a resolution mismatch (e.g. a snapshot from a future RES) or
    // malformed payload is skipped rather than throwing, so an unrecognised
    // schema leaves the terrain at its default flat state instead of breaking
    // the editor reload. Returns true when the grid was applied.
    public bool DeserializeState(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return false;
        if (_height == null) BuildMesh(); // arrays must exist before we fill them
        JObject doc;
        try { doc = JObject.Parse(json); }
        catch (Exception e) { Debug.LogWarning($"[TerrainBuilder] restore: bad JSON: {e.Message}"); return false; }

        int res = (int?)doc["res"] ?? RES;
        if (res != RES)
        {
            Debug.LogWarning($"[TerrainBuilder] restore: resolution mismatch ({res} != {RES}); skipping");
            return false;
        }

        var hStr = (string)doc["heights"];
        if (string.IsNullOrEmpty(hStr)) return false;
        var pStr = (string)doc["paint"];
        byte[] hb, pb;
        try
        {
            hb = Convert.FromBase64String(hStr);
            pb = string.IsNullOrEmpty(pStr) ? new byte[RES * RES] : Convert.FromBase64String(pStr);
        }
        catch (Exception e) { Debug.LogWarning($"[TerrainBuilder] restore: bad base64: {e.Message}"); return false; }
        if (hb.Length < RES * RES * 2) { Debug.LogWarning("[TerrainBuilder] restore: heights truncated"); return false; }

        int hi = 0, pi = 0;
        for (int y = 0; y < RES; y++)
        for (int x = 0; x < RES; x++)
        {
            short mm = (short)(hb[hi] | (hb[hi + 1] << 8));
            hi += 2;
            _height[x, y] = mm / 1000f;
            _paint[x, y]  = pi < pb.Length ? pb[pi] : (byte)0;
            pi++;
        }
        Touched = true;
        RebuildMesh();
        return true;
    }

    // Returns the current heightmap center value — useful for tests that want
    // to assert a brush actually changed something.
    public float SampleHeightAt(float worldX, float worldZ)
    {
        var local = transform.InverseTransformPoint(new Vector3(worldX, 0, worldZ));
        int x = Mathf.Clamp(Mathf.RoundToInt((local.x + SIZE * 0.5f) / CELL), 0, RES - 1);
        int y = Mathf.Clamp(Mathf.RoundToInt((local.z + SIZE * 0.5f) / CELL), 0, RES - 1);
        return _height[x, y];
    }

    public int SamplePaintAt(float worldX, float worldZ)
    {
        var local = transform.InverseTransformPoint(new Vector3(worldX, 0, worldZ));
        int x = Mathf.Clamp(Mathf.RoundToInt((local.x + SIZE * 0.5f) / CELL), 0, RES - 1);
        int y = Mathf.Clamp(Mathf.RoundToInt((local.z + SIZE * 0.5f) / CELL), 0, RES - 1);
        return _paint[x, y];
    }

    // Core brush application. radiusMeters is the brush footprint; strength
    // 0..1 scales the per-stroke effect (Raise/Lower apply strength × 0.5 m
    // peak, Flatten/Smooth lerp toward the target by strength × falloff).
    public void ApplyBrush(float worldX, float worldZ, float radiusMeters, float strength)
    {
        if (ActiveTool == Tool.None) return;
        Touched = true;
        if (radiusMeters < CELL * 0.5f) radiusMeters = CELL * 0.5f;
        strength = Mathf.Clamp01(strength);

        // Snapshot which nearby props are sitting ON the terrain RIGHT NOW, before
        // the switch below rewrites the height grid (CaptureNearbyAssets samples
        // the pre-edit _height). Grounded props will follow the new surface; props
        // the user has lifted off the ground are left floating. Paint never moves
        // the surface, so there's nothing to track for it.
        List<TrackedAsset> tracked = ActiveTool == Tool.Paint
            ? null : CaptureNearbyAssets(worldX, worldZ, radiusMeters);

        var local = transform.InverseTransformPoint(new Vector3(worldX, 0, worldZ));
        float fx = (local.x + SIZE * 0.5f) / CELL;
        float fy = (local.z + SIZE * 0.5f) / CELL;
        int rCells = Mathf.CeilToInt(radiusMeters / CELL);
        int cx = Mathf.RoundToInt(fx);
        int cy = Mathf.RoundToInt(fy);
        int x0 = Mathf.Clamp(cx - rCells, 0, RES - 1);
        int x1 = Mathf.Clamp(cx + rCells, 0, RES - 1);
        int y0 = Mathf.Clamp(cy - rCells, 0, RES - 1);
        int y1 = Mathf.Clamp(cy + rCells, 0, RES - 1);
        float radSq = radiusMeters * radiusMeters;

        switch (ActiveTool)
        {
            case Tool.Raise:
            case Tool.Lower:
            {
                float sign = ActiveTool == Tool.Raise ? 1f : -1f;
                for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float dx = (x - fx) * CELL;
                    float dz = (y - fy) * CELL;
                    float d2 = dx * dx + dz * dz;
                    if (d2 > radSq) continue;
                    float fall = 1f - Mathf.Sqrt(d2) / radiusMeters;
                    // Floor at 0 — the default flat baseplate level. Lowering
                    // can't dig the terrain below the ground plane (no pits /
                    // negative heights); Raise is unaffected (Max keeps it >= 0).
                    _height[x, y] = Mathf.Max(0f, _height[x, y] + sign * strength * fall * 0.5f);
                }
                break;
            }
            case Tool.Flatten:
            {
                float target = SampleHeightCells(cx, cy);
                for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float dx = (x - fx) * CELL;
                    float dz = (y - fy) * CELL;
                    float d2 = dx * dx + dz * dz;
                    if (d2 > radSq) continue;
                    float fall = 1f - Mathf.Sqrt(d2) / radiusMeters;
                    _height[x, y] = Mathf.Lerp(_height[x, y], target, strength * fall);
                }
                break;
            }
            case Tool.Smooth:
            {
                // Snapshot the current heightmap so the 3×3 neighbor average
                // reads pre-stroke values (otherwise diagonal smoothing biases
                // toward whichever cell got written first).
                var src = (float[,])_height.Clone();
                for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float dx = (x - fx) * CELL;
                    float dz = (y - fy) * CELL;
                    float d2 = dx * dx + dz * dz;
                    if (d2 > radSq) continue;
                    float fall = 1f - Mathf.Sqrt(d2) / radiusMeters;
                    float sum = 0f; int n = 0;
                    for (int oy = -1; oy <= 1; oy++)
                    for (int ox = -1; ox <= 1; ox++)
                    {
                        int nx = x + ox, ny = y + oy;
                        if (nx < 0 || ny < 0 || nx >= RES || ny >= RES) continue;
                        sum += src[nx, ny]; n++;
                    }
                    if (n == 0) continue;
                    float avg = sum / n;
                    _height[x, y] = Mathf.Lerp(_height[x, y], avg, strength * fall);
                }
                break;
            }
            case Tool.Paint:
            {
                // Single paint band for now (index 1 = grass-tint). Future
                // versions can route different colors by passing an index in
                // place of strength.
                for (int y = y0; y <= y1; y++)
                for (int x = x0; x <= x1; x++)
                {
                    float dx = (x - fx) * CELL;
                    float dz = (y - fy) * CELL;
                    if (dx * dx + dz * dz > radSq) continue;
                    _paint[x, y] = 1;
                }
                break;
            }
        }

        RebuildMesh();

        // Re-seat the tracked props on the freshly sculpted surface.
        if (tracked != null) AdjustTrackedAssets(tracked);
    }

    // A nearby placed prop plus whether it was resting on the terrain at capture
    // time. Drives AdjustTrackedAssets after the surface changes.
    private struct TrackedAsset { public GameObject go; public bool grounded; }

    // A prop counts as "grounded" if its lowest point is at, below, or just
    // barely above the terrain under its footprint. Anything floating higher than
    // this was deliberately lifted by the user and must not be dragged back down.
    private const float GroundedSnapTolerance = 0.35f;

    // Snapshot nearby non-terrain props and their grounded state using the
    // CURRENT (pre-edit) heightmap. Pivot filter is generous (brush radius +
    // margin) so wide props whose pivot sits just outside the brush still count.
    private List<TrackedAsset> CaptureNearbyAssets(float worldX, float worldZ, float radiusMeters)
    {
        const float footprintMargin = 8f;
        float maxDistSq = (radiusMeters + footprintMargin) * (radiusMeters + footprintMargin);

        var list = new List<TrackedAsset>();
        var markers = UnityEngine.Object.FindObjectsByType<MeshyAssetMarker>(FindObjectsSortMode.None);
        foreach (var m in markers)
        {
            if (m == null || m.IsTerrain) continue;
            var p = m.transform.position;
            float dx = p.x - worldX, dz = p.z - worldZ;
            if (dx * dx + dz * dz > maxDistSq) continue;
            if (!TryGetWorldBox(m.gameObject, out var box)) continue;

            float terrainOld = MaxTerrainUnderBox(box);
            bool grounded = (box.min.y - terrainOld) <= GroundedSnapTolerance;
            list.Add(new TrackedAsset { go = m.gameObject, grounded = grounded });
        }
        return list;
    }

    // After the surface moved: grounded props track it in BOTH directions (rise
    // with raised ground, settle with lowered ground); lifted/floating props keep
    // their height and are only nudged up if the new surface would bury them.
    private void AdjustTrackedAssets(List<TrackedAsset> tracked)
    {
        const float eps = 0.001f;
        foreach (var a in tracked)
        {
            if (a.go == null) continue;
            if (!TryGetWorldBox(a.go, out var box)) continue;

            float terrainNew = MaxTerrainUnderBox(box);
            float bottom = box.min.y;

            if (a.grounded)
            {
                float delta = terrainNew - bottom; // follow up or down
                if (Mathf.Abs(delta) > eps)
                    a.go.transform.position += new Vector3(0f, delta, 0f);
            }
            else if (bottom < terrainNew - eps)
            {
                a.go.transform.position += new Vector3(0f, terrainNew - bottom, 0f);
            }
        }
    }

    // World-space AABB of a prop's active renderers. False when it has none.
    private static bool TryGetWorldBox(GameObject go, out Bounds box)
    {
        box = default;
        bool first = true;
        foreach (var r in go.GetComponentsInChildren<Renderer>(false))
        {
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { box = r.bounds; first = false; }
            else        box.Encapsulate(r.bounds);
        }
        return !first;
    }

    // Highest terrain height sampled across a 3×3 grid over the box's XZ
    // footprint, so a prop straddling a slope is seated on the tallest point it
    // covers (never poking a corner into a hill).
    private float MaxTerrainUnderBox(Bounds box)
    {
        float top = float.MinValue;
        for (int iz = 0; iz <= 2; iz++)
        for (int ix = 0; ix <= 2; ix++)
        {
            float sx = Mathf.Lerp(box.min.x, box.max.x, ix * 0.5f);
            float sz = Mathf.Lerp(box.min.z, box.max.z, iz * 0.5f);
            float h  = SampleHeightAt(sx, sz);
            if (h > top) top = h;
        }
        return top;
    }

    private float SampleHeightCells(int cx, int cy)
    {
        cx = Mathf.Clamp(cx, 0, RES - 1);
        cy = Mathf.Clamp(cy, 0, RES - 1);
        return _height[cx, cy];
    }

    private void BuildMesh()
    {
        _height = new float[RES, RES];
        _paint  = new byte[RES, RES];
        _verts  = new Vector3[RES * RES];
        _uvs    = new Vector2[RES * RES];
        _colors = new Color[RES * RES];
        _tris   = new int[(RES - 1) * (RES - 1) * 6];

        for (int y = 0; y < RES; y++)
        for (int x = 0; x < RES; x++)
        {
            int i = y * RES + x;
            _verts[i]  = new Vector3(x * CELL - SIZE * 0.5f, 0f, y * CELL - SIZE * 0.5f);
            _uvs[i]    = new Vector2((float)x / (RES - 1), (float)y / (RES - 1));
            _colors[i] = Color.white;
        }

        int t = 0;
        for (int y = 0; y < RES - 1; y++)
        for (int x = 0; x < RES - 1; x++)
        {
            int i = y * RES + x;
            _tris[t++] = i;
            _tris[t++] = i + RES;
            _tris[t++] = i + 1;
            _tris[t++] = i + 1;
            _tris[t++] = i + RES;
            _tris[t++] = i + RES + 1;
        }

        _mesh = new Mesh { name = "TerrainBuilderMesh", indexFormat = IndexFormat.UInt32 };
        _mesh.vertices  = _verts;
        _mesh.uv        = _uvs;
        _mesh.triangles = _tris;
        _mesh.colors    = _colors;
        _mesh.RecalculateNormals();
        _mesh.RecalculateBounds();
        _mf.sharedMesh = _mesh;
        _mc.sharedMesh = _mesh;

        if (_mr.sharedMaterial == null)
        {
            // Lit shader so the terrain receives shadows cast by props /
            // characters, casts its own shadow, and self-shades — sculpted
            // slopes now read darker/lighter than flat regions because lighting
            // responds to the recomputed per-vertex normals. Pludo/TerrainBuilder
            // also tints by the vertex-color paint band. Fallback chain covers
            // the unlikely case where the custom shader was stripped from a build.
            var shader = Shader.Find("Pludo/TerrainBuilder")
                      ?? Shader.Find("Universal Render Pipeline/Lit")
                      ?? Shader.Find("Standard");
            var mat = new Material(shader);
            var c = new Color(0.42f, 0.55f, 0.32f);
            mat.SetColor("_BaseColor", c); // Pludo/TerrainBuilder + URP/Lit
            mat.SetColor("_Color",     c); // legacy fallback
            _mr.sharedMaterial = mat;
        }

        EnsureSlab();
    }

    // A solid 1 m-thick slab sitting just under the sculptable surface so the
    // baseplate has visible edge depth (like the Roblox baseplate) instead of
    // reading as an infinitely-thin sheet. It's a child of the terrain GO (so it
    // moves, hides and tears down with it) and shares the terrain material, so
    // the checker / greenish look applies to its top + sides automatically. Its
    // top sits 5 mm below the surface to avoid z-fighting with the heightmap.
    private void EnsureSlab()
    {
        if (transform.Find("[BaseplateSlab]") != null) return;

        var slab = GameObject.CreatePrimitive(PrimitiveType.Cube);
        slab.name = "[BaseplateSlab]";
        slab.transform.SetParent(transform, false);
        slab.transform.localPosition = new Vector3(0f, -THICKNESS * 0.5f - 0.005f, 0f);
        slab.transform.localScale    = new Vector3(SIZE, THICKNESS, SIZE);

        // The heightmap mesh collider is the ground the player stands on; the
        // slab is purely visual, so disable its box collider to avoid a second
        // surface at the same height.
        var col = slab.GetComponent<Collider>();
        if (col != null) col.enabled = false;

        slab.GetComponent<MeshRenderer>().sharedMaterial = _mr.sharedMaterial;
    }

    private void RebuildMesh()
    {
        for (int y = 0; y < RES; y++)
        for (int x = 0; x < RES; x++)
        {
            int i = y * RES + x;
            _verts[i].y = _height[x, y];
            _colors[i]  = _paint[x, y] == 0
                ? new Color(1f, 1f, 1f, 1f)
                : new Color(0.72f, 1.00f, 0.55f, 1f); // grass tint
        }
        _mesh.vertices = _verts;
        _mesh.colors   = _colors;
        _mesh.RecalculateNormals();
        _mesh.RecalculateBounds();
        // Mesh-collider must be reassigned for the new vertex data to take
        // effect on raycasts (assigning the same Mesh is a no-op).
        _mc.sharedMesh = null;
        _mc.sharedMesh = _mesh;
    }
}
