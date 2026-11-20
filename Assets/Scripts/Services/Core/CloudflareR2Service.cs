// Cloudflare R2 storage client using the S3-compatible API with AWS Signature V4.
// Upload: PUT with signed Authorization header.
// Retrieval: public URL (if PublicBaseUrl is set) or presigned query-param URL.
//
// IMPORTANT: UploadAsync must be called from the Unity main thread (UnityWebRequest constraint).

using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace Pludo.Services.Core
{
    public sealed class CloudflareR2Service : IR2StorageService
    {
        private const string Region    = "auto";
        private const string Service   = "s3";
        private const string Algorithm = "AWS4-HMAC-SHA256";

        private readonly CloudflareR2Config _config;

        public CloudflareR2Service(CloudflareR2Config config)
        {
            _config = config;
        }

        // ── IR2StorageService ─────────────────────────────────────────────────

        public async Task<ServiceResult<string>> UploadAsync(
            string key,
            byte[] data,
            string contentType,
            CancellationToken ct = default)
        {
            var now         = DateTime.UtcNow;
            var dateStamp   = now.ToString("yyyyMMdd");
            var amzDate     = now.ToString("yyyyMMddTHHmmssZ");
            var host        = $"{_config.AccountId}.r2.cloudflarestorage.com";
            var payloadHash = HexHash(data);
            var canonicalUri = CanonicalUri(key);

            // Canonical headers must be sorted, lowercase, with a trailing newline per entry.
            var canonicalHeaders =
                $"content-type:{contentType}\n" +
                $"host:{host}\n" +
                $"x-amz-content-sha256:{payloadHash}\n" +
                $"x-amz-date:{amzDate}\n";
            const string signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

            var canonicalRequest = string.Join("\n",
                "PUT",
                canonicalUri,
                "",                  // empty canonical query string
                canonicalHeaders,
                signedHeaders,
                payloadHash);

            var credentialScope = $"{dateStamp}/{Region}/{Service}/aws4_request";
            var stringToSign = string.Join("\n",
                Algorithm,
                amzDate,
                credentialScope,
                HexHash(Encoding.UTF8.GetBytes(canonicalRequest)));

            var signature  = HexHmac(GetSigningKey(dateStamp), stringToSign);
            var authHeader =
                $"{Algorithm} Credential={_config.AccessKeyId}/{credentialScope}, " +
                $"SignedHeaders={signedHeaders}, Signature={signature}";

            var url = $"https://{host}/{_config.BucketName}/{key}";
            using var req = new UnityWebRequest(url, "PUT")
            {
                uploadHandler   = new UploadHandlerRaw(data),
                downloadHandler = new DownloadHandlerBuffer(),
            };
            req.SetRequestHeader("Content-Type",         contentType);
            req.SetRequestHeader("x-amz-date",           amzDate);
            req.SetRequestHeader("x-amz-content-sha256", payloadHash);
            req.SetRequestHeader("Authorization",        authHeader);

            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            req.SendWebRequest().completed += _ => tcs.TrySetResult(true);

            using (ct.Register(() => { req.Abort(); tcs.TrySetCanceled(); }))
                await tcs.Task;

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogError($"[R2] Upload failed ({req.responseCode}): {req.error}");
                return ServiceResult<string>.Fail(
                    ServiceError.Network(req.error, (int)req.responseCode));
            }

            return ServiceResult<string>.Ok(GetUrl(key));
        }

        public string GetUrl(string keyOrUrl, int presignedExpirySeconds = 3600)
        {
            if (string.IsNullOrEmpty(keyOrUrl) || keyOrUrl.StartsWith("http"))
                return keyOrUrl;

            if (!string.IsNullOrEmpty(_config.PublicBaseUrl))
                return $"{_config.PublicBaseUrl.TrimEnd('/')}/{keyOrUrl}";

            return GeneratePresignedGetUrl(keyOrUrl, presignedExpirySeconds);
        }

        // ── Presigned GET URL (AWS Sig V4 query-param auth) ───────────────────

        private string GeneratePresignedGetUrl(string key, int expirySeconds)
        {
            var now             = DateTime.UtcNow;
            var dateStamp       = now.ToString("yyyyMMdd");
            var amzDate         = now.ToString("yyyyMMddTHHmmssZ");
            var host            = $"{_config.AccountId}.r2.cloudflarestorage.com";
            var credentialScope = $"{dateStamp}/{Region}/{Service}/aws4_request";

            // Query params must be sorted by name for the canonical query string.
            var qp = new SortedDictionary<string, string>(StringComparer.Ordinal)
            {
                ["X-Amz-Algorithm"]    = Algorithm,
                ["X-Amz-Credential"]   = $"{_config.AccessKeyId}/{credentialScope}",
                ["X-Amz-Date"]         = amzDate,
                ["X-Amz-Expires"]      = expirySeconds.ToString(),
                ["X-Amz-SignedHeaders"] = "host",
            };

            var canonicalQueryString = string.Join("&",
                qp.Select(kv => $"{Rfc3986Encode(kv.Key)}={Rfc3986Encode(kv.Value)}"));

            var canonicalUri = CanonicalUri(key);

            var canonicalRequest = string.Join("\n",
                "GET",
                canonicalUri,
                canonicalQueryString,
                $"host:{host}\n",   // canonical headers (one entry, trailing newline)
                "host",             // signed headers
                "UNSIGNED-PAYLOAD");

            var stringToSign = string.Join("\n",
                Algorithm,
                amzDate,
                credentialScope,
                HexHash(Encoding.UTF8.GetBytes(canonicalRequest)));

            var signature = HexHmac(GetSigningKey(dateStamp), stringToSign);

            return $"https://{host}/{_config.BucketName}/{key}" +
                   $"?{canonicalQueryString}&X-Amz-Signature={signature}";
        }

        // ── AWS Sig V4 helpers ────────────────────────────────────────────────

        private byte[] GetSigningKey(string dateStamp)
        {
            var kSecret  = Encoding.UTF8.GetBytes("AWS4" + _config.SecretAccessKey);
            var kDate    = HmacRaw(kSecret, dateStamp);
            var kRegion  = HmacRaw(kDate, Region);
            var kService = HmacRaw(kRegion, Service);
            return HmacRaw(kService, "aws4_request");
        }

        // Encode each path segment individually so '/' separators are preserved.
        private string CanonicalUri(string key)
        {
            var encoded = string.Join("/",
                key.Split('/').Select(s => Rfc3986Encode(s)));
            return $"/{_config.BucketName}/{encoded}";
        }

        private static string HexHash(byte[] data)
        {
            using var sha256 = SHA256.Create();
            return ToHex(sha256.ComputeHash(data));
        }

        private static string HexHmac(byte[] key, string data) =>
            ToHex(HmacRaw(key, data));

        private static byte[] HmacRaw(byte[] key, string data)
        {
            using var hmac = new HMACSHA256(key);
            return hmac.ComputeHash(Encoding.UTF8.GetBytes(data));
        }

        private static string ToHex(byte[] bytes) =>
            BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();

        // RFC 3986 unreserved chars: A-Z a-z 0-9 - _ . ~  (all others are encoded)
        private static string Rfc3986Encode(string s) =>
            Uri.EscapeDataString(s);
    }
}
