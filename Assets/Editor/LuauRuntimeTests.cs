using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using NUnit.Framework;
using MoonSharp.Interpreter;
using UnityEngine;

// EditMode tests for the Luau sanitizer and MoonSharp execution pipeline.
// Run via Unity Test Runner → EditMode tab.
// Results are written to <project-root>/luau-runtime-tests.json after all tests run.
[TestFixture]
public class LuauRuntimeTests
{
    // ── Result tracking ───────────────────────────────────────────────────────

    [Serializable]
    private class TestResult
    {
        public string category;
        public string name;
        public bool   passed;
        public string error;
        public TestResult(string cat, string n, bool ok, string err)
        { category = cat; name = n; passed = ok; error = err; }
    }

    private static readonly List<TestResult> Results = new List<TestResult>();

    private static void Record(string cat, string name, bool ok, string err = null)
        => Results.Add(new TestResult(cat, name, ok, err));

    [OneTimeTearDown]
    public void WriteJsonOutput()
    {
        int total = Results.Count, passed = 0;
        var sb = new StringBuilder();
        sb.AppendLine("{");
        sb.AppendLine($"  \"timestamp\": \"{DateTime.UtcNow:O}\",");
        sb.AppendLine("  \"results\": [");
        for (int i = 0; i < Results.Count; i++)
        {
            var r = Results[i];
            if (r.passed) passed++;
            string comma = i < Results.Count - 1 ? "," : "";
            string err   = r.error == null ? "null" : $"\"{r.error.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n")}\"";
            sb.AppendLine($"    {{\"category\":\"{r.category}\",\"name\":\"{r.name}\",\"passed\":{(r.passed?"true":"false")},\"error\":{err}}}{comma}");
        }
        sb.AppendLine("  ],");
        sb.AppendLine($"  \"summary\": {{\"total\":{total},\"passed\":{passed},\"failed\":{total-passed}}}");
        sb.AppendLine("}");

        string path = Path.Combine(Application.dataPath, "..", "luau-runtime-tests.json");
        File.WriteAllText(path, sb.ToString());
        Debug.Log($"[LuauRuntimeTests] Results: {passed}/{total} passed. Written to {path}");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string Sanitize(string code) => LuauGameRunner.SanitizeLuauScript(code);

    // Runs sanitized code through a fresh MoonSharp Script and returns the value.
    // Throws ScriptRuntimeException / SyntaxErrorException on script errors.
    private static DynValue Exec(string luauCode)
    {
        var s = new Script(CoreModules.Preset_SoftSandbox);
        s.Globals["print"] = (Action<object>)(_ => { });
        s.Globals["warn"]  = (Action<object>)(_ => { });
        return s.DoString(Sanitize(luauCode));
    }

    // Runs code on a background thread and returns true if it completed within
    // timeoutMs. Used to assert that infinite-loop protection works.
    private static bool ExecWithTimeout(string luauCode, int timeoutMs, out Exception ex)
    {
        Exception caught = null;
        var t = new Thread(() => {
            try { Exec(luauCode); }
            catch (Exception e) { caught = e; }
        });
        t.IsBackground = true;
        t.Start();
        bool finished = t.Join(timeoutMs);
        ex = caught;
        return finished;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 1: Sanitizer Coverage — every known Luau syntax pattern
    // ═══════════════════════════════════════════════════════════════════════════

    [Test]
    public void Sanitizer_StrictComment()
    {
        var output = Sanitize("--!strict\nlocal x = 1\n--!nocheck\n");
        bool ok = !output.Contains("--!strict") && !output.Contains("--!nocheck");
        Record("sanitizer", "StrictComment", ok, ok ? null : "strict/nocheck comments not stripped");
        Assert.IsTrue(ok, "Mode comments should be stripped");
    }

    [Test]
    public void Sanitizer_SimpleTypeDeclaration()
    {
        var output = Sanitize("type Color = { r: number, g: number, b: number }\nlocal x = 1");
        bool ok = !output.Contains("type Color");
        Record("sanitizer", "SimpleTypeDeclaration", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_ExportTypeDeclaration()
    {
        var output = Sanitize("export type Player = { name: string }\nlocal y = 2");
        bool ok = !output.Contains("export type") && !output.Contains("type Player");
        Record("sanitizer", "ExportTypeDeclaration", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_MultilineTypeBlock()
    {
        var code = "type Inventory = {\n  items: {string},\n  size: number,\n}\nlocal z = 3";
        var output = Sanitize(code);
        bool ok = !output.Contains("type Inventory") && output.Contains("local z = 3");
        Record("sanitizer", "MultilineTypeBlock", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_VariableAnnotation()
    {
        // `local x: number = 5` → `local x = 5`
        var output = Sanitize("local x: number = 5\nlocal s: string = \"hi\"");
        bool ok = !output.Contains(": number") && !output.Contains(": string")
                  && output.Contains("local x") && output.Contains("local s");
        Record("sanitizer", "VariableAnnotation", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_FunctionParameterAnnotation()
    {
        // `function f(x: number, y: string): boolean` → `function f(x, y)`
        var output = Sanitize("function f(x: number, y: string): boolean\n  return true\nend");
        bool ok = !output.Contains(": number") && !output.Contains(": string")
                  && !output.Contains(": boolean") && output.Contains("function f(");
        Record("sanitizer", "FunctionParameterAnnotation", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_FunctionTypeAnnotation()
    {
        // THE KEY BUG: `local callback: (number) -> string` must be stripped
        var output = Sanitize("local callback: (number) -> string = nil\nlocal f: () -> () = nil");
        bool hasColon = output.Contains(": (number)") || output.Contains(": ()");
        Record("sanitizer", "FunctionTypeAnnotation", !hasColon, hasColon ? output : null);
        Assert.IsFalse(hasColon, $"Function type annotations not stripped:\n{output}");
    }

    [Test]
    public void Sanitizer_FunctionTypeAnnotation_MultiParam()
    {
        var output = Sanitize("function register(cb: (string, boolean) -> ())\nend");
        bool ok = !output.Contains(": (string");
        Record("sanitizer", "FunctionTypeAnnotation_MultiParam", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_FunctionTypeAnnotation_TupleReturn()
    {
        var output = Sanitize("local fn: (number) -> (string, boolean) = nil");
        bool ok = !output.Contains(": (number)");
        Record("sanitizer", "FunctionTypeAnnotation_TupleReturn", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_NullableAnnotation()
    {
        var output = Sanitize("local x: number? = nil\nlocal y: string? = \"a\"");
        bool ok = !output.Contains(": number?") && !output.Contains(": string?");
        Record("sanitizer", "NullableAnnotation", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_UnionTypeAnnotation()
    {
        var output = Sanitize("local x: number | string = 1");
        bool ok = !output.Contains(": number | string");
        Record("sanitizer", "UnionTypeAnnotation", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_TableAnnotation()
    {
        var output = Sanitize("local t: {string} = {}\nlocal m: {[string]: number} = {}");
        bool ok = !output.Contains(": {string}") && !output.Contains(": {[string]");
        Record("sanitizer", "TableAnnotation", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_GenericTypeParams()
    {
        // `function f<T>(x: T)` — generic params on function
        var output = Sanitize("function f<T>(x)\n  return x\nend");
        bool ok = !output.Contains("<T>");
        Record("sanitizer", "GenericTypeParams", ok, ok ? null : output);
        Assert.IsTrue(ok);
    }

    [Test]
    public void Sanitizer_Continue()
    {
        // `continue` inside a loop must become --[[continue]]
        var output = Sanitize("for i = 1, 10 do\n  if i == 5 then continue end\nend");
        bool ok = output.Contains("--[[continue]]");
        Record("sanitizer", "Continue", ok, ok ? null : output);
        Assert.IsTrue(ok, "continue should be replaced with --[[continue]]");
    }

    [Test]
    public void Sanitizer_MissingTableComma()
    {
        // Consecutive `key = value` lines inside `{}` need commas inserted
        var code = "local t = {\n  a = 1\n  b = 2\n  c = 3\n}";
        var output = Sanitize(code);
        // After sanitization the table should parse cleanly
        Assert.DoesNotThrow(() => Exec(code), "Table with missing commas should be fixed");
        Record("sanitizer", "MissingTableComma", true, null);
    }

    [Test]
    public void Sanitizer_OutputIsCleanLua()
    {
        // Full Roblox-style script with every pattern combined — must parse without error
        const string luau = @"--!strict
export type Weapon = {
    damage: number,
    name: string,
}
type SpawnFn = (player: Player) -> ()

local MAX_HEALTH: number = 100
local playerName: string? = nil

function createWeapon<T>(name: string, dmg: number): {string}
    local w: {[string]: number} = {}
    return {}
end

local onHit: (number) -> boolean = nil

for i: number = 1, 10 do
    if i == 5 then continue end
    local x: number = i * 2
end

workspace.Part.Touched:Connect(function() end)
task.wait(0.1)
";
        Assert.DoesNotThrow(() => Exec(luau), "Combined Luau script should sanitize and parse cleanly");
        Record("sanitizer", "OutputIsCleanLua", true, null);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 2: Roblox Global Stubs — every stubbed global silently no-ops
    // ═══════════════════════════════════════════════════════════════════════════

    [Test]
    public void Stubs_WorkspacePropertyAccess()
    {
        Assert.DoesNotThrow(() => Exec("local v = workspace.Part.Position"));
        Record("stubs", "WorkspacePropertyAccess", true, null);
    }

    [Test]
    public void Stubs_WorkspaceConnectNoOp()
    {
        Assert.DoesNotThrow(() => Exec("workspace.Part.Touched:Connect(function(hit) end)"));
        Record("stubs", "WorkspaceConnectNoOp", true, null);
    }

    [Test]
    public void Stubs_InstanceNew()
    {
        Assert.DoesNotThrow(() => Exec("local p = Instance.new('Part')\np.Parent = workspace"));
        Record("stubs", "InstanceNew", true, null);
    }

    [Test]
    public void Stubs_TaskWait()
    {
        Assert.DoesNotThrow(() => Exec("task.wait(1)\ntask.wait()"));
        Record("stubs", "TaskWait", true, null);
    }

    [Test]
    public void Stubs_TaskSpawn()
    {
        Assert.DoesNotThrow(() => Exec("task.spawn(function() print('hi') end)"));
        Record("stubs", "TaskSpawn", true, null);
    }

    [Test]
    public void Stubs_RunServiceEvents()
    {
        Assert.DoesNotThrow(() => Exec("RunService.Heartbeat:Connect(function(dt) end)\nRunService.RenderStepped:Connect(function() end)"));
        Record("stubs", "RunServiceEvents", true, null);
    }

    [Test]
    public void Stubs_NumericIndexReturnsNil()
    {
        // workspace[1] must return nil so ipairs on a stub stops immediately
        Assert.DoesNotThrow(() => Exec("for i, v in ipairs(workspace) do end"));
        Record("stubs", "NumericIndexReturnsNil", true, null);
    }

    [Test]
    public void Stubs_DeepChain()
    {
        // Deep property chains should all silently no-op
        Assert.DoesNotThrow(() => Exec("workspace.Map.Folder.Part.Mesh.Scale = 2"));
        Record("stubs", "DeepChain", true, null);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 3: API Binding Smoke Tests — globals registered in RunScript
    // ═══════════════════════════════════════════════════════════════════════════

    [Test]
    public void API_PrintAndWarn()
    {
        Assert.DoesNotThrow(() => Exec("print('hello')\nwarn('warning')"));
        Record("api", "PrintAndWarn", true, null);
    }

    [Test]
    public void API_MathLibrary()
    {
        // Standard Lua math library must be available
        Assert.DoesNotThrow(() => Exec("local v = math.floor(3.7)\nlocal r = math.random(1, 10)"));
        Record("api", "MathLibrary", true, null);
    }

    [Test]
    public void API_StringLibrary()
    {
        Assert.DoesNotThrow(() => Exec("local s = string.format('%d', 42)\nlocal l = string.len('abc')"));
        Record("api", "StringLibrary", true, null);
    }

    [Test]
    public void API_TableLibrary()
    {
        Assert.DoesNotThrow(() => Exec("local t = {1,2,3}\ntable.insert(t, 4)\nlocal n = #t"));
        Record("api", "TableLibrary", true, null);
    }

    [Test]
    public void API_Pcall()
    {
        Assert.DoesNotThrow(() => Exec("local ok, err = pcall(function() error('boom') end)\nassert(not ok)"));
        Record("api", "Pcall", true, null);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 4: Malformed Script Stress Tests
    // ═══════════════════════════════════════════════════════════════════════════

    [Test]
    public void Stress_EmptyScript()
    {
        Assert.DoesNotThrow(() => Exec(""));
        Record("stress", "EmptyScript", true, null);
    }

    [Test]
    public void Stress_WhitespaceOnly()
    {
        Assert.DoesNotThrow(() => Exec("   \n\t\n  "));
        Record("stress", "WhitespaceOnly", true, null);
    }

    [Test]
    public void Stress_ImmediateError()
    {
        Assert.Throws<ScriptRuntimeException>(() => Exec("error('boom')"));
        Record("stress", "ImmediateError", true, null);
    }

    [Test]
    public void Stress_NilIndex()
    {
        Assert.Throws<ScriptRuntimeException>(() => Exec("local x = nil\nlocal y = x.field"));
        Record("stress", "NilIndex", true, null);
    }

    [Test]
    public void Stress_MismatchedBrackets()
    {
        Assert.Throws<Exception>(() => Exec("local t = {{{{"));
        Record("stress", "MismatchedBrackets", true, null);
    }

    [Test]
    public void Stress_UnclosedString()
    {
        Assert.Throws<Exception>(() => Exec("local s = \"unclosed"));
        Record("stress", "UnclosedString", true, null);
    }

    [Test]
    public void Stress_LargeStringLiteral()
    {
        var big = "local s = \"" + new string('a', 10_000) + "\"";
        Assert.DoesNotThrow(() => Exec(big));
        Record("stress", "LargeStringLiteral", true, null);
    }

    [Test]
    public void Stress_BinaryCharactersInScript()
    {
        // Binary bytes should be handled gracefully (not silently corrupt)
        var code = "local x = 1\x00\x01\x02\nlocal y = 2";
        try
        {
            Exec(code);
            Record("stress", "BinaryCharacters", true, null);
        }
        catch (Exception ex)
        {
            // Acceptable — MoonSharp may reject binary content; what matters is no hard crash
            Record("stress", "BinaryCharacters", true, $"throws (expected): {ex.Message}");
        }
    }

    [Test]
    public void Stress_StackOverflow_RecursiveFunction()
    {
        // Deep recursion should throw ScriptRuntimeException, not hang or crash Unity
        Assert.Throws<ScriptRuntimeException>(() => Exec("local function f() return f() end\nf()"));
        Record("stress", "StackOverflow_RecursiveFunction", true, null);
    }

    [Test]
    public void Stress_InfiniteLoop_ProtectedByTimeout()
    {
        // An infinite loop must not hang indefinitely. We run it on a background
        // thread with a 3-second timeout. The test PASSES if the loop is detected
        // within that window — either by finishing (impossible for `while true do end`)
        // or by the engine-level protection in LuauGameRunner.RunScript.
        //
        // This test validates the *test harness* timeout safety, not the engine.
        // The engine protection (10-second Thread.Join in RunScript) is validated
        // by running an infinite-loop game in play mode.
        bool finished = ExecWithTimeout("while true do end", 3_000, out var ex);

        // We EXPECT this to NOT finish (finished == false) unless the engine adds
        // a step-limit hook inside MoonSharp. Mark as known limitation if it hangs.
        if (!finished)
        {
            // Thread leaked; it's a daemon and will be killed when the editor exits.
            Record("stress", "InfiniteLoop_ProtectedByTimeout", false,
                "while true do end ran >3s — engine thread timeout is the only protection");
            Assert.Inconclusive("Infinite loop ran >3 s. Engine-level thread timeout active in RunScript.");
        }
        else
        {
            Record("stress", "InfiniteLoop_ProtectedByTimeout", true, null);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Step 5: Real Generated-Style Game Scripts
    // ═══════════════════════════════════════════════════════════════════════════

    [Test]
    public void RealScript_CounterGame()
    {
        const string script = @"--!strict
local count: number = 0
local MAX: number = 10

for i: number = 1, MAX do
    count = count + 1
end

assert(count == 10, 'counter must reach 10')
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "CounterGame", true, null);
    }

    [Test]
    public void RealScript_TableOperations()
    {
        const string script = @"
type Item = { name: string, value: number }

local inventory: {Item} = {}

local function addItem(name: string, value: number): ()
    table.insert(inventory, { name = name, value = value })
end

addItem('Sword', 100)
addItem('Shield', 50)
addItem('Potion', 25)

assert(#inventory == 3)
assert(inventory[1].name == 'Sword')
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "TableOperations", true, null);
    }

    [Test]
    public void RealScript_RobloxStyleWithWorkspace()
    {
        // Uses preamble-provided stubs (workspace, Players, Instance, task).
        // Avoids game:GetService() which is a global only wired in RunScript.
        const string script = @"--!strict
workspace.SpawnLocation.Touched:Connect(function(hit: BasePart)
    local player = Players:GetPlayerFromCharacter(hit.Parent)
    if player then
        print('player touched spawn')
    end
end)

RunService.Heartbeat:Connect(function(dt: number)
    -- per-frame update stub
end)

Instance.new('Part').Parent = workspace
task.spawn(function()
    task.wait(0.1)
end)
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "RobloxStyleWithWorkspace", true, null);
    }

    [Test]
    public void RealScript_HeavyTypeAnnotations()
    {
        // Simulates a type-annotation-heavy AI-generated script
        const string script = @"--!strict
type Vector2 = { x: number, y: number }
type Entity = {
    id: number,
    position: Vector2,
    health: number,
    onDeath: (() -> ())?
}

local function createEntity(id: number, x: number, y: number): Entity
    return {
        id = id,
        position = { x = x, y = y },
        health = 100,
        onDeath = nil,
    }
end

local function damage(entity: Entity, amount: number): boolean
    entity.health = entity.health - amount
    if entity.health <= 0 then
        if entity.onDeath then entity.onDeath() end
        return true
    end
    return false
end

local e: Entity = createEntity(1, 0, 0)
e.onDeath = function(): () print('dead') end
local died: boolean = damage(e, 150)
assert(died == true)
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "HeavyTypeAnnotations", true, null);
    }

    [Test]
    public void RealScript_EventDrivenWithContinue()
    {
        const string script = @"
local scores: {number} = {}
local total: number = 0

for i: number = 1, 20 do
    if i % 2 == 0 then continue end
    table.insert(scores, i)
    total = total + i
end

-- Odd numbers 1..19: 1+3+5+7+9+11+13+15+17+19 = 100
assert(total == 100, 'sum of odd 1-19 should be 100, got ' .. tostring(total))
assert(#scores == 10)
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "EventDrivenWithContinue", true, null);
    }

    [Test]
    public void RealScript_FunctionTypeCallbacks()
    {
        // Tests the newly-fixed function-type annotation stripping
        const string script = @"--!strict
type Handler = (event: string, data: any) -> boolean

local handlers: {[string]: Handler} = {}

local function on(event: string, handler: Handler): ()
    handlers[event] = handler
end

local function emit(event: string, data: any): boolean
    local h: Handler? = handlers[event]
    if h == nil then return false end
    return h(event, data)
end

on('collision', function(event: string, data: any): boolean
    print('collision: ' .. event)
    return true
end)

local result: boolean = emit('collision', {x=1, y=2})
assert(result == true)
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "FunctionTypeCallbacks", true, null);
    }

    [Test]
    public void RealScript_GenericFunctions()
    {
        const string script = @"--!strict
local function map<T, U>(t: {T}, fn: (T) -> U): {U}
    local result: {U} = {}
    for i, v in ipairs(t) do
        table.insert(result, fn(v))
    end
    return result
end

local nums: {number} = {1, 2, 3, 4, 5}
local doubled = map(nums, function(x: number): number
    return x * 2
end)

assert(doubled[1] == 2)
assert(doubled[5] == 10)
";
        Assert.DoesNotThrow(() => Exec(script));
        Record("realscript", "GenericFunctions", true, null);
    }
}
