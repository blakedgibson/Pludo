using UnityEngine;

namespace Pludo.Services.Core
{
    [CreateAssetMenu(menuName = "Pludo/Supabase Config", fileName = "SupabaseConfig")]
    public class SupabaseConfig : ScriptableObject
    {
        [SerializeField] private string _projectUrl;
        [SerializeField] private string _anonKey;

        public string ProjectUrl => _projectUrl;
        public string AnonKey => _anonKey;
    }
}
