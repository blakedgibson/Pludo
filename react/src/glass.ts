// ── Liquid Glass ────────────────────────────────────────────────────────────
// iOS 26-style "Liquid Glass" for the ReactUnity UI, modelled on the material
// in github.com/shayann07/liquidglass (Apache-2.0). That repo ships a refracting
// Unity shader, but it needs a Screen Space - Camera canvas and only refracts
// opaque 3D geometry — our ReactCanvas is Screen Space - Overlay and most of
// what sits behind a button is other UI, which no camera texture contains. So
// instead of refraction we reproduce the material's *look* with the layers
// ReactUnity can draw natively:
//
//   • body    — the repo's in-app tint: dark = black at ~45% over a 35/255 lift,
//               light = grey 241 at ~56%. Translucent, so the 3D world (editor,
//               in-game HUD) and page content still read through it.
//   • sheen   — a top-weighted vertical gradient: the bevel's specular band.
//   • rim     — inset 1 px highlights, strongest on the top/left edges because
//               the material's light comes from (-0.35, -0.94) (up and left),
//               plus a faint counter-light on the bottom edge.
//   • lift    — a soft drop shadow so the glass floats over the page.
//
// None of these layers touch layout (no borders are added), so `lg()` can be
// applied to any existing button style without shifting a pixel.

import { C } from './theme';

const IS_LIGHT = C.bg === '#FFFFFF';

export const GLASS = {
  // Bars / panels (thicker material, like the repo's dark bar at rest ≈ grey 33).
  bar:        IS_LIGHT ? 'rgba(246,246,248,0.78)' : 'rgba(30,30,33,0.74)',
  // Controls (buttons, chips) — a clear-ish glass.
  control:    IS_LIGHT ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.12)',
  // The selection lens inside the tab bar (the repo's pill rests darker/clearer
  // than the bar in dark mode; we lift it slightly so it reads on black).
  lens:       IS_LIGHT ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.13)',
  // Scrim behind modal glass sheets.
  scrim:      'rgba(0,0,0,0.45)',
} as const;

const SHEEN =
  'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.05) 38%, rgba(255,255,255,0) 62%, rgba(255,255,255,0.05) 100%)';
const SHEEN_PROMINENT =
  'linear-gradient(180deg, rgba(255,255,255,0.30) 0%, rgba(255,255,255,0.08) 45%, rgba(255,255,255,0) 60%, rgba(255,255,255,0.10) 100%)';

// Rim: top specular, left edge (light is up-left), bottom counter-light, hairline ring.
const RIM =
  'inset 0 1px 0 0 rgba(255,255,255,0.34), inset 1px 0 0 0 rgba(255,255,255,0.12), inset 0 -1px 0 0 rgba(255,255,255,0.07), inset 0 0 0 1px rgba(255,255,255,0.07)';
const RIM_PROMINENT =
  'inset 0 1px 0 0 rgba(255,255,255,0.55), inset 1px 0 0 0 rgba(255,255,255,0.20), inset 0 -1px 0 0 rgba(255,255,255,0.14), inset 0 0 0 1px rgba(255,255,255,0.12)';

const LIFT       = '0 6px 18px 0 rgba(0,0,0,0.28)';
const LIFT_LARGE = '0 12px 32px 0 rgba(0,0,0,0.38)';

export interface GlassOpts {
  radius?: number;
  /** Fill colour. Defaults to the bar material. */
  fill?: string;
  /** Larger, softer shadow for floating chrome (tab bar, sheets). */
  floating?: boolean;
  /** Tinted ("prominent") glass — brighter sheen and rim. */
  prominent?: boolean;
  /** Skip the drop shadow (for glass nested inside other glass). */
  flat?: boolean;
}

/** Style fragment for a piece of Liquid Glass. Spread it into a view's style. */
export function glass(opts: GlassOpts = {}): any {
  const { radius, fill = GLASS.bar, floating = false, prominent = false, flat = false } = opts;
  const rim = prominent ? RIM_PROMINENT : RIM;
  return {
    backgroundColor: fill,
    backgroundImage: prominent ? SHEEN_PROMINENT : SHEEN,
    boxShadow: flat ? rim : `${floating ? LIFT_LARGE : LIFT}, ${rim}`,
    ...(radius != null ? { borderRadius: radius } : null),
  };
}

// ── Automatic glass for existing button styles ─────────────────────────────

// Solid neutral surfaces that should become translucent glass.
const NEUTRAL_SOLIDS = new Set<string>([C.card, C.surface, C.surfaceHi, C.bg0, '#1a1a1a', '#1C1C1E', '#2C2C2E', '#3A3A3C'].map(s => s.toLowerCase()));

function alphaOf(color: string): number {
  const c = color.trim().toLowerCase();
  if (c === 'transparent' || c === 'none') return 0;
  const m = c.match(/^rgba\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',');
    const a = parseFloat(parts[3]);
    return isNaN(a) ? 1 : a;
  }
  if (/^#[0-9a-f]{8}$/.test(c)) return parseInt(c.slice(7, 9), 16) / 255;
  if (/^#[0-9a-f]{4}$/.test(c)) return parseInt(c[4] + c[4], 16) / 255;
  return 1;
}

// Is the colour a light/white translucent wash (rgba(255,255,255,a))?
function isWhiteWash(color: string): boolean {
  return /^rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/.test(color.trim().toLowerCase());
}

/**
 * Turn an existing button style into Liquid Glass without changing its layout.
 *  - invisible hit areas (alpha < 0.02) are left alone,
 *  - neutral greys become translucent glass,
 *  - coloured fills (primary, green, red…) become tinted "prominent" glass,
 *  - styles that already set boxShadow/backgroundImage keep theirs.
 */
export function lg(style: any): any {
  if (!style || typeof style !== 'object') return style;
  const bg = style.backgroundColor;
  if (typeof bg !== 'string') return style;
  const a = alphaOf(bg);
  if (a < 0.02) return style;

  const key = bg.trim().toLowerCase();
  const neutral = NEUTRAL_SOLIDS.has(key);
  const wash = isWhiteWash(bg) || (a < 0.9 && !neutral);
  const prominent = !neutral && !wash;

  const out: any = { ...style };
  if (neutral) out.backgroundColor = GLASS.control;
  if (out.backgroundImage == null) out.backgroundImage = prominent ? SHEEN_PROMINENT : SHEEN;
  if (out.boxShadow == null) out.boxShadow = `${LIFT}, ${prominent ? RIM_PROMINENT : RIM}`;
  return out;
}
