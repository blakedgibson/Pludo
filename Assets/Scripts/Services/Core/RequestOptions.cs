namespace Pludo.Services.Core
{
    public sealed class RequestOptions
    {
        public bool ReturnRepresentation { get; set; }
        public bool CountExact { get; set; }
        public RangeHeader? Range { get; set; }
        public string AcceptProfile { get; set; }
        public string ContentProfile { get; set; }
    }

    public readonly struct RangeHeader
    {
        public int From { get; }
        public int To { get; }  // -1 = open end

        public RangeHeader(int from, int to = -1)
        {
            From = from;
            To = to;
        }

        public static RangeHeader ForPage(int offset, int limit) =>
            new RangeHeader(offset, offset + limit - 1);
    }
}
