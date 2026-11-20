using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Pludo.Services.Core.Realtime
{
    public interface IRealtimeClient
    {
        // Establishes the WebSocket connection if not already connected.
        // Called automatically by Subscribe methods; callers may pre-connect
        // at bootstrap to reduce first-subscription latency.
        Task EnsureConnectedAsync(CancellationToken ct = default);

        // Subscribes to Postgres row changes on a table. Yields one event per matching
        // row change until ct is cancelled, at which point the channel is left cleanly.
        //
        // eventFilter: "INSERT", "UPDATE", "DELETE", or "*" for all.
        // rowFilter:   PostgREST-style row filter, e.g. "friend_id=eq.{uid}", or null.
        //
        // Note: WebGL is not supported by System.Net.WebSockets.ClientWebSocket.
        // A separate WebGL-specific implementation is required for that platform.
        IAsyncEnumerable<PostgresChangeEvent> SubscribeToTableChangesAsync(
            string schema,
            string table,
            string eventFilter,
            string rowFilter,
            CancellationToken ct);

        // Subscribes to presence join/leave/sync events on a named channel.
        // Yields one PresenceChangeEvent per key-level change until ct is cancelled.
        IAsyncEnumerable<PresenceChangeEvent> SubscribeToPresenceAsync(
            string channelName,
            CancellationToken ct);

        // Announces the caller's presence on a channel with an arbitrary payload.
        // key uniquely identifies this presence entry (typically the user's UUID).
        // Calling TrackPresenceAsync again with the same key replaces the payload.
        Task TrackPresenceAsync(
            string channelName,
            string key,
            object payload,
            CancellationToken ct = default);

        // Removes the caller's presence entry from a channel.
        // Silent no-op if not currently tracking on that channel.
        Task UntrackPresenceAsync(
            string channelName,
            CancellationToken ct = default);
    }
}
