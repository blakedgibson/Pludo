using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

// Auto-generates Assets/Resources/Avatar/PlayerAnimController.controller
// with Idle and Walk states driven by the "IsWalking" bool parameter.
[InitializeOnLoad]
public class CreatePlayerAnimController
{
    static CreatePlayerAnimController() => EditorApplication.delayCall += CreateIfMissing;

    [MenuItem("Pludo/Regenerate Player Anim Controller")]
    public static void CreateIfMissing()
    {
        const string ctrlPath = "Assets/Resources/Avatar/PlayerAnimController.controller";
        const string walkFbx  = "Assets/Resources/Avatar/walking.fbx";
        const string idleFbx  = "Assets/Resources/Avatar/climbing-ladder.fbx"; // fallback idle

        // Always regenerate so changes to this script take effect immediately.
        if (AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>(ctrlPath) != null)
            AssetDatabase.DeleteAsset(ctrlPath);

        var controller = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        var rootSM     = controller.layers[0].stateMachine;

        // Add the IsWalking bool parameter
        controller.AddParameter("IsWalking", AnimatorControllerParameterType.Bool);

        // Resolve animation clips
        var walkClip = LoadFbxClip(walkFbx);
        var idleClip = LoadFbxClip(idleFbx) ?? walkClip; // use walk if no idle

        var idleState = rootSM.AddState("Idle");
        idleState.motion             = idleClip;
        idleState.writeDefaultValues = true;

        var walkState = rootSM.AddState("Walk");
        walkState.motion             = walkClip;
        walkState.writeDefaultValues = true;

        rootSM.defaultState = idleState;

        // Idle → Walk when IsWalking = true
        var toWalk = idleState.AddTransition(walkState);
        toWalk.hasExitTime      = false;
        toWalk.duration         = 0.1f;
        toWalk.hasFixedDuration = true;
        toWalk.AddCondition(AnimatorConditionMode.If, 0f, "IsWalking");

        // Walk → Idle when IsWalking = false
        var toIdle = walkState.AddTransition(idleState);
        toIdle.hasExitTime      = false;
        toIdle.duration         = 0.1f;
        toIdle.hasFixedDuration = true;
        toIdle.AddCondition(AnimatorConditionMode.IfNot, 0f, "IsWalking");

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log("[CreatePlayerAnimController] PlayerAnimController.controller created (Idle↔Walk via IsWalking).");
    }

    private static AnimationClip LoadFbxClip(string fbxPath)
    {
        foreach (var a in AssetDatabase.LoadAllAssetsAtPath(fbxPath))
            if (a is AnimationClip c && !c.name.Contains("__preview__")) return c;
        return null;
    }
}
