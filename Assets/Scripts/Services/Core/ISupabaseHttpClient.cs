using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Pludo.Services.Core
{
    public interface ISupabaseHttpClient
    {
        void SetAccessToken(string token);
        void ClearAccessToken();

        Task<ServiceResult<T>> GetAsync<T>(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult<T>> PostAsync<T>(
            string path,
            object body,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult<T>> PatchAsync<T>(
            string path,
            object body,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult> DeleteAsync(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult<T>> RpcAsync<T>(
            string functionName,
            object args,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult> RpcVoidAsync(
            string functionName,
            object args,
            RequestOptions options = null,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<T>>> GetPagedAsync<T>(
            string path,
            IReadOnlyDictionary<string, string> query = null,
            RequestOptions options = null,
            CancellationToken ct = default);
    }
}
