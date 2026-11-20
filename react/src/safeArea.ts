// Lazily reads the iOS safe area insets from Unity globals.
// Returns the value in reference-resolution UI units (390×844 coordinate space).
// Defaults are tuned for typical notch iPhones if globals are not yet ready.
//
// These helpers are uncached so they react to orientation changes at runtime:
// in LandscapeLeft the notch lives on the RIGHT edge (safeAreaRight > 0,
// safeAreaLeft ≈ 0), in LandscapeRight it lives on the LEFT (safeAreaLeft > 0,
// safeAreaRight ≈ 0). App.tsx and CreateScreen re-render every frame from the
// Globals polling loop, so reading fresh each call picks up rotation
// automatically without explicit listeners.
//
// Side-anchored UI (chat, joystick, menus, score/timer) should add the inset
// on the notch side and keep a standard margin on the opposite side. Use
// safeAreaLeft()/safeAreaRight() symmetrically so the same layout works in
// both landscape orientations.

function readGlobal(name: string, fallback: number): number {
  try {
    const fn = (Globals as any)[name];
    if (typeof fn === 'function') {
      const v = Number(fn());
      return isFinite(v) && v >= 0 ? v : fallback;
    }
  } catch {
    // Globals not yet registered — fall through to default
  }
  return fallback;
}

// True once a landscape session (game / editor) has been requested AND the
// screen has physically rotated. False during the ~300–800 ms window between
// enterEditorOrientation() and the OS finishing the rotation: in that window
// the React canvas is still portrait-shaped while the layout has already
// switched to landscape reference units, so landscape UI renders bunched into
// the top-left corner and jumps outward when the rotation lands. Landscape
// screens should hold their chrome back until this reads true.
//
// Also false in the portrait lobby — this asks "is landscape live?", not "is
// the orientation settled?", so a screen gating on it can't be fooled by the
// portrait moment before the rotation is even requested.
export function landscapeReady(): boolean {
  try {
    const fn = (Globals as any).getLandscapeReady;
    if (typeof fn === 'function') return String(fn()) === 'true';
  } catch {
    // Globals not yet registered — treat as not ready; callers pair this with
    // a timeout so a missing bridge can never hide the UI forever.
  }
  return false;
}

export function safeAreaTop(): number {
  return readGlobal('getSafeAreaTop', 44);
}

// Bottom safe-area inset (home indicator bezel). In the Editor Device Simulator
// the device frame masks this region, so bottom-pinned UI (BottomNav, Play bar)
// must offset by this or it renders behind the bezel. ~34 reference px on
// notch iPhones.
export function safeAreaBottom(): number {
  return readGlobal('getSafeAreaBottom', 34);
}

// Left inset — non-zero in LandscapeRight (notch on left). Most landscape
// notch iPhones report 50–63 px in the 390-wide reference; default to 50 if
// Unity hasn't registered the global yet so chat still clears the notch on
// first paint.
export function safeAreaLeft(): number {
  return readGlobal('getSafeAreaLeft', 50);
}

// Right inset — non-zero in LandscapeLeft (notch on right). Mirrors
// safeAreaLeft so right-anchored UI (score, play button, etc.) can pad
// symmetrically.
export function safeAreaRight(): number {
  return readGlobal('getSafeAreaRight', 50);
}
