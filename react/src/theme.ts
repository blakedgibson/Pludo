import React from 'react';

// Read the system color scheme from the C# side (Application.systemUserInterfaceStyle).
// Cached on first read so every C.bg lookup doesn't re-cross the C#/JS bridge.
// Falls back to "dark" if Globals isn't ready yet — same pattern as safeArea.ts.
function readColorScheme(): 'light' | 'dark' {
  try {
    const fn = (Globals as any).getColorScheme;
    if (typeof fn === 'function') {
      const v = String(fn());
      if (v === 'light' || v === 'dark') return v;
    }
  } catch { /* renderer not ready */ }
  return 'dark';
}

const scheme = readColorScheme();

export const C = {
  // Pure black in dark mode, pure white in light mode — per design spec.
  // Other surface colors stay constant; flip this one only.
  bg:        scheme === 'light' ? '#FFFFFF' : '#000000',
  card:      '#2C2C2E',
  surface:   '#3A3A3C',
  text:      '#F5F5F0',
  secondary: '#8E8E93',
  green:     '#30D158',
  blue:      '#1E8CFF',
  orange:    '#FF8C00',
  red:       '#FF453A',
  border:    'rgba(255,255,255,0.06)',

  // ── Modern token foundation (additive) ───────────────────────────────────
  // New surfaces/accents introduced for the UI-modernization pass. The
  // existing tokens above stay frozen so un-migrated screens keep their
  // current look — adopt these in components as they're refreshed.
  //
  // Elevation tiers (darkest → lightest). `bg0` is the page floor; cards
  // and modals sit one tier up so they read as raised. `surfaceHi` is the
  // hover/pressed state OR the inner well of a card.
  bg0:       '#0A0A0B',
  surfaceHi: '#2A2A2E',

  // Brand primary — used for CTAs, focus rings, and the active bottom-nav
  // tab. Distinct from `green`, which is reserved for success/online status
  // semantics (was previously overloaded for both jobs).
  primary:   '#5B9CFF',

  // Used for "Epic" rarity, Hot badges, and other high-energy callouts so
  // we stop reusing `green` as a generic accent.
  accent:    '#C7A4FF',

  // Body-copy color between `text` and `secondary` — sits closer to text
  // for long-form copy that still needs to recede from headlines.
  textMuted: '#B0B0B5',

  // Translucent derivatives of `primary`, for selected/active states that
  // need a wash rather than a solid fill. Screens previously hand-rolled
  // these as rgba(48,209,88,…) literals against the old green accent, which
  // is how the two palettes drifted apart in the first place.
  primaryTint:   'rgba(91,156,255,0.14)',
  primaryBorder: 'rgba(91,156,255,0.55)',

  // Text/icon color to place ON a `primary` fill. Kept separate from `bg`
  // so light mode doesn't render white-on-blue.
  onPrimary: '#0A0A0B',
} as const;

// Centralized rarity palette. Single source of truth — replaces the local
// maps that previously lived in `ExploreScreen.tsx` and `ItemCard.tsx`
// (which had diverged: Epic was `C.green` in one and `#BF5AF2` in the other).
export const RARITY: Record<string, string> = {
  Common:    C.secondary,
  Uncommon:  '#33FF88',
  Rare:      '#00D4FF',
  Epic:      C.accent,
  Legendary: C.orange,
};

export const S = {
  flex1:    { flex: 1 } as React.CSSProperties,
  row:      { flexDirection: 'row'    as const },
  center:   { alignItems: 'center' as const, justifyContent: 'center' as const },
  bold:     { fontWeight: 'bold' as const },
  hidden:   { display: 'none' as const },
} as const;
