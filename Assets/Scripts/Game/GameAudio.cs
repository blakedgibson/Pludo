using System.Collections.Generic;
using UnityEngine;

// Singleton that provides real audio feedback for Lua game scripts.
// Lazily creates itself; all public methods are static.
public class GameAudio : MonoBehaviour
{
    private static GameAudio _instance;

    private AudioSource _sfxSource;
    private AudioSource _musicSource;
    private readonly Dictionary<string, AudioClip> _clips = new();

    private static readonly Dictionary<string, (float freq, float dur)> Presets = new()
    {
        ["jump"]      = (440f,  0.25f),
        ["land"]      = (120f,  0.15f),
        ["collect"]   = (880f,  0.20f),
        ["coin"]      = (1047f, 0.18f),
        ["hit"]       = (160f,  0.30f),
        ["hurt"]      = (200f,  0.30f),
        ["death"]     = (150f,  0.60f),
        ["explosion"] = (70f,   0.50f),
        ["whoosh"]    = (350f,  0.35f),
        ["click"]     = (1000f, 0.10f),
        ["win"]       = (523f,  0.55f),
        ["lose"]      = (196f,  0.55f),
        ["door"]      = (300f,  0.25f),
        ["teleport"]  = (700f,  0.40f),
        ["powerup"]   = (660f,  0.40f),
        ["shoot"]     = (900f,  0.12f),
        ["pickup"]    = (587f,  0.20f),
        ["error"]     = (220f,  0.30f),
        ["success"]   = (784f,  0.35f),
        ["bell"]      = (1175f, 0.50f),
        ["step"]      = (180f,  0.08f),
    };

    private static readonly Dictionary<string, float> MusicFreqs = new()
    {
        ["calm"]    = 261f,
        ["happy"]   = 392f,
        ["intense"] = 330f,
        ["sad"]     = 220f,
        ["action"]  = 349f,
        ["mystery"] = 277f,
    };

    private static GameAudio Instance
    {
        get
        {
            if (_instance != null) return _instance;
            var go = new GameObject("GameAudio");
            DontDestroyOnLoad(go);
            _instance = go.AddComponent<GameAudio>();
            return _instance;
        }
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { Destroy(gameObject); return; }
        _instance = this;

        _sfxSource            = gameObject.AddComponent<AudioSource>();
        _musicSource          = gameObject.AddComponent<AudioSource>();
        _musicSource.loop     = true;
        _musicSource.volume   = 0.5f;

        foreach (var (name, (freq, dur)) in Presets)
            _clips[name] = MakeTone(freq, dur, false);
    }

    private void OnDestroy() { if (_instance == this) _instance = null; }

    public static void PlaySound(string preset)
    {
        if (string.IsNullOrEmpty(preset)) return;
        var inst = Instance;
        var key  = preset.ToLowerInvariant();
        var clip = inst._clips.TryGetValue(key, out var c) ? c : MakeTone(440f, 0.2f, false);
        inst._sfxSource.PlayOneShot(clip);
    }

    public static void PlayMusic(string preset)
    {
        var inst = Instance;
        MusicFreqs.TryGetValue(preset?.ToLowerInvariant() ?? "", out float freq);
        if (freq < 1f) freq = 294f;
        inst._musicSource.clip = MakeTone(freq, 4f, true);
        inst._musicSource.Play();
    }

    public static void StopMusic()
    {
        if (_instance != null) _instance._musicSource.Stop();
    }

    // Stops both SFX (PlayOneShot tail) and looping music. Called by LuauGameRunner.TearDown
    // so audio doesn't bleed past the game session into the menu.
    public static void StopAll()
    {
        if (_instance == null) return;
        _instance._musicSource.Stop();
        _instance._sfxSource.Stop();
    }

    public static void SetSfxVolume(float v)
    {
        if (_instance != null) _instance._sfxSource.volume = Mathf.Clamp01(v);
    }

    public static void SetMusicVolume(float v)
    {
        if (_instance != null) _instance._musicSource.volume = Mathf.Clamp01(v);
    }

    // sustain=true → slow decay for looping music clips; false → fast decay for SFX pops
    private static AudioClip MakeTone(float freq, float duration, bool sustain)
    {
        const int Rate = 44100;
        int samples = Mathf.Max(1, Mathf.RoundToInt(Rate * duration));
        var data = new float[samples];
        float decay = sustain ? 0.5f / duration : 5f / duration;
        for (int i = 0; i < samples; i++)
        {
            float t = (float)i / Rate;
            data[i] = Mathf.Sin(2f * Mathf.PI * freq * t) * Mathf.Exp(-t * decay) * 0.35f;
        }
        var clip = AudioClip.Create($"tone{(int)freq}", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }
}
