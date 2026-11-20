#if UNITY_IOS
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.Callbacks;
using UnityEditor.iOS.Xcode;
using UnityEngine;

// Exports Pludo as "Unity as a Library" for the React Native shell (native-shell/).
//
//   Pludo ▸ Native Shell ▸ Export iOS (Simulator)  → native-shell/unity/export-ios-simulator
//   Pludo ▸ Native Shell ▸ Export iOS (Device)     → native-shell/unity/export-ios-device
//
// Each export is compiled with the PLUDO_NATIVE_SHELL define (NativeShellBridge.cs
// and the hosted mode in App.tsx). Player Settings are restored afterwards, so
// normal iOS builds are unaffected. native-shell/scripts/build-unity-framework.sh
// turns an export into unity/builds/ios/UnityFramework.xcframework.
public static class NativeShellBuild
{
    public const string Define = "PLUDO_NATIVE_SHELL";
    private static bool _exporting;

    private static string ShellUnityDir =>
        Path.GetFullPath(Path.Combine(Application.dataPath, "..", "native-shell", "unity"));

    [MenuItem("Pludo/Native Shell/Export iOS (Simulator)")]
    public static void ExportSimulator() => Export(iOSSdkVersion.SimulatorSDK, "export-ios-simulator");

    [MenuItem("Pludo/Native Shell/Export iOS (Device)")]
    public static void ExportDevice() => Export(iOSSdkVersion.DeviceSDK, "export-ios-device");

    public static BuildReport Export(iOSSdkVersion sdk, string folder)
    {
        var previousSdk  = PlayerSettings.iOS.sdkVersion;
        var previousArch = PlayerSettings.iOS.simulatorSdkArchitecture;
        var output = Path.Combine(ShellUnityDir, folder);
        Directory.CreateDirectory(output);
        try
        {
            _exporting = true;
            PlayerSettings.iOS.sdkVersion = sdk;
            // Unity's simulator runtime defaults to x86_64; Apple Silicon simulators need arm64.
            if (sdk == iOSSdkVersion.SimulatorSDK)
                PlayerSettings.iOS.simulatorSdkArchitecture = AppleMobileArchitectureSimulator.ARM64;
            var options = new BuildPlayerOptions
            {
                scenes = Array.ConvertAll(Array.FindAll(EditorBuildSettings.scenes, s => s.enabled), s => s.path),
                locationPathName = output,
                target = BuildTarget.iOS,
                targetGroup = BuildTargetGroup.iOS,
                extraScriptingDefines = new[] { Define },
                options = BuildOptions.None,
            };
            var report = BuildPipeline.BuildPlayer(options);
            Debug.Log($"[NativeShellBuild] {sdk} export → {output}: {report.summary.result} " +
                      $"({report.summary.totalErrors} errors, {report.summary.totalTime})");
            return report;
        }
        finally
        {
            PlayerSettings.iOS.sdkVersion = previousSdk;
            PlayerSettings.iOS.simulatorSdkArchitecture = previousArch;
            _exporting = false;
        }
    }

    // Unity-as-a-Library needs two changes to the exported Xcode project:
    //  1. the Data folder must ship inside UnityFramework (not the stub app), and
    //  2. NativeCallProxy.h must be a public header so the host can register.
    [PostProcessBuild(200)]
    public static void OnPostProcessBuild(BuildTarget target, string path)
    {
        if (target != BuildTarget.iOS || !_exporting) return;

        var projPath = PBXProject.GetPBXProjectPath(path);
        var proj = new PBXProject();
        proj.ReadFromFile(projPath);

        var frameworkTarget = proj.GetUnityFrameworkTargetGuid();
        var mainTarget      = proj.GetUnityMainTargetGuid();

        var dataGuid = proj.FindFileGuidByProjectPath("Data");
        if (dataGuid != null)
        {
            proj.RemoveFileFromBuild(mainTarget, dataGuid);
            proj.AddFileToBuild(frameworkTarget, dataGuid);
        }
        else Debug.LogWarning("[NativeShellBuild] Data folder not found in the Xcode project.");

        var headerGuid = proj.FindFileGuidByProjectPath("Libraries/Plugins/iOS/NativeCallProxy.h");
        if (headerGuid != null) proj.AddPublicHeaderToBuild(frameworkTarget, headerGuid);
        else Debug.LogWarning("[NativeShellBuild] NativeCallProxy.h not found in the Xcode project.");

        proj.WriteToFile(projPath);
    }
}
#endif
