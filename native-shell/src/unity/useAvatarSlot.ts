import { useCallback, useEffect, useRef, type ComponentRef } from 'react';
import { useWindowDimensions, type View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useUnity } from './UnityHost';

// Reserve an on-screen slot for the live Unity avatar. Attach `ref` and
// `onLayout` to a plain View: while the screen is focused, the single Unity
// view is measured onto that slot (window coordinates) and shown; on blur it is
// released. The slot must not scroll — Unity is an overlay and won't follow.
export function useAvatarSlot(owner: string, opts: { radius?: number; interactive?: boolean } = {}) {
  const unity = useUnity();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const focused = useRef(false);
  const { radius, interactive } = opts;

  const place = useCallback(() => {
    if (!focused.current) return;
    ref.current?.measureInWindow((x: number, y: number, width: number, height: number) => {
      if (width > 0 && height > 0) unity.showAvatar(owner, { x, y, width, height, radius, interactive });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, radius, interactive, unity.showAvatar]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    // Let the screen finish its transition/layout before measuring.
    const t = setTimeout(place, 50);
    return () => {
      focused.current = false;
      clearTimeout(t);
      unity.hideAvatar(owner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, place]));

  // Re-measure when the window changes size (rotation back from a landscape
  // game/editor) and when Unity returns to avatar mode after one: a slot
  // measured mid-rotation would leave Unity offset over the page.
  const { width, height } = useWindowDimensions();
  const { mode } = unity;
  useEffect(() => {
    if (mode !== 'avatar' && mode !== 'hidden') return;
    // Several passes: the rotation back from landscape can take ~1 s to settle.
    const timers = [150, 500, 1000, 1800].map(ms => setTimeout(place, ms));
    return () => timers.forEach(clearTimeout);
  }, [width, height, mode, place]);

  return { ref, onLayout: place };
}
