import React, { useEffect, useState } from 'react';
import { C } from '../theme';
import { CARD_WIDTH_PCT } from '../responsive';

// Pulsing placeholder block for loading states. One module-level interval
// drives every Skeleton instance so we never run more than a single 50 ms
// timer regardless of how many are on screen. Each Skeleton subscribes to
// the shared opacity value via useState.

let _sharedOpacity = 0.55;
let _direction = 1;
const _listeners = new Set<(v: number) => void>();
let _interval: any = null;

function ensureTicker() {
  if (_interval) return;
  _interval = setInterval(() => {
    _sharedOpacity += _direction * 0.04;
    if (_sharedOpacity >= 0.85) { _sharedOpacity = 0.85; _direction = -1; }
    if (_sharedOpacity <= 0.35) { _sharedOpacity = 0.35; _direction =  1; }
    _listeners.forEach(fn => fn(_sharedOpacity));
  }, 50);
}

function stopTicker() {
  if (_listeners.size > 0) return;
  if (_interval) { clearInterval(_interval); _interval = null; }
}

interface Props {
  width?:  number | string;
  height?: number | string;
  radius?: number;
  style?:  any;
}

export function Skeleton({ width = '100%', height = 14, radius = 8, style }: Props) {
  const [opacity, setOpacity] = useState(_sharedOpacity);

  useEffect(() => {
    _listeners.add(setOpacity);
    ensureTicker();
    return () => {
      _listeners.delete(setOpacity);
      stopTicker();
    };
  }, []);

  return (
    <view style={{
      width, height, borderRadius: radius,
      backgroundColor: C.card,
      opacity,
      ...style,
    }} />
  );
}

// 16:9 game-tile-shaped skeleton — drop-in replacement for a row of GameCards
// while the games endpoint is loading. Uses the same spacer-driven-aspect
// pattern as GameCard so the rectangle paints at the right shape.
export function SkeletonGameCard() {
  const [opacity, setOpacity] = useState(_sharedOpacity);

  useEffect(() => {
    _listeners.add(setOpacity);
    ensureTicker();
    return () => {
      _listeners.delete(setOpacity);
      stopTicker();
    };
  }, []);

  return (
    <view style={{
      width: CARD_WIDTH_PCT, marginBottom: 10,
      borderRadius: 14, overflow: 'hidden',
      borderWidth: 1, borderColor: C.border,
      backgroundColor: C.card,
      opacity,
      position: 'relative',
    }}>
      <view style={{ width: '100%', aspectRatio: 16 / 9 }} />
    </view>
  );
}
