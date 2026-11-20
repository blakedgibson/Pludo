// Frosted-glass UI panel — samples _GlassBlurTexture (written each frame by
// BackgroundBlurFeature) using screen-space UVs, then overlays a tint.
// Apply as a material on any Unity UI Image whose RectTransform covers the
// area you want to look like glass.

Shader "Pludo/GlassPanel"
{
    Properties
    {
        // Alpha drives overall panel opacity; RGB tints the blurred background.
        _TintColor    ("Tint",         Color)          = (0.12, 0.12, 0.16, 0.72)
        // How strongly the tint overrides the blurred background (0 = pure blur).
        _TintStrength ("Tint Strength", Range(0, 1))   = 0.18
        // Slight brightening to simulate light refraction through glass.
        _Brightness   ("Brightness",    Range(0.5, 2)) = 1.08
        // Edge highlight: thin bright line at the top/left edge of the panel.
        _EdgeColor    ("Edge Color",    Color)          = (1, 1, 1, 0.25)
        _EdgeWidth    ("Edge Width",    Range(0, 0.02)) = 0.004

        // Stencil support for Unity UI masks (do not edit manually).
        _StencilComp  ("Stencil Comparison", Float) = 8
        _Stencil      ("Stencil ID",         Float) = 0
        _StencilOp    ("Stencil Operation",  Float) = 0
        _StencilWM    ("Stencil Write Mask", Float) = 255
        _StencilRM    ("Stencil Read Mask",  Float) = 255
        _ColorMask    ("Color Mask",         Float) = 15
    }

    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "RenderPipeline"="UniversalPipeline" }

        Stencil
        {
            Ref   [_Stencil]
            Comp  [_StencilComp]
            Pass  [_StencilOp]
            ReadMask  [_StencilRM]
            WriteMask [_StencilWM]
        }

        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off
        ColorMask [_ColorMask]

        Pass
        {
            Name "GlassPanel"
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            TEXTURE2D(_GlassBlurTexture);
            SAMPLER(sampler_GlassBlurTexture);

            CBUFFER_START(UnityPerMaterial)
                float4 _TintColor;
                float  _TintStrength;
                float  _Brightness;
                float4 _EdgeColor;
                float  _EdgeWidth;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv         : TEXCOORD0;
                float4 color      : COLOR;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float4 screenPos  : TEXCOORD0;
                float2 uv         : TEXCOORD1;
                float4 color      : COLOR;
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.screenPos  = ComputeScreenPos(OUT.positionCS);
                OUT.uv         = IN.uv;
                OUT.color      = IN.color;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // Sample the blurred background at the panel's screen position
                float2 screenUV = IN.screenPos.xy / IN.screenPos.w;
                half4 blurred   = SAMPLE_TEXTURE2D(_GlassBlurTexture, sampler_GlassBlurTexture, screenUV);

                // Brighten (glass refracts light)
                blurred.rgb *= _Brightness;

                // Tint overlay
                blurred.rgb = lerp(blurred.rgb, _TintColor.rgb, _TintStrength);

                // Edge highlight: top and left edges glow slightly
                float edgeH = step(IN.uv.y, _EdgeWidth);
                float edgeV = step(1.0 - IN.uv.x, _EdgeWidth);
                float edge  = saturate(edgeH + edgeV);
                blurred.rgb = lerp(blurred.rgb, _EdgeColor.rgb, edge * _EdgeColor.a);

                // Vertex color alpha * tint alpha = final transparency
                return half4(blurred.rgb, IN.color.a * _TintColor.a);
            }
            ENDHLSL
        }
    }
}
