using System;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.RenderGraphModule;
using UnityEngine.Rendering.Universal;

// Captures the camera color before UI renders, applies a separable Gaussian
// blur, and exposes the result as _GlassBlurTexture for GlassPanel.shader.
// Add this feature to Mobile_Renderer and PC_Renderer assets in the Inspector.
public class BackgroundBlurFeature : ScriptableRendererFeature
{
    [Serializable]
    public class Settings
    {
        public RenderPassEvent renderPassEvent = RenderPassEvent.BeforeRenderingTransparents;
        [Range(1, 4)] public int downscale = 2;
        [Range(1, 6)] public int iterations = 3;
        [Range(0.5f, 6f)] public float blurRadius = 2f;
    }

    public Settings settings = new();
    BackgroundBlurPass _pass;
    Material _blurMat;

    public override void Create()
    {
        var shader = Shader.Find("Pludo/BackgroundBlur");
        if (shader == null)
        {
            Debug.LogWarning("BackgroundBlurFeature: shader 'Pludo/BackgroundBlur' not found.");
            return;
        }
        _blurMat = CoreUtils.CreateEngineMaterial(shader);
        _pass = new BackgroundBlurPass(settings, _blurMat);
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        if (_pass == null) return;
        if (renderingData.cameraData.cameraType != CameraType.Game) return;
        renderer.EnqueuePass(_pass);
    }

    protected override void Dispose(bool disposing)
    {
        CoreUtils.Destroy(_blurMat);
    }

    // -------------------------------------------------------------------------

    class BackgroundBlurPass : ScriptableRenderPass
    {
        readonly Settings _s;
        readonly Material _mat;

        static readonly int BlurTexelSizeId = Shader.PropertyToID("_BlurTexelSize");
        static readonly int BlurRadiusId    = Shader.PropertyToID("_BlurRadius");
        static readonly int GlassBlurTexId  = Shader.PropertyToID("_GlassBlurTexture");

        public BackgroundBlurPass(Settings s, Material mat)
        {
            _s = s;
            _mat = mat;
            renderPassEvent = s.renderPassEvent;
        }

        class DownscaleData
        {
            public TextureHandle source;
            public Vector4 texelSize;
        }

        class BlitData
        {
            public TextureHandle source;
            public Material mat;
            public int pass;
        }

        class GlobalTexData
        {
            public TextureHandle tex;
        }

        public override void RecordRenderGraph(RenderGraph renderGraph, ContextContainer frameData)
        {
            if (_mat == null) return;

            var cameraData   = frameData.Get<UniversalCameraData>();
            var resourceData = frameData.Get<UniversalResourceData>();

            var camDesc = cameraData.cameraTargetDescriptor;
            int w = Mathf.Max(1, camDesc.width  / _s.downscale);
            int h = Mathf.Max(1, camDesc.height / _s.downscale);
            var desc = new RenderTextureDescriptor(w, h, RenderTextureFormat.Default, 0) { msaaSamples = 1 };

            TextureHandle rt0 = UniversalRenderer.CreateRenderGraphTexture(renderGraph, desc, "_BlurTemp0", false, FilterMode.Bilinear);
            TextureHandle rt1 = UniversalRenderer.CreateRenderGraphTexture(renderGraph, desc, "_BlurTemp1", false, FilterMode.Bilinear);

            // Set material property at record time (CPU-side, persists into all blur pass draws)
            _mat.SetFloat(BlurRadiusId, _s.blurRadius);

            var texelSize = new Vector4(1f / w, 1f / h, w, h);

            // Pass: downscale camera color → rt0, and set global texel size
            using (var builder = renderGraph.AddRasterRenderPass<DownscaleData>("BG Blur Downscale", out var data))
            {
                data.source    = resourceData.activeColorTexture;
                data.texelSize = texelSize;

                builder.UseTexture(resourceData.activeColorTexture, AccessFlags.Read);
                builder.SetRenderAttachment(rt0, 0);
                builder.AllowGlobalStateModification(true);

                builder.SetRenderFunc(static (DownscaleData d, RasterGraphContext ctx) =>
                {
                    ctx.cmd.SetGlobalVector(BlurTexelSizeId, d.texelSize);
                    Blitter.BlitTexture(ctx.cmd, d.source, new Vector4(1, 1, 0, 0), 0, false);
                });
            }

            // Passes: iterative separable Gaussian blur
            for (int i = 0; i < _s.iterations; i++)
            {
                AddBlitPass(renderGraph, rt0, rt1, _mat, 0, $"BG Blur H{i}");
                AddBlitPass(renderGraph, rt1, rt0, _mat, 1, $"BG Blur V{i}");
            }

            // Pass: expose rt0 as global texture for GlassPanel.shader
            using (var builder = renderGraph.AddUnsafePass<GlobalTexData>("BG Blur SetGlobal", out var data))
            {
                data.tex = rt0;

                builder.UseTexture(rt0, AccessFlags.Read);
                builder.AllowGlobalStateModification(true);

                builder.SetRenderFunc(static (GlobalTexData d, UnsafeGraphContext ctx) =>
                {
                    ctx.cmd.SetGlobalTexture(GlassBlurTexId, d.tex);
                });
            }
        }

        static void AddBlitPass(RenderGraph renderGraph, TextureHandle source, TextureHandle dest, Material mat, int pass, string name)
        {
            using (var builder = renderGraph.AddRasterRenderPass<BlitData>(name, out var data))
            {
                data.source = source;
                data.mat    = mat;
                data.pass   = pass;

                builder.UseTexture(source, AccessFlags.Read);
                builder.SetRenderAttachment(dest, 0);

                builder.SetRenderFunc(static (BlitData d, RasterGraphContext ctx) =>
                {
                    Blitter.BlitTexture(ctx.cmd, d.source, new Vector4(1, 1, 0, 0), d.mat, d.pass);
                });
            }
        }
    }
}
