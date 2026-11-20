// v1 token persistence: AES-256-CBC encryption, key derived from device identifier.
//
// Security model:
//   The derived key is SystemInfo.deviceUniqueIdentifier + a fixed salt, hashed with SHA-256.
//   This is weak if an attacker has both the device and can read PlayerPrefs (rooted/jailbroken
//   devices). It is intentionally stronger than plaintext and covers the common threat (data
//   extracted from a backup or a filesystem copy without the device).
//
// Upgrade path (v2):
//   iOS  — replace with SecKeychain via a native bridge (Keychain Services API).
//   Android — replace with Android Keystore via AndroidJavaObject.
//   Both platforms require a thin native plugin. Swap only this class; ITokenStorage contract
//   and all callers are unchanged. The encrypted PlayerPrefs data will be invalidated on
//   upgrade (users will be re-prompted to sign in once).
//
// Requirements:
//   System.Security.Cryptography.AesManaged must not be stripped by IL2CPP.
//   Add to Assets/link.xml:
//     <assembly fullname="mscorlib">
//       <type fullname="System.Security.Cryptography.AesManaged" preserve="all" />
//       <type fullname="System.Security.Cryptography.SHA256Managed" preserve="all" />
//     </assembly>

using System;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using UnityEngine;

namespace Pludo.Services.Auth
{
    public sealed class PlayerPrefsTokenStorage : ITokenStorage
    {
        private const string PrefsKey = "pludo.session.v1";
        private const string KeySalt  = "pludo_v1_salt";

        public void Save(StoredSession session)
        {
            var json      = JsonConvert.SerializeObject(session);
            var encrypted = Encrypt(json);
            PlayerPrefs.SetString(PrefsKey, encrypted);
            PlayerPrefs.Save();
        }

        public StoredSession Load()
        {
            var raw = PlayerPrefs.GetString(PrefsKey, null);
            if (string.IsNullOrEmpty(raw)) return null;

            try
            {
                var json = Decrypt(raw);
                return JsonConvert.DeserializeObject<StoredSession>(json);
            }
            catch
            {
                // Corrupted data or key changed (e.g., device reset changed unique identifier).
                // Treat as no session — user will be prompted to sign in again.
                Clear();
                return null;
            }
        }

        public void Clear()
        {
            PlayerPrefs.DeleteKey(PrefsKey);
            PlayerPrefs.Save();
        }

        // ── AES-256-CBC encryption ────────────────────────────────────────────

        private static string Encrypt(string plaintext)
        {
            var key = DeriveKey();
            using var aes = new AesManaged { Key = key };
            aes.GenerateIV();

            using var encryptor = aes.CreateEncryptor();
            var plainBytes  = Encoding.UTF8.GetBytes(plaintext);
            var cipherBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);

            // Layout: [16-byte IV][ciphertext]
            var result = new byte[aes.IV.Length + cipherBytes.Length];
            Buffer.BlockCopy(aes.IV, 0, result, 0, aes.IV.Length);
            Buffer.BlockCopy(cipherBytes, 0, result, aes.IV.Length, cipherBytes.Length);
            return Convert.ToBase64String(result);
        }

        private static string Decrypt(string ciphertext)
        {
            var bytes = Convert.FromBase64String(ciphertext);
            var key   = DeriveKey();

            const int ivLength = 16;
            if (bytes.Length <= ivLength)
                throw new ArgumentException("Ciphertext too short");

            var iv          = new byte[ivLength];
            var cipherBytes = new byte[bytes.Length - ivLength];
            Buffer.BlockCopy(bytes, 0, iv, 0, ivLength);
            Buffer.BlockCopy(bytes, ivLength, cipherBytes, 0, cipherBytes.Length);

            using var aes = new AesManaged { Key = key, IV = iv };
            using var decryptor = aes.CreateDecryptor();
            var plainBytes = decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length);
            return Encoding.UTF8.GetString(plainBytes);
        }

        private static byte[] DeriveKey()
        {
            var raw = SystemInfo.deviceUniqueIdentifier + KeySalt;
            using var sha = new SHA256Managed();
            return sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
        }
    }
}
