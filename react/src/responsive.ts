// Tablet/phone layout switch. Backed by Unity's DeviceIdiom.IsTablet
// (Assets/Scripts/UI/DeviceIdiom.cs) via the getIsTablet Global — cached on
// first read since device idiom never changes mid-session, same pattern as
// theme.ts's readColorScheme().
function readIsTablet(): boolean {
  try {
    const fn = (Globals as any).getIsTablet;
    if (typeof fn === 'function') return Boolean(fn());
  } catch { /* renderer not ready */ }
  return false;
}

const tablet = readIsTablet();

export function isTablet(): boolean {
  return tablet;
}

// 3-column grid on tablet vs the app's existing 2-column (width:'48%') phone
// pattern. Used by GameCard/ItemCard/InvCard/SkeletonGameCard — keep these in
// lockstep or loading skeletons will show a different column count than the
// loaded content.
export const CARD_WIDTH_PCT = tablet ? '31.5%' : '48%';

// Canvas size in reference units, read fresh on every call because it changes
// with orientation and differs per device (the scaler pins one axis and lets
// the other float, so only one of these is ever a round 390/844/633).
//
// Do NOT hardcode 390/844 to convert screen px → reference units or to place
// things as a fraction of the canvas. The tablet lobby is landscape, so on iPad
// the space is ~844×633, and portrait-derived constants land in the wrong spot.
function readRefDim(name: string, fallback: number): number {
  try {
    const fn = (Globals as any)[name];
    if (typeof fn === 'function') {
      const v = Number(fn());
      if (isFinite(v) && v > 0) return v;
    }
  } catch { /* renderer not ready */ }
  return fallback;
}

export function refScreenWidth(): number {
  return readRefDim('getRefScreenWidth', tablet ? 844 : 390);
}

export function refScreenHeight(): number {
  return readRefDim('getRefScreenHeight', tablet ? 633 : 844);
}

// Centers single-column content (forms, lists, descriptions) instead of
// letting it stretch edge-to-edge on iPad's much wider canvas. Mirrors the
// maxWidth:720 pattern already used for the in-editor Shop overlay (App.tsx).
export const CONTENT_MAX_WIDTH: number | undefined = tablet ? 720 : undefined;
