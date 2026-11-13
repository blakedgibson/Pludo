import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import UnityView from '@azesmway/react-native-unity';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import { API_BASE } from '../api';
import { useAuth } from '../auth';
import { EditorChrome, type EditorCommand, type EditorState } from './EditorChrome';
import { GameHud, type HudActions, type HudState } from './GameHud';
import type { LogicCatalog } from './LogicEditor';

// One Unity instance for the whole app. UnityView unloads the engine when it
// unmounts, and iOS can't reliably start Unity again in the same process — so
// the view is mounted once at the root and only ever moved/hidden:
//
//   hidden  — parked behind the lobby, invisible and paused
//   avatar  — placed over a screen's avatar slot (profile card, customizer)
//   game    — full screen; ReactUnity draws the in-game HUD inside it
//   create  — full screen; ReactUnity's game creator (CreateScreen + editor)
//
// Messages to Unity go to the "NativeShell" GameObject (NativeShellBridge.cs);
// messages back arrive as JSON in onUnityMessage.

export type UnityMode = 'hidden' | 'avatar' | 'game' | 'create';

/** Where the avatar view sits, in window coordinates. */
export interface AvatarFrame {
  x: number; y: number; width: number; height: number;
  radius?: number;
  /** false = touches pass through to the native view underneath (eg. a card's
   *  onPress); true = Unity gets them (drag to spin). */
  interactive?: boolean;
  /** Backdrop colour Unity paints behind the chibi (#RRGGBB). */
  background?: string;
}

/** Default avatar backdrop — the colour of the native cards that frame it. */
export const AVATAR_BACKDROP = '#2C2C2E';

interface UnityHostApi {
  ready: boolean;
  mode: UnityMode;
  /** data: URI of the chibi's head, rendered by Unity (null until requested). */
  headshot: string | null;
  playGame: (gameId: number) => void;
  /** Place the avatar view for `owner`. The latest owner wins, so screens can
   *  hand the avatar over in either focus/blur order without hiding it. */
  showAvatar: (owner: string, frame: AvatarFrame) => void;
  hideAvatar: (owner: string) => void;
  requestHeadshot: () => void;
  /** Open the ReactUnity game editor full screen (needs a signed-in user):
   *  'new' creates a blank game and opens it; a game opens that game. Leaving
   *  the editor comes back to the native app. */
  openCreator: (target: 'new' | CreatorGame) => void;
}

/** The shape CreateScreen's editor expects (its GameStub). */
export interface CreatorGame {
  id: number; title: string; description: string; genre: string;
  plays: number; hasCode: boolean; thumbnailUrl: string;
}

const Ctx = createContext<UnityHostApi | null>(null);

export function useUnity(): UnityHostApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUnity must be used inside <UnityHost>');
  return v;
}

export function UnityHost({ children }: { children: React.ReactNode }) {
  const unityRef = useRef<UnityView>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<UnityMode>('hidden');
  const [gameStarted, setGameStarted] = useState(false);
  const [avatarFrame, setAvatarFrame] = useState<AvatarFrame>({ x: 0, y: 0, width: 0, height: 0 });
  const [headshot, setHeadshot] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<EditorState>({ active: false });
  // ReactUnity's asset library is open over the editor (native chrome hides).
  const [editorOverlay, setEditorOverlay] = useState(false);
  const [hudState, setHudState] = useState<HudState>({ active: false });
  const [logicCatalog, setLogicCatalog] = useState<LogicCatalog | null>(null);
  const queue = useRef<[string, string][]>([]);
  const readyRef = useRef(false);
  const avatarOwner = useRef<string | null>(null);
  const avatarFrameRef = useRef<AvatarFrame>({ x: 0, y: 0, width: 0, height: 0 });
  const creatorOpen = useRef(false);
  // True while a game or the editor owns the full screen. Set synchronously so
  // a screen regaining focus right after (eg. the drawer closing as Play/Edit
  // fires) can't pull Unity back into its avatar slot mid-launch.
  const fullScreenBusy = useRef(false);
  const { session } = useAuth();
  const insets = useSafeAreaInsets();

  const send = useCallback((method: string, arg = '') => {
    if (!readyRef.current) { queue.current.push([method, arg]); return; }
    unityRef.current?.postMessage('NativeShell', method, arg);
  }, []);

  const onUnityMessage = useCallback((e: { nativeEvent: { message: string } }) => {
    let msg: any;
    try { msg = JSON.parse(e.nativeEvent.message); } catch { return; }
    switch (msg.type) {
      case 'ready':
        readyRef.current = true;
        setReady(true);
        // The shell owns the environment: point Unity at the same API first.
        unityRef.current?.postMessage('NativeShell', 'Configure', JSON.stringify({ apiBaseUrl: API_BASE }));
        for (const [m, a] of queue.current) unityRef.current?.postMessage('NativeShell', m, a);
        queue.current = [];
        break;
      case 'gameStarted':
        setGameStarted(true);
        break;
      case 'gameExited':
        setGameStarted(false);
        setHudState({ active: false });
        // Play-testing from the editor returns to the editor.
        if (creatorOpen.current) { setMode('create'); break; }
        fullScreenBusy.current = false;
        // Back to wherever the user launched from.
        if (avatarOwner.current) {
          setMode('avatar');
          send('ShowAvatar', JSON.stringify({ background: avatarFrameRef.current.background ?? AVATAR_BACKDROP }));
        }
        else setMode('hidden');
        break;
      case 'editorState':
        setEditorState(msg as EditorState);
        break;
      case 'editorOverlay':
        setEditorOverlay(!!msg.open);
        break;
      case 'hudState':
        setHudState(msg as HudState);
        break;
      case 'logicCatalog':
        if (msg.catalog) setLogicCatalog(msg.catalog as LogicCatalog);
        break;
      case 'creatorClosed':
        setEditorState({ active: false });
        setEditorOverlay(false);
        creatorOpen.current = false;
        fullScreenBusy.current = false;
        if (avatarOwner.current) {
          setMode('avatar');
          send('ShowAvatar', JSON.stringify({ background: avatarFrameRef.current.background ?? AVATAR_BACKDROP }));
        } else setMode('hidden');
        break;
      case 'headshot':
        if (msg.dataUri) setHeadshot(msg.dataUri);
        break;
    }
  }, [send]);

  // The shell owns orientation: the native lobby is portrait; only a running
  // game may rotate (Unity's MobileOrientationManager then picks landscape).
  // Unity's own "back to portrait" request doesn't reach the host's scene, so
  // re-locking here is what actually brings the lobby upright again.
  useEffect(() => {
    if (mode === 'game' || mode === 'create') ScreenOrientation.unlockAsync().catch(() => {});
    else ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, [mode]);

  // Pause Unity whenever it's parked, so the hidden engine costs no GPU/CPU.
  // The pause is delayed: Unity finishes leaving a game over the next few
  // frames (eg. MobileOrientationManager commits the portrait lobby two frames
  // after ExitGame), and a paused engine never runs those frames.
  useEffect(() => {
    if (!ready) return;
    if (mode !== 'hidden') { unityRef.current?.pauseUnity(false); return; }
    const t = setTimeout(() => unityRef.current?.pauseUnity(true), 1500);
    return () => clearTimeout(t);
  }, [mode, ready]);

  // Unity's creator and game services use the native sign-in. Unity adopts
  // the tokens but never refreshes them (see AuthService.AdoptHostSession);
  // AuthProvider refreshes and this re-sends.
  useEffect(() => {
    if (!ready) return;
    send('SetSession', session ? JSON.stringify({
      userId: session.userId, username: session.username,
      accessToken: session.accessToken, refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    }) : '');
  }, [ready, session, send]);

  // Actions are stable (refs + setters only) so screens can depend on them
  // in focus effects without re-running every time Unity's mode changes.
  const playGame = useCallback((gameId: number) => {
    fullScreenBusy.current = true;
    setGameStarted(false);
    setMode('game');
    send('LaunchGame', String(gameId));
  }, [send]);

  const showAvatar = useCallback((owner: string, frame: AvatarFrame) => {
    const changedOwner = avatarOwner.current !== owner;
    avatarOwner.current = owner;
    avatarFrameRef.current = frame;
    setAvatarFrame(frame);
    // A game or the editor is on screen: just remember who wants the avatar;
    // gameExited / creatorClosed shows it again for them.
    if (fullScreenBusy.current) return;
    setMode(m => (m === 'game' || m === 'create' ? m : 'avatar'));
    // Re-frame in Unity when a new screen takes the avatar (its slot has a
    // different size); a re-measure of the same slot only moves the view.
    if (changedOwner) send('ShowAvatar', JSON.stringify({ background: frame.background ?? AVATAR_BACKDROP }));
  }, [send]);

  const hideAvatar = useCallback((owner: string) => {
    if (avatarOwner.current !== owner) return;   // someone else has it now
    avatarOwner.current = null;
    setMode(m => (m === 'avatar' ? 'hidden' : m));
    send('HideAvatar');
  }, [send]);

  const requestHeadshot = useCallback(() => send('RenderHeadshot'), [send]);

  const openCreator = useCallback((target: 'new' | CreatorGame) => {
    creatorOpen.current = true;
    fullScreenBusy.current = true;
    setMode('create');
    send('OpenCreator', target === 'new' ? 'new' : JSON.stringify(target));
  }, [send]);

  const editorCommand = useCallback((cmd: EditorCommand) => send('EditorCommand', cmd), [send]);

  // Native in-game HUD → Unity. Joystick moves are only sent when they change.
  const lastMove = useRef('');
  const hudActions = useMemo<HudActions>(() => ({
    command: cmd => send('HudCommand', cmd),
    move: (x, y) => {
      const v = `${x},${y}`;
      if (v === lastMove.current) return;
      lastMove.current = v;
      send('SetMove', v);
    },
    jump: () => send('Jump'),
  }), [send]);

  const api = useMemo<UnityHostApi>(() => ({
    ready, mode, headshot, playGame, showAvatar, hideAvatar, requestHeadshot, openCreator,
  }), [ready, mode, headshot, playGame, showAvatar, hideAvatar, requestHeadshot, openCreator]);

  const frameStyle =
    mode === 'game' || mode === 'create' ? StyleSheet.absoluteFill :
    mode === 'avatar' ? {
      position: 'absolute' as const,
      left: avatarFrame.x, top: avatarFrame.y, width: avatarFrame.width, height: avatarFrame.height,
      borderRadius: avatarFrame.radius ?? 0,
      overflow: 'hidden' as const,   // clips Unity's native view to the rounded card
    } : { position: 'absolute' as const, left: 0, top: 0, width: 1, height: 1, opacity: 0 };
  const unityTouches = mode === 'game' || mode === 'create' || (mode === 'avatar' && avatarFrame.interactive !== false);

  return (
    <Ctx.Provider value={api}>
      {children}
      <View style={frameStyle} pointerEvents={unityTouches ? 'auto' : 'none'}>
        <UnityView ref={unityRef} style={StyleSheet.absoluteFill} onUnityMessage={onUnityMessage} />
      </View>
      {/* Native editor toolbar over Unity's viewport (box-none: taps elsewhere
          reach Unity). Hidden while play-testing — the game HUD takes over. */}
      {mode === 'create' && editorState.active && !editorOverlay && !editorState.overlay && (
        <EditorChrome state={editorState} onCommand={editorCommand} catalog={logicCatalog} />
      )}
      {/* Native Liquid Glass in-game HUD (menu button, combined pause menu,
          joystick, jump) over the running game. */}
      {/* Lobby launches run in mode 'game'; editor play-tests stay in 'create'. */}
      {(mode === 'game' || mode === 'create') && hudState.active && <GameHud state={hudState} actions={hudActions} />}
      {/* Escape hatch while a game is still loading: if the launch fails
          before Unity's own HUD appears, the user isn't stranded. */}
      {mode === 'game' && !gameStarted && (
        <Pressable
          onPress={() => {
            send('ExitGame');
            fullScreenBusy.current = false;
            setMode(avatarOwner.current ? 'avatar' : 'hidden');
          }}
          style={[styles.closeWrap, { top: insets.top + 8 }]}
          accessibilityLabel="Cancel loading"
        >
          <GlassView style={styles.close} isInteractive>
            <SymbolView name="xmark" size={16} tintColor="#fff" />
          </GlassView>
        </Pressable>
      )}
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  closeWrap: { position: 'absolute', right: 16 },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

