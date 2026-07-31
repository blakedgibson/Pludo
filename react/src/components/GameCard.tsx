import React from 'react';
import { C } from '../theme';
import { CARD_WIDTH_PCT } from '../responsive';
import { Pressable } from './Pressable';
import { GameData } from '../types';

const GENRE_ICON: Record<string, string> = {
  platformer: 'directions_run',
  strategy:   'extension',
  survival:   'local_fire_department',
  simulation: 'paid',
  racer:      'directions_car',
  puzzle:     'extension',
  adventure:  'swords',
};

interface Props {
  game: GameData;
  onClick?: () => void;
}

// 16:9 game tile. Mirrors the My Games tile in CreateScreen.
//
// Sizing trick: the card has only absolutely-positioned children (image, icon,
// title overlay), which give Yoga nothing in-flow to measure. Putting
// aspectRatio on the outer container alone leaves the absolute children with
// no resolved parent height — the card paints its background but the children
// collapse and overflow downward. The fix is a relative-positioned spacer as
// the first child that owns aspectRatio; that drives the container's height,
// and the absolute children layer on top.
export function GameCard({ game, onClick }: Props) {
  return (
    <Pressable
      onClick={onClick}
      style={{
        width: CARD_WIDTH_PCT, marginBottom: 10,
        borderRadius: 14, overflow: 'hidden',
        borderWidth: 1, borderColor: C.border,
        backgroundColor: C.surface, position: 'relative',
      }}
    >
      <view style={{ width: '100%', aspectRatio: 16 / 9 }} />

      {game.thumbnailUrl ? (
        <image
          src={game.thumbnailUrl}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, objectFit: 'cover' } as any}
        />
      ) : (
        <view style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
          <icon set="material-rounded" style={{ fontSize: 56, color: C.primary, lineHeight: 56 }}>
            {GENRE_ICON[game.genre ?? ''] ?? 'sports_esports'}
          </icon>
        </view>
      )}

      {game.isHot && (
        <view style={{
          position: 'absolute', top: 8, left: 8,
          backgroundColor: C.accent,
          borderRadius: 12, paddingLeft: 9, paddingRight: 9, paddingTop: 3, paddingBottom: 3,
        }}>
          <text style={{ fontSize: 11, color: '#0A0A0B', fontWeight: 'bold' }}>Hot</text>
        </view>
      )}

      <view
        className="game-card-title-overlay"
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10,
          backgroundColor: 'rgba(0,0,0,0.72)',
          borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
        }}
      >
        <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold', maxLines: 1, textOverflow: 'ellipsis' } as any}>
          {game.title || 'Untitled Game'}
        </text>
        {game.creatorName ? (
          <text style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2, maxLines: 1, textOverflow: 'ellipsis' } as any}>
            by {game.creatorName}
          </text>
        ) : null}
      </view>
    </Pressable>
  );
}
