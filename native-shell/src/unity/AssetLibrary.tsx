import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { fetchAssets, type EditorAsset } from '../api';

const GAP = 8;

// Native asset library (phase 3) — replaces ReactUnity's ShopScreen sheet in
// the editor. Search the shared model library, tap models to select them, and
// "Add" puts them in this game's strip (models already there show a check and
// can't be picked twice). Landscape-only: the editor never rotates.
export function AssetLibrary({ visible, inStrip, onClose, onAdd }: {
  visible: boolean;
  inStrip: Set<string>;
  onClose: () => void;
  onAdd: (picked: EditorAsset[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<EditorAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, EditorAsset>>(new Map());

  // Load (and re-search, debounced) while open.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetchAssets(query)
        .then(list => { if (!cancelled) { setAssets(list); setError(null); } })
        .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });
    }, query ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [visible, query]);

  const padH = Math.max(insets.left, insets.right, 16);
  const cols = Math.max(4, Math.floor((width - padH * 2 + GAP) / (110 + GAP)));
  const tile = (width - padH * 2 - GAP * (cols - 1)) / cols;
  const pickedList = useMemo(() => [...picked.values()], [picked]);

  function toggle(a: EditorAsset) {
    if (inStrip.has(a.cacheKey)) return;
    setPicked(prev => {
      const next = new Map(prev);
      if (next.has(a.cacheKey)) next.delete(a.cacheKey); else next.set(a.cacheKey, a);
      return next;
    });
  }
  function close() { setPicked(new Map()); setQuery(''); onClose(); }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      supportedOrientations={['landscape-left', 'landscape-right']}
      onRequestClose={close}
    >
      <View style={[styles.page, { paddingTop: Math.max(insets.top, 10), paddingHorizontal: padH }]}>
        <View style={styles.header}>
          <Pressable onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
            <GlassView style={styles.round} glassEffectStyle="regular" isInteractive>
              <SymbolView name="xmark" size={16} weight="semibold" tintColor="#fff" />
            </GlassView>
          </Pressable>
          <GlassView style={styles.search} glassEffectStyle="regular">
            <SymbolView name="magnifyingglass" size={16} tintColor="#8E8E93" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor="#8E8E93"
              style={styles.searchInput}
              returnKeyType="search"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </GlassView>
          <Pressable
            onPress={() => { onAdd(pickedList); close(); }}
            disabled={pickedList.length === 0}
            accessibilityRole="button"
            accessibilityLabel="Add selected models"
          >
            <View style={[styles.add, pickedList.length === 0 && styles.addOff]}>
              <Text style={styles.addText}>{pickedList.length ? `Add (${pickedList.length})` : 'Add'}</Text>
            </View>
          </Pressable>
        </View>

        {assets === null && !error ? (
          <ActivityIndicator color="#fff" style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            key={cols}
            data={assets ?? []}
            numColumns={cols}
            keyExtractor={a => a.cacheKey}
            columnWrapperStyle={{ gap: GAP }}
            contentContainerStyle={{ gap: GAP, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16) }}
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              <Text style={styles.empty}>{error ? `Couldn't load models: ${error}` : 'No models match.'}</Text>
            }
            renderItem={({ item }) => {
              const owned = inStrip.has(item.cacheKey);
              const on = picked.has(item.cacheKey);
              return (
                <Pressable
                  onPress={() => toggle(item)}
                  accessibilityRole="button"
                  accessibilityLabel={item.title || item.prompt}
                  accessibilityState={{ selected: on, disabled: owned }}
                  style={[styles.cell, { width: tile, height: tile }, on && styles.cellOn]}
                >
                  {item.thumbnailUrl
                    ? <Image source={{ uri: item.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="contain" />
                    : <Text style={styles.cellText} numberOfLines={3}>{item.title || item.prompt}</Text>}
                  {(on || owned) && (
                    <View style={[styles.check, owned && styles.checkOwned]}>
                      <SymbolView name="checkmark" size={11} weight="bold" tintColor="#fff" />
                    </View>
                  )}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0B0B0D' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  search: {
    flex: 1, height: 40, borderRadius: 20, flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingHorizontal: 14,
  },
  searchInput: { flex: 1, color: '#fff', fontSize: 16 },
  add: { height: 40, paddingHorizontal: 18, borderRadius: 20, backgroundColor: '#0A84FF', alignItems: 'center', justifyContent: 'center' },
  addOff: { backgroundColor: 'rgba(10,132,255,0.35)' },
  addText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cell: {
    borderRadius: 14, backgroundColor: '#1C1C1E', overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent',
  },
  cellOn: { borderColor: '#0A84FF' },
  cellText: { color: '#fff', fontSize: 12, padding: 8, textAlign: 'center' },
  check: {
    position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#0A84FF', alignItems: 'center', justifyContent: 'center',
  },
  checkOwned: { backgroundColor: '#3A3A3C' },
  empty: { color: '#8E8E93', textAlign: 'center', marginTop: 40 },
});
