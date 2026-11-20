#nullable enable
using System.ComponentModel;
using com.IvanMurzak.McpPlugin;

namespace Pludo.Editor.MCP
{
    [McpPluginToolType]
    public partial class Tool_PingProject
    {
        [McpPluginTool
        (
            "ping",
            Title = "Ping",
            ReadOnlyHint = true,
            IdempotentHint = true
        )]
        [Description("Lightweight readiness probe. Returns the input message or 'pong' if omitted.")]
        public string Ping
        (
            [Description("Optional message to echo back.")]
            string? message = null
        )
        {
            return message ?? "pong";
        }
    }
}
