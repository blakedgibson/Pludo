using System.Threading;
using System.Threading.Tasks;

namespace Pludo.Services.Core
{
    public interface IR2StorageService
    {
        // Upload bytes to R2 under the given key. Returns the resolved URL on success.
        Task<ServiceResult<string>> UploadAsync(
            string key,
            byte[] data,
            string contentType,
            CancellationToken ct = default);

        // Resolve a stored key or passthrough an already-full URL.
        // Uses PublicBaseUrl when configured, otherwise generates a presigned GET URL.
        string GetUrl(string keyOrUrl, int presignedExpirySeconds = 3600);
    }
}
