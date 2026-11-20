import React, { useEffect, useRef, useState } from 'react';
import { C } from '../theme';
import { Pressable } from './Pressable';

interface Props {
  onRefresh: () => Promise<void> | void;
  size?: number;
}

// Spinning refresh affordance. Tap → calls onRefresh and visually spins until
// the returned promise resolves (or 600 ms passes for sync handlers, so the
// user gets at least one full rotation as confirmation). True pull-to-refresh
// would need scroll offset which ReactUnity doesn't expose; this gives the
// same UX with reliable behavior.
//
// Rotation is driven by setInterval(16ms) + manual `rotate` style, since
// CSS @keyframes / transitions aren't honored in ReactUnity's renderer.
export function RefreshButton({ onRefresh, size = 36 }: Props) {
  const [spinning, setSpinning] = useState(false);
  const [angle,    setAngle]    = useState(0);
  const angleRef = useRef(0);
  const animRef  = useRef<any>(null);

  useEffect(() => {
    if (!spinning) return;
    animRef.current = setInterval(() => {
      angleRef.current = (angleRef.current + 12) % 360;
      setAngle(angleRef.current);
    }, 16);
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, [spinning]);

  async function handleClick() {
    if (spinning) return;
    setSpinning(true);
    const started = Date.now();
    try { await onRefresh(); } catch { /* swallow — UI just stops spinning */ }
    // Hold the spinner for at least 600ms so a cached/instant refresh still
    // reads as "something happened" rather than a brief twitch.
    const elapsed = Date.now() - started;
    if (elapsed < 600) await new Promise(r => setTimeout(r, 600 - elapsed));
    setSpinning(false);
  }

  return (
    <Pressable onClick={handleClick} style={{
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: C.card,
      borderWidth: 1, borderColor: C.border,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <view style={{ rotate: angle } as any}>
        <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>refresh</icon>
      </view>
    </Pressable>
  );
}
