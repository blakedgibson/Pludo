// PludoTerrain.shader — URP triplanar PBR shader with up to 3 slope-blended
// layers. One material per Structure entity; GameRenderClient builds it from
// the server-side EntityState.terrainLayers (or .structureMaterial in 1-layer
// mode) and assigns the Polyhaven texture URLs once they download.
//
// Triplanar projection: sample each layer's albedo/normal/roughness from the
// XY, YZ, ZX planes in world space and blend by abs(worldNormal) weights.
// Eliminates UV stretching on a procedural plane (or any non-UV'd mesh).
//
// Slope blending: per-layer smoothstep(slopeMin, slopeMax, 1 - dot(N, up)).
// Layer 0 dominates flats, layer 2 dominates verticals. Weights are normalized
// so the layers always sum to 1.
//
// _LayerCount = 1 collapses to a single-layer PBR shader for structureMaterial.

Shader "Pludo/Terrain"
{
    Properties
    {
        // Layer 0
        _Layer0_Albedo    ("L0 Albedo",    2D)              = "white" {}
        _Layer0_Normal    ("L0 Normal",    2D)              = "bump"  {}
        _Layer0_Roughness ("L0 Roughness", 2D)              = "gray"  {}
        _Layer0_Tiling    ("L0 Tiling",    Range(0.1, 64))  = 8.0
        _Layer0_SlopeMin  ("L0 Slope Min", Range(0, 1))     = 0.0
        _Layer0_SlopeMax  ("L0 Slope Max", Range(0, 1))     = 0.35

        // Layer 1
        _Layer1_Albedo    ("L1 Albedo",    2D)              = "white" {}
        _Layer1_Normal    ("L1 Normal",    2D)              = "bump"  {}
        _Layer1_Roughness ("L1 Roughness", 2D)              = "gray"  {}
        _Layer1_Tiling    ("L1 Tiling",    Range(0.1, 64))  = 6.0
        _Layer1_SlopeMin  ("L1 Slope Min", Range(0, 1))     = 0.25
        _Layer1_SlopeMax  ("L1 Slope Max", Range(0, 1))     = 0.65

        // Layer 2
        _Layer2_Albedo    ("L2 Albedo",    2D)              = "white" {}
        _Layer2_Normal    ("L2 Normal",    2D)              = "bump"  {}
        _Layer2_Roughness ("L2 Roughness", 2D)              = "gray"  {}
        _Layer2_Tiling    ("L2 Tiling",    Range(0.1, 64))  = 5.0
        _Layer2_SlopeMin  ("L2 Slope Min", Range(0, 1))     = 0.55
        _Layer2_SlopeMax  ("L2 Slope Max", Range(0, 1))     = 1.0

        _LayerCount       ("Layer Count",  Range(1, 3))     = 3
        _RoughnessScale   ("Roughness Scale", Range(0, 2))  = 1.0
        _ColorVariation   ("Color Variation",  Range(0, 0.5)) = 0.10
        _ColorVarFreq     ("Color Variation Freq", Range(0.01, 5)) = 0.4
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" "RenderPipeline"="UniversalPipeline" }
        LOD 200

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma target 3.5
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile_fragment _ _ADDITIONAL_LIGHT_SHADOWS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"

            TEXTURE2D(_Layer0_Albedo);    SAMPLER(sampler_Layer0_Albedo);
            TEXTURE2D(_Layer0_Normal);    SAMPLER(sampler_Layer0_Normal);
            TEXTURE2D(_Layer0_Roughness); SAMPLER(sampler_Layer0_Roughness);
            TEXTURE2D(_Layer1_Albedo);    SAMPLER(sampler_Layer1_Albedo);
            TEXTURE2D(_Layer1_Normal);    SAMPLER(sampler_Layer1_Normal);
            TEXTURE2D(_Layer1_Roughness); SAMPLER(sampler_Layer1_Roughness);
            TEXTURE2D(_Layer2_Albedo);    SAMPLER(sampler_Layer2_Albedo);
            TEXTURE2D(_Layer2_Normal);    SAMPLER(sampler_Layer2_Normal);
            TEXTURE2D(_Layer2_Roughness); SAMPLER(sampler_Layer2_Roughness);

            CBUFFER_START(UnityPerMaterial)
                float _Layer0_Tiling; float _Layer0_SlopeMin; float _Layer0_SlopeMax;
                float _Layer1_Tiling; float _Layer1_SlopeMin; float _Layer1_SlopeMax;
                float _Layer2_Tiling; float _Layer2_SlopeMin; float _Layer2_SlopeMax;
                float _LayerCount;
                float _RoughnessScale;
                float _ColorVariation;
                float _ColorVarFreq;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float3 normalWS   : TEXCOORD1;
            };

            // Sample one layer with triplanar projection. Returns (albedo.rgb, roughness)
            // and writes a triplanar-blended object-space normal into outN.
            float4 sampleLayer(
                TEXTURE2D_PARAM(albedoTex, albedoSmp),
                TEXTURE2D_PARAM(normalTex, normalSmp),
                TEXTURE2D_PARAM(roughTex,  roughSmp),
                float3 posWS, float3 weights, float tiling, out float3 outN)
            {
                float2 uvXY = posWS.xy * tiling * 0.1;
                float2 uvYZ = posWS.yz * tiling * 0.1;
                float2 uvZX = posWS.zx * tiling * 0.1;

                float3 aXY = SAMPLE_TEXTURE2D(albedoTex, albedoSmp, uvYZ).rgb;
                float3 aYZ = SAMPLE_TEXTURE2D(albedoTex, albedoSmp, uvZX).rgb;
                float3 aZX = SAMPLE_TEXTURE2D(albedoTex, albedoSmp, uvXY).rgb;
                float3 albedo = aXY * weights.x + aYZ * weights.y + aZX * weights.z;

                float rXY = SAMPLE_TEXTURE2D(roughTex,  roughSmp,  uvYZ).r;
                float rYZ = SAMPLE_TEXTURE2D(roughTex,  roughSmp,  uvZX).r;
                float rZX = SAMPLE_TEXTURE2D(roughTex,  roughSmp,  uvXY).r;
                float roughness = rXY * weights.x + rYZ * weights.y + rZX * weights.z;

                // Cheap triplanar normal: decode each axis sample and blend by weight.
                float3 nXY = UnpackNormal(SAMPLE_TEXTURE2D(normalTex, normalSmp, uvYZ));
                float3 nYZ = UnpackNormal(SAMPLE_TEXTURE2D(normalTex, normalSmp, uvZX));
                float3 nZX = UnpackNormal(SAMPLE_TEXTURE2D(normalTex, normalSmp, uvXY));
                outN = normalize(nXY * weights.x + nYZ * weights.y + nZX * weights.z);

                return float4(albedo, roughness);
            }

            float hash21(float2 p)
            {
                p = frac(p * float2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return frac(p.x * p.y);
            }

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs vp = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionWS = vp.positionWS;
                OUT.positionCS = vp.positionCS;
                OUT.normalWS   = TransformObjectToWorldNormal(IN.normalOS);
                return OUT;
            }

            float4 frag(Varyings IN) : SV_Target
            {
                float3 worldNormal = normalize(IN.normalWS);

                // Triplanar weights from the abs world normal. Power 4 makes
                // each axis dominate cleanly without a wide blend strip.
                float3 weights = pow(abs(worldNormal), 4.0);
                weights /= max(weights.x + weights.y + weights.z, 1e-4);

                // Slope factor: 0 at flat ground (normal=up), 1 at vertical cliff.
                float slope = 1.0 - saturate(worldNormal.y);

                // Per-layer weight via smoothstep across [slopeMin, slopeMax].
                // Outside the band, weight is 0. Inside, smoothstep gives soft transitions.
                float w0 = smoothstep(_Layer0_SlopeMin, _Layer0_SlopeMax, slope);
                w0 = 1.0 - w0;                                                  // layer 0 owns flats
                float w1 = smoothstep(_Layer1_SlopeMin, _Layer1_SlopeMax, slope)
                         * (1.0 - smoothstep(_Layer1_SlopeMax + 0.001, _Layer1_SlopeMax + 0.15, slope));
                float w2 = smoothstep(_Layer2_SlopeMin, _Layer2_SlopeMax, slope);

                // Gate higher-index layers on _LayerCount so single-layer mode
                // (structureMaterial) collapses to layer 0 only.
                w1 *= step(2.0, _LayerCount + 0.01);
                w2 *= step(3.0, _LayerCount + 0.01);

                // Normalize so the three layers sum to 1.
                float wsum = max(w0 + w1 + w2, 1e-4);
                w0 /= wsum; w1 /= wsum; w2 /= wsum;

                float3 n0, n1, n2;
                float4 l0 = sampleLayer(_Layer0_Albedo, sampler_Layer0_Albedo,
                                        _Layer0_Normal, sampler_Layer0_Normal,
                                        _Layer0_Roughness, sampler_Layer0_Roughness,
                                        IN.positionWS, weights, _Layer0_Tiling, n0);
                float4 l1 = sampleLayer(_Layer1_Albedo, sampler_Layer1_Albedo,
                                        _Layer1_Normal, sampler_Layer1_Normal,
                                        _Layer1_Roughness, sampler_Layer1_Roughness,
                                        IN.positionWS, weights, _Layer1_Tiling, n1);
                float4 l2 = sampleLayer(_Layer2_Albedo, sampler_Layer2_Albedo,
                                        _Layer2_Normal, sampler_Layer2_Normal,
                                        _Layer2_Roughness, sampler_Layer2_Roughness,
                                        IN.positionWS, weights, _Layer2_Tiling, n2);

                float3 albedo    = l0.rgb * w0 + l1.rgb * w1 + l2.rgb * w2;
                float  roughness = saturate((l0.a * w0 + l1.a * w1 + l2.a * w2) * _RoughnessScale);

                // Hash-noise tint break so flat areas don't read as a single repeated tile.
                float variation = (hash21(floor(IN.positionWS.xz * _ColorVarFreq)) - 0.5) * 2.0 * _ColorVariation;
                albedo *= (1.0 + variation);

                // Approximate URP Lit shading using SurfaceData/BRDFData. We
                // build a minimal SurfaceData and feed it through
                // UniversalFragmentPBR so shadows + main light + global
                // illumination match the rest of the scene.
                SurfaceData surf  = (SurfaceData)0;
                surf.albedo       = albedo;
                surf.metallic     = 0.0;
                surf.smoothness   = 1.0 - roughness;
                surf.normalTS     = float3(0, 0, 1);
                surf.occlusion    = 1.0;
                surf.alpha        = 1.0;

                InputData input   = (InputData)0;
                input.positionWS  = IN.positionWS;
                input.normalWS    = worldNormal;
                input.viewDirectionWS = normalize(GetWorldSpaceViewDir(IN.positionWS));
                // Compute the shadow coord per-pixel from world position so the
                // main light's cascaded shadow map is sampled correctly. Doing
                // this per-vertex and interpolating breaks across cascade splits
                // and on the terrain's large, sparsely-tessellated triangles —
                // which is why other models' shadows never reached the ground.
                input.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);
                input.fogCoord    = 0;

                half4 final = UniversalFragmentPBR(input, surf);
                return final;
            }
            ENDHLSL
        }

        // Standard URP ShadowCaster so the terrain throws shadows like any
        // other Lit mesh. We don't need a custom pass — the built-in one
        // ships with URP and reads our positionOS just fine.
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
    }

    Fallback "Universal Render Pipeline/Lit"
}
