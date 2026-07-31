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

// Centers single-column content (forms, lists, descriptions) instead of
// letting it stretch edge-to-edge on iPad's much wider canvas. Mirrors the
// maxWidth:720 pattern already used for the in-editor Shop overlay (App.tsx).
export const CONTENT_MAX_WIDTH: number | undefined = tablet ? 720 : undefined;
