import React, { useEffect, useState } from 'react';
import { C } from '../theme';
import { CONTENT_MAX_WIDTH } from '../responsive';
import { GameData } from '../types';
import { fetchMyGames, formatCount } from '../api';
import { safeAreaTop } from '../safeArea';
import { bottomNavInset } from '../components/BottomNav';
import { Skeleton } from '../components/Skeleton';
import { GlassButton } from '../components/GlassButton';

interface Props {
  onNavigate: (section: number) => void;
}

export function PublicProfileScreen({ onNavigate }: Props) {
  const [games,    setGames]    = useState<GameData[]>([]);
  const [username, setUsername] = useState('');
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    // Try to get username from Unity globals
    try {
      const raw = (Globals as any).getUsername?.();
      if (raw) setUsername(String(raw));
    } catch { /* globals not ready yet */ }

    fetchMyGames().then(g => {
      setGames(g);
      setLoading(false);
    });
  }, []);

  const totalPlays = games.reduce((sum, g) => sum + (g.plays ?? 0), 0);

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>

      {/* Header */}
      <view style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 12, gap: 12 }}>
        <GlassButton onClick={() => onNavigate(0)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.text, lineHeight: 24 }}>arrow_back</icon>
        </GlassButton>
        <text style={{ fontSize: 24, color: C.text, fontWeight: 'bold', flex: 1 }}>Public Profile</text>
        <GlassButton onClick={() => onNavigate(2)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.secondary, lineHeight: 24 }}>arrow_forward</icon>
        </GlassButton>
      </view>

      <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 20, paddingRight: 20 }}>

        {/* Avatar + name card */}
        <view style={{ backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.border, alignItems: 'center', paddingTop: 28, paddingBottom: 24, marginBottom: 20 }}>
          <view style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 12, borderWidth: 3, borderColor: C.primary }}>
            <text style={{ fontSize: 32, color: C.text, fontWeight: 'bold' }}>
              {username ? username[0].toUpperCase() : 'Y'}
            </text>
          </view>
          <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', marginBottom: 4 }}>
            {username || 'You'}
          </text>
          {username ? (
            <text style={{ fontSize: 13, color: C.secondary }}>@{username}</text>
          ) : null}
        </view>

        {/* Stats row */}
        <view style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
          <view style={{ flex: 1, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, alignItems: 'center', paddingTop: 16, paddingBottom: 16 }}>
            <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', marginBottom: 2 }}>{games.length}</text>
            <text style={{ fontSize: 12, color: C.secondary }}>Games</text>
          </view>
          <view style={{ flex: 1, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, alignItems: 'center', paddingTop: 16, paddingBottom: 16 }}>
            <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', marginBottom: 2 }}>0</text>
            <text style={{ fontSize: 12, color: C.secondary }}>Friends</text>
          </view>
          <view style={{ flex: 1, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, alignItems: 'center', paddingTop: 16, paddingBottom: 16 }}>
            <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', marginBottom: 2 }}>{formatCount(totalPlays)}</text>
            <text style={{ fontSize: 12, color: C.secondary }}>Plays</text>
          </view>
        </view>

        {/* My games */}
        <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold', marginBottom: 12 }}>My Games</text>
        {loading ? (
          <view style={{ gap: 10 }}>
            {[0, 1, 2].map(i => <Skeleton key={i} height={76} radius={14} />)}
          </view>
        ) : games.length === 0 ? (
          <view style={{ backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, alignItems: 'center', paddingTop: 28, paddingBottom: 28, gap: 6 }}>
            <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center' }}>No games yet.</text>
            <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center' }}>Go to the Create tab to build your first game!</text>
          </view>
        ) : (
          <view style={{ gap: 10, marginBottom: 24 }}>
            {games.map(g => (
              <view key={g.id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingLeft: 14, paddingRight: 14, paddingTop: 14, paddingBottom: 14, gap: 14 }}>
                <view style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <icon set="material-rounded" style={{ fontSize: 22, color: C.primary, lineHeight: 22 }}>sports_esports</icon>
                </view>
                <view style={{ flex: 1 }}>
                  <text style={{ fontSize: 15, color: C.text, fontWeight: 'bold' }}>{g.title}</text>
                  <text style={{ fontSize: 12, color: C.secondary }}>{formatCount(g.plays)} plays · {g.genre ?? 'Game'}</text>
                </view>
                <icon set="material-rounded" style={{ fontSize: 22, color: C.secondary, lineHeight: 22 }}>chevron_right</icon>
              </view>
            ))}
          </view>
        )}

        <text style={{ fontSize: 12, color: C.secondary, textAlign: 'center', marginBottom: 24 }}>Swipe left to go back  ·  Swipe right for Settings</text>

        <view style={{ height: bottomNavInset() }} />

      </scroll>
      </view>
    </view>
  );
}
