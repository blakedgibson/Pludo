# Job Persistence Architecture

How game generation jobs survive navigation in the Pludo React/Unity UI.

---

## The Problem

Game generation is a long-running async operation (30 seconds to several minutes). The React UI in Pludo is mounted/unmounted aggressively:

- `App.tsx` renders `{tab === 2 && <CreateScreen />}` — switching tabs unmounts CreateScreen and **destroys all component state**.
- Inside CreateScreen, pressing "back" from the editor unmounts `EditorScreen`, stopping its polling `useEffect`.
- Force-killing the app clears all in-memory state entirely.

Without persistence, a job ID tracked only in `useState` is lost the moment the component unmounts.

---

## The Solution: Two-Layer Persistence

### Layer 1 — Module-Level Cache (client process lifetime)

```typescript
// react/src/screens/CreateScreen.tsx — outside the component
const _jobCache = new Map<number, string>(); // gameId → jobId
```

This Map lives at the JavaScript module scope. It **survives React component unmounts** caused by tab switches, back navigation, and re-renders. It is lost only when the app process itself dies (force-kill or OS eviction after long backgrounding).

**Write path:** `forge()` calls `_jobCache.set(gameId, jobId)` immediately after receiving the server response.

**Read path:** The prompt-phase polling effect reads `_jobCache.entries()` on every tick.

**Cleanup:** When a job reaches `done` or `error`, the polling effect calls `_jobCache.delete(gameId)`. `onBuildComplete` also deletes on successful EditorScreen completion.

### Layer 2 — Server Reverse Lookup (server process lifetime)

```typescript
// api-server/src/index.ts
const gameIdToJobId = new Map<number, string>(); // gameId → jobId
```

This Map on the server lets clients **recover a jobId after app relaunch** when Layer 1 is empty.

**Endpoint:** `GET /api/forge-game/find-by-game/:gameId`
- Returns `{ found: true, jobId, status }` if the job is still alive within its 45-min TTL.
- Returns `{ found: false }` if the job has expired or never existed.

**Write path:** In `POST /api/forge-game`, after `jobs.set(jobId, ...)`, also `gameIdToJobId.set(gameId, jobId)`.

**Cleanup:** The TTL cleanup interval (`setInterval` every 10 min) deletes from `gameIdToJobId` when it expires a job that has a `gameId` field.

---

## The Polling Architecture

There are **two independent polling loops**, each with a different scope:

### EditorScreen Polling (rich in-editor UX)

- **Location:** `useEffect([buildJobId])` inside `EditorScreen`
- **Interval:** 2500ms
- **Purpose:** Drive the live build chat (BUILD_STEPS messages, asset counter, partial Luau preview)
- **Lifetime:** Alive only while `EditorScreen` is mounted (user is watching the build)
- **Cleanup:** `return () => { clearInterval(stepTimer); clearInterval(partialTimer); clearInterval(pollTimer); }`

This loop is intentionally short-lived — it exists to give the user a rich real-time experience, not to guarantee persistence.

### Prompt-Phase Polling (background persistence)

- **Location:** `useEffect([phase])` inside `CreateScreen`
- **Interval:** 3000ms (with exponential backoff on network errors, max 30s)
- **Purpose:** Track all in-progress jobs when the user is NOT in the editor. Update `myGames` cards live.
- **Lifetime:** Alive whenever `phase === 'prompt'` AND `CreateScreen` is mounted
- **Cleanup:** `return () => clearInterval(interval)`

This loop reads directly from `_jobCache`, so it sees jobs that were started in the current session even if the user has navigated back from the editor.

---

## Navigation Scenarios

### 1. Back Button During Generation

```
User presses back in EditorScreen
→ onBack() fires: setPhase('prompt'); setActiveGame(null); loadMyGames()
   ❌ NO longer: setBuildJobId('')   (this was the original bug)
→ EditorScreen unmounts, its polling stops
→ CreateScreen stays mounted, phase becomes 'prompt'
→ Prompt-phase polling effect re-runs (phase changed)
→ Reads _jobCache which still has {gameId: jobId}
→ Polls /api/forge-game/status/:jobId every 3s
→ When done: updates myGames card, deletes from _jobCache
```

### 2. Tab Switch During Generation

```
User switches to another tab
→ App.tsx: tab changes, {tab === 2 && <CreateScreen/>} unmounts CreateScreen
→ All useState (buildJobId, myGames, etc.) destroyed
→ _jobCache still has {gameId: jobId} (module-level, survives)
→ User switches back to Create tab
→ CreateScreen remounts, useEffect([]) runs loadMyGames()
→ loadMyGames: fetches Supabase, finds hasCode=false games
→ For each: checks _jobCache first; if found, skips server roundtrip
→ phase === 'prompt', prompt-phase polling starts, resumes tracking
```

### 3. App Relaunch (Kill + Restart)

```
App is killed
→ All process memory gone: _jobCache empty, all React state gone
→ App relaunches, CreateScreen mounts
→ loadMyGames() fetches Supabase — returns game with hasCode=false
→ _jobCache.has(gameId) is false (empty after relaunch)
→ Calls GET /api/forge-game/find-by-game/:gameId
→ If server job still alive (within 45-min TTL): returns jobId
→ _jobCache.set(gameId, jobId)
→ Prompt-phase polling picks it up and resumes tracking
→ If server job expired: game stays as hasCode=false until user retries
```

### 4. Multiple Concurrent Jobs

```
User starts Job A (gameId=10), then Job B (gameId=11)
→ _jobCache: { 10: 'uuid-a', 11: 'uuid-b' }
→ Prompt-phase polling: for...of _jobCache iterates both entries
→ Each game's card updates independently
→ Job A completes first: _jobCache.delete(10), card updated to hasCode=true
→ Job B continues: its card stays 'Generating...'
```

---

## State Machine

```
Client Phase        Server Job Status     Card Display
─────────────────────────────────────────────────────
'editing' (active)  pending               Building... (EditorScreen chat)
'editing' (active)  script_ready          Chat shows asset counter
'editing' (active)  done                  Chat shows "ready!", onBuildComplete fires
'prompt'            pending               "Generating..." (orange border)  [NEW]
'prompt'            script_ready          "Generating..." → hasCode=true   [NEW]
'prompt'            done                  hasCode=true, title/genre updated [NEW]
'prompt'            error                 Description shows error in red    [NEW]
'prompt'            timeout (5min)        "Generation timed out"           [NEW]
Any                 (job not found)       Card stays at last known state; loadMyGames cleanup on next mount
```

---

## Supabase as Ground Truth

Supabase is the authoritative record. The client polling stack is a delivery layer on top:

| Data                      | Source of Truth | Client Cache     |
|---------------------------|-----------------|------------------|
| Game list, title, genre   | Supabase        | myGames useState |
| game_code present         | Supabase        | hasCode boolean  |
| Job in-progress           | Server in-memory| _jobCache        |
| Job ID for a given game   | Server reverse map | _jobCache     |
| Asset URLs                | Supabase + R2   | assetUrlsJson    |

On every CreateScreen mount, `loadMyGames()` fetches from Supabase and overwrites `myGames`. Local state is always treated as a cache, never as a source of truth for display.

---

## What This Does NOT Cover

- **Server restart during generation:** If the API server restarts, all in-memory jobs are lost. The `find-by-game` endpoint returns `{ found: false }`. The game stays as `hasCode=false` with no automatic recovery. Server-side job persistence (to a database or Redis) would be needed to handle this.
- **True exponential backoff:** The current implementation doubles `retryDelay` on network errors but the `setInterval` itself is fixed at 3s. A proper implementation would use `setTimeout` recursively to achieve true dynamic intervals.
- **Server-side job timeout:** Pending jobs are evicted from the server's in-memory store after 45 minutes, but they are not marked as `error` in Supabase. A server-side cron that marks stale `forge_games` rows as failed would improve the UX after very long server-side failures.
- **Deep links / URL-based routing:** Pludo uses tab-based navigation without URLs. Deep linking is not applicable.

---

## Regression Prevention

To prevent these bugs from recurring:

1. **Never store a job ID in component `useState` only.** Always mirror it to `_jobCache` immediately in the same synchronous call.
2. **Never clear `buildJobId` in `onBack`.** The prompt-phase polling loop is the cleanup mechanism; `onBack` only changes the visual phase.
3. **Always return a cleanup function from polling `useEffect` hooks.** Every `setInterval` must have a corresponding `clearInterval` in the cleanup.
4. **The prompt-phase polling effect is the canonical loop** for background job tracking. Do not add a second loop elsewhere; that creates double-polling and potential state conflicts.
5. **Supabase refetch on every CreateScreen mount is intentional.** Do not add a `if (myGames.length > 0) return` guard or similar optimization — stale state is a worse UX than an extra HTTP request.
