# Pludo Security Baseline

Living security documentation — update when controls change.

---

## MoonSharp Lua Sandbox

**Location:** `Assets/Scripts/LuauGameRunner.cs:305`  
**Mitigates:** Arbitrary code execution, filesystem access, process spawning from user-generated Lua scripts

The sandbox uses `CoreModules.Preset_SoftSandbox & ~CoreModules.Coroutine`.

**Excluded modules (blocked at runtime):**

| Module | Blocked APIs |
|--------|-------------|
| IO | `io.open`, `io.read`, `io.write`, `io.lines` |
| LoadMethods | `require`, `dofile`, `loadfile`, `load`, `loadstring` |
| Debug | `debug.getinfo`, `debug.sethook`, `debug.getupvalue` |
| Package | `package.loaded`, `package.path`, `package.preload` |
| Coroutine | `coroutine.create`, `coroutine.wrap`, `coroutine.resume` |
| OS (exec subset) | `os.execute`, `os.exit`, `os.remove`, `os.rename` |

**Included safe subset:**

- `os.time`, `os.clock`, `os.date` — time-only, no process control
- `math.*`, `string.*`, `table.*` — pure computation
- `Metatables` — `__index`, `__newindex` etc. (cannot reach blocked globals)

**Defence-in-depth layers:**

1. **Pre-execution scan** (`prompt-validation.ts:scanLuaScript`) — rejects scripts containing `os.*`, `io.*`, `require(`, `dofile(`, `loadfile(`, `load("`, `debug.*`, `package.*` before they are stored or run.
2. **Sandbox runtime** — MoonSharp nil's out all blocked globals at the Script level.
3. **10-second execution timeout** — `scriptThread.Join(10_000)` kills runaway scripts. Background daemon thread dies on app exit.
4. **No C# reflection access** — only `[MoonSharpUserData]`-annotated proxy classes with explicit registration are reachable from Lua.

---

## API Rate Limiting

**Location:** `api-server/src/index.ts` — `rateLimit()` middleware  
**Mitigates:** Claude/Meshy API cost abuse, AI endpoint flooding

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/forge-game` | 5 requests | 60 seconds per IP |
| `POST /api/edit-game` | 20 requests | 60 seconds per IP |

Over-limit responses: HTTP 429 with `Retry-After` header.

**Limitation:** In-memory only — resets on server restart. Replace with Redis-backed store before horizontal scaling.

---

## CORS Policy

**Location:** `api-server/src/index.ts` — `cors()` middleware  
**Mitigates:** Cross-site request forgery, credential theft via third-party websites

Allowed origins (explicit allowlist):
- `http://localhost:3000` — React dev server
- `http://localhost:4000` — same-origin
- `http://localhost:8080` — Unity WebGL preview
- Any origins in `ALLOWED_ORIGINS` environment variable (comma-separated)

Requests with no `Origin` header are allowed (Unity native app, server-to-server).  
Unknown origins receive HTTP 403.

---

## Security Headers

**Location:** `api-server/src/index.ts` — security headers middleware (applied before all routes)  
**Mitigates:** MIME sniffing, clickjacking, information disclosure, camera/mic access

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking via iframes |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Blocks sensor access |
| `X-Powered-By` | *removed* | Prevents framework fingerprinting |

---

## Input Validation Pipeline

**Location:** `api-server/src/prompt-validation.ts`  
**Mitigates:** Prompt injection, content policy violations, malformed Lua execution

Pipeline order for every `/api/forge-game` call:

1. **`validatePromptLength`** — rejects empty prompts and prompts over 2000 characters (HTTP 400)
2. **`filterContent`** — blocklist of CSAM, hate speech, extreme violence, real-person targeting patterns (HTTP 400)
3. Claude API call
4. **`scanLuaScript`** — rejects generated scripts containing dangerous Lua APIs (throws, game not stored)
5. **`validateManifest`** — enforces 3–6 asset count, drops malformed items
6. **`detectSystemPromptLeak`** — logs and flags if Claude echoes system prompt markers in output

---

## API Key Storage

**Location:** `api-server/.env` (gitignored)  
**Mitigates:** Credential exposure in source control and client bundles

| Key | Storage | In Server Logs | In API Responses | In React Bundle |
|-----|---------|----------------|------------------|-----------------|
| `ANTHROPIC_API_KEY` | `.env` only | Never | Never | Never |
| `MESHY_API_KEY` | `.env` only | Never | Never | Never |
| `SUPABASE_ANON_KEY` | `.env` + React bundle | Never | Never | Yes (by design) |
| Supabase service role | Not used | — | — | Never |

The Supabase anon key is intentionally present in the React bundle. It has read-only access gated by RLS policies. The service role key is never used in application code.

---

## WebSocket Security

**Location:** `api-server/src/index.ts` — WebSocket server configuration  
**Mitigates:** Memory exhaustion via oversized frames, DoS

- `maxPayload: 64 * 1024` (64 KB) on both `/api/ws` and `/api/game-ws` — frames larger than this are rejected at the network layer before application code runs.
- Chat messages truncated to 120 characters server-side before broadcast.
- Unknown WebSocket paths rejected with `socket.destroy()`.

---

## Dependency Security

Run `npm audit` in `api-server/` before every deployment. Current status: **0 vulnerabilities** (as of last audit).

Zero production dependencies with known CVEs. No `helmet`, `jsonwebtoken`, or other security-specific packages needed — controls are implemented directly.

---

## Manual Review Items

These controls exist but require human verification:

1. **RLS policy audit** — Confirm Supabase RLS on `forge_games` (and all other tables) blocks cross-user reads via the anon key. Test by calling Supabase REST directly without a user JWT and verifying only public rows are returned.

2. **Rate limiter for production** — Replace the in-memory rate limiter with a Redis-backed store before deploying multiple server instances.

3. ~~**Per-user Meshy concurrency**~~ — **FIXED**: `meshyPerIpCount` Map caps each IP at `PER_IP_MESHY_LIMIT = 2` concurrent Meshy tasks. Requests beyond that cap are rejected (asset skipped, returns empty URL) before the global semaphore is acquired. Location: `api-server/src/index.ts` — `meshyIpAcquire / meshyIpRelease` helpers and `resolveAsset(item, clientIp)`.
