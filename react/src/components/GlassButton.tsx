import React from 'react';
import { lg } from '../glass';

// Drop-in replacement for ReactUnity's <button>: identical props, but the style
// is run through lg() so every button in the app picks up the Liquid Glass
// material (see glass.ts). Pass glass={false} to render the plain button —
// used for creator-authored game UI, whose look belongs to the game.
export function GlassButton({ glass = true, style, children, ...rest }: any) {
  return React.createElement('button', { ...rest, style: glass ? lg(style) : style }, children);
}
