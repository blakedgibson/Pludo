// Two-pass separable Gaussian blur used by BackgroundBlurFeature.
// Pass 0: horizontal  |  Pass 1: vertical
// Blitter sets _BlitTexture; we read _BlurTexelSize from a global vector
// set each frame by the C# pass so pixel size is always correct.

Shader "Pludo/BackgroundBlur"
{
    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        ZWrite Off  ZTest Always  Cull Off

        // ── Pass 0: Horizontal ────────────────────────────────────────────────
        Pass
        {
            Name "BlurH"
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment FragH

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            float4 _BlurTexelSize; // (1/w, 1/h, w, h)
            float  _BlurRadius;

            // 9-tap Gaussian (σ≈1.3)
            static const float W[5] = { 0.2270270270, 0.1945945946, 0.1216216216,
                                         0.0540540541, 0.0162162162 };

            half4 FragH(Varyings input) : SV_Target
            {
                float2 uv  = input.texcoord;
                float2 off = float2(_BlurRadius * _BlurTexelSize.x, 0);
                half4 col  = SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv) * W[0];
                UNITY_UNROLL
                for (int i = 1; i < 5; i++)
                {
                    col += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv + off * i) * W[i];
                    col += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv - off * i) * W[i];
                }
                return col;
            }
            ENDHLSL
        }

        // ── Pass 1: Vertical ──────────────────────────────────────────────────
        Pass
        {
            Name "BlurV"
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment FragV

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            float4 _BlurTexelSize;
            float  _BlurRadius;

            static const float W[5] = { 0.2270270270, 0.1945945946, 0.1216216216,
                                         0.0540540541, 0.0162162162 };

            half4 FragV(Varyings input) : SV_Target
            {
                float2 uv  = input.texcoord;
                float2 off = float2(0, _BlurRadius * _BlurTexelSize.y);
                half4 col  = SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv) * W[0];
                UNITY_UNROLL
                for (int i = 1; i < 5; i++)
                {
                    col += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv + off * i) * W[i];
                    col += SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv - off * i) * W[i];
                }
                return col;
            }
            ENDHLSL
        }
    }
}
