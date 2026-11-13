using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Rendering.Universal;

// Pludo Model Studio — build 3D models by hand from parts (Roblox Studio
// style), no AI. Runs in its own isolated corner of the world with its own
// camera/light, driven by the native shell's Liquid Glass chrome:
//
//   Host → Unity : NativeShell.OpenModelStudio("") · CloseModelStudio("")
//                  NativeShell.StudioCommand("<cmd>:<arg>")
//   Unity → Host : {"type":"studioState", …}  after every change
//                  {"type":"studioPublished", ok, error?, name?, destination?}
//
// Touch: tap a part to select it, tap empty space to deselect. One finger on
// the selected part runs the current tool (move / rotate / scale); one finger
// elsewhere orbits; two fingers pinch-zoom and pan. The draft autosaves to
// PlayerPrefs so leaving the studio never loses work.
public class ModelStudio : MonoBehaviour
{
    public static ModelStudio Instance { get; private set; }
    public static bool IsOpen => Instance != null && Instance._open;

    // Far from every game/editor/avatar scene so nothing overlaps.
    private static readonly Vector3 Origin = new(0f, 0f, 9000f);
    private const int   Layer      = 30;
    private const int   MaxParts   = 200;
    private const string DraftKey  = "ModelStudioDraft.v1";
    private const float GroundSize = 12f;

    [Serializable]
    private class PartData
    {
        public int     id;
        public string  shape = "block";
        public float[] p = { 0, 0.5f, 0 };
        public float[] r = { 0, 0, 0 };
        public float[] s = { 1, 1, 1 };
        public string  c = "#4C9AFF";
        public string  m = "plastic";
    }

    private class Part
    {
        public PartData   Data;
        public GameObject Go;
        public Material   Mat;
    }

    private bool _open;
    private GameObject _root, _partsRoot, _ground, _lightGo;
    private Camera _cam;
    private readonly List<Part> _parts = new();
    private int _nextId = 1;
    private Part _selected;
    private string _tool = "move";      // move | rotate | scale
    private bool   _snap = true;
    private readonly List<string> _undo = new();
    private readonly List<string> _redo = new();
    private bool _publishing;

    // Camera orbit
    private float _yaw = 35f, _pitch = 25f, _dist = 7f;
    private Vector3 _pivot = new(0f, 0.8f, 0f);

    // Touch state
    private int     _fingerId = -1;
    private Vector2 _downPos, _lastPos;
    private float   _downTime;
    private bool    _dragging, _manipulating;
    private Vector3 _grabOffset;
    private Plane   _dragPlane;
    private float   _lastPinch;
    private Vector2 _lastMid;
    private bool    _twoFinger;
    private Color   _savedAmbient;

    private static readonly Dictionary<string, Mesh> Meshes = new();

    public static ModelStudio Ensure()
    {
        if (Instance != null) return Instance;
        var go = new GameObject("ModelStudio");
        DontDestroyOnLoad(go);
        Instance = go.AddComponent<ModelStudio>();
        return Instance;
    }

    // ── Open / close ─────────────────────────────────────────────────────────

    public void Open()
    {
        if (_open) { PushState(); return; }
        _open = true;
        BuildScene();
        LoadDraft();
        _savedAmbient = RenderSettings.ambientLight;
        RenderSettings.ambientLight = new Color(0.42f, 0.44f, 0.50f);
        PushState();
    }

    public void Close()
    {
        if (!_open) return;
        SaveDraft();
        _open = false;
        RenderSettings.ambientLight = _savedAmbient;
        if (_root != null) Destroy(_root);
        _root = null; _parts.Clear(); _selected = null;
        Send("{\"type\":\"studioState\",\"open\":false}");
    }

    private void BuildScene()
    {
        _root = new GameObject("ModelStudioRoot");
        _root.transform.position = Origin;
        _partsRoot = new GameObject("Parts");
        _partsRoot.transform.SetParent(_root.transform, false);

        // Grid ground (visual only; parts may go below it).
        _ground = GameObject.CreatePrimitive(PrimitiveType.Quad);
        _ground.name = "Grid";
        Destroy(_ground.GetComponent<Collider>());
        _ground.transform.SetParent(_root.transform, false);
        _ground.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
        _ground.transform.localScale = new Vector3(GroundSize, GroundSize, 1f);
        _ground.layer = Layer;
        var gm = new Material(Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Texture"));
        gm.mainTexture = GridTexture();
        gm.mainTextureScale = new Vector2(GroundSize, GroundSize);
        if (gm.HasProperty("_BaseMap")) { gm.SetTexture("_BaseMap", gm.mainTexture); gm.SetTextureScale("_BaseMap", gm.mainTextureScale); }
        _ground.GetComponent<MeshRenderer>().sharedMaterial = gm;

        // Own camera + key light so the studio looks the same whatever else is loaded.
        var camGo = new GameObject("ModelStudioCamera");
        camGo.transform.SetParent(_root.transform, false);
        _cam = camGo.AddComponent<Camera>();
        _cam.clearFlags = CameraClearFlags.SolidColor;
        _cam.backgroundColor = new Color(0.11f, 0.12f, 0.15f);
        _cam.cullingMask = 1 << Layer;
        _cam.depth = 90;   // above game/avatar cameras
        _cam.nearClipPlane = 0.05f;
        _cam.fieldOfView = 45f;
        camGo.AddComponent<UniversalAdditionalCameraData>();

        _lightGo = new GameObject("ModelStudioLight");
        _lightGo.transform.SetParent(_root.transform, false);
        _lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        var l = _lightGo.AddComponent<Light>();
        l.type = LightType.Directional;
        l.intensity = 0.85f;
        l.shadows = LightShadows.Soft;
        l.cullingMask = 1 << Layer;
        UpdateCamera();
    }

    private static Texture2D GridTexture()
    {
        const int n = 64;
        var t = new Texture2D(n, n, TextureFormat.RGBA32, true) { wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Trilinear, anisoLevel = 4 };
        var bg = new Color(0.17f, 0.18f, 0.22f);
        var ln = new Color(0.30f, 0.32f, 0.38f);
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
                t.SetPixel(x, y, (x < 2 || y < 2) ? ln : bg);
        t.Apply();
        return t;
    }

    // ── Commands from the host ───────────────────────────────────────────────

    public void Command(string raw)
    {
        if (!_open || string.IsNullOrEmpty(raw)) return;
        int colon = raw.IndexOf(':');
        string cmd = colon < 0 ? raw : raw.Substring(0, colon);
        string arg = colon < 0 ? "" : raw.Substring(colon + 1);
        switch (cmd)
        {
            case "add":       Checkpoint(); AddPart(arg); break;
            case "delete":    if (_selected != null) { Checkpoint(); RemovePart(_selected); } break;
            case "duplicate": if (_selected != null) { Checkpoint(); Duplicate(_selected); } break;
            case "deselect":  Select(null); break;
            case "color":     if (_selected != null) { Checkpoint(); _selected.Data.c = arg; ApplyLook(_selected); } break;
            case "material":  if (_selected != null) { Checkpoint(); _selected.Data.m = arg; ApplyLook(_selected); } break;
            case "tool":      _tool = arg is "rotate" or "scale" ? arg : "move"; break;
            case "snap":      _snap = arg == "1"; break;
            case "set":       if (_selected != null) { Checkpoint(); SetTransform(_selected, arg); } break;
            case "undo":      Undo(); break;
            case "redo":      Redo(); break;
            case "clear":     Checkpoint(); while (_parts.Count > 0) RemovePart(_parts[0]); break;
            case "frame":     FrameAll(); break;
            case "publish":   if (!_publishing) StartCoroutine(Publish(arg)); break;
        }
        SaveDraft();
        PushState();
    }

    // ── Parts ────────────────────────────────────────────────────────────────

    private void AddPart(string shape)
    {
        if (_parts.Count >= MaxParts) return;
        var d = new PartData { id = _nextId++, shape = NormalizeShape(shape) };
        // Drop new parts at the camera pivot so they appear where you're looking.
        var at = _selected != null ? _selected.Go.transform.localPosition + Vector3.up * 1.05f
                                   : new Vector3(_pivot.x, 0.5f, _pivot.z);
        if (_snap) at = SnapV(at, 0.25f);
        d.p = new[] { at.x, Mathf.Max(at.y, 0.5f), at.z };
        if (_selected != null) { d.c = _selected.Data.c; d.m = _selected.Data.m; }
        var part = Spawn(d);
        Select(part);
    }

    private static string NormalizeShape(string s) => s switch
    {
        "sphere" or "cylinder" or "cone" or "wedge" or "torus" or "pill" => s,
        _ => "block",
    };

    private Part Spawn(PartData d)
    {
        var go = new GameObject($"Part{d.id}") { layer = Layer };
        go.transform.SetParent(_partsRoot.transform, false);
        var mesh = MeshFor(d.shape);
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        var mat = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        mr.sharedMaterial = mat;
        var mc = go.AddComponent<MeshCollider>();
        mc.sharedMesh = mesh;
        var part = new Part { Data = d, Go = go, Mat = mat };
        ApplyTransform(part);
        ApplyLook(part);
        _parts.Add(part);
        return part;
    }

    private void RemovePart(Part p)
    {
        if (p == null) return;
        if (_selected == p) _selected = null;
        _parts.Remove(p);
        Destroy(p.Go);
        Destroy(p.Mat);
    }

    private void Duplicate(Part src)
    {
        var d = JsonConvert.DeserializeObject<PartData>(JsonConvert.SerializeObject(src.Data));
        d.id = _nextId++;
        d.p[0] += 0.5f; d.p[2] += 0.5f;
        Select(Spawn(d));
    }

    private void ApplyTransform(Part p)
    {
        var t = p.Go.transform;
        t.localPosition = new Vector3(p.Data.p[0], p.Data.p[1], p.Data.p[2]);
        t.localRotation = Quaternion.Euler(p.Data.r[0], p.Data.r[1], p.Data.r[2]);
        t.localScale    = new Vector3(p.Data.s[0], p.Data.s[1], p.Data.s[2]);
    }

    private void CaptureTransform(Part p)
    {
        var t = p.Go.transform;
        var e = t.localEulerAngles;
        p.Data.p = new[] { t.localPosition.x, t.localPosition.y, t.localPosition.z };
        p.Data.r = new[] { Wrap(e.x), Wrap(e.y), Wrap(e.z) };
        p.Data.s = new[] { t.localScale.x, t.localScale.y, t.localScale.z };
    }

    private static float Wrap(float a) { a %= 360f; return a > 180f ? a - 360f : a; }

    private void SetTransform(Part p, string json)
    {
        try
        {
            var o = JObject.Parse(json);
            float G(string k, float def) => o[k] != null ? o[k].Value<float>() : def;
            p.Data.p = new[] { G("px", p.Data.p[0]), G("py", p.Data.p[1]), G("pz", p.Data.p[2]) };
            p.Data.r = new[] { G("rx", p.Data.r[0]), G("ry", p.Data.r[1]), G("rz", p.Data.r[2]) };
            p.Data.s = new[] { Mathf.Clamp(G("sx", p.Data.s[0]), 0.05f, 50f), Mathf.Clamp(G("sy", p.Data.s[1]), 0.05f, 50f), Mathf.Clamp(G("sz", p.Data.s[2]), 0.05f, 50f) };
            ApplyTransform(p);
        }
        catch (Exception e) { Debug.LogWarning("[ModelStudio] bad set: " + e.Message); }
    }

    private static void MaterialParams(string m, out float metallic, out float smooth, out bool emissive, out float alpha)
    {
        metallic = 0f; smooth = 0.35f; emissive = false; alpha = 1f;
        switch (m)
        {
            case "metal": metallic = 1f;  smooth = 0.75f; break;
            case "neon":  emissive = true; smooth = 0.5f; break;
            case "glass": smooth = 0.95f; alpha = 0.45f; break;
            case "matte": smooth = 0.05f; break;
        }
    }

    private void ApplyLook(Part p)
    {
        if (!ColorUtility.TryParseHtmlString(p.Data.c, out var col)) col = Color.white;
        MaterialParams(p.Data.m, out var metal, out var smooth, out var emissive, out var alpha);
        var mat = p.Mat;
        col.a = alpha;
        mat.SetColor("_BaseColor", col);
        mat.SetFloat("_Metallic", metal);
        mat.SetFloat("_Smoothness", smooth);
        if (emissive) { mat.EnableKeyword("_EMISSION"); mat.SetColor("_EmissionColor", col * 1.6f); }
        else          { mat.DisableKeyword("_EMISSION"); mat.SetColor("_EmissionColor", Color.black); }
        bool transparent = alpha < 0.999f;
        mat.SetFloat("_Surface", transparent ? 1f : 0f);
        mat.SetFloat("_Blend", 0f);
        mat.SetFloat("_SrcBlend", transparent ? (float)UnityEngine.Rendering.BlendMode.SrcAlpha : 1f);
        mat.SetFloat("_DstBlend", transparent ? (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha : 0f);
        mat.SetFloat("_ZWrite", transparent ? 0f : 1f);
        if (transparent) mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT"); else mat.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
        mat.renderQueue = transparent ? 3000 : -1;
        HighlightSelection();
    }

    private void Select(Part p)
    {
        _selected = p;
        HighlightSelection();
    }

    // Selected part gets a subtle rim-light via emission so it reads as picked
    // without hiding its real colour.
    private void HighlightSelection()
    {
        foreach (var part in _parts)
        {
            MaterialParams(part.Data.m, out _, out _, out var emissive, out _);
            if (emissive) continue;
            if (part == _selected)
            {
                part.Mat.EnableKeyword("_EMISSION");
                // Neutral lift (not a hue) so the part's real colour still reads.
                part.Mat.SetColor("_EmissionColor", new Color(0.16f, 0.16f, 0.16f));
            }
            else
            {
                part.Mat.DisableKeyword("_EMISSION");
                part.Mat.SetColor("_EmissionColor", Color.black);
            }
        }
    }

    // ── Undo / draft ─────────────────────────────────────────────────────────

    private string Serialize() => JsonConvert.SerializeObject(new { next = _nextId, parts = _parts.ConvertAll(x => x.Data) });

    private void Restore(string json, int selectId = -1)
    {
        while (_parts.Count > 0) RemovePart(_parts[0]);
        try
        {
            var o = JObject.Parse(json);
            _nextId = o["next"]?.Value<int>() ?? 1;
            var arr = o["parts"]?.ToObject<List<PartData>>() ?? new List<PartData>();
            foreach (var d in arr)
            {
                if (d.p?.Length != 3 || d.r?.Length != 3 || d.s?.Length != 3) continue;
                var part = Spawn(d);
                if (d.id == selectId) _selected = part;
                _nextId = Mathf.Max(_nextId, d.id + 1);
            }
        }
        catch (Exception e) { Debug.LogWarning("[ModelStudio] restore failed: " + e.Message); }
        HighlightSelection();
    }

    private void Checkpoint()
    {
        _undo.Add(Serialize());
        if (_undo.Count > 60) _undo.RemoveAt(0);
        _redo.Clear();
    }

    private void Undo()
    {
        if (_undo.Count == 0) return;
        _redo.Add(Serialize());
        var s = _undo[^1]; _undo.RemoveAt(_undo.Count - 1);
        Restore(s, _selected?.Data.id ?? -1);
    }

    private void Redo()
    {
        if (_redo.Count == 0) return;
        _undo.Add(Serialize());
        var s = _redo[^1]; _redo.RemoveAt(_redo.Count - 1);
        Restore(s, _selected?.Data.id ?? -1);
    }

    private void SaveDraft() { if (_open) { PlayerPrefs.SetString(DraftKey, Serialize()); PlayerPrefs.Save(); } }

    private void LoadDraft()
    {
        _undo.Clear(); _redo.Clear();
        var s = PlayerPrefs.GetString(DraftKey, "");
        if (!string.IsNullOrEmpty(s)) Restore(s);
        _selected = null;
        HighlightSelection();
    }

    // ── State → host ─────────────────────────────────────────────────────────

    private void PushState()
    {
        if (!_open) return;
        object sel = null;
        if (_selected != null)
        {
            var d = _selected.Data;
            sel = new { id = d.id, shape = d.shape, color = d.c, material = d.m,
                        px = R(d.p[0]), py = R(d.p[1]), pz = R(d.p[2]),
                        rx = R(d.r[0]), ry = R(d.r[1]), rz = R(d.r[2]),
                        sx = R(d.s[0]), sy = R(d.s[1]), sz = R(d.s[2]) };
        }
        Send(JsonConvert.SerializeObject(new
        {
            type = "studioState", open = true, parts = _parts.Count, selected = sel,
            tool = _tool, snap = _snap, canUndo = _undo.Count > 0, canRedo = _redo.Count > 0,
            publishing = _publishing,
        }));
    }

    private static float R(float v) => Mathf.Round(v * 100f) / 100f;

    // ── Input ────────────────────────────────────────────────────────────────

    private void Update()
    {
        if (!_open || _cam == null) return;
        if (Input.touchCount > 0) HandleTouches();
        else HandleMouse();
        UpdateCamera();
    }

    private void HandleTouches()
    {
        if (Input.touchCount >= 2)
        {
            var a = Input.GetTouch(0); var b = Input.GetTouch(1);
            float d = Vector2.Distance(a.position, b.position);
            var mid = (a.position + b.position) * 0.5f;
            if (!_twoFinger) { _twoFinger = true; _lastPinch = d; _lastMid = mid; EndDrag(false); return; }
            _dist = Mathf.Clamp(_dist * (_lastPinch / Mathf.Max(d, 1f)), 1.2f, 40f);
            Pan(mid - _lastMid);
            _lastPinch = d; _lastMid = mid;
            return;
        }
        if (_twoFinger) { if (Input.touchCount == 0 || Input.GetTouch(0).phase == TouchPhase.Began) _twoFinger = false; else return; }

        var t = Input.GetTouch(0);
        Pointer(t.phase == TouchPhase.Began, t.phase == TouchPhase.Moved || t.phase == TouchPhase.Stationary,
                t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled, t.position);
    }

    private void HandleMouse()
    {
        if (Input.GetMouseButtonDown(0)) Pointer(true, false, false, Input.mousePosition);
        else if (Input.GetMouseButton(0)) Pointer(false, true, false, Input.mousePosition);
        else if (Input.GetMouseButtonUp(0)) Pointer(false, false, true, Input.mousePosition);
        float scroll = Input.mouseScrollDelta.y;
        if (Mathf.Abs(scroll) > 0.01f) _dist = Mathf.Clamp(_dist * (1f - scroll * 0.1f), 1.2f, 40f);
        if (Input.GetMouseButton(2)) Pan(new Vector2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y")) * 20f);
    }

    private void Pointer(bool down, bool held, bool up, Vector2 pos)
    {
        if (down)
        {
            _downPos = _lastPos = pos; _downTime = Time.unscaledTime;
            _dragging = false; _manipulating = false;
            var hit = Pick(pos);
            if (hit != null && hit == _selected)
            {
                _manipulating = true;
                Checkpoint();
                var tr = _selected.Go.transform;
                _dragPlane = new Plane(-_cam.transform.forward, tr.position);
                var ray = _cam.ScreenPointToRay(pos);
                _grabOffset = _dragPlane.Raycast(ray, out var e) ? tr.position - ray.GetPoint(e) : Vector3.zero;
            }
            return;
        }
        if (held)
        {
            var delta = pos - _lastPos;
            if (!_dragging && (pos - _downPos).magnitude > 8f) _dragging = true;
            if (_dragging)
            {
                if (_manipulating) Manipulate(pos, delta);
                else { _yaw += delta.x * 0.3f; _pitch = Mathf.Clamp(_pitch - delta.y * 0.3f, -10f, 85f); }
            }
            _lastPos = pos;
            return;
        }
        if (up)
        {
            bool tap = !_dragging && Time.unscaledTime - _downTime < 0.4f;
            if (tap) { Select(Pick(pos)); if (_manipulating) _undo.RemoveAt(_undo.Count - 1); }
            EndDrag(_manipulating && _dragging);
            PushState();
        }
    }

    private void EndDrag(bool committed)
    {
        if (committed && _selected != null) { CaptureTransform(_selected); SaveDraft(); }
        _dragging = false; _manipulating = false;
    }

    private void Manipulate(Vector2 pos, Vector2 delta)
    {
        var tr = _selected.Go.transform;
        switch (_tool)
        {
            case "rotate":
                tr.Rotate(Vector3.up, -delta.x * 0.5f, Space.World);
                tr.Rotate(_cam.transform.right, delta.y * 0.5f, Space.World);
                if (_snap)
                {
                    var e = tr.localEulerAngles;
                    tr.localRotation = Quaternion.Euler(SnapF(e.x, 15f), SnapF(e.y, 15f), SnapF(e.z, 15f));
                }
                break;
            case "scale":
            {
                float f = Mathf.Exp(delta.y * 0.006f);
                var s = tr.localScale * f;
                s = new Vector3(Mathf.Clamp(s.x, 0.05f, 50f), Mathf.Clamp(s.y, 0.05f, 50f), Mathf.Clamp(s.z, 0.05f, 50f));
                tr.localScale = s;
                break;
            }
            default:
            {
                var ray = _cam.ScreenPointToRay(pos);
                if (_dragPlane.Raycast(ray, out var e))
                {
                    var world = ray.GetPoint(e) + _grabOffset;
                    var local = _partsRoot.transform.InverseTransformPoint(world);
                    tr.localPosition = _snap ? SnapV(local, 0.25f) : local;
                }
                break;
            }
        }
        CaptureTransform(_selected);
        if (Time.frameCount % 6 == 0) PushState();
    }

    private void Pan(Vector2 screenDelta)
    {
        float k = _dist * 0.0018f;
        _pivot -= (_cam.transform.right * screenDelta.x + _cam.transform.up * screenDelta.y) * k;
        _pivot.y = Mathf.Clamp(_pivot.y, -5f, 20f);
    }

    private Part Pick(Vector2 screen)
    {
        var ray = _cam.ScreenPointToRay(screen);
        if (!Physics.Raycast(ray, out var hit, 500f, 1 << Layer, QueryTriggerInteraction.Ignore)) return null;
        return _parts.Find(x => x.Go == hit.collider.gameObject);
    }

    private void UpdateCamera()
    {
        if (_cam == null) return;
        var rot = Quaternion.Euler(_pitch, _yaw, 0f);
        var pivotWorld = Origin + _pivot;
        _cam.transform.SetPositionAndRotation(pivotWorld + rot * (Vector3.back * _dist), rot);
    }

    private void FrameAll()
    {
        if (_parts.Count == 0) { _pivot = new Vector3(0, 0.8f, 0); _dist = 7f; return; }
        var b = _parts[0].Go.GetComponent<Renderer>().bounds;
        foreach (var p in _parts) b.Encapsulate(p.Go.GetComponent<Renderer>().bounds);
        _pivot = b.center - Origin;
        _dist = Mathf.Clamp(b.extents.magnitude * 2.6f, 2f, 40f);
    }

    private static float SnapF(float v, float step) => Mathf.Round(v / step) * step;
    private static Vector3 SnapV(Vector3 v, float step) => new(SnapF(v.x, step), SnapF(v.y, step), SnapF(v.z, step));

    // ── Publish ──────────────────────────────────────────────────────────────

    [Serializable] private class PublishReq { public string name, destination, category, description, creatorName, userId; }

    private IEnumerator Publish(string json)
    {
        PublishReq req = null;
        try { req = JsonConvert.DeserializeObject<PublishReq>(json); } catch { }
        if (req == null || string.IsNullOrWhiteSpace(req.name)) { Published(false, "Give your model a name."); yield break; }
        if (_parts.Count == 0) { Published(false, "Add at least one part first."); yield break; }

        _publishing = true;
        PushState();
        var prevSel = _selected;
        Select(null);   // no selection tint in the thumbnail
        yield return null;

        byte[] glb, jpg;
        try
        {
            glb = BuildGlb();
            jpg = RenderThumbnail();
        }
        catch (Exception e)
        {
            _publishing = false; Select(prevSel);
            Published(false, "Couldn't export the model: " + e.Message);
            yield break;
        }

        var body = JsonConvert.SerializeObject(new
        {
            name = req.name.Trim(), destination = req.destination ?? "asset", category = req.category ?? "accessory",
            description = req.description ?? "", creatorName = req.creatorName ?? "Player", userId = req.userId ?? "",
            glbBase64 = Convert.ToBase64String(glb), thumbnailBase64 = Convert.ToBase64String(jpg),
        });
        var url = (PludoApiClient.BaseUrl ?? "").TrimEnd('/') + "/api/user-models";
        using var www = new UnityWebRequest(url, "POST")
        {
            uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body)),
            downloadHandler = new DownloadHandlerBuffer(),
            timeout = 60,
        };
        www.SetRequestHeader("Content-Type", "application/json");
        yield return www.SendWebRequest();

        _publishing = false;
        Select(prevSel);
        string err = null;
        if (www.result != UnityWebRequest.Result.Success)
        {
            try { err = JObject.Parse(www.downloadHandler.text)?["error"]?.Value<string>(); } catch { }
            err ??= www.error ?? "Upload failed.";
        }
        Published(err == null, err, req.name.Trim(), req.destination);
    }

    private void Published(bool ok, string error, string name = null, string destination = null)
    {
        Send(JsonConvert.SerializeObject(new { type = "studioPublished", ok, error, name, destination }));
        PushState();
    }

    // Parts relative to the model's footprint: centred on X/Z, resting on Y=0,
    // so the asset drops into games standing on the ground.
    private byte[] BuildGlb()
    {
        Bounds b = default; bool any = false;
        foreach (var p in _parts)
        {
            var rb = p.Go.GetComponent<Renderer>().bounds;
            if (!any) { b = rb; any = true; } else b.Encapsulate(rb);
        }
        var origin = new Vector3(b.center.x, b.min.y, b.center.z);
        var toExport = Matrix4x4.Translate(-origin);
        var list = new List<GlbWriter.Part>();
        foreach (var p in _parts)
        {
            ColorUtility.TryParseHtmlString(p.Data.c, out var col);
            MaterialParams(p.Data.m, out var metal, out var smooth, out var emissive, out var alpha);
            col.a = alpha;
            list.Add(new GlbWriter.Part
            {
                Name = $"{p.Data.shape}_{p.Data.id}",
                Mesh = p.Go.GetComponent<MeshFilter>().sharedMesh,
                LocalToExport = toExport * p.Go.transform.localToWorldMatrix,
                BaseColor = col, Metallic = metal, Roughness = 1f - smooth,
                Emissive = emissive ? col : Color.black,
            });
        }
        return GlbWriter.Write(list);
    }

    private byte[] RenderThumbnail()
    {
        const int size = 384;
        var savedPos = _cam.transform.position; var savedRot = _cam.transform.rotation;
        var savedBg = _cam.backgroundColor;
        _ground.SetActive(false);

        // Frame the model from a 3/4 view.
        var b = _parts[0].Go.GetComponent<Renderer>().bounds;
        foreach (var p in _parts) b.Encapsulate(p.Go.GetComponent<Renderer>().bounds);
        var rot = Quaternion.Euler(22f, 35f, 0f);
        float dist = b.extents.magnitude / Mathf.Sin(Mathf.Deg2Rad * _cam.fieldOfView * 0.5f) * 1.05f;
        _cam.transform.SetPositionAndRotation(b.center + rot * (Vector3.back * dist), rot);
        _cam.backgroundColor = new Color(0.20f, 0.22f, 0.27f);

        var rt = RenderTexture.GetTemporary(size, size, 24, RenderTextureFormat.ARGB32);
        var prevTarget = _cam.targetTexture;
        _cam.targetTexture = rt;
        _cam.Render();
        var prevActive = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(size, size, TextureFormat.RGB24, false);
        tex.ReadPixels(new Rect(0, 0, size, size), 0, 0);
        tex.Apply();
        RenderTexture.active = prevActive;
        _cam.targetTexture = prevTarget;
        RenderTexture.ReleaseTemporary(rt);

        _cam.transform.SetPositionAndRotation(savedPos, savedRot);
        _cam.backgroundColor = savedBg;
        _ground.SetActive(true);
        var jpg = tex.EncodeToJPG(85);
        Destroy(tex);
        return jpg;
    }

    // ── Meshes (all fit a 1×1×1 box centred on the origin) ──────────────────

    private static Mesh MeshFor(string shape)
    {
        if (Meshes.TryGetValue(shape, out var m) && m != null) return m;
        m = shape switch
        {
            "sphere"   => FromPrimitive(PrimitiveType.Sphere, Vector3.one),
            "cylinder" => FromPrimitive(PrimitiveType.Cylinder, new Vector3(1f, 0.5f, 1f)),
            "pill"     => FromPrimitive(PrimitiveType.Capsule, new Vector3(1f, 0.5f, 1f)),
            "cone"     => Cone(32),
            "wedge"    => Wedge(),
            "torus"    => Torus(32, 16, 0.35f, 0.15f),
            _          => FromPrimitive(PrimitiveType.Cube, Vector3.one),
        };
        m.name = "Studio_" + shape;
        Meshes[shape] = m;
        return m;
    }

    private static Mesh FromPrimitive(PrimitiveType type, Vector3 scale)
    {
        var go = GameObject.CreatePrimitive(type);
        var src = go.GetComponent<MeshFilter>().sharedMesh;
        var v = src.vertices;
        for (int i = 0; i < v.Length; i++) v[i] = Vector3.Scale(v[i], scale);
        var m = new Mesh { vertices = v, triangles = src.triangles, uv = src.uv };
        m.RecalculateNormals(); m.RecalculateBounds();
        if (type == PrimitiveType.Sphere || type == PrimitiveType.Capsule) m.normals = NormalsFrom(src, scale);
        Destroy(go);
        return m;
    }

    // Keep the primitive's smooth normals (RecalculateNormals would facet seams).
    private static Vector3[] NormalsFrom(Mesh src, Vector3 scale)
    {
        var n = src.normals;
        var inv = new Vector3(1f / scale.x, 1f / scale.y, 1f / scale.z);
        for (int i = 0; i < n.Length; i++) n[i] = Vector3.Scale(n[i], inv).normalized;
        return n;
    }

    private static Mesh Cone(int seg)
    {
        var v = new List<Vector3>(); var t = new List<int>();
        for (int i = 0; i < seg; i++)
        {
            float a0 = i * Mathf.PI * 2f / seg, a1 = (i + 1) * Mathf.PI * 2f / seg;
            var p0 = new Vector3(Mathf.Cos(a0) * 0.5f, -0.5f, Mathf.Sin(a0) * 0.5f);
            var p1 = new Vector3(Mathf.Cos(a1) * 0.5f, -0.5f, Mathf.Sin(a1) * 0.5f);
            int b = v.Count;
            v.Add(p0); v.Add(new Vector3(0, 0.5f, 0)); v.Add(p1);   // side
            t.Add(b); t.Add(b + 1); t.Add(b + 2);
            b = v.Count;
            v.Add(p0); v.Add(p1); v.Add(new Vector3(0, -0.5f, 0));  // base
            t.Add(b); t.Add(b + 1); t.Add(b + 2);
        }
        return Finish(v, t);
    }

    private static Mesh Wedge()
    {
        // Ramp rising toward +Z: full-height back face, sloped top.
        Vector3 a = new(-0.5f, -0.5f, -0.5f), b = new(0.5f, -0.5f, -0.5f), c = new(0.5f, -0.5f, 0.5f), d = new(-0.5f, -0.5f, 0.5f);
        Vector3 e = new(-0.5f, 0.5f, 0.5f), f = new(0.5f, 0.5f, 0.5f);
        var v = new List<Vector3>(); var t = new List<int>();
        void Tri(Vector3 x, Vector3 y, Vector3 z) { int i = v.Count; v.Add(x); v.Add(y); v.Add(z); t.Add(i); t.Add(i + 1); t.Add(i + 2); }
        void Quad(Vector3 x, Vector3 y, Vector3 z, Vector3 w) { Tri(x, y, z); Tri(x, z, w); }
        Quad(a, b, c, d);         // bottom (facing down)
        Quad(d, c, f, e);         // back (+Z)
        Quad(a, e, f, b);         // slope
        Tri(a, d, e);             // left side
        Tri(b, f, c);             // right side
        return Finish(v, t);
    }

    private static Mesh Torus(int seg, int side, float R, float r)
    {
        var v = new List<Vector3>(); var n = new List<Vector3>(); var t = new List<int>();
        for (int i = 0; i <= seg; i++)
        {
            float u = i * Mathf.PI * 2f / seg;
            var center = new Vector3(Mathf.Cos(u) * R, 0, Mathf.Sin(u) * R);
            for (int j = 0; j <= side; j++)
            {
                float w = j * Mathf.PI * 2f / side;
                var dir = new Vector3(Mathf.Cos(u) * Mathf.Cos(w), Mathf.Sin(w), Mathf.Sin(u) * Mathf.Cos(w));
                v.Add(center + dir * r); n.Add(dir);
            }
        }
        for (int i = 0; i < seg; i++)
            for (int j = 0; j < side; j++)
            {
                int a = i * (side + 1) + j, b = a + side + 1;
                t.Add(a); t.Add(a + 1); t.Add(b);
                t.Add(b); t.Add(a + 1); t.Add(b + 1);
            }
        var m = new Mesh(); m.SetVertices(v); m.SetNormals(n); m.SetTriangles(t, 0); m.RecalculateBounds();
        return m;
    }

    private static Mesh Finish(List<Vector3> v, List<int> t)
    {
        var m = new Mesh(); m.SetVertices(v); m.SetTriangles(t, 0);
        m.RecalculateNormals(); m.RecalculateBounds();
        return m;
    }

    private static void Send(string json) => NativeShellHost.Send(json);
}

// Unity → host messages, available whether or not the native-shell bridge is
// compiled in (the studio also runs in the Unity Editor for testing).
public static class NativeShellHost
{
#if UNITY_IOS && !UNITY_EDITOR && PLUDO_NATIVE_SHELL
    [System.Runtime.InteropServices.DllImport("__Internal")]
    private static extern void sendMessageToMobileApp(string message);
#endif
    public static void Send(string json)
    {
#if UNITY_IOS && !UNITY_EDITOR && PLUDO_NATIVE_SHELL
        sendMessageToMobileApp(json);
#else
        Debug.Log("[NativeShell] → host: " + json);
#endif
    }
}
