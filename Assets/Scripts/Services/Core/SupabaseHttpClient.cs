using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine.Networking;

namespace Pludo.Services.Core
{
    public sealed class SupabaseHttpClient : ISupabaseHttpClient
    {
        private readonly string _baseUrl;
        private readonly string _anonKey;

        // Written and read only on the Unity main thread via the synchronization context
        // established by Unity's default SynchronizationContext. Do not call service methods
        // from background threads or Task.Run continuations — if that ever changes, add a lock.
        private string _accessToken;

        public SupabaseHttpClient(SupabaseConfig config)
        {
            _baseUrl = config.ProjectUrl.TrimEnd('/') + "/rest/v1";
            _anonKey  = config.AnonKey;
        }

        public void SetAccessToken(string token) => _accessToken = token;
        public void ClearAccessToken()           => _accessToken = null;

        // ── GET ──────────────────────────────────────────────────────────────

        public Task<ServiceResult<T>> GetAsync<T>(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = UnityWebRequest.Get(BuildUrl(path, query));
            SetHeaders(req, options);
            return SendAndDeserializeAsync<T>(req, ct);
        }

        public async Task<ServiceResult<PagedResult<T>>> GetPagedAsync<T>(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            // Copy so we never mutate the caller's RequestOptions instance.
            var pagedOptions = new RequestOptions
            {
                ReturnRepresentation = options?.ReturnRepresentation ?? false,
                CountExact           = true,
                Range                = options?.Range,
                AcceptProfile        = options?.AcceptProfile,
                ContentProfile       = options?.ContentProfile,
            };

            var req = UnityWebRequest.Get(BuildUrl(path, query));
            SetHeaders(req, pagedOptions);

            using (req)
            {
                var sendErr = await SupabaseHttp.TrySendAsync(req, ct);
                if (sendErr.HasValue)
                    return ServiceResult<PagedResult<T>>.Fail(sendErr.Value);

                if (SupabaseHttp.IsNetworkError(req))
                    return ServiceResult<PagedResult<T>>.Fail(ServiceError.Network(req.error));

                if (!SupabaseHttp.IsHttpSuccess(req))
                    return ServiceResult<PagedResult<T>>.Fail(SupabaseHttp.ParseHttpError(req));

                T[] items;
                try
                {
                    items = JsonConvert.DeserializeObject<T[]>(
                                req.downloadHandler.text, SupabaseHttp.JsonSettings)
                            ?? Array.Empty<T>();
                }
                catch (Exception ex)
                {
                    return ServiceResult<PagedResult<T>>.Fail(
                        ServiceError.Server($"Deserialize failed: {ex.Message}"));
                }

                var (totalCount, hasMore) = ParseContentRange(req, items.Length);
                return ServiceResult<PagedResult<T>>.Ok(
                    new PagedResult<T>(items, totalCount, hasMore));
            }
        }

        // ── POST ─────────────────────────────────────────────────────────────

        public Task<ServiceResult<T>> PostAsync<T>(
            string path,
            object body,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = SupabaseHttp.BuildJsonRequest("POST", BuildUrl(path, null), body);
            SetHeaders(req, options);
            return SendAndDeserializeAsync<T>(req, ct);
        }

        // ── PATCH ────────────────────────────────────────────────────────────

        public Task<ServiceResult<T>> PatchAsync<T>(
            string path,
            object body,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = SupabaseHttp.BuildJsonRequest("PATCH", BuildUrl(path, query), body);
            SetHeaders(req, options);
            return SendAndDeserializeAsync<T>(req, ct);
        }

        // ── DELETE ───────────────────────────────────────────────────────────

        public Task<ServiceResult> DeleteAsync(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = UnityWebRequest.Delete(BuildUrl(path, query));
            req.downloadHandler = new DownloadHandlerBuffer();
            SetHeaders(req, options);
            return SendAndVoidAsync(req, ct);
        }

        // ── RPC ──────────────────────────────────────────────────────────────

        public Task<ServiceResult<T>> RpcAsync<T>(
            string functionName,
            object args,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = SupabaseHttp.BuildJsonRequest("POST", _baseUrl + "/rpc/" + functionName, args);
            SetHeaders(req, options);
            return SendAndDeserializeAsync<T>(req, ct);
        }

        public Task<ServiceResult> RpcVoidAsync(
            string functionName,
            object args,
            RequestOptions options = null,
            CancellationToken ct = default)
        {
            var req = SupabaseHttp.BuildJsonRequest("POST", _baseUrl + "/rpc/" + functionName, args);
            SetHeaders(req, options);
            return SendAndVoidAsync(req, ct);
        }

        // ── Send helpers ─────────────────────────────────────────────────────

        private static async Task<ServiceResult<T>> SendAndDeserializeAsync<T>(
            UnityWebRequest req,
            CancellationToken ct)
        {
            using (req)
            {
                var sendErr = await SupabaseHttp.TrySendAsync(req, ct);
                if (sendErr.HasValue)
                    return ServiceResult<T>.Fail(sendErr.Value);

                if (SupabaseHttp.IsNetworkError(req))
                    return ServiceResult<T>.Fail(ServiceError.Network(req.error));

                if (!SupabaseHttp.IsHttpSuccess(req))
                    return ServiceResult<T>.Fail(SupabaseHttp.ParseHttpError(req));

                var body = req.downloadHandler?.text;
                if (string.IsNullOrWhiteSpace(body))
                    return ServiceResult<T>.Ok(default);

                try
                {
                    return ServiceResult<T>.Ok(
                        JsonConvert.DeserializeObject<T>(body, SupabaseHttp.JsonSettings));
                }
                catch (Exception ex)
                {
                    return ServiceResult<T>.Fail(
                        ServiceError.Server($"Deserialize failed: {ex.Message}"));
                }
            }
        }

        private static async Task<ServiceResult> SendAndVoidAsync(
            UnityWebRequest req,
            CancellationToken ct)
        {
            using (req)
            {
                var sendErr = await SupabaseHttp.TrySendAsync(req, ct);
                if (sendErr.HasValue)
                    return ServiceResult.Fail(sendErr.Value);

                if (SupabaseHttp.IsNetworkError(req))
                    return ServiceResult.Fail(ServiceError.Network(req.error));

                return SupabaseHttp.IsHttpSuccess(req)
                    ? ServiceResult.Ok()
                    : ServiceResult.Fail(SupabaseHttp.ParseHttpError(req));
            }
        }

        // ── URL / header builders ─────────────────────────────────────────────

        private string BuildUrl(string path, IReadOnlyDictionary<string, string> query)
        {
            var sb = new StringBuilder(_baseUrl);
            if (!path.StartsWith("/", StringComparison.Ordinal))
                sb.Append('/');
            sb.Append(path);

            if (query != null && query.Count > 0)
            {
                bool first = true;
                foreach (var kv in query)
                {
                    sb.Append(first ? '?' : '&');
                    sb.Append(Uri.EscapeDataString(kv.Key));
                    sb.Append('=');
                    sb.Append(Uri.EscapeDataString(kv.Value));
                    first = false;
                }
            }
            return sb.ToString();
        }

        private void SetHeaders(UnityWebRequest req, RequestOptions options)
        {
            req.SetRequestHeader("apikey", _anonKey);
            if (!string.IsNullOrEmpty(_accessToken))
                req.SetRequestHeader("Authorization", "Bearer " + _accessToken);

            if (options == null) return;

            var prefer = new StringBuilder();
            if (options.ReturnRepresentation) AppendPrefer(prefer, "return=representation");
            if (options.CountExact)           AppendPrefer(prefer, "count=exact");
            if (prefer.Length > 0)
                req.SetRequestHeader("Prefer", prefer.ToString());

            if (options.Range.HasValue)
            {
                var r = options.Range.Value;
                req.SetRequestHeader("Range", r.To < 0 ? $"{r.From}-" : $"{r.From}-{r.To}");
            }

            if (!string.IsNullOrEmpty(options.AcceptProfile))
                req.SetRequestHeader("Accept-Profile", options.AcceptProfile);
            if (!string.IsNullOrEmpty(options.ContentProfile))
                req.SetRequestHeader("Content-Profile", options.ContentProfile);
        }

        private static void AppendPrefer(StringBuilder sb, string value)
        {
            if (sb.Length > 0) sb.Append(',');
            sb.Append(value);
        }

        // ── Content-Range parser ──────────────────────────────────────────────

        // Content-Range: start-end/total  (or */total when range is not applicable)
        private static (int? totalCount, bool hasMore) ParseContentRange(
            UnityWebRequest req,
            int itemCount)
        {
            var header = req.GetResponseHeader("Content-Range");
            if (string.IsNullOrEmpty(header))
                return (null, itemCount > 0);

            var slashIdx = header.IndexOf('/');
            if (slashIdx < 0)
                return (null, itemCount > 0);

            var totalStr = header.Substring(slashIdx + 1);
            if (totalStr == "*" || !int.TryParse(totalStr, out var total))
                return (null, itemCount > 0);

            var rangePart = header.Substring(0, slashIdx);
            var dashIdx   = rangePart.IndexOf('-');
            if (dashIdx >= 0 && int.TryParse(rangePart.Substring(dashIdx + 1), out var end))
                return (total, end + 1 < total);

            return (total, itemCount < total);
        }
    }
}
