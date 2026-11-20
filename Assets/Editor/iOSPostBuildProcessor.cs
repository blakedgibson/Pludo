#if UNITY_IOS
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;
using System.IO;

// Post-build step: configure the generated Xcode project for Pludo iOS.
public static class iOSPostBuildProcessor
{
    [PostProcessBuild(100)]
    public static void OnPostProcessBuild(BuildTarget target, string buildPath)
    {
        if (target != BuildTarget.iOS) return;

        string plistPath = Path.Combine(buildPath, "Info.plist");
        var plist = new PlistDocument();
        plist.ReadFromFile(plistPath);

        var root = plist.root;

        // Allow UIApplication.setStatusBarHidden to work alongside the
        // UIViewController category in PludoStatusBar.mm.
        root.SetBoolean("UIViewControllerBasedStatusBarAppearance", true);

        // Show the status bar on launch (hidden=false).
        root.SetBoolean("UIStatusBarHidden", false);

        plist.WriteToFile(plistPath);
    }
}
#endif
