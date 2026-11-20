using UnityEngine;

namespace Pludo.Services.Core
{
    public enum PludoEnvironment { Development, Staging, Production }

    [CreateAssetMenu(menuName = "Pludo/Environment Config", fileName = "PludoEnvironmentConfig")]
    public class PludoEnvironmentConfig : ScriptableObject
    {
        [SerializeField] private SupabaseConfig _development;
        [SerializeField] private SupabaseConfig _staging;
        [SerializeField] private SupabaseConfig _production;
        [SerializeField] private string _photonAppId;
        [SerializeField] private string _photonAppVersion = "1.0";
        [SerializeField] private CloudflareR2Config _r2;

        [Header("API Server URLs")]
        [SerializeField] private string _devApiUrl   = "http://localhost:4000";
        [SerializeField] private string _prodApiUrl  = "";

        // Auto-detects: Development in Editor / dev builds, Production in release builds.
        // The React Native shell (PLUDO_NATIVE_SHELL exports) signs users in against
        // the dev Supabase project and talks to the dev API, so Unity must match it
        // or the host's session token is invalid here. Revisit when the shell ships.
        public static PludoEnvironment ActiveEnvironment
        {
            get
            {
#if UNITY_EDITOR || DEVELOPMENT_BUILD || PLUDO_NATIVE_SHELL
                return PludoEnvironment.Development;
#else
                return PludoEnvironment.Production;
#endif
            }
        }

        public string PhotonAppId => _photonAppId;
        public string PhotonAppVersion => _photonAppVersion;
        public CloudflareR2Config R2 => _r2;

        public string ActiveApiUrl => ActiveEnvironment == PludoEnvironment.Production
            ? _prodApiUrl
            : _devApiUrl;

        public SupabaseConfig ActiveSupabase => ActiveEnvironment switch
        {
            PludoEnvironment.Staging    => _staging,
            PludoEnvironment.Production => _production,
            _                           => _development,
        };
    }
}
