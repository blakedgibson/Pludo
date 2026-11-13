import React, { useState, useEffect, useRef } from 'react';
import { C } from './theme';
import { safeAreaTop, safeAreaLeft, safeAreaRight, safeAreaBottom } from './safeArea';
import { FriendData, AssetItem } from './types';
import { BottomNav, NAV_FOOTPRINT } from './components/BottomNav';
import { isTablet, refScreenWidth, refScreenHeight } from './responsive';
import { HomeScreen }          from './screens/HomeScreen';
import { ExploreScreen }       from './screens/ExploreScreen';
import { CreateScreen }        from './screens/CreateScreen';
import { ChatScreen }          from './screens/ChatScreen';
import { AvatarScreen }        from './screens/AvatarScreen';
import { PublicProfileScreen } from './screens/PublicProfileScreen';
import { SettingsScreen }      from './screens/SettingsScreen';
import { ShopScreen }          from './screens/ShopScreen';
import { AuthScreen }          from './screens/AuthScreen';
import { GamePreviewScreen }   from './screens/GamePreviewScreen';
import { GameData }            from './types';
import {
  IfaceElement, IfaceWorkflow, IfaceStep,
  migrateHudButtonsToInterface, isMaterialIconName,
} from './interfaceModel';
import { GlassButton } from './components/GlassButton';
import { glass } from './glass';

// Bottom-nav tab indices:
//   0 Home | 1 Explore | 2 Create | 3 Chat | 4 Avatar
const AVATAR_TAB = 4;

// Avatar sub-sections (navigated by swipe within tab 4):
//   0 = Avatar Editor | 1 = Public Profile | 2 = Settings
type AvatarSection = 0 | 1 | 2;

// ── In-game HUD overlay ───────────────────────────────────────────────────────
// Renders transparent over the live 3D Unity scene.
// Polls Globals for score/timer/message set by LuauGameRunner.

function GameHUD({ onExit }: { onExit: () => void }) {
  // Native shell: the top-left cluster, quick tray, chat window, pause menu
  // and the joystick/jump controls are drawn natively (Liquid Glass) over
  // Unity's view. This HUD reports their state and runs the commands they send.
  const [hosted] = useState(() => {
    try { return String((Globals as any).getHostMode?.() ?? '') === 'native'; } catch { return false; }
  });
  const [score,        setScore]        = useState('');
  const [timer,        setTimer]        = useState('');
  const [health,       setHealth]       = useState('');
  const [showHealth,   setShowHealth]   = useState(false);
  const [message,      setMessage]      = useState('');
  const [title,        setTitle]        = useState('');
  const [subtitle,     setSubtitle]     = useState('');
  const [shiftLock,    setShiftLock]    = useState(false);
  const [popupTitle,   setPopupTitle]   = useState('');
  const [popupBody,    setPopupBody]    = useState('');
  const [popupBtn,     setPopupBtn]     = useState('');
  const [flashColor,   setFlashColor]   = useState('');
  // ── Toolbar state ─────────────────────────────────────────────────────────
  // Parsed from C# Globals._gameToolbar — JSON { tools: [...], equipped: "" }
  // pushed by GameRenderClient whenever the server's diff carries a `toolbar`
  // field (UI.SetToolbar / UI.SetEquippedTool from the Lua side).
  type ToolSlot = { name: string; icon?: string; key: string; cost?: number; color?: string };
  const [toolbar, setToolbar] = useState<{ tools: ToolSlot[]; equipped: string }>({ tools: [], equipped: '' });
  const lastToolbarJSON = useRef('');
  // ── Chat state ────────────────────────────────────────────────────────────
  // chatLog is parsed from C# Globals._chatLog (JSON array of {clientId,
  // username, text, ts}). chatOpen is driven by the Chat button in the
  // top-left cluster (closed by default, like Roblox). chatInput is the
  // in-flight text the user is typing. chatError surfaces a brief toast when
  // the server rejects a message (rate-limit, profanity, etc).
  const [chatLog,      setChatLog]      = useState<Array<{clientId:string;username:string;text:string;ts:number}>>([]);
  const [chatOpen,     setChatOpen]     = useState(false);
  const [chatInput,    setChatInput]    = useState('');
  const [chatError,    setChatError]    = useState('');
  // ── Roblox-style top-left cluster ─────────────────────────────────────────
  // Exactly three buttons live in the top-left corner during play:
  //   [main menu]  [hamburger]  [chat]
  // • main menu  → full-screen pause menu (Resume / Reset / Shift Lock / Leave)
  // • hamburger  → quick-actions tray that drops under the bar
  // • chat       → chat window that drops under the bar
  // Only one of the two drop-downs is open at a time so they never stack.
  const [mainMenuOpen, setMainMenuOpen] = useState(false);
  const [trayOpen,     setTrayOpen]     = useState(false);
  // Roster for the tray's player list — published by GameRenderClient as
  // Globals._playerList (JSON array of { username, local }). Empty in local
  // single-player sessions, where the tray falls back to a lone "You" row.
  const [players,      setPlayers]      = useState<Array<{username:string;local?:boolean}>>([]);
  const lastPlayersJSON = useRef('');
  const lastChatJSON  = useRef('');
  const escapeSignalSeen = useRef(false);
  // ── Interface Builder — elements + workflows ──────────────────────────────
  // Editor-authored via CreateScreen.tsx's Interface Builder. Polled from
  // _interfaceElements/_interfaceWorkflows globals (JSON, set by
  // GameRenderClient at session start from SceneSettings). Falls back to
  // migrating _hudButtons on the fly for old games that were published before
  // the builder existed and never got reopened in the editor (which would
  // otherwise have triggered the one-time save-side migration).
  const [interfaceElements,  setInterfaceElements]  = useState<IfaceElement[]>([]);
  const [interfaceWorkflows, setInterfaceWorkflows] = useState<IfaceWorkflow[]>([]);
  const [panelVisibility,    setPanelVisibility]    = useState<Record<string, boolean>>({});
  const [ifaceToast,         setIfaceToast]         = useState('');
  // Legacy sentinel — old "Leaderboard" HUD buttons migrate to a
  // fireCustomEvent('__openLeaderboard') step. '__openLeaderboard' was never a
  // real script event, so it's special-cased in runInterfaceWorkflow below
  // instead of being shipped to Lua.
  const [showLeaderboard,    setShowLeaderboard]    = useState(false);
  const lastIfaceElJSON = useRef('');
  const lastIfaceWfJSON = useRef('');
  const ifaceRuntimeMigratedRef = useRef(false);
  const interfaceWorkflowsRef = useRef<IfaceWorkflow[]>([]);
  interfaceWorkflowsRef.current = interfaceWorkflows;

  useEffect(() => {
    const t = setInterval(() => {
      try {
        setScore(   String((Globals as any)._gameScore    ?? ''));
        setTimer(   String((Globals as any)._gameTimer    ?? ''));
        setMessage( String((Globals as any)._gameMessage  ?? ''));
        setTitle(   String((Globals as any)._gameTitle    ?? ''));
        setSubtitle(String((Globals as any)._gameSubtitle ?? ''));
        setPopupTitle(String((Globals as any)._popupTitle ?? ''));
        setPopupBody( String((Globals as any)._popupBody  ?? ''));
        setPopupBtn(  String((Globals as any)._popupBtn   ?? ''));
        const hp = String((Globals as any)._gameHealth ?? '');
        setHealth(hp);
        setShowHealth(hp !== '' && hp !== '100');
        setFlashColor(String((Globals as any)._flashColor ?? ''));

        // Swipe-from-left → C# fires PauseRequested → sets _showEscape = "true".
        // Same gesture as Roblox's Escape key: it opens the main menu. Edge-
        // detected so the menu can still be dismissed while the signal is
        // latched high (closing calls resumeGame, which clears it).
        const escActive = String((Globals as any)._showEscape ?? '') === 'true';
        if (escActive && !escapeSignalSeen.current) {
          escapeSignalSeen.current = true;
          setMainMenuOpen(true);
          setTrayOpen(false);
        } else if (!escActive && escapeSignalSeen.current) {
          escapeSignalSeen.current = false;
        }

        const sl = String((Globals as any)._shiftLock ?? '') === 'true';
        setShiftLock(sl);

        // Toolbar: same dedup-on-raw-JSON pattern as the chat log. C# pushes
        // an empty array on session start/end so old toolbars don't bleed
        // across game sessions.
        const rawTb = String((Globals as any)._gameToolbar ?? '');
        if (rawTb !== lastToolbarJSON.current) {
          lastToolbarJSON.current = rawTb;
          if (!rawTb) {
            setToolbar({ tools: [], equipped: '' });
          } else {
            try {
              const tb = JSON.parse(rawTb);
              setToolbar({
                tools:    Array.isArray(tb?.tools) ? tb.tools : [],
                equipped: typeof tb?.equipped === 'string' ? tb.equipped : '',
              });
            } catch { /* ignore malformed payload */ }
          }
        }

        // Interface Builder elements/workflows — pushed once at session start.
        const rawIfaceEl = String((Globals as any)._interfaceElements ?? '');
        const rawIfaceWf = String((Globals as any)._interfaceWorkflows ?? '');
        if (rawIfaceEl !== lastIfaceElJSON.current || rawIfaceWf !== lastIfaceWfJSON.current) {
          lastIfaceElJSON.current = rawIfaceEl;
          lastIfaceWfJSON.current = rawIfaceWf;
          let els: IfaceElement[] = [];
          let wfs: IfaceWorkflow[] = [];
          try { els = rawIfaceEl ? JSON.parse(rawIfaceEl) : []; } catch { /* ignore */ }
          try { wfs = rawIfaceWf ? JSON.parse(rawIfaceWf) : []; } catch { /* ignore */ }
          if (els.length === 0 && !ifaceRuntimeMigratedRef.current) {
            const rawHb = String((Globals as any)._hudButtons ?? '');
            if (rawHb) {
              try {
                const btns = JSON.parse(rawHb);
                if (Array.isArray(btns) && btns.length > 0) {
                  const migrated = migrateHudButtonsToInterface(btns);
                  els = migrated.elements;
                  wfs = migrated.workflows;
                }
              } catch { /* ignore */ }
            }
          }
          ifaceRuntimeMigratedRef.current = true;
          setInterfaceElements(els);
          setInterfaceWorkflows(wfs);
          setPanelVisibility(Object.fromEntries(els.filter(e => e.kind === 'panel').map(e => [e.id, e.visible])));
        }

        // Player roster — republished only when someone joins or leaves, so
        // dedupe on the raw string like the chat log does.
        const rawPl = String((Globals as any)._playerList ?? '');
        if (rawPl !== lastPlayersJSON.current) {
          lastPlayersJSON.current = rawPl;
          try { setPlayers(rawPl ? JSON.parse(rawPl) : []); } catch { setPlayers([]); }
        }

        // Chat log: only re-parse when the JSON actually changes. The C# side
        // re-publishes the full log on every received chat message, so we
        // dedupe on the raw string to avoid parsing a 50-entry JSON 10×/sec.
        const rawLog = String((Globals as any)._chatLog ?? '');
        if (rawLog && rawLog !== lastChatJSON.current) {
          lastChatJSON.current = rawLog;
          try { setChatLog(JSON.parse(rawLog)); } catch { /* ignore */ }
        }
        // Chat error toast — auto-clears after a short window so we don't
        // wedge a stale rate-limit warning on screen.
        const ce = String((Globals as any)._chatError ?? '');
        if (ce) {
          setChatError(ce);
          try { (Globals as any)._chatError = ''; } catch { /* no-op */ }
        }
      } catch { /* renderer not ready yet */ }
    }, 100);
    return () => clearInterval(t);
  }, []);

  // Auto-clear chat error after 3s so it behaves like a transient toast.
  useEffect(() => {
    if (!chatError) return;
    const t = setTimeout(() => setChatError(''), 3000);
    return () => clearTimeout(t);
  }, [chatError]);

  // Runs an interface element's "On Tap" step list in order. Deliberately
  // small vocabulary (see IFACE_ACTION_META in interfaceModel.ts) — panel
  // visibility and toasts are handled entirely client-side here; fireCustomEvent
  // is the only step that leaves React, reusing the same Globals.fireHudEvent
  // bridge the old HudButton action="event" used (→ Lua Interface.OnButton).
  async function runInterfaceWorkflow(elementId: string) {
    const wf = interfaceWorkflowsRef.current.find(w => w.elementId === elementId && w.enabled);
    if (!wf) return;
    for (const step of wf.steps as IfaceStep[]) {
      if (!step.enabled) continue;
      switch (step.type) {
        case 'openPanel':
          if (step.params.targetId) setPanelVisibility(v => ({ ...v, [step.params.targetId]: true }));
          break;
        case 'closePanel':
          if (step.params.targetId) setPanelVisibility(v => ({ ...v, [step.params.targetId]: false }));
          break;
        case 'togglePanel':
          if (step.params.targetId) {
            const id = step.params.targetId;
            setPanelVisibility(v => ({ ...v, [id]: !v[id] }));
          }
          break;
        case 'showToast': {
          const text = String(step.params.text ?? '');
          if (text) {
            setIfaceToast(text);
            setTimeout(() => setIfaceToast(t => (t === text ? '' : t)), 2500);
          }
          break;
        }
        case 'fireCustomEvent': {
          const name = String(step.params.eventName ?? '');
          if (!name) break;
          if (name === '__openLeaderboard') setShowLeaderboard(true);
          else { try { (Globals as any).fireHudEvent?.(name); } catch { /* no-op */ } }
          break;
        }
        case 'playSound':
          // No sound-asset pipeline wired up yet — placeholder so the step
          // type/UI exist without another schema migration once one lands.
          break;
        case 'wait':
          await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(step.params.ms) || 0)));
          break;
      }
    }
  }

  // ── Native shell bridge ──────────────────────────────────────────────────
  const hostRoster = players.length > 0 ? players : [{ username: 'You', local: true }];
  const hostStateJson = JSON.stringify({
    players: hostRoster, score, shiftLock, chatLog: chatLog.slice(-50), chatError,
    health: showHealth ? Number(health) || 0 : null, popup: !!popupTitle,
  });
  useEffect(() => {
    if (!hosted) return;
    try { (Globals as any).notifyHost?.(JSON.stringify({ type: 'hudState', active: true, ...JSON.parse(hostStateJson) })); } catch {}
  }, [hosted, hostStateJson]);
  useEffect(() => {
    if (!hosted) return;
    return () => { try { (Globals as any).notifyHost?.(JSON.stringify({ type: 'hudState', active: false })); } catch {} };
  }, [hosted]);
  const hudCommandRef = useRef<(raw: string) => void>(() => {});
  useEffect(() => {
    hudCommandRef.current = (raw: string) => {
      const sep = raw.indexOf(':');
      const cmd = sep < 0 ? raw : raw.slice(0, sep);
      const arg = sep < 0 ? '' : raw.slice(sep + 1);
      switch (cmd) {
        case 'pause':     try { (Globals as any).pauseGame?.(); } catch {} return;
        case 'resume':    try { (Globals as any).resumeGame?.(); } catch {} return;
        case 'reset':     resetSpawn(); return;
        case 'shiftLock': toggleSL(); return;
        case 'chat':      if (arg.trim()) { try { (Globals as any).sendChat?.(arg.trim().slice(0, 200)); } catch {} } return;
        case 'leave':     leaveGame(); return;
      }
    };
  });
  useEffect(() => {
    if (!hosted) return;
    const t = setInterval(() => {
      try {
        const cmd = String((Globals as any).takeHudCommand?.() ?? '');
        if (cmd) hudCommandRef.current(cmd);
      } catch { /* bridge not ready */ }
    }, 50);
    return () => clearInterval(t);
  }, [hosted]);

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    try { (Globals as any).sendChat?.(text); } catch { /* no-op */ }
    setChatInput('');
  }

  function resetSpawn() {
    try { (Globals as any).resetPlayer?.(); } catch { /* no-op */ }
  }

  function toggleSL() {
    try { (Globals as any).toggleShiftLock?.(); } catch { /* no-op */ }
  }

  function leaveGame() {
    setMainMenuOpen(false);
    setTrayOpen(false);
    onExit();
  }

  // ── Top-left cluster button handlers ──────────────────────────────────────
  // Opening the main menu pauses like Roblox does: the joystick is hidden and
  // the world keeps running behind the dim. `pauseGame`/`resumeGame` are the
  // C# side of that (they also drive _showEscape, which is what the
  // swipe-from-left gesture sets). Both drop-downs close so the pause overlay
  // is the only thing on screen.
  function openMainMenu() {
    setTrayOpen(false);
    setChatOpen(false);
    setMainMenuOpen(true);
    try { (Globals as any).pauseGame?.(); } catch { /* no-op */ }
  }

  function closeMainMenu() {
    setMainMenuOpen(false);
    try { (Globals as any).resumeGame?.(); } catch { /* no-op */ }
  }

  function toggleTray() {
    setTrayOpen(o => {
      if (!o) setChatOpen(false);
      return !o;
    });
  }

  function toggleChat() {
    setChatOpen(o => {
      if (!o) setTrayOpen(false);
      return !o;
    });
  }

  // ── Quick-actions tray — drops under the three-button bar ─────────────────
  // The hamburger's panel: who's in the session, the current score, and the
  // two toggles a player reaches for mid-game (reset character, shift lock).
  // Deliberately does NOT carry Leave Game — that lives in the main menu, so
  // the destructive action is never one stray tap away from the HUD.
  function renderQuickTray() {
    const rowStyle: any = {
      flexDirection: 'row', alignItems: 'center',
      paddingTop: 8, paddingBottom: 8, paddingLeft: 9, paddingRight: 9,
      borderWidth: 0, backgroundColor: 'rgba(0,0,0,0)',
    };
    const rowLabel: any = { color: '#fff', fontSize: 12, flex: 1 };
    const pillOn:  any = { backgroundColor: C.primary,                borderRadius: 6, paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 };
    const pillOff: any = { backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 6, paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 };
    const divider = <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginLeft: 9 }} />;
    // Local session (LuauGameRunner) never publishes a roster — show the one
    // player who is definitely here rather than an empty list.
    const roster = players.length > 0 ? players : [{ username: 'You', local: true }];
    return (
      <view style={{
        width: 240,
        ...glass({ fill: 'rgba(20,20,22,0.86)' }), borderRadius: 12,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
        flexDirection: 'column', gap: 6,
      }}>
        {/* Players — Roblox's leaderboard, with the score column filled from
            the game's own score global when the game keeps one. */}
        <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 1 }}>
          <icon set="material-rounded" style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', lineHeight: 14 }}>group</icon>
          <text style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontWeight: 'bold', flex: 1 }}>PLAYERS</text>
          <text style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontWeight: 'bold' }}>{roster.length}</text>
        </view>
        {/* One scroll for the whole body (roster + toggles) rather than a
            roster scroll nested inside the panel: play runs in landscape,
            where the canvas is only ~390 reference units tall, so the tray
            has to stay short enough to clear the bottom-left joystick no
            matter how many players are in the room. */}
        <scroll className="pludo-chat-scroll" style={{ maxHeight: 150 }}>
          <view style={{ flexDirection: 'column', gap: 6 }}>
            <view style={{
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
              overflow: 'hidden', flexDirection: 'column',
            }}>
              {roster.map((p, i) => (
                <view key={`${p.username}-${i}`} style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  paddingTop: 6, paddingBottom: 6, paddingLeft: 9, paddingRight: 9,
                  borderTopWidth: i === 0 ? 0 : 1, borderColor: 'rgba(255,255,255,0.06)',
                }}>
                  <text style={{
                    fontSize: 12, flex: 1, fontWeight: p.local ? 'bold' : 'normal',
                    color: p.local ? '#7dd3fc' : '#fff',
                  }}>{p.username}</text>
                  {p.local && score ? (
                    <text style={{ fontSize: 12, color: '#fcd34d', fontWeight: 'bold' }}>{score}</text>
                  ) : null}
                </view>
              ))}
            </view>

            {/* Toggles */}
            <view style={{
              backgroundColor: 'rgba(255,255,255,0.04)',
              borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
              overflow: 'hidden',
            }}>
              <GlassButton onClick={resetSpawn} style={rowStyle}>
                <text style={rowLabel}>Reset Character</text>
                <icon set="material-rounded" style={{ fontSize: 15, color: 'rgba(255,255,255,0.5)', lineHeight: 15 }}>refresh</icon>
              </GlassButton>
              {divider}
              <GlassButton onClick={toggleSL} style={rowStyle}>
                <text style={rowLabel}>Shift Lock</text>
                <view style={shiftLock ? pillOn : pillOff}>
                  <text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>{shiftLock ? 'ON' : 'OFF'}</text>
                </view>
              </GlassButton>
              {divider}
              <GlassButton onClick={toggleChat} style={rowStyle}>
                <text style={rowLabel}>Show Chat</text>
                <view style={chatOpen ? pillOn : pillOff}>
                  <text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>{chatOpen ? 'ON' : 'OFF'}</text>
                </view>
              </GlassButton>
            </view>
          </view>
        </scroll>
      </view>
    );
  }

  // ── Chat window — drops under the three-button bar ────────────────────────
  // Message backlog + composer. Width matches the tray so the two drop-downs
  // read as the same surface; the log is height-capped so a long backlog can
  // never reach the bottom-left joystick.
  function renderChatWindow() {
    return (
      <view style={{
        width: 240,
        ...glass({ fill: 'rgba(20,20,22,0.86)' }), borderRadius: 12,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
        flexDirection: 'column',
      }}>
        {/* Same landscape height budget as the tray — cap the backlog so the
            window's bottom edge stays clear of the joystick. */}
        <scroll className="pludo-chat-scroll" style={{ maxHeight: 110 }}>
          <view style={{ flexDirection: 'column' }}>
            {chatLog.length === 0 ? (
              <text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, fontStyle: 'italic', paddingTop: 4, paddingBottom: 4 }}>
                Say hi to other players…
              </text>
            ) : null}
            {chatLog.map((m, i) => (
              <view key={`${m.ts}-${i}`} style={{ flexDirection: 'row', flexWrap: 'wrap', paddingTop: 2, paddingBottom: 2 }}>
                <text style={{ color: '#7dd3fc', fontSize: 12, fontWeight: 'bold' }}>{m.username}: </text>
                <text style={{ color: '#fff', fontSize: 12, flexShrink: 1 }}>{m.text}</text>
              </view>
            ))}
          </view>
        </scroll>
        <view style={{
          flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6,
          backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 8,
          paddingLeft: 10, paddingRight: 6, paddingTop: 4, paddingBottom: 4,
        }}>
          <input
            value={chatInput}
            onChange={(e: any) => setChatInput(e?.target?.value ?? e)}
            placeholder="Type a message…"
            maxLength={200}
            style={{
              flex: 1, fontSize: 12, color: '#fff',
              backgroundColor: 'transparent', borderWidth: 0, minHeight: 24,
            }}
          />
          <GlassButton onClick={sendChat} style={{
            backgroundColor: C.primary, borderRadius: 6, borderWidth: 0,
            paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4,
          }}>
            <text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>SEND</text>
          </GlassButton>
        </view>
        {chatError ? (
          <text style={{ color: '#ff453a', fontSize: 11, marginTop: 4 }}>{chatError}</text>
        ) : null}
      </view>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <view style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0)', pointerEvents: 'box-none' as any }}>

      {/* HUD — transparent so 3D game shows through.
          The top-left corner is reserved for the chat panel; score, timer
          and the health bar were previously here but have been relocated:
            - score + timer  → top-right column, near the top edge
            - health bar     → bottom-left, out of the chat's vertical column
          so the chat sits cleanly in the top-left with nothing competing
          for that real estate. */}
      <view style={{ flex: 1, flexDirection: 'column', backgroundColor: 'rgba(0,0,0,0)', pointerEvents: 'box-none' as any }}>

        {/* Timer — top-right corner. Score chip removed by request; timer
            still rendered when the game sets one. */}
        {timer ? (
          <view style={{
            position: 'absolute',
            top: safeAreaTop(), right: safeAreaRight(),
            alignItems: 'flex-end',
            pointerEvents: 'box-none' as any,
          }}>
            <view style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12, paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7 }}>
              <text style={{ color: '#fff', fontWeight: 'bold', fontSize: 15 }}>{timer}</text>
            </view>
          </view>
        ) : null}

        {/* Title overlay — vertically centered for big start/end banners. */}
        <view style={{ flex: 1, alignItems: 'center', justifyContent: 'center', pointerEvents: 'box-none' as any }}>
          {title ? (
            <view style={{ backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 18, paddingLeft: 28, paddingRight: 28, paddingTop: 18, paddingBottom: 18, marginBottom: 12 }}>
              <text style={{ color: '#fff', fontWeight: 'bold', fontSize: 24, textAlign: 'center' }}>{title}</text>
              {subtitle ? (
                <text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14, textAlign: 'center', marginTop: 6 }}>{subtitle}</text>
              ) : null}
            </view>
          ) : null}
        </view>

        {/* In-game message overlay — anchored to TOP of screen so transient
            gameplay messages ("Cell occupied!", "Wave 1 incoming") don't
            cover the player. Sits below the iPhone notch / status bar. */}
        {message ? (
          <view style={{
            position: 'absolute', top: 64, left: 0, right: 0,
            alignItems: 'center', pointerEvents: 'box-none' as any,
          }}>
            <view style={{ backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 14, paddingLeft: 22, paddingRight: 22, paddingTop: 12, paddingBottom: 12 }}>
              <text style={{ color: '#fff', fontSize: 17, textAlign: 'center', fontWeight: 'bold' }}>{message}</text>
            </view>
          </view>
        ) : null}

        {/* Health bar has moved into the chat panel's header row, sitting
            next to the hamburger icon. See the chat panel block below. */}

      </view>

      {/* Game popup (win/lose) — rendered over the HUD */}
      {popupTitle ? (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.65)',
        }}>
          <view style={{
            width: '80%',
            ...glass({ fill: 'rgba(18,18,24,0.98)' }),
            borderRadius: 26,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
            overflow: 'hidden',
            paddingLeft: 28, paddingRight: 28, paddingTop: 32, paddingBottom: 28,
            alignItems: 'center',
          }}>
            <text style={{ fontSize: 22, color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 12 }}>
              {popupTitle}
            </text>
            {popupBody ? (
              <text style={{ fontSize: 14, color: 'rgba(255,255,255,0.65)', textAlign: 'center', marginBottom: 24, lineHeight: 20 }}>
                {popupBody}
              </text>
            ) : null}
            {popupBtn ? (
              <GlassButton onClick={() => {
                try { (Globals as any).restartGame?.(); } catch { /* no-op */ }
              }} style={{
                backgroundColor: C.primary, borderRadius: 16, borderWidth: 0,
                paddingTop: 16, paddingBottom: 16, paddingLeft: 32, paddingRight: 32,
                alignItems: 'center', justifyContent: 'center', marginBottom: 10, width: '100%',
              }}>
                <text style={{ fontSize: 16, color: '#fff', fontWeight: 'bold' }}>{popupBtn}</text>
              </GlassButton>
            ) : null}
            <GlassButton onClick={() => {
              try { (Globals as any).exitGame?.(); } catch { /* no-op */ }
              onExit();
            }} style={{
              backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, borderWidth: 0,
              paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24,
              alignItems: 'center', justifyContent: 'center', width: '100%',
            }}>
              <text style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>Leave Game</text>
            </GlassButton>
          </view>
        </view>
      ) : null}

      {/* Screen flash (Effects.Flash) — brief colored overlay */}
      {flashColor ? (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: flashColor,
          opacity: 0.35,
          pointerEvents: 'none' as any,
        }} />
      ) : null}

      {/* Damage vignette — inset red box-shadow whose blur / spread / alpha
          scale linearly with damage (1 - hp/100). Same gate as the health
          bar, so it disappears at full health. pointerEvents none so it
          never absorbs taps. */}
      {showHealth ? (() => {
        const damage = Math.max(0, Math.min(1, (100 - (Number(health) || 0)) / 100));
        const blur   = Math.round(140 * damage);
        const spread = Math.round(70  * damage);
        const alpha  = (0.85 * damage).toFixed(2);
        return (
          <view style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            pointerEvents: 'none' as any,
            boxShadow: `inset 0 0 ${blur}px ${spread}px rgba(255,0,0,${alpha})`,
          }} />
        );
      })() : null}

      {/* ── Roblox-style top-left cluster ───────────────────────────────────
          One pill holding exactly three buttons — main menu, hamburger, chat
          — pinned to the top-left safe-area corner, with the health bar and
          whichever drop-down is open stacked underneath it. Nothing else the
          HUD owns lives in this corner. Scrollbars inside the drop-downs are
          suppressed via a scoped ::scrollbar { width: 0 } (same pattern used
          in ExploreScreen / CreateScreen). */}
      {!popupTitle && !hosted ? (
        <>
          {React.createElement('style', { scope: ':root' }, `
            .pludo-chat-scroll::scrollbar, .pludo-chat-scroll::scrollbar-thumb { width: 0; height: 0; background-color: rgba(0,0,0,0); }
          `)}
          <view style={{
            position: 'absolute',
            top: safeAreaTop(), left: safeAreaLeft(),
            flexDirection: 'column', gap: 6,
            pointerEvents: 'box-none' as any,
          }}>
            {/* The bar itself. Fixed 44 height matches the editor's top-left
                chrome so the two modes line up when you play-test out of the
                editor and come back. */}
            <view style={{
              flexDirection: 'row', alignItems: 'center',
              height: 44,
              ...glass({ radius: 22, floating: true }),
              paddingLeft: 5, paddingRight: 5, gap: 2,
            }}>
              {/* 1 — Main menu (Roblox's logo button): pauses and opens the
                     full-screen menu. */}
              <GlassButton onClick={openMainMenu} style={{
                width: 38, height: 34, borderRadius: 17, borderWidth: 0,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: mainMenuOpen ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
              }}>
                <icon set="material-rounded-filled" style={{ fontSize: 20, lineHeight: 20, color: mainMenuOpen ? C.blue : '#fff' }}>sports_esports</icon>
              </GlassButton>
              <view style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.10)' }} />
              {/* 2 — Hamburger: quick-actions tray. */}
              <GlassButton onClick={toggleTray} style={{
                width: 38, height: 34, borderRadius: 17, borderWidth: 0,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: trayOpen ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
              }}>
                <icon set="material-rounded" style={{ fontSize: 20, lineHeight: 20, color: trayOpen ? C.blue : '#fff' }}>{trayOpen ? 'close' : 'menu'}</icon>
              </GlassButton>
              <view style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.10)' }} />
              {/* 3 — Chat: the message window. */}
              <GlassButton onClick={toggleChat} style={{
                width: 38, height: 34, borderRadius: 17, borderWidth: 0,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: chatOpen ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
              }}>
                <icon set={chatOpen ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 19, lineHeight: 19, color: chatOpen ? C.blue : '#fff' }}>chat_bubble</icon>
              </GlassButton>
            </view>

            {/* Health bar — sits directly under the bar (where Roblox puts
                it) instead of competing for space inside it. Only rendered
                once the player has taken damage. */}
            {showHealth ? (
              <view style={{
                width: 148, flexDirection: 'row', alignItems: 'center', gap: 6,
                ...glass({ fill: 'rgba(20,20,22,0.78)' }), borderRadius: 8,
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
                paddingLeft: 8, paddingRight: 8, paddingTop: 5, paddingBottom: 5,
              }}>
                <text style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontWeight: 'bold' }}>HP</text>
                <view style={{ flex: 1, height: 6, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, overflow: 'hidden' }}>
                  <view style={{
                    height: '100%', borderRadius: 3,
                    width: `${Math.max(0, Math.min(100, Number(health) || 0))}%`,
                    backgroundColor: Number(health) > 50 ? '#30d158'
                                   : Number(health) > 25 ? '#ff9f0a'
                                   :                       '#ff453a',
                  }} />
                </view>
                <text style={{ fontSize: 10, color: '#fff', fontWeight: 'bold', minWidth: 18, textAlign: 'right' as any }}>{health}</text>
              </view>
            ) : null}

            {/* Drop-downs — mutually exclusive, so the column never grows
                past one panel's height. */}
            {trayOpen ? renderQuickTray() : chatOpen ? renderChatWindow() : null}
          </view>
        </>
      ) : null}

      {/* ── Main menu — the Roblox pause overlay ────────────────────────────
          Full-screen dim over the still-running world. Resume closes it and
          calls resumeGame(), which restores the joystick and clears the
          _showEscape latch set by either pauseGame() or the swipe gesture. */}
      {mainMenuOpen && !popupTitle && !hosted ? (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.65)',
        }}>
          <view style={{
            width: '78%', maxWidth: 380,
            ...glass({ radius: 30, floating: true, fill: 'rgba(28,28,32,0.86)' }),
            paddingLeft: 22, paddingRight: 22, paddingTop: 22, paddingBottom: 20,
            flexDirection: 'column', gap: 10,
          }}>
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <icon set="material-rounded-filled" style={{ fontSize: 20, lineHeight: 20, color: '#fff' }}>sports_esports</icon>
              <text style={{ fontSize: 17, color: '#fff', fontWeight: 'bold', flex: 1 }}>Menu</text>
              <GlassButton onClick={closeMainMenu} style={{
                width: 32, height: 32, borderRadius: 10, borderWidth: 0,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: 'rgba(255,255,255,0.08)',
              }}>
                <icon set="material-rounded" style={{ fontSize: 18, lineHeight: 18, color: '#fff' }}>close</icon>
              </GlassButton>
            </view>

            <GlassButton onClick={closeMainMenu} style={{
              backgroundColor: C.primary, borderRadius: 14, borderWidth: 0,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              paddingTop: 14, paddingBottom: 14,
            }}>
              <icon set="material-rounded-filled" style={{ fontSize: 18, lineHeight: 18, color: '#fff' }}>play_arrow</icon>
              <text style={{ fontSize: 15, color: '#fff', fontWeight: 'bold' }}>Resume Game</text>
            </GlassButton>

            {/* Resetting drops you back at spawn, so close the menu with it —
                staring at the pause dim after a respawn is pointless. */}
            <GlassButton onClick={() => { resetSpawn(); closeMainMenu(); }} style={{
              backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, borderWidth: 0,
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingTop: 13, paddingBottom: 13, paddingLeft: 16, paddingRight: 16,
            }}>
              <icon set="material-rounded" style={{ fontSize: 18, lineHeight: 18, color: '#fff' }}>refresh</icon>
              <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold', flex: 1 }}>Reset Character</text>
            </GlassButton>

            <GlassButton onClick={toggleSL} style={{
              backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, borderWidth: 0,
              flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingTop: 13, paddingBottom: 13, paddingLeft: 16, paddingRight: 16,
            }}>
              <icon set="material-rounded" style={{ fontSize: 18, lineHeight: 18, color: '#fff' }}>center_focus_strong</icon>
              <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold', flex: 1 }}>Shift Lock</text>
              <view style={{
                backgroundColor: shiftLock ? C.primary : 'rgba(255,255,255,0.12)',
                borderRadius: 7, paddingLeft: 9, paddingRight: 9, paddingTop: 3, paddingBottom: 3,
              }}>
                <text style={{ fontSize: 11, color: '#fff', fontWeight: 'bold' }}>{shiftLock ? 'ON' : 'OFF'}</text>
              </view>
            </GlassButton>

            <GlassButton onClick={leaveGame} style={{
              backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 14,
              borderWidth: 1, borderColor: 'rgba(255,69,58,0.28)',
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              paddingTop: 13, paddingBottom: 13, marginTop: 2,
            }}>
              <icon set="material-rounded" style={{ fontSize: 18, lineHeight: 18, color: '#ff453a' }}>logout</icon>
              <text style={{ fontSize: 14, color: '#ff453a', fontWeight: 'bold' }}>Leave Game</text>
            </GlassButton>
          </view>
        </view>
      ) : null}

      {/* ── Interface Builder elements — editor-authored buttons/text/images/
          panels from the Design canvas. x/y/w/h are percentages of the full
          screen (the same reference-unit space every other <view> here uses).
          Panels start hidden unless placed visible; a workflow's
          openPanel/closePanel/togglePanel steps flip panelVisibility. */}
      {interfaceElements.length > 0 && !popupTitle ? (
        <>
          {[...interfaceElements]
            .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
            .map(el => {
              if (el.kind === 'panel') {
                if (!panelVisibility[el.id]) return null;
              } else if (!el.visible) {
                return null;
              }
              const box: any = {
                position: 'absolute',
                left: `${el.x}%`, top: `${el.y}%`,
                width: el.w != null ? `${el.w}%` : undefined,
                height: el.h != null ? `${el.h}%` : undefined,
              };
              if (el.kind === 'button') {
                return (
                  <GlassButton glass={false} key={el.id} onClick={() => runInterfaceWorkflow(el.id)} style={{
                    ...box, flexDirection: 'row', alignItems: 'center', gap: 6,
                    backgroundColor: el.bgColor ?? 'rgba(0,0,0,0.60)',
                    borderRadius: el.cornerRadius ?? 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                    paddingLeft: 12, paddingRight: 14, paddingTop: 8, paddingBottom: 8, minWidth: 60,
                  }}>
                    {el.icon ? (isMaterialIconName(el.icon) ? (
                      <icon set="material-rounded" style={{ fontSize: 17, lineHeight: 17, color: el.textColor ?? '#fff' }}>{el.icon}</icon>
                    ) : (
                      <text style={{ fontSize: 17, lineHeight: 17 }}>{el.icon}</text>
                    )) : null}
                    <text style={{ fontSize: 13, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label}</text>
                  </GlassButton>
                );
              }
              if (el.kind === 'text') {
                return (
                  <view key={el.id} style={box}>
                    <text style={{ fontSize: 13, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label}</text>
                  </view>
                );
              }
              if (el.kind === 'image') {
                return (
                  <view key={el.id} style={{
                    ...box, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: el.bgColor ?? 'rgba(255,255,255,0.10)', borderRadius: el.cornerRadius ?? 10,
                  }}>
                    {el.icon ? (isMaterialIconName(el.icon) ? (
                      <icon set="material-rounded" style={{ fontSize: 24, lineHeight: 24, color: el.textColor ?? '#fff' }}>{el.icon}</icon>
                    ) : (
                      <text style={{ fontSize: 24, lineHeight: 24 }}>{el.icon}</text>
                    )) : null}
                  </view>
                );
              }
              // panel
              return (
                <view key={el.id} style={{
                  ...box, backgroundColor: el.bgColor ?? 'rgba(18,18,24,0.96)', borderRadius: el.cornerRadius ?? 14,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', padding: 16, flexDirection: 'column', gap: 8,
                }}>
                  {el.label ? <text style={{ fontSize: 16, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label}</text> : null}
                  {el.body ? <text style={{ fontSize: 13, color: el.textColor ?? 'rgba(255,255,255,0.75)', lineHeight: 18 }}>{el.body}</text> : null}
                  <GlassButton onClick={() => setPanelVisibility(v => ({ ...v, [el.id]: false }))} style={{
                    marginTop: 6, backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 10, borderWidth: 0,
                    paddingTop: 8, paddingBottom: 8, alignItems: 'center',
                  }}>
                    <text style={{ fontSize: 12, color: '#fff', fontWeight: 'bold' }}>Close</text>
                  </GlassButton>
                </view>
              );
            })}
        </>
      ) : null}

      {/* Toast — pushed by a workflow's "Show Message" step */}
      {ifaceToast ? (
        <view style={{
          position: 'absolute', left: 0, right: 0, bottom: safeAreaBottom() + 140,
          alignItems: 'center', pointerEvents: 'none' as any,
        }}>
          <view style={{
            ...glass({ fill: 'rgba(20,20,24,0.92)' }), borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10, maxWidth: '80%',
          }}>
            <text style={{ fontSize: 13, color: '#fff', fontWeight: 'bold', textAlign: 'center' as any }}>{ifaceToast}</text>
          </view>
        </view>
      ) : null}

      {/* Legacy leaderboard sentinel — see runInterfaceWorkflow's
          '__openLeaderboard' case above. */}
      {showLeaderboard ? (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.65)',
        }}>
          <view style={{
            width: '82%',
            ...glass({ fill: 'rgba(18,18,24,0.98)' }),
            borderRadius: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
            paddingLeft: 28, paddingRight: 28, paddingTop: 28, paddingBottom: 24,
          }}>
            <text style={{ fontSize: 18, color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 16 }}>Leaderboard</text>
            <view style={{
              backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 14,
              paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, marginBottom: 20,
            }}>
              <view style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4, paddingBottom: 4 }}>
                <text style={{ fontSize: 14, color: '#fcd34d', fontWeight: 'bold', minWidth: 20 }}>🥇</text>
                <text style={{ fontSize: 13, color: '#fff', flex: 1 }}>You</text>
                <text style={{ fontSize: 13, color: '#fcd34d', fontWeight: 'bold' }}>{score || '0'}</text>
              </view>
            </view>
            <text style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', marginBottom: 16 }}>
              Multiplayer rankings coming soon
            </text>
            <GlassButton onClick={() => setShowLeaderboard(false)} style={{
              backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 14, borderWidth: 0,
              paddingTop: 12, paddingBottom: 12, alignItems: 'center',
            }}>
              <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold' }}>Close</text>
            </GlassButton>
          </view>
        </view>
      ) : null}

      {/* Mobile toolbar — bottom-of-screen tool slots. Tapping a slot fires
          the configured key through the same input pipeline as a desktop
          keypress AND highlights the slot via UI.SetEquippedTool on the
          server. Only renders when Lua has called UI.SetToolbar. Hidden
          during the game-end popup so it doesn't compete for taps. */}
      {toolbar.tools.length > 0 && !popupTitle ? (
        <view style={{
          position: 'absolute',
          // Sit on the bottom safe-area border so the toolbar lines up with
          // the editor's bottom-row buttons (Undo / asset strip / Select Mode
          // / asset-shop +) which use the same anchor.
          left: 0, right: 0, bottom: safeAreaBottom(),
          alignItems: 'center', pointerEvents: 'box-none' as any,
        }}>
          <view style={{
            flexDirection: 'row', gap: 5,
            backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12,
            paddingLeft: 5, paddingRight: 5, paddingTop: 5, paddingBottom: 5,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
          }}>
            {toolbar.tools.map((t, i) => {
              const equipped = toolbar.equipped === t.name;
              const accent = t.color || '#7dd3fc';
              // Truncate names that won't fit the 50 px button — "Peashooter"
              // becomes "Peashoot…" instead of overflowing into the next slot
              // or being silently clipped by the rendering layer (ReactUnity
              // doesn't ellipsize on its own when text wraps inside a flex
              // child of a row).
              const displayName = t.name.length > 9 ? t.name.slice(0, 8) + '…' : t.name;
              return (
                <GlassButton
                  key={`${t.name}-${i}`}
                  onClick={() => {
                    try { (Globals as any).equipTool?.(t.name, t.key); } catch {}
                  }}
                  style={{
                    width: 50, height: 54, borderRadius: 9,
                    backgroundColor: equipped ? 'rgba(125,211,252,0.18)' : 'rgba(255,255,255,0.06)',
                    borderWidth: 2, borderColor: equipped ? accent : 'rgba(255,255,255,0.1)',
                    alignItems: 'center', justifyContent: 'center',
                    paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2,
                    overflow: 'hidden' as any,
                  }}
                >
                  <text style={{ fontSize: 16, color: '#fff', lineHeight: 18 }}>{t.icon ?? t.name.charAt(0)}</text>
                  <text style={{
                    fontSize: 8, color: '#fff', fontWeight: 'bold', marginTop: 1,
                    width: 46, textAlign: 'center' as any,
                  }}>{displayName}</text>
                  {typeof t.cost === 'number' && t.cost > 0 ? (
                    <text style={{ fontSize: 7, color: '#fcd34d', lineHeight: 9 }}>{t.cost}</text>
                  ) : null}
                </GlassButton>
              );
            })}
          </view>
        </view>
      ) : null}

    </view>
  );
}

// Special "player spawn" tray item — always the first tile in the editor's
// bottom strip for every game, tap/drag it like any other asset. Unity swaps
// in the real chibi model (same one as the You tab avatar editor) instead of
// downloading a GLB — see GameAssetLoader.SpawnMarkerCacheKey. cacheKey MUST
// match that Unity constant and PLAYER_SPAWN_MARKER_CACHE_KEY in
// api-server/src/room-manager.ts exactly (three runtimes, one sentinel string,
// no shared constant to import across them).
const PLAYER_SPAWN_ASSET: AssetItem = {
  cacheKey: '__player_spawn__',
  prompt: 'Spawn Point',
  isHumanoid: true,
  sizeHint: 2,
  modelUrl: '',
  title: 'Spawn Point',
};

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const [tab,             setTab]             = useState(0);
  const [avatarSection,   setAvatarSection]   = useState<AvatarSection>(0);
  const [showShop,        setShowShop]        = useState(false);
  const [isPlayingGame,   setIsPlayingGame]   = useState(false);
  const [isEditingGame,   setIsEditingGame]   = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  // "native" when Unity runs as a library inside the React Native shell
  // (native-shell/): the shell owns auth and the lobby, so this tree renders
  // only the in-game HUD.
  const [hostedByNative,  setHostedByNative]  = useState(false);
  // Hosted mode only: which ReactUnity screen the native shell asked for
  // ("create" = game creator, "" = none — native UI is showing).
  const [hostRoute,       setHostRoute]       = useState('');
  // How the native shell entered the creator: a game to edit (drawer "Edit"),
  // 'new' (the "+" button: blank game straight into the editor), or null.
  const [hostEntry,       setHostEntry]       = useState<{ kind: 'new' } | { kind: 'edit'; game: any } | null>(null);
  const [servicesReady,   setServicesReady]   = useState(false);
  const [friends,         setFriends]         = useState<FriendData[]>([]);
  const [previewGame,     setPreviewGame]     = useState<GameData | null>(null);
  // Assets the user has applied from the Assets picker — surfaced in the
  // editor's bottom horizontal scroll list. Keyed by game id so each game
  // gets its own list; opening Game A then Game B never mixes their applied
  // assets. Deduped by cacheKey so re-applying the same model doesn't create
  // duplicates in the strip. Persisted to PlayerPrefs under `editor.assetsByGame`
  // so the strip survives reloads — load lazily on first read (Globals may not
  // be registered yet when App mounts), then sync on every change.
  const [editingGameId,   setEditingGameId]   = useState<number | null>(null);
  const [editorAssetsByGame, setEditorAssetsByGame] = useState<Record<number, AssetItem[]>>({});
  // Picture for the spawn-point tray tile — a data: URI Unity renders once from
  // the user's actual chibi avatar (GameLauncher.RenderSpawnMarkerThumbnail) and
  // pushes via Globals._spawnMarkerThumbnail. Undefined until the first render
  // lands, so the tile falls back to the "SP" initials for a moment on cold start.
  const [spawnThumb, setSpawnThumb] = useState<string | undefined>(undefined);
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const raw = String((Globals as any)._spawnMarkerThumbnail ?? '');
        if (raw && raw !== spawnThumb) setSpawnThumb(raw);
      } catch { /* bridge not ready yet */ }
    }, 500);
    return () => clearInterval(t);
  }, [spawnThumb]);
  const editorAssetsLoadedRef = useRef(false);
  useEffect(() => {
    if (!servicesReady || editorAssetsLoadedRef.current) return;
    editorAssetsLoadedRef.current = true;
    try {
      const raw = String((Globals as any).getPref?.('editor.assetsByGame', '') ?? '');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setEditorAssetsByGame(parsed);
      }
    } catch { /* corrupt pref — start empty */ }
  }, [servicesReady]);
  useEffect(() => {
    if (!editorAssetsLoadedRef.current) return; // don't overwrite stored value before initial load
    try { (Globals as any).setPref?.('editor.assetsByGame', JSON.stringify(editorAssetsByGame)); }
    catch { /* pref bridge unavailable — ignore */ }
  }, [editorAssetsByGame]);
  const currentEditorAssets: AssetItem[] = editingGameId != null
    ? [{ ...PLAYER_SPAWN_ASSET, thumbnailUrl: spawnThumb }, ...(editorAssetsByGame[editingGameId] ?? [])]
    : [];

  function applyEditorAssets(picked: AssetItem[]) {
    if (editingGameId == null) return; // shop should only be openable inside the editor
    const gid = editingGameId;
    setEditorAssetsByGame(prev => {
      const cur  = prev[gid] ?? [];
      const seen = new Set(cur.map(a => a.cacheKey));
      const additions = picked.filter(a => !seen.has(a.cacheKey));
      if (additions.length === 0) return prev;
      return { ...prev, [gid]: [...cur, ...additions] };
    });
  }

  function openPreview(game: GameData)  { setPreviewGame(game); }
  function closePreview()                 { setPreviewGame(null); }
  function playFromPreview(gameId: number) {
    setPreviewGame(null);
    try { (Globals as any).loadGame?.(gameId); } catch {}
  }

  function addFriend(f: FriendData) {
    setFriends(prev => prev.some(x => x.id === f.id) ? prev : [...prev, f]);
  }

  // Poll until C# globals are registered, then track auth state.
  // servicesReady = globals registered; null auth = still waiting; false = logged out.
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const fn = (Globals as any).isAuthenticated;
        if (typeof fn !== 'function') return; // globals not registered yet
        setServicesReady(true);
        setIsAuthenticated(fn() === true);
        try {
          const host = (Globals as any).getHostMode;
          if (typeof host === 'function' && String(host()) === 'native') setHostedByNative(true);
          const route = (Globals as any).getHostRoute;
          if (typeof route === 'function') {
            const r = String(route() ?? '');
            if (r === 'create') {
              const raw = String((Globals as any).takeHostEditGame?.() ?? '');
              if (raw === 'new') setHostEntry({ kind: 'new' });
              else if (raw) { try { setHostEntry({ kind: 'edit', game: JSON.parse(raw) }); } catch { /* bad JSON */ } }
            } else {
              setHostEntry(prev => (prev ? null : prev));
            }
            setHostRoute(prev => (prev !== r ? r : prev));
          }
        } catch { /* standalone build */ }
      } catch { /* renderer not ready */ }
    }, 250);
    return () => clearInterval(t);
  }, []);

  // Mirror the C# _gameActive global into React state (set by LuauGameRunner).
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const active = String((Globals as any)._gameActive ?? '') === 'true';
        setIsPlayingGame(prev => active !== prev ? active : prev);
      } catch { /* renderer not ready */ }
    }, 250);
    return () => clearInterval(t);
  }, []);

  function showChibi(visible: boolean) {
    (Globals['setAvatarVisible'] as ((v: boolean) => void) | undefined)?.(visible);
  }

  // When the Assets modal is open over the editor, suppress the editor
  // camera so vertical scroll gestures on the asset grid don't simultaneously
  // pan/orbit the 3D viewport behind it. EditorCameraController.SheetDragging
  // is the same switch the chat sheet uses for the same reason.
  useEffect(() => {
    const suppress = showShop && isEditingGame;
    try { (Globals as any).setEditorSheetDragging?.(suppress ? 'true' : 'false'); } catch {}
    // Always release the suppression on unmount so a stale 'true' can't strand
    // the editor camera permanently silent.
    return () => {
      try { (Globals as any).setEditorSheetDragging?.('false'); } catch {}
    };
  }, [showShop, isEditingGame]);

  // Native shell: the asset library is a ReactUnity overlay drawn over the
  // editor, so tell the host to step its native editor chrome aside meanwhile.
  useEffect(() => {
    if (!hostedByNative) return;
    try {
      (Globals as any).notifyHost?.(JSON.stringify({ type: 'editorOverlay', open: showShop && isEditingGame }));
    } catch { /* bridge not ready */ }
  }, [hostedByNative, showShop, isEditingGame]);

  function onTabPress(t: number) {
    showChibi(t === AVATAR_TAB);
    if (t === AVATAR_TAB) setAvatarSection(0);
    setTab(t);
  }

  function onSectionChange(s: number) {
    showChibi(s === 0);
    setAvatarSection(s as AvatarSection);
  }

  // ── Auth gate — wait for globals, then show auth screen if logged out ──────────
  if (!servicesReady) return null;          // globals not registered yet — show nothing
  function closeHostCreator() {
    try { (Globals as any).closeHostRoute?.(); } catch { /* bridge gone */ }
  }

  // Native shell: it owns the lobby, so render only what it asks for — the
  // in-game HUD (below, once a game is active) or the game creator.
  if (hostedByNative && !isPlayingGame) {
    if (hostRoute !== 'create') return null;
    return (
      <view style={{
        flex: 1,
        backgroundColor: (isEditingGame || previewGame) ? 'rgba(0,0,0,0)' : C.bg,
        flexDirection: 'column',
      }}>
        <view style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' } as any}>
          <CreateScreen
            key={hostEntry ? (hostEntry.kind === 'edit' ? `edit-${hostEntry.game?.id}` : 'new') : 'create'}
            initialEditGame={hostEntry?.kind === 'edit' ? hostEntry.game : undefined}
            startNewGame={hostEntry?.kind === 'new'}
            onExitEditor={hostEntry ? closeHostCreator : undefined}
            onEditingChange={setIsEditingGame}
            onEditingGameChange={setEditingGameId}
            onOpenShop={() => setShowShop(true)}
            onApplyAssets={applyEditorAssets}
            editorAssets={currentEditorAssets}
          />
        </view>
        {/* Entered straight into the editor ("+" / "Edit"): cover the Create
            list while the game is created and the editor opens. */}
        {hostEntry && !isEditingGame && (
          <view style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: 10,
          } as any}>
            <icon set="material-rounded" style={{ fontSize: 34, lineHeight: 34, color: C.secondary }}>construction</icon>
            <text style={{ fontSize: 16, color: C.secondary }}>Opening editor…</text>
          </view>
        )}
        {/* Back to the native app — on the Create landing or the cover above;
            the editor has its own exit. */}
        {!isEditingGame && (
          <GlassButton
            onClick={closeHostCreator}
            style={{
              position: 'absolute', top: safeAreaTop() + 6, right: 16,
              width: 40, height: 40, borderRadius: 20, borderWidth: 0,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.12)',
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 22, lineHeight: 22, color: C.text }}>close</icon>
          </GlassButton>
        )}
        {showShop && isEditingGame && (
          <view style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.72)',
            alignItems: 'center', justifyContent: 'center',
            paddingLeft: 28, paddingRight: 28, paddingTop: 16, paddingBottom: 16,
            zIndex: 200,
          } as any}>
            <view style={{
              width: '100%', maxWidth: 720, height: '100%',
              backgroundColor: C.bg, borderRadius: 22,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}>
              <ShopScreen
                embedded
                onBack={() => setShowShop(false)}
                onApply={picked => { applyEditorAssets(picked); setShowShop(false); }}
              />
            </view>
          </view>
        )}
      </view>
    );
  }
  if (!isAuthenticated && !hostedByNative) {
    return <AuthScreen onAuth={() => setIsAuthenticated(true)} />;
  }

  // ── Active game overlay ────────────────────────────────────────────────────────
  // Preview mode never sets _gameActive, so isPlayingGame is only true during real play.
  // The GameHUD replaces the whole tree, so CreateScreen unmounts while playing.
  // When play was launched from the editor, CreateScreen resumes that editing
  // session on remount (see _resumeEditSession), so leaving the game returns the
  // user to the editor — not the Create game list.
  if (isPlayingGame) {
    return (
      <GameHUD onExit={() => {
        try { (Globals as any).exitGame?.(); } catch { /* no-op */ }
        setIsPlayingGame(false);
      }} />
    );
  }

  // Shop full-screen overlay (no bottom nav).
  // Only takes over the screen when the shop was opened from outside the editor
  // (e.g. avatar tab). When opened from the editor's + button (isEditingGame),
  // the shop is rendered below as a centered landscape card so the device stays
  // in landscape and the editor isn't torn down behind it.
  if (showShop && !isEditingGame) {
    return (
      <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
        <ShopScreen
          onBack={() => { showChibi(true); setShowShop(false); }}
          onApply={picked => { applyEditorAssets(picked); setShowShop(false); }}
        />
      </view>
    );
  }

  function handleLogout() {
    try { (Globals as any).signOut?.(); } catch { /* no-op */ }
    setIsAuthenticated(false);
  }

  function renderAvatarSection() {
    switch (avatarSection) {
      case 0: return <AvatarScreen onShop={() => { showChibi(false); setShowShop(true); }} onNavigate={onSectionChange} />;
      case 1: return <PublicProfileScreen onNavigate={onSectionChange} />;
      case 2: return <SettingsScreen onNavigate={onSectionChange} onLogout={handleLogout} />;
    }
  }

  // Single render tree — changing isEditingGame must NOT remount CreateScreen or it loses phase state.
  // Background goes transparent and BottomNav hides when editing so the 3D world shows through.
  return (
    <view style={{
      flex: 1,
      backgroundColor: (isEditingGame || previewGame) ? 'rgba(0,0,0,0)' : C.bg,
      flexDirection: 'column',
    }}>
      {React.createElement('style', { scope: ':root' }, `
        .game-card-title-overlay, .my-game-title-overlay { backdrop-filter: blur(20px); }
        .pludo-scroll::scrollbar, .pludo-scroll::scrollbar-thumb { width: 0; height: 0; background-color: rgba(0,0,0,0); }
      `)}
      {/* Content area is absolutely-positioned (not flex:1) so a child <scroll>
          with tall content — eg. Explore's results — can't push the layout box
          taller than the viewport, which would shift the absolutely-positioned
          BottomNav off the bottom of the screen. Tab screens append their own
          bottom spacer (BOTTOM_NAV_HEIGHT + safeAreaBottom) so cards aren't
          hidden under the nav. On tablet the nav is a left rail instead —
          inset the left edge by its footprint whenever it's actually showing
          (hidden while editing/previewing, so no inset needed there). */}
      <view style={{
        position: 'absolute', top: 0, right: 0, bottom: 0,
        left: (isTablet() && !isEditingGame && !previewGame) ? NAV_FOOTPRINT : 0,
        overflow: 'hidden',
      } as any}>
        {tab === 0 && !isEditingGame && <HomeScreen onNavigate={setTab} onPreview={openPreview} friends={friends} onFriendAdd={addFriend} />}
        {tab === 1 && !isEditingGame && <ExploreScreen onPreview={openPreview} />}
        {tab === 2 && <CreateScreen onEditingChange={setIsEditingGame} onEditingGameChange={setEditingGameId} onOpenShop={() => { showChibi(false); setShowShop(true); }} editorAssets={currentEditorAssets} />}
        {tab === 3 && !isEditingGame && <ChatScreen friends={friends} />}
        {tab === 4 && !isEditingGame && renderAvatarSection()}
      </view>
      {/* Preview overlay sits above tab content but BELOW the BottomNav so the tab
          nav remains visible/reachable while previewing — and the preview's own
          sticky Play bar lands directly above the nav. */}
      {previewGame && (
        <GamePreviewScreen
          game={previewGame}
          onClose={closePreview}
          onPlay={playFromPreview}
        />
      )}
      {/* BottomNav is anchored absolutely to the bottom so screen content
          overflowing in column-flex (eg. Explore's scroll) cannot push it
          off-screen. Hidden while a game preview is open so the preview's
          sticky Play bar lands directly at the bottom of the screen — and
          hidden while editing so the 3D editor fills the viewport. */}
      {!isEditingGame && !previewGame && (
        <view style={isTablet()
          ? { position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 100 } as any
          : { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 100 } as any
        }>
          <BottomNav active={tab} onTab={onTabPress} />
        </view>
      )}
      {/* Asset shop opened from inside the editor — render as a centered
          landscape card on top of the editor instead of taking over the
          screen, so the device stays in landscape and CreateScreen isn't
          unmounted/remounted (which would tear down the running editor
          session). */}
      {showShop && isEditingGame && (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.72)',
          alignItems: 'center', justifyContent: 'center',
          paddingLeft: 28, paddingRight: 28, paddingTop: 16, paddingBottom: 16,
          zIndex: 200,
        } as any}>
          <view style={{
            width: '100%', maxWidth: 720, height: '100%',
            backgroundColor: C.bg, borderRadius: 22,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}>
            <ShopScreen
              embedded
              onBack={() => setShowShop(false)}
              onApply={picked => { applyEditorAssets(picked); setShowShop(false); }}
            />
          </view>
        </view>
      )}
    </view>
  );
}
