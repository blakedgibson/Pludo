using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

// Per-object workflow list authored in the React editor's Custom Logic panel.
// React owns the UI state and pushes the entire graph as a JSON blob through
// editorSetObjectLogic(name, graphJson); EditorCameraController.SetObjectLogic
// routes it to this component on the currently-selected GameObject so the
// workflows travel with the object (clone, save, etc.).
//
// Wire format (see CreateScreen.tsx — modeled on Bubble's Workflow tab):
//   { "workflows": [ {
//       "id", "name", "color", "enabled": true,
//       "event":  { "type": "<ConditionType>", "params": { … } },
//       "guards": [ { "id", "type", "negate": false, "params": { … } } ],
//       "steps":  [ { "id", "type": "<ActionType>", "params": { … },
//                     "guards": [ … ], "enabled": true } ]
//   } ] }
//
// The component is passive storage at the editor stage — the LuauGameRunner
// reads `Workflows` on each placed object when the player taps Play and
// compiles them into live behavior. Keeping it as raw structured data here
// means hot-edits in the panel show up the moment the user retries Play
// without a rebuild.
public class EditorObjectLogic : MonoBehaviour
{
    public string GraphJson { get; private set; } = "";
    public List<Workflow> Workflows { get; private set; } = new List<Workflow>();
    public List<LogicVar> Variables { get; private set; } = new List<LogicVar>();

    public void Set(string graphJson)
    {
        GraphJson = graphJson ?? "";
        // Tolerant parser — a malformed payload from React shouldn't blank out
        // the previously-stored workflows. Surface a warning and keep what we
        // had so the user doesn't silently lose work.
        if (string.IsNullOrWhiteSpace(GraphJson)) return;
        try
        {
            var root = JObject.Parse(GraphJson);
            Variables = ParseVariables(root["variables"]);

            if (root["workflows"] is JArray wfArr)
            {
                var parsed = new List<Workflow>(wfArr.Count);
                foreach (var w in wfArr)
                {
                    var wf = ParseWorkflow(w as JObject);
                    if (wf != null) parsed.Add(wf);
                }
                Workflows = parsed;
                return;
            }

            // Legacy { nodes: [...] } chain — one Execute root, AND-joined
            // conditions, then actions. Fold it into a single workflow: the
            // first condition is the event, the rest become its "Only when",
            // and every action becomes a step.
            if (root["nodes"] is JArray nodeArr)
            {
                var conditions = new List<JObject>();
                var actions    = new List<JObject>();
                foreach (var n in nodeArr)
                {
                    if (!(n is JObject o)) continue;
                    var kind = (string)o["kind"] ?? "";
                    if (kind == "condition") conditions.Add(o);
                    else if (kind == "action") actions.Add(o);
                }
                if (conditions.Count == 0 && actions.Count == 0) return;

                var wf = new Workflow { Id = "wf_legacy", Enabled = true };
                if (conditions.Count > 0)
                {
                    wf.EventType   = (string)conditions[0]["type"] ?? "gameStart";
                    wf.EventParams = ReadParams(conditions[0]["params"]);
                    for (int i = 1; i < conditions.Count; i++)
                    {
                        wf.Guards.Add(new Guard
                        {
                            Type   = (string)conditions[i]["type"] ?? "",
                            Params = ReadParams(conditions[i]["params"]),
                        });
                    }
                }
                foreach (var a in actions)
                {
                    wf.Steps.Add(new Step
                    {
                        Type    = (string)a["type"] ?? "",
                        Params  = ReadParams(a["params"]),
                        Enabled = true,
                    });
                }
                Workflows = new List<Workflow> { wf };
            }
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[EditorObjectLogic] Failed to parse graph for '{name}': {e.Message}");
        }
    }

    private static Workflow ParseWorkflow(JObject w)
    {
        if (w == null) return null;
        var ev = w["event"] as JObject;
        if (ev == null) return null;

        var wf = new Workflow
        {
            Id          = (string)w["id"]    ?? "",
            Name        = (string)w["name"]  ?? "",
            Color       = (string)w["color"] ?? "",
            Enabled     = w["enabled"] == null || (bool)w["enabled"],
            EventType   = (string)ev["type"] ?? "",
            EventParams = ReadParams(ev["params"]),
        };
        wf.Guards = ReadGuards(w["guards"]);

        if (w["steps"] is JArray steps)
        {
            foreach (var s in steps)
            {
                if (!(s is JObject so)) continue;
                wf.Steps.Add(new Step
                {
                    Id      = (string)so["id"]   ?? "",
                    Type    = (string)so["type"] ?? "",
                    Params  = ReadParams(so["params"]),
                    Guards  = ReadGuards(so["guards"]),
                    Enabled = so["enabled"] == null || (bool)so["enabled"],
                });
            }
        }
        return wf;
    }

    // Named handles a workflow field can reference as {{name}} — see
    // CreateScreen.tsx's LogicVariable. "Self" is implicit (never serialized)
    // and is injected separately by whatever reads Variables at runtime.
    private static List<LogicVar> ParseVariables(JToken tok)
    {
        var list = new List<LogicVar>();
        if (!(tok is JArray arr)) return list;
        foreach (var v in arr)
        {
            if (!(v is JObject vo)) continue;
            list.Add(new LogicVar
            {
                Id     = (string)vo["id"]     ?? "",
                Name   = (string)vo["name"]   ?? "",
                Source = (string)vo["source"] ?? "",
                Target = (string)vo["target"] ?? "",
                Owner  = (string)vo["owner"]  ?? "",
            });
        }
        return list;
    }

    private static List<Guard> ReadGuards(JToken tok)
    {
        var list = new List<Guard>();
        if (!(tok is JArray arr)) return list;
        foreach (var g in arr)
        {
            if (!(g is JObject go)) continue;
            list.Add(new Guard
            {
                Id     = (string)go["id"]   ?? "",
                Type   = (string)go["type"] ?? "",
                Negate = go["negate"] != null && (bool)go["negate"],
                Params = ReadParams(go["params"]),
            });
        }
        return list;
    }

    // React stores params as a Record<string,string>. Round-trip into a plain
    // dictionary so the Lua bridge / behavior compiler doesn't have to know
    // about JToken.
    private static Dictionary<string, string> ReadParams(JToken tok)
    {
        var dict = new Dictionary<string, string>();
        if (!(tok is JObject o)) return dict;
        foreach (var kv in o)
        {
            var v = kv.Value;
            dict[kv.Key] = v == null ? "" : v.ToString();
        }
        return dict;
    }

    // See React's LogicVariable — target is the object name / child element
    // name / HUD event name that was live in the editor when the creator
    // named it. Source "asset" is the only one workflow-step targets resolve
    // today; "part" and "interface" round-trip but aren't looked up yet.
    public class LogicVar
    {
        public string Id     = "";
        public string Name   = "";
        public string Source = "";
        public string Target = "";
        public string Owner  = "";
    }

    // An AND-joined "Only when" predicate on either an event or a single step.
    public class Guard
    {
        public string Id     = "";
        // See React's GUARD_CATALOG.
        public string Type   = "";
        public bool   Negate = false;
        public Dictionary<string, string> Params = new Dictionary<string, string>();
    }

    // One numbered action in a workflow. Disabled steps stay in the list and
    // are skipped at runtime.
    public class Step
    {
        public string Id      = "";
        // See React's ACTION_CATALOG.
        public string Type    = "";
        public bool   Enabled = true;
        public Dictionary<string, string> Params = new Dictionary<string, string>();
        public List<Guard> Guards = new List<Guard>();
    }

    // One event → steps chain. Disabled workflows never trigger.
    public class Workflow
    {
        public string Id      = "";
        public string Name    = "";
        public string Color   = "";
        public bool   Enabled = true;
        // See React's EVENT_CATALOG.
        public string EventType = "";
        public Dictionary<string, string> EventParams = new Dictionary<string, string>();
        public List<Guard> Guards = new List<Guard>();
        public List<Step>  Steps  = new List<Step>();
    }
}
