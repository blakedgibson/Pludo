using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;
using GLTFast;
using Newtonsoft.Json;

// Downloads Meshy-generated GLB models from R2/CDN URLs and instantiates them in the scene.
// Models are cached in memory so repeated Object.Create("model:<id>") calls are cheap.
//
// Usage:
//   yield return loader.LoadAssets(assetUrlsJson);   // pre-load before running Luau script
//   var go = loader.Spawn("dragon", parent);          // instantiate a loaded model
public class GameAssetLoader : MonoBehaviour
{
    // Root → list of top-level GOs produced by GLTFast instantiation for that asset id.
    private readonly Dictionary<string, List<GameObject>> _templates = new();
    private readonly Dictionary<string, bool> _humanoid = new();
    // Per-id real-world target size in meters (longest dim for props, height for humanoids).
    // Populated from sizeHintsJson passed to LoadAssets / EnsureLoaded.
    private readonly Dictionary<string, float> _sizeHints = new();
    // Per-id auto-yaw recorded at load time. Spawn() copies this onto every
    // MeshyAssetMarker so the rotation pipeline can cancel the bake-in.
    private readonly Dictionary<string, float> _yawCorrection = new();

    // Per-asset Y-rotation correction (degrees) applied at load time. Meshy AI exports
    // models inconsistently: humanoids reliably face -Z (so 180° flips them to Unity's
    // +Z forward), while props can face any direction. Server manifests may supply
    // explicit yaw overrides via LoadAssets(orientationJson). Hardcoded entries below
    // patch known-broken bundled assets so they face +Z without server changes.
    private static readonly Dictionary<string, float> AssetYawOverrides = new()
    {
        // Plants-vs-Zombies style props that ship with the demo game. Add new
        // entries here when a Meshy export's "front" axis is not +Z.
        // Verified against in-editor "Front" view screenshots in May 2026.
        { "lawnmower",  90f },  // handle axis on X → rotate to align cutting deck with +Z
        { "peashooter", -90f }, // cannon at +X (peashooter's "shooting" direction) → -90° aligns it with +Z
    };

    // True once LoadAssets has finished iterating every URL in the manifest. Read by the
    // thumbnail flow to defer the "final" capture until Meshy-loaded models are present.
    public bool IsLoadingComplete { get; private set; }

    // Pre-load all assets declared in the assetUrlsJson map.
    // assetUrlsJson:    {"dragon":"https://...","guard":"https://...",...}
    // humanoidIdsJson:  ["dragon","guard"]   (subset of asset ids whose models are rigged)
    // orientationJson:  {"dragon":180,"guard":90}   (optional per-asset yaw override in degrees)
    // sizeHintsJson:    {"dragon":3.5,"guard":1.8}  (real-world target size in meters per asset)
    public IEnumerator LoadAssets(string assetUrlsJson, string humanoidIdsJson = null,
        string orientationJson = null, string sizeHintsJson = null)
    {
        IsLoadingComplete = false;

        if (string.IsNullOrEmpty(assetUrlsJson) || assetUrlsJson == "{}")
        {
            IsLoadingComplete = true;
            yield break;
        }

        Dictionary<string, string> urls;
        try { urls = JsonConvert.DeserializeObject<Dictionary<string, string>>(assetUrlsJson); }
        catch (Exception e)
        {
            Debug.LogWarning($"[GameAssetLoader] Cannot parse assetUrlsJson: {e.Message}");
            IsLoadingComplete = true;
            yield break;
        }

        HashSet<string> humanoidIds = new();
        if (!string.IsNullOrEmpty(humanoidIdsJson))
        {
            try { humanoidIds = new HashSet<string>(JsonConvert.DeserializeObject<List<string>>(humanoidIdsJson)); }
            catch { }
        }

        Dictionary<string, float> serverYaw = null;
        if (!string.IsNullOrEmpty(orientationJson) && orientationJson != "{}")
        {
            try { serverYaw = JsonConvert.DeserializeObject<Dictionary<string, float>>(orientationJson); }
            catch (Exception e) { Debug.LogWarning($"[GameAssetLoader] Cannot parse orientationJson: {e.Message}"); }
        }

        if (!string.IsNullOrEmpty(sizeHintsJson) && sizeHintsJson != "{}")
        {
            try
            {
                var hints = JsonConvert.DeserializeObject<Dictionary<string, float>>(sizeHintsJson);
                foreach (var kv in hints) _sizeHints[kv.Key] = kv.Value;
            }
            catch (Exception e) { Debug.LogWarning($"[GameAssetLoader] Cannot parse sizeHintsJson: {e.Message}"); }
        }

        foreach (var (id, url) in urls)
        {
            if (string.IsNullOrEmpty(url)) continue;
            _humanoid[id] = humanoidIds.Contains(id);
            float yaw = ResolveYawCorrection(id, _humanoid[id], serverYaw);
            _yawCorrection[id] = yaw;
            float sizeHint = _sizeHints.TryGetValue(id, out var sh) ? sh : 0f;
            yield return LoadOne(id, url, _humanoid[id], yaw, sizeHint);
        }

        IsLoadingComplete = true;
    }

    // Determines the Y-rotation correction for an asset.
    //   1. Server-supplied per-asset yaw wins (most authoritative).
    //   2. Hardcoded AssetYawOverrides patches known-broken bundled assets.
    //   3. Terrain tiles stay at 0° — they're symmetrical and tiled in a grid;
    //      flipping them shifts the seams by half a tile.
    //   4. All other Meshy text-to-3D exports (humanoid OR prop) default to 180°.
    //      The Meshy renderer's "front" view shoots the camera down -Z, so the
    //      generated mesh's "front" face points toward -Z. Without this flip,
    //      models read as turned around in Unity (which uses +Z = forward).
    private static float ResolveYawCorrection(string id, bool isHumanoid, Dictionary<string, float> serverYaw)
    {
        if (serverYaw != null && serverYaw.TryGetValue(id, out var s)) return s;
        if (AssetYawOverrides.TryGetValue(id, out var o))               return o;
        if (id == "terrain")                                            return 0f;
        return 180f;
    }

    // Idempotently load a single asset (cache key → URL). Used by the editor
    // drag-and-drop flow where the user picks one Meshy model out of the Assets
    // picker and drops it into the live preview scene. Subsequent calls with
    // the same id are a no-op so repeated drops never re-download.
    // sizeHint: real-world target size in meters (0 = use default 1.5m).
    public IEnumerator EnsureLoaded(string id, string url, bool isHumanoid, float sizeHint = 0f)
    {
        if (_templates.ContainsKey(id)) yield break;
        _humanoid[id] = isHumanoid;
        if (sizeHint > 0f) _sizeHints[id] = sizeHint;
        float yaw = ResolveYawCorrection(id, isHumanoid, null);
        _yawCorrection[id] = yaw;
        float hint = _sizeHints.TryGetValue(id, out var sh) ? sh : 0f;
        yield return LoadOne(id, url, isHumanoid, yaw, hint);
    }

    // True once at least one template root has been registered under `id`.
    public bool HasAsset(string id) => _templates.ContainsKey(id);

    // Instantiate a previously loaded model. Returns null if the model wasn't loaded.
    public GameObject Spawn(string id, Transform parent)
    {
        if (!_templates.TryGetValue(id, out var roots) || roots.Count == 0)
        {
            Debug.LogWarning($"[GameAssetLoader] Asset '{id}' not loaded — using capsule fallback");
            return null;
        }

        var container = new GameObject($"Model_{id}");
        container.transform.SetParent(parent, false);

        foreach (var template in roots)
        {
            var copy = Instantiate(template, container.transform);
            copy.transform.localPosition = template.transform.localPosition;
            copy.transform.localRotation = template.transform.localRotation;
            copy.transform.localScale    = template.transform.localScale;
            copy.SetActive(true);
        }

        // Tag the container so the runtime can identify spawned Meshy models —
        // needed by the auto-snap-to-terrain logic in LuaObject.SetPosition and
        // the swap-retry path in LuauGameRunner. YawCorrection lets the
        // server-authoritative rotation pipeline cancel the baked auto-yaw so
        // SetRotation/LookAt produce the visual rotation the script asked for.
        var marker        = container.AddComponent<MeshyAssetMarker>();
        marker.AssetId    = id;
        marker.IsTerrain  = (id == "terrain");
        marker.YawCorrection = _yawCorrection.TryGetValue(id, out var y) ? y : 0f;

        // Rigged humanoids get a walk/idle animator
        if (_humanoid.TryGetValue(id, out var isHumanoid) && isHumanoid)
            TryAttachAnimator(container);

        return container;
    }

    // ── Terrain snap helper ────────────────────────────────────────────────────
    //
    // Lifts a Meshy prop's Y so its bottom sits ON TOP of the terrain whenever
    // the requested position would clip into the terrain mesh. Terrain tiles
    // (MeshyAssetMarker.IsTerrain == true) are skipped — they belong at Y = 0.
    //
    // Called from LuaObject.SetPosition (so every Lua-driven move snaps) and
    // from LuauGameRunner's asset-swap retry coroutine (so a placeholder cube
    // snaps to terrain once the real GLB swaps in).
    public static void SnapToTerrainIfBelow(GameObject go)
    {
        if (go == null) return;

        var marker = go.GetComponent<MeshyAssetMarker>();
        if (marker == null || marker.IsTerrain) return;

        // Compute the world-space AABB of the model's renderers. We use whatever
        // is currently active in the hierarchy — for a freshly-swapped placeholder
        // this is the real GLB's renderers; for a direct Spawn this is the prop.
        var rends = go.GetComponentsInChildren<Renderer>(false);
        if (rends.Length == 0) return;

        bool first = true;
        Bounds modelBounds = default;
        foreach (var r in rends)
        {
            // Skip renderers with zero bounds (mesh data not yet assigned)
            if (r.bounds.size.sqrMagnitude < 0.0001f) continue;
            if (first) { modelBounds = r.bounds; first = false; }
            else        modelBounds.Encapsulate(r.bounds);
        }
        if (first) return;

        // Sample the terrain under the model's whole XZ footprint, not just the
        // pivot column. A wide prop straddling a slope (or sitting on terrain the
        // user just sculpted upward) can have its pivot clear while a corner pokes
        // into a hill — so we take the HIGHEST terrain point found anywhere under
        // the footprint and lift the bottom above that. A 3×3 grid plus the center
        // (sampled at the AABB edges) is enough to catch slope intrusions cheaply.
        var pos = go.transform.position;
        float terrainY = float.MinValue;
        for (int iz = 0; iz <= 2; iz++)
        for (int ix = 0; ix <= 2; ix++)
        {
            float sx = Mathf.Lerp(modelBounds.min.x, modelBounds.max.x, ix * 0.5f);
            float sz = Mathf.Lerp(modelBounds.min.z, modelBounds.max.z, iz * 0.5f);
            float y = SampleTerrainTop(sx, sz, go);
            if (y > terrainY) terrainY = y;
        }
        if (terrainY == float.MinValue) return; // no terrain under this footprint

        if (modelBounds.min.y < terrainY - 0.001f)
        {
            float lift = terrainY - modelBounds.min.y;
            go.transform.position = new Vector3(pos.x, pos.y + lift, pos.z);
        }
    }

    // Highest terrain surface Y directly below (x, z), ignoring colliders that
    // belong to `ignore`. Returns float.MinValue when no terrain tile is hit.
    private static float SampleTerrainTop(float x, float z, GameObject ignore)
    {
        var rayOrigin = new Vector3(x, 500f, z);
        var hits = Physics.RaycastAll(rayOrigin, Vector3.down, 1000f, ~0, QueryTriggerInteraction.Ignore);

        float top = float.MinValue;
        foreach (var hit in hits)
        {
            if (hit.collider == null) continue;
            if (ignore != null && hit.collider.transform.IsChildOf(ignore.transform)) continue;

            var hitMarker = hit.collider.GetComponentInParent<MeshyAssetMarker>();
            if (hitMarker == null || !hitMarker.IsTerrain) continue;
            if (hit.point.y > top) top = hit.point.y;
        }
        return top;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    // Local file path for an asset's cached GLB bytes. The id (e.g.
    // "game-assets/v1/<hash>.glb") is flattened into a single filename. Returns
    // null if the cache dir can't be prepared (caller then just skips caching).
    private static string GlbCachePath(string id)
    {
        if (string.IsNullOrEmpty(id)) return null;
        try
        {
            var dir = Path.Combine(Application.persistentDataPath, "glbcache");
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var safe = id.Replace('/', '_').Replace('\\', '_');
            return Path.Combine(dir, safe);
        }
        catch { return null; }
    }

    private IEnumerator LoadOne(string id, string url, bool isHumanoid, float yawCorrection = 0f, float sizeHint = 0f)
    {
        // Resolve relative API paths against PludoApiClient.BaseUrl so they work
        // regardless of whether the client is on device, simulator, or the editor.
        if (url.StartsWith("/"))
            url = PludoApiClient.BaseUrl.TrimEnd('/') + url;

        // Retry up to 3× with exponential backoff (2s, 4s) on transient failures
        // (HTTP 5xx, network drops, GLTFast parse errors). Permanent 404s still
        // fail fast. Without this, a single CDN hiccup at game launch produces
        // a placeholder cube for the rest of the session.
        const int MaxAttempts = 3;
        byte[] bytes = null;

        // Disk cache: Meshy GLBs are content-addressed (the id IS the file hash),
        // so a model never changes once fetched. Reading it from local disk on the
        // next editor reopen avoids a fresh network round-trip per placed asset —
        // the difference between a reopen that snaps in instantly and one that
        // looks empty for several seconds while every model re-downloads.
        string cachePath = GlbCachePath(id);
        bool fromCache = false;
        if (cachePath != null && File.Exists(cachePath))
        {
            try
            {
                var cached = File.ReadAllBytes(cachePath);
                if (cached != null && cached.Length > 0)
                {
                    bytes = cached;
                    fromCache = true;
                    Debug.Log($"[GameAssetLoader] '{id}' loaded from disk cache ({bytes.Length} bytes)");
                }
            }
            catch (Exception e) { Debug.LogWarning($"[GameAssetLoader] cache read failed for '{id}': {e.Message}"); }
        }

        for (int attempt = 1; bytes == null && attempt <= MaxAttempts; attempt++)
        {
            Debug.Log($"[GameAssetLoader] Downloading '{id}' (attempt {attempt}/{MaxAttempts}) from {url}");
            using var req = UnityWebRequest.Get(url);
            req.downloadHandler = new DownloadHandlerBuffer();
            yield return req.SendWebRequest();

            // Hard-fail on 4xx other than 408/429 — those won't get better.
            if (req.responseCode >= 400 && req.responseCode < 500
                && req.responseCode != 408 && req.responseCode != 429)
            {
                Debug.LogWarning($"[GameAssetLoader] '{id}' HTTP {req.responseCode} — non-retryable, giving up");
                yield break;
            }

            if (req.result == UnityWebRequest.Result.Success)
            {
                bytes = req.downloadHandler.data;
                if (bytes != null && bytes.Length > 0) break;
                Debug.LogWarning($"[GameAssetLoader] '{id}' empty body on attempt {attempt}");
            }
            else
            {
                Debug.LogWarning($"[GameAssetLoader] '{id}' download failed on attempt {attempt}: {req.error}");
            }

            if (attempt < MaxAttempts)
            {
                int delayMs = 2000 * attempt; // 2s, 4s
                yield return new WaitForSecondsRealtime(delayMs / 1000f);
            }
        }
        if (bytes == null || bytes.Length == 0)
        {
            Debug.LogError($"[GameAssetLoader] '{id}' failed all {MaxAttempts} download attempts — Object.Create will use a placeholder cube");
            yield break;
        }

        // Persist a freshly-downloaded GLB so future reopens read it from disk.
        if (!fromCache && cachePath != null)
        {
            try { File.WriteAllBytes(cachePath, bytes); }
            catch (Exception e) { Debug.LogWarning($"[GameAssetLoader] cache write failed for '{id}': {e.Message}"); }
        }

        // Parse the GLB using GLTFast
        var gltf = new GltfImport();
        var loadTask = gltf.Load(bytes, new Uri(url));
        yield return new WaitUntil(() => loadTask.IsCompleted);

        if (!loadTask.Result)
        {
            Debug.LogWarning($"[GameAssetLoader] GLTFast parse failed for '{id}'");
            yield break;
        }

        // Instantiate into an off-screen staging area at a position cameras can't see.
        // Keep it active during instantiation so GLTFast can initialize renderers and
        // world-space bounds are valid for scale normalization.
        var staging = new GameObject($"[AssetTemplate_{id}]");
        staging.transform.position = new Vector3(0f, -1000f, 0f);

        var instTask = gltf.InstantiateMainSceneAsync(staging.transform);
        yield return new WaitUntil(() => instTask.IsCompleted);

        // Collect the instantiated root children as the template set
        var roots = new List<GameObject>();
        for (int i = 0; i < staging.transform.childCount; i++)
            roots.Add(staging.transform.GetChild(i).gameObject);

        if (roots.Count == 0)
        {
            Debug.LogWarning($"[GameAssetLoader] GLTFast produced no scene objects for '{id}'");
            Destroy(staging);
            yield break;
        }

        // Convert any Standard (built-in) shaders to URP/Lit so models don't appear
        // white/untextured in a URP project. GLTFast 6.x handles URP automatically for
        // GLB PBR materials, but some exports include Standard-shader overrides.
        ConvertMaterialsToURP(staging);

        // Wait for mesh data to be fully assigned to renderers before reading
        // bounds. GLTFast's InstantiateMainSceneAsync resolves before Unity has
        // necessarily ticked the renderers and finished any shader-variant
        // compilation that the meshes depend on, so on a cold first-join
        // mf.sharedMesh / smr.sharedMesh can still be null or report (0,0,0)
        // bounds. If we proceed with a single yielded frame, NormalizeScale's
        // maxDim check fails, the early-return fires, and the template stays at
        // GLTFast's raw (often tiny) scale — the entire scene then reads as
        // models clustered at the origin because they're scaled to ~0. Second
        // joins worked because Unity's shader/material caches were warm and one
        // frame was enough. Poll up to ~30 frames (≈0.5 s at 60fps) and stop as
        // soon as any mesh reports a non-zero bounds size.
        const int MaxBoundsWaitFrames = 30;
        bool boundsReady = false;
        for (int frame = 0; frame < MaxBoundsWaitFrames; frame++)
        {
            yield return new WaitForEndOfFrame();
            if (HasValidMeshBounds(staging)) { boundsReady = true; break; }
        }
        if (!boundsReady)
        {
            Debug.LogWarning($"[GameAssetLoader] '{id}' mesh bounds still invalid after {MaxBoundsWaitFrames} frames — model may be incorrectly scaled.");
        }

        // Normalize scale so models have a predictable size in the game world.
        // Terrain tiles target 12 m (matches the per-tile cell size used in Lua templates).
        // Humanoids target 2 m TALL (Y axis specifically) so a zombie or character
        // is always 2 m regardless of how wide its arms or weapons extend.
        // Without the height-only mode, a zombie with arms outstretched 2.5 m wide
        // and 1.4 m tall would normalize against maxDim=2.5, leaving it at 1.12 m
        // tall — visibly squished. Non-humanoid props still target 1.5 m max
        // dimension because their orientation is unpredictable (a sword is long,
        // a tree is tall, a chest is wide — there's no canonical "up").
        // Use caller-supplied real-world size if provided; fall back to defaults.
        // Humanoids: target = height (Y axis). Props: target = longest dimension.
        float normTarget = id == "terrain" ? 12f
            : sizeHint > 0f ? sizeHint
            : isHumanoid    ? 2.0f
            : 1.5f;
        NormalizeScale(staging, normTarget, useHeightOnly: isHumanoid);

        // Apply Y-rotation correction so the model's "front" lines up with Unity's
        // +Z forward axis. Done after scale normalization (which uses world bounds)
        // and before SetActive(false) (so the rotation is baked into the template
        // and every Spawn() copy inherits it via localRotation).
        ApplyYawCorrection(roots, yawCorrection, id);

        // Add MeshColliders so terrain surfaces and props block physics objects.
        // GLTFast does not create collision geometry — without this, the player falls through.
        foreach (var mf in staging.GetComponentsInChildren<MeshFilter>())
        {
            if (mf.sharedMesh != null && mf.GetComponent<Collider>() == null)
            {
                var mc = mf.gameObject.AddComponent<MeshCollider>();
                mc.sharedMesh = mf.sharedMesh;
            }
        }

        // Hide staging — templates must not be rendered while stored
        staging.SetActive(false);

        _templates[id] = roots;
        // Staging container kept alive (hidden) so templates aren't GC'd
        DontDestroyOnLoad(staging);

        Debug.Log($"[GameAssetLoader] Loaded '{id}' ({roots.Count} root(s), humanoid={isHumanoid})");
    }

    // Walks all renderers in the hierarchy and replaces any Standard shader materials
    // with URP/Lit equivalents, copying albedo/metallic/smoothness so models aren't white.
    private static void ConvertMaterialsToURP(GameObject root)
    {
        var urpShader = Shader.Find("Universal Render Pipeline/Lit");
        if (urpShader == null) return; // not a URP project — no conversion needed

        foreach (var renderer in root.GetComponentsInChildren<Renderer>())
        {
            var mats = renderer.sharedMaterials;
            bool changed = false;
            for (int i = 0; i < mats.Length; i++)
            {
                var m = mats[i];
                if (m == null) continue;
                if (m.shader != null && m.shader.name.Contains("Standard"))
                {
                    var urpMat = new Material(urpShader);
                    // Copy the most common PBR properties
                    if (m.HasProperty("_Color"))
                        urpMat.SetColor("_BaseColor", m.GetColor("_Color"));
                    if (m.HasProperty("_MainTex") && m.GetTexture("_MainTex") != null)
                    {
                        urpMat.SetTexture("_BaseMap", m.GetTexture("_MainTex"));
                        urpMat.SetTextureScale("_BaseMap", m.GetTextureScale("_MainTex"));
                        urpMat.SetTextureOffset("_BaseMap", m.GetTextureOffset("_MainTex"));
                    }
                    if (m.HasProperty("_Metallic"))
                        urpMat.SetFloat("_Metallic", m.GetFloat("_Metallic"));
                    if (m.HasProperty("_Glossiness"))
                        urpMat.SetFloat("_Smoothness", m.GetFloat("_Glossiness"));
                    if (m.HasProperty("_BumpMap") && m.GetTexture("_BumpMap") != null)
                        urpMat.SetTexture("_BumpMap", m.GetTexture("_BumpMap"));
                    mats[i] = urpMat;
                    changed  = true;
                }
            }
            if (changed) renderer.sharedMaterials = mats;
        }
    }

    // Rotates each top-level GLB root around Y so the model's "front" axis lines
    // up with Unity's +Z forward. Both rotation and position are pre-multiplied
    // because GLTFast may emit non-zero localPositions for the root nodes; rotating
    // only the rotation would translate asymmetric models off the staging origin.
    private static void ApplyYawCorrection(List<GameObject> roots, float yawDegrees, string id)
    {
        if (Mathf.Approximately(yawDegrees, 0f)) return;
        var rot = Quaternion.Euler(0f, yawDegrees, 0f);
        foreach (var root in roots)
        {
            root.transform.localRotation = rot * root.transform.localRotation;
            root.transform.localPosition = rot * root.transform.localPosition;
        }
        Debug.Log($"[GameAssetLoader] Applied {yawDegrees:F0}° yaw correction to '{id}'");
    }

    // Returns true if any MeshFilter or SkinnedMeshRenderer in the hierarchy
    // has a sharedMesh with non-zero bounds. Used by LoadOne to decide whether
    // GLTFast has finished assigning mesh data before NormalizeScale runs.
    private static bool HasValidMeshBounds(GameObject root)
    {
        foreach (var mf in root.GetComponentsInChildren<MeshFilter>())
        {
            if (mf.sharedMesh == null) continue;
            var b = mf.sharedMesh.bounds;
            if (b.size.x > 0.0001f || b.size.y > 0.0001f || b.size.z > 0.0001f) return true;
        }
        foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>())
        {
            if (smr.sharedMesh == null) continue;
            var b = smr.sharedMesh.bounds;
            if (b.size.x > 0.0001f || b.size.y > 0.0001f || b.size.z > 0.0001f) return true;
        }
        return false;
    }

    private static void NormalizeScale(GameObject root, float targetSize, bool useHeightOnly = false)
    {
        // We read bounds from Mesh.bounds (vertex-space, deterministic the moment
        // the mesh asset is assigned to the renderer) and transform the 8 corners
        // into world space ourselves. This sidesteps Renderer.bounds, which can
        // return (0,0,0) or stale values for SkinnedMeshRenderer instances that
        // haven't been ticked by Unity yet — the original cause of the
        // "small-terrain-on-first-join" bug.
        Bounds combined = default;
        bool first = true;

        foreach (var mf in root.GetComponentsInChildren<MeshFilter>())
        {
            if (mf.sharedMesh == null) continue;
            var w = TransformLocalBoundsToWorld(mf.transform, mf.sharedMesh.bounds);
            if (first) { combined = w; first = false; }
            else combined.Encapsulate(w);
        }
        foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>())
        {
            if (smr.sharedMesh == null) continue;
            var w = TransformLocalBoundsToWorld(smr.transform, smr.sharedMesh.bounds);
            if (first) { combined = w; first = false; }
            else combined.Encapsulate(w);
        }
        if (first) return; // no meshes

        // For humanoids we lock the reference axis to HEIGHT (Y). Meshy frequently
        // returns characters posed in T-stance with arms wider than the body is
        // tall — using maxDim picks the arm-span as the reference and the avatar
        // scales down to a squat 1.1 m. Locking on Y guarantees a 2 m-tall
        // character every time, with arms allowed to extend wider naturally.
        // For everything else, use maxDim so a long sword or wide chest still
        // fits the world without distorting its aspect.
        float refDim = useHeightOnly
            ? combined.size.y
            : Mathf.Max(combined.size.x, combined.size.y, combined.size.z);
        if (refDim < 0.001f)
        {
            // Bounds still unavailable even after the LoadOne polling loop.
            // Falling back to "no scaling" used to be a silent skip, which is
            // exactly what produced the "first-join condensed at the middle"
            // bug — templates stayed at GLTFast's raw scale (often << 1 m) and
            // every spawned model collapsed to a near-invisible dot at its
            // entity position, creating the visual impression that everything
            // was clustered at the origin. Apply a conservative default scale
            // so models are at least visible at roughly the intended size.
            Debug.LogWarning($"[GameAssetLoader] NormalizeScale: bounds unavailable (refDim={refDim:F4}) — applying default ×{targetSize:F1} fallback scale.");
            for (int i = 0; i < root.transform.childCount; i++)
                root.transform.GetChild(i).localScale *= targetSize;
            return;
        }

        float s = targetSize / refDim;
        for (int i = 0; i < root.transform.childCount; i++)
            root.transform.GetChild(i).localScale *= s;

        var axis = useHeightOnly ? "height" : "maxDim";
        Debug.Log($"[GameAssetLoader] Normalized scale ×{s:F3} ({axis}={refDim:F2} → {targetSize:F1} m)");
    }

    // Transform a local-space AABB into world space by transforming all 8
    // corners and re-encapsulating. More accurate than just scaling extents
    // when the transform contains rotation; matches what Renderer.bounds
    // would have given us once Unity ticked the renderer.
    private static Bounds TransformLocalBoundsToWorld(Transform t, Bounds local)
    {
        var c = local.center;
        var e = local.extents;
        var p0 = t.TransformPoint(c + new Vector3(+e.x, +e.y, +e.z));
        var b  = new Bounds(p0, Vector3.zero);
        b.Encapsulate(t.TransformPoint(c + new Vector3(+e.x, +e.y, -e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(+e.x, -e.y, +e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(+e.x, -e.y, -e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(-e.x, +e.y, +e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(-e.x, +e.y, -e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(-e.x, -e.y, +e.z)));
        b.Encapsulate(t.TransformPoint(c + new Vector3(-e.x, -e.y, -e.z)));
        return b;
    }

    private void TryAttachAnimator(GameObject container)
    {
        var animCtrl = Resources.Load<RuntimeAnimatorController>("Avatar/PlayerAnimController");
        if (animCtrl == null) return;

        var animator = container.GetComponentInChildren<Animator>();
        if (animator == null) animator = container.AddComponent<Animator>();
        animator.runtimeAnimatorController = animCtrl;

        // Try to build a humanoid avatar from standard bone names so Mecanim clips can retarget
        var humanDesc = BuildHumanDescription(container);
        if (humanDesc != null)
        {
            var avatar = AvatarBuilder.BuildHumanAvatar(container, humanDesc.Value);
            if (avatar.isValid)
            {
                animator.avatar = avatar;
                Debug.Log($"[GameAssetLoader] HumanoidAvatar built for '{container.name}'");
            }
        }
    }

    // Attempts to create a HumanDescription by matching common bone name patterns
    // produced by Meshy's rig step (Mixamo-style names).
    private HumanDescription? BuildHumanDescription(GameObject root)
    {
        var transforms = root.GetComponentsInChildren<Transform>();
        var byName = new Dictionary<string, Transform>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in transforms)
            if (!byName.ContainsKey(t.name)) byName[t.name] = t;

        // Mapping: HumanBodyBones name → candidate bone names (Mixamo prefix variants)
        var mapping = new Dictionary<string, string[]>
        {
            ["Hips"]             = new[]{ "mixamorig:Hips",      "Hips" },
            ["Spine"]            = new[]{ "mixamorig:Spine",     "Spine" },
            ["Chest"]            = new[]{ "mixamorig:Spine1",    "Spine1", "Chest" },
            ["UpperChest"]       = new[]{ "mixamorig:Spine2",    "Spine2" },
            ["Head"]             = new[]{ "mixamorig:Head",      "Head" },
            ["Neck"]             = new[]{ "mixamorig:Neck",      "Neck" },
            ["LeftUpperArm"]     = new[]{ "mixamorig:LeftArm",   "LeftArm" },
            ["LeftLowerArm"]     = new[]{ "mixamorig:LeftForeArm","LeftForeArm" },
            ["LeftHand"]         = new[]{ "mixamorig:LeftHand",  "LeftHand" },
            ["RightUpperArm"]    = new[]{ "mixamorig:RightArm",  "RightArm" },
            ["RightLowerArm"]    = new[]{ "mixamorig:RightForeArm","RightForeArm" },
            ["RightHand"]        = new[]{ "mixamorig:RightHand", "RightHand" },
            ["LeftUpperLeg"]     = new[]{ "mixamorig:LeftUpLeg", "LeftUpLeg","LeftUpperLeg" },
            ["LeftLowerLeg"]     = new[]{ "mixamorig:LeftLeg",   "LeftLeg" },
            ["LeftFoot"]         = new[]{ "mixamorig:LeftFoot",  "LeftFoot" },
            ["RightUpperLeg"]    = new[]{ "mixamorig:RightUpLeg","RightUpLeg","RightUpperLeg" },
            ["RightLowerLeg"]    = new[]{ "mixamorig:RightLeg",  "RightLeg" },
            ["RightFoot"]        = new[]{ "mixamorig:RightFoot", "RightFoot" },
        };

        var bones = new List<HumanBone>();
        int matched = 0;
        foreach (var (humanName, candidates) in mapping)
        {
            foreach (var c in candidates)
            {
                if (byName.TryGetValue(c, out _))
                {
                    bones.Add(new HumanBone { humanName = humanName, boneName = c, limit = new HumanLimit { useDefaultValues = true } });
                    matched++;
                    break;
                }
            }
        }

        // Need at least Hips + two leg bones to build a valid avatar
        if (matched < 3) return null;

        // Build skeleton (all transforms)
        var skeletonBones = new List<SkeletonBone>();
        foreach (var t in transforms)
        {
            skeletonBones.Add(new SkeletonBone
            {
                name     = t.name,
                position = t.localPosition,
                rotation = t.localRotation,
                scale    = t.localScale,
            });
        }

        return new HumanDescription
        {
            human         = bones.ToArray(),
            skeleton      = skeletonBones.ToArray(),
            armStretch    = 0.05f,
            legStretch    = 0.05f,
            upperArmTwist = 0.5f,
            lowerArmTwist = 0.5f,
            upperLegTwist = 0.5f,
            lowerLegTwist = 0.5f,
            feetSpacing   = 0f,
        };
    }
}

// Tag attached to every container created by GameAssetLoader.Spawn. Lets the
// runtime distinguish Meshy-generated models from primitives and identify
// terrain tiles for the auto-snap-to-terrain logic.
public class MeshyAssetMarker : MonoBehaviour
{
    public string AssetId;
    public bool   IsTerrain;
    // Auto-yaw applied to the inner template by ApplyYawCorrection. The
    // GameRenderClient subtracts this from any incoming rotation Y so that
    // a script's `obj:SetRotation(0, 90, 0)` produces a 90° VISUAL yaw,
    // independent of how the GLB happened to be oriented internally.
    // Without this, every Lua-side rotation on a humanoid (LookAt, LookAtPlayer,
    // SetRotation) compounded with the 180° auto-yaw and the model faced the
    // wrong direction (zombies pointed away from the house etc.).
    public float  YawCorrection;
}
