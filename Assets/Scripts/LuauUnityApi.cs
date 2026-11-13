using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using UnityEngine;
using MoonSharp.Interpreter;

// ── SceneProxy ─────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class SceneProxy
{

    // Set by LuauGameRunner while DoString runs on the background thread.
    // Any RenderSettings/Physics/Camera call is queued here and drained on
    // the main thread after the script loads, eliminating the "can only be
    // called from the main thread" exception.
    private ConcurrentQueue<Action> _deferredActions;

    internal void BeginDeferredMode(ConcurrentQueue<Action> queue) => _deferredActions = queue;
    internal void EndDeferredMode()                                 => _deferredActions = null;

    private void Dispatch(Action a)
    {
        var q = _deferredActions;   // snapshot — thread-safe single read
        if (q != null) q.Enqueue(a);
        else           a();
    }

    public void SetSkybox(string preset)
    {
        var key = preset ?? "";
        Dispatch(() => EnvironmentManager.SetSkybox(key));
    }

    // Procedural skybox: descriptor table is converted to a JObject so we can
    // re-use EnvironmentManager.SetSkyboxFromDescriptor (also called from the
    // server-authoritative path). Every field is optional; defaults kick in
    // for anything missing.
    public void SetCustomSkybox(DynValue descriptor)
    {
        if (descriptor == null || descriptor.Type != DataType.Table) return;
        var jo = DynTableToJObject(descriptor.Table);
        Dispatch(() => EnvironmentManager.SetSkyboxFromDescriptor(jo));
    }

    private static Newtonsoft.Json.Linq.JObject DynTableToJObject(Table t)
    {
        // Manual whitelist of recognized descriptor fields. Avoids dragging
        // arbitrary Lua values across the bridge and keeps the JObject shape
        // identical to what the server-side path produces.
        var jo = new Newtonsoft.Json.Linq.JObject();

        void Copy3(string key)
        {
            var v = t.Get(key);
            if (v.Type == DataType.Table)
            {
                var inner = v.Table;
                Newtonsoft.Json.Linq.JToken get(object k)
                {
                    var dv = inner.Get(k);
                    return dv.Type == DataType.Number ? new Newtonsoft.Json.Linq.JValue(dv.Number) : null;
                }
                var r = get("r") ?? get(1);
                var g = get("g") ?? get(2);
                var b = get("b") ?? get(3);
                if (r != null && g != null && b != null)
                    jo[key] = new Newtonsoft.Json.Linq.JArray(r, g, b);
            }
        }
        void CopyNum(string key)
        {
            var v = t.Get(key);
            if (v.Type == DataType.Number) jo[key] = v.Number;
        }
        void CopyStr(string key)
        {
            var v = t.Get(key);
            if (v.Type == DataType.String) jo[key] = v.String;
        }

        Copy3("topColor"); Copy3("bottomColor"); Copy3("horizonColor");
        Copy3("sunColor"); Copy3("sunDirection");
        Copy3("fogColor"); Copy3("ambientColor");
        CopyNum("sunSize"); CopyNum("sunIntensity");
        CopyNum("exposure"); CopyNum("atmosphereThickness");
        CopyNum("fogDensity"); CopyNum("ambientIntensity");
        CopyStr("timeOfDay");

        return jo;
    }

    // Deprecated — terrain is now always a Meshy asset in the manifest.
    public void SetGround(string groundType)
    {
        Dispatch(() => Debug.LogWarning("[Luau] Scene.SetGround() is deprecated — use a terrain asset in asset_manifest instead."));
    }

    public void SetEnvironment(string genre)
    {
        var key = genre ?? "";
        Dispatch(() => EnvironmentManager.SetEnvironment(key));
    }

    public void SetFog(DynValue color, float density)
    {
        var c = DynToColor(color, new Color(0.7f, 0.7f, 0.8f));
        Dispatch(() => {
            RenderSettings.fog        = true;
            RenderSettings.fogColor   = c;
            RenderSettings.fogDensity = density;
        });
    }

    public void SetAmbientLight(DynValue color, float intensity)
    {
        var c = DynToColor(color, Color.white) * intensity;
        Dispatch(() => RenderSettings.ambientLight = c);
    }

    public void SetGravity(float value)
        => Dispatch(() => Physics.gravity = new Vector3(0, value, 0));

    public void SetBackgroundColor(float r, float g, float b)
    {
        var col = new Color(r, g, b);
        Dispatch(() => {
            RenderSettings.ambientLight = col * 0.4f;
            if (Camera.main != null)
            {
                Camera.main.clearFlags      = CameraClearFlags.SolidColor;
                Camera.main.backgroundColor = col;
            }
        });
    }

    internal static Color DynToColor(DynValue v, Color def)
    {
        if (v.Type != DataType.Table) return def;
        var t = v.Table;
        return new Color(
            (float)(t.Get("r").Type == DataType.Number ? t.Get("r").Number : def.r),
            (float)(t.Get("g").Type == DataType.Number ? t.Get("g").Number : def.g),
            (float)(t.Get("b").Type == DataType.Number ? t.Get("b").Number : def.b));
    }
}

// ── LuaObject ─────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class LuaObject
{
    internal readonly GameObject Go;
    private readonly LuauGameRunner _runner;

    public LuaObject(GameObject go, LuauGameRunner runner) { Go = go; _runner = runner; }

    // Dispatch to main thread when called from the background script-load thread;
    // no-op wrapper when already on the main thread (callbacks, runtime, etc.).
    private void MT(Action a) => _runner.RunOnMainThread<object>(() => { a(); return null; });

    public void SetPosition(float x, float y, float z)
        => MT(() => {
            Go.transform.localPosition = new Vector3(x, y, z);
            // Lift the model if it would clip into the terrain mesh. No-op for
            // primitives, terrain tiles, and props above the terrain surface.
            GameAssetLoader.SnapToTerrainIfBelow(Go);
        });

    public void SetRotation(float x, float y, float z)
        => MT(() => Go.transform.localEulerAngles = new Vector3(x, y, z));

    public void SetScale(float x, float y, float z)
        => MT(() => Go.transform.localScale = new Vector3(x, y, z));

    public void SetColor(float r, float g, float b)
        => MT(() => {
            var ren = Go.GetComponent<Renderer>();
            if (!ren) return;
            var col = new Color(r, g, b);
            ren.material.SetColor("_BaseColor", col); // URP Lit
            ren.material.SetColor("_Color",     col); // Standard fallback
        });

    // SetMaterial is polymorphic to match the server-side Lua proxy:
    //   1 arg  → legacy color/preset path
    //   3 args → PBR materialType + tiling + roughness (Polyhaven path)
    // In the local-play preview we don't have Polyhaven URLs to plug in, so
    // the 3-arg form still applies the Pludo/Terrain shader (single-layer
    // mode) with the requested tiling. Textures arrive only via the server-
    // authoritative WS path; this keeps partial-stream preview from crashing
    // on "no matching SetMaterial(string, float, float)" overload errors.
    public void SetMaterial(string preset)
        => MT(() => {
            var ren = Go.GetComponent<Renderer>();
            if (!ren) return;
            ren.material = BuildMaterial(preset);
        });

    public void SetMaterial(string materialType, double tiling, double roughness = 0.7)
        => MT(() => {
            var ren = Go.GetComponent<Renderer>();
            if (!ren) return;
            var shader = Shader.Find("Pludo/Terrain");
            if (shader == null)
            {
                // Shader not loaded yet (rare during cold compile). Fall back
                // to the preset path so we still render something reasonable.
                ren.material = BuildMaterial(materialType);
                return;
            }
            var mat = new Material(shader);
            mat.SetFloat("_LayerCount",     1f);
            mat.SetFloat("_Layer0_Tiling",  (float)tiling);
            mat.SetFloat("_RoughnessScale", (float)roughness);
            ren.material = mat;
        });

    public void SetPhysics(bool enabled)
        => MT(() => {
            if (!Go) return;
            if (enabled)
                EnsurePhysicsReady();
            else
            {
                var rb = Go.GetComponent<Rigidbody>();
                if (rb) rb.isKinematic = true;
            }
        });

    public void SetStatic(bool enabled)
        => MT(() => {
            if (!Go) return;
            Go.isStatic = enabled;
            var rb = Go.GetComponent<Rigidbody>();
            if (rb) rb.isKinematic = enabled;
        });

    public void SetTag(string tag)
        => MT(() => {
            try { Go.tag = tag; }
            catch (UnityException) { } // tag not defined in Project Settings — silently skip
        });

    public void SetName(string name) => MT(() => Go.name = name);
    public void Destroy() => MT(() => UnityEngine.Object.Destroy(Go));

    public Table GetPosition() => _runner.RunOnMainThread<Table>(() =>
    {
        var p = Go.transform.localPosition;
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(p.x));
        t.Set("y", DynValue.NewNumber(p.y));
        t.Set("z", DynValue.NewNumber(p.z));
        return t;
    });

    public void OnPlayerEnter(DynValue cb)
        => MT(() => GetOrAddTrigger().SetEnter(_runner, cb));

    public void OnPlayerExit(DynValue cb)
        => MT(() => GetOrAddTrigger().SetExit(_runner, cb));

    public void OnCollision(DynValue cb)
        => MT(() => {
            var h = Go.GetComponent<LuaCollisionHandler>() ?? Go.AddComponent<LuaCollisionHandler>();
            h.Init(_runner, cb);
        });

    public void ApplyForce(float x, float y, float z)
        => MT(() => {
            if (!Go) return;
            var rb = EnsurePhysicsReady();
            rb.AddForce(new Vector3(x, y, z), ForceMode.Impulse);
        });

    public void SetVelocity(float x, float y, float z)
        => MT(() => {
            if (!Go) return;
            var rb = EnsurePhysicsReady();
            rb.linearVelocity = new Vector3(x, y, z);
        });

    public Table GetVelocity() => _runner.RunOnMainThread<Table>(() =>
    {
        var rb = Go.GetComponent<Rigidbody>();
        var v = rb != null ? rb.linearVelocity : Vector3.zero;
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(v.x));
        t.Set("y", DynValue.NewNumber(v.y));
        t.Set("z", DynValue.NewNumber(v.z));
        return t;
    });

    public void SetVisible(bool v)
        => MT(() => {
            foreach (var r in Go.GetComponentsInChildren<Renderer>(true)) r.enabled = v;
            // Never disable trigger colliders — they back OnPlayerEnter zones and must stay active
            foreach (var c in Go.GetComponentsInChildren<Collider>(true))
                if (!c.isTrigger) c.enabled = v;
        });

    public LuaObject Clone()
        => _runner.RunOnMainThread(() => {
            var parent = Go.transform.parent ?? LuauGameRunner.Instance?.GameRoot;
            var go2 = UnityEngine.Object.Instantiate(Go, parent);
            return new LuaObject(go2, _runner);
        });

    public void LookAt(float x, float y, float z)
        => MT(() => {
            var target = new Vector3(x, Go.transform.position.y, z);
            if ((target - Go.transform.position).sqrMagnitude > 0.001f)
                Go.transform.LookAt(target);
        });

    public void LookAtPlayer()
        => MT(() => {
            var pp = LuauGameRunner.Instance?.GetPlayerPosition() ?? Vector3.zero;
            var target = new Vector3(pp.x, Go.transform.position.y, pp.z);
            if ((target - Go.transform.position).sqrMagnitude > 0.001f)
                Go.transform.LookAt(target);
        });

    public float GetDistanceToPlayer() => _runner.RunOnMainThread<float>(() =>
    {
        var pp = LuauGameRunner.Instance?.GetPlayerPosition() ?? Vector3.zero;
        return Vector3.Distance(Go.transform.position, pp);
    });

    public float GetDistanceTo(LuaObject other) => _runner.RunOnMainThread<float>(() =>
        Vector3.Distance(Go.transform.position, other.Go.transform.position));

    public void SetParent(LuaObject parent)
        => MT(() => Go.transform.SetParent(parent.Go.transform, true));

    public void Detach()
        => MT(() => Go.transform.SetParent(LuauGameRunner.Instance?.GameRoot, true));

    public void SetEmissive(float r, float g, float b, float intensity)
        => MT(() => {
            var ren = Go.GetComponent<Renderer>();
            if (!ren) return;
            var col = new Color(r, g, b);
            ren.material.EnableKeyword("_EMISSION");
            ren.material.SetColor("_EmissionColor", col * intensity);
        });

    public Table GetRotation() => _runner.RunOnMainThread<Table>(() =>
    {
        var e = Go.transform.localEulerAngles;
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(e.x));
        t.Set("y", DynValue.NewNumber(e.y));
        t.Set("z", DynValue.NewNumber(e.z));
        return t;
    });

    public Table GetScale() => _runner.RunOnMainThread<Table>(() =>
    {
        var s = Go.transform.localScale;
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(s.x));
        t.Set("y", DynValue.NewNumber(s.y));
        t.Set("z", DynValue.NewNumber(s.z));
        return t;
    });

    // ── helpers ────────────────────────────────────────────────────────────────

    // Gets or adds a Rigidbody using Unity's bool operator (not C# ??) so fake-null
    // destroyed components are detected correctly.  Also synthesises a BoxCollider from
    // the model's renderer bounds when no collider exists — necessary for GLB models
    // which Meshy ships without collision geometry.
    private Rigidbody EnsurePhysicsReady()
    {
        var rb = Go.GetComponent<Rigidbody>();
        if (!rb) rb = Go.AddComponent<Rigidbody>();

        if (!Go.GetComponent<Collider>() && !Go.GetComponentInChildren<Collider>())
        {
            var bc    = Go.AddComponent<BoxCollider>();
            var rends = Go.GetComponentsInChildren<Renderer>();
            if (rends.Length > 0)
            {
                var bounds = rends[0].bounds;
                foreach (var r in rends) bounds.Encapsulate(r.bounds);
                bc.center = Go.transform.InverseTransformPoint(bounds.center);
                var s = Go.transform.lossyScale;
                bc.size = new Vector3(
                    Mathf.Abs(s.x) > 0.001f ? bounds.size.x / Mathf.Abs(s.x) : bounds.size.x,
                    Mathf.Abs(s.y) > 0.001f ? bounds.size.y / Mathf.Abs(s.y) : bounds.size.y,
                    Mathf.Abs(s.z) > 0.001f ? bounds.size.z / Mathf.Abs(s.z) : bounds.size.z);
            }
        }

        rb.isKinematic = false;
        return rb;
    }

    private void AddTriggerChild()
    {
        if (Go.transform.Find("_Trigger") != null) return;
        var child = new GameObject("_Trigger");
        child.transform.SetParent(Go.transform, false);
        var bc = child.AddComponent<BoxCollider>();
        bc.isTrigger = true;
        bc.size = Vector3.one * 1.05f;
    }

    private LuaTrigger GetOrAddTrigger()
    {
        var child = Go.transform.Find("_Trigger");
        if (child == null) { AddTriggerChild(); child = Go.transform.Find("_Trigger"); }
        return child.GetComponent<LuaTrigger>() ?? child.gameObject.AddComponent<LuaTrigger>();
    }

    private static Material BuildMaterial(string preset)
    {
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var m = new Material(shader);
        Color c = preset switch
        {
            "metal"  => new Color(0.72f, 0.72f, 0.78f),
            "wood"   => new Color(0.60f, 0.40f, 0.20f),
            "stone"  => new Color(0.52f, 0.52f, 0.52f),
            "grass"  => new Color(0.28f, 0.62f, 0.20f),
            "ice"    => new Color(0.68f, 0.85f, 1.00f),
            "lava"   => new Color(1.00f, 0.28f, 0.00f),
            "glass"  => new Color(0.60f, 0.85f, 0.95f),
            "sand"   => new Color(0.86f, 0.76f, 0.52f),
            _        => new Color(0.80f, 0.80f, 0.80f),
        };
        m.SetColor("_BaseColor", c); // URP Lit
        m.SetColor("_Color",     c); // Standard fallback
        if (preset is "lava" or "neon")
        {
            m.EnableKeyword("_EMISSION");
            m.SetColor("_EmissionColor", c * 2f);
        }
        else if (preset is "glass" or "ice")
        {
            m.SetFloat("_Surface", 1f);
            var ca = c; ca.a = 0.5f;
            m.SetColor("_BaseColor", ca);
            m.SetColor("_Color",     ca);
        }
        return m;
    }
}

// MonoBehaviour — player trigger callbacks
public class LuaTrigger : MonoBehaviour
{
    private LuauGameRunner _runner;
    private DynValue _onEnter = DynValue.Nil;
    private DynValue _onExit  = DynValue.Nil;

    public void SetEnter(LuauGameRunner r, DynValue cb) { _runner = r; _onEnter = cb; }
    public void SetExit (LuauGameRunner r, DynValue cb) { _runner = r; _onExit  = cb; }

    private void OnTriggerEnter(Collider other)
    {
        if (_runner && _onEnter.Type == DataType.Function && other.CompareTag("Player"))
            _runner.CallLua(_onEnter);
    }

    private void OnTriggerExit(Collider other)
    {
        if (_runner && _onExit.Type == DataType.Function && other.CompareTag("Player"))
            _runner.CallLua(_onExit);
    }
}

// MonoBehaviour — physics collision callback
public class LuaCollisionHandler : MonoBehaviour
{
    private LuauGameRunner _runner;
    private DynValue _cb = DynValue.Nil;

    public void Init(LuauGameRunner r, DynValue cb) { _runner = r; _cb = cb; }

    private void OnCollisionEnter(Collision c) => NotifyTouch(c.gameObject);

    // Also called by LuauPlayerController when the kinematic player bumps us.
    public void NotifyTouch(GameObject other)
    {
        if (_runner && _cb.Type == DataType.Function && other != null)
            _runner.CallLua(_cb, DynValue.NewString(other.name));
    }
}

// ── ObjectFactory ─────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class ObjectFactory
{
    private readonly Transform _root;
    private readonly LuauGameRunner _runner;

    // Lazily resolved on first use. Static field initializers can run on the
    // background DoString thread under IL2CPP, which throws IsObjectMonoBehaviour;
    // every read site below is already inside a RunOnMainThread dispatch.
    private static Shader _lit;
    private static Shader Lit => _lit != null
        ? _lit
        : (_lit = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));

    public ObjectFactory(Transform root, LuauGameRunner runner) { _root = root; _runner = runner; }

    public LuaObject Create(string type) => _runner.RunOnMainThread(() => CreateImpl(type));

    private LuaObject CreateImpl(string type)
    {
        // Custom Meshy-generated 3D model — "model:<assetId>"
        if (type != null && type.StartsWith("model:", StringComparison.OrdinalIgnoreCase))
        {
            var assetId = type.Substring(6);
            var go = _runner.SpawnAsset(assetId, _root);
            if (go != null) return new LuaObject(go, _runner);

            // Asset wasn't ready when Lua executed Object.Create. Return a colored
            // placeholder cube immediately (Lua needs a synchronous handle), but
            // schedule a retry coroutine that polls the loader and swaps the real
            // GLB in as a child of the same GameObject when it becomes available.
            // This keeps the LuaObject reference stable so SetPosition/SetScale
            // calls already issued against `obj` continue to work after the swap.
            var placeholder = GameObject.CreatePrimitive(PrimitiveType.Cube);
            placeholder.name = $"model:{assetId}";
            placeholder.transform.SetParent(_root, false);
            // Tag the placeholder so SetPosition snaps it to terrain. Once the
            // real GLB swaps in, AssetSwapRetryCoroutine re-runs the snap.
            var phMarker        = placeholder.AddComponent<MeshyAssetMarker>();
            phMarker.AssetId    = assetId;
            phMarker.IsTerrain  = (assetId == "terrain");
            var placeholderRen = placeholder.GetComponent<Renderer>();
            if (placeholderRen)
            {
                var col = PlaceholderColor(assetId);
                var mat = new Material(Lit);
                mat.SetColor("_BaseColor", col);
                mat.SetColor("_Color",     col);
                placeholderRen.material = mat;
            }
            var placeholderRb = placeholder.GetComponent<Rigidbody>();
            if (placeholderRb) placeholderRb.isKinematic = true;

            // Fire-and-forget swap-in. Capped to 3 attempts at 2s, 4s, 6s so we
            // don't poll forever for a permanently-failed asset.
            _runner.StartAssetSwapRetry(assetId, placeholder);

            return new LuaObject(placeholder, _runner);
        }

        GameObject prim = (type?.ToLower()) switch
        {
            "sphere"   => GameObject.CreatePrimitive(PrimitiveType.Sphere),
            "cylinder" => GameObject.CreatePrimitive(PrimitiveType.Cylinder),
            "capsule"  => GameObject.CreatePrimitive(PrimitiveType.Capsule),
            "plane"    => GameObject.CreatePrimitive(PrimitiveType.Plane),
            _          => GameObject.CreatePrimitive(PrimitiveType.Cube),
        };
        prim.transform.SetParent(_root, false);

        // Ramp/wedge: tilt the cube
        if (type is "ramp" or "wedge")
            prim.transform.localEulerAngles = new Vector3(30f, 0f, 0f);

        // Default grey lit material, static
        var ren = prim.GetComponent<Renderer>();
        if (ren)
        {
            var grey = new Color(0.8f, 0.8f, 0.8f);
            var mat = new Material(Lit);
            mat.SetColor("_BaseColor", grey);
            mat.SetColor("_Color",     grey);
            ren.material = mat;
        }
        var rb = prim.GetComponent<Rigidbody>();
        if (rb) rb.isKinematic = true;

        return new LuaObject(prim, _runner);
    }

    // Picks a tinted color for model placeholders based on keywords in the asset id
    // so terrain looks green, portals look gold, water looks blue, etc.
    private static Color PlaceholderColor(string id)
    {
        var l = id.ToLower();
        if (Contains(l, "grass", "terrain", "ground", "island", "land"))   return new Color(0.35f, 0.65f, 0.25f);
        if (Contains(l, "water", "ocean", "lake", "river", "pool"))         return new Color(0.20f, 0.45f, 0.80f);
        if (Contains(l, "lava", "magma", "fire", "volcano"))                return new Color(0.90f, 0.30f, 0.05f);
        if (Contains(l, "stone", "rock", "cliff", "boulder", "wall"))       return new Color(0.55f, 0.52f, 0.48f);
        if (Contains(l, "ice", "snow", "frost", "glacier"))                 return new Color(0.80f, 0.92f, 1.00f);
        if (Contains(l, "cloud", "sky"))                                     return new Color(0.90f, 0.90f, 0.95f);
        if (Contains(l, "portal", "finish", "goal", "end"))                 return new Color(1.00f, 0.85f, 0.10f);
        if (Contains(l, "coin", "gold", "gem", "treasure"))                 return new Color(1.00f, 0.80f, 0.00f);
        if (Contains(l, "wood", "tree", "log", "plank", "platform"))        return new Color(0.58f, 0.38f, 0.18f);
        if (Contains(l, "sand", "desert", "beach", "dune"))                 return new Color(0.90f, 0.82f, 0.55f);
        if (Contains(l, "enemy", "monster", "zombie", "boss"))              return new Color(0.75f, 0.15f, 0.15f);
        if (Contains(l, "mushroom", "plant", "flower", "bush"))             return new Color(0.60f, 0.25f, 0.50f);
        return new Color(0.55f, 0.60f, 0.70f); // neutral blue-grey default
    }
    private static bool Contains(string s, params string[] terms)
    {
        foreach (var t in terms) if (s.Contains(t)) return true;
        return false;
    }
}

// ── StructureFactory ─────────────────────────────────────────────────────────
// Procedural visible primitives for terrain, walls, ramps, water. Matches the
// server-side Structure.* API (see lua-runtime.ts) so the generated Lua script
// runs identically on the local-play and server-authoritative paths.
//
// All Structure entities are visible by default (unlike Object.Create primitives,
// which are force-hidden to suppress placeholder cubes from buggy old prompts).
[MoonSharpUserData]
public class StructureFactory
{
    private readonly Transform _root;
    private readonly LuauGameRunner _runner;
    private static Shader _lit;
    private static Shader Lit => _lit != null
        ? _lit
        : (_lit = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));

    public StructureFactory(Transform root, LuauGameRunner runner) { _root = root; _runner = runner; }

    public LuaObject CreateGround(float x, float y, float z, float sizeX, float sizeZ, DynValue color = null)
        => _runner.RunOnMainThread(() => MakePrim(PrimitiveType.Plane, x, y, z, sizeX, 1f, sizeZ, 0f, color, new Color(0.30f, 0.55f, 0.25f)));

    public LuaObject CreateBox(float x, float y, float z, float sx, float sy, float sz, DynValue color = null)
        => _runner.RunOnMainThread(() => MakePrim(PrimitiveType.Cube, x, y, z, sx, sy, sz, 0f, color, new Color(0.55f, 0.40f, 0.25f)));

    public LuaObject CreateWall(float x, float y, float z, float length, float height, float rotY, DynValue color = null)
        => _runner.RunOnMainThread(() => MakePrim(PrimitiveType.Cube, x, y, z, 0.4f, height, length, rotY, color, new Color(0.40f, 0.30f, 0.20f)));

    public LuaObject CreateRamp(float x, float y, float z, float sx, float sy, float sz, float rotY, DynValue color = null)
        => _runner.RunOnMainThread(() => MakeRamp(x, y, z, sx, sy, sz, rotY, color, new Color(0.55f, 0.45f, 0.35f)));

    public LuaObject CreateCylinder(float x, float y, float z, float radius, float height, DynValue color = null)
        => _runner.RunOnMainThread(() => MakePrim(PrimitiveType.Cylinder, x, y, z, radius * 2f, height, radius * 2f, 0f, color, new Color(0.55f, 0.45f, 0.35f)));

    public LuaObject CreateSphere(float x, float y, float z, float radius, DynValue color = null)
    {
        var d = radius * 2f;
        return _runner.RunOnMainThread(() => MakePrim(PrimitiveType.Sphere, x, y, z, d, d, d, 0f, color, new Color(0.60f, 0.60f, 0.65f)));
    }

    // Triplanar PBR terrain plane — mirrors the server-side Structure.CreateTerrain.
    // For local-play preview we apply the Pludo/Terrain shader if it's available
    // and leave the textures unassigned (the shader's white-default samplers keep
    // the surface visible until a server-authoritative session swaps in real
    // Polyhaven maps). Falls back to a flat green plane if the shader is missing,
    // so partial-stream previews never crash.
    public LuaObject CreateTerrain(float x, float y, float z, float sizeX, float sizeZ, DynValue layers = null)
        => _runner.RunOnMainThread(() =>
        {
            var fallback = new Color(0.30f, 0.55f, 0.25f);
            var obj = MakePrim(PrimitiveType.Plane, x, y, z, sizeX, 1f, sizeZ, 0f, null, fallback);
            var go  = obj.Go;
            if (go == null) return obj;
            var ren = go.GetComponent<Renderer>();
            if (ren == null) return obj;
            var shader = Shader.Find("Pludo/Terrain");
            if (shader == null) return obj;                                  // keep flat-color fallback
            var mat = new Material(shader);
            int layerCount = 1;
            if (layers != null && layers.Type == DataType.Table)
            {
                layerCount = Mathf.Clamp(layers.Table.Length, 1, 3);
                for (int i = 1; i <= layerCount; i++)
                {
                    var entry = layers.Table.Get(i);
                    if (entry.Type != DataType.Table) continue;
                    var t = entry.Table;
                    var tiling   = (float)(t.Get("tiling").CastToNumber()   ?? (8.0 - (i - 1) * 1.5));
                    var slopeMin = (float)(t.Get("slopeMin").CastToNumber() ?? (i - 1) / 3.0);
                    var slopeMax = (float)(t.Get("slopeMax").CastToNumber() ?? i / 3.0);
                    int idx = i - 1; // Lua 1-based → shader 0-based
                    mat.SetFloat($"_Layer{idx}_Tiling",   tiling);
                    mat.SetFloat($"_Layer{idx}_SlopeMin", slopeMin);
                    mat.SetFloat($"_Layer{idx}_SlopeMax", slopeMax);
                }
            }
            mat.SetFloat("_LayerCount", layerCount);
            ren.material = mat;
            return obj;
        });

    public LuaObject CreateWater(float x, float y, float z, float sizeX, float sizeZ, DynValue color = null)
    {
        var fallback = new Color(0.25f, 0.55f, 0.75f);
        return _runner.RunOnMainThread(() =>
        {
            var obj = MakePrim(PrimitiveType.Plane, x, y, z, sizeX, 1f, sizeZ, 0f, color, fallback);
            // Water gets a translucent material so it reads as water, not a flat
            // solid. Honor the descriptor color but force alpha = 0.6 and the
            // URP/Lit transparent surface.
            var go = obj.Go;
            if (go != null)
            {
                var ren = go.GetComponent<Renderer>();
                if (ren != null && ren.sharedMaterial != null)
                {
                    var col = ren.sharedMaterial.HasProperty("_BaseColor") ? ren.sharedMaterial.GetColor("_BaseColor") : fallback;
                    col.a = 0.6f;
                    ren.sharedMaterial.SetFloat("_Surface", 1f); // 0=Opaque, 1=Transparent
                    ren.sharedMaterial.SetFloat("_Blend",   0f);
                    ren.sharedMaterial.SetColor("_BaseColor", col);
                    ren.sharedMaterial.SetColor("_Color",     col);
                    ren.sharedMaterial.renderQueue = 3000;
                }
            }
            return obj;
        });
    }

    private LuaObject MakePrim(PrimitiveType t, float x, float y, float z,
                               float sx, float sy, float sz, float rotY,
                               DynValue color, Color fallbackColor)
    {
        var go = GameObject.CreatePrimitive(t);
        go.name = $"Structure.{t}";
        go.transform.SetParent(_root, false);
        go.transform.localPosition    = new Vector3(x, y, z);
        go.transform.localScale       = new Vector3(sx, sy, sz);
        go.transform.localEulerAngles = new Vector3(0f, rotY, 0f);
        ApplyColor(go, color, fallbackColor);
        EnsureStatic(go);
        return new LuaObject(go, _runner);
    }

    private LuaObject MakeRamp(float x, float y, float z, float sx, float sy, float sz,
                               float rotY, DynValue color, Color fallbackColor)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = "Structure.Ramp";
        go.transform.SetParent(_root, false);
        go.transform.localPosition    = new Vector3(x, y, z);
        go.transform.localScale       = new Vector3(sx, sy, sz);
        // Preserve the legacy "ramp" pitch (~30°) so geometry matches the
        // server-side _structCreate("ramp") path. rotY rotates the slope.
        go.transform.localEulerAngles = new Vector3(30f, rotY, 0f);
        ApplyColor(go, color, fallbackColor);
        EnsureStatic(go);
        return new LuaObject(go, _runner);
    }

    private static void ApplyColor(GameObject go, DynValue color, Color fallback)
    {
        var ren = go.GetComponent<Renderer>();
        if (ren == null) return;
        var col = SceneProxy.DynToColor(color, fallback);
        var mat = new Material(Lit);
        mat.SetColor("_BaseColor", col);
        mat.SetColor("_Color",     col);
        ren.material = mat;
    }

    private static void EnsureStatic(GameObject go)
    {
        var rb = go.GetComponent<Rigidbody>();
        if (rb) rb.isKinematic = true;
    }
}

// ── PlayerProxy ───────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class PlayerProxy
{
    private readonly LuauGameRunner _runner;
    public PlayerProxy(LuauGameRunner r) { _runner = r; }

    public void SetSpeed(float v)       => _runner.SetPlayerSpeed(v);
    public void SetJumpHeight(float v)  => _runner.SetPlayerJumpHeight(v);
    public void SetSpawnPoint(float x, float y, float z) => _runner.RequestSpawnPlayer(new Vector3(x, y, z));
    public void GiveItem(string item)   => Debug.Log($"[Luau] Player.GiveItem({item})");

    public Table GetPosition()
    {
        var p = _runner.GetPlayerPosition();
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(p.x)); t.Set("y", DynValue.NewNumber(p.y)); t.Set("z", DynValue.NewNumber(p.z));
        return t;
    }

    public float GetHealth()            => _runner.GetPlayerHealth();
    public void SetHealth(float v)      => _runner.SetPlayerHealth(v);
    public void AddHealth(float v)      => _runner.SetPlayerHealth(_runner.GetPlayerHealth() + v);
    public void AddScore(int pts)       => _runner.RequestAddScore(pts);
    public int  GetScore()              => _runner.GetScore();
    public void ShowMessage(string txt, float dur) => _runner.RequestShowMessage(txt, dur);
    public void ShowTitle(string txt, string sub, float dur) => _runner.RequestShowTitle(txt, sub, dur);

    public void Teleport(float x, float y, float z) => _runner.TeleportPlayer(x, y, z);

    public Table GetVelocity()
    {
        var v = _runner.GetPlayerVelocity();
        var t = new Table(null);
        t.Set("x", DynValue.NewNumber(v.x));
        t.Set("y", DynValue.NewNumber(v.y));
        t.Set("z", DynValue.NewNumber(v.z));
        return t;
    }

    public bool IsGrounded() => _runner.GetPlayerGrounded();

    public float GetDistanceTo(LuaObject obj) => _runner.RunOnMainThread<float>(() =>
        Vector3.Distance(_runner.GetPlayerPosition(), obj.Go.transform.position));

    public void SetInvincible(bool v) => _runner.SetPlayerInvincible(v);
}

// ── LightFactory + LuaLight ───────────────────────────────────────────────────
[MoonSharpUserData]
public class LightFactory
{
    private readonly Transform _root;
    private readonly LuauGameRunner _runner;
    public LightFactory(Transform root, LuauGameRunner runner) { _root = root; _runner = runner; }

    public LuaLight Create(string type, float x, float y, float z)
        => _runner.RunOnMainThread(() => {
            var go = new GameObject($"LuaLight_{type}");
            go.transform.SetParent(_root, false);
            go.transform.position = new Vector3(x, y, z);
            var l = go.AddComponent<Light>();
            l.type      = type?.ToLower() switch { "spot" => LightType.Spot, "directional" => LightType.Directional, _ => LightType.Point };
            l.intensity = 1.5f;
            l.range     = 15f;
            return new LuaLight(l, _runner);
        });
}

[MoonSharpUserData]
public class LuaLight
{
    private readonly Light _l;
    private readonly LuauGameRunner _runner;
    private void MT(Action a) => _runner.RunOnMainThread<object>(() => { a(); return null; });

    public LuaLight(Light l, LuauGameRunner runner) { _l = l; _runner = runner; }
    public void SetColor(float r, float g, float b) => MT(() => _l.color = new Color(r, g, b));
    public void SetIntensity(float v) => MT(() => _l.intensity = v);
    public void SetRange(float v)     => MT(() => _l.range = v);
}

// ── AudioProxy ────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class AudioProxy
{
    // GameAudio.Instance lazily creates a "GameAudio" GameObject on first touch,
    // which throws Internal_CreateGameObject if hit from the DoString bg thread
    // (templates emit `Audio.PlayMusic` at top level). Dispatch every call.
    private readonly LuauGameRunner _runner;
    public AudioProxy(LuauGameRunner r) { _runner = r; }

    private void MT(Action a) => _runner.RunOnMainThread<object>(() => { a(); return null; });

    public void PlaySound(string p)     => MT(() => GameAudio.PlaySound(p));
    // Editor preview is for visual scene inspection + chat with the AI; looping
    // game music over that UX is intrusive, so we silence it during preview mode.
    // Genuine play sessions (RunGame) are unaffected.
    public void PlayMusic(string p)     => MT(() => { if (_runner.IsPreviewMode) return; GameAudio.PlayMusic(p); });
    public void StopMusic()             => MT(GameAudio.StopMusic);
    public void SetVolume(float v)      => MT(() => GameAudio.SetSfxVolume(v));
    public void SetMusicVolume(float v) => MT(() => GameAudio.SetMusicVolume(v));
}

// ── UIProxy ───────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class UIProxy
{
    private readonly LuauGameRunner _runner;
    public UIProxy(LuauGameRunner r) { _runner = r; }

    public void ShowHUD(DynValue config) { /* HUD is controlled by React */ }
    public void UpdateHUD(string key, DynValue value) => _runner.UpdateHUDValue(key, value);
    public void ShowPopup(string title, string body, string btn) => _runner.RequestShowPopup(title, body, btn);
    public void ShowCountdown(float secs, DynValue cb) => _runner.RequestShowCountdown(secs, cb);
    public void ShowMessage(string txt, float dur = 3f) => _runner.RequestShowMessage(txt, dur);
    public void SetScore(int s)   => _runner.RequestSetScore(s);
    public void AddScore(int d)   => _runner.RequestAddScore(d);
}

// ── GameProxy ─────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class GameProxy
{
    private readonly LuauGameRunner _runner;
    private DynValue _onUpdate     = DynValue.Nil;
    private DynValue _onStart      = DynValue.Nil;
    private DynValue _onWin        = DynValue.Nil;
    private DynValue _onLose       = DynValue.Nil;
    private DynValue _onPlayerDied = DynValue.Nil;

    public GameProxy(LuauGameRunner r) { _runner = r; }

    public void OnUpdate(DynValue cb)     => _onUpdate     = cb;
    public void OnStart(DynValue cb)      => _onStart      = cb;
    public void OnWin(DynValue cb)        => _onWin        = cb;
    public void OnLose(DynValue cb)       => _onLose       = cb;
    public void OnPlayerDied(DynValue cb) => _onPlayerDied = cb;

    public void SetObjective(string text) => _runner.RequestShowMessage(text, 6f);
    public void SetTimeLimit(float secs)  => _runner.SetTimeLimit(secs);
    public float GetTimeRemaining()       => _runner.GetTimeRemaining();
    public void Restart()                 => _runner.RestartGame();

    public void End(string result)
    {
        if (result == "win")
        {
            if (_onWin.Type == DataType.Function) _runner.CallLua(_onWin);
            _runner.RequestEndGame("You Win!");
        }
        else
        {
            if (_onLose.Type == DataType.Function) _runner.CallLua(_onLose);
            _runner.RequestEndGame("Game Over");
        }
    }

    internal void FirePlayerDied()
    {
        if (_onPlayerDied.Type == DataType.Function) _runner.CallLua(_onPlayerDied);
    }

    // Legacy aliases
    public void SetScore(int s)  => _runner.RequestSetScore(s);
    public void AddScore(int d)  => _runner.RequestAddScore(d);
    public void EndGame(string m) => _runner.RequestEndGame(m);

    public void FireUpdate(float dt)
    {
        if (_onUpdate.Type == DataType.Function)
            _runner.CallLua(_onUpdate, DynValue.NewNumber(dt));
    }

    public void FireStart()
    {
        if (_onStart.Type == DataType.Function)
            _runner.CallLua(_onStart);
    }
}

// ── NetworkProxy ──────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class NetworkProxy
{
    private readonly LuauGameRunner _runner;
    private DynValue _onJoined = DynValue.Nil;
    private DynValue _onLeft   = DynValue.Nil;

    public NetworkProxy(LuauGameRunner runner)
    {
        _runner = runner;
        runner.OnPlayerSpawned += FireLocalPlayerJoined;
    }

    private void FireLocalPlayerJoined(string id)
    {
        if (_onJoined.Type != DataType.Function) return;
        var t = new Table(null);
        t.Set("id",       DynValue.NewString("local"));
        t.Set("username", DynValue.NewString("You"));
        _runner.CallLua(_onJoined, DynValue.NewTable(t));
    }

    public void OnPlayerJoined(DynValue cb)  => _onJoined = cb;
    public void OnPlayerLeft(DynValue cb)    => _onLeft   = cb;

    public Table GetAllPlayers()
    {
        var t      = new Table(null);
        var player = new Table(null);
        player.Set("id",       DynValue.NewString("local"));
        player.Set("username", DynValue.NewString("You"));
        t.Set(1, DynValue.NewTable(player));
        return t;
    }

    public void SyncObject(LuaObject obj)            { }
    public void BroadcastEvent(string n, DynValue d) { }
    public void OnEvent(string n, DynValue cb)       { }
}

// ── PhysicsProxy ──────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class PhysicsProxy
{
    private readonly LuauGameRunner _runner;
    public PhysicsProxy(LuauGameRunner r) { _runner = r; }

    public Table Raycast(float ox, float oy, float oz, float dx, float dy, float dz, float maxDist = 100f)
        => _runner.RunOnMainThread(() =>
    {
        var result = new Table(null);
        var dir    = new Vector3(dx, dy, dz);
        if (dir.sqrMagnitude < 0.0001f) { result.Set("hit", DynValue.False); return result; }

        if (Physics.Raycast(new Vector3(ox, oy, oz), dir.normalized, out RaycastHit rh, maxDist))
        {
            result.Set("hit",      DynValue.True);
            result.Set("x",        DynValue.NewNumber(rh.point.x));
            result.Set("y",        DynValue.NewNumber(rh.point.y));
            result.Set("z",        DynValue.NewNumber(rh.point.z));
            result.Set("distance", DynValue.NewNumber(rh.distance));
            result.Set("name",     DynValue.NewString(rh.collider.gameObject.name));
            result.Set("tag",      DynValue.NewString(rh.collider.gameObject.tag));
            var n = new Table(null);
            n.Set("x", DynValue.NewNumber(rh.normal.x));
            n.Set("y", DynValue.NewNumber(rh.normal.y));
            n.Set("z", DynValue.NewNumber(rh.normal.z));
            result.Set("normal", DynValue.NewTable(n));
        }
        else
        {
            result.Set("hit", DynValue.False);
        }
        return result;
    });

    public void SetGravity(float g) => _runner.RunOnMainThread<object>(() =>
    { Physics.gravity = new Vector3(0, g, 0); return null; });
}

// ── EffectsProxy ──────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class EffectsProxy
{
    private readonly LuauGameRunner _runner;
    public EffectsProxy(LuauGameRunner r) { _runner = r; }

    public void Spawn(string preset, float x, float y, float z)
        => _runner.SpawnEffect(preset, new Vector3(x, y, z));

    public void ScreenShake(float intensity, float dur) => _runner.RequestScreenShake(intensity, dur);

    public void Flash(DynValue color, float dur)
        => _runner.RequestFlash(SceneProxy.DynToColor(color, Color.red), dur);
}

// ── TimerProxy ────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class TimerProxy
{
    private readonly LuauGameRunner _runner;
    public TimerProxy(LuauGameRunner r) { _runner = r; }

    public int After(float secs, DynValue cb) => _runner.RegisterTimerAfter(secs, cb);
    public int Every(float secs, DynValue cb) => _runner.RegisterTimerEvery(secs, cb);
    public void Cancel(int handle)            => _runner.CancelTimer(handle);
}

// ── EnvironmentProxy ──────────────────────────────────────────────────────────
[MoonSharpUserData]
public class EnvironmentProxy
{
    private readonly ObjectFactory _factory;
    private readonly LuauGameRunner _runner;
    public EnvironmentProxy(ObjectFactory f, LuauGameRunner r) { _factory = f; _runner = r; }

    public LuaObject SpawnObject(string type, float x, float y, float z)
    {
        var obj = _factory.Create(type);
        obj.SetPosition(x, y, z);
        return obj;
    }

    public void SetWeather(string preset) => Debug.Log($"[Luau] Environment.SetWeather({preset})");

    public void SetTimeOfDay(float hour) => _runner.RunOnMainThread<object>(() =>
    {
        var dl = UnityEngine.Object.FindAnyObjectByType<Light>();
        if (dl && dl.type == LightType.Directional)
            dl.transform.eulerAngles = new Vector3((hour / 24f) * 360f - 90f, 30f, 0f);
        return null;
    });
}

// ── InputProxy ────────────────────────────────────────────────────────────────
[MoonSharpUserData]
public class InputProxy
{
    private readonly LuauGameRunner _runner;
    private readonly Dictionary<string, DynValue> _keyCallbacks = new();
    private DynValue _onActionCb = DynValue.Nil;
    private DynValue _onSwipeCb  = DynValue.Nil;

    private static readonly Dictionary<string, KeyCode> KeyAliases = new(System.StringComparer.OrdinalIgnoreCase)
    {
        ["space"]  = KeyCode.Space,
        ["e"]      = KeyCode.E,
        ["f"]      = KeyCode.F,
        ["r"]      = KeyCode.R,
        ["q"]      = KeyCode.Q,
        ["1"]      = KeyCode.Alpha1,
        ["2"]      = KeyCode.Alpha2,
        ["3"]      = KeyCode.Alpha3,
        ["shift"]  = KeyCode.LeftShift,
        ["ctrl"]   = KeyCode.LeftControl,
        ["tab"]    = KeyCode.Tab,
        ["enter"]  = KeyCode.Return,
    };

    public InputProxy(LuauGameRunner r) { _runner = r; }

    public void OnKey(string key, DynValue cb)
    {
        if (KeyAliases.TryGetValue(key, out _) || System.Enum.IsDefined(typeof(KeyCode), key))
            _keyCallbacks[key] = cb;
    }

    public void OnAction(DynValue cb) => _onActionCb = cb;
    public void OnSwipe(DynValue cb)  => _onSwipeCb  = cb;

    internal void CheckInput()
    {
        foreach (var kv in _keyCallbacks)
        {
            KeyCode code = KeyAliases.TryGetValue(kv.Key, out var aliased)
                ? aliased
                : (System.Enum.TryParse<KeyCode>(kv.Key, true, out var parsed) ? parsed : KeyCode.None);
            if (code != KeyCode.None && UnityEngine.Input.GetKeyDown(code))
                _runner.CallLua(kv.Value);
        }
        if (_onActionCb.Type == DataType.Function && UnityEngine.Input.GetKeyDown(KeyCode.E))
            _runner.CallLua(_onActionCb);
    }

    internal void FireSwipe(string direction)
    {
        if (_onSwipeCb.Type == DataType.Function)
            _runner.CallLua(_onSwipeCb, DynValue.NewString(direction));
    }
}

// ── LuauPlayerController ──────────────────────────────────────────────────────
// Local player movement on the shared kinematic RobloxCharacterMotor (walls,
// steps, ceilings, no falling through the baseplate). The Rigidbody stays on
// the player only so triggers keep firing; it is kinematic and never simulated.
// In server-hosted play GameRenderClient runs the same motor in its predictor
// and sets ExternallyDriven, so this component only carries speed/jump config.
public class LuauPlayerController : MonoBehaviour
{
    private float     _speed      = RobloxPhysics.WalkSpeed;
    private float     _jumpHeight = RobloxPhysics.JumpHeight;
    private Rigidbody _rb;
    private Collider  _col;

    private RobloxCharacterMotor.State _s;
    private Vector3 _prevPos;        // last substep, for render interpolation
    private Vector3 _lastWritten;    // what we last put on transform.position
    private float   _accum;
    private bool    _ready;
    private bool    _jumpQueued;
    private readonly HashSet<Collider> _touching = new();
    private readonly HashSet<Collider> _touchNow = new();

    /// <summary>GameRenderClient drives movement itself (server-hosted play).</summary>
    public bool ExternallyDriven;

    public bool    IsGrounded => _s.Grounded;
    public Vector3 Velocity   => _s.Vel;

    public void Init(float speed, float jumpHeight)
    {
        _speed      = speed;
        _jumpHeight = Mathf.Max(jumpHeight, 0.1f);
    }

    public void SetVelocity(Vector3 v) => _s.Vel = v;

    private void Awake()
    {
        _rb  = GetComponent<Rigidbody>();
        _col = GetComponent<CapsuleCollider>();
        if (_rb != null)
        {
            _rb.isKinematic   = true;
            _rb.useGravity    = false;
            _rb.interpolation = RigidbodyInterpolation.None; // we write the transform ourselves
        }
    }

    private void Resync()
    {
        _s = new RobloxCharacterMotor.State { Pos = transform.position, LastGroundedAt = -999f };
        _prevPos = _lastWritten = transform.position;
        _accum = 0f;
        _ready = true;
    }

    private void Update()
    {
        if (ExternallyDriven) return;

        // Anything else that moved us (spawn, Player.SetPosition, respawn,
        // void reset) wrote transform.position directly — treat it as a
        // teleport and restart the motor there with no velocity.
        if (!_ready || (transform.position - _lastWritten).sqrMagnitude > 1e-6f) Resync();

        // Joystick (mobile) takes priority; fall back to keyboard on desktop
        var joy = MobileGameInput.MoveInput;
        float h = Mathf.Abs(joy.x) > 0.05f ? joy.x : Input.GetAxis("Horizontal");
        float v = Mathf.Abs(joy.y) > 0.05f ? joy.y : Input.GetAxis("Vertical");

        Vector3 fwd = Vector3.forward, right = Vector3.right;
        if (Camera.main != null)
        {
            fwd   = Camera.main.transform.forward; fwd.y   = 0f;
            fwd   = fwd.sqrMagnitude > 1e-6f ? fwd.normalized : Vector3.forward;
            right = Camera.main.transform.right;   right.y = 0f;
            right = right.sqrMagnitude > 1e-6f ? right.normalized : Vector3.right;
        }
        var input = fwd * v + right * h;
        if (input.sqrMagnitude > 1f) input.Normalize();

        if (MobileGameInput.JumpPressed || Input.GetButtonDown("Jump") || Input.GetKeyDown(KeyCode.Space))
            _jumpQueued = true;
        // Roblox: holding jump keeps hopping every time you land.
        bool held = MobileGameInput.JumpHeld || Input.GetKey(KeyCode.Space);

        float gravity = Physics.gravity.y;
        RobloxCharacterMotor.Touched.Clear();
        _accum = Mathf.Min(_accum + Time.deltaTime, 0.25f);
        while (_accum >= RobloxCharacterMotor.Substep)
        {
            _accum  -= RobloxCharacterMotor.Substep;
            _prevPos = _s.Pos;
            bool want = _jumpQueued || (held && _s.Grounded);
            RobloxCharacterMotor.Step(ref _s, new Vector2(input.x, input.z), want, _speed, _jumpHeight,
                                      gravity, Time.time, transform, _col);
            _jumpQueued = false; // one press = one attempt (coyote time covers ledges)
        }

        RaiseTouched();

        // Render between the last two substeps: smooth at any refresh rate,
        // and never ahead of the swept (collision-checked) position.
        var render = Vector3.Lerp(_prevPos, _s.Pos, _accum / RobloxCharacterMotor.Substep);
        transform.position = render;
        _lastWritten = render;

        // Only self-rotate toward movement when shift lock is off;
        // with shift lock on, LuauOrbitCamera.LateUpdate overrides rotation.
        var flat = new Vector3(_s.Vel.x, 0f, _s.Vel.z);
        if (!LuauOrbitCamera.ShiftLock && flat.sqrMagnitude > 0.04f)
            transform.rotation = Quaternion.Slerp(
                transform.rotation, Quaternion.LookRotation(flat), Time.deltaTime * 20f);
    }

    // Fire Lua collision callbacks when the player starts touching an object
    // (the kinematic capsule never produces OnCollisionEnter on its own).
    private void RaiseTouched()
    {
        _touchNow.Clear();
        foreach (var c in RobloxCharacterMotor.Touched) if (c != null) _touchNow.Add(c);
        foreach (var c in _touchNow)
        {
            if (_touching.Contains(c)) continue;
            var handler = c.GetComponentInParent<LuaCollisionHandler>();
            if (handler != null) handler.NotifyTouch(gameObject);
        }
        _touching.Clear();
        foreach (var c in _touchNow) _touching.Add(c);
    }
}

// ── LuauOrbitCamera ───────────────────────────────────────────────────────────
// Roblox-style third-person orbit camera.
//   Touch: single finger on right side = orbit | two fingers = pinch-zoom
//   Desktop/Simulator: left-drag (right side) or right-drag = orbit | scroll = zoom
//   ShiftLock: player always faces camera forward direction.
public class LuauOrbitCamera : MonoBehaviour
{
    private Transform _target;

    private float _yaw   =   0f;
    private float _pitch =  20f;
    private float _dist  =   7f;

    private const float PitchMin  = -89f;
    private const float PitchMax  =  80f;
    private const float DistMin   =   0.6f;  // allow zooming all the way in to first-person
    private const float DistMax   =  18f;
    private const float TouchSens =   0.30f;
    private const float MouseSens =   0.4f;

    // First-person engages when zoomed nearly all the way in. Hysteresis so it
    // doesn't flicker right at the boundary while scrolling.
    private const float FirstPersonEnter = 1.4f;
    private const float FirstPersonExit  = 2.2f;
    private const float CamRadius        = 0.25f; // near-plane clearance for occlusion casts
    private bool    _firstPerson;
    private bool    _haveSmoothedPos;
    private float   _camDist;
    private readonly Collider[] _overlaps = new Collider[8];

    // Shift lock: player Y rotation tracks camera yaw
    public static bool ShiftLock { get; private set; }
    public static void ToggleShiftLock() => ShiftLock = !ShiftLock;

    private int     _orbitFingerId = -1;
    private Vector2 _lastOrbitPos;
    private bool    _pinching;
    private float   _lastPinchDist;
    private int     _postPinchFrames;  // frames remaining before orbit can resume after pinch
    private bool    _mouseOrbitActive;
    private Vector3    _pivotOffset    = new Vector3(0f, 1f, 0f);
    private Renderer[] _avatarRenderers;
    private bool       _aimHeightCaptured;  // capture rest-pose framing height once
    private float      _aimHeight;          // fixed Y offset above root, immune to animation

    public void SetTarget(Transform t)                   { _target = t; }
    public void SetPivotOffset(Vector3 offset)           { _pivotOffset = offset; }
    public void SetAvatarRenderers(Renderer[] renderers) { _avatarRenderers = renderers; }

    private void LateUpdate()
    {
        if (_target == null) return;
        HandleTouchInput();
        HandleMouseInput();

        // Lock the aim to the ROOT transform plus a fixed height offset so the
        // camera is completely immune to animation / bone movement. The height
        // is captured ONCE from the avatar's rest-pose bounds to preserve the
        // original framing, then held constant forever after.
        if (!_aimHeightCaptured)
        {
            if (_avatarRenderers != null && _avatarRenderers.Length > 0)
            {
                bool any = false;
                Bounds b = default;
                foreach (var r in _avatarRenderers)
                {
                    if (r == null || !r.enabled) continue;
                    if (!any) { b = r.bounds; any = true; }
                    else b.Encapsulate(r.bounds);
                }
                if (any)
                {
                    _aimHeight = b.center.y - _target.position.y;
                    _aimHeightCaptured = true;
                }
            }

            if (!_aimHeightCaptured)
                _aimHeight = _pivotOffset.y;  // fallback until renderers exist
        }

        Vector3 aim = new Vector3(_target.position.x,
                                  _target.position.y + _aimHeight,
                                  _target.position.z);

        // First-person toggle with hysteresis based on zoom distance.
        if (!_firstPerson && _dist <= FirstPersonEnter) SetFirstPerson(true);
        else if (_firstPerson && _dist >= FirstPersonExit) SetFirstPerson(false);

        var rot = Quaternion.Euler(_pitch, _yaw, 0f);

        if (_firstPerson)
        {
            // Eye at head height, looking along yaw/pitch. Rigid (no spring) so
            // the look feels direct, and the body turns with the camera.
            transform.position = aim;
            transform.rotation = rot;
            _target.rotation   = Quaternion.Euler(0f, _yaw, 0f);
            _haveSmoothedPos   = false;  // re-seed spring on exit so it doesn't lurch
        }
        else
        {
            // Roblox camera: rigidly attached to the subject (no positional
            // spring). The old spring lagged the avatar's jump arc while LookAt
            // tracked it exactly, so every jump tilted and bobbed the view —
            // the "camera shake". The motor now renders the avatar smoothly,
            // so following it 1:1 is smooth too.
            Vector3 back = rot * Vector3.back;

            // Occlusion: never put the camera inside or behind geometry. Pull
            // in instantly when something is between camera and character;
            // ease back out once it clears (like Roblox's Popper).
            float allowed = _dist;
            if (Physics.SphereCast(aim, CamRadius, back, out var hit, _dist, ~0, QueryTriggerInteraction.Ignore)
                && !hit.collider.transform.IsChildOf(_target))
                allowed = Mathf.Max(DistMin * 0.5f, hit.distance - CamRadius * 0.5f);
            else
            {
                // SphereCast skips colliders it starts inside; catch walls the
                // character is pressed against with an overlap at the aim point.
                int n = Physics.OverlapSphereNonAlloc(aim, CamRadius, _overlaps, ~0, QueryTriggerInteraction.Ignore);
                for (int i = 0; i < n; i++)
                    if (_overlaps[i] != null && !_overlaps[i].transform.IsChildOf(_target)) { allowed = DistMin * 0.5f; break; }
            }
            if (!_haveSmoothedPos || allowed < _camDist) _camDist = allowed;   // snap in
            else _camDist = Mathf.MoveTowards(_camDist, allowed, Time.deltaTime * 12f); // ease out
            _haveSmoothedPos = true;

            transform.position = aim + back * _camDist;
            transform.rotation = rot;

            // Shift lock: force player to face camera direction
            if (ShiftLock)
                _target.rotation = Quaternion.Euler(0f, _yaw, 0f);
        }
    }

    private void SetFirstPerson(bool on)
    {
        _firstPerson = on;
        // Hide/show the local avatar so we don't render the inside of the mesh
        // while in first-person.
        if (_avatarRenderers != null)
            foreach (var r in _avatarRenderers)
                if (r != null) r.enabled = !on;
    }

    private void HandleTouchInput()
    {
        int tc = Input.touchCount;

        // ── Pinch zoom: two fingers that are NOT claimed by joystick/jump ────────
        if (tc >= 2)
        {
            // Find two unclaimed fingers
            Touch? ua = null, ub = null;
            for (int i = 0; i < tc && (ua == null || ub == null); i++)
            {
                var t = Input.GetTouch(i);
                if (MobileGameInput.ClaimedFingerIds.Contains(t.fingerId)) continue;
                if (ua == null) ua = t; else ub = t;
            }

            if (ua != null && ub != null)
            {
                float d = Vector2.Distance(ua.Value.position, ub.Value.position);
                if (!_pinching)
                {
                    _pinching      = true;
                    _lastPinchDist = d;
                    _orbitFingerId = -1;
                }
                else
                {
                    float delta = d - _lastPinchDist;
                    _dist = Mathf.Clamp(_dist - delta * 0.04f, DistMin, DistMax);
                    _lastPinchDist = d;
                }
                return;
            }
        }
        if (_pinching)
        {
            _pinching        = false;
            _postPinchFrames = 3;  // mutex: lock out orbit for 3 frames after pinch ends
        }

        // ── Single-finger orbit on the right half of the screen ──────────────────
        if (_postPinchFrames > 0) { _postPinchFrames--; return; }
        for (int i = 0; i < tc; i++)
        {
            var t = Input.GetTouch(i);
            if (_orbitFingerId < 0)
            {
                if (t.phase == TouchPhase.Began
                    && t.position.x > Screen.width * 0.45f
                    && !MobileGameInput.ClaimedFingerIds.Contains(t.fingerId))
                { _orbitFingerId = t.fingerId; _lastOrbitPos = t.position; }
            }
            else if (t.fingerId == _orbitFingerId)
            {
                if (t.phase == TouchPhase.Moved)
                {
                    var d = t.position - _lastOrbitPos;
                    _yaw   += d.x * TouchSens;
                    _pitch  = Mathf.Clamp(_pitch - d.y * TouchSens, PitchMin, PitchMax);
                    _lastOrbitPos = t.position;
                }
                else if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
                    _orbitFingerId = -1;
            }
        }
    }

    private void HandleMouseInput()
    {
        if (Input.touchCount > 0) { _mouseOrbitActive = false; return; }

        // Left mouse on the right side of screen = orbit; right mouse anywhere = orbit
        if (Input.GetMouseButtonDown(0) && Input.mousePosition.x > Screen.width * 0.55f)
            _mouseOrbitActive = true;
        if (!Input.GetMouseButton(0))
            _mouseOrbitActive = false;

        if ((_mouseOrbitActive && Input.GetMouseButton(0)) || Input.GetMouseButton(1))
        {
            _yaw   += Input.GetAxis("Mouse X") * MouseSens * 4f;
            _pitch  = Mathf.Clamp(_pitch - Input.GetAxis("Mouse Y") * MouseSens * 4f, PitchMin, PitchMax);
        }

        // Scroll wheel zoom — works in Unity Editor Game View and on desktop builds
        float scroll = Input.mouseScrollDelta.y;
        if (Mathf.Abs(scroll) > 0.001f)
            _dist = Mathf.Clamp(_dist - scroll * 1.5f, DistMin, DistMax);
    }
}
