using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

// Downloads JPG/PNG texture maps from the Polyhaven R2 cache served by our
// api-server at /api/glb/textures/polyhaven/v1/<hash>.jpg. Same retry +
// in-memory cache pattern as GameAssetLoader, but for Texture2D instead of GLB.
//
// Materials are built by GameRenderClient when a Structure entity arrives with
// `structureMaterial` or `terrainLayers` populated by the server. Each map
// URL is requested once globally and reused across every game session — the
// underlying Polyhaven slug → SHA-256 key contract guarantees the URL is the
// same forever once cached.
public static class TextureLoader
{
    // Globally-shared cache. Same URL (one Polyhaven slug + map type) means
    // the same Texture2D — no need to redownload between game sessions.
    // Keyed by absolute URL after PludoApiClient.ResolveUrl() so relative and
    // absolute references resolve to the same entry.
    private static readonly Dictionary<string, Texture2D> _cache = new();
    // In-flight requests so two concurrent material builds don't both
    // dispatch a UnityWebRequest for the same URL.
    private static readonly Dictionary<string, List<Action<Texture2D>>> _waiters = new();

    // Public entry. Resolves cache → in-flight → fetch. The callback fires on
    // the next Update tick after the texture is ready, or with null on failure
    // after retries. Safe to call from anywhere with a host MonoBehaviour.
    public static IEnumerator LoadTexture(MonoBehaviour host, string url, Action<Texture2D> onDone)
    {
        if (string.IsNullOrEmpty(url)) { onDone?.Invoke(null); yield break; }
        var resolved = ResolveUrl(url);

        // Cache hit — fire next frame so callers see consistent async semantics.
        if (_cache.TryGetValue(resolved, out var cached) && cached != null)
        {
            yield return null;
            onDone?.Invoke(cached);
            yield break;
        }

        // In-flight: attach our callback to the existing fetch's waiter list.
        if (_waiters.TryGetValue(resolved, out var waiters))
        {
            waiters.Add(onDone);
            yield break;
        }

        // New fetch — start the coroutine on the host so it survives scene
        // changes the way the GLB loader does. Register an empty waiter list
        // before yielding so concurrent callers can attach.
        _waiters[resolved] = new List<Action<Texture2D>> { onDone };
        yield return host.StartCoroutine(DoFetch(resolved));
    }

    // Same retry pattern as GameAssetLoader.LoadOne: 3 attempts, exponential
    // backoff (2s, 4s). On success, populate cache + fire every waiter; on
    // exhausted failure, fire every waiter with null so callers can fall back.
    private static IEnumerator DoFetch(string url)
    {
        Texture2D result = null;
        for (int attempt = 1; attempt <= 3 && result == null; attempt++)
        {
            using (var req = UnityWebRequestTexture.GetTexture(url))
            {
                req.timeout = 30;
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    var tex = DownloadHandlerTexture.GetContent(req);
                    if (tex != null)
                    {
                        // Triplanar shader expects tileable repeats and slightly
                        // sharper mips than the auto-LOD bias to avoid mushy
                        // texture at glancing slope angles.
                        tex.wrapMode  = TextureWrapMode.Repeat;
                        tex.mipMapBias = -0.5f;
                        result = tex;
                        break;
                    }
                }
                Debug.LogWarning($"[TextureLoader] '{url}' attempt {attempt} failed: {req.error ?? "no texture"}");
            }
            if (result == null && attempt < 3)
            {
                var delay = Mathf.Pow(2f, attempt); // 2s, 4s
                yield return new WaitForSeconds(delay);
            }
        }

        if (result != null) _cache[url] = result;
        else Debug.LogWarning($"[TextureLoader] gave up on '{url}' after 3 attempts");

        // Fire waiters AFTER cache write so anyone re-entering during the
        // callback hits the cache instead of stalling on _waiters.
        if (_waiters.TryGetValue(url, out var waiters))
        {
            _waiters.Remove(url);
            foreach (var cb in waiters) { try { cb?.Invoke(result); } catch (Exception e) { Debug.LogError(e); } }
        }
    }

    // Same logic as PludoApiClient: relative `/api/...` paths resolve against
    // the live api-server BaseUrl so dev/prod swap is transparent. Absolute
    // URLs pass through unchanged.
    private static string ResolveUrl(string url)
    {
        if (string.IsNullOrEmpty(url)) return url;
        if (url.StartsWith("http://") || url.StartsWith("https://")) return url;
        // Mirror PludoApiClient — anchor on its BaseUrl so dev hot-reload picks
        // up the right host without recompiling.
        var baseUrl = PludoApiClient.BaseUrl?.TrimEnd('/') ?? "http://localhost:4000";
        if (!url.StartsWith("/")) url = "/" + url;
        return baseUrl + url;
    }
}
