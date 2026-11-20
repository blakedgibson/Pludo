using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Pludo.Services.Core;

namespace Pludo.Services.Games
{
    public interface IGameCatalogService
    {
        Task<ServiceResult<PagedResult<GeneratedGame>>> GetPublicGamesAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        Task<ServiceResult<GeneratedGame>> GetGameAsync(
            string gameId,
            CancellationToken ct = default);

        Task<ServiceResult<PagedResult<GeneratedGame>>> GetMyGamesAsync(
            PageRequest page = default,
            CancellationToken ct = default);

        // tagMatchMode controls the PostgREST operator: Any → ov (overlap), All → cs (contains).
        // Both use the GIN index on the tags column.
        Task<ServiceResult<PagedResult<GeneratedGame>>> SearchByTagsAsync(
            IReadOnlyList<string> tags,
            TagMatchMode tagMatchMode = TagMatchMode.Any,
            PageRequest page = default,
            CancellationToken ct = default);
    }
}
