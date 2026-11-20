using System.Collections.Generic;

namespace Pludo.Services.Core
{
    public readonly struct PageRequest
    {
        public int Offset { get; }
        public int Limit { get; }

        public PageRequest(int offset, int limit)
        {
            Offset = offset;
            Limit = limit;
        }

        public static PageRequest First(int limit = 20) => new PageRequest(0, limit);
    }

    public readonly struct PagedResult<T>
    {
        public IReadOnlyList<T> Items { get; }
        public int? TotalCount { get; }
        public bool HasMore { get; }

        public PagedResult(IReadOnlyList<T> items, int? totalCount, bool hasMore)
        {
            Items = items;
            TotalCount = totalCount;
            HasMore = hasMore;
        }
    }
}
