import React, { useEffect, useState } from 'react';
import { C } from '../theme';
import { safeAreaTop } from '../safeArea';
import { GameData } from '../types';
import { fetchGames } from '../api';
import { GameCard } from '../components/GameCard';
import { GlassButton } from '../components/GlassButton';

export function GamesScreen({ onPlay }: { onPlay?: (gameId: number) => void }) {
  const [games, setGames] = useState<GameData[]>([]);
  const [query, setQuery] = useState('');
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    fetchGames(20).then(setGames).catch(() => setFetchError(true));
  }, []);

  const filtered = games.filter(g =>
    !query || g.title.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>

      {/* Header */}
      <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 4 }}>
        <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5 }}>Games</text>
      </view>

      {/* Search */}
      <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 12 }}>
        <view style={{ backgroundColor: C.card, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 11, paddingBottom: 11 }}>
          <icon set="material-rounded" style={{ fontSize: 18, color: C.secondary, lineHeight: 18, marginRight: 8 }}>search</icon>
          <input value={query} onChange={(val: any) => setQuery(val)}
            placeholder="Search games..."
            style={{ flex: 1, fontSize: 15, color: C.text, backgroundColor: 'transparent', borderWidth: 0, minHeight: 40 }} />
        </view>
      </view>

      {/* Section header */}
      <view style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 16, paddingRight: 16, marginBottom: 12 }}>
        <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold' }}>All games</text>
        <GlassButton onClick={() => {}} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
          <text style={{ fontSize: 15, color: C.green, fontWeight: 'bold' }}>Filter</text>
        </GlassButton>
      </view>

      {/* Games grid */}
      {fetchError ? (
        <view style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <text style={{ fontSize: 17, color: C.secondary, textAlign: 'center' }}>
            Could not load games. Check your connection and try again.
          </text>
        </view>
      ) : (
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16 }}>
          <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {filtered.map(g => (
              <GameCard key={g.id} game={g} onClick={onPlay ? () => onPlay(g.id) : undefined} />
            ))}
          </view>
        </scroll>
      )}

    </view>
  );
}
