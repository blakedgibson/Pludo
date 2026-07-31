import React, { useEffect, useRef, useState } from 'react';
import { C } from '../theme';
import { isTablet } from '../responsive';
import { Pressable } from './Pressable';
import { safeAreaBottom, safeAreaLeft } from '../safeArea';

interface Props {
  active: number;
  onTab: (i: number) => void;
}

// Visible height of the nav CONTENT (icons + labels + internal padding) — excludes
// the dynamic safe-area bottom inset that the nav also pads for. Overlays that
// need to sit above the nav (eg. the Play bar) should offset by
// BOTTOM_NAV_HEIGHT + safeAreaBottom().
export const BOTTOM_NAV_HEIGHT = 60;

// Width of the tablet side-rail variant (icons + labels + internal padding),
// analogous to BOTTOM_NAV_HEIGHT on phone.
export const NAV_RAIL_WIDTH = 84;

// Whichever footprint is actually on screen for the current idiom — the
// value screens should reserve space for. Use instead of BOTTOM_NAV_HEIGHT
// directly wherever code needs to avoid the nav generically.
export const NAV_FOOTPRINT = isTablet() ? NAV_RAIL_WIDTH : BOTTOM_NAV_HEIGHT;

// Selected color uses the brand primary so the active tab reads as accented
// rather than "default white text." Light mode still inverts to a dark glyph
// so the tab pops on a near-white nav bg.
const IS_LIGHT = C.bg === '#FFFFFF';
const SELECTED_COLOR   = IS_LIGHT ? '#000000' : C.primary;
const UNSELECTED_COLOR = C.secondary;
const NAV_BG           = IS_LIGHT ? 'rgba(242,242,247,0.96)' : 'rgba(28,28,30,0.96)';
const NAV_BORDER       = IS_LIGHT ? 'rgba(0,0,0,0.08)'       : 'rgba(255,255,255,0.08)';

const ICON_SIZE = 26;

const TABS: { glyph: string; label: string }[] = [
  { glyph: 'home',         label: 'Home'    },
  { glyph: 'search',       label: 'Explore' },
  { glyph: 'add_circle',   label: 'Create'  },
  { glyph: 'chat_bubble',  label: 'Chat'    },
  { glyph: 'person',       label: 'You'     },
];

const TAB_WIDTH_PCT  = 100 / TABS.length;
const PILL_WIDTH_PCT = 6;          // pill is ~6% of nav width
const PILL_HEIGHT    = 3;
const LERP_SPEED     = 0.32;       // higher = snappier; lower = smoother

export function BottomNav({ active, onTab }: Props) {
  // Pill x-center expressed as a percentage of nav width. Each tab's center
  // sits at (i + 0.5) * 20% for 5 tabs.
  const target     = (active + 0.5) * TAB_WIDTH_PCT;
  const [pillX, setPillX] = useState(target);
  const pillRef    = useRef(target);
  const animRef    = useRef<any>(null);

  useEffect(() => {
    if (animRef.current) clearInterval(animRef.current);
    animRef.current = setInterval(() => {
      const cur  = pillRef.current;
      const next = cur + (target - cur) * LERP_SPEED;
      const done = Math.abs(target - next) < 0.05;
      const val  = done ? target : next;
      pillRef.current = val;
      setPillX(val);
      if (done) { clearInterval(animRef.current); animRef.current = null; }
    }, 16);
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, [target]);

  const tablet = isTablet();

  // Tablet: a left-docked vertical rail instead of a bottom row — a full-width
  // 5-tab bar stretched across an iPad reads as sparse/oversized. Same tab
  // data, sliding-pill mechanics, and colors; only the strip's axis flips.
  if (tablet) {
    return (
      <view style={{
        flexDirection: 'column',
        flexShrink: 0,
        width: NAV_RAIL_WIDTH,
        height: '100%',
        backgroundColor: NAV_BG,
        borderRightWidth: 1,
        borderRightColor: NAV_BORDER,
        paddingLeft: safeAreaLeft() + 6,
        paddingTop: 12,
        position: 'relative',
      } as any}>
        {/* Sliding indicator pill on the left edge, moving vertically. */}
        <view style={{
          position: 'absolute',
          left: 0,
          top: `${pillX - PILL_WIDTH_PCT / 2}%`,
          height: `${PILL_WIDTH_PCT}%`,
          width: PILL_HEIGHT,
          borderRadius: PILL_HEIGHT,
          backgroundColor: SELECTED_COLOR,
        } as any} />

        {TABS.map(({ glyph, label }, i) => {
          const isActive = i === active;
          const color    = isActive ? SELECTED_COLOR : UNSELECTED_COLOR;
          const set      = isActive ? 'material-rounded-filled' : 'material-rounded';
          return (
            <Pressable key={i} onClick={() => onTab(i)} style={{
              flex: 1,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.002)',
              borderWidth: 0,
              padding: 0,
              gap: 3,
            }}>
              <icon set={set} style={{ fontSize: ICON_SIZE, color, lineHeight: ICON_SIZE }}>{glyph}</icon>
              <text style={{ fontSize: 11, color, textAlign: 'center', fontWeight: isActive ? 'bold' : 'normal' }}>{label}</text>
            </Pressable>
          );
        })}
      </view>
    );
  }

  return (
    <view style={{
      flexDirection: 'row',
      flexShrink: 0,
      backgroundColor: NAV_BG,
      borderTopWidth: 1,
      borderTopColor: NAV_BORDER,
      paddingBottom: safeAreaBottom() + 6,
      paddingTop: 8,
      position: 'relative',
    }}>
      {/* Sliding indicator pill — anchored to the top edge so it reads as a
          tab marker rather than a separator. Center-aligned via the pillX
          percentage minus half its width. */}
      <view style={{
        position: 'absolute',
        top: 0,
        left: `${pillX - PILL_WIDTH_PCT / 2}%`,
        width: `${PILL_WIDTH_PCT}%`,
        height: PILL_HEIGHT,
        borderRadius: PILL_HEIGHT,
        backgroundColor: SELECTED_COLOR,
      } as any} />

      {TABS.map(({ glyph, label }, i) => {
        const isActive = i === active;
        const color    = isActive ? SELECTED_COLOR : UNSELECTED_COLOR;
        const set      = isActive ? 'material-rounded-filled' : 'material-rounded';
        return (
          <Pressable key={i} onClick={() => onTab(i)} style={{
            flex: 1,
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.002)',
            borderWidth: 0,
            padding: 0,
            gap: 3,
          }}>
            <icon set={set} style={{ fontSize: ICON_SIZE, color, lineHeight: ICON_SIZE }}>{glyph}</icon>
            <text style={{ fontSize: 11, color, textAlign: 'center', fontWeight: isActive ? 'bold' : 'normal' }}>{label}</text>
          </Pressable>
        );
      })}
    </view>
  );
}
