import React, { useEffect, useState } from 'react';
import { FlatList, PanResponder, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Button, Host } from '@expo/ui/swift-ui';
import { buttonBorderShape, buttonStyle, controlSize, labelStyle } from '@expo/ui/swift-ui/modifiers';
import type { EditorCommand } from './EditorChrome';

/** A strip tile as reported by ReactUnity (see hostAssetsJson in CreateScreen). */
export interface StripAsset {
  cacheKey: string;
  prompt: string;
  title?: string | null;
  thumbnailUrl?: string | null;
}

const TILE = 56;
const DRAG_START = 12;   // pt the finger must travel upward before a drag begins
const TAP_SLOP = 10;     // pt of travel still counted as a tap

// Native asset strip along the bottom of the editor (phase 3). Tap a tile to
// drop that model in front of the camera; drag a tile up into the scene and
// release to place it under your finger. Horizontal swipes still scroll the
// strip: a tile only claims the gesture once the finger heads upward. The
// placement itself is done by Unity (editorPlaceAsset) — the finger never
// reaches Unity's view, so a ghost thumbnail follows it here instead.
export function AssetStrip({ assets, left, right, plusRight, bottom, onCommand, onOpenLibrary }: {
  assets: StripAsset[];
  left: number; right: number; plusRight: number; bottom: number;
  onCommand: (cmd: EditorCommand) => void;
  onOpenLibrary: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [ghost, setGhost] = useState<{ asset: StripAsset; x: number; y: number } | null>(null);
  const stripTop = height - bottom - TILE;

  return (
    <>
      {assets.length > 0 && (
        // Sized to its tiles (up to the space left of the + button).
        <View style={[styles.strip, { left, bottom, width: Math.min(assets.length * TILE, width - left - right) }]}>
          <FlatList
            horizontal
            data={assets}
            keyExtractor={a => a.cacheKey}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <Tile
                asset={item}
                onTap={() => onCommand(`assetCenter:${item.cacheKey}`)}
                onDragMove={(x, y) => setGhost({ asset: item, x, y })}
                onDragEnd={(x, y) => {
                  setGhost(null);
                  // Released back over the strip = cancel.
                  if (y < stripTop - 4) {
                    onCommand(`assetPlace:${JSON.stringify({ key: item.cacheKey, fx: x / width, fy: y / height })}`);
                  }
                }}
                onDragCancel={() => setGhost(null)}
              />
            )}
          />
        </View>
      )}

      {/* Asset library — SwiftUI glass so the glyph adapts to the scene
          behind it (dark over a bright sky), like undo/redo. */}
      <View style={[styles.plusWrap, { right: plusRight, bottom }]}>
        <Host matchContents>
          <Button
            label="Add models"
            systemImage="plus"
            onPress={onOpenLibrary}
            modifiers={[buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('extraLarge')]}
          />
        </Host>
      </View>

      {ghost && (
        <View pointerEvents="none" style={[styles.ghost, { left: ghost.x - TILE / 2, top: ghost.y - TILE / 2 }]}>
          <TileFace asset={ghost.asset} />
        </View>
      )}
    </>
  );
}

function Tile({ asset, onTap, onDragMove, onDragEnd, onDragCancel }: {
  asset: StripAsset;
  onTap: () => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
  onDragCancel: () => void;
}) {
  // One mutable box per tile (held in state, so it lives as long as the tile):
  // the responder is created once and reads the latest callbacks from it.
  const [box] = useState(() => ({ dragging: false, cb: { onTap, onDragMove, onDragEnd, onDragCancel } }));
  // The box is deliberately mutable (it is never rendered from): PanResponder
  // handlers are bound once, so they must read the newest callbacks from it.
  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { box.cb = { onTap, onDragMove, onDragEnd, onDragCancel }; });

  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => g.dy < -DRAG_START && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => { box.dragging = false; },
    onPanResponderMove: (e, g) => {
      if (!box.dragging && g.dy < -DRAG_START && Math.abs(g.dy) > Math.abs(g.dx)) box.dragging = true;
      if (box.dragging) box.cb.onDragMove(e.nativeEvent.pageX, e.nativeEvent.pageY);
    },
    onPanResponderRelease: (e, g) => {
      if (box.dragging) box.cb.onDragEnd(e.nativeEvent.pageX, e.nativeEvent.pageY);
      else if (Math.hypot(g.dx, g.dy) < TAP_SLOP) box.cb.onTap();
      box.dragging = false;
    },
    // A horizontal swipe hands the touch to the strip's scroll view; once a
    // placement drag has started the tile keeps it.
    onPanResponderTerminationRequest: () => !box.dragging,
    onPanResponderTerminate: () => { box.dragging = false; box.cb.onDragCancel(); },
  }));

  return (
    <View {...responder.panHandlers} accessibilityRole="button" accessibilityLabel={asset.title || asset.prompt}>
      <TileFace asset={asset} />
    </View>
  );
}

function TileFace({ asset }: { asset: StripAsset }) {
  if (asset.thumbnailUrl) {
    return <Image source={{ uri: asset.thumbnailUrl }} style={styles.tile} contentFit="cover" />;
  }
  const words = asset.prompt.match(/[A-Za-z]+/g) ?? [];
  const initials = ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '•';
  return (
    <View style={[styles.tile, styles.initialsTile]}>
      <Text style={styles.initials}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    position: 'absolute', height: TILE,
    borderRadius: 14, overflow: 'hidden',
    backgroundColor: 'rgba(20,20,22,0.55)',
  },
  tile: { width: TILE, height: TILE, backgroundColor: '#1a1a1a' },
  initialsTile: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontSize: 14, fontWeight: '700' },
  plusWrap: { position: 'absolute' },
  ghost: { position: 'absolute', width: TILE, height: TILE, borderRadius: 12, overflow: 'hidden', opacity: 0.85 },
});
