import React, { useState, useEffect, useRef } from 'react';
import { C } from './theme';
import { safeAreaTop, safeAreaLeft, safeAreaRight, safeAreaBottom } from './safeArea';
import { FriendData, AssetItem } from './types';
import { BottomNav, NAV_FOOTPRINT } from './components/BottomNav';
import { isTablet }            from './responsive';
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
  // username, text, ts}). chatVisible is a local UI preference toggled from
  // the escape menu. chatInput is the in-flight text the user is typing.
  // chatError surfaces a brief toast when the server rejects a message
  // (rate-limit, profanity, etc).
  const [chatLog,      setChatLog]      = useState<Array<{clientId:string;username:string;text:string;ts:number}>>([]);
  const [chatVisible,  setChatVisible]  = useState(true);
  const [chatInput,    setChatInput]    = useState('');
  const [chatError,    setChatError]    = useState('');
  // Hamburger dropdown — replaces the legacy centered escape modal. When
  // true, the chat panel renders the menu (Resume / Reset / Shift Lock /
  // Show Chat / Leave Game) instead of the messages + input row.
  const [menuOpen,     setMenuOpen]     = useState(false);
  const lastChatJSON  = useRef('');
  const escapeSignalSeen = useRef(false);
  // ── HUD buttons ──────────────────────────────────────────────────────────
  // Editor-authored interface buttons. Polled from _hudButtons global (JSON
  // array set by GameRenderClient at session start from SceneSettings).
  type HudButton = {
    id: string; label: string; icon: string; anchor: string;
    action: 'panel' | 'leaderboard' | 'event';
    panelTitle?: string; panelBody?: string; eventName?: string;
  };
  const [hudButtons,   setHudButtons]   = useState<HudButton[]>([]);
  const [hudModal,     setHudModal]     = useState<HudButton | null>(null);
  const lastHudBtnsJSON = useRef('');

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
        // The legacy centered modal is gone; route the signal to opening the
        // hamburger dropdown so the same gesture still surfaces the menu.
        const escActive = String((Globals as any)._showEscape ?? '') === 'true';
        if (escActive && !escapeSignalSeen.current) {
          escapeSignalSeen.current = true;
          setMenuOpen(true);
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

        // HUD buttons — pushed once at session start, static per game.
        const rawHb = String((Globals as any)._hudButtons ?? '');
        if (rawHb !== lastHudBtnsJSON.current) {
          lastHudBtnsJSON.current = rawHb;
          try { setHudButtons(rawHb ? JSON.parse(rawHb) : []); } catch { setHudButtons([]); }
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
    setMenuOpen(false);
    onExit();
  }

  // ── Hamburger dropdown — renders inside the chat panel ────────────────────
  // Same width and (capped) height as the chat panel itself. Replaces the
  // legacy centered escape modal.
  function renderHamburgerMenu() {
    const rowStyle: any = {
      flexDirection: 'row', alignItems: 'center',
      paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8,
      borderWidth: 0, backgroundColor: 'transparent',
    };
    const rowLabel: any = { color: '#fff', fontSize: 12, flex: 1 };
    const pillOn:  any = { backgroundColor: C.green,                  borderRadius: 6, paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 };
    const pillOff: any = { backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 6, paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 };
    return (
      <scroll className="pludo-chat-scroll" style={{ maxHeight: 160 }}>
        <view style={{ flexDirection: 'column', gap: 4 }}>
          <view style={{
            backgroundColor: 'rgba(255,255,255,0.04)',
            borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
            overflow: 'hidden',
          }}>
            <button onClick={resetSpawn} style={rowStyle}>
              <text style={rowLabel}>Reset Position</text>
              <text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, fontWeight: 'bold' }}>RESET</text>
            </button>
            <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginLeft: 8 }} />
            <button onClick={toggleSL} style={rowStyle}>
              <text style={rowLabel}>Shift Lock</text>
              <view style={shiftLock ? pillOn : pillOff}>
                <text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>{shiftLock ? 'ON' : 'OFF'}</text>
              </view>
            </button>
            <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginLeft: 8 }} />
            <button onClick={() => setChatVisible(v => !v)} style={rowStyle}>
              <text style={rowLabel}>Show Chat</text>
              <view style={chatVisible ? pillOn : pillOff}>
                <text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>{chatVisible ? 'ON' : 'OFF'}</text>
              </view>
            </button>
          </view>

          <button onClick={leaveGame} style={{
            backgroundColor: 'rgba(255,69,58,0.12)',
            borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,69,58,0.28)',
            paddingTop: 8, paddingBottom: 8,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <text style={{ fontSize: 12, color: '#ff453a', fontWeight: 'bold' }}>Leave Game</text>
          </button>
        </view>
      </scroll>
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
            backgroundColor: 'rgba(18,18,24,0.98)',
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
              <button onClick={() => {
                try { (Globals as any).restartGame?.(); } catch { /* no-op */ }
              }} style={{
                backgroundColor: C.green, borderRadius: 16, borderWidth: 0,
                paddingTop: 16, paddingBottom: 16, paddingLeft: 32, paddingRight: 32,
                alignItems: 'center', justifyContent: 'center', marginBottom: 10, width: '100%',
              }}>
                <text style={{ fontSize: 16, color: '#fff', fontWeight: 'bold' }}>{popupBtn}</text>
              </button>
            ) : null}
            <button onClick={() => {
              try { (Globals as any).exitGame?.(); } catch { /* no-op */ }
              onExit();
            }} style={{
              backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 14, borderWidth: 0,
              paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24,
              alignItems: 'center', justifyContent: 'center', width: '100%',
            }}>
              <text style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }}>Leave Game</text>
            </button>
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

      {/* Chat panel — pinned to the top-left safe-area corner. Width is fixed
          at 260 ref units; height is capped at 50% of the canvas so a long
          backlog (or a tall menu dropdown) never overlaps the bottom-left
          joystick. A hamburger button in the panel's top-left toggles the
          menu dropdown (Resume / Reset / Shift Lock / Show Chat / Leave) —
          the legacy centered escape modal has been removed. Scrollbar inside
          the message list is suppressed via a scoped ::scrollbar { width: 0 }
          (same pattern used in ExploreScreen / CreateScreen). */}
      {!popupTitle ? (
        <>
          {React.createElement('style', { scope: ':root' }, `
            .pludo-chat-scroll::scrollbar, .pludo-chat-scroll::scrollbar-thumb { width: 0; height: 0; background-color: rgba(0,0,0,0); }
          `)}
          <view style={{
            position: 'absolute',
            top: safeAreaTop(), left: safeAreaLeft(),
            width: 260,
            maxHeight: '50%',
            backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 12,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
            paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10,
            flexDirection: 'column',
          }}>
            {/* Header row — hamburger icon in the top-left toggles the menu.
                Always rendered, so when the user flips "Show Chat" off they
                still have a button to re-open the menu / chat. Closing the
                menu also calls resumeGame() since the standalone Resume
                button has been removed.

                When the player is damaged (hp < 100), a slim health bar
                renders to the right of the hamburger and fills the rest of
                the header row. Colour goes green > yellow > red as hp drops. */}
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: (menuOpen || chatVisible) ? 6 : 0 }}>
              <button onClick={() => {
                setMenuOpen(o => {
                  const next = !o;
                  if (!next) { try { (Globals as any).resumeGame?.(); } catch { /* no-op */ } }
                  return next;
                });
              }} style={{
                backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 6, borderWidth: 0,
                paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2,
              }}>
                <icon set="material-rounded" style={{ color: '#fff', fontSize: 16, lineHeight: 16 }}>menu</icon>
              </button>
              {showHealth ? (
                <view style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <text style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>HP</text>
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
            </view>

            {menuOpen ? renderHamburgerMenu() : chatVisible ? (
              <>
                {/* Message list — hard maxHeight so the scroll caps before
                    it pushes the send row outside the chat panel's 50%
                    overall maxHeight. */}
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
                  <button onClick={sendChat} style={{
                    backgroundColor: C.green, borderRadius: 6, borderWidth: 0,
                    paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4,
                  }}>
                    <text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>SEND</text>
                  </button>
                </view>
                {chatError ? (
                  <text style={{ color: '#ff453a', fontSize: 11, marginTop: 4 }}>{chatError}</text>
                ) : null}
              </>
            ) : null}
          </view>
        </>
      ) : null}

      {/* ── Custom HUD buttons — editor-authored Interface panel buttons ──────
          Rendered at anchor positions over the scene. Tapping fires the
          configured action: show a panel, show scores, or fire a Lua event. */}
      {hudButtons.length > 0 && !popupTitle ? (() => {
        function anchorStyle(anchor: string): any {
          const base: any = { position: 'absolute', flexDirection: 'column', gap: 6 };
          switch (anchor) {
            case 'top-left':      return { ...base, top: safeAreaTop() + 60,    left:  safeAreaLeft()  + 8, alignItems: 'flex-start' };
            case 'top-center':    return { ...base, top: safeAreaTop() + 60,    left:  0, right: 0,          alignItems: 'center' };
            case 'top-right':     return { ...base, top: safeAreaTop() + 60,    right: safeAreaRight() + 8, alignItems: 'flex-end' };
            case 'bottom-left':   return { ...base, bottom: safeAreaBottom() + 80, left:  safeAreaLeft()  + 8, alignItems: 'flex-start' };
            case 'bottom-center': return { ...base, bottom: safeAreaBottom() + 80, left:  0, right: 0,          alignItems: 'center' };
            case 'bottom-right':  return { ...base, bottom: safeAreaBottom() + 80, right: safeAreaRight() + 8, alignItems: 'flex-end' };
            default:              return { ...base, bottom: safeAreaBottom() + 80, right: safeAreaRight() + 8, alignItems: 'flex-end' };
          }
        }
        const ANCHORS = ['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'];
        return (
          <>
            {ANCHORS.map(anchor => {
              const group = hudButtons.filter(b => (b.anchor || 'bottom-right') === anchor);
              if (!group.length) return null;
              return (
                <view key={anchor} style={anchorStyle(anchor)}>
                  {group.map(btn => (
                    <button
                      key={btn.id}
                      onClick={() => {
                        if (btn.action === 'event') {
                          try { (Globals as any).fireHudEvent?.(btn.eventName ?? ''); } catch {}
                        } else {
                          setHudModal(btn);
                        }
                      }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 6,
                        backgroundColor: 'rgba(0,0,0,0.60)',
                        borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                        paddingLeft: 12, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
                        minWidth: 60,
                      }}
                    >
                      {btn.icon ? <text style={{ fontSize: 17, lineHeight: 17 }}>{btn.icon}</text> : null}
                      <text style={{ fontSize: 13, color: '#fff', fontWeight: 'bold' }}>{btn.label}</text>
                    </button>
                  ))}
                </view>
              );
            })}
          </>
        );
      })() : null}

      {/* HUD button modal — panel or leaderboard overlay */}
      {hudModal ? (
        <view style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.65)',
        }}>
          <view style={{
            width: '82%',
            backgroundColor: 'rgba(18,18,24,0.98)',
            borderRadius: 26, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
            paddingLeft: 28, paddingRight: 28, paddingTop: 28, paddingBottom: 24,
          }}>
            {hudModal.action === 'leaderboard' ? (
              <>
                <text style={{ fontSize: 18, color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 16 }}>
                  {hudModal.icon ? `${hudModal.icon} ` : ''}{hudModal.label}
                </text>
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
              </>
            ) : (
              <>
                <text style={{ fontSize: 18, color: '#fff', fontWeight: 'bold', textAlign: 'center', marginBottom: 12 }}>
                  {hudModal.icon ? `${hudModal.icon} ` : ''}{hudModal.panelTitle || hudModal.label}
                </text>
                {hudModal.panelBody ? (
                  <text style={{ fontSize: 14, color: 'rgba(255,255,255,0.72)', textAlign: 'center', marginBottom: 20, lineHeight: 20 }}>
                    {hudModal.panelBody}
                  </text>
                ) : null}
              </>
            )}
            <button onClick={() => setHudModal(null)} style={{
              backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 14, borderWidth: 0,
              paddingTop: 12, paddingBottom: 12, alignItems: 'center',
            }}>
              <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold' }}>Close</text>
            </button>
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
                <button
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
                </button>
              );
            })}
          </view>
        </view>
      ) : null}

    </view>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const [tab,             setTab]             = useState(0);
  const [avatarSection,   setAvatarSection]   = useState<AvatarSection>(0);
  const [showShop,        setShowShop]        = useState(false);
  const [isPlayingGame,   setIsPlayingGame]   = useState(false);
  const [isEditingGame,   setIsEditingGame]   = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
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
    ? (editorAssetsByGame[editingGameId] ?? [])
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
  if (!isAuthenticated) {
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
              onBack={() => setShowShop(false)}
              onApply={picked => { applyEditorAssets(picked); setShowShop(false); }}
            />
          </view>
        </view>
      )}
    </view>
  );
}
