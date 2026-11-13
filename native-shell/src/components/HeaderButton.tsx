import React from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { Button, Host, Menu } from '@expo/ui/swift-ui';
import { buttonBorderShape, buttonStyle, controlSize, labelStyle } from '@expo/ui/swift-ui/modifiers';
import { createBlankGame } from '../api';
import { useAuth } from '../auth';
import { useUnity } from '../unity/UnityHost';

// Round Liquid Glass icon button used in the tab header rows.
export function HeaderButton({ sf, label, onPress }: { sf: string; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={label}>
      <GlassView style={styles.button} glassEffectStyle="regular" isInteractive>
        <SymbolView name={sf as any} size={20} weight="semibold" tintColor="#fff" />
      </GlassView>
    </Pressable>
  );
}

/** "Pludo" wordmark centred in a tab header row. Absolutely positioned across
 *  the row so it stays centred whatever buttons sit either side of it. */
export function HeaderTitle() {
  return (
    <Text style={styles.title} pointerEvents="none" accessibilityRole="header" numberOfLines={1}>
      Pludo
    </Text>
  );
}

/** "+" — asks for a name in a native (Liquid Glass) alert, creates the game,
 *  then opens it in the Unity editor. Signed-out users go to the You tab to
 *  sign in first. A name the server rejects re-opens the prompt with why. */
export function useOpenCreator() {
  const { session, getAccessToken } = useAuth();
  const { openCreator } = useUnity();
  const router = useRouter();

  function ask(message?: string, prefill = '') {
    Alert.prompt(
      'Name your game',
      message,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create Game',
          isPreferred: true,
          onPress: (name?: string) => { void create((name ?? '').trim()); },
        },
      ],
      'plain-text',
      prefill,
      'default',
      { userInterfaceStyle: 'dark' },
    );
  }

  async function create(name: string) {
    if (!session) return;
    try {
      const token = (await getAccessToken()) ?? session.accessToken;
      const id = await createBlankGame({
        title: name, username: session.username, userId: session.userId, accessToken: token,
      });
      openCreator({
        id, title: name || 'Untitled Game', description: '', genre: '',
        plays: 0, hasCode: true, thumbnailUrl: '',
      });
    } catch (e: any) {
      ask(String(e?.message ?? e), name);
    }
  }

  return () => (session ? ask() : router.navigate('/you'));
}

/** The header "+": a Liquid Glass dropdown — Create Game (name prompt →
 *  editor) or Create 3D Model (the Model Studio: build from parts, no AI).
 *  Signed-out users are sent to the You tab to sign in instead. */
export function CreateMenu() {
  const { session } = useAuth();
  const router = useRouter();
  const createGame = useOpenCreator();
  const { openStudio } = useUnity();
  return (
    <Host matchContents>
      <Menu
        label="Create"
        systemImage="plus"
        modifiers={[buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large')]}
      >
        <Button label="Create Game" systemImage="gamecontroller" onPress={createGame} />
        <Button
          label="Create 3D Model"
          systemImage="cube"
          onPress={() => (session ? openStudio() : router.navigate('/you'))}
        />
      </Menu>
    </Host>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  title: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: '#fff', fontSize: 22, fontWeight: '800', letterSpacing: 0.3,
  },
});
