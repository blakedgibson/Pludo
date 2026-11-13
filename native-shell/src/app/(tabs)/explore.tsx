import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { GameCard } from '../../components/GameCard';
import { useGames } from '../../components/useGames';

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const { games } = useGames();
  const router = useRouter();
  const [q, setQ] = useState('');

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return games;
    return games.filter(g =>
      g.title.toLowerCase().includes(s) || g.genre.toLowerCase().includes(s) ||
      (g.tags ?? []).some(t => t.toLowerCase().includes(s)));
  }, [games, q]);

  return (
    <View style={styles.page}>
      <FlatList
        data={results}
        keyExtractor={g => String(g.id)}
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: insets.top + 76, paddingBottom: insets.bottom + 90, paddingHorizontal: 16, gap: 14 }}
        renderItem={({ item }) => <GameCard game={item} onOpen={() => router.push(`/game/${item.id}`)} />}
        ListEmptyComponent={<Text style={styles.empty}>No games match “{q}”.</Text>}
      />
      {/* Floating glass search field over the scrolling results. */}
      <GlassView style={[styles.search, { top: insets.top + 12 }]} glassEffectStyle="regular" isInteractive>
        <SymbolView name="magnifyingglass" size={16} tintColor="rgba(255,255,255,0.7)" />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search games, genres, tags"
          placeholderTextColor="rgba(255,255,255,0.5)"
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
        />
      </GlassView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  search: { position: 'absolute', left: 16, right: 16, height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  input: { flex: 1, color: '#fff', fontSize: 16 },
  empty: { color: '#8E8E93', textAlign: 'center', marginTop: 40 },
});
