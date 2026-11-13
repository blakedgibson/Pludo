using UnityEngine;

// Kinematic Roblox-style character motor shared by every local-player path:
// LuauPlayerController (editor play-test / local play) and GameRenderClient's
// predictor (server-hosted play, where the client is now authoritative for its
// own movement and the server validates it). One implementation means both
// modes feel identical.
//
// Why kinematic instead of a dynamic Rigidbody:
//   • A dynamic body integrates in FixedUpdate (50 Hz) while the camera renders
//     at 60–120 Hz, which showed up as the camera shaking during jumps.
//   • Roblox's 78 m/s² gravity (see RobloxPhysics) makes fast falls tunnel
//     through thin baseplates/platforms between physics steps.
//   • Contact-normal grounding flickers on uneven meshes, so jumps got eaten.
//
// The motor instead sweeps a capsule through the world every fixed 60 Hz
// substep: walls stop and slide you, ledges under StepHeight are stepped onto,
// ceilings stop a jump, and the floor is found by a sphere sweep from the
// previous position, so even a 100 m/s fall can't skip past a 1 cm plate.
public static class RobloxCharacterMotor
{
    public const float Radius      = 0.4f;
    public const float Height      = 2.0f;
    public const float StepHeight  = 0.55f;  // Roblox auto-climbs ~ half a character-leg
    public const float Skin        = 0.02f;
    public const float CoyoteTime  = 0.15f;
    public const float Substep     = 1f / 60f;
    public const float MaxFallSpeed = 120f;  // sanity cap; Roblox has effectively none
    private const float WalkableNormalY = 0.55f; // ≈ 57°, steeper is a wall

    public struct State
    {
        public Vector3 Pos;
        public Vector3 Vel;
        public bool    Grounded;
        public float   LastGroundedAt;
    }

    private static readonly RaycastHit[] Hits = new RaycastHit[32];

    /// <summary>
    /// Colliders the capsule touched (wall, ceiling or floor) during Step calls
    /// since the caller last cleared it. A kinematic capsule kept a skin-width
    /// away never generates OnCollisionEnter, so callers use this to raise
    /// Roblox-style "Touched" events themselves.
    /// </summary>
    public static readonly System.Collections.Generic.HashSet<Collider> Touched = new();
    private static readonly Collider[]   Overlaps = new Collider[16];

    /// <summary>
    /// Advance one fixed substep. <paramref name="move"/> is the desired
    /// world-space XZ direction (|move| ≤ 1). Returns true when a jump fired.
    /// </summary>
    public static bool Step(ref State s, Vector2 move, bool jump, float speed, float jumpHeight,
                            float gravity, float now, Transform self, Collider selfCol)
    {
        const float h = Substep;
        bool jumped = false;

        // Horizontal Roblox acceleration (shared ramp, momentum kept mid-air).
        var hv = RobloxPhysics.StepHorizontal(new Vector2(s.Vel.x, s.Vel.z), move * speed, speed, s.Grounded, h);
        s.Vel.x = hv.x; s.Vel.z = hv.y;

        bool canJump = s.Grounded || (now - s.LastGroundedAt) <= CoyoteTime;
        if (jump && canJump)
        {
            s.Vel.y          = RobloxPhysics.JumpVelocity(jumpHeight, gravity);
            s.Grounded       = false;
            s.LastGroundedAt = -999f;
            jumped           = true;
        }

        // Average of start/end velocity = exact displacement under constant
        // gravity (plain Euler undershot the jump apex by ~6%).
        float vyStart = s.Vel.y;
        if (!s.Grounded) s.Vel.y = Mathf.Max(s.Vel.y + gravity * h, -MaxFallSpeed);
        else if (s.Vel.y < 0f) { s.Vel.y = 0f; vyStart = 0f; }

        // ── Horizontal sweep with wall sliding ───────────────────────────────
        var delta = new Vector3(s.Vel.x, 0f, s.Vel.z) * h;
        for (int iter = 0; iter < 3 && delta.sqrMagnitude > 1e-10f; iter++)
        {
            float dist = delta.magnitude;
            var dir = delta / dist;
            if (CastCapsule(s.Pos, dir, dist + Skin, self, out var hit))
            {
                Touched.Add(hit.collider);
                float travel = Mathf.Max(0f, hit.distance - Skin);
                s.Pos += dir * travel;
                var n = hit.normal; n.y = 0f;
                if (n.sqrMagnitude < 1e-6f) break;
                n.Normalize();
                // Slide the remainder along the wall; kill velocity into it.
                var rest = dir * (dist - travel);
                delta = rest - Vector3.Dot(rest, n) * n;
                var vh = new Vector3(s.Vel.x, 0f, s.Vel.z);
                float into = Vector3.Dot(vh, n);
                if (into < 0f) { vh -= into * n; s.Vel.x = vh.x; s.Vel.z = vh.z; }
            }
            else { s.Pos += delta; break; }
        }

        // ── Vertical ────────────────────────────────────────────────────────
        float oldY = s.Pos.y;
        float dy   = (vyStart + s.Vel.y) * 0.5f * h;
        if (dy > 0f)
        {
            // Head bump.
            var head = s.Pos + Vector3.up * (Height - Radius);
            if (SphereCastFiltered(head, Radius - Skin, Vector3.up, dy + Skin, self, out var ceil))
            {
                Touched.Add(ceil.collider);
                s.Pos.y += Mathf.Max(0f, ceil.distance - Skin);
                s.Vel.y = 0f;
            }
            else s.Pos.y += dy;
        }
        else s.Pos.y += dy;

        // Ground: sweep a sphere down from the higher of the old/new feet
        // (plus StepHeight so small ledges are climbed) to the new feet, plus
        // StepHeight extra when we were grounded so walking downhill sticks.
        float topY     = Mathf.Max(oldY, s.Pos.y) + StepHeight;
        bool  wasDown  = s.Grounded;
        float reach    = (topY - s.Pos.y) + (wasDown && s.Vel.y <= 0f ? StepHeight : 0f) + Skin;
        var   origin   = new Vector3(s.Pos.x, topY + Radius, s.Pos.z);
        bool  landed   = false;
        if (s.Vel.y <= 0f && SphereCastFiltered(origin, Radius * 0.9f, Vector3.down, reach, self, out var g)
            && g.normal.y >= WalkableNormalY)
        {
            float groundY = origin.y - g.distance - Radius * 0.9f;
            s.Pos.y = groundY;
            s.Vel.y = 0f;
            landed  = true;
            Touched.Add(g.collider);
        }
        s.Grounded = landed;
        if (landed) s.LastGroundedAt = now;

        Depenetrate(ref s, self, selfCol);
        return jumped;
    }

    // Upper capsule (feet raised by StepHeight) so low ledges don't block.
    private static bool CastCapsule(Vector3 pos, Vector3 dir, float dist, Transform self, out RaycastHit best)
    {
        var p1 = pos + Vector3.up * (Radius + StepHeight);
        var p2 = pos + Vector3.up * (Height - Radius);
        int n = Physics.CapsuleCastNonAlloc(p1, p2, Radius - Skin, dir, Hits, dist, ~0, QueryTriggerInteraction.Ignore);
        return Nearest(n, self, out best);
    }

    private static bool SphereCastFiltered(Vector3 origin, float r, Vector3 dir, float dist, Transform self, out RaycastHit best)
    {
        int n = Physics.SphereCastNonAlloc(origin, r, dir, Hits, dist, ~0, QueryTriggerInteraction.Ignore);
        return Nearest(n, self, out best);
    }

    private static bool Nearest(int n, Transform self, out RaycastHit best)
    {
        best = default;
        float bestD = float.MaxValue;
        bool found = false;
        for (int i = 0; i < n; i++)
        {
            var hit = Hits[i];
            if (hit.collider == null) continue;
            if (self != null && hit.collider.transform.IsChildOf(self)) continue;
            // distance 0 = we started overlapping it; let Depenetrate push us
            // out instead of pinning the player in place forever.
            if (hit.distance <= 0f && hit.point == Vector3.zero) continue;
            if (hit.distance < bestD) { bestD = hit.distance; best = hit; found = true; }
        }
        return found;
    }

    // Push out of anything we ended up inside (moving platforms, spawning in
    // a prop). Horizontal only for floors so we don't fight the ground snap.
    private static void Depenetrate(ref State s, Transform self, Collider selfCol)
    {
        if (selfCol == null) return;
        var p1 = s.Pos + Vector3.up * (Radius + StepHeight);
        var p2 = s.Pos + Vector3.up * (Height - Radius);
        int n = Physics.OverlapCapsuleNonAlloc(p1, p2, Radius - Skin, Overlaps, ~0, QueryTriggerInteraction.Ignore);
        for (int i = 0; i < n; i++)
        {
            var c = Overlaps[i];
            if (c == null || c == selfCol) continue;
            if (self != null && c.transform.IsChildOf(self)) continue;
            if (Physics.ComputePenetration(selfCol, s.Pos, Quaternion.identity,
                                           c, c.transform.position, c.transform.rotation,
                                           out var dir, out var depth))
            {
                var push = dir * depth;
                if (dir.y > WalkableNormalY) continue; // floor — ground snap owns it
                if (dir.y < -WalkableNormalY) { s.Pos += push; if (s.Vel.y > 0f) s.Vel.y = 0f; continue; }
                push.y = 0f;
                s.Pos += push;
            }
        }
    }
}
