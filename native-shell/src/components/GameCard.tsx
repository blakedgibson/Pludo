import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import type { GameSummary } from '../api';

const GENRE_COLORS: Record<string, string> = {
  platformer: '#5B9CFF', simulation: '#30D158', adventure: '#FF8C00',
  racing: '#FF453A', puzzle: '#C7A4FF', shooter: '#FF375F',
};

export function GameCard({ game, onOpen }: { game: GameSummary; onOpen: () => void }) {
  const tint = GENRE_COLORS[game.genre] ?? '#5B9CFF';
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Open ${game.title}`}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] }]}
    >
      {game.thumbnailUrl
        ? <Image source={{ uri: game.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        : <View style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: 0.55 }]} />}
      {/* Real iOS 26 Liquid Glass over the artwork. */}
      <GlassView style={styles.info} glassEffectStyle="regular">
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{game.title}</Text>
          <Text style={styles.meta} numberOfLines={1}>{game.creatorName} · {game.plays} plays</Text>
        </View>
        <SymbolView name="chevron.right" size={16} tintColor="rgba(255,255,255,0.7)" />
      </GlassView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { height: 190, borderRadius: 26, overflow: 'hidden', backgroundColor: '#1C1C1E', justifyContent: 'flex-end', padding: 8 },
  info: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 20, paddingVertical: 10, paddingLeft: 14, paddingRight: 8 },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  meta: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },
});
