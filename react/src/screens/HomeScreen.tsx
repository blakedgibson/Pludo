import React, { useEffect, useRef, useState } from 'react';
import { C } from '../theme';
import { safeAreaTop } from '../safeArea';
import { GameData, AvatarItemData, FriendData } from '../types';
import { fetchGames, fetchAvatarItems } from '../api';
import { GameCard } from '../components/GameCard';
import { ItemCard } from '../components/ItemCard';
import { Pressable } from '../components/Pressable';
import { SkeletonGameCard } from '../components/Skeleton';
import { RefreshButton } from '../components/RefreshButton';
import { bottomNavInset, BOTTOM_NAV_HEIGHT, NAV_FOOTPRINT } from '../components/BottomNav';
import { isTablet, refScreenWidth, refScreenHeight } from '../responsive';
import { GlassButton } from '../components/GlassButton';

interface Props {
  onNavigate:   (tab: number) => void;
  onPreview:    (game: GameData) => void;
  friends:      FriendData[];
  onFriendAdd:  (f: FriendData) => void;
}

const STATUS_COLOR: Record<string, string> = {
  playing:  C.green,
  online:   C.blue,
  building: C.orange,
  offline:  C.surface,
};

const HANDLE_H       = 30;                     // handle pill height
const AVATAR_FRAME_H = 164;                    // avatar frame height (see JSX below)
const LERP_SPEED     = 0.28;

// Panel snap heights. Capped against the live canvas height because the tablet
// lobby is landscape — only ~633 reference units tall, so the phone's 700pt
// "full" position would overflow the screen and the sheet could never close.
// On phone (844 tall) both caps are inert and the values are the original ones.
function panelHalf(): number { return Math.min(420, refScreenHeight() * 0.62); }
function panelFull(): number { return Math.min(700, refScreenHeight() - 40); }
function snapToFull(): number { return panelFull() * 0.75; }
function snapToHalf(): number { return panelHalf() * 0.40; }

function getPointerY(): number {
  return (Globals['getPointerY'] as any)?.() ?? 0;
}
function getPointerX(): number {
  return (Globals['getPointerX'] as any)?.() ?? 0;
}
function getScreenH(): number {
  return (Globals['getScreenHeight'] as any)?.() ?? 844;
}

// ── Profile preview panel ─────────────────────────────────────────────────────
// Conditionally mounted — mounts when "You" is pressed, unmounts when fully closed.

function ProfilePreviewPanel({ onClose }: { onClose: () => void }) {
  const [h, setH]              = useState(0);
  const [username, setUsername]         = useState('');
  const [gamesCount, setGamesCount]     = useState<number | null>(null);
  const [friendsCount, setFriendsCount] = useState<number | null>(null);

  const animRef       = useRef<any>(null);
  const panelHRef     = useRef(0);
  const lastDragY     = useRef(0);
  const hasDragged    = useRef(false);
  const lastAvatarDragX = useRef(0);

  // Rectangle in screen-normalized coords for camera.rect (Y from screen bottom).
  // Handle = 30px, avatar frame = 164px tall, sitting at the top of the panel's
  // content — so its bottom edge is (navBottom + panelHalf - handle - frame)
  // above the screen bottom. On phone this reproduces the original hardcoded
  // constants exactly: 60 + 420 - 30 - 164 = 286 over an 844-tall canvas.
  //
  // Every term is measured live rather than against 390×844: on tablet the
  // canvas is landscape, the nav is a LEFT rail (so nothing is docked at the
  // bottom) and the panel starts inboard of that rail.
  const refW      = refScreenWidth();
  const refH      = refScreenHeight();
  const navBottom = isTablet() ? 0 : BOTTOM_NAV_HEIGHT;
  const panelLeft = isTablet() ? NAV_FOOTPRINT : 0;

  const RECT_X = (panelLeft + 20) / refW;
  const RECT_Y = (navBottom + panelHalf() - HANDLE_H - AVATAR_FRAME_H) / refH;
  const RECT_W = 100 / refW;
  const RECT_H = AVATAR_FRAME_H / refH;

  function showAvatar(v: boolean) {
    try {
      if (v) (Globals as any).showAvatarInRect?.(RECT_X, RECT_Y, RECT_W, RECT_H);
      else   (Globals as any).resetAvatarFullscreen?.();
    } catch {}
  }

  function slideTo(target: number, andClose = false) {
    if (animRef.current) clearInterval(animRef.current);
    animRef.current = setInterval(() => {
      const current = panelHRef.current;
      const next    = current + (target - current) * LERP_SPEED;
      const done    = Math.abs(target - next) < 1;
      const val     = done ? target : next;
      panelHRef.current = val;
      setH(val);
      if (done) {
        clearInterval(animRef.current);
        animRef.current = null;
        if (andClose) onClose();
      }
    }, 16);
  }

  // On mount: slide up to half-open and fetch profile data.
  useEffect(() => {
    showAvatar(true);
    slideTo(panelHalf());
    (async () => {
      try {
        const json = await (Globals as any).fetchMyProfile?.();
        if (json) {
          const d = JSON.parse(json);
          setUsername(d.username ?? '');
          setGamesCount(d.gamesCount ?? 0);
          setFriendsCount(d.friendsCount ?? 0);
        }
      } catch {}
    })();
  }, []);

  // Cleanup animation on unmount.
  useEffect(() => {
    return () => {
      if (animRef.current) clearInterval(animRef.current);
      showAvatar(false);
    };
  }, []);

  function close() {
    showAvatar(false);
    slideTo(0, true);
  }

  function handlePointerDown(_e: any) {
    if (animRef.current) { clearInterval(animRef.current); animRef.current = null; }
    hasDragged.current = false;
    lastDragY.current  = getPointerY();
  }

  function handleBeginDrag(_e: any) {
    hasDragged.current = true;
    lastDragY.current  = getPointerY();
  }

  function handleDrag(_e: any) {
    hasDragged.current = true;
    const y     = getPointerY();
    const dy    = y - lastDragY.current;
    lastDragY.current = y;
    const scale = getScreenH() / refScreenHeight();
    const dyRef = dy / (scale || 1);
    const newH  = Math.max(0, Math.min(panelFull(), panelHRef.current + dyRef));
    // Re-show avatar when dragging back up from closed state.
    if (newH > 10 && panelHRef.current <= 10) showAvatar(true);
    else if (newH <= 10 && panelHRef.current > 10) showAvatar(false);
    panelHRef.current = newH;
    setH(newH);
  }

  function handleAvatarPointerDown(_e: any) {
    lastAvatarDragX.current = getPointerX();
  }

  function handleAvatarDrag(_e: any) {
    const x  = getPointerX();
    const dx = x - lastAvatarDragX.current;
    lastAvatarDragX.current = x;
    try { (Globals as any).orbitAvatar?.(dx, 0); } catch {}
  }

  function handlePointerUp(_e: any) {
    if (!hasDragged.current) {
      // Tap on handle: close if open, else open to half.
      if (panelHRef.current > panelHalf() * 0.3) { showAvatar(false); slideTo(0, true); }
      else { showAvatar(true); slideTo(panelHalf()); }
      return;
    }
    hasDragged.current = false;
    const h = panelHRef.current;
    if (h > snapToFull())      { showAvatar(true);  slideTo(panelFull()); }
    else if (h > snapToHalf()) { showAvatar(true);  slideTo(panelHalf()); }
    else                       { showAvatar(false); slideTo(0, true); }
  }

  const panelH    = Math.round(h);
  const contentH  = Math.max(0, panelH - HANDLE_H);

  return (
    <>
      {/* Backdrop — only mounted when panel is visibly open so it never blocks
          Home-screen touches when the panel is closed at h=0. */}
      {panelH > 10 && (
        <view
          onClick={panelH > 40 ? close : undefined}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }}
        />
      )}

      {/* Panel — explicit height + overflow:hidden clips all normal-flow children.
          Single container (no inner position:absolute) so ReactUnity's uGUI
          actually clips the content instead of letting it overflow. */}
      <view style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        height: panelH,
        overflow: 'hidden',
        flexDirection: 'column',
        backgroundColor: C.card,
        borderTopLeftRadius:  panelH > 8 && panelH < panelFull() - 10 ? 24 : 0,
        borderTopRightRadius: panelH > 8 && panelH < panelFull() - 10 ? 24 : 0,
      }}>

        {/* Draggable handle pill — normal-flow child, clipped to 0 when panelH=0 */}
        <view
          onPointerDown={handlePointerDown}
          onBeginDrag={handleBeginDrag}
          onDrag={handleDrag}
          onPointerUp={handlePointerUp}
          style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 14, cursor: 'pointer', flexShrink: 0 }}
        >
          <view style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: C.surface }} />
        </view>

        {/* Expandable content area */}
        <view style={{ height: contentH, overflow: 'hidden', flexDirection: 'column' }}>
          {contentH > 10 && (
            <scroll className="pludo-scroll" style={{ flex: 1, height: 1 }}>
              <view style={{ flexDirection: 'column', paddingLeft: 20, paddingRight: 20, paddingBottom: 20 }}>

                {/* Avatar + info row */}
                <view style={{ flexDirection: 'row', gap: 16, marginBottom: 20 }}>

                  {/* Transparent avatar frame — Unity RenderTexture overlay */}
                  <view
                    onPointerDown={handleAvatarPointerDown}
                    onBeginDrag={handleAvatarDrag}
                    onDrag={handleAvatarDrag}
                    style={{
                      width: 100, height: 164,
                      borderRadius: 16,
                      borderWidth: 1, borderColor: C.border,
                      flexShrink: 0,
                      cursor: 'pointer',
                    }}
                  />

                  {/* Right column */}
                  <view style={{ flex: 1, height: 164, flexDirection: 'column' }}>

                    <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold', marginBottom: 2 }}>
                      {username ? `@${username}` : <text style={{ color: C.secondary }}>Loading...</text>}
                    </text>

                    <view style={{ flexDirection: 'row', gap: 20, marginBottom: 10 }}>
                      <view>
                        <text style={{ fontSize: 17, color: C.text, fontWeight: 'bold' }}>
                          {gamesCount === null ? '-' : String(gamesCount)}
                        </text>
                        <text style={{ fontSize: 11, color: C.secondary }}>Games Created</text>
                      </view>
                      <view>
                        <text style={{ fontSize: 17, color: C.text, fontWeight: 'bold' }}>
                          {friendsCount === null ? '-' : String(friendsCount)}
                        </text>
                        <text style={{ fontSize: 11, color: C.secondary }}>Friends</text>
                      </view>
                    </view>

                  </view>
                </view>

              </view>
            </scroll>
          )}
        </view>

      </view>
    </>
  );
}

// ── You bubble (no ring) ──────────────────────────────────────────────────────

function YouBubble({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onClick={onPress} style={{
      flexDirection: 'column', alignItems: 'center', gap: 8, width: 76,
      backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 0,
    }}>
      <view style={{
        width: 68, height: 68, borderRadius: 34,
        backgroundColor: C.surface,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: C.primary,
      }}>
        <text style={{ fontSize: 22, color: C.primary, fontWeight: 'bold', textAlign: 'center' }}>Y</text>
      </view>
      <text style={{ fontSize: 12, color: C.text, textAlign: 'center', fontWeight: '600' }}>You</text>
    </Pressable>
  );
}

function FriendBubble({ name, status }: { name: string; status: string }) {
  const ring = STATUS_COLOR[status] ?? C.surface;
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <view style={{ flexDirection: 'column', alignItems: 'center', gap: 8, width: 76 }}>
      <view style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: ring, alignItems: 'center', justifyContent: 'center' }}>
        <view style={{ width: 66, height: 66, borderRadius: 33, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
          <view style={{ width: 62, height: 62, borderRadius: 31, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ fontSize: 20, color: 'white', fontWeight: 'bold', textAlign: 'center' }}>{initials}</text>
          </view>
        </view>
      </view>
      <text style={{ fontSize: 12, color: C.text, textAlign: 'center', fontWeight: '600' }}>{name.split(' ')[0]}</text>
    </view>
  );
}

function AddBubble({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onClick={onPress} style={{ flexDirection: 'column', alignItems: 'center', gap: 8, width: 76, backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 0 }}>
      <view style={{
        width: 68, height: 68, borderRadius: 34,
        backgroundColor: C.card,
        borderWidth: 2, borderColor: C.border,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded" style={{ fontSize: 32, color: C.primary, lineHeight: 32 }}>add</icon>
      </view>
      <text style={{ fontSize: 12, color: C.secondary, textAlign: 'center' }}>Add</text>
    </Pressable>
  );
}

interface SearchUser { id: string; username: string; handle: string; }

function AddFriendPage({ onClose, onAdd }: { onClose: () => void; onAdd: (f: FriendData) => void }) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<any>(null);

  async function fetchUsers(q: string) {
    setLoading(true);
    try {
      const base = (Globals as any).apiBaseUrl ?? 'http://localhost:4000';
      const url  = q.trim()
        ? `${base}/api/users/search?q=${encodeURIComponent(q.trim())}`
        : `${base}/api/users/search?q=`;
      const r = await fetch(url);
      if (r.ok) setResults((await r.json() as { users: SearchUser[] }).users);
    } catch { /* offline */ }
    finally { setLoading(false); }
  }

  useEffect(() => { fetchUsers(''); }, []);

  function handleChange(val: string) {
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchUsers(val), 350);
  }

  function addUser(u: SearchUser) {
    onAdd({ id: u.id, name: u.username, handle: u.handle, status: 'online' });
    onClose();
  }

  return (
    <view style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, flexDirection: 'column' }}>

      {/* Top bar */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 16, paddingRight: 20,
        paddingTop: safeAreaTop() + 4, paddingBottom: 14,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <GlassButton onClick={onClose} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 8, marginRight: 4 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.text, lineHeight: 24 }}>arrow_back</icon>
        </GlassButton>
        <text style={{ flex: 1, fontSize: 20, color: C.text, fontWeight: 'bold' }}>Add Friend</text>
      </view>

      {/* Search bar */}
      <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 8 }}>
        <view style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          backgroundColor: C.surface, borderRadius: 14,
          paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
        }}>
          <icon set="material-rounded" style={{ fontSize: 18, color: C.secondary, lineHeight: 18 }}>search</icon>
          <input
            value={query}
            onChange={(val: any) => handleChange(val)}
            placeholder="Search by username or @handle"
            style={{ flex: 1, backgroundColor: 'transparent', borderWidth: 0, color: C.text, fontSize: 15, minHeight: 40 }}
          />
        </view>
      </view>

      {/* Results */}
      {results.length > 0 ? (
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1 }}>
          <view style={{ paddingLeft: 16, paddingRight: 16 }}>
            {results.map(u => (
              <view key={u.id} style={{
                flexDirection: 'row', alignItems: 'center',
                paddingTop: 12, paddingBottom: 12,
                borderBottomWidth: 1, borderBottomColor: C.border,
              }}>
                <view style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', marginRight: 12, flexShrink: 0 }}>
                  <text style={{ fontSize: 17, color: C.text, fontWeight: 'bold' }}>{u.username[0].toUpperCase()}</text>
                </view>
                <view style={{ flex: 1 }}>
                  <text style={{ fontSize: 15, color: C.text, fontWeight: 'bold' }}>{u.username}</text>
                  <text style={{ fontSize: 13, color: C.secondary }}>@{u.handle}</text>
                </view>
                <Pressable onClick={() => addUser(u)} style={{
                  backgroundColor: C.primary, borderRadius: 10, borderWidth: 0,
                  paddingLeft: 18, paddingRight: 18, paddingTop: 8, paddingBottom: 8,
                }}>
                  <text style={{ fontSize: 13, color: C.onPrimary, fontWeight: 'bold' }}>Add</text>
                </Pressable>
              </view>
            ))}
          </view>
        </scroll>
      ) : (
        <view style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingLeft: 32, paddingRight: 32 }}>
          <icon set="material-rounded" style={{ fontSize: 32, color: C.secondary, lineHeight: 32 }}>search_off</icon>
          <text style={{ fontSize: 15, color: C.secondary, textAlign: 'center', lineHeight: 20 }}>
            {loading         ? 'Loading...'
              : query.trim() ? `No users found for "${query}"`
              : 'No accounts found.'}
          </text>
        </view>
      )}

    </view>
  );
}

// ── HomeScreen ────────────────────────────────────────────────────────────────

export function HomeScreen({ onNavigate, onPreview, friends, onFriendAdd }: Props) {
  const [games,            setGames]            = useState<GameData[]>([]);
  const [items,            setItems]            = useState<AvatarItemData[]>([]);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showProfile,   setShowProfile]   = useState(false);
  const [gamesLoaded,   setGamesLoaded]   = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [g, it] = await Promise.all([fetchGames(200), fetchAvatarItems(3)]);
        if (!cancelled) { setGames(g); setItems(it.slice(0, 3)); }
      } finally {
        if (!cancelled) setGamesLoaded(true);
      }
    };
    refreshRef.current = refresh;
    refresh();
    // Expose so CreateScreen.confirmPublish can poke us when a game is published
    // while Home is mounted (e.g. background mount via Lynx). The conditional
    // unmount in App.tsx already handles tab-switch refetches.
    (Globals as any)._refreshHomeContent = refresh;
    return () => {
      cancelled = true;
      if ((Globals as any)._refreshHomeContent === refresh) {
        (Globals as any)._refreshHomeContent = undefined;
      }
    };
  }, []);

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <scroll className="pludo-scroll" style={{ flex: 1, height: 1 }}>

        {/* Header */}
        <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 14 }}>
          <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5 }}>Home</text>
        </view>

        {/* Friends section */}
        <view style={{ marginBottom: 22 }}>
          <view style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingLeft: 20, paddingRight: 20, marginBottom: 14,
          }}>
            <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold' }}>Friends</text>
            {friends.length > 0 && (
              <text style={{ fontSize: 13, color: C.secondary }}>
                {friends.length} friend{friends.length !== 1 ? 's' : ''}
              </text>
            )}
          </view>
          <scroll className="pludo-scroll" style={{ flexShrink: 0 }}>
            <view style={{ flexDirection: 'row', paddingLeft: 16, paddingRight: 16, paddingBottom: 4, gap: 18 }}>
              <YouBubble onPress={() => setShowProfile(true)} />
              <AddBubble onPress={() => setShowAddFriend(true)} />
              {friends.map(f => <FriendBubble key={f.id} name={f.name} status={f.status} />)}
            </view>
          </scroll>
        </view>

        {/* Published games — every game flipped to published in /api/games */}
        <view style={{ marginLeft: 16, marginRight: 16, marginBottom: 6 }}>
          <view style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold' }}>Games</text>
              {games.length > 0 && (
                <text style={{ fontSize: 13, color: C.secondary }}>
                  {games.length} game{games.length !== 1 ? 's' : ''}
                </text>
              )}
            </view>
            <RefreshButton onRefresh={() => refreshRef.current()} />
          </view>
          {!gamesLoaded
            ? (
              <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                {[0, 1, 2, 3].map(i => <SkeletonGameCard key={i} />)}
              </view>
            )
            : games.length > 0
            ? (
              <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                {games.map(g => <GameCard key={g.id} game={g} onClick={() => onPreview(g)} />)}
              </view>
            )
            : (
              <view style={{ backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingTop: 24, paddingBottom: 24, alignItems: 'center', gap: 6 }}>
                <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center' }}>
                  No games yet — create the first one!
                </text>
                <Pressable onClick={() => onNavigate(2)} style={{ backgroundColor: C.primary, borderRadius: 10, paddingLeft: 18, paddingRight: 18, paddingTop: 8, paddingBottom: 8, borderWidth: 0, marginTop: 8 }}>
                  <text style={{ fontSize: 13, color: C.onPrimary, fontWeight: 'bold' }}>Create a Game</text>
                </Pressable>
              </view>
            )
          }
        </view>

        {/* Hot items — only shown when there are real items in the catalog */}
        {items.length > 0 && (
          <view style={{ marginLeft: 16, marginRight: 16, marginBottom: 24 }}>
            <view style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold' }}>Hot items</text>
              <GlassButton onClick={() => onNavigate(4)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 0 }}>
                <text style={{ fontSize: 13, color: C.primary, fontWeight: 'bold' }}>See all</text>
              </GlassButton>
            </view>
            <view style={{ flexDirection: 'row', gap: 10 }}>
              {items.map((item, i) => <ItemCard key={i} item={item} compact onClick={() => onNavigate(4)} />)}
            </view>
          </view>
        )}

        {/* Clears the floating BottomNav so the last game card stays tappable. */}
        <view style={{ height: bottomNavInset() + 16 }} />

      </scroll>

      {showAddFriend && <AddFriendPage onClose={() => setShowAddFriend(false)} onAdd={onFriendAdd} />}

      {showProfile && <ProfilePreviewPanel onClose={() => setShowProfile(false)} />}
    </view>
  );
}
