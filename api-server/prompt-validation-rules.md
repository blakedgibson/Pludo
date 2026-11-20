# Prompt Validation Rules — `/api/forge-game`

Server-side validation runs in this fixed order. A failure at any step returns immediately without proceeding to the next step.

---

## Rule 1 — Length Validation (`validatePromptLength`)

**File:** `src/prompt-validation.ts` → `validatePromptLength()`  
**Runs:** Before any DB insert, Claude call, or Meshy credit spend.

| Check | Threshold | Response |
|-------|-----------|----------|
| Too few non-whitespace characters | `< 3` non-WS chars | HTTP 400 — "Prompt is too short..." |
| Too many total characters | `> 2000` chars | HTTP 400 — "Prompt is too long (N chars)..." |

**Notes:**
- Whitespace (spaces, tabs, newlines, Unicode whitespace like `　`) is stripped before the minimum check.
- The max check operates on the raw total character count, not stripped.
- Non-printable chars and Unicode non-WS code points count toward the minimum. A prompt of 3 emoji characters passes.

---

## Rule 2 — Content Filter (`filterContent`)

**File:** `src/prompt-validation.ts` → `filterContent()`  
**Runs:** Immediately after length validation, still before DB insert.

Regex blocklist with word-boundary anchors (`\b`). All patterns are case-insensitive.

| Category | Example triggers | Note |
|----------|-----------------|------|
| Sexual violence / CSAM | rape, sexual assault, child porn, cp, loli | Plural and singular |
| Profanity | fuck, shit, cock, pussy, cunt, dick, bitch, asshole | Common profanity |
| Hate speech | nigger/niggers/nigga/niggas, faggot/faggots, tranny/trannies, kike, spic, chink, wetback, gook | Plural forms included |
| Extreme violence | genocide, ethnic cleansing, mass murder, torture porn | Phrase-level patterns |
| Real-person targeting | "kill [trump|biden|obama|putin|musk|zuckerberg|elon]" | Named public figures |

**On match:** HTTP 400 — "This prompt violates our usage policy."  
**On pass:** Request proceeds to template scoring and Claude call.

**Intentional gaps (handled by Claude's own guardrails):**
- Borderline content (gore, violence without slurs, gambling) is not blocked server-side.
- Non-English equivalents of blocked terms are not matched (English keyword list only).

---

## Rule 3 — Template Scoring (Observability)

**File:** `src/game-templates.ts` → `scoreTemplates()`  
**Runs:** After content filter passes, before Claude call.

This step does not reject requests. It scores the prompt against all known game templates and logs the results for observability.

**Scoring:**
- Multi-word keyword match: +3 points
- Single-word keyword match: +1 point
- Highest-scoring template with score ≥ 1 is selected via `selectTemplate()`
- If all scores = 0: `null` is returned → Claude receives a freeform (no-scaffold) prompt

**Available genres:** platformer, strategy (tower-defense), survival, simulation, racer, puzzle, adventure

**Template selection behavior:**
- Selection is deterministic for any given input string.
- Non-English prompts always fall through to freeform (keywords are English-only).
- Template affects the Lua scaffold injected into the system prompt; freeform gives Claude full creative latitude.

---

## Rule 4 — Claude API Call

**File:** `src/index.ts` → `runForgeGame()`  
**Runs:** After template scoring.

Claude receives the user prompt and a system prompt that includes:
- The Luau game API specification
- The selected template scaffold (or freeform instructions)
- Mandatory constraints (at least one player entity, at least one win condition, 3–6 assets)

Claude returns a JSON object with `reply`, `luau_script`, and `asset_manifest` fields.

If Claude returns invalid JSON or the API call fails, the request returns HTTP 500.

---

## Rule 5 — System Prompt Leak Detection (`detectSystemPromptLeak`)

**File:** `src/prompt-validation.ts` → `detectSystemPromptLeak()`  
**Runs:** On Claude's raw response text, before parsing.

Checks for known marker strings that would indicate Claude is echoing its own system prompt:

- `"You are Pludo"`
- `"LUAU_FORGE_SYSTEM"`
- `"MoonSharp Luau sandbox"`
- `"MANDATORY: every game MUST have"`

**On match:** Logs a security warning. The response is still processed (detection is non-blocking), but the incident is surfaced in server logs for review.

---

## Rule 6 — Lua Script Security Scan (`scanLuaScript`)

**File:** `src/prompt-validation.ts` → `scanLuaScript()`  
**Runs:** After Claude's response is parsed, on the `luau_script` field, before any DB write or hot-reload.

Scans for dangerous Lua patterns using regex:

| Pattern | Label | Rationale |
|---------|-------|-----------|
| `\bos\s*\.\s*\w+` | `os.*` | OS-level access (execute, exit, etc.) |
| `\bio\s*\.\s*\w+` | `io.*` | File system access |
| `\brequire\s*\(` | `require()` | Module loading |
| `\bdofile\s*\(` | `dofile()` | Execute external file |
| `\bloadfile\s*\(` | `loadfile()` | Load external file |
| `\bload\s*\(\s*['"]` | `load(string)` | Dynamic code execution from string literal |
| `\bdebug\s*\.\s*\w+` | `debug.*` | Lua debug library (hook injection, etc.) |
| `\bpackage\s*\.\s*\w+` | `package.*` | Package/library loading |

**On match:** HTTP 500 — generation rejected. Violations are listed in server logs as a security event.  
**On pass:** Script is stored in DB and sent to the game room for hot-reload.

**Defense-in-depth note:** The wasmoon Lua runtime also `nil`s out these globals at runtime (`os=nil;io=nil;...`). The server-side scan is an additional layer that detects and rejects rather than silently neutralising.

---

## Rule 7 — Manifest Hard Validation (`validateManifest`)

**File:** `src/prompt-validation.ts` → `validateManifest()`  
**Runs:** After the Lua script scan passes, on the `asset_manifest` field.

**Shape validation:** Each item must have:
- `id`: non-empty string
- `prompt`: string (any value)
- `is_humanoid`: boolean

Items failing shape validation are silently dropped and counted. There is no upper cap on valid items — the Meshy semaphore (10 concurrent slots) naturally rate-limits asset generation for very large manifests.

**Count enforcement:**

| Condition | Action |
|-----------|--------|
| `< 3` valid items | Warning logged; game uses primitive placeholders |
| 0 valid items | Warning logged; game runs with no 3D assets |

**Warnings are non-blocking** — the game is still stored and started even if the manifest is smaller than expected. The warnings are returned to the caller in the response body's `warnings` array.

---

## Summary Table

| Step | Function | Blocking? | HTTP code on failure |
|------|----------|-----------|----------------------|
| 1 | `validatePromptLength` | Yes | 400 |
| 2 | `filterContent` | Yes | 400 |
| 3 | `scoreTemplates` / `selectTemplate` | No (logging only) | — |
| 4 | Claude API call | Yes (on error) | 500 |
| 5 | `detectSystemPromptLeak` | No (logging only) | — |
| 6 | `scanLuaScript` | Yes | 500 |
| 7 | `validateManifest` | Partial (drops items, warns) | — |
