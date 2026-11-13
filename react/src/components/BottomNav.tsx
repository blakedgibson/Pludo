import React, { useEffect, useRef, useState } from 'react';
import { C } from '../theme';
import { isTablet } from '../responsive';
import { Pressable } from './Pressable';
import { safeAreaBottom, safeAreaLeft } from '../safeArea';
import { glass, GLASS } from '../glass';

interface Props {
  active: number;
  onTab: (i: number) => void;
}

// ── Liquid Glass tab bar ────────────────────────────────────────────────────
// iOS 26-style: the bar is a floating glass capsule detached from the screen
// edges, and the selection is a smaller glass "lens" that slides between tabs
// (see glass.ts and github.com/shayann07/liquidglass docs/tab-bar.md). On
// tablet the same capsule stands vertically as a floating left rail.

// Height of the glass capsule itself.
const BAR_HEIGHT = 62;
// Gap between the capsule and the screen's bottom edge when there is no
// home-indicator inset. With an inset the bar sinks into it a little, as iOS's does.
const BAR_MIN_GAP = 10;
const BAR_SINK    = 12;

// Space the nav claims above the safe-area inset: capsule + gap + breathing
// room so the last row of content clears it. Overlays that need to sit above
// the nav (eg. the Play bar) should offset by BOTTOM_NAV_HEIGHT + safeAreaBottom().
export const BOTTOM_NAV_HEIGHT = BAR_HEIGHT + BAR_MIN_GAP;

// Width of the tablet side-rail variant (glass capsule + its margins),
// analogous to BOTTOM_NAV_HEIGHT on phone.
export const NAV_RAIL_WIDTH = 84;

// Whichever footprint is actually on screen for the current idiom — the
// value screens should reserve space for. Use instead of BOTTOM_NAV_HEIGHT
// directly wherever code needs to avoid the nav generically.
export const NAV_FOOTPRINT = isTablet() ? NAV_RAIL_WIDTH : BOTTOM_NAV_HEIGHT;

// Vertical space a tab screen must leave at the bottom of its content so the
// last row isn't swallowed by the floating nav. On tablet the nav is a left
// rail, so only the home-indicator inset applies. Uncached because
// safeAreaBottom() tracks orientation.
export function bottomNavInset(): number {
  return (isTablet() ? 0 : BOTTOM_NAV_HEIGHT) + safeAreaBottom();
}

const IS_LIGHT = C.bg === '#FFFFFF';
const SELECTED_COLOR   = IS_LIGHT ? '#0A64FF' : C.primary;
const UNSELECTED_COLOR = IS_LIGHT ? '#3C3C43' : '#D1D1D6';

const ICON_SIZE = 25;
const LENS_INSET = 4;          // lens sits this far inside the bar
const RAIL_TAB_HEIGHT = 64;    // tablet: fixed tab height inside the rail

const TABS: { glyph: string; label: string }[] = [
  { glyph: 'home',         label: 'Home'    },
  { glyph: 'search',       label: 'Explore' },
  { glyph: 'add_circle',   label: 'Create'  },
  { glyph: 'chat_bubble',  label: 'Chat'    },
  { glyph: 'person',       label: 'You'     },
];

const TAB_PCT    = 100 / TABS.length;
const LERP_SPEED = 0.28;       // higher = snappier; lower = smoother

// The lens position as a fractional tab index, eased toward the active tab.
function useLensPosition(active: number): number {
  const [pos, setPos] = useState(active);
  const posRef  = useRef(active);
  const animRef = useRef<any>(null);

  useEffect(() => {
    if (animRef.current) clearInterval(animRef.current);
    animRef.current = setInterval(() => {
      const cur  = posRef.current;
      const next = cur + (active - cur) * LERP_SPEED;
      const done = Math.abs(active - next) < 0.004;
      const val  = done ? active : next;
      posRef.current = val;
      setPos(val);
      if (done) { clearInterval(animRef.current); animRef.current = null; }
    }, 16);
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, [active]);

  return pos;
}

function TabItem({ i, active, onTab, style }: { i: number; active: number; onTab: (i: number) => void; style: any }) {
  const { glyph, label } = TABS[i];
  const isActive = i === active;
  const color    = isActive ? SELECTED_COLOR : UNSELECTED_COLOR;
  const set      = isActive ? 'material-rounded-filled' : 'material-rounded';
  return (
    <Pressable glass={false} onClick={() => onTab(i)} pressedScale={1.06} pressedOpacity={0.85} style={{
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      // Near-transparent fill keeps the whole tab a hit target.
      backgroundColor: 'rgba(0,0,0,0.002)',
      borderWidth: 0,
      padding: 0,
      gap: 2,
      ...style,
    }}>
      <icon set={set} style={{ fontSize: ICON_SIZE, color, lineHeight: ICON_SIZE }}>{glyph}</icon>
      {/* maxLines guards the frame where the label re-measures from
          normal to bold on activation and briefly wraps. */}
      <text style={{ fontSize: 10, color, textAlign: 'center', fontWeight: isActive ? 'bold' : 'normal', maxLines: 1 } as any}>{label}</text>
    </Pressable>
  );
}

export function BottomNav({ active, onTab }: Props) {
  const pos = useLensPosition(active);
  const tablet = isTablet();

  // Tablet: a floating vertical glass rail on the left.
  if (tablet) {
    return (
      <view style={{
        width: NAV_RAIL_WIDTH,
        height: '100%',
        paddingLeft: safeAreaLeft() + 8,
        paddingRight: 8,
        justifyContent: 'center',
        flexShrink: 0,
      } as any}>
        <view style={{
          ...glass({ radius: 34, floating: true }),
          flexDirection: 'column',
          paddingTop: LENS_INSET,
          paddingBottom: LENS_INSET,
          position: 'relative',
        }}>
          {/* Selection lens — slides vertically between tabs. */}
          <view style={{
            ...glass({ radius: 28, fill: GLASS.lens, flat: true }),
            position: 'absolute',
            left: LENS_INSET,
            right: LENS_INSET,
            top: LENS_INSET + pos * RAIL_TAB_HEIGHT,
            height: RAIL_TAB_HEIGHT,
          } as any} />
          {TABS.map((_, i) => (
            <TabItem key={i} i={i} active={active} onTab={onTab} style={{ height: RAIL_TAB_HEIGHT }} />
          ))}
        </view>
      </view>
    );
  }

  const sab = safeAreaBottom();
  const gap = sab > 0 ? Math.max(BAR_MIN_GAP, sab - BAR_SINK) : BAR_MIN_GAP;

  return (
    <view style={{
      paddingLeft: 16,
      paddingRight: 16,
      paddingBottom: gap,
      flexShrink: 0,
    }}>
      <view style={{
        ...glass({ radius: BAR_HEIGHT / 2, floating: true }),
        height: BAR_HEIGHT,
        flexDirection: 'row',
        position: 'relative',
      }}>
        {/* Selection lens — a smaller glass capsule that slides under the
            active tab. Tabs span the full bar, so tab i covers
            [i*20%, (i+1)*20%]. A wrapper carries the %, the lens insets in it. */}
        <view style={{
          position: 'absolute',
          top: LENS_INSET,
          bottom: LENS_INSET,
          left: `${pos * TAB_PCT}%`,
          width: `${TAB_PCT}%`,
          paddingLeft: LENS_INSET,
          paddingRight: LENS_INSET,
        } as any}>
          <view style={{
            ...glass({ radius: (BAR_HEIGHT - LENS_INSET * 2) / 2, fill: GLASS.lens, flat: true }),
            flex: 1,
          }} />
        </view>

        {TABS.map((_, i) => (
          // flexBasis 0 is load-bearing: with the default `auto` basis the
          // tabs size to their labels, while the lens is positioned at even
          // fifths. Pinning the basis makes the two agree.
          <TabItem key={i} i={i} active={active} onTab={onTab} style={{ flex: 1, flexBasis: 0 }} />
        ))}
      </view>
    </view>
  );
}
