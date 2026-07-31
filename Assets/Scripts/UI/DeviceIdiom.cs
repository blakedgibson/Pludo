using UnityEngine;

// Tablet vs. phone detection for iPad/tablet-optimized layouts.
// On-device this checks the real iOS device generation; everywhere else
// (Unity Editor incl. Device Simulator, Android, etc.) it falls back to an
// aspect-ratio heuristic. The heuristic doubles as the Editor testing path:
// simulating an iPad in the Device Simulator sets Screen.width/height to the
// iPad's point resolution, which the heuristic correctly reads as tablet.
public static class DeviceIdiom
{
    // iPhones sit around 2.1-2.2 (long/short side). iPads sit around 1.3-1.4.
    // 1.6 cleanly separates the two families with margin on both sides.
    private const float TabletAspectThreshold = 1.6f;

    public static bool IsTablet
    {
        get
        {
#if UNITY_IOS && !UNITY_EDITOR
            string generation = UnityEngine.iOS.Device.generation.ToString();
            if (generation.IndexOf("iPad", System.StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (generation.IndexOf("iPhone", System.StringComparison.OrdinalIgnoreCase) >= 0) return false;
#endif
            int w = Mathf.Max(1, Screen.width);
            int h = Mathf.Max(1, Screen.height);
            float longSide  = Mathf.Max(w, h);
            float shortSide = Mathf.Min(w, h);
            return (longSide / shortSide) < TabletAspectThreshold;
        }
    }
}
