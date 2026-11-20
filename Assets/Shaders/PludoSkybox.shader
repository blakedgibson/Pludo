// PludoSkybox.shader — procedural skybox built from runtime descriptor values.
// One material instance per game; GameRenderClient.ApplySceneConfig sets every
// property from the SkyboxDescriptor and assigns it to RenderSettings.skybox.
//
// Layout (top → bottom):
//   _TopColor at zenith → _HorizonColor at horizon → _GroundColor below horizon.
//   _BottomColor mirrors topColor on the far side of zenith if used.
// Sun disc lives at the world-space direction implied by _SunDirection (xyz
// pre-computed Euler→vector on the C# side so this shader stays branch-free).
// Stars and clouds are cheap procedural noise gated by their density inputs.

Shader "Pludo/Skybox"
{
    Properties
    {
        _TopColor       ("Top Color",        Color) = (0.20, 0.55, 0.95, 1)
        _HorizonColor   ("Horizon Color",    Color) = (0.85, 0.93, 1.00, 1)
        _BottomColor    ("Bottom Color",     Color) = (0.85, 0.93, 1.00, 1)
        _GroundColor    ("Ground Color",     Color) = (0.30, 0.30, 0.32, 1)
        _SunColor       ("Sun Color",        Color) = (1.00, 0.95, 0.85, 1)
        // Unit direction *toward* the sun in world space.
        _SunDirection   ("Sun Direction",    Vector) = (0.40, 0.70, 0.59, 0)
        _SunSize        ("Sun Size",         Range(0.001, 0.2)) = 0.04
        _SunIntensity   ("Sun Intensity",    Range(0, 4))       = 1.4
        _Exposure       ("Exposure",         Range(0, 2))       = 1.0
        _AtmosphereThickness ("Atmosphere",  Range(0, 3))       = 1.0
        _StarDensity    ("Star Density",     Range(0, 1))       = 0.0
        _CloudDensity   ("Cloud Density",    Range(0, 1))       = 0.0
        _CloudTint      ("Cloud Tint",       Color) = (1, 1, 1, 1)
    }

    SubShader
    {
        // Skybox queue; render before opaques, no depth output.
        Tags { "RenderType"="Background" "Queue"="Background" "PreviewType"="Skybox" "RenderPipeline"="UniversalPipeline" }
        Cull Off ZWrite Off

        Pass
        {
            HLSLPROGRAM
            #pragma vertex   vert
            #pragma fragment frag
            #pragma target 3.5

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _TopColor;
                float4 _HorizonColor;
                float4 _BottomColor;
                float4 _GroundColor;
                float4 _SunColor;
                float4 _SunDirection;
                float  _SunSize;
                float  _SunIntensity;
                float  _Exposure;
                float  _AtmosphereThickness;
                float  _StarDensity;
                float  _CloudDensity;
                float4 _CloudTint;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 viewDirWS  : TEXCOORD0;
            };

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                // Skyboxes sample world direction from the cube vertex position.
                OUT.viewDirWS  = IN.positionOS.xyz;
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                return OUT;
            }

            // Cheap hash for star field — feeds a thresholded white-noise sparkle
            // gated by _StarDensity. 0 = none, 1 = dense field.
            float hash21(float2 p)
            {
                p = frac(p * float2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return frac(p.x * p.y);
            }

            // 2D fbm for clouds — 3 octaves is plenty for a horizon band.
            float fbm(float2 p)
            {
                float v = 0;
                float a = 0.5;
                for (int i = 0; i < 3; i++)
                {
                    v += a * (hash21(floor(p)) * 2.0 - 1.0);
                    p *= 2.0;
                    a *= 0.5;
                }
                return saturate(v * 0.5 + 0.5);
            }

            float4 frag(Varyings IN) : SV_Target
            {
                float3 viewDir = normalize(IN.viewDirWS);

                // Sky gradient: smoothstep over view.y so the horizon band is
                // soft. Below horizon we blend into _GroundColor — important
                // for tall play areas where the camera looks downward.
                float aboveT  = saturate(viewDir.y);                          // 0..1 above horizon
                float belowT  = saturate(-viewDir.y);                         // 0..1 below horizon
                // Horizon band falloff sharpens with thicker atmosphere.
                float band    = pow(1.0 - aboveT, lerp(2.0, 8.0, saturate(_AtmosphereThickness * 0.5)));

                float3 sky    = lerp(_TopColor.rgb,    _HorizonColor.rgb, band);
                float3 ground = lerp(_HorizonColor.rgb, _GroundColor.rgb,  pow(belowT, 1.5));
                float3 col    = lerp(ground, sky, step(0.0, viewDir.y));

                // Sun disc. _SunDirection is pre-normalized on the C# side.
                float3 sunDir = normalize(_SunDirection.xyz);
                float  sunDot = dot(viewDir, sunDir);
                // saturate(...) so the disc doesn't bleed below horizon.
                float  sunMask = smoothstep(1.0 - _SunSize, 1.0 - _SunSize * 0.5, sunDot) * saturate(viewDir.y + 0.05);
                col += _SunColor.rgb * sunMask * _SunIntensity;

                // Cloud band: only above horizon, density-modulated. Uses
                // (azimuth, altitude) coordinates so panning the view rotates
                // around naturally.
                if (_CloudDensity > 0.001)
                {
                    float2 cloudUV = float2(atan2(viewDir.z, viewDir.x) * 1.5915494, viewDir.y * 4.0);
                    float  c       = fbm(cloudUV * 3.0);
                    float  band01  = smoothstep(0.05, 0.45, viewDir.y) * (1.0 - smoothstep(0.45, 0.95, viewDir.y));
                    float  mask    = saturate((c - (1.0 - _CloudDensity)) * 4.0) * band01;
                    col = lerp(col, _CloudTint.rgb, mask * 0.65);
                }

                // Stars: only above horizon, gated by density. Hash-noise spots.
                if (_StarDensity > 0.001 && viewDir.y > 0.0)
                {
                    // Multiplying viewDir by 200 makes the cell grid fine enough
                    // for visible point stars without obvious tiling.
                    float n = hash21(floor(viewDir.xz * 200.0));
                    float threshold = 1.0 - _StarDensity * 0.04;
                    float starMask  = smoothstep(threshold, 1.0, n) * saturate(viewDir.y * 3.0);
                    col += starMask * 1.2;
                }

                col *= _Exposure;
                return float4(col, 1);
            }
            ENDHLSL
        }
    }

    // Built-in fallback for editors without URP loaded.
    Fallback "Skybox/Procedural"
}
