import React from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GameCard } from '../../components/GameCard';
import { CreateMenu, HeaderButton, HeaderTitle } from '../../components/HeaderButton';
import { useGames } from '../../components/useGames';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { games, error, loading, reload } = useGames();

  return (
    <View style={[styles.page, { paddingTop: insets.top + 4 }]}>
      {/* Header row: create (left), Pludo (centre), notifications (right). */}
      <View style={styles.headerRow}>
        <HeaderTitle />
        <CreateMenu />
        <HeaderButton sf="bell" label="Notifications" onPress={() => router.push('/notifications')} />
      </View>

      <FlatList
        style={styles.page}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 90, paddingHorizontal: 16, gap: 14 }}
        data={games}
        keyExtractor={g => String(g.id)}
        refreshControl={<RefreshControl refreshing={loading && games.length > 0} onRefresh={reload} tintColor="#fff" />}
        ListEmptyComponent={
          loading ? <ActivityIndicator color="#fff" style={{ marginTop: 40 }} />
                  : <Text style={styles.empty}>{error ? `Couldn't load games: ${error}` : 'No games yet.'}</Text>
        }
        renderItem={({ item }) => <GameCard game={item} onOpen={() => router.push(`/game/${item.id}`)} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 4 },
  empty: { color: '#8E8E93', textAlign: 'center', marginTop: 40 },
});
