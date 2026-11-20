# Apple-Maps-Feel Camera for the Pludo Editor

**Status:** Phase 1 greenlit. Phases 2–5 sequenced.
**Primary file:** `Assets/Scripts/Game/EditorCameraController.cs`
**Last updated:** 2026-05-18

---

## Goal

Make the editor preview camera feel "exactly like" Apple Maps:

1. **Instant 1:1 tracking** — the world point under your fingertip is glued to your fingertip during touch, with zero easing.
2. **Exponential decay on release** — flick-and-glide with a characteristic ~1.5 s ease-out, not linear.
3. **Gesture-midpoint anchoring** — pinch, twist, and tilt all happen around the world point that was under the touch midpoint at gesture start.
4. **Rubber-band boundaries** — soft resistance + spring-back at world / pitch / distance limits, never hard walls.
5. **Compounding gestures** — pinch, twist, tilt, and pan all apply in parallel from a single two-finger interaction.

---

## Current state (as of the audit)

`EditorCameraController.cs` is a single-file orbital camera (pitch / yaw / dist / pivot) attached to `Camera.main` only in preview mode (`LuauGameRunner.cs:1687–1694`). Touch flows through `HandleInput()`, gated by `SheetDragging` and `TerrainModeActive` (9 setters across C# + React). Two-finger input uses a **single-gesture lock** — once a session decides Pinch / Twist / Tilt, only that one applies. Each axis has its own inertia velocity with framerate-independent exponential damping. All gestures pivot around `_pivot` (the look-at point), not around the gesture midpoint. No anchor system. No rubber-banding.

## Gap analysis vs. Apple Maps

| Apple Maps behavior | Today | Gap |
|---|---|---|
| 1:1 finger tracking | pixel delta × `_dist × 0.007` (approximate) | **Big** — needs anchor-to-finger |
| Exponential decay on release | ✓ `Pow(0.92, dt*60)` | polish: 100 ms sample window + snap-to-rest |
| Velocity floor / snap to rest | asymptotic only | small but real — discrete cutoff |
| Tap during glide = dead stop | ✓ `KillVelocities()` on touch begin | needs anchor recapture on touch-during-glide |
| Midpoint anchor for pinch | rotates around `_pivot`, not midpoint | **Big** |
| Midpoint anchor for twist | same | same |
| Midpoint anchor for tilt | same | same |
| Compounding gestures | **blocked** by gesture lock | **Big** — drop the lock |
| Rotation dead zone (8–12°) | ✓ 8° as lock-acquisition only | refactor to per-axis "engaged" flag |
| Pitch rubber-band | hard `Mathf.Clamp` | soft resistance + ~5° overshoot |
| World-position rubber-band | no bounds | soft bounds + spring back |
| Compass / snap-to-north | none | public `SnapToNorth()` with overshoot |
| Track touches by fingerId | uses `Input.GetTouch(0/1)` index | survive finger swaps |

## Three architectural shifts

Everything else falls out of these.

### Shift 1: drop the gesture lock — pinch / twist / tilt / pan compound

The `TwoFingerKind` enum, the cumulative-threshold lock-acquisition block, and the locked-switch must go. Replace with three independent per-axis "engaged" flags driven by their own dead zones (8° twist, 30 px pinch, 35 px tilt). Once an axis engages within a session, it applies its per-frame delta independently of the others.

### Shift 2: single midpoint anchor + analytic pivot solve

Capture **one** world XZ point at gesture start — the y=0 plane intersection under the touch (one finger) or midpoint (two fingers). Each frame, after pinch / twist / tilt deltas update `_dist` / `_yaw` / `_pitch`, **solve analytically** for the `_pivot.xz` that makes the anchor project back to the current screen point:

```
Given: camera at  pivot - rot * forward * dist,  rot = Euler(pitch, yaw, 0)
       ray through screen point P has direction D = rot * unproject_local(P)
Want:  ray(camera, D) ∩ y=0  ==  anchor

Solve: t       = forward.y * dist / D.y
       pivot.x = anchor.x + forward.x * dist - t * D.x
       pivot.z = anchor.z + forward.z * dist - t * D.z
```

Six floats, no allocations, no raycast. Avoids every failure mode of "raycast + shift" — never catches walls or the avatar (y=0 plane only), no order-of-operations bugs, no compound error across frames. Pan emerges for free: when the gesture point moves on screen, the anchor solve shifts pivot to track it. The existing `ApplyDrag(...)` goes away.

### Shift 3: rubber-band replaces hard clamps

- **Pitch:** scale incoming delta by `1 - (overshoot / band)²` near `PitchMin/Max`. Allow ~5° soft overshoot. Critically-damped spring back (~400 ms) on release.
- **Distance:** same pattern at `DistMin/Max`.
- **World position:** derive `_softBounds : Bounds` in `Init` from scene `MeshyAssetMarker` AABB; **fallback to 200×200 around spawn** if no markers (Meshy still streaming). Recompute on every asset placement. Past-bound pivot scales by `1 / (1 + overshoot / damp)` so resistance grows with distance. Spring back when no finger is panning.

---

## Phase 1 — Anchor system + compounding + Phase-1 addenda (the keystone)

Single coherent refactor of `EditorCameraController.cs` plus a small `CreateScreen.tsx` fix. Includes the four addenda from review.

### Core changes

1. **Remove gesture lock:** delete the `TwoFingerKind` enum, `_twoFingerLock`, `_twoFingerStart*`, and the detection-phase block.
2. **Add anchor state:**
   ```csharp
   bool    _hasAnchor;
   Vector3 _anchorWorld;             // captured y=0 XZ point
   int     _t0Id = -1, _t1Id = -1;   // fingerId-tracked
   Vector2 _t0Start, _t1Start;       // for parallel-motion check
   bool    _pinchEngaged, _twistEngaged, _tiltEngaged;
   float   _startD, _startAng;
   Vector2 _startMid;
   ```
3. **New helpers:**
   ```csharp
   bool TryPlaneAnchor(Vector2 screenPos, out Vector3 worldXZ);
   Vector3 ScreenRayDirection(Vector2 screenPos, Quaternion camRot); // analytic
   Vector3 SolvePivotForAnchor(Vector3 anchor, Vector2 screenPos);   // closed-form
   ```
4. **Refactor `HandleInput`:**
   - **Two-finger entry:** track `_t0Id/_t1Id`, store per-finger starts, capture `_anchorWorld` from midpoint, reset all `*Engaged` flags, `KillVelocities()`.
   - **Each frame:** look up touches by `fingerId` (not index). Compute `d`, `mid`, `ang`.
   - **Per-axis engage:** if `!engaged` and cumulative motion past dead zone → engage. Once engaged, apply per-frame delta to the corresponding parameter.
   - **Tilt parallel-motion guard** *(addendum #2)*: tilt only engages if both fingers' Y deltas-from-start have the same sign.
   - **After all deltas:** `_pivot = SolvePivotForAnchor(_anchorWorld, mid)`.
5. **Refactor one-finger:** capture anchor on `Began`, `SolvePivotForAnchor` on `Moved/Stationary`. Delete `ApplyDrag`.
6. **Mouse drag:** same anchor model with cursor position.

### Addenda folded into Phase 1

**Addendum 1 — extreme-pitch graceful fallback (Risk #2 resolved).** At near-horizontal pitch the ray through the midpoint may miss y=0 forward (t < 0 or `|t| > 10 × _dist`). Instead of freezing, fall back to a virtual horizontal plane that intersects the camera's forward ray at the current `_dist` ahead of the camera. The anchor is held against that plane for the remainder of the frame. User feels slight loss of stickiness at the horizon, not a discontinuous freeze.

**Addendum 2 — tilt vs. pan discriminator (Risk #6 resolved).** If `_tiltEngaged`, suppress the Y component of the midpoint-driven pan. Implementation: solve pivot against an anchor whose Z (world-Y of the projection) is held at its captured value. If `!_tiltEngaged`, full 2D pan. Three lines inside `SolvePivotForAnchor`.

**Addendum 3 — asset-strip `SheetDragging` fix (Risk #4 resolved).** In `react/src/screens/CreateScreen.tsx`, the asset-tile `onPointerDown` arms an asset for placement but does not raise `SheetDragging`, so the camera pans under the user's finger while they're picking a tile. Raise `SheetDragging` on tile `onPointerDown`, lower on the matching `onPointerUp` (whether or not placement succeeded). Five lines.

**Addendum 4 — tap-during-glide anchor recapture.** A tap arriving while inertia is decaying must both `KillVelocities()` (already done) **and** immediately capture a fresh anchor at the touch point — even if no `Moved` phase follows. Without this, the next finger motion uses the stale pre-glide anchor and the world jumps one frame. Implementation: any touch-`Began` path that hits the gesture handler captures the anchor unconditionally (not just when motion starts).

### Phase 1 acceptance criteria

- World point under fingertip is glued during one-finger drag, including at high pitch (with graceful horizon fallback).
- Pinching on a corner of a building keeps that corner under the midpoint of the two fingers throughout the zoom.
- Two-finger twist rotates the scene around the midpoint, not around screen center.
- Pinch + twist + tilt + pan can all happen at once from a single two-finger interaction.
- Dragging an asset tile from the strip does not pan the camera.
- Tapping mid-glide stops the camera dead and the next swipe doesn't show a one-frame jump.
- The gesture lock and `ApplyDrag` are gone.

---

## Phase 2 — Inertia polish

1. **Ring-buffer velocity sample** *(addendum from review)*: pre-allocated `Vector3[8]` (pivot positions) and `float[8]` per axis (yaw, pitch, dist). 8 samples at 60 fps ≈ 133 ms window. Index modulo 8. Release velocity = `(latest - oldest_in_window) / window_duration`.
2. **Sample from `_pivot` motion, not raw finger delta** *(addendum from review)*: at high pitch + high distance a small finger move = large world move; inertia must match the world glide the user just felt, not the finger speed. Phase 1 makes this trivial — we already track `_pivot` per frame, just sample it.
3. **Snap-to-rest cutoffs** at end of `ApplyInertia`:
   - Pan: kill below 0.05 world-units / sec
   - Yaw: kill below 2° / sec
   - Pitch: kill below 2° / sec
   - Zoom: kill below 0.1 dist / sec

## Phase 3 — Rubber-band boundaries

1. **Pitch** rubber-band with ~5° soft overshoot + spring back.
2. **Distance** rubber-band at `DistMin/Max`.
3. **World position:** `_softBounds` from `MeshyAssetMarker` AABB on `Init`; fallback **200 × 200 around spawn** if none. Recompute on every `editorPlaceAsset` and terrain-build event. Up to ~30 % past-bound under user input; critically-damped spring back when no finger panning.

## Phase 4 — Compass snap-to-north (independent feature)

- Public `SnapToNorth()` — animates `_yaw → 0` over ~350 ms with 3° overshoot, `_yawVelocity = 0` first.
- Register `snapEditorCameraToNorth` Global next to `resetEditorCamera` in `GameLauncher.cs`.
- Optional compass-icon button in `CreateScreen.tsx`.

## Phase 5 — Invisible polish

- Cache `ReactRendererUGUI` reference in `Notify(...)` — currently `FindObjectsByType` every frame from `PublishSelectionBounds`.
- `IsInteracting` getter so React can suppress unrelated UI animations during camera gestures.
- Verify snap-to-rest is observable: `Unity_RunCommand` simulation that flicks and checks for a hard stop within ~1.5 s.

---

## File-level change summary

| File | Phase | Change |
|---|---|---|
| `Assets/Scripts/Game/EditorCameraController.cs` | 1 | ~250 lines added, ~80 removed |
| `react/src/screens/CreateScreen.tsx` | 1 | Asset-strip `SheetDragging` raise/lower (~5 lines) |
| `Assets/Scripts/Game/EditorCameraController.cs` | 2 | Ring-buffer velocity + snap-to-rest |
| `Assets/Scripts/Game/EditorCameraController.cs` | 3 | Rubber-band + soft bounds |
| `Assets/Scripts/LuauGameRunner.cs` | 3 | Hook for bounds recompute on asset placement |
| `Assets/Scripts/Game/GameLauncher.cs` | 4 | `snapEditorCameraToNorth` Global |
| `react/src/screens/CreateScreen.tsx` | 4 | Compass UI button (optional) |
| `Assets/Scripts/Game/EditorCameraController.cs` | 5 | Cached `ReactRendererUGUI`, `IsInteracting` |

## Decisions (resolved from review)

- **Extreme-pitch fallback:** virtual horizontal plane at current pivot.y intersecting the camera-forward ray at `_dist` ahead. Not freeze.
- **Two-finger vertical motion:** tilt-engaged ⇒ suppress Y-component of midpoint pan. Tilt not engaged ⇒ full 2D pan.
- **Asset-strip touch gating:** fix in Phase 1, not deferred.
- **World bounds fallback:** ship a hard 200×200 default; recompute on Meshy stream-in.
- **Velocity sampling:** ring buffer of `_pivot` (and per-axis floats), 8 slots = ~133 ms window at 60 fps.
- **Tap-during-glide:** always recapture anchor on touch-begin, regardless of subsequent motion.

## Testing approach

- **Unit-style** (no touch input): `Unity_RunCommand` scripts that set `_pitch/_yaw/_dist` and an anchor, then verify `SolvePivotForAnchor` makes the anchor project back to the input screen point. Cover top-down, 45°, near-horizon, and yaw-rotated cases.
- **Inertia decay:** flick simulation as in prior commits; assert reach hard zero within ~1.5 s.
- **On-device:** manual smoke test of each gesture in isolation and in compound, plus the asset-strip drag bug regression check.

---

*Originally drafted alongside the Phase 1 implementation. Keep updated as phases land.*
