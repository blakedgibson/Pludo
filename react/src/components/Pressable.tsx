import React, { useRef, useState } from 'react';
import { lg } from '../glass';

// Shared press-feedback wrapper. Renders a <view onClick> (not <button>, which
// in ReactUnity doesn't establish a positioning context for absolute children
// — see GameCard's history). Press state is tracked via pointer events and
// applied as an opacity dip + slight scale-down; that's how native iOS buttons
// feel. ReactUnity exposes `scale` as a direct style property (see
// PackageCache/com.reactunity.core/.../TransformShorthand.cs), so we set it
// inline. CSS transitions aren't honored, so the snap is intentional.
//
// The pressed state activates after a 60ms hold so a flick that becomes a
// scroll-start never lights the button up — important inside <scroll> lists.

interface Props {
  onClick?: () => void;
  style?: any;
  pressedStyle?: any;
  pressedOpacity?: number;
  pressedScale?: number;
  disabled?: boolean;
  disabledOpacity?: number;
  className?: string;
  children?: any;
  /** Apply the Liquid Glass material to filled styles (default on). */
  glass?: boolean;
}

export function Pressable({
  onClick,
  style,
  pressedStyle,
  pressedOpacity = 0.72,
  pressedScale   = 0.97,
  disabled       = false,
  disabledOpacity = 0.4,
  className,
  children,
  glass = true,
}: Props) {
  if (glass) style = lg(style);
  const [pressed, setPressed] = useState(false);
  const holdRef = useRef<any>(null);

  function clearHold() {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; }
  }
  function arm() {
    if (disabled) return;
    clearHold();
    holdRef.current = setTimeout(() => { holdRef.current = null; setPressed(true); }, 60);
  }
  function release() {
    clearHold();
    if (pressed) setPressed(false);
  }

  return (
    <view
      onPointerDown={arm}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onClick={disabled ? undefined : onClick}
      className={className}
      style={{
        ...style,
        opacity: disabled
          ? disabledOpacity
          : pressed
            ? pressedOpacity
            : (style?.opacity ?? 1),
        ...(pressed && !disabled ? { scale: pressedScale, ...pressedStyle } : null),
      }}
    >
      {children}
    </view>
  );
}
