import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text as RNText, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import {
  Button, Form, Host, Menu, Picker, Section, Stepper, Text, TextField, Toggle, useNativeState,
} from '@expo/ui/swift-ui';
import {
  buttonBorderShape, buttonStyle, controlSize, disabled, labelStyle, pickerStyle, scrollContentBackground, tag,
} from '@expo/ui/swift-ui/modifiers';

// Native Liquid Glass chrome for Unity's Model Studio (ModelStudio.cs): build a
// 3D model from parts by hand — no AI — then name it and publish it to the
// game asset library and/or the avatar marketplace.

export interface StudioSelected {
  id: number; shape: string; color: string; material: string;
  px: number; py: number; pz: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number;
}
export interface StudioState {
  open: boolean; parts?: number; selected?: StudioSelected | null;
  tool?: 'move' | 'rotate' | 'scale'; snap?: boolean; canUndo?: boolean; canRedo?: boolean; publishing?: boolean;
}
export interface StudioPublished { ok: boolean; error?: string; name?: string; destination?: string }

const SHAPES = [
  { key: 'block', label: 'Block', icon: 'cube.fill' },
  { key: 'sphere', label: 'Sphere', icon: 'circle.fill' },
  { key: 'cylinder', label: 'Cylinder', icon: 'cylinder.fill' },
  { key: 'cone', label: 'Cone', icon: 'cone.fill' },
  { key: 'wedge', label: 'Wedge', icon: 'triangle.fill' },
  { key: 'torus', label: 'Ring', icon: 'circle.circle' },
  { key: 'pill', label: 'Pill', icon: 'capsule.fill' },
] as const;

const COLORS = [
  { name: 'Blue', value: '#4C9AFF' }, { name: 'Red', value: '#FF453A' }, { name: 'Orange', value: '#FF9F0A' },
  { name: 'Yellow', value: '#FFD60A' }, { name: 'Green', value: '#30D158' }, { name: 'Teal', value: '#40C8E0' },
  { name: 'Purple', value: '#BF5AF2' }, { name: 'Pink', value: '#FF6FB1' }, { name: 'Brown', value: '#A2845E' },
  { name: 'White', value: '#F2F2F7' }, { name: 'Gray', value: '#8E8E93' }, { name: 'Black', value: '#1C1C1E' },
];
const MATERIALS = [
  { key: 'plastic', label: 'Plastic' }, { key: 'matte', label: 'Matte' }, { key: 'metal', label: 'Metal' },
  { key: 'neon', label: 'Neon' }, { key: 'glass', label: 'Glass' },
];
const CATEGORIES = ['head', 'hair', 'face', 'neck', 'top', 'bottom', 'shoes', 'back', 'front', 'waist', 'accessory'];

const circleGlass = [buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large')];

export function ModelStudioChrome({ state, published, onCommand, onClose, onPublish, onDismissPublished }: {
  state: StudioState;
  published: StudioPublished | null;
  onCommand: (cmd: string) => void;
  onClose: () => void;
  onPublish: (req: { name: string; destination: 'asset' | 'avatar' | 'both'; category: string }) => void;
  onDismissPublished: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: W } = useWindowDimensions();
  const [inspector, setInspector] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const sel = state.selected ?? null;
  const top = Math.max(insets.top, 10);
  const bottom = Math.max(insets.bottom, 10);
  const wide = W >= 700;   // iPad / landscape: inspector docks as a side panel

  // A finished publish closes the form; the result banner takes over.
  const sheetVisible = publishOpen && !published?.ok;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { top, left: Math.max(insets.left, 12), right: Math.max(insets.right, 12) }]} pointerEvents="box-none">
        <Host matchContents>
          <Button label="Close" systemImage="xmark" onPress={onClose} modifiers={circleGlass} />
        </Host>
        <GlassView style={styles.titlePill} glassEffectStyle="regular">
          <RNText style={styles.title}>Model Studio</RNText>
          <RNText style={styles.subtitle}>{state.parts ?? 0} {state.parts === 1 ? 'part' : 'parts'}</RNText>
        </GlassView>
        <View style={{ flex: 1 }} pointerEvents="none" />
        <Host matchContents>
          <Button label="Undo" systemImage="arrow.uturn.backward" onPress={() => onCommand('undo')} modifiers={[...circleGlass, disabled(!state.canUndo)]} />
        </Host>
        <Host matchContents>
          <Button label="Redo" systemImage="arrow.uturn.forward" onPress={() => onCommand('redo')} modifiers={[...circleGlass, disabled(!state.canRedo)]} />
        </Host>
        <Host matchContents>
          <Menu label="More" systemImage="ellipsis" modifiers={circleGlass}>
            <Toggle label="Snap to grid" systemImage="squareshape.split.3x3" isOn={!!state.snap} onIsOnChange={on => onCommand(`snap:${on ? 1 : 0}`)} />
            <Button label="Frame model" systemImage="viewfinder" onPress={() => onCommand('frame')} />
            <Button label="Clear all parts" systemImage="trash" role="destructive" onPress={() => onCommand('clear')} />
          </Menu>
        </Host>
        <Host matchContents>
          <Button label="Publish" systemImage="arrow.up.circle.fill" onPress={() => { onDismissPublished(); setPublishOpen(true); }}
            modifiers={[buttonStyle('glassProminent'), controlSize('large'), disabled(!state.parts || !!state.publishing)]} />
        </Host>
      </View>

      {/* ── Selected-part tools ── */}
      {sel && (
        <View style={[styles.selBar, { bottom: bottom + 86, left: Math.max(insets.left, 12), right: Math.max(insets.right, 12) }]} pointerEvents="box-none">
          <GlassView style={styles.selGlass} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.35)">
            <Host matchContents>
              <Picker selection={state.tool ?? 'move'} onSelectionChange={(t: string) => onCommand(`tool:${t}`)} modifiers={[pickerStyle('segmented')]}>
                <Text modifiers={[tag('move')]}>Move</Text>
                <Text modifiers={[tag('rotate')]}>Rotate</Text>
                <Text modifiers={[tag('scale')]}>Scale</Text>
              </Picker>
            </Host>
            <Swatch color={sel.color} />
            <Host matchContents>
              <Menu label="Color" systemImage="paintpalette.fill" modifiers={[buttonStyle('glass'), labelStyle('iconOnly')]}>
                {COLORS.map(c => (
                  <Button key={c.value} label={c.name} systemImage={sel.color.toUpperCase() === c.value ? 'checkmark' : 'circle.fill'}
                    onPress={() => onCommand(`color:${c.value}`)} />
                ))}
              </Menu>
            </Host>
            <Host matchContents>
              <Menu label={MATERIALS.find(m => m.key === sel.material)?.label ?? 'Material'} systemImage="sparkles" modifiers={[buttonStyle('glass')]}>
                {MATERIALS.map(m => (
                  <Button key={m.key} label={m.label} systemImage={sel.material === m.key ? 'checkmark' : undefined}
                    onPress={() => onCommand(`material:${m.key}`)} />
                ))}
              </Menu>
            </Host>
            <Host matchContents>
              <Button label="Exact size & position" systemImage="slider.horizontal.3" onPress={() => setInspector(v => !v)}
                modifiers={[buttonStyle(inspector ? 'glassProminent' : 'glass'), labelStyle('iconOnly')]} />
            </Host>
            <Host matchContents>
              <Button label="Duplicate" systemImage="plus.square.on.square" onPress={() => onCommand('duplicate')} modifiers={[buttonStyle('glass'), labelStyle('iconOnly')]} />
            </Host>
            <Host matchContents>
              <Button label="Delete" systemImage="trash" role="destructive" onPress={() => onCommand('delete')} modifiers={[buttonStyle('glass'), labelStyle('iconOnly')]} />
            </Host>
          </GlassView>
        </View>
      )}

      {/* ── Inspector: exact transform ── */}
      {sel && inspector && (
        <GlassView
          style={[styles.inspector, wide
            ? { top: top + 60, right: Math.max(insets.right, 12), width: 300, bottom: bottom + 150 }
            : { left: 12, right: 12, bottom: bottom + 150, height: 300 }]}
          glassEffectStyle="regular" tintColor="rgba(20,20,22,0.55)"
        >
          <Host style={{ flex: 1 }} colorScheme="dark">
            <Form modifiers={[scrollContentBackground('hidden')]}>
              <Section title="Position">
                <Axis label="X" value={sel.px} step={0.25} onChange={v => onCommand(`set:${JSON.stringify({ px: v })}`)} />
                <Axis label="Y" value={sel.py} step={0.25} onChange={v => onCommand(`set:${JSON.stringify({ py: v })}`)} />
                <Axis label="Z" value={sel.pz} step={0.25} onChange={v => onCommand(`set:${JSON.stringify({ pz: v })}`)} />
              </Section>
              <Section title="Rotation">
                <Axis label="X" value={sel.rx} step={15} unit="°" onChange={v => onCommand(`set:${JSON.stringify({ rx: v })}`)} />
                <Axis label="Y" value={sel.ry} step={15} unit="°" onChange={v => onCommand(`set:${JSON.stringify({ ry: v })}`)} />
                <Axis label="Z" value={sel.rz} step={15} unit="°" onChange={v => onCommand(`set:${JSON.stringify({ rz: v })}`)} />
              </Section>
              <Section title="Size">
                <Axis label="Width" value={sel.sx} step={0.25} min={0.05} onChange={v => onCommand(`set:${JSON.stringify({ sx: v })}`)} />
                <Axis label="Height" value={sel.sy} step={0.25} min={0.05} onChange={v => onCommand(`set:${JSON.stringify({ sy: v })}`)} />
                <Axis label="Depth" value={sel.sz} step={0.25} min={0.05} onChange={v => onCommand(`set:${JSON.stringify({ sz: v })}`)} />
              </Section>
            </Form>
          </Host>
        </GlassView>
      )}

      {/* ── Shape palette ── */}
      <View style={[styles.paletteWrap, { bottom }]} pointerEvents="box-none">
        <GlassView style={styles.palette} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.3)">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.paletteRow}>
            {SHAPES.map(s => (
              <Pressable key={s.key} onPress={() => onCommand(`add:${s.key}`)} style={styles.shapeBtn}
                accessibilityRole="button" accessibilityLabel={`Add ${s.label}`}>
                <SymbolView name={s.icon as any} size={24} tintColor="#fff" />
                <RNText style={styles.shapeLabel}>{s.label}</RNText>
              </Pressable>
            ))}
          </ScrollView>
        </GlassView>
      </View>

      {!state.parts && (
        <View style={styles.hint} pointerEvents="none">
          <GlassView style={styles.hintGlass} glassEffectStyle="regular">
            <RNText style={styles.hintText}>Tap a shape below to start building.{'\n'}Drag to orbit · pinch to zoom · two fingers to pan.</RNText>
          </GlassView>
        </View>
      )}

      {state.publishing && (
        <View style={styles.hint} pointerEvents="none">
          <GlassView style={[styles.hintGlass, { flexDirection: 'row', gap: 10 }]} glassEffectStyle="regular">
            <ActivityIndicator color="#fff" />
            <RNText style={styles.hintText}>Publishing…</RNText>
          </GlassView>
        </View>
      )}

      {published && (
        <View style={[styles.banner, { top: top + 64 }]}>
          <GlassView style={styles.bannerGlass} glassEffectStyle="regular" tintColor={published.ok ? 'rgba(48,209,88,0.25)' : 'rgba(255,69,58,0.25)'}>
            <SymbolView name={published.ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'} size={20} tintColor="#fff" />
            <RNText style={styles.bannerText}>
              {published.ok
                ? `“${published.name}” published to ${published.destination === 'both' ? 'your assets and the avatar shop' : published.destination === 'avatar' ? 'the avatar shop' : 'your game assets'}.`
                : published.error ?? 'Publish failed.'}
            </RNText>
            <Pressable onPress={onDismissPublished} hitSlop={10} accessibilityLabel="Dismiss">
              <SymbolView name="xmark" size={13} weight="bold" tintColor="#fff" />
            </Pressable>
          </GlassView>
        </View>
      )}

      <PublishSheet
        visible={sheetVisible}
        busy={!!state.publishing}
        error={published && !published.ok ? published.error : undefined}
        onCancel={() => setPublishOpen(false)}
        onPublish={onPublish}
      />
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

function Axis({ label, value, step, min, unit = '', onChange }: {
  label: string; value: number; step: number; min?: number; unit?: string; onChange: (v: number) => void;
}) {
  const shown = Math.round(value * 100) / 100;
  return (
    <Stepper label={`${label}  ${shown}${unit}`} value={value} step={step} min={min ?? -1000} max={1000}
      onValueChange={v => onChange(Math.round(v * 100) / 100)} />
  );
}

function PublishSheet({ visible, busy, error, onCancel, onPublish }: {
  visible: boolean; busy: boolean; error?: string;
  onCancel: () => void;
  onPublish: (req: { name: string; destination: 'asset' | 'avatar' | 'both'; category: string }) => void;
}) {
  const nameState = useNativeState('');
  const [name, setName] = useState('');
  const [dest, setDest] = useState<'asset' | 'avatar' | 'both'>('asset');
  const [category, setCategory] = useState('accessory');
  const { width: W } = useWindowDimensions();

  return (
    <Modal visible={visible} transparent animationType="fade" supportedOrientations={['portrait', 'landscape']} onRequestClose={onCancel}>
      <View style={styles.sheetDim}>
        <GlassView style={[styles.sheet, { width: Math.min(W - 32, 420) }]} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.55)">
          <RNText style={styles.sheetTitle}>Publish your model</RNText>
          <Host style={{ height: dest === 'asset' ? 230 : 280 }} colorScheme="dark">
            <Form modifiers={[scrollContentBackground('hidden')]}>
              <Section>
                <TextField text={nameState} placeholder="Model name" onTextChange={setName} />
              </Section>
              <Section title="Upload to">
                <Picker selection={dest} onSelectionChange={(v: 'asset' | 'avatar' | 'both') => setDest(v)} modifiers={[pickerStyle('segmented')]}>
                  <Text modifiers={[tag('asset')]}>Game assets</Text>
                  <Text modifiers={[tag('avatar')]}>Avatar shop</Text>
                  <Text modifiers={[tag('both')]}>Both</Text>
                </Picker>
                {dest !== 'asset' && (
                  <Picker label="Wear on" selection={category} onSelectionChange={(v: string) => setCategory(v)} modifiers={[pickerStyle('menu')]}>
                    {CATEGORIES.map(c => <Text key={c} modifiers={[tag(c)]}>{c[0].toUpperCase() + c.slice(1)}</Text>)}
                  </Picker>
                )}
              </Section>
            </Form>
          </Host>
          {!!error && <RNText style={styles.sheetError}>{error}</RNText>}
          <View style={styles.sheetButtons}>
            <Host matchContents>
              <Button label="Cancel" onPress={onCancel} modifiers={[buttonStyle('glass'), controlSize('large')]} />
            </Host>
            <Host matchContents>
              <Button label={busy ? 'Publishing…' : 'Publish'}
                onPress={() => onPublish({ name: name.trim(), destination: dest, category })}
                modifiers={[buttonStyle('glassProminent'), controlSize('large'), disabled(busy || !name.trim())]} />
            </Host>
          </View>
        </GlassView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  topBar: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 8 },
  titlePill: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
  title: { color: '#fff', fontSize: 15, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
  selBar: { position: 'absolute', alignItems: 'center' },
  selGlass: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 26, paddingHorizontal: 10, paddingVertical: 8, flexWrap: 'wrap', justifyContent: 'center' },
  swatch: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)' },
  inspector: { position: 'absolute', borderRadius: 24, overflow: 'hidden' },
  paletteWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  palette: { borderRadius: 28, maxWidth: '94%' },
  paletteRow: { paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
  shapeBtn: { width: 64, height: 60, alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 18 },
  shapeLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
  hint: { position: 'absolute', top: '42%', left: 0, right: 0, alignItems: 'center' },
  hintGlass: { borderRadius: 18, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center' },
  hintText: { color: '#fff', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  banner: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bannerGlass: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, maxWidth: 520 },
  bannerText: { color: '#fff', fontSize: 14, flexShrink: 1 },
  sheetDim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  sheet: { borderRadius: 30, padding: 18, gap: 8 },
  sheetTitle: { color: '#fff', fontSize: 19, fontWeight: '700', paddingHorizontal: 4 },
  sheetError: { color: '#FF8A80', fontSize: 13, paddingHorizontal: 4 },
  sheetButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, paddingTop: 4 },
});
