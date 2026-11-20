using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using UnityEngine.Networking;

namespace Pludo.Services.Core
{
    // Shared HTTP utilities used by SupabaseHttpClient (REST) and AuthService (Auth).
    // Internal to this assembly; if asmdef files are introduced later, all callers
    // must reside in the same asmdef or an InternalsVisibleTo attribute is required.
    internal static class SupabaseHttp
    {
        internal static readonly JsonSerializerSettings JsonSettings = new JsonSerializerSettings
        {
            ContractResolver = new DefaultContractResolver
            {
                NamingStrategy = new SnakeCaseNamingStrategy()
            },
            NullValueHandling = NullValueHandling.Ignore,
        };

        // Wraps UnityWebRequest.SendWebRequest() in a TaskCompletionSource using the
        // completed callback (no UniTask required). The registration is disposed inside
        // the callback to avoid a race where the CancellationToken fires after the
        // request already completed normally. TrySetCanceled / TrySetResult prevent
        // double-completion on the same TCS.
        internal static async Task<ServiceError?> TrySendAsync(
            UnityWebRequest req,
            CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<bool>();
            var op  = req.SendWebRequest();

            CancellationTokenRegistration reg = default;
            if (ct.CanBeCanceled)
                reg = ct.Register(() => req.Abort());

            op.completed += _ =>
            {
                reg.Dispose();
                if (ct.IsCancellationRequested)
                    tcs.TrySetCanceled(ct);
                else
                    tcs.TrySetResult(true);
            };

            try
            {
                await tcs.Task;
                ct.ThrowIfCancellationRequested();
                return null;
            }
            catch (OperationCanceledException)
            {
                return ServiceError.Network("Request cancelled");
            }
            catch (Exception ex)
            {
                return ServiceError.Network(ex.Message);
            }
        }

        internal static bool IsNetworkError(UnityWebRequest req) =>
            req.result == UnityWebRequest.Result.ConnectionError ||
            req.result == UnityWebRequest.Result.DataProcessingError;

        internal static bool IsHttpSuccess(UnityWebRequest req) =>
            req.responseCode is >= 200 and < 300;

        // Maps HTTP status codes to ServiceError categories.
        // 406 is PostgREST PGRST116 (no rows on a singular GET) — treated as Domain.
        internal static ServiceError ParseHttpError(UnityWebRequest req)
        {
            var status  = (int)req.responseCode;
            var message = ExtractErrorMessage(req.downloadHandler?.text) ?? req.error ?? "Unknown error";

            return status switch
            {
                401 or 403        => ServiceError.Auth(message, status),
                400 or 422        => ServiceError.Validation(message, status),
                404 or 406 or 409 => ServiceError.Domain(message, status),
                429               => ServiceError.Server(message, status),
                >= 500            => ServiceError.Server(message, status),
                _                 => ServiceError.Domain(message, status),
            };
        }

        // Handles PostgREST {"code":"...","message":"..."} and
        // Supabase Auth {"error":"...","error_description":"..."} envelopes.
        // Prefers message > error_description > error for user-facing text.
        internal static string ExtractErrorMessage(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return null;
            try
            {
                var env = JsonConvert.DeserializeObject<ErrorEnvelope>(body);
                return env?.Message ?? env?.ErrorDescription ?? env?.Error;
            }
            catch { return null; }
        }

        internal static UnityWebRequest BuildJsonRequest(string method, string url, object body)
        {
            var json  = body != null ? JsonConvert.SerializeObject(body, JsonSettings) : "{}";
            var bytes = Encoding.UTF8.GetBytes(json);
            var req   = new UnityWebRequest(url, method)
            {
                uploadHandler   = new UploadHandlerRaw(bytes),
                downloadHandler = new DownloadHandlerBuffer(),
            };
            req.SetRequestHeader("Content-Type", "application/json");
            return req;
        }

        private sealed class ErrorEnvelope
        {
            [JsonProperty("message")]           public string Message          { get; set; }
            [JsonProperty("error")]             public string Error            { get; set; }
            [JsonProperty("error_description")] public string ErrorDescription { get; set; }
        }
    }
}
