using Pludo.Services.Auth;
using Pludo.Services.Core;
using Pludo.Services.Games;
using Pludo.Services.Inventory;
using Pludo.Services.Multiplayer;
using Pludo.Services.Social;

// Static accessor so any C# script can reach the live service instances
// without needing a serialized Inspector reference.
// All properties are null until ServiceBootstrap.Awake() completes.
public static class PludoServices
{
    public static IAuthService        Auth        { get; internal set; }
    public static IGameCatalogService  Games       { get; internal set; }
    public static IInventoryService    Inventory   { get; internal set; }
    public static IFriendService       Friends     { get; internal set; }
    public static IProfileService      Profile     { get; internal set; }
    public static ISessionService      Session     { get; internal set; }
    public static IMultiplayerService  Multiplayer { get; internal set; }
    public static IR2StorageService    Storage     { get; internal set; }

    public static bool IsReady { get; internal set; }
}
