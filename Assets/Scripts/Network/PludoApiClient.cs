using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

// Thin HTTP wrapper mirroring the @workspace/api-client-react hooks.
// All methods return IEnumerator so callers can StartCoroutine() them.
// Pass a MonoBehaviour to use StartCoroutine, or wire into MainAppController.
public static class PludoApiClient
{
    // ServiceBootstrap normally writes the active env URL here at app startup.
    // If something runs before bootstrap (an editor-launched test, a script-only
    // path that bypasses the React shell, a hot-reload that wipes static state),
    // BaseUrl is empty and downstream URL construction silently produces things
    // like "/api/game-ws?gameId=92" — no scheme, ClientWebSocket throws, the
    // join times out and the user sees "everything is the same" with no useful
    // diagnostic. Default to localhost:4000 in the Editor so dev work always
    // resolves; production builds ride on ServiceBootstrap setting the real URL.
    private static string _baseUrl = "";
    public static string BaseUrl
    {
        get
        {
#if UNITY_EDITOR
            return string.IsNullOrEmpty(_baseUrl) ? "http://localhost:4000" : _baseUrl;
#else
            return _baseUrl;
#endif
        }
        set { _baseUrl = value; }
    }

    // ── Games ──────────────────────────────────────────────────────────────────

    public static IEnumerator ListGames(
        int limit, string genre,
        Action<GameListResponse> onSuccess,
        Action<string> onError = null)
    {
        var url = BuildUrl("/api/games", $"limit={limit}" + (string.IsNullOrEmpty(genre) ? "" : $"&genre={UnityWebRequest.EscapeURL(genre)}"));
        yield return Get(url, onSuccess, onError);
    }

    // published=true asks the server to return the frozen published snapshot
    // of the game (title, description, gameCode, asset URLs, thumbnail) instead
    // of the live draft. The play feed uses this so post-publish edits don't
    // alter what other players see; the editor passes false and gets the draft.
    public static IEnumerator GetGame(
        int id,
        Action<GameData> onSuccess,
        Action<string> onError = null,
        bool published = false)
    {
        var path = published ? $"/games/{id}?published=true" : $"/games/{id}";
        yield return Get<GameData>(BuildUrl(path), onSuccess, onError);
    }

    public static IEnumerator CreateGame(
        string prompt, string creatorName,
        Action<GameData> onSuccess,
        Action<string> onError = null)
    {
        var body = JsonUtility.ToJson(new CreateGameRequest { prompt = prompt, creatorName = creatorName });
        yield return Post("/ai/generate-game", body, onSuccess, onError);
    }

    // Starts a Luau generation job, polls until done, saves the result via POST /games,
    // and returns the saved GameData.  onProgress receives step messages while polling.
    public static IEnumerator CreateLuauGame(
        string prompt, string creatorName,
        Action<GameData> onSuccess,
        Action<string> onError = null,
        Action<string> onProgress = null)
    {
        // Step 1 — Start the async job
        onProgress?.Invoke("Analyzing concept...");
        var startBody = JsonUtility.ToJson(new CreateLuauGameRequest { prompt = prompt, creatorName = creatorName });
        LuauJobStartResponse jobStart = null;
        string startError = null;
        yield return Post<LuauJobStartResponse>("/ai/generate-game-luau", startBody,
            r => jobStart = r,
            e => startError = e);

        if (startError != null || jobStart == null || string.IsNullOrEmpty(jobStart.jobId))
        {
            onError?.Invoke(startError ?? "Failed to start generation job");
            yield break;
        }

        // Step 2 — Poll the status endpoint
        var steps = new[]
        {
            "Designing game mechanics...",
            "Writing game script...",
            "Building world and gameplay systems...",
            "Generating 3D models...",
            "Finalizing game...",
        };
        int stepIndex = 0;
        float pollInterval = 3f;
        float elapsed     = 0f;

        LuauGameStatusResponse status = null;
        while (true)
        {
            // Advance progress label ~every poll
            if (stepIndex < steps.Length)
            {
                onProgress?.Invoke(steps[stepIndex]);
                stepIndex++;
            }

            elapsed = 0f;
            while (elapsed < pollInterval)
            {
                elapsed += Time.unscaledDeltaTime;
                yield return null;
            }

            string pollError = null;
            yield return GetRaw(BuildUrl($"/ai/generate-game-luau/status/{jobStart.jobId}"),
                raw =>
                {
                    try { status = JsonUtility.FromJson<LuauGameStatusResponse>(raw); }
                    catch (Exception e) { pollError = $"Parse error: {e.Message}"; }
                },
                e => pollError = e);

            if (pollError != null) { onError?.Invoke(pollError); yield break; }
            if (status == null)   { onError?.Invoke("Empty status response"); yield break; }
            if (status.status == "error") { onError?.Invoke(status.error ?? "Generation failed"); yield break; }
            if (status.status == "done")  break;
            // still pending — loop
        }

        var res = status.result;
        if (res == null) { onError?.Invoke("Missing result in done response"); yield break; }

        // Step 3 — Save to /games
        onProgress?.Invoke("Saving your game...");
        var saveReq = new SaveGameRequest
        {
            title         = res.title,
            description   = res.description,
            genre         = res.genre,
            gameCode      = res.gameCode,
            creatorName   = creatorName,
            assetUrlsJson = res.assetUrlsJson ?? "{}",
            tags          = res.tags ?? new System.Collections.Generic.List<string>(),
        };
        yield return Post<GameData>("/games", JsonUtility.ToJson(saveReq), onSuccess, onError);
    }

    // ── Avatar Items ───────────────────────────────────────────────────────────

    public static IEnumerator SearchUsers(
        string query,
        Action<UserSearchResponse> onSuccess,
        Action<string> onError = null)
    {
        var url = BuildUrl("/api/users/search", $"q={UnityWebRequest.EscapeURL(query ?? "")}");
        yield return Get(url, onSuccess, onError);
    }

    public static IEnumerator ListAvatarItems(
        int limit, string category,
        Action<AvatarItemDataList> onSuccess,
        Action<string> onError = null)
    {
        var q = $"limit={limit}" + (string.IsNullOrEmpty(category) ? "" : $"&category={UnityWebRequest.EscapeURL(category)}");
        var url = BuildUrl("/avatar-items", q);
        yield return GetRaw(url,
            raw =>
            {
                // The API returns { items: [...], total: N }
                // Wrap it so JsonUtility can parse it
                var wrapper = JsonUtility.FromJson<AvatarItemDataList>("{\"items\":" + ExtractArray(raw, "items") + "}");
                onSuccess?.Invoke(wrapper);
            },
            onError);
    }

    public static IEnumerator CreateAvatarItem(
        string prompt, string creatorName,
        Action<AvatarItemData> onSuccess,
        Action<string> onError = null)
    {
        var body = JsonUtility.ToJson(new CreateAvatarItemRequest { prompt = prompt, creatorName = creatorName });
        yield return Post("/ai/generate-avatar-item", body, onSuccess, onError);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    private static string BuildUrl(string path, string query = "")
    {
        var base_ = BaseUrl.TrimEnd('/');
        return string.IsNullOrEmpty(query) ? $"{base_}{path}" : $"{base_}{path}?{query}";
    }

    private static IEnumerator Get<T>(string url, Action<T> onSuccess, Action<string> onError)
    {
        yield return GetRaw(url, raw =>
        {
            try { onSuccess?.Invoke(JsonUtility.FromJson<T>(raw)); }
            catch (Exception e) { onError?.Invoke($"Parse error: {e.Message}"); }
        }, onError);
    }

    private static IEnumerator GetRaw(string url, Action<string> onSuccess, Action<string> onError)
    {
        using var req = UnityWebRequest.Get(url);
        req.SetRequestHeader("Accept", "application/json");
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success)
            onSuccess?.Invoke(req.downloadHandler.text);
        else
        {
            // Previously silent — a failed fetch (e.g. api-server not running) only
            // surfaced as whatever the caller's onError did with the string, which for
            // several callers was nothing visible at all. Log it so a dead API server
            // shows up in the console instead of manifesting as an unexplained blank UI.
            Debug.LogError($"[PludoApiClient] GET {url} failed: {req.error}");
            onError?.Invoke(req.error);
        }
    }

    private static IEnumerator Post<T>(string path, string json, Action<T> onSuccess, Action<string> onError)
    {
        var url = BuildUrl(path);
        using var req = new UnityWebRequest(url, "POST");
        req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "application/json");
        req.SetRequestHeader("Accept", "application/json");
        yield return req.SendWebRequest();
        if (req.result == UnityWebRequest.Result.Success)
        {
            try { onSuccess?.Invoke(JsonUtility.FromJson<T>(req.downloadHandler.text)); }
            catch (Exception e) { onError?.Invoke($"Parse error: {e.Message}"); }
        }
        else
        {
            Debug.LogError($"[PludoApiClient] POST {url} failed: {req.error}");
            onError?.Invoke(req.error);
        }
    }

    // Minimal JSON array extractor — finds the value of the named array key.
    private static string ExtractArray(string json, string key)
    {
        var marker = $"\"{key}\":";
        var idx = json.IndexOf(marker, StringComparison.Ordinal);
        if (idx < 0) return "[]";
        var start = json.IndexOf('[', idx + marker.Length);
        if (start < 0) return "[]";
        var depth = 0; var end = start;
        for (; end < json.Length; end++)
        {
            if (json[end] == '[') depth++;
            else if (json[end] == ']') { depth--; if (depth == 0) { end++; break; } }
        }
        return json[start..end];
    }
}
