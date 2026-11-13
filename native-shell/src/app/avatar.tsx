import React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { useAvatarSlot } from '../unity/useAvatarSlot';
import { AVATAR_BACKDROP } from '../unity/UnityHost';

const HEADER = 56;

// Avatar customization: a large live Unity chibi (drag to spin) above the
// wardrobe controls. Opened by tapping the avatar card on the You tab.
export default function AvatarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { height } = useWindowDimensions();
  const { ref: slotRef, onLayout: onSlotLayout } = useAvatarSlot('avatar-customizer', { interactive: true });

  return (
    <View style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top, height: insets.top + HEADER }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <GlassView style={styles.back} glassEffectStyle="regular" isInteractive>
            <SymbolView name="chevron.down" size={18} tintColor="#fff" />
          </GlassView>
        </Pressable>
        <Text style={styles.title}>Avatar</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* The header stays outside the slot: Unity draws above RN views. */}
      <View ref={slotRef} onLayout={onSlotLayout} style={[styles.stage, { height: Math.round(height * 0.52) }]} />

      <View style={[styles.panel, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={styles.hint}>Drag the character to spin it.</Text>
        <View style={styles.row}>
          {[
            { sf: 'tshirt', label: 'Outfit' },
            { sf: 'paintpalette', label: 'Colors' },
            { sf: 'bag', label: 'Shop' },
          ].map(b => (
            <GlassView key={b.label} style={styles.tile} glassEffectStyle="regular" isInteractive>
              <SymbolView name={b.sf as any} size={22} tintColor="#fff" />
              <Text style={styles.tileText}>{b.label}</Text>
            </GlassView>
          ))}
        </View>
        <Text style={styles.soon}>Wardrobe editing moves here in phase 2.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  stage: { backgroundColor: AVATAR_BACKDROP },
  panel: { flex: 1, paddingHorizontal: 20, paddingTop: 18, gap: 12 },
  hint: { color: '#8E8E93', fontSize: 14 },
  row: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, height: 84, borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 6 },
  tileText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  soon: { color: '#636366', fontSize: 13, marginTop: 4 },
});
