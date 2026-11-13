import React, { useCallback, useEffect, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useAuth } from '../../auth';
import { fetchMyGames, type MyGame } from '../../api';
import { AVATAR_BACKDROP, useUnity } from '../../unity/UnityHost';
import { useAvatarSlot } from '../../unity/useAvatarSlot';
import { SignIn } from '../../components/SignIn';
import { CreateMenu, HeaderButton, HeaderTitle } from '../../components/HeaderButton';

const CARD_RADIUS = 24;
const HEAD_SIZE = 112;

const GENRE_COLORS: Record<string, string> = {
  platformer: '#5B9CFF', simulation: '#30D158', adventure: '#FF8C00',
  racing: '#FF453A', puzzle: '#C7A4FF', shooter: '#FF375F',
};

export default function YouScreen() {
  const { session, restoring } = useAuth();
  if (restoring) return <View style={styles.page}><ActivityIndicator color="#fff" style={{ marginTop: 120 }} /></View>;
  if (!session) return <SignIn />;
  return <Profile />;
}

function Profile() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session, getAccessToken, signOut } = useAuth();
  // iPad landscape / large windows: avatar on the left, games on the right
  // (the full-width card would be taller than the screen).
  const { width: winW } = useWindowDimensions();
  const wide = winW >= 900;
  const leftW = wide ? Math.min(winW * 0.46, 560) : undefined;
  const unity = useUnity();
  // Live Unity chibi inside the card. Not interactive: taps fall through to the
  // card, which opens the customizer (where the avatar can be spun).
  const { ref: slotRef, onLayout: onSlotLayout } = useAvatarSlot('profile-card', { radius: CARD_RADIUS, interactive: false });

  const [games, setGames] = useState<MyGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userId = session?.userId;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    getAccessToken()
      .then(token => (token ? fetchMyGames(userId, token) : Promise.reject(new Error('Signed out'))))
      .then(list => { if (alive) { setGames(list); setError(null); } })
      .catch(e => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [userId, getAccessToken]);

  // Refresh the head picture whenever the profile comes back into view (the
  // avatar may have changed in the customizer). Unity renders it on request.
  const { ready, requestHeadshot } = unity;
  useFocusEffect(useCallback(() => {
    if (ready) requestHeadshot();
  }, [ready, requestHeadshot]));

  // Three-bars menu. Sign out lives here for now (more items can join it).
  function openMenu() {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Sign out', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1, userInterfaceStyle: 'dark' },
      i => { if (i === 0) signOut(); },
    );
  }

  return (
    <View style={[styles.page, { paddingTop: insets.top + 4 }]}>
      {/* Header row above the avatar card: create (left), Pludo (centre), menu (right). */}
      <View style={styles.header}>
        <HeaderTitle />
        <CreateMenu />
        <HeaderButton sf="line.3.horizontal" label="Menu" onPress={openMenu} />
      </View>

      <View style={wide ? styles.split : undefined}>
      <View style={wide ? { width: leftW } : undefined}>
      {/* Avatar card — tap to customize. */}
      <Pressable
        onPress={() => router.push('/avatar')}
        accessibilityRole="button"
        accessibilityLabel="Customize avatar"
        style={styles.card}
      >
        {/* Unity is a native overlay above all RN views, so the slot stops
            short of the strip the head picture overlaps — otherwise Unity
            would cover the top of the circle. Unity paints AVATAR_BACKDROP
            behind the chibi, the card's colour, so it reads as one surface. */}
        <View ref={slotRef} onLayout={onSlotLayout} style={styles.slot} />
      </Pressable>

      {/* Head picture overlapping the card, then the username. */}
      <View style={styles.identity}>
        <View style={styles.head}>
          {unity.headshot
            ? <Image source={{ uri: unity.headshot }} style={styles.headImage} contentFit="cover" />
            : <SymbolView name="person.fill" size={44} tintColor="#8E8E93" />}
        </View>
        <View style={styles.names}>
          <Text style={styles.name} numberOfLines={1}>{session!.username}</Text>
          <Text style={styles.handle} numberOfLines={1}>@{session!.username}</Text>
        </View>
      </View>

      </View>
      <View style={wide ? { flex: 1 } : undefined}>
      <Text style={[styles.section, wide && { marginTop: 0 }]}>Games</Text>
      {games === null && !error ? (
        <ActivityIndicator color="#fff" style={{ marginTop: 24 }} />
      ) : error ? (
        <Text style={styles.empty}>{`Couldn't load your games: ${error}`}</Text>
      ) : games!.length === 0 ? (
        <Text style={styles.empty}>{"You haven't made any games yet."}</Text>
      ) : (
        <FlatList
          horizontal
          data={games ?? []}
          keyExtractor={g => String(g.id)}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, gap: 14 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/game/${item.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.title}`}
              style={({ pressed }) => [styles.tile, pressed && { opacity: 0.75 }]}
            >
              <View style={[styles.tileArt, { backgroundColor: GENRE_COLORS[item.genre.toLowerCase()] ?? '#3A3A3C' }]}>
                {item.thumbnailUrl
                  ? <Image source={{ uri: item.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  : <SymbolView name="gamecontroller.fill" size={40} tintColor="rgba(255,255,255,0.85)" />}
              </View>
              <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
            </Pressable>
          )}
        />
      )}
      </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  split: { flexDirection: 'row', gap: 8, flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 },
  card: {
    marginHorizontal: 20,
    aspectRatio: 1.24,
    borderRadius: CARD_RADIUS,
    backgroundColor: AVATAR_BACKDROP,
    overflow: 'hidden',
  },
  slot: { position: 'absolute', left: 0, right: 0, top: 0, bottom: HEAD_SIZE / 2 + 6 },
  identity: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: -HEAD_SIZE / 2,
    paddingHorizontal: 20,
    gap: 14,
  },
  head: {
    width: HEAD_SIZE,
    height: HEAD_SIZE,
    borderRadius: HEAD_SIZE / 2,
    backgroundColor: '#3A3A3C',
    borderWidth: 4,
    borderColor: '#000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headImage: { width: '100%', height: '100%' },
  names: { flex: 1, paddingBottom: 10 },
  name: { color: '#fff', fontSize: 30, fontWeight: '800' },
  handle: { color: '#8E8E93', fontSize: 16, marginTop: 2 },
  section: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 28, marginBottom: 14, paddingHorizontal: 20 },
  empty: { color: '#8E8E93', fontSize: 15, paddingHorizontal: 20 },
  tile: { width: 132 },
  tileArt: { width: 132, height: 132, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  tileTitle: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: 8 },
});
