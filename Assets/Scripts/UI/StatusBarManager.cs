using System.Runtime.InteropServices;
using UnityEngine;

// Controls the iOS native status bar visibility.
// Call StatusBarManager.Show() in the main UI and Hide() when entering a game.
public static class StatusBarManager
{
#if UNITY_IOS && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void PludoStatusBar_Show();
    [DllImport("__Internal")] private static extern void PludoStatusBar_Hide();
#endif

    public static void Show()
    {
#if UNITY_IOS && !UNITY_EDITOR
        PludoStatusBar_Show();
#endif
        Debug.Log("[StatusBar] Show");
    }

    public static void Hide()
    {
#if UNITY_IOS && !UNITY_EDITOR
        PludoStatusBar_Hide();
#endif
        Debug.Log("[StatusBar] Hide");
    }
}
