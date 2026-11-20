namespace Pludo.Services.Core.Realtime
{
    public enum PostgresChangeType { Insert, Update, Delete }
    public enum PresenceChangeType  { Sync, Join, Leave }

    public sealed class PostgresChangeEvent
    {
        public PostgresChangeType ChangeType    { get; set; }
        public string             Schema        { get; set; }
        public string             Table         { get; set; }
        public string             RawRecord     { get; set; }     // JSON of new/updated row
        public string             RawOldRecord  { get; set; }     // JSON of pre-update row (UPDATE/DELETE)
    }

    // One event per presence key that changed. For Sync events (initial presence_state),
    // one event is emitted per key currently in the channel. For Join/Leave, one event
    // per key in the diff's joins/leaves map.
    public sealed class PresenceChangeEvent
    {
        public PresenceChangeType ChangeType  { get; set; }
        public string             Key         { get; set; }   // User-defined presence key
        public string             RawPayload  { get; set; }   // JSON of the first presence payload
    }
}
