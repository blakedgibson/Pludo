# Known MoonSharp / Luau Sanitizer Limitations

This document tracks cases where MoonSharp (Lua 5.2 interpreter) cannot execute
Luau/Roblox scripts without special handling, and how each is mitigated.

---

## 1. Infinite Loops

**Problem:** `while true do end` runs synchronously and hangs the Unity main thread.

**Mitigation:** `LuauGameRunner.RunScript` executes `DoString` on a background thread
and joins with a 10-second timeout. If the timeout fires, execution is aborted and a
`"Script error: timed out"` message is shown to the user.

**Known gap:** The background thread is leaked (not forcibly killed) — it runs until
the app exits or the Mono runtime reclaims it. MoonSharp does not expose a
step-interrupt hook that would allow clean cancellation.

---

## 2. Function-Type Annotations

**Problem:** Luau function types like `local f: (number) -> string` contain `(` after
the `:`, which the original identifier-based regex (`[A-Za-z_]...`) did not match.
These passed through unstripped and caused `SyntaxErrorException` in MoonSharp.

**Fix (2026-05-05):** Added a second annotation-stripping pass with regex:
```
\s*:\s*(?:\([^)\n]*\)\s*->\s*(?:\([^)\n]*\)|[^\n,)={]+)|\([^)\n]*\))(?=\s*[,)=\n{])
```
Covers: `(T) -> R`, `(T) -> (R1, R2)`, `(T) -> ()`, `() -> T`, and bare `(T, U)` tuple types.

**Known gap:** Function types with table return types (e.g., `(T) -> {string}`) are
not fully stripped because `{` is excluded from `[^\n,)={]+`. These are rare in
AI-generated code but can be handled by running the sanitizer a second time if needed.

---

## 3. Luau `continue` Statement

**Problem:** Standard Lua (and MoonSharp) has no `continue` keyword.

**Mitigation:** The sanitizer replaces `\bcontinue\b` with `--[[continue]]`. This means
the loop body finishes rather than jumping to the next iteration, which is semantically
wrong but prevents a parse/runtime error. For most AI-generated games this is acceptable.

---

## 4. Luau Type Assertions (`x :: Type`)

**Problem:** Luau supports `x :: Type` as a type assertion. MoonSharp parses `::` as a
label separator (Lua 5.2 `::label::`), which causes subtle parse errors.

**Current status:** Not yet handled by the sanitizer. If AI-generated scripts start
using `::`, add a regex pass: `\s*::\s*[A-Za-z_]\w*` → `""`.

---

## 5. Multi-Return Type Annotations After `->`

**Problem:** `function f(): (string, number)` — the tuple return type in parens passes
the sanitizer correctly because the function-type regex handles `\([^)\n]*\)` as the
return type. However, a bare `function f(): string, number` (no parens) uses the
identifier regex which only strips `string` and leaves `, number` dangling.

**Current status:** The `, number` would be interpreted as a trailing expression
statement `number`, which evaluates to nil in Lua — harmless but technically incorrect.
Does not cause a MoonSharp crash.

---

## 6. MoonSharp Lua 5.2 vs Luau Semantics

MoonSharp targets Lua 5.2. Key divergences from Luau:

| Feature | Luau | MoonSharp / Lua 5.2 |
|---|---|---|
| `continue` | keyword | not supported (replaced with comment) |
| Integer division `//` | supported | supported in Lua 5.3+; **not in MoonSharp** |
| Bitwise operators `&`, `\|`, `~`, `>>`, `<<` | supported | **not supported** (Lua 5.3+) |
| `string.split` | supported | not available |
| `buffer` library | supported | not available |
| Native types (`number` as int/float) | strict | unified `number` |

**Current workaround:** None for bitwise operators or `//`. If AI-generated scripts use
these, they will fail with `SyntaxErrorException`. Add a sanitizer pass or upgrade to
a Lua 5.3-compatible interpreter if this becomes a recurring issue.

---

## 7. `game:GetService()` Pattern

**Problem:** `game:GetService('Players')` — in the null-sink preamble, `game` is `__ns()`.
A method call `__ns():GetService('Players')` returns another `__ns()` (via `__call`),
which is then used as `Players`. This works silently. ✓

---

## 8. `os` and `io` Libraries

MoonSharp's `CoreModules.Preset_SoftSandbox` excludes `os`, `io`, `debug`, and `load*`
functions. This is intentional for security — Luau scripts cannot access the filesystem
or execute arbitrary code. Scripts that call `os.time()` or `io.open()` will receive
a `nil` global and likely throw a runtime error. Add specific safe wrappers if needed
(e.g., `os.time` can be bridged to `DateTimeOffset.UtcNow.ToUnixTimeSeconds()`).
