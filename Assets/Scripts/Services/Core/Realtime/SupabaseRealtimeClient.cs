// Requires Unity 2021.2+ (.NET Standard 2.1) for:
//   - System.Net.WebSockets.ClientWebSocket
//   - System.Threading.Channels
//   - IAsyncEnumerable / await foreach
//
// Does NOT support WebGL (ClientWebSocket is not available on that platform).
// For WebGL, subclass or replace this with a Unity-native WebSocket wrapper.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Pludo.Services.Core.Realtime;
using UnityEngine;

namespace Pludo.Services.Core.Realtime
{
    public sealed class SupabaseRealtimeClient : IRealtimeClient, IDisposable
    {
        // ── Config ────────────────────────────────────────────────────────────

        private readonly string      _wsUrl;            // wss://xyz.supabase.co/realtime/v1/websocket
        private readonly string      _anonKey;
        private readonly Func<string> _getAccessToken;  // Returns current JWT; null if unauthenticated

        // ── Connection state ──────────────────────────────────────────────────

        private ClientWebSocket            _ws;
        private CancellationTokenSource    _connectionCts;
        private bool                       _isConnected;
        private readonly SemaphoreSlim     _connectGate = new SemaphoreSlim(1, 1);
        private readonly SemaphoreSlim     _sendGate    = new SemaphoreSlim(1, 1);

        // ── Channel registry ──────────────────────────────────────────────────

        // topic → channel state. Accessed only from the Unity main thread.
        private readonly Dictionary<string, ChannelState> _channels
            = new Dictionary<string, ChannelState>();

        // ref → TCS awaiting the phx_reply for a join request.
        private readonly Dictionary<string, TaskCompletionSource<bool>> _pendingReplies
            = new Dictionary<string, TaskCompletionSource<bool>>();

        private int _refSeq;  // Monotonically increasing; NextRef() is the only writer.

        // Backoff schedule for reconnection attempts (milliseconds).
        private static readonly int[] ReconnectBackoffMs = { 1_000, 2_000, 4_000, 8_000, 16_000, 30_000 };

        // ── Constructor ───────────────────────────────────────────────────────

        public SupabaseRealtimeClient(SupabaseConfig config, Func<string> getAccessToken)
        {
            // Replace https/http with wss/ws so the config URL can be reused as-is.
            var baseUrl   = config.ProjectUrl.TrimEnd('/');
            _wsUrl         = (baseUrl.StartsWith("https") ? "wss" + baseUrl.Substring(5) : "ws" + baseUrl.Substring(4))
                           + "/realtime/v1/websocket"
                           + $"?apikey={Uri.EscapeDataString(config.AnonKey)}&vsn=1.0.0";
            _anonKey        = config.AnonKey;
            _getAccessToken = getAccessToken;
        }

        // ── IRealtimeClient ───────────────────────────────────────────────────

        public async Task EnsureConnectedAsync(CancellationToken ct = default)
        {
            if (_isConnected) return;

            await _connectGate.WaitAsync(ct);
            try
            {
                if (_isConnected) return;
                await ConnectAndStartLoopsAsync(ct);
            }
            finally
            {
                _connectGate.Release();
            }
        }

        public async IAsyncEnumerable<PostgresChangeEvent> SubscribeToTableChangesAsync(
            string schema,
            string table,
            string eventFilter,
            string rowFilter,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await EnsureConnectedAsync(ct);

            var topic   = $"realtime:{schema}:{table}";
            var channel = await JoinPostgresChannelAsync(topic, schema, table, eventFilter, rowFilter, ct);

            try
            {
                await foreach (var msg in channel.Reader.ReadAllAsync(ct))
                {
                    var evt = ParsePostgresChange(msg);
                    if (evt != null) yield return evt;
                }
            }
            finally
            {
                channel.Writer.TryComplete();
                _ = LeaveChannelAsync(topic);
            }
        }

        public async IAsyncEnumerable<PresenceChangeEvent> SubscribeToPresenceAsync(
            string channelName,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await EnsureConnectedAsync(ct);

            var topic   = $"realtime:{channelName}";
            var channel = await JoinPresenceChannelAsync(topic, ct);

            try
            {
                await foreach (var msg in channel.Reader.ReadAllAsync(ct))
                {
                    foreach (var evt in ParsePresenceEvents(msg))
                        yield return evt;
                }
            }
            finally
            {
                channel.Writer.TryComplete();
                _ = LeaveChannelAsync(topic);
            }
        }

        public async Task TrackPresenceAsync(
            string channelName,
            string key,
            object payload,
            CancellationToken ct = default)
        {
            await EnsureConnectedAsync(ct);

            var topic = $"realtime:{channelName}";
            if (!_channels.ContainsKey(topic))
                await JoinPresenceChannelAsync(topic, ct);

            await SendAsync(new PhxMessage
            {
                Topic   = topic,
                Event   = "presence",
                Ref     = NextRef(),
                JoinRef = _channels.TryGetValue(topic, out var ch) ? ch.JoinRef : null,
                Payload = JToken.FromObject(new
                {
                    @event   = "track",
                    payload  = payload,
                }),
            }, ct);
        }

        public async Task UntrackPresenceAsync(
            string channelName,
            CancellationToken ct = default)
        {
            var topic = $"realtime:{channelName}";
            if (!_channels.ContainsKey(topic)) return;

            await SendAsync(new PhxMessage
            {
                Topic   = topic,
                Event   = "presence",
                Ref     = NextRef(),
                JoinRef = _channels[topic].JoinRef,
                Payload = JToken.FromObject(new { @event = "untrack" }),
            }, ct);
        }

        // ── Connect / disconnect ──────────────────────────────────────────────

        private async Task ConnectAndStartLoopsAsync(CancellationToken ct)
        {
            _connectionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var loopCt = _connectionCts.Token;

            _ws = new ClientWebSocket();
            await _ws.ConnectAsync(new Uri(_wsUrl), ct);
            _isConnected = true;

            _ = ReceiveLoopAsync(loopCt);
            _ = HeartbeatLoopAsync(loopCt);
        }

        private async Task ReconnectAsync()
        {
            _isConnected = false;

            for (int attempt = 0; ; attempt++)
            {
                var delayMs = ReconnectBackoffMs[Math.Min(attempt, ReconnectBackoffMs.Length - 1)];
                await Task.Delay(delayMs);

                try
                {
                    _ws?.Dispose();
                    _ws = new ClientWebSocket();
                    await _ws.ConnectAsync(new Uri(_wsUrl), _connectionCts.Token);
                    _isConnected = true;
                    Debug.Log($"[Realtime] Reconnected after {attempt + 1} attempt(s)");

                    // Rejoin all active channels so subscriptions resume.
                    foreach (var kvp in _channels)
                        await RejoinChannelAsync(kvp.Value);

                    return;
                }
                catch (OperationCanceledException) { return; }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[Realtime] Reconnect attempt {attempt + 1} failed: {ex.Message}");
                }
            }
        }

        // ── Background loops ──────────────────────────────────────────────────

        private async Task ReceiveLoopAsync(CancellationToken ct)
        {
            var buffer = new byte[8192];
            using var ms = new MemoryStream();

            try
            {
                while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
                {
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                        ms.Write(buffer, 0, result.Count);
                    }
                    while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close)
                        break;

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var json = Encoding.UTF8.GetString(ms.ToArray());
                        RouteMessage(json);
                    }

                    ms.SetLength(0);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Realtime] Receive error: {ex.Message}");
            }

            if (!ct.IsCancellationRequested)
                _ = ReconnectAsync();
        }

        private async Task HeartbeatLoopAsync(CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(25_000, ct);
                    if (!_isConnected) continue;

                    await SendAsync(new PhxMessage
                    {
                        Topic   = "phoenix",
                        Event   = "heartbeat",
                        Ref     = NextRef(),
                        Payload = new JObject(),
                    }, ct);
                }
            }
            catch (OperationCanceledException) { }
        }

        // ── Message routing ───────────────────────────────────────────────────

        private void RouteMessage(string json)
        {
            PhxMessage msg;
            try { msg = JsonConvert.DeserializeObject<PhxMessage>(json); }
            catch { return; }

            if (msg == null) return;

            // Resolve pending join acks.
            if (msg.Event == "phx_reply" && msg.Ref != null)
            {
                if (_pendingReplies.TryGetValue(msg.Ref, out var tcs))
                {
                    _pendingReplies.Remove(msg.Ref);
                    var status = msg.Payload?["status"]?.Value<string>();
                    if (status == "ok") tcs.TrySetResult(true);
                    else tcs.TrySetException(new Exception($"Channel join failed: {msg.Payload}"));
                }
                return;
            }

            // Route data events to the appropriate channel queue.
            if (msg.Topic != null && _channels.TryGetValue(msg.Topic, out var channel))
                channel.Queue.Writer.TryWrite(msg);
        }

        // ── Channel join / leave ──────────────────────────────────────────────

        private async Task<System.Threading.Channels.Channel<PhxMessage>> JoinPostgresChannelAsync(
            string topic, string schema, string table,
            string eventFilter, string rowFilter,
            CancellationToken ct)
        {
            var queue   = System.Threading.Channels.Channel.CreateBounded<PhxMessage>(
                new System.Threading.Channels.BoundedChannelOptions(128)
                { FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest });

            var joinRef = NextRef();
            var tcs     = new TaskCompletionSource<bool>();
            _pendingReplies[joinRef] = tcs;

            var pgChange = rowFilter != null
                ? (object)new { @event = eventFilter, schema, table, filter = rowFilter }
                : new { @event = eventFilter, schema, table };

            await SendAsync(new PhxMessage
            {
                Topic   = topic,
                Event   = "phx_join",
                Ref     = joinRef,
                JoinRef = joinRef,
                Payload = JToken.FromObject(new
                {
                    config         = new { postgres_changes = new[] { pgChange } },
                    access_token   = _getAccessToken?.Invoke() ?? string.Empty,
                }),
            }, ct);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            var joinWinner1 = await Task.WhenAny(tcs.Task, Task.Delay(Timeout.Infinite, cts.Token));
            if (joinWinner1 != tcs.Task) cts.Token.ThrowIfCancellationRequested();
            await tcs.Task;

            // Capture variables for the rejoin closure; token is re-read on each call.
            var capturedPgChange = pgChange;
            var state = new ChannelState
            {
                Topic        = topic,
                JoinRef      = joinRef,
                Queue        = queue,
                IsPresence   = false,
                BuildPayload = () => JToken.FromObject(new
                {
                    config       = new { postgres_changes = new[] { capturedPgChange } },
                    access_token = _getAccessToken?.Invoke() ?? string.Empty,
                }),
            };
            _channels[topic] = state;
            return queue;
        }

        private async Task<System.Threading.Channels.Channel<PhxMessage>> JoinPresenceChannelAsync(
            string topic,
            CancellationToken ct)
        {
            if (_channels.TryGetValue(topic, out var existing))
                return existing.Queue;

            var queue   = System.Threading.Channels.Channel.CreateBounded<PhxMessage>(
                new System.Threading.Channels.BoundedChannelOptions(128)
                { FullMode = System.Threading.Channels.BoundedChannelFullMode.DropOldest });

            var joinRef = NextRef();
            var tcs     = new TaskCompletionSource<bool>();
            _pendingReplies[joinRef] = tcs;

            await SendAsync(new PhxMessage
            {
                Topic   = topic,
                Event   = "phx_join",
                Ref     = joinRef,
                JoinRef = joinRef,
                Payload = JToken.FromObject(new
                {
                    config       = new { presence = new { key = string.Empty } },
                    access_token = _getAccessToken?.Invoke() ?? string.Empty,
                }),
            }, ct);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            var joinWinner2 = await Task.WhenAny(tcs.Task, Task.Delay(Timeout.Infinite, cts.Token));
            if (joinWinner2 != tcs.Task) cts.Token.ThrowIfCancellationRequested();
            await tcs.Task;

            var state = new ChannelState
            {
                Topic        = topic,
                JoinRef      = joinRef,
                Queue        = queue,
                IsPresence   = true,
                BuildPayload = () => JToken.FromObject(new
                {
                    config       = new { presence = new { key = string.Empty } },
                    access_token = _getAccessToken?.Invoke() ?? string.Empty,
                }),
            };
            _channels[topic] = state;
            return queue;
        }

        private async Task LeaveChannelAsync(string topic)
        {
            if (!_channels.TryGetValue(topic, out var state)) return;
            _channels.Remove(topic);

            if (!_isConnected) return;
            try
            {
                await SendAsync(new PhxMessage
                {
                    Topic   = topic,
                    Event   = "phx_leave",
                    Ref     = NextRef(),
                    JoinRef = state.JoinRef,
                    Payload = new JObject(),
                }, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Realtime] Leave failed for {topic}: {ex.Message}");
            }
        }

        // Re-sends the join message for a channel after reconnection.
        private async Task RejoinChannelAsync(ChannelState state)
        {
            var tcs = new TaskCompletionSource<bool>();
            _pendingReplies[state.JoinRef] = tcs;

            // Re-use the existing JoinRef so the reply routes to the existing TCS.
            // BuildPayload() refreshes the access_token for the new session.
            // The channel queue is preserved; subscribers continue to receive events.
            await SendAsync(new PhxMessage
            {
                Topic   = state.Topic,
                Event   = "phx_join",
                Ref     = state.JoinRef,
                JoinRef = state.JoinRef,
                Payload = state.BuildPayload(),
            }, CancellationToken.None);
        }

        // ── Send ──────────────────────────────────────────────────────────────

        private async Task SendAsync(PhxMessage msg, CancellationToken ct)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            var json  = JsonConvert.SerializeObject(msg, SupabaseHttp.JsonSettings);
            var bytes = new ArraySegment<byte>(Encoding.UTF8.GetBytes(json));

            await _sendGate.WaitAsync(ct);
            try
            {
                await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
            }
            finally
            {
                _sendGate.Release();
            }
        }

        // ── Event parsers ─────────────────────────────────────────────────────

        private static PostgresChangeEvent ParsePostgresChange(PhxMessage msg)
        {
            if (msg.Event != "postgres_changes") return null;

            var data = msg.Payload?["data"];
            if (data == null) return null;

            var typStr = data["type"]?.Value<string>() ?? data["eventType"]?.Value<string>();
            if (!TryParseChangeType(typStr, out var changeType)) return null;

            return new PostgresChangeEvent
            {
                ChangeType   = changeType,
                Schema       = data["schema"]?.Value<string>(),
                Table        = data["table"]?.Value<string>(),
                RawRecord    = data["record"]?.ToString(Formatting.None),
                RawOldRecord = data["old_record"]?.ToString(Formatting.None),
            };
        }

        private static IEnumerable<PresenceChangeEvent> ParsePresenceEvents(PhxMessage msg)
        {
            if (msg.Event == "presence_state" && msg.Payload != null)
            {
                foreach (var prop in (JObject)msg.Payload)
                {
                    yield return new PresenceChangeEvent
                    {
                        ChangeType = PresenceChangeType.Sync,
                        Key        = prop.Key,
                        RawPayload = ((JArray)prop.Value).First?.ToString(Formatting.None),
                    };
                }
                yield break;
            }

            if (msg.Event == "presence_diff" && msg.Payload != null)
            {
                var joins  = msg.Payload["joins"]  as JObject;
                var leaves = msg.Payload["leaves"] as JObject;

                if (joins != null)
                    foreach (var prop in joins)
                        yield return new PresenceChangeEvent
                        {
                            ChangeType = PresenceChangeType.Join,
                            Key        = prop.Key,
                            RawPayload = ((JArray)prop.Value).First?.ToString(Formatting.None),
                        };

                if (leaves != null)
                    foreach (var prop in leaves)
                        yield return new PresenceChangeEvent
                        {
                            ChangeType = PresenceChangeType.Leave,
                            Key        = prop.Key,
                            RawPayload = ((JArray)prop.Value).First?.ToString(Formatting.None),
                        };
            }
        }

        private static bool TryParseChangeType(string s, out PostgresChangeType t)
        {
            switch (s?.ToUpperInvariant())
            {
                case "INSERT": t = PostgresChangeType.Insert; return true;
                case "UPDATE": t = PostgresChangeType.Update; return true;
                case "DELETE": t = PostgresChangeType.Delete; return true;
                default:       t = default;                   return false;
            }
        }

        // ── Helpers ───────────────────────────────────────────────────────────

        private string NextRef() => System.Threading.Interlocked.Increment(ref _refSeq).ToString();

        public void Dispose()
        {
            _connectionCts?.Cancel();
            _connectionCts?.Dispose();
            _ws?.Dispose();
        }

        // ── Internal types ────────────────────────────────────────────────────

        private sealed class ChannelState
        {
            public string                                            Topic        { get; set; }
            public string                                            JoinRef      { get; set; }
            public System.Threading.Channels.Channel<PhxMessage>    Queue        { get; set; }
            public bool                                              IsPresence   { get; set; }
            // Returns the join payload, refreshing the access_token on each call.
            // Stored as a Func so the token is always current after reconnection.
            public Func<JToken>                                      BuildPayload { get; set; }
        }

        private sealed class PhxMessage
        {
            [JsonProperty("topic")]    public string Topic    { get; set; }
            [JsonProperty("event")]    public string Event    { get; set; }
            [JsonProperty("payload")]  public JToken Payload  { get; set; }
            [JsonProperty("ref")]      public string Ref      { get; set; }
            [JsonProperty("join_ref")] public string JoinRef  { get; set; }
        }
    }
}
