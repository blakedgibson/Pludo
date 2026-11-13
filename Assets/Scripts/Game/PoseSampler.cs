using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

// Drop-in replacement for AnimationClip.SampleAnimation that also works in
// player builds.
//
// The avatar clips (idle/walking/running/jumping-*) are imported as Generic
// (Mecanim) clips. AnimationClip.SampleAnimation only samples those inside the
// Unity Editor — on device it logs "Non-Legacy animations cannot be sampled
// outside the Editor without an Animator" every frame and leaves the skeleton
// in its bind (T) pose. That is why the avatar never animated in the iOS app
// even though it did in the Editor.
//
// This drives the same clip through a manually-evaluated PlayableGraph bound
// to an Animator on the pose source, which writes the bone transforms
// synchronously on Evaluate() — the same "set time, pose now" contract the
// callers relied on, so their pose-copy code is unchanged.
public sealed class PoseSampler : MonoBehaviour
{
    private PlayableGraph _graph;
    private AnimationPlayableOutput _output;
    private readonly Dictionary<AnimationClip, AnimationClipPlayable> _playables = new();
    private AnimationClip _current;

    public static void Sample(AnimationClip clip, GameObject poseSource, float time)
    {
        if (clip == null || poseSource == null) return;
        if (!poseSource.TryGetComponent<PoseSampler>(out var sampler))
            sampler = poseSource.AddComponent<PoseSampler>();
        sampler.SampleNow(clip, time);
    }

    private void EnsureGraph()
    {
        if (_graph.IsValid()) return;

        // The clip's curve paths are relative to the FBX root, so the Animator
        // must live on this object (the instantiated idle.fbx root).
        var animator = GetComponent<Animator>();
        if (animator == null) animator = gameObject.AddComponent<Animator>();
        animator.runtimeAnimatorController = null;   // the graph is the only driver
        animator.applyRootMotion = false;
        animator.cullingMode     = AnimatorCullingMode.AlwaysAnimate; // renderers are hidden
        animator.enabled         = true;

        _graph = PlayableGraph.Create("PoseSampler");
        _graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);
        _output = AnimationPlayableOutput.Create(_graph, "pose", animator);
    }

    private void SampleNow(AnimationClip clip, float time)
    {
        EnsureGraph();
        if (!_playables.TryGetValue(clip, out var playable))
        {
            playable = AnimationClipPlayable.Create(_graph, clip);
            playable.SetApplyFootIK(false);
            playable.SetSpeed(0);
            _playables[clip] = playable;
        }
        if (_current != clip)
        {
            _output.SetSourcePlayable(playable);
            _current = clip;
        }
        playable.SetTime(time);
        _graph.Evaluate(0f);
    }

    private void OnDestroy()
    {
        if (_graph.IsValid()) _graph.Destroy();
    }
}
