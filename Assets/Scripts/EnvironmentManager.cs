using System.Collections.Generic;
using UnityEngine;
using Newtonsoft.Json.Linq;

// Manages HDRI skyboxes, ground textures, and directional lighting for Pludo games.
// All public methods are main-thread-safe and should be called on the main thread.
public static class EnvironmentManager
{
    private static readonly Dictionary<string, string> SkyboxPaths = new()
    {
        ["midday"]      = "Environment/Skyboxes/sky_midday",
        ["golden_hour"] = "Environment/Skyboxes/sky_golden_hour",
        ["overcast"]    = "Environment/Skyboxes/sky_overcast",
        ["night"]       = "Environment/Skyboxes/sky_night",
        ["stormy"]      = "Environment/Skyboxes/sky_stormy",
        ["clear_blue"]  = "Environment/Skyboxes/sky_clear_blue",
        ["warm_day"]    = "Environment/Skyboxes/sky_warm_day",
    };

    // Procedural descriptors for the named sky presets — same Pludo/Skybox shader
    // as SetBaseplateEnvironment so all presets feel visually consistent.
    private static JArray C3A(float r, float g, float b) => new JArray { r, g, b };
    private static readonly Dictionary<string, JObject> ProceduralPresets = new()
    {
        ["midday"] = new JObject
        {
            ["topColor"]          = C3A(0.25f, 0.52f, 0.95f),
            ["horizonColor"]      = C3A(0.72f, 0.88f, 1.00f),
            ["bottomColor"]       = C3A(0.55f, 0.78f, 1.00f),
            ["groundColor"]       = C3A(0.32f, 0.28f, 0.22f),
            ["sunColor"]          = C3A(1.00f, 0.97f, 0.88f),
            ["ambientColor"]      = C3A(0.65f, 0.72f, 0.80f),
            ["sunDirection"]      = C3A(55f,  40f,  0f),
            ["sunSize"]           = 0.035f,
            ["sunIntensity"]      = 1.4f,
            ["exposure"]          = 1.2f,
            ["atmosphereThickness"] = 1.0f,
            ["fogDensity"]        = 0f,
            ["ambientIntensity"]  = 0.9f,
        },
        ["golden_hour"] = new JObject
        {
            ["topColor"]          = C3A(0.18f, 0.28f, 0.62f),
            ["horizonColor"]      = C3A(1.00f, 0.48f, 0.12f),
            ["bottomColor"]       = C3A(0.95f, 0.35f, 0.10f),
            ["groundColor"]       = C3A(0.28f, 0.15f, 0.08f),
            ["sunColor"]          = C3A(1.00f, 0.55f, 0.18f),
            ["ambientColor"]      = C3A(0.90f, 0.62f, 0.38f),
            ["sunDirection"]      = C3A(12f,  50f,  0f),
            ["sunSize"]           = 0.06f,
            ["sunIntensity"]      = 1.2f,
            ["exposure"]          = 1.1f,
            ["atmosphereThickness"] = 1.3f,
            ["fogDensity"]        = 0.005f,
            ["ambientIntensity"]  = 0.55f,
        },
        ["night"] = new JObject
        {
            ["topColor"]          = C3A(0.02f, 0.03f, 0.12f),
            ["horizonColor"]      = C3A(0.05f, 0.07f, 0.20f),
            ["bottomColor"]       = C3A(0.03f, 0.04f, 0.15f),
            ["groundColor"]       = C3A(0.02f, 0.02f, 0.06f),
            ["sunColor"]          = C3A(0.60f, 0.65f, 0.85f),
            ["ambientColor"]      = C3A(0.08f, 0.10f, 0.20f),
            ["sunDirection"]      = C3A(30f, 180f,  0f),
            ["sunSize"]           = 0.025f,
            ["sunIntensity"]      = 0.25f,
            ["exposure"]          = 0.4f,
            ["atmosphereThickness"] = 0.5f,
            ["fogDensity"]        = 0f,
            ["starDensity"]       = 0.85f,
            ["ambientIntensity"]  = 0.12f,
        },
        ["overcast"] = new JObject
        {
            ["topColor"]          = C3A(0.55f, 0.60f, 0.65f),
            ["horizonColor"]      = C3A(0.68f, 0.72f, 0.76f),
            ["bottomColor"]       = C3A(0.60f, 0.65f, 0.68f),
            ["groundColor"]       = C3A(0.32f, 0.32f, 0.34f),
            ["sunColor"]          = C3A(0.85f, 0.88f, 0.92f),
            ["ambientColor"]      = C3A(0.70f, 0.72f, 0.75f),
            ["sunDirection"]      = C3A(65f,  20f,  0f),
            ["sunSize"]           = 0.08f,
            ["sunIntensity"]      = 0.5f,
            ["exposure"]          = 0.9f,
            ["atmosphereThickness"] = 1.6f,
            ["fogDensity"]        = 0.008f,
            ["ambientIntensity"]  = 1.0f,
        },
        ["warm_day"] = new JObject
        {
            ["topColor"]          = C3A(0.30f, 0.58f, 0.90f),
            ["horizonColor"]      = C3A(0.90f, 0.78f, 0.58f),
            ["bottomColor"]       = C3A(0.85f, 0.72f, 0.50f),
            ["groundColor"]       = C3A(0.35f, 0.28f, 0.18f),
            ["sunColor"]          = C3A(1.00f, 0.92f, 0.78f),
            ["ambientColor"]      = C3A(0.80f, 0.75f, 0.65f),
            ["sunDirection"]      = C3A(42f,  35f,  0f),
            ["sunSize"]           = 0.04f,
            ["sunIntensity"]      = 1.3f,
            ["exposure"]          = 1.15f,
            ["atmosphereThickness"] = 1.1f,
            ["fogDensity"]        = 0f,
            ["ambientIntensity"]  = 0.85f,
        },
        ["clear_blue"] = new JObject
        {
            ["topColor"]          = C3A(0.22f, 0.50f, 1.00f),
            ["horizonColor"]      = C3A(0.68f, 0.85f, 1.00f),
            ["bottomColor"]       = C3A(0.50f, 0.75f, 1.00f),
            ["groundColor"]       = C3A(0.28f, 0.24f, 0.20f),
            ["sunColor"]          = C3A(1.00f, 0.98f, 0.92f),
            ["ambientColor"]      = C3A(0.62f, 0.72f, 0.85f),
            ["sunDirection"]      = C3A(52f,  38f,  0f),
            ["sunSize"]           = 0.035f,
            ["sunIntensity"]      = 1.5f,
            ["exposure"]          = 1.25f,
            ["atmosphereThickness"] = 0.9f,
            ["fogDensity"]        = 0f,
            ["ambientIntensity"]  = 0.95f,
        },
        ["stormy"] = new JObject
        {
            ["topColor"]          = C3A(0.18f, 0.18f, 0.22f),
            ["horizonColor"]      = C3A(0.28f, 0.28f, 0.32f),
            ["bottomColor"]       = C3A(0.22f, 0.22f, 0.25f),
            ["groundColor"]       = C3A(0.10f, 0.10f, 0.12f),
            ["sunColor"]          = C3A(0.55f, 0.58f, 0.62f),
            ["ambientColor"]      = C3A(0.38f, 0.40f, 0.44f),
            ["sunDirection"]      = C3A(70f,  30f,  0f),
            ["sunSize"]           = 0.03f,
            ["sunIntensity"]      = 0.35f,
            ["exposure"]          = 0.7f,
            ["atmosphereThickness"] = 2.0f,
            ["fogDensity"]        = 0.015f,
            ["ambientIntensity"]  = 0.65f,
        },
    };

    private static readonly Dictionary<string, string> GroundPaths = new()
    {
        ["grass"]   = "Environment/Ground/grass_ground_diff",
        ["dirt"]    = "Environment/Ground/dirt_ground_diff",
        ["sand"]    = "Environment/Ground/sand_ground_diff",
        ["stone"]   = "Environment/Ground/stone_tiles_diff",
        ["snow"]    = "Environment/Ground/snow_ground_diff",
        ["wood"]    = "Environment/Ground/wood_planks_diff",
        ["asphalt"] = "Environment/Ground/asphalt_diff",
    };

    // Fallback solid colors when HDRI not found at runtime
    private static readonly Dictionary<string, Color> ProceduralColors = new()
    {
        ["midday"]      = new Color(0.53f, 0.81f, 0.98f),
        ["golden_hour"] = new Color(1.00f, 0.55f, 0.15f),
        ["overcast"]    = new Color(0.62f, 0.68f, 0.74f),
        ["night"]       = new Color(0.02f, 0.03f, 0.12f),
        ["stormy"]      = new Color(0.35f, 0.38f, 0.44f),
        ["clear_blue"]  = new Color(0.40f, 0.75f, 1.00f),
        ["warm_day"]    = new Color(0.95f, 0.78f, 0.56f),
        // Legacy Lua names kept for backward compat
        ["sunset"]      = new Color(1.00f, 0.38f, 0.12f),
        ["dawn"]        = new Color(0.90f, 0.68f, 0.48f),
        ["space"]       = new Color(0.00f, 0.00f, 0.04f),
    };

    private static readonly Dictionary<string, (string sky, string ground)> GenrePresets = new()
    {
        ["platformer"] = ("clear_blue",  "grass"),
        ["racer"]      = ("midday",      "asphalt"),
        ["puzzle"]     = ("overcast",    "stone"),
        ["survival"]   = ("stormy",      "dirt"),
        ["adventure"]  = ("warm_day",    "grass"),
        ["strategy"]   = ("overcast",    "stone"),
        ["simulation"] = ("midday",      "grass"),
    };

    private static readonly Dictionary<string, (float amb, Color sun, float sunI, Vector3 rot)> LightingPresets = new()
    {
        ["day"]         = (0.8f, new Color(1.00f, 0.95f, 0.85f), 1.5f, new Vector3(50f,  30f, 0f)),
        ["golden_hour"] = (0.5f, new Color(1.00f, 0.60f, 0.20f), 1.2f, new Vector3(15f,  50f, 0f)),
        ["overcast"]    = (1.0f, new Color(0.80f, 0.85f, 0.90f), 0.6f, new Vector3(60f,   0f, 0f)),
        ["night"]       = (0.1f, new Color(0.20f, 0.25f, 0.45f), 0.2f, new Vector3(30f, 180f, 0f)),
        ["stormy"]      = (0.6f, new Color(0.60f, 0.65f, 0.70f), 0.4f, new Vector3(70f,  30f, 0f)),
    };

    // ── Public API ─────────────────────────────────────────────────────────────

    // Build a procedural skybox material from a per-game descriptor. Used by
    // both the server-authoritative path (GameRenderClient parses the JObject
    // from world.scene.skyboxDescriptor) and the local-play path (LuauUnityApi
    // forwards the Scene.SetCustomSkybox table). Every parameter is optional;
    // missing fields fall back to sane defaults so a half-filled descriptor
    // still produces a valid sky.
    public static void SetSkyboxFromDescriptor(JObject d)
    {
        if (d == null) return;

        Color C3(string key, Color fallback)
        {
            var arr = d[key] as JArray;
            if (arr != null && arr.Count >= 3)
                return new Color(arr[0].Value<float>(), arr[1].Value<float>(), arr[2].Value<float>());
            return fallback;
        }
        float F(string key, float fallback)
        {
            var t = d[key];
            return t != null && t.Type != JTokenType.Null ? t.Value<float>() : fallback;
        }

        var topColor      = C3("topColor",      new Color(0.40f, 0.65f, 0.95f));
        var bottomColor   = C3("bottomColor",   new Color(0.85f, 0.93f, 1.00f));
        var horizonColor  = C3("horizonColor",  Color.Lerp(topColor, bottomColor, 0.5f));
        // groundColor is the hemisphere seen below the horizon — distinct
        // from bottomColor (zenith-mirror low-sky). Falls back to a darkened
        // horizonColor so older descriptors still render reasonably.
        var groundColor   = C3("groundColor",   horizonColor * 0.35f);
        var sunColor      = C3("sunColor",      new Color(1.00f, 0.95f, 0.85f));
        var fogColor      = C3("fogColor",      horizonColor);
        var ambientColor  = C3("ambientColor",  Color.Lerp(topColor, sunColor, 0.5f));

        var sunSize       = Mathf.Clamp(F("sunSize",       0.04f), 0f, 0.20f);
        var sunIntensity  = Mathf.Clamp(F("sunIntensity",  1.4f), 0f, 8f);
        var exposure      = Mathf.Clamp(F("exposure",      1.2f), 0f, 4f);
        var atmosphere    = Mathf.Clamp(F("atmosphereThickness", 1.0f), 0f, 5f);
        var fogDensity    = Mathf.Clamp(F("fogDensity",    0.008f), 0f, 0.1f);
        var ambientI      = Mathf.Clamp(F("ambientIntensity", 0.8f), 0f, 3f);
        var starDensity   = Mathf.Clamp01(F("starDensity",  0f));
        var cloudDensity  = Mathf.Clamp01(F("cloudDensity", 0f));

        // Sun direction comes as euler angles in the descriptor — pitch up
        // from horizon, yaw around vertical. The procedural skybox uses
        // RenderSettings.sun.transform.forward to position its disc.
        Vector3 sunEuler = new Vector3(50f, 30f, 0f);
        if (d["sunDirection"] is JArray sd && sd.Count >= 3)
            sunEuler = new Vector3(sd[0].Value<float>(), sd[1].Value<float>(), sd[2].Value<float>());

        // Pludo/Skybox is the richer per-game procedural shader (horizon band,
        // ground hemisphere, stars, clouds). Skybox/Procedural is Unity's
        // built-in fallback that handles topColor + bottomColor + sun + fog
        // but ignores horizon/ground/stars/clouds. Try the rich one first.
        var pludoShader = Shader.Find("Pludo/Skybox");
        if (pludoShader != null)
        {
            var mat = new Material(pludoShader);
            mat.SetColor("_TopColor",     topColor);
            mat.SetColor("_HorizonColor", horizonColor);
            mat.SetColor("_BottomColor",  bottomColor);
            mat.SetColor("_GroundColor",  groundColor);
            mat.SetColor("_SunColor",     sunColor);
            // Server descriptor ships euler angles; the shader wants a unit
            // direction vector toward the sun. Compute it on the C# side so
            // the shader stays branch-free.
            var sunRot = Quaternion.Euler(sunEuler) * Vector3.forward;
            mat.SetVector("_SunDirection", new Vector4(sunRot.x, sunRot.y, sunRot.z, 0));
            mat.SetFloat("_SunSize",      sunSize);
            mat.SetFloat("_SunIntensity", sunIntensity);
            mat.SetFloat("_Exposure",     exposure);
            mat.SetFloat("_AtmosphereThickness", atmosphere);
            mat.SetFloat("_StarDensity",  starDensity);
            mat.SetFloat("_CloudDensity", cloudDensity);
            RenderSettings.skybox = mat;
        }
        else
        {
            var procShader = Shader.Find("Skybox/Procedural");
            if (procShader != null)
            {
                var mat = new Material(procShader);
                // _SkyTint biases the upper hemisphere; _GroundColor biases the lower.
                mat.SetColor("_SkyTint",   topColor);
                mat.SetColor("_GroundColor", bottomColor);
                mat.SetFloat("_Exposure",  exposure);
                mat.SetFloat("_SunSize",   sunSize);
                mat.SetFloat("_AtmosphereThickness", atmosphere);
                RenderSettings.skybox = mat;
            }
            else
            {
                // Neither shader available → flat color clear that at least
                // matches the descriptor's top hue.
                RenderSettings.skybox = null;
                if (Camera.main != null)
                {
                    Camera.main.clearFlags      = CameraClearFlags.SolidColor;
                    Camera.main.backgroundColor = topColor;
                }
            }
        }

        // Fog
        if (fogDensity > 0f)
        {
            RenderSettings.fog        = true;
            RenderSettings.fogColor   = fogColor;
            RenderSettings.fogDensity = fogDensity;
        }
        else
        {
            RenderSettings.fog = false;
        }

        // Ambient
        RenderSettings.ambientLight     = ambientColor * ambientI;
        RenderSettings.ambientIntensity = ambientI;

        // Directional sun: positions the lighting key and the procedural sun disc.
        var sunGo = GameObject.Find("_EnvironmentSun");
        Light sun;
        if (sunGo == null)
        {
            sunGo = new GameObject("_EnvironmentSun");
            sun   = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
        }
        else
        {
            sun = sunGo.GetComponent<Light>() ?? sunGo.AddComponent<Light>();
        }
        sunGo.transform.rotation = Quaternion.Euler(sunEuler);
        sun.color                = sunColor;
        sun.intensity            = sunIntensity;
        RenderSettings.sun       = sun;

        DynamicGI.UpdateEnvironment();
        if (Camera.main != null && RenderSettings.skybox != null)
            Camera.main.clearFlags = CameraClearFlags.Skybox;
    }

    public static void SetSkybox(string skyboxName)
    {
        var key = skyboxName?.ToLower().Trim() ?? "";
        // Use the procedural Pludo/Skybox descriptor when one exists — keeps all
        // presets visually consistent with the default baseplate sky instead of
        // relying on external HDRI texture files.
        if (ProceduralPresets.TryGetValue(key, out var desc))
        {
            SetSkyboxFromDescriptor(desc);
            return;
        }
        SetProceduralSky(key);
    }

    // Apply a textured material to the ground plane. tileScale controls UV tiling.
    public static void SetGround(string groundType, GameObject groundPlane)
    {
        if (groundPlane == null) return;
        var key = groundType?.ToLower().Trim() ?? "grass";
        if (!GroundPaths.TryGetValue(key, out var path)) path = GroundPaths["grass"];

        var renderer = groundPlane.GetComponent<Renderer>();
        if (renderer == null) return;

        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var mat = new Material(shader);

        var tex = Resources.Load<Texture2D>(path);
        if (tex != null)
        {
            mat.SetTexture("_BaseMap", tex);
            mat.SetTexture("_MainTex", tex);
            mat.SetTextureScale("_BaseMap", new Vector2(20f, 20f));
            mat.SetTextureScale("_MainTex", new Vector2(20f, 20f));
            mat.color = Color.white;
        }
        else
        {
            mat.color = GroundFallbackColor(key);
        }

        renderer.material = mat;
    }

    // Roblox-style "baseplate" environment for a brand-new blank game: a clean
    // light-blue sky and bright, even ambient ("skyline") lighting so the gray
    // checkerboard baseplate reads cleanly. Uses the procedural sky shader.
    public static void SetBaseplateEnvironment()
    {
        // Clean light-blue gradient sky (Roblox baseplate look) via the rich
        // Pludo/Skybox shader — a flat blue→pale-blue gradient with NO warm
        // atmospheric haze (the haze is what made Skybox/Procedural read beige).
        // SetSkyboxFromDescriptor also sets the ambient + sun from these fields.
        JArray C(float r, float g, float b) => new JArray { r, g, b };
        var descriptor = new JObject
        {
            ["topColor"]      = C(0.33f, 0.58f, 0.92f), // sky blue overhead
            ["horizonColor"]  = C(0.80f, 0.90f, 0.98f), // pale blue at the horizon
            ["bottomColor"]   = C(0.62f, 0.80f, 0.96f),
            ["groundColor"]   = C(0.55f, 0.58f, 0.62f), // neutral gray below horizon
            ["sunColor"]      = C(1.00f, 0.98f, 0.92f),
            ["ambientColor"]  = C(0.70f, 0.72f, 0.76f), // bright neutral fill
            ["ambientIntensity"] = 1.05f,
            ["sunIntensity"]  = 1.15f,
            ["sunSize"]       = 0.035f,
            ["exposure"]      = 1.0f,
            ["fogDensity"]    = 0f,                     // no haze
            ["sunDirection"]  = C(50f, 40f, 0f),
        };
        SetSkyboxFromDescriptor(descriptor);
    }

    // Full environment preset from genre string.
    public static void SetEnvironment(string genre)
    {
        var key = genre?.ToLower().Trim() ?? "";
        if (!GenrePresets.TryGetValue(key, out var preset))
            preset = ("midday", "grass");

        SetSkybox(preset.sky);

        var lightPreset = preset.sky switch
        {
            "golden_hour" => "golden_hour",
            "night"       => "night",
            "stormy"      => "stormy",
            "overcast"    => "overcast",
            _             => "day",
        };
        SetLighting(lightPreset);
    }

    public static string GetSkyboxForGenre(string genre)
    {
        var key = genre?.ToLower().Trim() ?? "";
        return GenrePresets.TryGetValue(key, out var p) ? p.sky : "midday";
    }

    public static string GetGroundForGenre(string genre)
    {
        var key = genre?.ToLower().Trim() ?? "";
        return GenrePresets.TryGetValue(key, out var p) ? p.ground : "grass";
    }

    public static void SetLighting(string preset)
    {
        var key = preset?.ToLower().Trim() ?? "day";
        if (!LightingPresets.TryGetValue(key, out var lp))
            lp = LightingPresets["day"];

        RenderSettings.ambientIntensity = lp.amb;
        RenderSettings.ambientLight     = lp.sun * lp.amb * 0.5f;

        var sunGo = GameObject.Find("_EnvironmentSun");
        Light sun;
        if (sunGo == null)
        {
            sunGo = new GameObject("_EnvironmentSun");
            sun   = sunGo.AddComponent<Light>();
            sun.type = LightType.Directional;
        }
        else
        {
            sun = sunGo.GetComponent<Light>() ?? sunGo.AddComponent<Light>();
        }
        sun.color     = lp.sun;
        sun.intensity = lp.sunI;
        sunGo.transform.rotation = Quaternion.Euler(lp.rot);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private static void SetProceduralSky(string key)
    {
        // Try Skybox/Procedural first — gives a real sky horizon instead of a flat color.
        var shader = Shader.Find("Skybox/Procedural");
        if (shader != null)
        {
            var mat = new Material(shader);
            switch (key)
            {
                case "clear_blue":
                case "midday":
                    mat.SetColor("_SkyTint",   new Color(0.40f, 0.60f, 1.00f));
                    mat.SetColor("_GroundColor",new Color(0.30f, 0.25f, 0.20f));
                    mat.SetFloat("_Exposure",  1.3f); mat.SetFloat("_SunSize", 0.04f);
                    mat.SetFloat("_AtmosphereThickness", 1.0f);
                    break;
                case "golden_hour":
                case "warm_day":
                    mat.SetColor("_SkyTint",   new Color(1.00f, 0.60f, 0.20f));
                    mat.SetColor("_GroundColor",new Color(0.40f, 0.30f, 0.10f));
                    mat.SetFloat("_Exposure",  1.1f); mat.SetFloat("_SunSize", 0.06f);
                    mat.SetFloat("_AtmosphereThickness", 1.2f);
                    break;
                case "night":
                    mat.SetColor("_SkyTint",   new Color(0.05f, 0.05f, 0.15f));
                    mat.SetColor("_GroundColor",new Color(0.02f, 0.02f, 0.05f));
                    mat.SetFloat("_Exposure",  0.3f); mat.SetFloat("_SunSize", 0.02f);
                    mat.SetFloat("_AtmosphereThickness", 0.5f);
                    break;
                case "overcast":
                    mat.SetColor("_SkyTint",   new Color(0.60f, 0.65f, 0.70f));
                    mat.SetColor("_GroundColor",new Color(0.30f, 0.30f, 0.30f));
                    mat.SetFloat("_Exposure",  0.9f); mat.SetFloat("_SunSize", 0.08f);
                    mat.SetFloat("_AtmosphereThickness", 1.5f);
                    break;
                case "stormy":
                    mat.SetColor("_SkyTint",   new Color(0.20f, 0.20f, 0.25f));
                    mat.SetColor("_GroundColor",new Color(0.10f, 0.10f, 0.10f));
                    mat.SetFloat("_Exposure",  0.6f); mat.SetFloat("_SunSize", 0.03f);
                    mat.SetFloat("_AtmosphereThickness", 2.0f);
                    break;
                default:
                    mat.SetColor("_SkyTint",   new Color(0.40f, 0.60f, 1.00f));
                    mat.SetColor("_GroundColor",new Color(0.30f, 0.25f, 0.20f));
                    mat.SetFloat("_Exposure",  1.3f); mat.SetFloat("_SunSize", 0.04f);
                    mat.SetFloat("_AtmosphereThickness", 1.0f);
                    break;
            }
            RenderSettings.skybox = mat;
            DynamicGI.UpdateEnvironment();
            if (Camera.main != null) Camera.main.clearFlags = CameraClearFlags.Skybox;
            RenderSettings.ambientLight = new Color(0.4f, 0.45f, 0.5f);
            return;
        }

        // Absolute fallback: solid background color when no sky shader is available.
        if (!ProceduralColors.TryGetValue(key, out var col))
            col = new Color(0.53f, 0.81f, 0.98f);
        RenderSettings.skybox = null;
        DynamicGI.UpdateEnvironment();
        if (Camera.main != null)
        {
            Camera.main.clearFlags      = CameraClearFlags.SolidColor;
            Camera.main.backgroundColor = col;
        }
        RenderSettings.ambientLight = col * 0.4f;
    }

    private static Color GroundFallbackColor(string key) => key switch
    {
        "grass"   => new Color(0.20f, 0.45f, 0.15f),
        "dirt"    => new Color(0.48f, 0.30f, 0.18f),
        "sand"    => new Color(0.82f, 0.72f, 0.50f),
        "stone"   => new Color(0.40f, 0.40f, 0.42f),
        "snow"    => new Color(0.90f, 0.92f, 0.96f),
        "wood"    => new Color(0.50f, 0.32f, 0.18f),
        "asphalt" => new Color(0.20f, 0.20f, 0.22f),
        _         => new Color(0.28f, 0.30f, 0.32f),
    };
}
