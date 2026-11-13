using UnityEngine;

// Roblox-derived character physics constants, shared by every path that moves a
// player: the client-side prediction in GameRenderClient (server-authoritative
// play), LuauPlayerController (local / editor-preview play), and LuauGameRunner's
// defaults. Keeping them in one place is what stops those three from drifting
// apart and producing three subtly different "feels".
//
// Roblox's numbers are in studs, so porting them means porting RATIOS, not raw
// values. A default Roblox character is 5 studs tall, so dividing each constant
// by 5 gives a scale-invariant "per character-height" figure that reproduces the
// same feel on our 2 m avatar:
//
//   gravity     196.2 studs/s² ÷ 5 = 39.24 heights/s²
//   walk speed   16   studs/s  ÷ 5 =  3.2  heights/s
//   jump height   7.2 studs    ÷ 5 =  1.44 heights
//
// The ratio is robust to whichever stud→metre convention you pick (0.28 m/stud
// or 20 studs/m) because numerator and denominator are both in studs.
//
// The headline consequence: gravity ends up ~8× stronger relative to character
// size than the Earth-gravity default this project used to ship (9.81 m/s² on a
// 2 m avatar = 4.9 heights/s²). Total airtime for a jump goes 1.28 s → 0.542 s
// — the difference between a moon jump and Roblox's snappy hop.
//
// Mirrored in api-server/src/world-state.ts — keep the two in sync.
public static class RobloxPhysics
{
    // Metres. Matches the humanoid normalisation target used by GameAssetLoader
    // and LuauGameRunner.DeferredAvatarScale.
    public const float CharacterHeight = 2f;

    public const float Gravity    = 39.24f * CharacterHeight; // 78.48 m/s²
    public const float WalkSpeed  = 3.2f   * CharacterHeight; //  6.40 m/s
    public const float JumpHeight = 1.44f  * CharacterHeight; //  2.88 m
    // → jump velocity 21.26 m/s, apex 0.271 s, airtime 0.542 s (matches Roblox)

    // Roblox GroundController semantics: seconds to reach full speed from rest,
    // and to come to a full stop from full speed. Ground values are deliberately
    // snappy (the legacy Humanoid feels near-instant); air acceleration is weaker
    // so you steer mid-jump rather than teleport.
    public const float GroundAccelTime = 0.10f;
    public const float GroundDecelTime = 0.10f;
    public const float AirAccelTime    = 0.35f;

    // Initial upward velocity that reaches `jumpHeight` under `gravity`.
    public static float JumpVelocity(float jumpHeight, float gravity)
        => Mathf.Sqrt(2f * Mathf.Abs(gravity) * Mathf.Max(jumpHeight, 0.01f));

    // One Roblox-style horizontal velocity ramp, returning the new (vx, vz).
    //
    // Airborne with no input conserves momentum outright — that is what makes a
    // running jump carry you forward instead of stopping dead the moment you let
    // go of the stick, and it is the single most recognisable part of Roblox's
    // movement feel. Mirrored by stepHorizontalVelocity in world-state.ts.
    public static Vector2 StepHorizontal(
        Vector2 vel, Vector2 targetVel, float speed, bool grounded, float dt)
    {
        bool hasInput = targetVel.sqrMagnitude > 1e-6f;
        float rampTime;
        if (hasInput)      rampTime = grounded ? GroundAccelTime : AirAccelTime;
        else if (grounded) rampTime = GroundDecelTime;
        else               return vel; // airborne, no input → keep momentum

        if (rampTime <= 1e-4f) return targetVel;
        float maxDelta = (Mathf.Max(speed, 0.01f) / rampTime) * dt;
        return Vector2.MoveTowards(vel, targetVel, maxDelta);
    }
}
