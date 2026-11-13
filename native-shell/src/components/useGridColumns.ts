import { useWindowDimensions } from 'react-native';

/** Card-grid columns for the current window: phones 1, iPad portrait / split
 *  view 2, iPad landscape 3. Also the content width cap, so a single column
 *  never stretches edge to edge on a big screen. */
export function useGridColumns(): { cols: number; isTablet: boolean; maxWidth: number } {
  const { width, height } = useWindowDimensions();
  const isTablet = Math.min(width, height) >= 600;
  const cols = width >= 1100 ? 3 : width >= 680 ? 2 : 1;
  return { cols, isTablet, maxWidth: cols === 1 ? 640 : 1400 };
}
