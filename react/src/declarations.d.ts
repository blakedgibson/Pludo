import type { CSSProperties, HTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, ImgHTMLAttributes, ReactNode, Key } from 'react';

type RUBase = {
  key?: Key | null;
  children?: ReactNode;
  style?: CSSProperties;
  onPointerDown?: (e: any) => void;
  onPointerUp?: (e: any) => void;
  onPointerMove?: (e: any) => void;
  onBeginDrag?: (e: any) => void;
  onDrag?: (e: any) => void;
  onEndDrag?: (e: any) => void;
};

declare module 'react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      view:   HTMLAttributes<HTMLElement>   & RUBase;
      text:   HTMLAttributes<HTMLElement>   & RUBase;
      button: ButtonHTMLAttributes<HTMLButtonElement> & RUBase & { onClick?: () => void };
      scroll: HTMLAttributes<HTMLElement>   & RUBase & { horizontal?: boolean };
      input:  InputHTMLAttributes<HTMLInputElement>   & RUBase;
      icon:   HTMLAttributes<HTMLElement>   & RUBase & { set?: string };
      image:  ImgHTMLAttributes<HTMLImageElement>     & RUBase;
    }
  }
}

declare const Globals: Record<string, any>;
