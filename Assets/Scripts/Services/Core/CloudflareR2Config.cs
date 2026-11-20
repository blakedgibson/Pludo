using System;
using UnityEngine;

namespace Pludo.Services.Core
{
    /// <summary>
    /// R2 bucket settings. Credentials are NOT stored in this asset (it is committed to git).
    /// They are resolved at runtime, first match wins:
    ///   1. Environment variables PLUDO_R2_ACCOUNT_ID / PLUDO_R2_ACCESS_KEY_ID / PLUDO_R2_SECRET_ACCESS_KEY
    ///   2. Assets/Resources/Config/CloudflareR2Secrets.json (gitignored; copy CloudflareR2Secrets.example.json)
    ///   3. The serialized fields below (leave the key fields empty in the committed asset)
    /// </summary>
    [CreateAssetMenu(menuName = "Pludo/Cloudflare R2 Config", fileName = "CloudflareR2Config")]
    public class CloudflareR2Config : ScriptableObject
    {
        [SerializeField] private string _accountId;
        [SerializeField] private string _accessKeyId;
        [SerializeField] private string _secretAccessKey;
        [SerializeField] private string _bucketName;

        // Optional: set to your R2 public bucket domain (e.g. https://assets.example.com).
        // When set, GetUrl() returns a direct URL instead of a presigned one.
        [SerializeField] private string _publicBaseUrl;

        public string AccountId       => Resolve("PLUDO_R2_ACCOUNT_ID",        Secrets?.accountId,       _accountId);
        public string AccessKeyId     => Resolve("PLUDO_R2_ACCESS_KEY_ID",     Secrets?.accessKeyId,     _accessKeyId);
        public string SecretAccessKey => Resolve("PLUDO_R2_SECRET_ACCESS_KEY", Secrets?.secretAccessKey, _secretAccessKey);
        public string BucketName      => _bucketName;
        public string PublicBaseUrl   => _publicBaseUrl;

        [Serializable]
        private class SecretsFile
        {
            public string accountId;
            public string accessKeyId;
            public string secretAccessKey;
        }

        private const string SecretsResourcePath = "Config/CloudflareR2Secrets";

        [NonSerialized] private SecretsFile _secrets;
        [NonSerialized] private bool _secretsLoaded;

        private SecretsFile Secrets
        {
            get
            {
                if (_secretsLoaded) return _secrets;
                _secretsLoaded = true;
                var text = Resources.Load<TextAsset>(SecretsResourcePath);
                if (text != null)
                {
                    try { _secrets = JsonUtility.FromJson<SecretsFile>(text.text); }
                    catch (Exception e) { Debug.LogWarning($"[CloudflareR2Config] Could not parse {SecretsResourcePath}.json: {e.Message}"); }
                }
                return _secrets;
            }
        }

        private static string Resolve(string envVar, string fromFile, string serialized)
        {
            var env = Environment.GetEnvironmentVariable(envVar);
            if (!string.IsNullOrEmpty(env)) return env;
            if (!string.IsNullOrEmpty(fromFile)) return fromFile;
            return serialized;
        }
    }
}
