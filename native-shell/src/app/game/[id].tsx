import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { Host, Menu, Button } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, labelStyle } from '@expo/ui/swift-ui/modifiers';
import { useAuth } from '../../auth';
import { fetchGameDetail, fetchSocial, toggleFavorite, type GameDetail } from '../../api';
import { isNotifying, setNotifying } from '../../notify';
import { useUnity } from '../../unity/UnityHost';

const GENRE_COLORS: Record<string, string> = {
  platformer: '#5B9CFF', simulation: '#30D158', adventure: '#FF8C00',
  racing: '#FF453A', puzzle: '#C7A4FF', shooter: '#FF375F',
};

// Game drawer: a native iOS sheet (Liquid Glass on iOS 26) opened by tapping a
// game anywhere in the app. Play at the bottom; the ••• button beside it opens
// a native glass menu: Notify, Favorite, Share, and Edit for the game's owner.
export default function GameSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gameId = Number(id);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const unity = useUnity();
  const { session, getAccessToken } = useAuth();

  const [game, setGame] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [likes, setLikes] = useState(0);
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchGameDetail(gameId)
      .then(g => { if (alive) setGame(g); })
      .catch(e => { if (alive) setError(String(e?.message ?? e)); });
    isNotifying(gameId).then(v => { if (alive) setNotify(v); });
    getAccessToken()
      .then(token => fetchSocial(gameId, token))
      .then(s => { if (alive) { setFavorite(s.likedByMe); setLikes(s.likes); } })
      .catch(() => { /* social counts are optional */ });
    return () => { alive = false; };
  }, [gameId, getAccessToken]);

  const owner = !!(session && game && game.createdByUserId && game.createdByUserId === session.userId);

  function play() {
    router.back();
    unity.playGame(gameId);
  }

  async function onToggleFavorite() {
    if (!session) { router.back(); router.navigate('/you'); return; }
    const token = await getAccessToken();
    if (!token) return;
    // Optimistic, then reconcile with the server's answer.
    setFavorite(f => !f);
    try {
      const s = await toggleFavorite(gameId, token, session.username);
      setFavorite(s.likedByMe);
      setLikes(s.likes);
    } catch { setFavorite(f => !f); }
  }

  async function onToggleNotify() {
    const next = !notify;
    setNotify(next);
    await setNotifying(gameId, next);
  }

  function onShare() {
    if (!game) return;
    // Apple's share sheet (UIActivityViewController).
    Share.share({
      title: game.title,
      message: `Play "${game.title}" on Pludo`,
      url: `pludoshell://game/${gameId}`,
    }).catch(() => {});
  }

  function onEdit() {
    if (!game) return;
    router.back();
    unity.openCreator({
      id: game.id, title: game.title, description: game.description, genre: game.genre,
      plays: game.plays, hasCode: game.hasCode, thumbnailUrl: game.thumbnailUrl,
    });
  }

  if (!game) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.muted}>{`Couldn't load this game: ${error}`}</Text> : <ActivityIndicator color="#fff" />}
      </View>
    );
  }

  const tint = GENRE_COLORS[game.genre.toLowerCase()] ?? '#5B9CFF';

  return (
    <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
      <View style={[styles.art, { backgroundColor: tint }]}>
        {game.thumbnailUrl
          ? <Image source={{ uri: game.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
          : <SymbolView name="gamecontroller.fill" size={56} tintColor="rgba(255,255,255,0.85)" />}
      </View>

      <Text style={styles.title} numberOfLines={2}>{game.title}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {[game.creatorName && `by ${game.creatorName}`, `${game.plays} plays`, `${likes} ♥`].filter(Boolean).join('  ·  ')}
      </Text>
      {!!game.description && <Text style={styles.description} numberOfLines={4}>{game.description}</Text>}

      <View style={{ flex: 1 }} />

      {/* Bottom bar: ••• menu, then Play. */}
      <View style={styles.actions}>
        <Host matchContents>
          <Menu
            label="More"
            systemImage="ellipsis"
            modifiers={[buttonStyle('glass'), labelStyle('iconOnly'), controlSize('extraLarge')]}
          >
            <Button
              label={notify ? 'Notifications On' : 'Notify'}
              systemImage={notify ? 'bell.fill' : 'bell'}
              onPress={onToggleNotify}
            />
            <Button
              label={favorite ? 'Unfavorite' : 'Favorite'}
              systemImage={favorite ? 'heart.fill' : 'heart'}
              onPress={onToggleFavorite}
            />
            <Button label="Share" systemImage="square.and.arrow.up" onPress={onShare} />
            {owner ? <Button label="Edit" systemImage="pencil" onPress={onEdit} /> : null}
          </Menu>
        </Host>
        <Pressable onPress={play} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`Play ${game.title}`}>
          <GlassView style={styles.play} glassEffectStyle="regular" tintColor={tint} isInteractive>
            <SymbolView name="play.fill" size={18} tintColor="#fff" />
            <Text style={styles.playText}>Play</Text>
          </GlassView>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: '#8E8E93', textAlign: 'center' },
  sheet: { flex: 1, paddingHorizontal: 20, paddingTop: 24 },
  art: { height: 190, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', marginTop: 16 },
  meta: { color: '#8E8E93', fontSize: 14, marginTop: 4 },
  description: { color: '#D1D1D6', fontSize: 15, lineHeight: 21, marginTop: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  play: { height: 56, borderRadius: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  playText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
