using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Pludo.Services.Core;
using Social = Pludo.Services.Social;

namespace Pludo.Services.Inventory
{
    public sealed class InventoryService : IInventoryService
    {
        private readonly ISupabaseHttpClient _http;
        private readonly IR2StorageService   _r2;

        public InventoryService(ISupabaseHttpClient http, IR2StorageService r2 = null)
        {
            _http = http;
            _r2   = r2;
        }

        // ── Reads ─────────────────────────────────────────────────────────────

        public async Task<ServiceResult<PagedResult<InventoryEntry>>> GetInventoryAsync(
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var limit = page.Limit > 0 ? page.Limit : 20;

            return (await _http.GetPagedAsync<InventoryRow>(
                "user_inventory",
                new Dictionary<string, string>
                {
                    // RLS restricts rows to auth.uid(); explicit user_id filter omitted intentionally
                    // to keep the query symmetric with all other inventory reads.
                    ["select"] = InventorySelect,
                    ["order"]  = "acquired_at.desc",
                },
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<InventoryEntry>(
                    MapInventoryEntries(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // Reconstructs AvatarConfig from inventory rows where equipped = true.
        // This is the authoritative source for the caller's own loadout — users.avatar_config
        // is a denormalized cache for other players and may lag behind equip/unequip RPCs.
        public async Task<ServiceResult<Social.AvatarConfig>> GetEquippedConfigAsync(
            CancellationToken ct = default)
        {
            var result = await _http.GetAsync<InventoryRow[]>(
                "user_inventory",
                new Dictionary<string, string>
                {
                    ["equipped"] = "eq.true",
                    ["select"]   = InventorySelect,
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<Social.AvatarConfig>.Fail(result.Error);

            var equipped = new Dictionary<string, string>();
            if (result.Value != null)
                foreach (var row in result.Value)
                    if (row?.Item?.ItemType != null)
                        equipped[row.Item.ItemType.ToLower()] = row.Item.Id;

            return ServiceResult<Social.AvatarConfig>.Ok(new Social.AvatarConfig { EquippedItems = equipped });
        }

        // ── Mutations (SECURITY DEFINER RPCs) ────────────────────────────────

        public Task<ServiceResult> EquipItemAsync(
            string itemId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("equip_item", new { p_item_id = itemId }, ct: ct);

        public Task<ServiceResult> UnequipItemAsync(
            string itemId,
            CancellationToken ct = default) =>
            _http.RpcVoidAsync("unequip_item", new { p_item_id = itemId }, ct: ct);

        // ── Avatar item catalog (public read) ─────────────────────────────────

        public async Task<ServiceResult<AvatarItem>> GetAvatarItemAsync(
            string itemId,
            CancellationToken ct = default)
        {
            var result = await _http.GetAsync<AvatarItemDto[]>(
                "avatar_items",
                new Dictionary<string, string>
                {
                    ["id"]     = $"eq.{itemId}",
                    ["limit"]  = "1",
                    ["select"] = AvatarItemColumns,
                },
                ct: ct);

            if (!result.IsSuccess) return ServiceResult<AvatarItem>.Fail(result.Error);
            if (result.Value == null || result.Value.Length == 0)
                return ServiceResult<AvatarItem>.Fail(ServiceError.Domain("Item not found"));

            return ServiceResult<AvatarItem>.Ok(result.Value[0].ToModel(_r2));
        }

        public async Task<ServiceResult<PagedResult<AvatarItem>>> GetPublicItemsAsync(
            AvatarItemType? itemType = null,
            PageRequest page = default,
            CancellationToken ct = default)
        {
            var limit = page.Limit > 0 ? page.Limit : 20;

            var query = new Dictionary<string, string>
            {
                ["is_public"] = "eq.true",
                ["select"]    = AvatarItemColumns,
                ["order"]     = "created_at.desc",
            };

            if (itemType.HasValue)
                query["item_type"] = $"eq.{itemType.Value.ToString().ToLower()}";

            return (await _http.GetPagedAsync<AvatarItemDto>(
                "avatar_items",
                query,
                new RequestOptions
                {
                    Range = RangeHeader.ForPage(page.Offset, limit),
                },
                ct))
                .Map(paged => new PagedResult<AvatarItem>(MapAvatarItems(paged.Items), paged.TotalCount, paged.HasMore));
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        // Embedded join: inventory row + avatar_items columns via item_id FK.
        private const string InventorySelect =
            "equipped,acquired_at,item:avatar_items(id,name,description,item_type,mesh_url,thumbnail_url,generation_prompt,is_public,created_at)";

        private const string AvatarItemColumns =
            "id,name,description,item_type,mesh_url,thumbnail_url,generation_prompt,is_public,created_at";

        private IReadOnlyList<InventoryEntry> MapInventoryEntries(
            IReadOnlyList<InventoryRow> rows)
        {
            var result = new InventoryEntry[rows.Count];
            for (int i = 0; i < rows.Count; i++)
                result[i] = new InventoryEntry
                {
                    Item       = rows[i].Item?.ToModel(_r2),
                    Equipped   = rows[i].Equipped,
                    AcquiredAt = rows[i].AcquiredAt,
                };
            return result;
        }

        private IReadOnlyList<AvatarItem> MapAvatarItems(
            IReadOnlyList<AvatarItemDto> dtos)
        {
            var result = new AvatarItem[dtos.Count];
            for (int i = 0; i < dtos.Count; i++)
                result[i] = dtos[i].ToModel(_r2);
            return result;
        }

        // ── Private DTOs ──────────────────────────────────────────────────────

        private sealed class AvatarItemDto
        {
            [JsonProperty("id")]                 public string  Id               { get; set; }
            [JsonProperty("name")]               public string  Name             { get; set; }
            [JsonProperty("description")]        public string  Description      { get; set; }
            [JsonProperty("item_type")]          public string  ItemType         { get; set; }
            [JsonProperty("mesh_url")]           public string  MeshUrl          { get; set; }
            [JsonProperty("thumbnail_url")]      public string  ThumbnailUrl     { get; set; }
            [JsonProperty("generation_prompt")]  public string  GenerationPrompt { get; set; }
            [JsonProperty("is_public")]          public bool    IsPublic         { get; set; }
            [JsonProperty("created_at")]         public System.DateTime CreatedAt { get; set; }

            public AvatarItem ToModel(IR2StorageService r2 = null) => new AvatarItem
            {
                Id               = Id,
                Name             = Name,
                Description      = Description,
                ItemType         = ParseItemType(ItemType),
                MeshUrl          = r2 != null ? r2.GetUrl(MeshUrl) : MeshUrl,
                ThumbnailUrl     = ThumbnailUrl,
                GenerationPrompt = GenerationPrompt,
                IsPublic         = IsPublic,
                CreatedAt        = CreatedAt,
            };

            private static AvatarItemType ParseItemType(string raw) =>
                System.Enum.TryParse<AvatarItemType>(raw, ignoreCase: true, out var v) ? v : AvatarItemType.Accessory;
        }

        // Embedded join result for GET /user_inventory?select=...,item:avatar_items(...)
        private sealed class InventoryRow
        {
            [JsonProperty("equipped")]    public bool          Equipped    { get; set; }
            [JsonProperty("acquired_at")] public System.DateTime AcquiredAt { get; set; }
            [JsonProperty("item")]        public AvatarItemDto Item        { get; set; }
        }
    }
}
