using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

// Custom Logic (workflow) execution — the interpreter for the Struckd-style
// node graph authored in CreateScreen.tsx's Custom Logic panel (wire format:
// EditorObjectLogic.Workflow / .Step / .Guard / .LogicVar). Partial class so
// it can reach LuauGameRunner's private player/game-root state directly;
// split into its own file purely so LuauGameRunner.cs doesn't grow further.
//
// Coverage, honestly:
//   • Action   (37 types) — full runtime behavior. A few that need a system
//     this engine doesn't have (dialogue UI, inventory, AI behaviors, doors,
//     asset-by-friendly-name spawning) get a documented, best-effort stand-in
//     rather than a silent no-op — see each case below.
//   • Logic    (19 types) — full runtime behavior: a scalar/vector variable
//     store, math, vector ops, and branching via early-exit ("continue only
//     if" aborts the rest of *this* workflow's steps — there's no separate
//     true/false branch target in the flat wire format, so ifCheck/ifBranch/
//     comparePoints all gate the same way).
//   • Condition (22 types, used as inline "Only when" guards) — evaluated
//     for real wherever the engine has actual state to answer from: game
//     start, grounded/airborne, death, collision/proximity. Everything else
//     (aim, attack, dash, dialogue, doors, equip, inventory, mount, pickup,
//     reload, weapon change/scope, health regen) always evaluates false —
//     there is no aiming/weapon/dialogue/inventory/mount system in this
//     engine for them to observe, so pretending otherwise would be a lie.
//   • Flow     (16 types) — structurally inert. LogicStep is a flat list
//     with no child/branch references, so Sequence/Random/Parallel/Repeat/
//     Inverter/Succeeder/TimeOut have nothing to act on. They no-op without
//     erroring; making them do anything else would need a wire-format and
//     UI change (nested children), not an interpreter change.
//   • Triggers — only "On Game Start" actually fires a workflow (once, after
//     the player spawns in real Play). The other 20 event types round-trip
//     through EditorObjectLogic correctly but nothing in the engine emits
//     them yet, for the same reason the matching Conditions above are inert.
public partial class LuauGameRunner
{
    // Runtime scalar/vector/text variable store for Logic nodes (Set
    // Variable, Math, vector ops, Get Stat, …). Separate from the per-object
    // reference map built per EditorObjectLogic (BuildVariableMap) — a
    // {{name}} can be either kind, so resolvers check both. Shared across
    // every workflow for the lifetime of one Play session (reset on load).
    private readonly Dictionary<string, string> _wfScalars = new Dictionary<string, string>(StringComparer.Ordinal);

    // Per-object float stat store backing Change/Get Stat, Heal, Deal
    // Damage. The player's Health/MovementSpeed/JumpHeight are special-cased
    // onto the real systems (SetPlayerHealth etc.) so damage/heal still
    // trigger respawn-on-death instead of writing a shadow number nothing
    // else reads.
    private readonly Dictionary<GameObject, Dictionary<string, float>> _objectStats = new Dictionary<GameObject, Dictionary<string, float>>();

    // Points/score, addressed by player or team NAME rather than a scene
    // object — awardPoints/comparePoints target "Player" or a team string.
    private readonly Dictionary<string, float> _pointsByName = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);

    // Original rotation of any object changeDoor has opened, so "Close"
    // can restore it without a dedicated Door component existing.
    private readonly Dictionary<GameObject, Quaternion> _doorClosedRotation = new Dictionary<GameObject, Quaternion>();

    private Dictionary<string, GameObject> BuildVariableMap(EditorObjectLogic logic)
    {
        var map = new Dictionary<string, GameObject>(StringComparer.Ordinal) { ["Self"] = logic.gameObject };
        foreach (var v in logic.Variables)
        {
            if (v.Source != "asset" || string.IsNullOrEmpty(v.Name)) continue;
            map[v.Name] = ResolveVariableTarget(v.Target);
        }
        return map;
    }

    // A variable's stored Target is whatever object name was live in the editor
    // when the creator picked it via Assign. The player's editor-preview stand-in
    // ("LuauPreviewPlayer") never exists at real Play time — the running player
    // is "LuauLocalPlayer" — so that one name is special-cased to the live
    // player instance. Anything else is looked up as a direct child of the
    // game root, matching how the editor's own picker resolves objects.
    private GameObject ResolveVariableTarget(string target)
    {
        if (string.IsNullOrEmpty(target)) return null;
        if (target == "LuauPreviewPlayer") return _playerInstance;
        return GameRoot.Find(target)?.gameObject;
    }

    // A step's target param is either a bound {{Variable}} token, a literal
    // scene-object name, or empty (falls back to the workflow's own object).
    private GameObject ResolveTargetParam(string raw, GameObject self, Dictionary<string, GameObject> vars)
    {
        if (string.IsNullOrEmpty(raw)) return self;
        if (raw.StartsWith("{{") && raw.EndsWith("}}"))
        {
            var name = raw.Substring(2, raw.Length - 4);
            return vars != null && vars.TryGetValue(name, out var go) ? go : null;
        }
        return GameRoot.Find(raw)?.gameObject;
    }

    // "x,y,z" (any axis may be blank) → Vector3, missing axes fall back to `fallback`.
    private static Vector3 ParseVector(string raw, Vector3 fallback)
    {
        if (string.IsNullOrEmpty(raw)) return fallback;
        var parts = raw.Split(',');
        float Axis(int i, float d) => i < parts.Length && float.TryParse(parts[i], out var f) ? f : d;
        return new Vector3(Axis(0, fallback.x), Axis(1, fallback.y), Axis(2, fallback.z));
    }

    private static string Vec3ToStr(Vector3 v) => $"{v.x:F4},{v.y:F4},{v.z:F4}";

    private static string TokenName(string raw) =>
        !string.IsNullOrEmpty(raw) && raw.StartsWith("{{") && raw.EndsWith("}}") ? raw.Substring(2, raw.Length - 4) : null;

    // Resolves a {{token}} against the scalar store first, then the object
    // map (returning its live name), else returns the raw literal untouched.
    private string ResolveText(string raw, Dictionary<string, GameObject> vars)
    {
        if (string.IsNullOrEmpty(raw)) return raw ?? "";
        var name = TokenName(raw);
        if (name == null) return raw;
        if (_wfScalars.TryGetValue(name, out var sv)) return sv;
        if (vars != null && vars.TryGetValue(name, out var go)) return go != null ? go.name : "";
        return "";
    }

    private float ResolveFloat(string raw, Dictionary<string, GameObject> vars, float fallback = 0f)
    {
        var s = ResolveText(raw, vars);
        return float.TryParse(s, out var f) ? f : fallback;
    }

    private Vector3 ResolveVec(string raw, Dictionary<string, GameObject> vars, Vector3 fallback)
    {
        var name = TokenName(raw);
        if (name == null) return ParseVector(raw, fallback);
        return _wfScalars.TryGetValue(name, out var sv) ? ParseVector(sv, fallback) : fallback;
    }

    private void SetScalar(string name, string value)
    {
        if (string.IsNullOrEmpty(name)) return;
        _wfScalars[name] = value ?? "";
    }

    private float GetStatValue(GameObject go, string stat)
    {
        if (go != null && go == _playerInstance)
        {
            if (stat == "Health" || stat == "CurrentHealthPoints" || stat == "MaxHealthPoints") return _health;
            if (stat == "MovementSpeed") return _speed;
            if (stat == "JumpHeight" || stat == "JumpPower") return _jumpHeight;
        }
        if (go != null && _objectStats.TryGetValue(go, out var d) && d.TryGetValue(stat, out var v)) return v;
        return stat == "Health" || stat == "MaxHealthPoints" || stat == "CurrentHealthPoints" ? 100f : 0f;
    }

    private void SetStatValue(GameObject go, string stat, float value)
    {
        if (go == null) return;
        if (go == _playerInstance)
        {
            if (stat == "Health" || stat == "CurrentHealthPoints") { SetPlayerHealth(value); return; }
            if (stat == "MovementSpeed") { SetPlayerSpeed(value); return; }
            if (stat == "JumpHeight" || stat == "JumpPower") { SetPlayerJumpHeight(value); return; }
        }
        if (!_objectStats.TryGetValue(go, out var d)) { d = new Dictionary<string, float>(); _objectStats[go] = d; }
        d[stat] = value;
    }

    private float GetPoints(string who) => _pointsByName.TryGetValue(string.IsNullOrEmpty(who) ? "Player" : who, out var v) ? v : 0f;
    private void SetPoints(string who, float value) => _pointsByName[string.IsNullOrEmpty(who) ? "Player" : who] = value;

    private static bool Compare(float a, string op, float b) => op switch
    {
        "!=" => a != b,
        ">" => a > b,
        "<" => a < b,
        ">=" => a >= b,
        "<=" => a <= b,
        _ => Mathf.Approximately(a, b), // "=" and unknown default to equals
    };

    // ── Guard / Condition evaluation ────────────────────────────────────────
    // Answers a Condition as an instantaneous state check (used by "Only
    // when" guards on both workflow triggers and individual steps). Only
    // the types with real state behind them are meaningfully evaluable —
    // see the file header for the full list of always-false types.
    private bool EvaluateCondition(string type, Dictionary<string, string> p, GameObject self, Dictionary<string, GameObject> vars)
    {
        GameObject Target() => ResolveTargetParam(p.GetValueOrDefault("target"), self, vars);
        switch (type)
        {
            case "gameStart":
            case "check_gameStart":
                return true; // the workflow only ever runs after game start
            case "onGround":
            case "check_onGround":
            {
                var t = Target();
                if (t == null) return false;
                bool grounded = t.TryGetComponent<LuauPlayerController>(out var pc)
                    ? pc.IsGrounded
                    : Physics.Raycast(t.transform.position + Vector3.up * 0.1f, Vector3.down, 0.3f);
                return p.GetValueOrDefault("state") == "airborne" ? !grounded : grounded;
            }
            case "destroyed":
            case "check_destroyed":
                return Target() == null;
            case "collision":
            case "check_collision":
            {
                var t = Target();
                return t != null && IsOverlapping(t, null);
            }
            case "onCollisionWithObject":
            case "check_onCollisionWithObject":
            {
                var t = Target();
                var to = ResolveTargetParam(p.GetValueOrDefault("to"), null, vars);
                return t != null && to != null && IsOverlapping(t, to);
            }
            case "enterZone":
            case "check_enterZone":
            {
                var t = Target();
                var to = ResolveTargetParam(p.GetValueOrDefault("to"), _playerInstance, vars) ?? _playerInstance;
                float range = 0f; float.TryParse(p.GetValueOrDefault("range"), out range);
                return t != null && to != null && Vector3.Distance(t.transform.position, to.transform.position) <= (range > 0f ? range : 5f);
            }
            default:
                // No aim/attack/dash/dialogue/door/equip/inventory/mount/
                // pickup/reload/weapon/health-regen system exists yet.
                return false;
        }
    }

    private static bool IsOverlapping(GameObject a, GameObject b)
    {
        if (a == null || !a.TryGetComponent<Collider>(out var ca)) return false;
        if (b == null)
            return Physics.CheckBox(ca.bounds.center, ca.bounds.extents, Quaternion.identity, ~0, QueryTriggerInteraction.Ignore);
        if (!b.TryGetComponent<Collider>(out var cb)) return false;
        return ca.bounds.Intersects(cb.bounds);
    }

    private bool EvaluateGuards(List<EditorObjectLogic.Guard> guards, GameObject self, Dictionary<string, GameObject> vars)
    {
        if (guards == null) return true;
        foreach (var g in guards)
        {
            bool result = EvaluateCondition(g.Type, g.Params, self, vars);
            if (g.Negate) result = !result;
            if (!result) return false;
        }
        return true;
    }

    // ── Step sequencer ───────────────────────────────────────────────────────
    // A coroutine (not a plain loop) so "Wait" can genuinely suspend this
    // workflow's own remaining steps without blocking anything else.
    private IEnumerator RunWorkflowSteps(List<EditorObjectLogic.Step> steps, GameObject self, Dictionary<string, GameObject> vars)
    {
        foreach (var step in steps)
        {
            if (!step.Enabled) continue;
            if (!EvaluateGuards(step.Guards, self, vars)) continue;
            if (step.Type == "wait")
            {
                float secs = ResolveFloat(step.Params.GetValueOrDefault("seconds"), vars, 0f);
                if (secs > 0f) yield return new WaitForSeconds(secs);
                continue;
            }
            bool keepGoing = RunWorkflowStep(step, self, vars);
            if (!keepGoing) yield break; // ifCheck / ifBranch / comparePoints gate failed
        }
    }

    // Returns false to abort the rest of this workflow's steps (gates only —
    // ifCheck, ifBranch, comparePoints). Everything else always returns true.
    private bool RunWorkflowStep(EditorObjectLogic.Step step, GameObject self, Dictionary<string, GameObject> vars)
    {
        var p = step.Params;
        string Raw(string key) => p.GetValueOrDefault(key);
        GameObject Target() => ResolveTargetParam(Raw("target"), self, vars);

        switch (step.Type)
        {
            // ── Action ──────────────────────────────────────────────────────
            case "addForce":
            {
                var t = Target();
                if (t != null && t.TryGetComponent<Rigidbody>(out var rb))
                    rb.AddForce(ResolveVec(Raw("direction"), vars, Vector3.zero), ForceMode.Impulse);
                break;
            }
            case "attachObject":
            {
                var t = Target();
                var parent = ResolveTargetParam(Raw("parent"), null, vars);
                if (t != null && parent != null)
                {
                    t.transform.SetParent(parent.transform, false);
                    t.transform.localPosition = ResolveVec(Raw("offset"), vars, Vector3.zero);
                }
                break;
            }
            case "cameraLookAt":
            {
                var t = Target();
                float secs = ResolveFloat(Raw("seconds"), vars, 0f);
                if (t != null && Camera.main != null)
                    StartCoroutine(CameraLookAtCoroutine(t.transform, secs > 0f ? secs : 2f));
                break;
            }
            case "changeBehavior":
                // No AI-behavior system exists (Guard/Follow/Flee/Wander) —
                // recorded so a future system has somewhere to read it from.
                if (Target() is GameObject cb) _objectStats.TryAdd(cb, new Dictionary<string, float>());
                break;
            case "changeCamera":
            {
                var t = Target();
                if (t != null && Camera.main != null) ApplyCameraView(Camera.main.transform, t.transform, Raw("view"));
                break;
            }
            case "changeDoor":
            {
                var t = Target();
                if (t != null)
                {
                    if (!_doorClosedRotation.ContainsKey(t)) _doorClosedRotation[t] = t.transform.localRotation;
                    t.transform.localRotation = Raw("state") == "Close"
                        ? _doorClosedRotation[t]
                        : _doorClosedRotation[t] * Quaternion.Euler(0, 90f, 0);
                }
                break;
            }
            case "changeEnvironment":
                ApplyEnvironmentChange(Raw("setting"), Raw("mode"), ResolveFloat(Raw("value"), vars, 0f));
                break;
            case "changeStat":
            {
                var t = Target();
                if (t != null)
                {
                    float value = ResolveFloat(Raw("value"), vars, 0f);
                    float cur = GetStatValue(t, Raw("stat"));
                    SetStatValue(t, Raw("stat"), Raw("mode") == "by" ? cur + value : value);
                }
                break;
            }
            case "changeTeam":
                if (Target() is GameObject ctGo) SetStatValue(ctGo, "__team_marker", 1f); // team string has no numeric slot; presence only
                break;
            case "changeWeather":
                // No weather system — approximate via fog density (Stormy/
                // Foggy thicker, Clear thinnest) so the change is visible.
                RenderSettings.fog = true;
                RenderSettings.fogDensity = Raw("weather") switch
                {
                    "Clear" => 0.0005f,
                    "Cloudy" => 0.01f,
                    "Overcast" => 0.02f,
                    "Foggy" => 0.05f,
                    "Stormy" => 0.08f,
                    _ => RenderSettings.fogDensity,
                };
                break;
            case "clearInventory":
                break; // no inventory system
            case "convertToString":
                SetScalar(Raw("variable"), ResolveText(Raw("value"), vars));
                break;
            case "dealDamage":
            {
                var t = Target();
                if (t != null) SetStatValue(t, "Health", GetStatValue(t, "Health") - ResolveFloat(Raw("amount"), vars, 0f));
                break;
            }
            case "heal":
            {
                var t = Target();
                if (t != null) SetStatValue(t, "Health", Mathf.Min(100f, GetStatValue(t, "Health") + ResolveFloat(Raw("amount"), vars, 0f)));
                break;
            }
            case "destroy":
            {
                var t = Target();
                if (t != null) Destroy(t);
                break;
            }
            case "detachObject":
            {
                var t = Target();
                if (t != null) t.transform.SetParent(GameRoot, true);
                break;
            }
            case "endGame":
                RequestShowMessage($"Game Over — {Raw("outcome")}", 6f);
                break;
            case "endGameAsTeam":
                RequestShowMessage($"Team {Raw("team")} {Raw("outcome")}s!", 6f);
                break;
            case "lookAt":
            {
                var t = Target();
                if (t != null && self != null) self.transform.LookAt(t.transform.position);
                break;
            }
            case "moveToObject":
            {
                var t = Target();
                var to = ResolveTargetParam(Raw("to"), null, vars);
                if (t != null && to != null)
                {
                    float speed = ResolveFloat(Raw("speed"), vars, 0f);
                    StartCoroutine(MoveTowards(t.transform, to.transform, speed > 0f ? speed : 4f));
                }
                break;
            }
            case "moveToVector":
            {
                var t = Target();
                if (t != null)
                {
                    var pos = ResolveVec(Raw("position"), vars, Vector3.zero);
                    var dest = Raw("mode") == "by" ? t.transform.position + pos : pos;
                    float speed = ResolveFloat(Raw("speed"), vars, 0f);
                    StartCoroutine(MoveToPoint(t.transform, dest, speed > 0f ? speed : 4f));
                }
                break;
            }
            case "playAnimation":
            {
                var t = Target();
                if (t != null && t.TryGetComponent<Animator>(out var anim) && HasAnimParam(anim, Raw("animation")))
                    anim.SetTrigger(Raw("animation"));
                break;
            }
            case "playSound":
                GameAudio.PlaySound(Raw("name"));
                break;
            case "position":
            {
                var t = Target();
                if (t != null)
                {
                    var offset = ResolveVec(Raw("position"), vars, Vector3.zero);
                    var newPos = Raw("mode") == "by" ? t.transform.position + offset : offset;
                    float duration = ResolveFloat(Raw("duration"), vars, 0f);
                    if (duration > 0f) StartCoroutine(LerpPosition(t.transform, newPos, duration));
                    else
                    {
                        t.transform.position = newPos;
                        if (t.TryGetComponent<Rigidbody>(out var rb)) { rb.linearVelocity = Vector3.zero; rb.angularVelocity = Vector3.zero; }
                    }
                }
                break;
            }
            case "rotate":
            {
                var t = Target();
                if (t != null)
                {
                    var offset = ResolveVec(Raw("rotation"), vars, Vector3.zero);
                    var newEuler = Raw("mode") == "by" ? t.transform.eulerAngles + offset : offset;
                    float duration = ResolveFloat(Raw("duration"), vars, 0f);
                    if (duration > 0f) StartCoroutine(LerpRotation(t.transform, Quaternion.Euler(newEuler), duration));
                    else t.transform.eulerAngles = newEuler;
                }
                break;
            }
            case "scale":
            {
                var t = Target();
                if (t != null)
                {
                    var offset = ResolveVec(Raw("scale"), vars, Vector3.one);
                    var newScale = Raw("mode") == "by" ? t.transform.localScale + offset : offset;
                    float duration = ResolveFloat(Raw("duration"), vars, 0f);
                    if (duration > 0f) StartCoroutine(LerpScale(t.transform, newScale, duration));
                    else t.transform.localScale = newScale;
                }
                break;
            }
            case "spawn":
            {
                var pos = ResolveVec(Raw("position"), vars, Vector3.zero);
                var go = SpawnPlaceholder(Raw("asset"), pos);
                if (vars != null) vars[Raw("variable")] = go;
                break;
            }
            case "spawnAtObject":
            {
                var t = ResolveTargetParam(Raw("target"), null, vars);
                var offset = ResolveVec(Raw("offset"), vars, Vector3.zero);
                var pos = (t != null ? t.transform.position : Vector3.zero) + offset;
                var go = SpawnPlaceholder(Raw("asset"), pos);
                if (vars != null) vars[Raw("variable")] = go;
                break;
            }
            case "startDialogue":
            {
                var t = Target();
                RequestShowMessage($"💬 Dialogue with {(t != null ? t.name : "object")}", 4f);
                break;
            }
            case "textBubble":
            {
                var t = Target();
                if (t != null) StartCoroutine(FloatingLabel(t.transform, ResolveText(Raw("text"), vars), ResolveFloat(Raw("seconds"), vars, 3f)));
                break;
            }
            case "textOnObject":
            {
                var t = Target();
                if (t == null) break;
                var text = ResolveText(Raw("text"), vars);
                if (t.TryGetComponent<TMPro.TMP_Text>(out var tmp)) tmp.text = text;
                else if (t.TryGetComponent<TextMesh>(out var legacy)) legacy.text = text;
                else StartCoroutine(FloatingLabel(t.transform, text, 3f));
                break;
            }
            case "showMessage":
                RequestShowMessage(ResolveText(Raw("text"), vars), ResolveFloat(Raw("seconds"), vars, 3f) is var s && s > 0f ? s : 3f);
                break;
            case "toggleCollision":
            {
                var t = Target();
                if (t != null) foreach (var c in t.GetComponentsInChildren<Collider>(true)) c.enabled = Raw("on") == "true";
                break;
            }
            case "togglePhysics":
            {
                var t = Target();
                if (t != null && t.TryGetComponent<Rigidbody>(out var rb))
                {
                    bool on = Raw("on") == "true";
                    rb.isKinematic = !on;
                    rb.useGravity = on;
                }
                break;
            }
            case "toggleVisibility":
            {
                var t = Target();
                if (t != null) foreach (var r in t.GetComponentsInChildren<Renderer>(true)) r.enabled = Raw("on") == "true";
                break;
            }
            case "walkToObject":
            {
                var t = Target();
                var to = ResolveTargetParam(Raw("to"), null, vars);
                if (t != null && to != null)
                {
                    float speed = ResolveFloat(Raw("speed"), vars, 0f);
                    StartCoroutine(WalkTowards(t.transform, to.transform, speed > 0f ? speed : 3f));
                }
                break;
            }
            case "walkToVector":
            {
                var t = Target();
                if (t != null)
                {
                    var pos = ResolveVec(Raw("position"), vars, Vector3.zero);
                    var dest = Raw("mode") == "by" ? t.transform.position + pos : pos;
                    float speed = ResolveFloat(Raw("speed"), vars, 0f);
                    StartCoroutine(WalkToPoint(t.transform, dest, speed > 0f ? speed : 3f));
                }
                break;
            }

            // ── Logic ───────────────────────────────────────────────────────
            case "setVariable":
                SetScalar(Raw("name"), ResolveText(Raw("value"), vars));
                break;
            case "addToString":
            {
                var name = Raw("name");
                _wfScalars.TryGetValue(name, out var cur);
                SetScalar(name, (cur ?? "") + ResolveText(Raw("text"), vars));
                break;
            }
            case "math":
            {
                float l = ResolveFloat(Raw("left"), vars, 0f);
                float r = ResolveFloat(Raw("right"), vars, 0f);
                float result = Raw("op") switch { "-" => l - r, "×" => l * r, "÷" => r != 0f ? l / r : 0f, _ => l + r };
                SetScalar(Raw("variable"), result.ToString("F4"));
                break;
            }
            case "randomFloat":
            {
                float min = ResolveFloat(Raw("min"), vars, 0f);
                float max = ResolveFloat(Raw("max"), vars, 1f);
                SetScalar(Raw("variable"), UnityEngine.Random.Range(min, max).ToString("F4"));
                break;
            }
            case "ifCheck":
            case "ifBranch":
                return Compare(ResolveFloat(Raw("left"), vars, 0f), Raw("op"), ResolveFloat(Raw("right"), vars, 0f));
            case "comparePoints":
            {
                float l = _pointsByName.ContainsKey(Raw("left")) ? GetPoints(Raw("left")) : ResolveFloat(Raw("left"), vars, 0f);
                float r = _pointsByName.ContainsKey(Raw("right")) ? GetPoints(Raw("right")) : ResolveFloat(Raw("right"), vars, 0f);
                return Compare(l, Raw("op"), r);
            }
            case "awardPoints":
                SetPoints(Raw("target"), ResolveFloat(Raw("points"), vars, 0f));
                break;
            case "getStat":
            {
                var t = ResolveTargetParam(Raw("target"), self, vars);
                SetScalar(Raw("variable"), t != null ? GetStatValue(t, Raw("stat")).ToString("F4") : "0");
                break;
            }
            case "getEnvironment":
            {
                float value = Raw("setting") switch
                {
                    "Gravity" => Physics.gravity.y,
                    "Light intensity" => RenderSettings.ambientIntensity,
                    "Fog intensity" => RenderSettings.fogDensity,
                    _ => 0f, // "Water height" — no water system
                };
                SetScalar(Raw("variable"), value.ToString("F4"));
                break;
            }
            case "getObjectVector":
            {
                var t = ResolveTargetParam(Raw("target"), self, vars);
                SetScalar(Raw("variable"), t != null ? Vec3ToStr(t.transform.position) : "0,0,0");
                break;
            }
            case "addVector":
                SetScalar(Raw("variable"), Vec3ToStr(ResolveVec(Raw("a"), vars, Vector3.zero) + ParseVector(ResolveText(Raw("b"), vars), Vector3.zero)));
                break;
            case "multiplyVector":
                SetScalar(Raw("variable"), Vec3ToStr(ResolveVec(Raw("vector"), vars, Vector3.zero) * ResolveFloat(Raw("factor"), vars, 1f)));
                break;
            case "randomVector":
            {
                var min = ParseVector(ResolveText(Raw("min"), vars), new Vector3(-5, 0, -5));
                var max = ParseVector(ResolveText(Raw("max"), vars), new Vector3(5, 0, 5));
                var rv = new Vector3(UnityEngine.Random.Range(min.x, max.x), UnityEngine.Random.Range(min.y, max.y), UnityEngine.Random.Range(min.z, max.z));
                SetScalar(Raw("variable"), Vec3ToStr(rv));
                break;
            }
            case "getVectorElement":
            {
                var v = ResolveVec(Raw("vector"), vars, Vector3.zero);
                float axisVal = Raw("axis") switch { "Y" => v.y, "Z" => v.z, _ => v.x };
                SetScalar(Raw("variable"), axisVal.ToString("F4"));
                break;
            }
            case "setVectorElement":
            {
                var name = TokenName(Raw("vector"));
                if (name == null) break;
                var v = ResolveVec(Raw("vector"), vars, Vector3.zero);
                float val = ResolveFloat(Raw("value"), vars, 0f);
                v = Raw("axis") switch { "Y" => new Vector3(v.x, val, v.z), "Z" => new Vector3(v.x, v.y, val), _ => new Vector3(val, v.y, v.z) };
                SetScalar(name, Vec3ToStr(v));
                break;
            }
            case "saveAimDirection":
                SetScalar(Raw("variable"), self != null ? Vec3ToStr(self.transform.forward) : "0,0,1");
                break;
            case "saveDistance":
            {
                var from = ResolveTargetParam(Raw("from"), self, vars);
                var to = ResolveTargetParam(Raw("to"), null, vars);
                SetScalar(Raw("variable"), from != null && to != null ? Vector3.Distance(from.transform.position, to.transform.position).ToString("F4") : "0");
                break;
            }

            // "execute" (root marker) and every Flow type (sequence,
            // tryInOrder, random, runInParallel*, waitForAll/Any, repeat*,
            // inverter, succeeder, timeOut) fall through here — structurally
            // inert, see file header.
            default:
                break;
        }
        return true;
    }

    private static bool HasAnimParam(Animator a, string name)
    {
        if (a == null || string.IsNullOrEmpty(name)) return false;
        foreach (var param in a.parameters) if (param.name == name) return true;
        return false;
    }

    private GameObject SpawnPlaceholder(string label, Vector3 pos)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = string.IsNullOrEmpty(label) ? "SpawnedObject" : label;
        go.transform.SetParent(GameRoot, true);
        go.transform.position = pos;
        go.transform.localScale = Vector3.one * 0.5f;
        return go;
    }

    private void ApplyCameraView(Transform cam, Transform target, string view)
    {
        switch (view)
        {
            case "First Person":
                cam.position = target.position + Vector3.up * 1.6f;
                cam.rotation = target.rotation;
                break;
            case "Top Down":
                cam.position = target.position + Vector3.up * 15f;
                cam.rotation = Quaternion.Euler(90f, 0f, 0f);
                break;
            default: // "Third Person"
                cam.position = target.position - target.forward * 4f + Vector3.up * 2f;
                cam.LookAt(target.position + Vector3.up * 1.2f);
                break;
        }
    }

    private void ApplyEnvironmentChange(string setting, string mode, float value)
    {
        switch (setting)
        {
            case "Gravity":
                Physics.gravity = new Vector3(0, mode == "by" ? Physics.gravity.y + value : value, 0);
                break;
            case "Light Intensity":
                RenderSettings.ambientIntensity = mode == "by" ? RenderSettings.ambientIntensity + value : value;
                break;
            case "Fog Density":
                RenderSettings.fog = true;
                RenderSettings.fogDensity = mode == "by" ? RenderSettings.fogDensity + value : value;
                break;
            case "Ambient Light":
                RenderSettings.ambientIntensity = mode == "by" ? RenderSettings.ambientIntensity + value : value;
                break;
        }
    }

    private IEnumerator CameraLookAtCoroutine(Transform target, float duration)
    {
        var cam = Camera.main;
        float elapsed = 0f;
        while (cam != null && target != null && elapsed < duration)
        {
            cam.transform.LookAt(target.position);
            elapsed += Time.deltaTime;
            yield return null;
        }
    }

    private IEnumerator FloatingLabel(Transform anchor, string text, float seconds)
    {
        var go = new GameObject("WorkflowLabel");
        var tm = go.AddComponent<TextMesh>();
        tm.text = text;
        tm.fontSize = 48;
        tm.characterSize = 0.1f;
        tm.color = Color.white;
        tm.anchor = TextAnchor.LowerCenter;
        tm.alignment = TextAlignment.Center;
        go.transform.SetParent(anchor, false);
        go.transform.localPosition = Vector3.up * 2f;
        float elapsed = 0f;
        var cam = Camera.main;
        while (elapsed < seconds)
        {
            if (go == null) yield break;
            if (cam != null) go.transform.rotation = cam.transform.rotation;
            elapsed += Time.deltaTime;
            yield return null;
        }
        if (go != null) Destroy(go);
    }

    private IEnumerator LerpPosition(Transform t, Vector3 target, float duration)
    {
        var start = t.position;
        float elapsed = 0f;
        while (t != null && elapsed < duration)
        {
            elapsed += Time.deltaTime;
            t.position = Vector3.Lerp(start, target, Mathf.Clamp01(elapsed / duration));
            yield return null;
        }
        if (t != null) t.position = target;
    }

    private IEnumerator LerpRotation(Transform t, Quaternion target, float duration)
    {
        var start = t.rotation;
        float elapsed = 0f;
        while (t != null && elapsed < duration)
        {
            elapsed += Time.deltaTime;
            t.rotation = Quaternion.Slerp(start, target, Mathf.Clamp01(elapsed / duration));
            yield return null;
        }
        if (t != null) t.rotation = target;
    }

    private IEnumerator LerpScale(Transform t, Vector3 target, float duration)
    {
        var start = t.localScale;
        float elapsed = 0f;
        while (t != null && elapsed < duration)
        {
            elapsed += Time.deltaTime;
            t.localScale = Vector3.Lerp(start, target, Mathf.Clamp01(elapsed / duration));
            yield return null;
        }
        if (t != null) t.localScale = target;
    }

    private IEnumerator MoveTowards(Transform t, Transform target, float speed)
    {
        while (t != null && target != null && Vector3.Distance(t.position, target.position) > 0.05f)
        {
            t.position = Vector3.MoveTowards(t.position, target.position, speed * Time.deltaTime);
            yield return null;
        }
    }

    private IEnumerator MoveToPoint(Transform t, Vector3 dest, float speed)
    {
        while (t != null && Vector3.Distance(t.position, dest) > 0.05f)
        {
            t.position = Vector3.MoveTowards(t.position, dest, speed * Time.deltaTime);
            yield return null;
        }
    }

    private IEnumerator WalkTowards(Transform t, Transform target, float speed)
    {
        while (t != null && target != null && Vector3.Distance(t.position, target.position) > 0.1f)
        {
            var dir = (target.position - t.position); dir.y = 0f;
            if (dir.sqrMagnitude > 0.0001f) t.rotation = Quaternion.LookRotation(dir.normalized);
            t.position = Vector3.MoveTowards(t.position, target.position, speed * Time.deltaTime);
            yield return null;
        }
    }

    private IEnumerator WalkToPoint(Transform t, Vector3 dest, float speed)
    {
        while (t != null && Vector3.Distance(t.position, dest) > 0.1f)
        {
            var dir = (dest - t.position); dir.y = 0f;
            if (dir.sqrMagnitude > 0.0001f) t.rotation = Quaternion.LookRotation(dir.normalized);
            t.position = Vector3.MoveTowards(t.position, dest, speed * Time.deltaTime);
            yield return null;
        }
    }
}
