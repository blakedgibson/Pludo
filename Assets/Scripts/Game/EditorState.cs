using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Editor-session persistence. Captures everything the user can mutate in the
// React editor that ISN'T already covered by `game_code` (the Lua script
// itself, written by the AI on /api/edit-game): per-object transform tweaks
// (move / rotate / scale / duplicate), the per-object Settings (gear) panel,
// and the per-object Custom Logic graph.
//
// Object identity is keyed on `transform.name`. The Lua script re-creates
// objects with deterministic names on every run (Object.Create("model:Zombie")
// → "model:Zombie", obj:SetName("Boss") → "Boss"), so applying a snapshot on
// top of a freshly-executed script matches by name. Objects that no longer
// exist in the rebuilt script are silently dropped — their snapshot entry is
// preserved so a future revert can still rehydrate them if the user undoes the
// Lua change that removed them.
//
// Reciprocal serializer/applier so a round-trip is a no-op:
//   Apply(Capture(runner)) === scene unchanged.
public static class EditorState
{
    // Names of script-created objects the user deleted in the editor. Session-
    // global; EditorCameraController.DeleteSelected adds to it, Capture writes it
    // into the snapshot, Apply re-seeds it from the snapshot (clear-then-add) and
    // destroys the matching objects after the script re-creates them. Cleared by
    // LuauGameRunner.TearDown so it can't leak across games.
    public static readonly HashSet<string> DeletedNames = new HashSet<string>(StringComparer.Ordinal);

    // Deletions must be destroyed EXACTLY ONCE per session — on the first Apply
    // pass (the synchronous post-build pass, before the first frame renders).
    // Apply runs many times (sync pass + delayed reapplies for late Meshy swaps
    // + React's editorApplyState re-pushes). Because object names are not unique
    // (the Lua script can create five objects all named "Structure.Cube"), a
    // single deleted name destroys the *first match* each pass — so re-running
    // deletions on every pass progressively wipes out every same-named sibling
    // over several seconds (the "objects deleting before my eyes" bug). This
    // flag gates destruction to the first pass; DeletedNames is still re-seeded
    // every pass so a subsequent Capture/autosave keeps persisting them. Reset
    // by LuauGameRunner.TearDown so the next game starts fresh.
    public static bool DeletionsApplied;

    // ── Capture ──────────────────────────────────────────────────────────────
    // Walks LuauGameRunner.GameRoot's direct children and emits a JSON object
    // matching the shape consumed by Apply() and stored on
    // forge_games.editor_state_json. Returns "{}" if no runner / root.
    public static string Capture(LuauGameRunner runner)
    {
        if (runner == null) runner = LuauGameRunner.Instance;
        var root = runner != null ? runner.GameRoot : null;
        var doc = new JObject
        {
            ["version"]  = 1,
            ["savedAt"]  = DateTime.UtcNow.ToString("o"),
            ["objects"]  = new JArray(),
        };
        if (root == null) return doc.ToString(Formatting.None);

        var arr       = (JArray)doc["objects"];
        var added     = new JArray();
        var seenNames = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < root.childCount; i++)
        {
            var child = root.GetChild(i);
            if (child == null) continue;

            // Skip anonymous Lua scratch objects and Unity-side primitives
            // that the Lua engine spawns/destroys frequently (lighting probes,
            // build-preview blocks). They have no stable identity and shouldn't
            // bloat the snapshot.
            var name = child.name ?? "";
            if (string.IsNullOrEmpty(name)) continue;
            // Dedupe — if two children share a name (which the Lua side allows
            // but we cannot disambiguate on apply), keep the first.
            if (!seenNames.Add(name)) continue;

            var entry = BuildEntry(child);

            // Objects the user ADDED (drag-placed assets, duplicates) carry an
            // EditorPlacedObject marker. The Lua script never recreates them, so
            // they go in a separate `added` list with a recreation recipe; Apply
            // re-spawns them after the script runs. Everything else is a
            // script-created object and only needs its property tweaks recorded.
            var placed = child.GetComponent<EditorPlacedObject>();
            if (placed != null)
            {
                entry["recipe"] = new JObject
                {
                    ["cacheKey"]   = placed.cacheKey ?? "",
                    ["modelUrl"]   = placed.modelUrl ?? "",
                    ["isHumanoid"] = placed.isHumanoid,
                    ["cloneOf"]    = placed.cloneOf ?? "",
                };
                added.Add(entry);
            }
            else
            {
                arr.Add(entry);
            }
        }
        if (added.Count > 0) doc["added"] = added;

        // Names of script-created objects the user DELETED. The script recreates
        // them on every run, so Apply must destroy them again afterwards.
        if (DeletedNames.Count > 0)
        {
            var del = new JArray();
            foreach (var dn in DeletedNames) del.Add(dn);
            doc["deleted"] = del;
        }

        // Terrain Builder heightmap/paint. Independent of GameRoot — the
        // sculpted baseplate survives Lua TearDowns. Only emitted once the user
        // has touched it (Instance, never EnsureInstance, so capture never
        // spawns a terrain GO for games that don't use one).
        var tb = TerrainBuilder.Instance;
        if (tb != null && tb.Touched)
        {
            try
            {
                var terrainJson = tb.SerializeState();
                if (!string.IsNullOrEmpty(terrainJson))
                    doc["terrain"] = JObject.Parse(terrainJson);
            }
            catch (Exception e) { Debug.LogWarning($"[EditorState] terrain capture failed: {e.Message}"); }
        }

        // Orbit-cam pose, so reopening the editor restores the exact view the
        // user left (otherwise the scene looks empty even though it isn't).
        var cam = EditorCameraController.Instance;
        if (cam != null)
        {
            cam.GetView(out var piv, out var yaw, out var pitch, out var dist);
            doc["camera"] = new JObject
            {
                ["pivot"] = Vec3ToArr(piv),
                ["yaw"]   = Math.Round(yaw,   3),
                ["pitch"] = Math.Round(pitch, 3),
                ["dist"]  = Math.Round(dist,  3),
            };
        }

        // Scene style/player settings (Tools → Style / Player). Only emitted when
        // the creator has changed something away from the defaults.
        if (!SceneSettings.IsDefault)
            doc["sceneSettings"] = SceneSettings.ToJson();

        return doc.ToString(Formatting.None);
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    // Routes a previously-captured JSON blob back onto the current scene. Run
    // AFTER the Lua script has executed and all `Object.Create` calls have
    // returned — otherwise the matching transforms don't exist yet. The
    // applier is tolerant: missing fields, missing components, and missing
    // objects are all silently skipped so a partial snapshot from a prior
    // schema version can still land.
    // `restoreOnce`, when supplied, makes Apply restore each named object (and the
    // terrain) AT MOST ONCE across all the calls that share the set. The load path
    // (LuauGameRunner.ReapplyEditorStateLater) re-runs Apply on a 0.75 s cadence to
    // catch placed assets that re-spawn asynchronously — but a plain re-Apply also
    // re-writes the saved transform onto objects that ALREADY exist, silently
    // reverting any edit the user made since the previous pass. Script-created
    // objects exist from frame 0, so the user edits them DURING that window and the
    // next pass clobbered the edit (placed assets only become editable after they
    // re-spawn, i.e. once the loop has usually exited — which is why their edits
    // stuck while script-object edits did not). With a shared `restoreOnce` set each
    // object is restored a single time, when it first appears, and never re-touched,
    // so a later user edit is physically safe from the reconcile loop. Pass null
    // (undo/redo's ApplyExact, one-shot applies) for the original always-overwrite
    // behaviour.
    public static void Apply(LuauGameRunner runner, string json, bool restoreCamera = false, HashSet<string> restoreOnce = null)
    {
        if (runner == null) runner = LuauGameRunner.Instance;
        if (string.IsNullOrWhiteSpace(json)) return;

        JObject doc;
        try { doc = JObject.Parse(json); }
        catch (Exception e) { Debug.LogWarning($"[EditorState] Apply: bad JSON: {e.Message}"); return; }

        // Restore the saved orbit-cam pose — ONLY on the load path (restoreCamera
        // true). Never on undo/redo: reverting an object edit must not yank the
        // camera around. Applied early so it sticks over the default spawn view.
        if (restoreCamera && doc["camera"] is JObject camo)
        {
            var cam = EditorCameraController.Instance;
            if (cam != null)
            {
                float dist = F(camo["dist"]);
                if (dist > 0.01f)
                    cam.ApplyView(ReadVec(camo["pivot"], Vector3.zero), F(camo["yaw"]), F(camo["pitch"]), dist);
            }
        }

        // Restore the Terrain Builder grid first — it's independent of GameRoot
        // (survives Lua TearDowns) so it must come back even if the script
        // hasn't re-created its objects yet on this apply pass.
        // "\0terrain" is a sentinel that can't collide with a GameObject name, so a
        // shared restoreOnce set deserializes the sculpted grid a single time and
        // never re-clobbers a terrain edit on a later reconcile pass.
        if (doc["terrain"] is JObject terr && (restoreOnce == null || restoreOnce.Add("\0terrain")))
        {
            try { TerrainBuilder.EnsureInstance().DeserializeState(terr.ToString(Formatting.None)); }
            catch (Exception e) { Debug.LogWarning($"[EditorState] terrain apply failed: {e.Message}"); }
        }

        // Scene style/player settings (sky / lighting / ground / speed / jump).
        if (doc["sceneSettings"] is JObject ss && (restoreOnce == null || restoreOnce.Add("\0sceneSettings")))
        {
            try { SceneSettings.FromJson(ss); SceneSettings.ApplyToScene(runner); }
            catch (Exception e) { Debug.LogWarning($"[EditorState] sceneSettings apply failed: {e.Message}"); }
        }

        var root = runner != null ? runner.GameRoot : null;
        if (root == null) return;

        if (!(doc["objects"] is JArray arr)) return;

        // Build a name→Transform lookup so a snapshot of N objects is O(N+M)
        // instead of O(N*M). Lua-created names are unique within a single
        // GameRoot run, so a single dictionary suffices.
        var lookup = new Dictionary<string, Transform>(root.childCount, StringComparer.Ordinal);
        for (int i = 0; i < root.childCount; i++)
        {
            var c = root.GetChild(i);
            if (c == null) continue;
            var nm = c.name ?? "";
            if (!string.IsNullOrEmpty(nm) && !lookup.ContainsKey(nm)) lookup.Add(nm, c);
        }

        int applied = 0, missing = 0;
        foreach (var node in arr)
        {
            if (!(node is JObject e)) continue;
            var name = (string)e["name"];
            if (string.IsNullOrEmpty(name)) continue;
            if (!lookup.TryGetValue(name, out var t) || t == null) { missing++; continue; }
            // Already restored once this load → leave it alone so a user edit survives.
            if (restoreOnce != null && !restoreOnce.Add(name)) continue;
            ApplyEntry(t, e);
            applied++;
        }

        // ── Deleted objects ──────────────────────────────────────────────────
        // Re-seed the session set from the snapshot (clear-then-add so a stale
        // entry from a prior game can't survive) and destroy any matching object
        // the script just re-created. Placed/added objects aren't tracked here —
        // they simply aren't in `added`, so they never come back.
        // Re-seed DeletedNames every pass (so a later Capture re-persists them),
        // but only DESTROY objects on the first pass — see DeletionsApplied. Each
        // destroy removes a single first-match per name; re-running across passes
        // would wipe out every same-named sibling, not just the deleted one.
        DeletedNames.Clear();
        if (doc["deleted"] is JArray del)
        {
            bool destroy = !DeletionsApplied;
            foreach (var dn in del)
            {
                var nm = (string)dn;
                if (string.IsNullOrEmpty(nm)) continue;
                DeletedNames.Add(nm);
                if (destroy && lookup.TryGetValue(nm, out var dt) && dt != null)
                {
                    UnityEngine.Object.Destroy(dt.gameObject);
                    lookup.Remove(nm);
                }
            }
            if (destroy) DeletionsApplied = true;
        }

        // ── Added objects ────────────────────────────────────────────────────
        // Re-spawn objects the user placed/duplicated that the script doesn't
        // create. Asset-backed recipes re-spawn asynchronously through the
        // runner (de-duped across the 3 apply passes); clone-of recipes clone a
        // live script object synchronously.
        if (doc["added"] is JArray addedArr)
        {
            foreach (var node in addedArr)
            {
                if (!(node is JObject e)) continue;
                var name = (string)e["name"];
                if (string.IsNullOrEmpty(name)) continue;

                // Already present (a previous apply pass re-spawned it) — refresh its
                // transform/settings/logic ONCE (restoreOnce), then never again so a
                // later user edit isn't reverted by a subsequent reconcile pass.
                if (lookup.TryGetValue(name, out var ex) && ex != null)
                {
                    if (restoreOnce == null || restoreOnce.Add(name)) ApplyEntry(ex, e);
                    continue;
                }

                var recipe   = e["recipe"] as JObject;
                string ckey  = recipe != null ? (string)recipe["cacheKey"] ?? "" : "";
                string clone = recipe != null ? (string)recipe["cloneOf"]  ?? "" : "";

                if (!string.IsNullOrEmpty(ckey) && runner != null)
                {
                    runner.RespawnEditorAsset(
                        name, ckey,
                        recipe != null ? (string)recipe["modelUrl"] ?? "" : "",
                        recipe != null && (recipe["isHumanoid"]?.Value<bool>() ?? false),
                        ReadVec(e["position"], Vector3.zero),
                        ReadVec(e["rotation"], Vector3.zero),
                        ReadVec(e["scale"],    Vector3.one),
                        e["settings"]?.ToString(Formatting.None) ?? "",
                        e["logic"]?.ToString(Formatting.None) ?? "");
                }
                else if (!string.IsNullOrEmpty(clone)
                         && lookup.TryGetValue(clone, out var src) && src != null)
                {
                    var go = UnityEngine.Object.Instantiate(src.gameObject, root);
                    go.name = name;
                    var mk = go.GetComponent<EditorPlacedObject>() ?? go.AddComponent<EditorPlacedObject>();
                    mk.cloneOf = clone; mk.cacheKey = ""; mk.modelUrl = ""; mk.isHumanoid = false;
                    ApplyEntry(go.transform, e);
                    lookup[name] = go.transform; // dedupe within this same pass
                    restoreOnce?.Add(name);      // applied at clone time — don't re-apply next pass
                }
            }
        }

        if (missing > 0)
            Debug.Log($"[EditorState] Apply: {applied} restored, {missing} objects not present in current scene (likely removed by a later AI edit).");
    }

    // ── ApplyExact ─────────────────────────────────────────────────────────────
    // Reconciling variant of Apply used by the editor's session undo/redo. Apply
    // is purely ADDITIVE (it restores / refreshes / respawns but never removes an
    // object the snapshot omits) which is right for the load path but wrong for
    // an undo: undoing a placement must DELETE the placed object, not leave it.
    // ApplyExact makes the live scene match the target snapshot for everything it
    // can do WITHOUT re-running the Lua script:
    //   • placed/added objects present in the scene but absent from the snapshot
    //     are destroyed (undo a drag-place / duplicate);
    //   • the snapshot's deletions are applied in-place;
    //   • terrain is reset to flat when the target carries no terrain key.
    // One thing it cannot do in-place: rehydrate a SCRIPT-created object the user
    // already deleted (DeleteSelected destroyed it outright). When the target
    // wants such an object back, ApplyExact returns "reload" so the caller can
    // re-run the script (which recreates it) and then Apply(json) on top. Returns
    // "ok" when the in-place revert is complete.
    public static string ApplyExact(LuauGameRunner runner, string json)
    {
        if (runner == null) runner = LuauGameRunner.Instance;
        if (string.IsNullOrWhiteSpace(json)) return "ok";

        JObject doc;
        try { doc = JObject.Parse(json); }
        catch (Exception e) { Debug.LogWarning($"[EditorState] ApplyExact: bad JSON: {e.Message}"); return "ok"; }

        // If any object the user currently has deleted is NOT deleted in the
        // target snapshot, the target wants it alive again — only a script re-run
        // can bring a deleted script object back, so defer to the reload path.
        var targetDeleted = new HashSet<string>(StringComparer.Ordinal);
        if (doc["deleted"] is JArray tdel)
            foreach (var dn in tdel) { var s = (string)dn; if (!string.IsNullOrEmpty(s)) targetDeleted.Add(s); }
        foreach (var cur in DeletedNames)
            if (!targetDeleted.Contains(cur)) return "reload";

        var root = runner != null ? runner.GameRoot : null;
        if (root == null) return "ok";

        // Destroy placed/added objects the target snapshot omits — they were added
        // AFTER this snapshot, so reverting to it removes them. (Destroy is
        // deferred to end-of-frame; the additive Apply below ignores them since
        // they're not named in the target's arrays.)
        var targetAdded = new HashSet<string>(StringComparer.Ordinal);
        if (doc["added"] is JArray tadd)
            foreach (var node in tadd)
                if (node is JObject e) { var nm = (string)e["name"]; if (!string.IsNullOrEmpty(nm)) targetAdded.Add(nm); }
        for (int i = root.childCount - 1; i >= 0; i--)
        {
            var child = root.GetChild(i);
            if (child == null) continue;
            if (child.GetComponent<EditorPlacedObject>() != null && !targetAdded.Contains(child.name))
                UnityEngine.Object.Destroy(child.gameObject);
        }

        // Run the additive applier for transforms / settings / logic / added
        // respawns / target deletions. Reset the once-per-session deletion gate so
        // a target that deletes a still-present object actually removes it here.
        DeletionsApplied = false;
        Apply(runner, json);

        // Reset the terrain grid when the target predates any terrain edit (Apply
        // only restores terrain when the key is present, never clears it).
        if (!(doc["terrain"] is JObject))
        {
            var tb = TerrainBuilder.Instance;
            if (tb != null && tb.Touched) tb.ResetTerrain(false);
        }

        // Reset scene settings when the target predates any style change (Apply
        // only restores sceneSettings when the key is present, never clears it —
        // so undoing a sky/lighting/ground/speed/jump edit would otherwise leave
        // the scene visually wrong). Only act when settings are currently
        // non-default to avoid an unnecessary SetBaseplateEnvironment call every
        // undo that touches plain object transforms.
        if (!(doc["sceneSettings"] is JObject) && !SceneSettings.IsDefault)
        {
            SceneSettings.Reset();
            SceneSettings.ApplyToScene(runner); // resets sky → SetBaseplateEnvironment; ground; speed; jump
        }

        return "ok";
    }

    // True once every object the snapshot placed (the `added` array — drag-placed
    // assets and duplicates) is present in the live scene by name. The load path
    // polls this so it can keep re-running the async re-spawn until the scene
    // actually matches the saved state, instead of firing a few fixed-delay
    // passes and giving up while a GLB spawn is still in flight (the reason
    // placed models could vanish on reopen while terrain — which restores
    // synchronously — always came back). Returns true when there's nothing to
    // place, false while the runner/root isn't ready yet (keep waiting).
    public static bool AddedAllPresent(LuauGameRunner runner, string json)
    {
        if (runner == null) runner = LuauGameRunner.Instance;
        if (string.IsNullOrWhiteSpace(json)) return true;

        JObject doc;
        try { doc = JObject.Parse(json); }
        catch { return true; }                       // unparseable → nothing to wait for

        if (!(doc["added"] is JArray added) || added.Count == 0) return true;

        var root = runner != null ? runner.GameRoot : null;
        if (root == null) return false;              // not ready — caller keeps polling

        var present = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < root.childCount; i++)
        {
            var c = root.GetChild(i);
            if (c != null && !string.IsNullOrEmpty(c.name)) present.Add(c.name);
        }
        foreach (var node in added)
        {
            if (!(node is JObject e)) continue;
            var name = (string)e["name"];
            if (!string.IsNullOrEmpty(name) && !present.Contains(name)) return false;
        }
        return true;
    }

    // Applies one captured entry (transform + settings + logic) onto a live
    // object. Shared by the script-object restore loop and the added-object
    // re-spawn paths so they can't drift.
    private static void ApplyEntry(Transform t, JObject e)
    {
        if (e["position"] is JArray p && p.Count == 3)
            t.localPosition = new Vector3(F(p[0]), F(p[1]), F(p[2]));
        if (e["rotation"] is JArray r && r.Count == 3)
            t.localEulerAngles = new Vector3(F(r[0]), F(r[1]), F(r[2]));
        if (e["scale"] is JArray s && s.Count == 3)
            t.localScale = new Vector3(F(s[0]), F(s[1]), F(s[2]));

        if (e["settings"] is JObject so)
        {
            var settings = t.GetComponent<EditorObjectSettings>();
            if (settings == null) settings = t.gameObject.AddComponent<EditorObjectSettings>();
            ApplySettings(settings, so);
        }

        if (e["logic"] is JObject lo)
        {
            var logic = t.GetComponent<EditorObjectLogic>();
            if (logic == null) logic = t.gameObject.AddComponent<EditorObjectLogic>();
            logic.Set(lo.ToString(Formatting.None));
        }

        // Editor was authored with this object's bottom resting on terrain —
        // keep that invariant after restore so a tweaked y-position doesn't sink
        // the model below the ground after the terrain itself shifts on reload.
        GameAssetLoader.SnapToTerrainIfBelow(t.gameObject);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static JArray Vec3ToArr(Vector3 v) => new JArray
    {
        Math.Round(v.x, 4),
        Math.Round(v.y, 4),
        Math.Round(v.z, 4),
    };

    private static float F(JToken tok)
    {
        if (tok == null) return 0f;
        if (tok.Type == JTokenType.Float || tok.Type == JTokenType.Integer) return (float)(double)tok;
        if (float.TryParse((string)tok, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) return v;
        return 0f;
    }

    private static Vector3 ReadVec(JToken tok, Vector3 fallback)
        => tok is JArray a && a.Count == 3 ? new Vector3(F(a[0]), F(a[1]), F(a[2])) : fallback;

    // ── Scene index ──────────────────────────────────────────────────────────
    // Everything the Variables pane in the workflow editor can put a name on:
    // each top-level object under GameRoot plus the child elements connected to
    // it (a door on a house, a wheel on a cart). Read-only — this never touches
    // the scene, and it is deliberately separate from Capture(), whose payload
    // is a persistence snapshot rather than a picker listing.
    //
    //   { "nodes": [ { "name": "Barn#e1", "placed": true, "parts": ["Door"] } ] }
    public static string ListSceneNodes(LuauGameRunner runner)
    {
        if (runner == null) runner = LuauGameRunner.Instance;
        var root = runner != null ? runner.GameRoot : null;
        var doc  = new JObject { ["nodes"] = new JArray() };
        if (root == null) return doc.ToString(Formatting.None);

        var arr   = (JArray)doc["nodes"];
        var seen  = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < root.childCount; i++)
        {
            var child = root.GetChild(i);
            if (child == null) continue;
            var name = child.name ?? "";
            if (string.IsNullOrEmpty(name)) continue;
            if (!seen.Add(name)) continue;

            var entry = new JObject
            {
                ["name"]   = name,
                ["placed"] = child.GetComponent<EditorPlacedObject>() != null,
            };
            var parts     = new JArray();
            var partNames = new HashSet<string>(StringComparer.Ordinal);
            CollectParts(child, parts, partNames, 0);
            if (parts.Count > 0) entry["parts"] = parts;
            arr.Add(entry);
        }
        return doc.ToString(Formatting.None);
    }

    private const int PartsMaxDepth = 3;
    private const int PartsMaxCount = 40;

    // Descends into an object's hierarchy collecting nameable elements. Nodes
    // whose names are glTF import scaffolding carry no meaning for a creator,
    // so they are skipped — but still descended through, because the meaningful
    // parts of a Meshy model hang underneath them.
    private static void CollectParts(Transform t, JArray into, HashSet<string> seen, int depth)
    {
        if (depth >= PartsMaxDepth || into.Count >= PartsMaxCount) return;
        for (int i = 0; i < t.childCount; i++)
        {
            var c = t.GetChild(i);
            if (c == null) continue;
            var n = c.name ?? "";
            if (!string.IsNullOrEmpty(n) && !IsImportScaffolding(n) && seen.Add(n))
            {
                if (into.Count >= PartsMaxCount) return;
                into.Add(n);
            }
            CollectParts(c, into, seen, depth + 1);
        }
    }

    private static readonly string[] ScaffoldingNames =
    {
        "Sketchfab_model", "RootNode", "GLTF_SceneRootNode", "Scene", "Armature", "root",
    };

    private static bool IsImportScaffolding(string n)
    {
        for (int i = 0; i < ScaffoldingNames.Length; i++)
            if (string.Equals(n, ScaffoldingNames[i], StringComparison.OrdinalIgnoreCase)) return true;
        // "Object_12", "mesh_3", "node0" and friends — importer-generated ids.
        int us = n.LastIndexOf('_');
        string stem = us > 0 ? n.Substring(0, us) : n.TrimEnd('0','1','2','3','4','5','6','7','8','9');
        string tail = us > 0 ? n.Substring(us + 1) : n.Substring(stem.Length);
        if (tail.Length > 0 && IsAllDigits(tail) &&
            (stem.Equals("Object", StringComparison.OrdinalIgnoreCase) ||
             stem.Equals("mesh",   StringComparison.OrdinalIgnoreCase) ||
             stem.Equals("node",   StringComparison.OrdinalIgnoreCase) ||
             stem.Equals("primitive", StringComparison.OrdinalIgnoreCase)))
            return true;
        return false;
    }

    private static bool IsAllDigits(string s)
    {
        for (int i = 0; i < s.Length; i++) if (s[i] < '0' || s[i] > '9') return false;
        return s.Length > 0;
    }

    // Per-object base entry: name + transform + (optional) settings + logic.
    // Shared by both the script-object and added-object capture paths.
    private static JObject BuildEntry(Transform child)
    {
        var entry = new JObject { ["name"] = child.name };
        entry["position"] = Vec3ToArr(child.localPosition);
        entry["rotation"] = Vec3ToArr(child.localEulerAngles);
        entry["scale"]    = Vec3ToArr(child.localScale);

        var settings = child.GetComponent<EditorObjectSettings>();
        if (settings != null) entry["settings"] = SettingsToJson(settings);

        var logic = child.GetComponent<EditorObjectLogic>();
        if (logic != null && !string.IsNullOrWhiteSpace(logic.GraphJson))
        {
            // Store the verbatim JSON React pushed so a round-trip never loses
            // data. JObject.Parse is tolerant of pretty / minified.
            try { entry["logic"] = JObject.Parse(logic.GraphJson); }
            catch { /* malformed — skip the logic field, keep the rest */ }
        }
        return entry;
    }

    // Stable, unique name for a user-added object (placed asset / duplicate) so
    // the snapshot can key it across reloads. Strips any prior "#eN" suffix so
    // duplicating a duplicate doesn't grow the name unbounded.
    public static string UniqueAddedName(string baseName, Transform parent)
    {
        string b = string.IsNullOrEmpty(baseName) ? "Object" : baseName;
        int h = b.IndexOf("#e", StringComparison.Ordinal);
        if (h >= 0) b = b.Substring(0, h);
        for (int n = 1; ; n++)
        {
            string cand = b + "#e" + n;
            // NOTE: must NOT use Transform.Find here — placed-asset names embed the
            // R2 cache key (e.g. "Model_game-assets/v1/<hash>.glb") which contains
            // '/', and Find interprets '/' as a child-path separator, so it never
            // matches the flat-named sibling and always returns "#e1". That made
            // every repeat placement of the same model collide on one name; the
            // capture's seenNames dedup then silently dropped all but the first, so
            // only one instance of each model ever persisted. Scan direct children
            // by exact name instead.
            if (FindDirectChildByName(parent, cand) == null) return cand;
        }
    }

    // Exact-name lookup over a transform's DIRECT children. Slash-safe replacement
    // for Transform.Find when the name may contain '/' (placed-asset cache keys).
    // Returns null when parent is null or no direct child has that exact name.
    public static Transform FindDirectChildByName(Transform parent, string name)
    {
        if (parent == null || string.IsNullOrEmpty(name)) return null;
        for (int i = 0; i < parent.childCount; i++)
        {
            var c = parent.GetChild(i);
            if (c != null && c.name == name) return c;
        }
        return null;
    }

    // Public JSON appliers used by LuauGameRunner's async asset re-spawn path
    // (the coroutine only has the captured JSON strings, not JObjects).
    public static void ApplySettingsJson(GameObject go, string settingsJson)
    {
        if (go == null || string.IsNullOrWhiteSpace(settingsJson)) return;
        try
        {
            var o = JObject.Parse(settingsJson);
            var s = go.GetComponent<EditorObjectSettings>() ?? go.AddComponent<EditorObjectSettings>();
            ApplySettings(s, o);
        }
        catch (Exception e) { Debug.LogWarning($"[EditorState] ApplySettingsJson failed: {e.Message}"); }
    }

    public static void ApplyLogicJson(GameObject go, string logicJson)
    {
        if (go == null || string.IsNullOrWhiteSpace(logicJson)) return;
        var l = go.GetComponent<EditorObjectLogic>() ?? go.AddComponent<EditorObjectLogic>();
        l.Set(logicJson);
    }

    // Mirror of EditorObjectSettings → JSON. Kept in this file (not on the
    // component) so the component stays a pure data sink without a hard
    // dependency on Newtonsoft.
    private static JObject SettingsToJson(EditorObjectSettings s)
    {
        return new JObject
        {
            ["destroyable"]        = s.destroyable,
            ["healthRegen"]        = s.healthRegen,
            ["infiniteLives"]      = s.infiniteLives,
            ["explode"]            = s.explode,
            ["healthPoints"]       = s.healthPoints,
            ["extraLives"]         = s.extraLives,
            ["invisible"]          = s.invisible,
            ["physics"]            = s.physics,
            ["weight"]             = s.weight,
            ["move"]               = s.move,
            ["horizontal"]         = s.horizontal,
            ["horizontalSpeed"]    = s.horizontalSpeed,
            ["horizontalDistance"] = s.horizontalDistance,
            ["vertical"]           = s.vertical,
            ["verticalSpeed"]      = s.verticalSpeed,
            ["verticalDistance"]   = s.verticalDistance,
        };
    }

    private static void ApplySettings(EditorObjectSettings s, JObject o)
    {
        // Pump every present field back through EditorObjectSettings.Set so
        // side-effects (invisible toggle re-disables renderers, terrain snap)
        // fire exactly as if React had pushed them one by one.
        foreach (var prop in o.Properties())
        {
            string val;
            switch (prop.Value.Type)
            {
                case JTokenType.Boolean: val = (bool)prop.Value ? "true" : "false"; break;
                case JTokenType.Integer:
                case JTokenType.Float:   val = ((double)prop.Value).ToString(CultureInfo.InvariantCulture); break;
                case JTokenType.Null:    val = "";  break;
                default:                 val = (string)prop.Value ?? ""; break;
            }
            s.Set(prop.Name, val);
        }
    }
}
