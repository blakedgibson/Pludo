using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

// Renders ONE other player in a multiplayer room: the chibi avatar, a floating
// username nametag, and chat bubbles. Driven entirely by network state pushed in
// via SetNetState() (position/velocity/grounded from the server's remotePlayers
// list). Reuses GameRenderClient's shared chibi builder + animation clips so the
// remote avatar looks and animates like the local one.
//
// Animation note: each remote owns its own hidden pose source and samples the
// shared (immutable) clips onto it, then copies bone rotations to its chibi —
// the same SampleAnimation approach the local player uses, just per-instance.
public class RemotePlayerAvatar : MonoBehaviour
{
    public string ClientId { get; private set; }

    private Dictionary<string, Transform> _bones;
    private Dictionary<string, Transform> _poseBones;
    private GameObject _poseSrc;
    private Dictionary<string, AnimationClip> _clips;
    private Dictionary<string, bool>          _clipLoops;
    private Transform _chibi;            // the ChibiVisual wrapper
    private string _currentState = "";
    private float  _playTime;
    private float  _stepTimer;

    // Network target state.
    private Vector3 _targetPos;
    private Vector3 _netVel;
    private bool    _grounded = true;
    private bool    _havePos;

    // Nametag + chat bubble (world-space, billboarded).
    private GameObject _bubble;
    private Text       _bubbleText;
    private float      _bubbleHideAt;
    private float      _topHeight = 2.2f;  // updated after scale; nametag/bubble sit above this

    private const string HipsName = "mixamorig:Hips";

    public void Init(string clientId, string username, Vector3 spawnPos)
    {
        ClientId   = clientId;
        _targetPos = spawnPos;
        _havePos   = true;
        transform.position = spawnPos;

        // Remote players use the default skin tint — per-player avatar
        // customization isn't carried over the wire yet (see editor plan).
        var bodyCol = new Color(0.83f, 0.64f, 0.51f);
        var wrapper = GameRenderClient.BuildChibiVisual(transform, bodyCol, out _bones);
        if (wrapper != null)
        {
            _chibi = wrapper.transform;
            _poseSrc = GameRenderClient.BuildPoseSource(out _poseBones);
            GameRenderClient.GetSharedClips(out _clips, out _clipLoops);
            SwitchAnim("idle");
            StartCoroutine(ScaleAndCenter());
        }

        BuildNametag(username);
    }

    public void SetNetState(Vector3 pos, Vector3 vel, bool grounded)
    {
        _targetPos = pos;
        _netVel    = vel;
        _grounded  = grounded;
        _havePos   = true;
    }

    // Scales the chibi to a 2 m height and centers it on the rotation pivot
    // (feet on root, body centered horizontally) — mirrors the local player's
    // DeferredAvatarScale so remote avatars don't sink, float, or turn widely.
    private IEnumerator ScaleAndCenter()
    {
        if (_chibi == null) yield break;
        _chibi.localScale    = Vector3.one;
        _chibi.localPosition = Vector3.zero;

        float renderedH = 0f, lo = 0f, centerX = 0f, centerZ = 0f;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            yield return new WaitForEndOfFrame();
            if (_chibi == null) yield break;
            float minY = float.MaxValue, maxY = float.MinValue;
            float minX = float.MaxValue, maxX = float.MinValue;
            float minZ = float.MaxValue, maxZ = float.MinValue;
            foreach (var r in _chibi.GetComponentsInChildren<Renderer>())
            {
                if (!r.enabled) continue;
                minY = Mathf.Min(minY, r.bounds.min.y); maxY = Mathf.Max(maxY, r.bounds.max.y);
                minX = Mathf.Min(minX, r.bounds.min.x); maxX = Mathf.Max(maxX, r.bounds.max.x);
                minZ = Mathf.Min(minZ, r.bounds.min.z); maxZ = Mathf.Max(maxZ, r.bounds.max.z);
            }
            if (minY >= float.MaxValue) continue;
            renderedH = maxY - minY; lo = minY;
            centerX = (minX + maxX) * 0.5f; centerZ = (minZ + maxZ) * 0.5f;
            if (renderedH >= 0.001f) break;
        }
        if (renderedH < 0.001f || _chibi == null) yield break;

        const float TargetH = 2f;
        float s = TargetH / renderedH;
        _chibi.localScale = Vector3.one * s;
        float halfHeight = (_chibi.position.y - lo) * s;
        float offX = (centerX - _chibi.position.x) * s;
        float offZ = (centerZ - _chibi.position.z) * s;
        _chibi.localPosition = new Vector3(-offX, halfHeight, -offZ);
        _topHeight = TargetH + 0.3f;
        if (_bubble != null) _bubble.transform.localPosition = new Vector3(0f, _topHeight, 0f);
    }

    private void LateUpdate()
    {
        // Smoothly chase the networked position (server streams at ~20 Hz).
        if (_havePos)
        {
            float a = 1f - Mathf.Exp(-18f * Time.deltaTime);
            transform.position = Vector3.Lerp(transform.position, _targetPos, a);
        }

        // Face the direction of travel (crisp, like the local player).
        Vector3 horiz = _netVel; horiz.y = 0f;
        if (horiz.sqrMagnitude > 0.04f)
        {
            var look = Quaternion.LookRotation(horiz.normalized, Vector3.up);
            transform.rotation = Quaternion.Slerp(transform.rotation, look, Time.deltaTime * 30f);
        }

        DriveAnimation();
        UpdateBubble();
    }

    private void DriveAnimation()
    {
        if (_poseSrc == null || _poseBones == null || _bones == null) return;

        float vy = _netVel.y;
        float hSpeed = new Vector2(_netVel.x, _netVel.z).magnitude;
        bool inAir = !_grounded;

        string next;
        if (inAir)
            next = vy > 0f ? "jumping-up" : "jumping-down";
        else
            next = hSpeed > (_currentState == "running" ? 2.5f : 3.5f) ? "running"
                 : hSpeed > (_currentState == "walking" ? 0.2f : 0.5f) ? "walking"
                 : "idle";
        SwitchAnim(next);

        // Footsteps for remote players too, so the world feels populated.
        if (!inAir && hSpeed > 0.3f)
        {
            _stepTimer -= Time.deltaTime;
            if (_stepTimer <= 0f) { GameAudio.PlaySound("step"); _stepTimer = Mathf.Clamp(2.2f / Mathf.Max(hSpeed, 0.5f), 0.22f, 0.5f); }
        }
        else _stepTimer = 0f;

        if (!string.IsNullOrEmpty(_currentState) && _clips != null && _clips.TryGetValue(_currentState, out var clip))
        {
            bool loops = _clipLoops != null && _clipLoops.TryGetValue(_currentState, out var lp) && lp;
            _playTime += Time.deltaTime / clip.length;
            if (loops) _playTime %= 1f; else _playTime = Mathf.Min(_playTime, 1f);
            PoseSampler.Sample(clip, _poseSrc, _playTime * clip.length);
        }

        // Copy pose-source bone rotations onto the chibi skeleton.
        if (_bones.TryGetValue(HipsName, out var hipsTarget) &&
            _poseBones.TryGetValue(HipsName, out var hipsSrc) &&
            hipsTarget != null && hipsSrc != null)
        {
            var par = hipsTarget.parent;
            hipsTarget.localRotation = par != null
                ? Quaternion.Inverse(par.rotation) * transform.rotation * hipsSrc.rotation
                : transform.rotation * hipsSrc.rotation;
        }
        foreach (var kv in _bones)
        {
            if (kv.Value == null || kv.Key == HipsName) continue;
            if (_poseBones.TryGetValue(kv.Key, out var src) && src != null)
                kv.Value.localRotation = src.localRotation;
        }
    }

    private void SwitchAnim(string state)
    {
        if (_currentState == state) return;
        if (_clips == null || !_clips.ContainsKey(state)) return;
        _currentState = state;
        _playTime = 0f;
    }

    // ── Nametag + chat bubble ──────────────────────────────────────────────────

    private void BuildNametag(string username)
    {
        var tag = MakeWorldLabel("[Nametag]", username, new Color(1f, 1f, 1f, 1f),
                                 new Color(0f, 0f, 0f, 0.55f), _topHeight + 0.35f);
        // Nametag is always on.
        tag.SetActive(true);
    }

    public void ShowBubble(string text)
    {
        if (_bubble == null)
        {
            _bubble = MakeWorldLabel("[ChatBubble]", text, Color.white,
                                     new Color(0f, 0f, 0f, 0.8f), _topHeight);
            _bubbleText = _bubble.GetComponentInChildren<Text>();
        }
        else if (_bubbleText != null)
        {
            _bubbleText.text = text;
            _bubble.SetActive(true);
        }
        _bubbleHideAt = Time.unscaledTime + 4f;
    }

    private void UpdateBubble()
    {
        if (_bubble != null && _bubble.activeSelf && Time.unscaledTime > _bubbleHideAt)
            _bubble.SetActive(false);
    }

    // Builds a billboarded world-space label above the avatar's head.
    private GameObject MakeWorldLabel(string name, string text, Color textColor, Color bgColor, float height)
    {
        var go = new GameObject(name);
        go.transform.SetParent(transform, false);
        go.transform.localPosition = new Vector3(0f, height, 0f);

        var canvas = go.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.WorldSpace;
        var scaler = go.AddComponent<CanvasScaler>();
        scaler.dynamicPixelsPerUnit = 30f;
        var rt = (RectTransform)go.transform;
        rt.sizeDelta   = new Vector2(2.4f, 0.7f);
        rt.localScale  = new Vector3(0.01f, 0.01f, 0.01f);

        var bg = new GameObject("Bg");
        bg.transform.SetParent(go.transform, false);
        var img = bg.AddComponent<Image>();
        img.color = bgColor;
        var bgRt = (RectTransform)bg.transform;
        bgRt.anchorMin = Vector2.zero; bgRt.anchorMax = Vector2.one;
        bgRt.offsetMin = new Vector2(-6f, -4f); bgRt.offsetMax = new Vector2(6f, 4f);

        var label = new GameObject("Text");
        label.transform.SetParent(go.transform, false);
        var t = label.AddComponent<Text>();
        t.text = text;
        t.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        t.alignment = TextAnchor.MiddleCenter;
        t.color = textColor;
        t.fontSize = 28;
        t.horizontalOverflow = HorizontalWrapMode.Wrap;
        t.verticalOverflow   = VerticalWrapMode.Overflow;
        var tRt = (RectTransform)label.transform;
        tRt.anchorMin = Vector2.zero; tRt.anchorMax = Vector2.one;
        tRt.offsetMin = Vector2.zero; tRt.offsetMax = Vector2.zero;

        go.AddComponent<ChatBubbleBillboard>();
        return go;
    }

    private void OnDestroy()
    {
        if (_poseSrc != null) Destroy(_poseSrc);
    }
}
