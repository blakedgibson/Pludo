import React, { useEffect, useState } from 'react';
import { Pressable, Text as RNText, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { AssetLibrary } from './AssetLibrary';
import { AssetStrip, type StripAsset } from './AssetStrip';
import { InterfaceBuilder, type IfaceState } from './InterfaceBuilder';
import { LogicEditor, logicPageTitle, useLogicPages, type LogicCatalog, type LogicGraph } from './LogicEditor';
import {
  Button, Form, Host, HStack, Image, Label, LabeledContent, Menu, Section, Spacer, Stepper, Text,
  TextField, Toggle, useNativeState,
} from '@expo/ui/swift-ui';
import {
  buttonBorderShape, buttonStyle, controlSize, disabled, foregroundStyle, keyboardType, labelStyle,
  layoutPriority, lineLimit,
  multilineTextAlignment, scrollContentBackground,
} from '@expo/ui/swift-ui/modifiers';

/** Per-object behaviors — mirrors ObjectSettings in ReactUnity's CreateScreen. */
export interface ObjectSettings {
  destroyable: boolean; healthRegen: boolean; infiniteLives: boolean; explode: boolean;
  healthPoints: string; extraLives: string;
  invisible: boolean;
  physics: boolean; weight: string;
  move: boolean;
  horizontal: boolean; horizontalSpeed: string; horizontalDistance: string;
  vertical: boolean; verticalSpeed: string; verticalDistance: string;
}

export interface SceneStyle { sky: string; lighting: string; ground: string; speed: number; jump: number }

/** Editor state reported by ReactUnity's EditorScreen (see notifyHost there). */
export interface EditorState {
  active: boolean;
  atRest?: boolean;
  /** rest = nothing contextual open; selected = object selected (native bar);
   *  other = terrain / Custom Logic / Interface Builder (drawn by Unity). */
  mode?: 'rest' | 'selected' | 'terrain' | 'interface' | 'other';
  canUndo?: boolean;
  canRedo?: boolean;
  playLabel?: string;
  playEnabled?: boolean;
  published?: boolean;
  picking?: boolean;
  objectId?: string;
  settingsOpen?: boolean;
  settings?: ObjectSettings;
  scene?: SceneStyle;
  /** A ReactUnity dialog/sheet (Publish, Play-loading, AI chat) is up. */
  overlay?: boolean;
  /** This game's asset strip (phase 3) and whether it belongs on screen. */
  assets?: StripAsset[];
  stripVisible?: boolean;
  /** Phase 4: Custom Logic panel + terrain toolbar. */
  logicOpen?: boolean;
  logic?: LogicGraph | null;
  terrainTool?: string;
  /** Phase 5: Interface Builder elements + tap workflows (while it's open). */
  iface?: IfaceState | null;
}

/** Plain command name, or "name:arg" (see hostCommandRef in CreateScreen). */
export type EditorCommand = string;

const PANEL_W = 280;
const LOGIC_W = 320;
const TERRAIN_TOOLS = [
  { key: 'raise', label: 'Raise', icon: 'arrow.up' },
  { key: 'lower', label: 'Lower', icon: 'arrow.down' },
  { key: 'flatten', label: 'Flatten', icon: 'minus' },
  { key: 'smooth', label: 'Smooth', icon: 'water.waves' },
];
const GAP = 12;

const SKY = [
  { key: '', label: 'Default' }, { key: 'midday', label: 'Day' }, { key: 'golden_hour', label: 'Sunset' },
  { key: 'night', label: 'Night' }, { key: 'overcast', label: 'Cloudy' },
];
const LIGHT = [
  { key: 'day', label: 'Bright' }, { key: 'overcast', label: 'Soft' },
  { key: 'golden_hour', label: 'Golden' }, { key: 'night', label: 'Dim' },
];
const GROUND = [
  { key: '', label: 'Grass' }, { key: 'gray', label: 'Gray' }, { key: 'dirt', label: 'Dirt' },
  { key: 'sand', label: 'Sand' }, { key: 'stone', label: 'Stone' }, { key: 'snow', label: 'Snow' },
];

const circleGlass = [buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large')];

// Native Liquid Glass editor chrome drawn over Unity's editor viewport.
//   Phase 1: ☰ menu (Play / Tools / Publish / Leave) + undo/redo.
//   Phase 2: Tools drill-downs as nested menus (style presets) + a Player
//            panel, and the object-selection bar with its Edit side panel.
//   Phase 3: asset strip + model library.
//   Phase 4: Custom Logic (workflow editor) panel + terrain toolbar.
// The Interface Builder is still ReactUnity: while it is open (mode 'other')
// only undo/redo stay. The container is box-none, so taps anywhere else fall
// through to Unity's 3D viewport (terrain brushing included).
export function EditorChrome({ state, onCommand, catalog }: {
  state: EditorState; onCommand: (cmd: EditorCommand) => void; catalog: LogicCatalog | null;
}) {
  const insets = useSafeAreaInsets();
  const [playerOpen, setPlayerOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const mode = state.mode ?? (state.atRest ? 'rest' : 'other');
  const showPlayer = playerOpen && mode === 'rest';

  // The Player panel belongs to the resting chrome; leaving rest closes it
  // (adjusted during render rather than in an effect).
  // Which behavior page the Edit panel shows (null = the index); back to the
  // index whenever the selection changes or the panel closes.
  const [fnPage, setFnPage] = useState<Fn | null>(null);
  const logicPages = useLogicPages();
  const panelKey = `${state.objectId ?? ''}|${state.settingsOpen ? 1 : 0}|${state.logicOpen ? 1 : 0}`;
  const [lastPanelKey, setLastPanelKey] = useState(panelKey);
  if (panelKey !== lastPanelKey) {
    setLastPanelKey(panelKey);
    setFnPage(null);
    if (logicPages.depth > 1) logicPages.reset();
  }
  // The logic catalog (event/step definitions) comes from ReactUnity once.
  const needCatalog = !!state.logicOpen && !catalog;
  useEffect(() => { if (needCatalog) onCommand('logicCatalog'); }, [needCatalog, onCommand]);
  const [lastMode, setLastMode] = useState(mode);
  if (mode !== lastMode) {
    setLastMode(mode);
    if (mode !== 'rest') setPlayerOpen(false);
  }

  if (!state.active || state.picking) return null;

  // Phase 5: the Interface Builder takes the whole screen.
  if (mode === 'interface' && state.iface) {
    return (
      <InterfaceBuilder
        iface={state.iface}
        onChange={next => onCommand(`iface:${JSON.stringify(next)}`)}
        onClose={() => onCommand('ifaceClose')}
      />
    );
  }

  const top = Math.max(insets.top, 8);
  const panelLeft = insets.left;
  const logicOpen = mode === 'selected' && !!state.logicOpen;
  const panelOpen = showPlayer || logicOpen || (mode === 'selected' && !!state.settingsOpen);
  const panelW = logicOpen ? LOGIC_W : PANEL_W;
  const barLeft = panelOpen ? panelLeft + panelW + GAP : Math.max(insets.left, 12);
  const graph: LogicGraph = state.logic ?? { workflows: [], variables: [] };
  const scene = state.scene ?? { sky: '', lighting: '', ground: '', speed: 5, jump: 2 };
  const presetMenu = (label: string, icon: string, cmd: string, list: { key: string; label: string }[], active: string) => (
    <Menu label={label} systemImage={icon as any}>
      {list.map(p => (
        <Button
          key={p.key || 'default'}
          label={p.label}
          systemImage={active === p.key ? 'checkmark' : undefined}
          onPress={() => onCommand(`${cmd}:${p.key}`)}
        />
      ))}
    </Menu>
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* ── Side panel (Player, or the selected object's Edit panel) ── */}
      {panelOpen && (
        <SidePanel
          left={panelLeft}
          top={top}
          bottom={Math.max(insets.bottom, 8)}
          width={panelW}
          title={showPlayer ? 'Player'
            : logicOpen ? logicPageTitle(logicPages.page, graph, catalog)
            : fnPage ? FN_META.find(m => m.key === fnPage)!.label : 'Edit'}
          onBack={showPlayer ? undefined
            : logicOpen ? (logicPages.depth > 1 ? logicPages.pop : undefined)
            : fnPage ? () => setFnPage(null) : undefined}
          onClose={() => (showPlayer ? setPlayerOpen(false) : onCommand('closePanel'))}
        >
          {showPlayer
            ? <PlayerForm scene={scene} onCommand={onCommand} />
            : logicOpen
              ? <LogicEditor
                  graph={graph}
                  catalog={catalog}
                  page={logicPages.page}
                  push={logicPages.push}
                  pop={logicPages.pop}
                  onChange={g => onCommand(`logic:${JSON.stringify(g)}`)}
                  onPick={id => onCommand(`pickVar:${id}`)}
                />
              : <ObjectSettingsForm key={state.objectId} page={fnPage} onOpen={setFnPage}
                  settings={state.settings} onCommand={onCommand} />}
        </SidePanel>
      )}

      {mode === 'rest' && (
        <View style={[styles.corner, { top, left: barLeft }]}>
          <Host matchContents>
            <Menu label="Editor menu" systemImage="line.3.horizontal" modifiers={circleGlass}>
              <Button
                label={state.playLabel ?? 'Play'}
                systemImage={state.playEnabled === false ? 'hourglass' : 'play.fill'}
                onPress={() => onCommand('play')}
              />
              <Menu label="Tools" systemImage="wrench.and.screwdriver">
                <Button label="Terrain" systemImage="mountain.2" onPress={() => onCommand('terrain')} />
                <Menu label="Style" systemImage="paintpalette">
                  {presetMenu('Sky', 'cloud.sun', 'sky', SKY, scene.sky)}
                  {presetMenu('Lighting', 'sun.max', 'lighting', LIGHT, scene.lighting)}
                  {presetMenu('Textures', 'square.grid.3x3', 'ground', GROUND, scene.ground)}
                </Menu>
                <Button label="Interface" systemImage="rectangle.3.group" onPress={() => onCommand('interface')} />
                <Button label="Player" systemImage="figure.run" onPress={() => setPlayerOpen(true)} />
              </Menu>
              <Button
                label={state.published ? 'Published' : 'Publish'}
                systemImage={state.published ? 'checkmark.circle.fill' : 'paperplane'}
                onPress={() => onCommand('publish')}
              />
              <Button label="Leave" systemImage="arrow.backward" onPress={() => onCommand('leave')} />
            </Menu>
          </Host>
        </View>
      )}

      {mode === 'selected' && (
        <View style={[styles.corner, { top, left: barLeft }]}>
          <Host matchContents>
            <HStack spacing={8}>
              <Button label="Deselect" systemImage="xmark" onPress={() => onCommand('deselect')} modifiers={circleGlass} />
              <Button
                label="Edit"
                systemImage="gearshape"
                onPress={() => onCommand('edit')}
                modifiers={[
                  buttonStyle(state.settingsOpen ? 'glassProminent' : 'glass'), controlSize('large'),
                  // Icon-only beside an open panel so the bar clears undo/redo.
                  ...(panelOpen ? [buttonBorderShape('circle'), labelStyle('iconOnly')] : []),
                ]}
              />
              <Button
                label="Workflow"
                systemImage="chevron.left.forwardslash.chevron.right"
                onPress={() => onCommand('workflow')}
                modifiers={[
                  buttonStyle(state.logicOpen ? 'glassProminent' : 'glass'), controlSize('large'),
                  ...(panelOpen ? [buttonBorderShape('circle'), labelStyle('iconOnly')] : []),
                ]}
              />
            </HStack>
          </Host>
        </View>
      )}

      {/* ── Terrain toolbar: Done + brush tools (drag on the ground to sculpt) ── */}
      {mode === 'terrain' && (
        <View style={[styles.corner, { top, left: Math.max(insets.left, 12) }]}>
          <Host matchContents>
            <HStack spacing={8}>
              <Button label="Done" systemImage="checkmark" onPress={() => onCommand('terrainExit')} modifiers={circleGlass} />
              {TERRAIN_TOOLS.map(t => {
                const on = state.terrainTool === t.key;
                return (
                  <Button
                    key={t.key}
                    label={t.label}
                    systemImage={t.icon as any}
                    onPress={() => onCommand(`terrainTool:${on ? '' : t.key}`)}
                    modifiers={[buttonStyle(on ? 'glassProminent' : 'glass'), controlSize('large')]}
                  />
                );
              })}
            </HStack>
          </Host>
        </View>
      )}

      {/* ── Asset strip + library (phase 3) ── */}
      {state.stripVisible !== false && mode !== 'other' && mode !== 'terrain' && (
        <AssetStrip
          assets={state.assets ?? []}
          left={panelOpen ? panelLeft + panelW + GAP : Math.max(insets.left, 12)}
          right={Math.max(insets.right, 12) + 56 + GAP}
          plusRight={Math.max(insets.right, 12)}
          bottom={Math.max(insets.bottom, 8)}
          onCommand={onCommand}
          onOpenLibrary={() => setLibraryOpen(true)}
        />
      )}
      <AssetLibrary
        visible={libraryOpen}
        inStrip={new Set((state.assets ?? []).map(a => a.cacheKey))}
        onClose={() => setLibraryOpen(false)}
        onAdd={picked => { if (picked.length) onCommand(`addAssets:${JSON.stringify(picked)}`); }}
      />

      {/* SwiftUI glass buttons: their glyphs adapt to what's behind them
          (dark over a bright sky, light over a dark one), like the ☰ menu. */}
      <View style={[styles.corner, { top, right: Math.max(insets.right, 12) }]}>
        <Host matchContents>
          <HStack spacing={10}>
            <Button label="Undo" systemImage="arrow.uturn.backward" onPress={() => onCommand('undo')}
              modifiers={[...circleGlass, disabled(!state.canUndo)]} />
            <Button label="Redo" systemImage="arrow.uturn.forward" onPress={() => onCommand('redo')}
              modifiers={[...circleGlass, disabled(!state.canRedo)]} />
          </HStack>
        </Host>
      </View>
    </View>
  );
}

// Glass column docked to the left safe-area edge (same slot ReactUnity's
// ObjectSettingsPanel used, so Unity's selection framing still clears it).
// Header (back / title / close) is RN; the body is a SwiftUI Form with its
// scroll background hidden so the Liquid Glass shows through. Page pushes are
// handled here rather than by NavigationStack, which paints an opaque backdrop.
function SidePanel({ left, top, bottom, width, title, onBack, onClose, children }: {
  left: number; top: number; bottom: number; width: number; title: string;
  onBack?: () => void; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <View style={[styles.panel, { left, top, bottom, width }]}>
      <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.55)" />
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={10} style={styles.headerBtn} accessibilityLabel="Back">
            <SymbolView name="chevron.left" size={15} weight="semibold" tintColor="#fff" />
          </Pressable>
        ) : <View style={styles.headerBtn} />}
        <RNText style={styles.title} numberOfLines={1}>{title}</RNText>
        <Pressable onPress={onClose} hitSlop={10} style={[styles.headerBtn, styles.close]} accessibilityLabel="Close panel">
          <SymbolView name="xmark" size={12} weight="bold" tintColor="#fff" />
        </Pressable>
      </View>
      <Host style={styles.body} colorScheme="dark">
        {children}
      </Host>
    </View>
  );
}

const FORM_MODS = [scrollContentBackground('hidden')];

function PlayerForm({ scene, onCommand }: { scene: SceneStyle; onCommand: (cmd: EditorCommand) => void }) {
  return (
    <Form modifiers={FORM_MODS}>
      <Section title="Movement" footer={<Text>How every player moves in this game.</Text>}>
        <Stepper
          label={`Walk speed  ${scene.speed.toFixed(0)}`}
          value={scene.speed} step={1} min={1} max={20}
          onValueChange={v => onCommand(`speed:${v}`)}
        />
        <Stepper
          label={`Jump height  ${scene.jump.toFixed(1)}`}
          value={scene.jump} step={0.5} min={0.5} max={8}
          onValueChange={v => onCommand(`jump:${v}`)}
        />
      </Section>
    </Form>
  );
}

type Fn = 'destroyable' | 'invisible' | 'physics' | 'move';
const FN_META: { key: Fn; label: string; icon: string; blurb: string }[] = [
  { key: 'destroyable', label: 'Destroyable', icon: 'heart.slash', blurb: 'Give the object health so players can damage and destroy it.' },
  { key: 'invisible',   label: 'Invisible',   icon: 'eye.slash',   blurb: 'Hide the object during play. It still exists and still collides — only its mesh is hidden.' },
  { key: 'physics',     label: 'Physics',     icon: 'scalemass',   blurb: 'Let gravity and collisions push the object around instead of pinning it in place.' },
  { key: 'move',        label: 'Move',        icon: 'arrow.up.and.down.and.arrow.left.and.right', blurb: 'Drive the object back and forth on its own, with no player input.' },
];

function summary(fn: Fn, s: ObjectSettings): string {
  switch (fn) {
    case 'destroyable': {
      if (!s.destroyable) return 'Off';
      const hp = s.healthPoints.trim() || '100';
      return s.infiniteLives ? `${hp} HP · ∞` : `${hp} HP`;
    }
    case 'invisible': return s.invisible ? 'On' : 'Off';
    case 'physics':   return s.physics ? `Weight ${s.weight.trim() || '1.0'}` : 'Off';
    case 'move':
      if (!s.move) return 'Off';
      if (s.horizontal && s.vertical) return 'Both axes';
      if (s.horizontal) return 'Horizontal';
      if (s.vertical) return 'Vertical';
      return 'On';
  }
}

const EMPTY_SETTINGS: ObjectSettings = {
  destroyable: false, healthRegen: false, infiniteLives: false, explode: false, healthPoints: '', extraLives: '',
  invisible: false, physics: false, weight: '', move: false,
  horizontal: false, horizontalSpeed: '', horizontalDistance: '',
  vertical: false, verticalSpeed: '', verticalDistance: '',
};

// Settings.app-style: an index of behaviors with their current state, each
// opening a detail page with its master switch and sub-fields. Every change is
// sent straight to ReactUnity (which owns the per-object state and mirrors it
// to Unity); the echo comes back in EditorState.settings.
function ObjectSettingsForm({ page, onOpen, settings, onCommand }: {
  page: Fn | null; onOpen: (fn: Fn) => void;
  settings?: ObjectSettings; onCommand: (cmd: EditorCommand) => void;
}) {
  const s = settings ?? EMPTY_SETTINGS;
  const set = (key: keyof ObjectSettings, value: boolean | string) =>
    onCommand(`setting:${JSON.stringify({ key, value })}`);
  const toggle = (label: string, key: keyof ObjectSettings) => (
    <Toggle label={label} isOn={!!s[key]} onIsOnChange={v => set(key, v)} />
  );
  const field = (label: string, key: keyof ObjectSettings, placeholder: string) => (
    <NumberField key={key} label={label} initial={String(s[key] ?? '')} placeholder={placeholder} onChange={v => set(key, v)} />
  );

  if (!page) {
    return (
      <Form modifiers={FORM_MODS}>
        <Section footer={<Text>Behaviors this object carries during play.</Text>}>
          {FN_META.map(m => (
            <Button key={m.key} onPress={() => onOpen(m.key)} modifiers={[buttonStyle('plain')]}>
              <HStack spacing={8}>
                <Label title={m.label} systemImage={m.icon as any} modifiers={[lineLimit(1), layoutPriority(1)]} />
                <Spacer />
                <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>{summary(m.key, s)}</Text>
                <Image systemName="chevron.right" size={12} color="gray" />
              </HStack>
            </Button>
          ))}
        </Section>
      </Form>
    );
  }

  const blurb = FN_META.find(m => m.key === page)!.blurb;
  return (
    <Form modifiers={FORM_MODS}>
      {page === 'destroyable' && <>
        <Section footer={<Text>{blurb}</Text>}>{toggle('Destroyable', 'destroyable')}</Section>
        {s.destroyable && (
          <Section>
            {field('Health Points', 'healthPoints', '100')}
            {toggle('Health Regeneration', 'healthRegen')}
            {field('Extra Lives', 'extraLives', '0')}
            {toggle('Infinite Lives', 'infiniteLives')}
            {toggle('Explode', 'explode')}
          </Section>
        )}
      </>}
      {page === 'invisible' && (
        <Section footer={<Text>{blurb}</Text>}>{toggle('Invisible', 'invisible')}</Section>
      )}
      {page === 'physics' && <>
        <Section footer={<Text>{blurb}</Text>}>{toggle('Physics', 'physics')}</Section>
        {s.physics && <Section>{field('Weight', 'weight', '1.0')}</Section>}
      </>}
      {page === 'move' && <>
        <Section footer={<Text>{blurb}</Text>}>{toggle('Move', 'move')}</Section>
        {s.move && (
          <Section title="Horizontal">
            {toggle('Horizontally', 'horizontal')}
            {s.horizontal && field('Movement Speed', 'horizontalSpeed', '2.0')}
            {s.horizontal && field('Distance', 'horizontalDistance', '5.0')}
          </Section>
        )}
        {s.move && (
          <Section title="Vertical">
            {toggle('Vertically', 'vertical')}
            {s.vertical && field('Movement Speed', 'verticalSpeed', '2.0')}
            {s.vertical && field('Distance', 'verticalDistance', '3.0')}
          </Section>
        )}
      </>}
    </Form>
  );
}

// Uncontrolled native text field (its text lives in SwiftUI state), seeded once
// from the object's saved value; every edit is forwarded.
function NumberField({ label, initial, placeholder, onChange }: {
  label: string; initial: string; placeholder: string; onChange: (v: string) => void;
}) {
  const text = useNativeState(initial);
  return (
    <LabeledContent label={label}>
      <TextField
        text={text}
        placeholder={placeholder}
        onTextChange={onChange}
        modifiers={[keyboardType('decimal-pad'), multilineTextAlignment('trailing')]}
      />
    </LabeledContent>
  );
}

const styles = StyleSheet.create({
  corner: { position: 'absolute' },
  panel: {
    position: 'absolute',
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingTop: 10, paddingBottom: 4,
  },
  headerBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  close: { borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.14)' },
  title: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '600' },
  body: { flex: 1 },
});
