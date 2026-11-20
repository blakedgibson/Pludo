using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Core;

namespace Pludo.Services.Games
{
    public sealed class GameCatalogService : IGameCatalogService
    {
        private readonly ISupabaseHttpClient _http;
        private readonly IR2StorageService   _r2;

        public GameCatalogService(ISupabaseHttpClient http, IR2StorageService r2 = null)
        {
            _http = http;
            _r2   = r2;
        }

        // ── Reads ─────────────────────────────────────────────────────────────

        public async Task<ServiceResult<PagedResult<GeneratedGame>>> GetPublicGamesAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<GeneratedGameDto>(
                "games",
                new Dictionary<string, string>
                {
                    ["is_public"] = "eq.true",
                    ["select"]    = GameColumns,
                    ["order"]     = "created_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<GeneratedGame>(
                    MapGames(paged.Items), paged.TotalCount, paged.HasMore));
        }

        public async Task<ServiceResult<GeneratedGame>> GetGameAsync(
            string gameId,
            CancellationToken ct = default)
        {
            var result = await _http.GetAsync<GeneratedGameDto[]>(
                "games",
                new Dictionary<string, string>
                {
                    ["id"]    = $"eq.{gameId}",
                    ["limit"] = "1",
                    ["select"] = GameColumns,
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<GeneratedGame>.Fail(result.Error);
            if (result.Value == null || result.Value.Length == 0)
                return ServiceResult<GeneratedGame>.Fail(ServiceError.Domain("Game not found"));

            return ServiceResult<GeneratedGame>.Ok(result.Value[0].ToModel(_r2));
        }

        // Excludes rows where created_by_user_id IS NULL (AI-generated orphaned games that
        // have no owning user; they should only appear in public browse, not in "my games").
        public async Task<ServiceResult<PagedResult<GeneratedGame>>> GetMyGamesAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<GeneratedGameDto>(
                "games",
                new Dictionary<string, string>
                {
                    // RLS enforces created_by_user_id = auth.uid(); the not.is.null guard
                    // is a belt-and-suspenders defence against the orphan case.
                    ["created_by_user_id"] = "not.is.null",
                    ["select"]             = GameColumns,
                    ["order"]              = "created_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<GeneratedGame>(
                    MapGames(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // tagMatchMode controls the PostgREST array operator applied to the tags[] column:
        //   Any → "ov" (overlap — at least one tag matches; hits GIN index)
        //   All → "cs" (contains — all supplied tags must be present; hits GIN index)
        public async Task<ServiceResult<PagedResult<GeneratedGame>>> SearchByTagsAsync(
            IReadOnlyList<string> tags,
            TagMatchMode tagMatchMode = TagMatchMode.Any,
            PageRequest page = default,
            CancellationToken ct = default)
        {
            if (tags == null || tags.Count == 0)
                return ServiceResult<PagedResult<GeneratedGame>>.Ok(
                    new PagedResult<GeneratedGame>(new GeneratedGame[0], 0, false));

            var limit = page.Limit > 0 ? page.Limit : 20;
            var op    = tagMatchMode == TagMatchMode.All ? "cs" : "ov";

            // PostgREST array literal format: {tag1,tag2,...}
            var tagLiteral = $"{{{string.Join(",", tags)}}}";

            return (await _http.GetPagedAsync<GeneratedGameDto>(
                "games",
                new Dictionary<string, string>
                {
                    ["is_public"] = "eq.true",
                    ["tags"]      = $"{op}.{tagLiteral}",
                    ["select"]    = GameColumns,
                    ["order"]     = "created_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<GeneratedGame>(
                    MapGames(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        private const string GameColumns =
            "id,title,description,generation_prompt,bundle_url,thumbnail_url,created_by_user_id,play_count,is_public,tags,created_at";

        private IReadOnlyList<GeneratedGame> MapGames(IReadOnlyList<GeneratedGameDto> dtos)
        {
            var result = new GeneratedGame[dtos.Count];
            for (int i = 0; i < dtos.Count; i++)
                result[i] = dtos[i].ToModel(_r2);
            return result;
        }

        // ── Private DTOs ──────────────────────────────────────────────────────

        private sealed class GeneratedGameDto
        {
            [JsonProperty("id")]                   public string         Id               { get; set; }
            [JsonProperty("title")]                public string         Title            { get; set; }
            [JsonProperty("description")]          public string         Description      { get; set; }
            [JsonProperty("generation_prompt")]    public string         GenerationPrompt { get; set; }
            [JsonProperty("bundle_url")]           public string         BundleUrl        { get; set; }
            [JsonProperty("thumbnail_url")]        public string         ThumbnailUrl     { get; set; }
            [JsonProperty("created_by_user_id")]   public string         CreatedByUserId  { get; set; }
            [JsonProperty("play_count")]           public int            PlayCount        { get; set; }
            [JsonProperty("is_public")]            public bool           IsPublic         { get; set; }
            [JsonProperty("tags")]                 public List<string>   Tags             { get; set; }
            [JsonProperty("created_at")]           public System.DateTime CreatedAt       { get; set; }

            public GeneratedGame ToModel(IR2StorageService r2 = null) => new GeneratedGame
            {
                Id               = Id,
                Title            = Title,
                Description      = Description,
                GenerationPrompt = GenerationPrompt,
                BundleUrl        = r2 != null ? r2.GetUrl(BundleUrl) : BundleUrl,
                ThumbnailUrl     = ThumbnailUrl,
                CreatedByUserId  = CreatedByUserId,
                PlayCount        = PlayCount,
                IsPublic         = IsPublic,
                Tags             = Tags,
                CreatedAt        = CreatedAt,
            };
        }
    }
}
