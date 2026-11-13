import React, { useEffect, useRef, useState } from 'react';
import { C, RARITY } from '../theme';
import { GameData, AvatarItemData, UserResult } from '../types';
import { fetchGames, fetchAvatarItems, searchUsers } from '../api';
import { GameCard } from '../components/GameCard';
import { SkeletonGameCard } from '../components/Skeleton';
import { RefreshButton } from '../components/RefreshButton';
import { safeAreaTop } from '../safeArea';
import { bottomNavInset } from '../components/BottomNav';
import { GlassButton } from '../components/GlassButton';

// `trailing` renders a right-aligned control (eg. the refresh button) inside
// the header row rather than in a wrapper around it — a wrapper would stack
// its own margin on top of this one and knock the control out of vertical
// alignment with the title.
function SectionHeader({ title, count, trailing }: { title: string; count?: number; trailing?: React.ReactNode }) {
  return (
    <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold' }}>{title}</text>
      {count != null ? (
        <view style={{ backgroundColor: C.surface, borderRadius: 10, paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2 }}>
          <text style={{ fontSize: 12, color: C.secondary, fontWeight: 'bold' }}>{count}</text>
        </view>
      ) : null}
      {trailing ? (
        <>
          <view style={{ flex: 1 }} />
          {trailing}
        </>
      ) : null}
    </view>
  );
}

function UserRow({ user }: { user: UserResult }) {
  return (
    <view style={{
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: C.card, borderRadius: 14,
      borderWidth: 1, borderColor: C.border,
      paddingLeft: 14, paddingRight: 14,
      paddingTop: 12, paddingBottom: 12,
      marginBottom: 8,
    }}>
      <view style={{
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: C.surface,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <text style={{ fontSize: 16, color: C.text, fontWeight: 'bold' }}>
          {user.username.charAt(0).toUpperCase()}
        </text>
      </view>
      <view style={{ flex: 1 }}>
        <text style={{ fontSize: 15, color: C.text, fontWeight: 'bold' }}>{user.username}</text>
        <text style={{ fontSize: 12, color: C.secondary }}>@{user.handle}</text>
      </view>
    </view>
  );
}

function ItemRow({ item }: { item: AvatarItemData }) {
  const rarityColor = RARITY[item.rarity] ?? C.secondary;
  return (
    <view style={{
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: C.card, borderRadius: 14,
      borderWidth: 1, borderColor: C.border,
      paddingLeft: 14, paddingRight: 14,
      paddingTop: 12, paddingBottom: 12,
      marginBottom: 8,
    }}>
      <view style={{
        width: 40, height: 40, borderRadius: 10,
        backgroundColor: C.surface,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded-filled" style={{ fontSize: 20, color: C.text, lineHeight: 20 }}>diamond</icon>
      </view>
      <view style={{ flex: 1 }}>
        <text style={{ fontSize: 15, color: C.text, fontWeight: 'bold' }}>{item.name}</text>
        <text style={{ fontSize: 12, color: C.secondary }}>{item.category}</text>
      </view>
      <view style={{
        backgroundColor: `${rarityColor}22`,
        borderRadius: 8, borderWidth: 1, borderColor: rarityColor,
        paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3,
      }}>
        <text style={{ fontSize: 11, color: rarityColor, fontWeight: 'bold' }}>{item.rarity}</text>
      </view>
    </view>
  );
}

export function ExploreScreen({ onPreview }: { onPreview: (game: GameData) => void }) {
  const [query,      setQuery]      = useState('');
  const [allGames,   setAllGames]   = useState<GameData[]>([]);
  const [allItems,   setAllItems]   = useState<AvatarItemData[]>([]);
  const [resGames,   setResGames]   = useState<GameData[]>([]);
  const [resUsers,   setResUsers]   = useState<UserResult[]>([]);
  const [resItems,   setResItems]   = useState<AvatarItemData[]>([]);
  const [searching,  setSearching]  = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [loaded,     setLoaded]     = useState(false);
  const debounce = useRef<any>(null);

  const refreshRef = useRef<() => Promise<void>>(async () => {});

  // Load everything on mount so client-side filtering is instant
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [g, it] = await Promise.all([fetchGames(50), fetchAvatarItems(100)]);
        if (!cancelled) { setAllGames(g); setAllItems(it); setFetchError(false); setLoaded(true); }
      } catch {
        if (!cancelled) { setFetchError(true); setLoaded(true); }
      }
    };
    refreshRef.current = refresh;
    refresh();
    (Globals as any)._refreshExploreContent = refresh;
    return () => {
      cancelled = true;
      if ((Globals as any)._refreshExploreContent === refresh) {
        (Globals as any)._refreshExploreContent = undefined;
      }
    };
  }, []);

  // Debounced search across all three data sources
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);

    if (!query.trim()) {
      setResGames([]); setResUsers([]); setResItems([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    debounce.current = setTimeout(async () => {
      const q = query.trim().toLowerCase();

      const matchedGames = allGames.filter(g =>
        g.title.toLowerCase().includes(q) ||
        (g.description ?? '').toLowerCase().includes(q) ||
        (g.genre ?? '').toLowerCase().includes(q) ||
        (g.creatorName ?? '').toLowerCase().includes(q)
      );

      const matchedItems = allItems.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        i.rarity.toLowerCase().includes(q) ||
        (i.description ?? '').toLowerCase().includes(q)
      );

      const users = await searchUsers(q);

      setResGames(matchedGames);
      setResUsers(users);
      setResItems(matchedItems);
      setSearching(false);
    }, 320);

    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, allGames, allItems]);

  const hasQuery   = query.trim().length > 0;
  const hasResults = resGames.length > 0 || resUsers.length > 0 || resItems.length > 0;

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>

      {/* Header */}
      <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 6 }}>
        <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5 }}>Explore</text>
      </view>

      {/* Search bar */}
      <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 12 }}>
        <view style={{
          backgroundColor: C.card, borderRadius: 14,
          flexDirection: 'row', alignItems: 'center',
          paddingLeft: 14, paddingRight: 14,
          paddingTop: 11, paddingBottom: 11,
          borderWidth: 1, borderColor: query ? C.primary : C.border,
          gap: 10,
        }}>
          <icon set="material-rounded" style={{ fontSize: 20, color: searching ? C.primary : C.secondary, lineHeight: 20 }}>search</icon>
          <input
            value={query}
            onChange={(val: any) => setQuery(val)}
            placeholder="Search games, people, items..."
            style={{
              flex: 1, fontSize: 15, color: C.text,
              backgroundColor: 'transparent', borderWidth: 0, minHeight: 38,
            }}
          />
          {query.length > 0 ? (
            <GlassButton onClick={() => setQuery('')} style={{ backgroundColor: C.surface, borderRadius: 10, borderWidth: 0, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
              <icon set="material-rounded" style={{ fontSize: 14, color: C.secondary, lineHeight: 14 }}>close</icon>
            </GlassButton>
          ) : null}
        </view>
      </view>

      {fetchError ? (
        <view style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <text style={{ fontSize: 15, color: C.secondary, textAlign: 'center' }}>
            Could not load content. Check your connection.
          </text>
        </view>
      ) : (
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16 }}>

          {/* ── Search results ── */}
          {hasQuery ? (
            <view style={{ paddingBottom: 24 }}>
              {!hasResults && !searching ? (
                <view style={{ alignItems: 'center', paddingTop: 40, gap: 8 }}>
                  <icon set="material-rounded" style={{ fontSize: 36, color: C.secondary, lineHeight: 36 }}>search_off</icon>
                  <text style={{ fontSize: 16, color: C.secondary, textAlign: 'center' }}>
                    No results for "{query}"
                  </text>
                </view>
              ) : null}

              {/* People */}
              {resUsers.length > 0 ? (
                <view style={{ marginBottom: 20 }}>
                  <SectionHeader title="People" count={resUsers.length} />
                  {resUsers.map(u => <UserRow key={u.id} user={u} />)}
                </view>
              ) : null}

              {/* Games */}
              {resGames.length > 0 ? (
                <view style={{ marginBottom: 20 }}>
                  <SectionHeader title="Games" count={resGames.length} />
                  <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                    {resGames.map(g => (
                      <GameCard key={g.id} game={g} onClick={() => onPreview(g)} />
                    ))}
                  </view>
                </view>
              ) : null}

              {/* Items */}
              {resItems.length > 0 ? (
                <view style={{ marginBottom: 20 }}>
                  <SectionHeader title="Items" count={resItems.length} />
                  {resItems.map((item, i) => <ItemRow key={i} item={item} />)}
                </view>
              ) : null}
            </view>

          ) : (
            /* ── Default browse view ── */
            <view style={{ paddingBottom: 24 }}>
              <SectionHeader
                title="Popular Games"
                trailing={<RefreshButton onRefresh={() => refreshRef.current()} />}
              />
              {!loaded ? (
                <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  {[0, 1, 2, 3, 4, 5].map(i => <SkeletonGameCard key={i} />)}
                </view>
              ) : allGames.length === 0 ? (
                <view style={{ alignItems: 'center', paddingTop: 24, gap: 6 }}>
                  <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center' }}>No games yet. Create one!</text>
                </view>
              ) : (
                <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  {allGames.map(g => (
                    <GameCard key={g.id} game={g} onClick={() => onPreview(g)} />
                  ))}
                </view>
              )}
            </view>
          )}

          {/* Bottom spacer so the last row of cards isn't hidden behind the
              floating BottomNav (which is anchored absolute at the App root).
              Include safe-area-bottom so the spacer matches the nav's full
              footprint on devices with a home-indicator bezel. On tablet the
              nav is a left rail instead — the bottom edge is clear, so this
              only needs the safe-area inset, not the nav's own height. */}
          <view style={{ height: bottomNavInset() + 16 }} />

        </scroll>
      )}
    </view>
  );
}
