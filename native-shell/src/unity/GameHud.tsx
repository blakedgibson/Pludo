import React, { useEffect, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text as RNText, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import {
  Button, Form, Host, HStack, Image, LabeledContent, Section, Spacer, Text, Toggle,
} from '@expo/ui/swift-ui';
import {
  buttonBorderShape, buttonStyle, controlSize, foregroundStyle, frame, glassEffect, labelStyle,
  scrollContentBackground,
} from '@expo/ui/swift-ui/modifiers';

/** In-game HUD state reported by ReactUnity's GameHUD (see notifyHost there). */
export interface HudState {
  active: boolean;
  players?: { username: string; local?: boolean }[];
  score?: string;
  shiftLock?: boolean;
  health?: number | null;
  /** A game's win/lose popup is up — the HUD steps aside like the Unity one did. */
  popup?: boolean;
}

/** Commands for ReactUnity's GameHUD (HudCommand) plus the raw input channels. */
export interface HudActions {
  command: (cmd: string) => void;   // pause | resume | reset | shiftLock | leave
  move: (x: number, y: number) => void;
  jump: () => void;
}

const MENU_W = 340;

// Native Liquid Glass in-game HUD: one menu button (top-left) that pauses and
// opens the combined menu (Resume · players · Reset · Shift Lock · Leave), plus
// a glass joystick and jump button. Scores, timers, banners, popups and
// Interface Builder elements are still drawn by ReactUnity underneath. The root
// is box-none so taps elsewhere reach Unity (camera orbit etc.).
export function GameHud({ state, actions }: { state: HudState; actions: HudActions }) {
  const insets = useSafeAreaInsets();
  const { height: H } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!state.active || state.popup) return null;

  function openMenu() {
    setMenuOpen(true);
    actions.command('pause');
  }
  function closeMenu() {
    setMenuOpen(false);
    actions.command('resume');
  }
  const roster = state.players?.length ? state.players : [{ username: 'You', local: true }];
  const menuH = Math.min(H - Math.max(insets.top, 8) - Math.max(insets.bottom, 8) - 16, 300 + roster.length * 44);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* ── Menu button (top-left) + health ── */}
      <View style={[styles.abs, { top: Math.max(insets.top, 8), left: Math.max(insets.left, 12) }]} pointerEvents="box-none">
        <Host matchContents>
          <Button
            label="Menu"
            systemImage="line.3.horizontal"
            onPress={openMenu}
            modifiers={[buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large')]}
          />
        </Host>
        {state.health != null && <HealthBar hp={state.health} />}
      </View>

      {/* ── Joystick + jump (hidden while paused, like Roblox) ── */}
      {!menuOpen && (
        <>
          <Joystick left={Math.max(insets.left, 20)} bottom={Math.max(insets.bottom, 16)} onMove={actions.move} />
          <Pressable
            onPressIn={actions.jump}
            accessibilityRole="button"
            accessibilityLabel="Jump"
            hitSlop={12}
            style={[styles.abs, { right: Math.max(insets.right, 24), bottom: Math.max(insets.bottom, 20) }]}
          >
            {/* Real SwiftUI Liquid Glass; the Pressable owns the touch so the
                jump fires on press-down, not on release. */}
            <Host matchContents pointerEvents="none">
              <HStack modifiers={[frame({ width: JUMP, height: JUMP }), glassEffect({ glass: { variant: 'regular', interactive: true }, shape: 'circle' })]}>
                <Image systemName="arrow.up" size={30} color="white" />
              </HStack>
            </Host>
          </Pressable>
        </>
      )}

      {/* ── Combined menu: resume, players, reset, shift lock, leave ── */}
      {menuOpen && (
        <View style={styles.dim}>
          <GlassView style={[styles.menu, { height: menuH }]} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.45)">
            <View style={styles.menuHeader}>
              <SymbolView name="gamecontroller.fill" size={18} tintColor="#fff" />
              <RNText style={styles.menuTitle}>Menu</RNText>
              <Pressable onPress={closeMenu} hitSlop={10} accessibilityLabel="Close menu" style={styles.menuClose}>
                <SymbolView name="xmark" size={13} weight="bold" tintColor="#fff" />
              </Pressable>
            </View>
            <Host style={styles.menuBody} colorScheme="dark">
              <Form modifiers={[scrollContentBackground('hidden')]}>
                <Section>
                  <Button onPress={closeMenu} modifiers={[buttonStyle('glassProminent'), controlSize('large')]}>
                    <HStack spacing={8} modifiers={[frame({ maxWidth: 1000 })]}>
                      <Spacer />
                      <Image systemName="play.fill" size={15} color="white" />
                      <Text>Resume Game</Text>
                      <Spacer />
                    </HStack>
                  </Button>
                </Section>
                <Section>
                  <Button label="Reset Character" systemImage="arrow.counterclockwise" onPress={() => { actions.command('reset'); closeMenu(); }} />
                  <Toggle label="Shift Lock" systemImage="scope" isOn={!!state.shiftLock} onIsOnChange={() => actions.command('shiftLock')} />
                  <Button label="Leave Game" systemImage="rectangle.portrait.and.arrow.right" role="destructive"
                    onPress={() => { setMenuOpen(false); actions.command('leave'); }} />
                </Section>
                <Section title={`Players · ${roster.length}`}>
                  {roster.map((p, i) => (
                    <LabeledContent key={`${p.username}-${i}`} label={p.local ? `${p.username} (you)` : p.username}>
                      <Text modifiers={[foregroundStyle('#FFD60A')]}>{p.local && state.score ? state.score : ''}</Text>
                    </LabeledContent>
                  ))}
                </Section>
              </Form>
            </Host>
          </GlassView>
        </View>
      )}
    </View>
  );
}

function HealthBar({ hp }: { hp: number }) {
  const pct = Math.max(0, Math.min(100, hp));
  const color = pct > 50 ? '#30D158' : pct > 25 ? '#FF9F0A' : '#FF453A';
  return (
    <GlassView style={styles.hp} glassEffectStyle="regular">
      <SymbolView name="heart.fill" size={12} tintColor={color} />
      <View style={styles.hpTrack}><View style={[styles.hpFill, { width: `${pct}%`, backgroundColor: color }]} /></View>
      <RNText style={styles.hpText}>{Math.round(pct)}</RNText>
    </GlassView>
  );
}

const JUMP = 76;
const JOY_SIZE = 132;
const KNOB = 56;
const JOY_R = (JOY_SIZE - KNOB) / 2;

// Fixed-base thumbstick drawn with SwiftUI Liquid Glass (clear base, regular
// knob). x right, y forward (screen up), both -1..1, sent on every move and
// zeroed on release. The RN view on top owns the touch.
function Joystick({ left, bottom, onMove }: { left: number; bottom: number; onMove: (x: number, y: number) => void }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [box] = useState(() => ({ onMove, sx: 0, sy: 0 }));
  // PanResponder handlers are bound once; they read the newest callback here.
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { box.onMove = onMove; });

  const [responder] = useState(() => {
    const update = (dx: number, dy: number) => {
      const d = Math.hypot(dx, dy);
      const k = d > JOY_R ? JOY_R / d : 1;
      const x = dx * k, y = dy * k;
      setKnob({ x, y });
      box.onMove(+(x / JOY_R).toFixed(3), +(-y / JOY_R).toFixed(3));
    };
    const end = () => { setKnob({ x: 0, y: 0 }); box.onMove(0, 0); };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        // Where the finger landed, relative to the stick's centre; moves are
        // that plus the gesture's travel.
        box.sx = e.nativeEvent.locationX - JOY_SIZE / 2;
        box.sy = e.nativeEvent.locationY - JOY_SIZE / 2;
        update(box.sx, box.sy);
      },
      onPanResponderMove: (_e, g) => update(box.sx + g.dx, box.sy + g.dy),
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
      onPanResponderTerminationRequest: () => false,
    });
  });

  return (
    <View style={[styles.abs, { left, bottom, width: JOY_SIZE, height: JOY_SIZE }]}>
      <Host style={StyleSheet.absoluteFill} pointerEvents="none">
        <HStack modifiers={[frame({ width: JOY_SIZE, height: JOY_SIZE }), glassEffect({ glass: { variant: 'clear' }, shape: 'circle' })]}>
          <Spacer />
        </HStack>
      </Host>
      <View pointerEvents="none" style={[styles.knobWrap, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]}>
        <Host style={StyleSheet.absoluteFill}>
          <HStack modifiers={[frame({ width: KNOB, height: KNOB }), glassEffect({ glass: { variant: 'regular' }, shape: 'circle' })]}>
            <Spacer />
          </HStack>
        </Host>
      </View>
      {/* Touch surface above the glass. */}
      <View {...responder.panHandlers} style={StyleSheet.absoluteFill} accessibilityLabel="Movement joystick" />
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  hp: {
    marginTop: 8, width: 160, height: 26, borderRadius: 13, flexDirection: 'row',
    alignItems: 'center', gap: 6, paddingHorizontal: 10,
  },
  hpTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  hpFill: { height: '100%', borderRadius: 3 },
  hpText: { color: '#fff', fontSize: 11, fontWeight: '700', minWidth: 20, textAlign: 'right' },
  knobWrap: { position: 'absolute', left: JOY_R, top: JOY_R, width: KNOB, height: KNOB },
  dim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center',
  },
  menu: { width: MENU_W, borderRadius: 30, overflow: 'hidden' },
  menuHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 },
  menuTitle: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '700' },
  menuClose: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  menuBody: { flex: 1 },
});
