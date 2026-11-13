import React from 'react';
import { C, RARITY } from '../theme';
import { CARD_WIDTH_PCT } from '../responsive';
import { Pressable } from './Pressable';
import { AvatarItemData } from '../types';

interface Props {
  item: AvatarItemData;
  compact?: boolean;
  onClick?: () => void;
}

export function ItemCard({ item, compact = false, onClick }: Props) {
  const rarityColor = RARITY[item.rarity] ?? C.secondary;

  if (compact) {
    return (
      <Pressable onClick={onClick} style={{
        flex: 1,
        height: 108,
        backgroundColor: C.card,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
        alignItems: 'stretch',
      }}>
        <view style={{
          flex: 1, backgroundColor: C.surface,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <icon set="material-rounded-filled" style={{ fontSize: 26, color: rarityColor, lineHeight: 26 }}>diamond</icon>
          <view style={{
            position: 'absolute', top: 8, right: 8,
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: rarityColor,
          }} />
        </view>
      </Pressable>
    );
  }

  return (
    <Pressable onClick={onClick} style={{
      width: CARD_WIDTH_PCT,
      backgroundColor: item.equipped ? C.primaryTint : C.card,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: item.equipped ? C.primaryBorder : C.border,
      marginBottom: 10,
      overflow: 'hidden',
      alignItems: 'stretch',
    }}>
      <view style={{
        height: 100, backgroundColor: C.surface,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded-filled" style={{ fontSize: 26, color: rarityColor, lineHeight: 26 }}>diamond</icon>
        <view style={{
          position: 'absolute', top: 8, right: 8,
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: rarityColor,
        }} />
      </view>
      <view style={{ padding: 10, gap: 2 }}>
        <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold' }}>{item.name}</text>
        <text style={{ fontSize: 12, color: C.secondary }}>{item.category}</text>
        <view style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <text style={{ fontSize: 11, color: rarityColor, fontWeight: 'bold' }}>{item.rarity}</text>
          <text style={{ fontSize: 11, color: C.primary, fontWeight: 'bold' }}>
            {item.price > 0 ? `${item.price} G` : 'Free'}
          </text>
        </view>
      </view>
    </Pressable>
  );
}
