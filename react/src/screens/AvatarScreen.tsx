import React, { useEffect } from 'react';
import { C } from '../theme';
import { InventoryDrawer, WardrobePanel, wardrobePanelWidth } from '../components/InventoryDrawer';
import { NAV_FOOTPRINT } from '../components/BottomNav';
import { isTablet, refScreenWidth } from '../responsive';
import { safeAreaTop } from '../safeArea';
import { GlassButton } from '../components/GlassButton';

interface Props {
  onShop: () => void;
  onNavigate: (section: number) => void;
}

function Header({ onNavigate }: { onNavigate: (section: number) => void }) {
  return (
    <view style={{
      backgroundColor: C.bg,
      paddingLeft: 20, paddingRight: 16,
      paddingTop: safeAreaTop() + 4, paddingBottom: 12,
      flexDirection: 'row', alignItems: 'center',
    }}>
      <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5, flex: 1 }}>Avatar</text>
      <GlassButton onClick={() => onNavigate(2)} style={{
        width: 44, height: 44, borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.07)',
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>menu</icon>
      </GlassButton>
    </view>
  );
}

export function AvatarScreen({ onShop, onNavigate }: Props) {
  const tablet   = isTablet();
  // Recomputed on every render (App re-renders from its globals polling loop),
  // so a rotation or a late-arriving width read flows through to both the panel
  // and the Unity camera column below.
  const panelW   = tablet ? wardrobePanelWidth(refScreenWidth() - NAV_FOOTPRINT) : 0;

  // Tell Unity to frame the chibi inside the left column instead of the whole
  // screen, so it sits beside the wardrobe rather than behind it. The camera
  // owns the framing — React only reports where the column's edges are.
  useEffect(() => {
    if (!tablet) return;
    try { (Globals as any).setAvatarRegion?.(NAV_FOOTPRINT, panelW); } catch { /* renderer not ready */ }
    // Always release on unmount: leaving the tab (or dropping into Settings /
    // the shop) must restore full-screen framing or the phone drawer layout and
    // the profile-panel thumbnail would inherit a stale column.
    return () => {
      try { (Globals as any).clearAvatarRegion?.(); } catch { /* renderer not ready */ }
    };
  }, [tablet, panelW]);

  // Tablet: avatar column on the left, wardrobe panel on the right — an iPad has
  // the width to show both at once, so the phone's drag-up-over-the-avatar
  // drawer just wastes it.
  if (tablet) {
    return (
      <view style={{ flex: 1, flexDirection: 'row' }}>
        <view style={{ flex: 1, flexDirection: 'column' }}>
          <Header onNavigate={onNavigate} />
          {/* Chibi area — transparent so the RT canvas shows through. */}
          <view style={{ flex: 1 }} />
        </view>
        <WardrobePanel width={panelW} />
      </view>
    );
  }

  return (
    <view style={{ flex: 1, flexDirection: 'column' }}>

      <Header onNavigate={onNavigate} />

      {/* Chibi area — transparent so the RT canvas shows through.
          Orbit is driven by Unity's Input system (SetOrbitActive), not React events. */}
      <view style={{ flex: 1 }} />

      {/* Inventory drawer — sits directly above the bottom nav */}
      <InventoryDrawer />

    </view>
  );
}
