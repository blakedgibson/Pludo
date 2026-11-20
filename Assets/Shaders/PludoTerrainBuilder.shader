// PludoTerrainBuilder.shader — URP Lit shader for the editor's sculpted
// baseplate terrain (TerrainBuilder). Replaces the old URP/Unlit material so
// the ground:
//   * receives shadows cast by props / characters,
//   * casts its own shadow (via the UsePass ShadowCaster below), and
//   * self-shades — sculpted slopes read darker/lighter than flat regions
//     because lighting now responds to the per-vertex normals.
//
// It also tints the base color by the mesh's vertex color, which is how
// TerrainBuilder's Paint tool surfaces its grass band (white = untouched,
// light-green = painted). The shadow coordinate is computed per-pixel from
// world position so URP's cascaded main-light shadow map is sampled correctly
// across this large (100×100 m) sparsely-tessellated mesh.

Shader "Pludo/TerrainBuilder"
{
    Properties
    {
        _BaseColor  ("Base Color", Color)        = (0.42, 0.55, 0.32, 1)
        _Smoothness ("Smoothness", Range(0, 1))  = 0.08
        // Roblox-style gray checkerboard for the blank baseplate. _CheckerStrength
        // defaults to 0 so every existing terrain material is visually unchanged;
        // TerrainBuilder.SetBaseplateStyle(true) sets it to 1 for new blank games.
        _CheckerColorA ("Checker Color A", Color) = (0.40, 0.41, 0.43, 1)
        _CheckerColorB ("Checker Color B", Color) = (0.56, 0.57, 0.60, 1)
        _CheckerSize   ("Checker Size (m)", Float) = 4
        _CheckerStrength ("Checker Strength", Range(0, 1)) = 0
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

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseColor;
                float  _Smoothness;
                float4 _CheckerColorA;
                float4 _CheckerColorB;
                float  _CheckerSize;
                float  _CheckerStrength;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 color      : COLOR;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 positionWS : TEXCOORD0;
                float3 normalWS   : TEXCOORD1;
                float4 color      : TEXCOORD2;
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                VertexPositionInputs vp = GetVertexPositionInputs(IN.positionOS.xyz);
                OUT.positionWS = vp.positionWS;
                OUT.positionCS = vp.positionCS;
                OUT.normalWS   = TransformObjectToWorldNormal(IN.normalOS);
                OUT.color      = IN.color;
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                // World-space gray checkerboard (Roblox baseplate). Each cell is
                // _CheckerSize metres; alternating cells use color A / B. Blended
                // in by _CheckerStrength so it's a no-op when 0.
                float size = max(_CheckerSize, 0.001);
                float2 cell = floor(IN.positionWS.xz / size);
                float  checker = frac((cell.x + cell.y) * 0.5) * 2.0; // 0 or 1
                float3 checkerCol = lerp(_CheckerColorA.rgb, _CheckerColorB.rgb, checker);
                float3 baseRGB = lerp(_BaseColor.rgb, checkerCol, saturate(_CheckerStrength));

                float3 albedo = baseRGB * IN.color.rgb;

                SurfaceData surf  = (SurfaceData)0;
                surf.albedo       = albedo;
                surf.metallic     = 0.0;
                surf.smoothness    = _Smoothness;
                surf.normalTS     = float3(0, 0, 1);
                surf.occlusion    = 1.0;
                surf.alpha        = 1.0;

                InputData input   = (InputData)0;
                input.positionWS  = IN.positionWS;
                input.normalWS    = normalize(IN.normalWS);
                input.viewDirectionWS = normalize(GetWorldSpaceViewDir(IN.positionWS));
                // Per-pixel shadow coord so the cascaded main-light shadow map is
                // sampled correctly across the large terrain triangles.
                input.shadowCoord = TransformWorldToShadowCoord(IN.positionWS);
                input.fogCoord    = 0;

                return UniversalFragmentPBR(input, surf);
            }
            ENDHLSL
        }

        // Standard URP shadow + depth passes so the terrain casts shadows and
        // participates in depth-based features like any other Lit mesh.
        UsePass "Universal Render Pipeline/Lit/ShadowCaster"
        UsePass "Universal Render Pipeline/Lit/DepthOnly"
    }

    Fallback "Universal Render Pipeline/Lit"
}
