import React, { useEffect, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text as RNText, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import {
  Button, Form, Host, HStack, Image, Menu, Picker, Section, Spacer, Stepper, Text, TextField, Toggle,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  buttonBorderShape, buttonStyle, controlSize, foregroundStyle, labelStyle, lineLimit, pickerStyle,
  scrollContentBackground, tag,
} from '@expo/ui/swift-ui/modifiers';

// ── Wire format (mirrors react/src/interfaceModel.ts) ───────────────────────
type Kind = 'button' | 'text' | 'image' | 'panel';
export interface IfaceElement {
  id: string; kind: Kind; x: number; y: number; w?: number; h?: number; zIndex?: number;
  visible: boolean; label?: string; body?: string; icon?: string;
  bgColor?: string; textColor?: string; cornerRadius?: number;
}
type ActionType = 'openPanel' | 'closePanel' | 'togglePanel' | 'showToast' | 'fireCustomEvent' | 'playSound' | 'wait';
interface IfaceStep { id: string; type: ActionType; params: Record<string, any>; enabled: boolean }
interface IfaceWorkflow { id: string; elementId: string; enabled: boolean; steps: IfaceStep[] }
export interface IfaceState { elements: IfaceElement[]; workflows: IfaceWorkflow[] }

const ACTIONS: { type: ActionType; label: string; icon: string }[] = [
  { type: 'openPanel', label: 'Open Panel', icon: 'rectangle.expand.vertical' },
  { type: 'closePanel', label: 'Close Panel', icon: 'rectangle.compress.vertical' },
  { type: 'togglePanel', label: 'Toggle Panel', icon: 'rectangle.on.rectangle' },
  { type: 'showToast', label: 'Show Message', icon: 'text.bubble' },
  { type: 'fireCustomEvent', label: 'Fire Game Event', icon: 'bolt' },
  { type: 'playSound', label: 'Play Sound', icon: 'speaker.wave.2' },
  { type: 'wait', label: 'Wait', icon: 'timer' },
];
const KINDS: { kind: Kind; label: string; icon: string }[] = [
  { kind: 'button', label: 'Button', icon: 'capsule' },
  { kind: 'text', label: 'Text', icon: 'textformat' },
  { kind: 'image', label: 'Image', icon: 'photo' },
  { kind: 'panel', label: 'Panel', icon: 'rectangle.inset.filled' },
];
const SWATCHES: { value: string; name: string }[] = [
  { value: 'rgba(0,0,0,0.60)', name: 'Dark' }, { value: 'rgba(255,255,255,0.14)', name: 'Frost' },
  { value: 'rgba(30,140,255,0.55)', name: 'Blue' }, { value: 'rgba(255,69,58,0.55)', name: 'Red' },
  { value: 'rgba(52,199,89,0.55)', name: 'Green' }, { value: 'rgba(255,214,10,0.55)', name: 'Yellow' },
  { value: 'rgba(191,90,242,0.55)', name: 'Purple' }, { value: 'rgba(18,18,24,0.96)', name: 'Night' },
];
const TEXT_COLORS = [
  { value: '#ffffff', name: 'White' }, { value: '#000000', name: 'Black' }, { value: '#FFD60A', name: 'Yellow' },
  { value: '#64D2FF', name: 'Cyan' }, { value: '#FF453A', name: 'Red' },
];
// The game renders Material Symbols; the builder previews them with SF Symbols.
const ICONS: { name: string; sf: string }[] = [
  { name: 'star', sf: 'star.fill' }, { name: 'favorite', sf: 'heart.fill' }, { name: 'home', sf: 'house.fill' },
  { name: 'settings', sf: 'gearshape.fill' }, { name: 'info', sf: 'info.circle.fill' }, { name: 'help', sf: 'questionmark.circle.fill' },
  { name: 'shopping_cart', sf: 'cart.fill' }, { name: 'leaderboard', sf: 'chart.bar.fill' }, { name: 'play_arrow', sf: 'play.fill' },
  { name: 'pause', sf: 'pause.fill' }, { name: 'bolt', sf: 'bolt.fill' }, { name: 'menu', sf: 'line.3.horizontal' },
  { name: 'close', sf: 'xmark' }, { name: 'image', sf: 'photo' }, { name: 'emoji_events', sf: 'trophy.fill' },
  { name: 'backpack', sf: 'backpack.fill' },
];
const sfFor = (icon?: string) => ICONS.find(i => i.name === icon)?.sf ?? 'circle.fill';
const isEmoji = (icon?: string) => !!icon && !/^[a-z0-9_]+$/.test(icon);

function uid(prefix: string) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function defaultElement(kind: Kind, x: number, y: number): IfaceElement {
  switch (kind) {
    case 'button': return { id: uid('el'), kind, x, y, visible: true, label: 'Button', icon: 'star', bgColor: 'rgba(0,0,0,0.60)', textColor: '#ffffff' };
    case 'text':   return { id: uid('el'), kind, x, y, visible: true, label: 'Text', textColor: '#ffffff' };
    case 'image':  return { id: uid('el'), kind, x, y, w: 18, h: 18, visible: true, icon: 'image', bgColor: 'rgba(255,255,255,0.10)' };
    case 'panel':  return { id: uid('el'), kind, x, y, w: 70, h: 34, visible: true, label: 'Panel', bgColor: 'rgba(18,18,24,0.96)', textColor: '#ffffff' };
  }
}
function blankStep(type: ActionType): IfaceStep {
  const params: Record<string, any> =
    type === 'openPanel' || type === 'closePanel' || type === 'togglePanel' ? { targetId: '' } :
    type === 'showToast' ? { text: '' } : type === 'fireCustomEvent' ? { eventName: '' } :
    type === 'playSound' ? { soundName: '' } : { ms: 500 };
  return { id: uid('step'), type, params, enabled: true };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const describe = (e: IfaceElement) => `${KINDS.find(k => k.kind === e.kind)?.label}${e.label ? ` · ${e.label}` : ''}`;

// Native Interface Builder (phase 5): full-screen Design canvas (drag to
// move, tap to select, glass inspector) + Logic tab (each button's tap
// actions). ReactUnity owns the elements/workflows and saves them into the
// game; every edit here sends the full updated set back.
export function InterfaceBuilder({ iface, onChange, onClose }: {
  iface: IfaceState; onChange: (next: IfaceState) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const [tab, setTab] = useState<'design' | 'logic'>('design');
  const [selected, setSelected] = useState<string | null>(null);
  const [logicEl, setLogicEl] = useState<string | null>(null);

  const els = iface.elements;
  const sel = els.find(e => e.id === selected) ?? null;
  const setEls = (elements: IfaceElement[]) => onChange({ ...iface, elements });
  const patchEl = (id: string, patch: Partial<IfaceElement>) => setEls(els.map(e => (e.id === id ? { ...e, ...patch } : e)));

  // Canvas = the game screen scaled into the space left of the inspector.
  const INSPECTOR_W = 300;
  const headerH = 56;
  const left = Math.max(insets.left, 16);
  const right = Math.max(insets.right, 16);
  const availW = W - left - right - (tab === 'design' && sel ? INSPECTOR_W + 12 : 0);
  const availH = H - headerH - Math.max(insets.top, 8) - Math.max(insets.bottom, 12);
  const scale = Math.min(availW / W, availH / H);
  const cw = W * scale, ch = H * scale;

  function addElement(kind: Kind) {
    const el = defaultElement(kind, 40, 40);
    setEls([...els, el]);
    setSelected(el.id);
  }

  return (
    <View style={styles.root}>
      {/* Header: tabs, add, done */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 8), paddingLeft: left, paddingRight: right }]}>
        <Host matchContents>
          <HStack spacing={10}>
            <Picker selection={tab} onSelectionChange={(t: 'design' | 'logic') => setTab(t)} modifiers={[pickerStyle('segmented')]}>
              <Text modifiers={[tag('design')]}>Design</Text>
              <Text modifiers={[tag('logic')]}>Logic</Text>
            </Picker>
            {tab === 'design' && (
              <Menu label="Add" systemImage="plus" modifiers={[buttonStyle('glass'), controlSize('large')]}>
                {KINDS.map(k => <Button key={k.kind} label={k.label} systemImage={k.icon as any} onPress={() => addElement(k.kind)} />)}
              </Menu>
            )}
          </HStack>
        </Host>
        <RNText style={styles.title}>Interface</RNText>
        <Host matchContents>
          <Button label="Done" systemImage="checkmark" onPress={onClose}
            modifiers={[buttonStyle('glassProminent'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large')]} />
        </Host>
      </View>

      {tab === 'design' ? (
        <View style={[styles.body, { paddingLeft: left, paddingRight: right }]}>
          {/* Canvas */}
          <Pressable onPress={() => setSelected(null)} style={[styles.canvas, { width: cw, height: ch }]}>
            {[...els].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)).map(e => (
              <CanvasElement
                key={e.id}
                el={e}
                scale={scale}
                cw={cw}
                ch={ch}
                selected={e.id === selected}
                onSelect={() => setSelected(e.id)}
                onMove={(x, y) => patchEl(e.id, { x, y })}
              />
            ))}
            {els.length === 0 && (
              <View style={styles.empty} pointerEvents="none">
                <RNText style={styles.emptyText}>Add buttons, text, images and panels for your game&apos;s screen.</RNText>
              </View>
            )}
          </Pressable>

          {/* Inspector */}
          {sel && (
            <GlassView style={[styles.inspector, { width: INSPECTOR_W, height: ch }]} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.55)">
              <Host style={StyleSheet.absoluteFill} colorScheme="dark">
                <Inspector
                  key={sel.id}
                  el={sel}
                  onPatch={p => patchEl(sel.id, p)}
                  onDelete={() => {
                    onChange({
                      elements: els.filter(e => e.id !== sel.id),
                      workflows: iface.workflows.filter(w => w.elementId !== sel.id),
                    });
                    setSelected(null);
                  }}
                  onLayer={d => patchEl(sel.id, { zIndex: (sel.zIndex ?? 0) + d })}
                  onEditLogic={() => { setLogicEl(sel.id); setTab('logic'); }}
                />
              </Host>
            </GlassView>
          )}
        </View>
      ) : (
        <View style={[styles.body, { paddingLeft: left, paddingRight: right }]}>
          <GlassView style={[styles.logic, { height: availH }]} glassEffectStyle="regular" tintColor="rgba(20,20,22,0.55)">
            <Host style={StyleSheet.absoluteFill} colorScheme="dark">
              <LogicTab iface={iface} onChange={onChange} elementId={logicEl} setElementId={setLogicEl} />
            </Host>
          </GlassView>
        </View>
      )}
    </View>
  );
}

// One draggable element on the canvas. Drag position is local until release
// (then sent once), so dragging stays smooth whatever the round-trip.
function CanvasElement({ el, scale, cw, ch, selected, onSelect, onMove }: {
  el: IfaceElement; scale: number; cw: number; ch: number; selected: boolean;
  onSelect: () => void; onMove: (x: number, y: number) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [box] = useState(() => ({ onSelect, onMove, el, cw, ch }));
  // PanResponder handlers are bound once; they read the newest props from `box`.
  useEffect(() => { Object.assign(box, { onSelect, onMove, el, cw, ch }); });
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { box.onSelect(); setDrag({ dx: 0, dy: 0 }); },
    onPanResponderMove: (_e, g) => setDrag({ dx: g.dx, dy: g.dy }),
    onPanResponderRelease: (_e, g) => {
      setDrag(null);
      if (Math.hypot(g.dx, g.dy) < 3) return;
      const x = clamp(Math.round((box.el.x + (g.dx / box.cw) * 100) * 10) / 10, 0, 98);
      const y = clamp(Math.round((box.el.y + (g.dy / box.ch) * 100) * 10) / 10, 0, 98);
      box.onMove(x, y);
    },
    onPanResponderTerminate: () => setDrag(null),
  }));

  const fs = Math.max(8, 15 * scale);
  const sized = el.kind === 'panel' || el.kind === 'image';
  return (
    <View
      {...responder.panHandlers}
      style={[
        styles.el,
        {
          left: (el.x / 100) * cw + (drag?.dx ?? 0),
          top: (el.y / 100) * ch + (drag?.dy ?? 0),
          width: sized ? ((el.w ?? 18) / 100) * cw : undefined,
          height: sized ? ((el.h ?? 18) / 100) * ch : undefined,
          backgroundColor: el.kind === 'text' ? 'transparent' : el.bgColor ?? 'rgba(0,0,0,0.6)',
          borderRadius: (el.cornerRadius ?? (el.kind === 'button' ? 999 : 12)) * scale,
          opacity: el.visible ? 1 : 0.45,
          zIndex: el.zIndex ?? 0,
          borderWidth: selected ? 2 : 0,
          borderColor: '#0A84FF',
          paddingHorizontal: el.kind === 'button' ? 14 * scale : 8 * scale,
          paddingVertical: el.kind === 'button' ? 8 * scale : 4 * scale,
        },
      ]}
    >
      {el.kind === 'panel' ? (
        <View>
          <RNText style={{ color: el.textColor ?? '#fff', fontSize: fs, fontWeight: '700' }} numberOfLines={1}>{el.label}</RNText>
          {el.body ? <RNText style={{ color: el.textColor ?? '#fff', fontSize: fs * 0.8, opacity: 0.8 }} numberOfLines={3}>{el.body}</RNText> : null}
        </View>
      ) : (
        <View style={styles.elRow}>
          {(el.kind === 'button' || el.kind === 'image') && el.icon ? (
            isEmoji(el.icon)
              ? <RNText style={{ fontSize: fs }}>{el.icon}</RNText>
              : <SymbolView name={sfFor(el.icon) as any} size={el.kind === 'image' ? fs * 1.8 : fs} tintColor={el.textColor ?? '#fff'} />
          ) : null}
          {el.kind !== 'image' && el.label ? (
            <RNText style={{ color: el.textColor ?? '#fff', fontSize: fs, fontWeight: el.kind === 'button' ? '700' : '500' }} numberOfLines={1}>{el.label}</RNText>
          ) : null}
        </View>
      )}
    </View>
  );
}

function Inspector({ el, onPatch, onDelete, onLayer, onEditLogic }: {
  el: IfaceElement; onPatch: (p: Partial<IfaceElement>) => void; onDelete: () => void;
  onLayer: (d: 1 | -1) => void; onEditLogic: () => void;
}) {
  const sized = el.kind === 'panel' || el.kind === 'image';
  return (
    <Form modifiers={[scrollContentBackground('hidden')]}>
      <Section title={KINDS.find(k => k.kind === el.kind)?.label}>
        {el.kind !== 'image' && <PlainField initial={el.label ?? ''} placeholder={el.kind === 'panel' ? 'Title' : 'Label'} onChange={t => onPatch({ label: t })} />}
        {el.kind === 'panel' && <PlainField initial={el.body ?? ''} placeholder="Body text" onChange={t => onPatch({ body: t })} />}
        {(el.kind === 'button' || el.kind === 'image') && (
          <Picker label="Icon" selection={el.icon ?? 'star'} onSelectionChange={(v: string) => onPatch({ icon: v })} modifiers={[pickerStyle('menu')]}>
            {ICONS.map(i => <Text key={i.name} modifiers={[tag(i.name)]}>{i.name.replace(/_/g, ' ')}</Text>)}
          </Picker>
        )}
      </Section>
      <Section title="Style">
        {el.kind !== 'text' && (
          <Picker label="Background" selection={el.bgColor ?? SWATCHES[0].value} onSelectionChange={(v: string) => onPatch({ bgColor: v })} modifiers={[pickerStyle('menu')]}>
            {SWATCHES.map(s => <Text key={s.value} modifiers={[tag(s.value)]}>{s.name}</Text>)}
          </Picker>
        )}
        {el.kind !== 'image' && (
          <Picker label="Text" selection={el.textColor ?? '#ffffff'} onSelectionChange={(v: string) => onPatch({ textColor: v })} modifiers={[pickerStyle('menu')]}>
            {TEXT_COLORS.map(s => <Text key={s.value} modifiers={[tag(s.value)]}>{s.name}</Text>)}
          </Picker>
        )}
        {el.kind !== 'text' && (
          <Stepper label={`Corners  ${el.cornerRadius ?? (el.kind === 'button' ? 99 : 12)}`} value={el.cornerRadius ?? 12}
            step={2} min={0} max={40} onValueChange={v => onPatch({ cornerRadius: v })} />
        )}
      </Section>
      <Section title="Layout">
        <Stepper label={`X  ${Math.round(el.x)}%`} value={el.x} step={1} min={0} max={98} onValueChange={v => onPatch({ x: v })} />
        <Stepper label={`Y  ${Math.round(el.y)}%`} value={el.y} step={1} min={0} max={98} onValueChange={v => onPatch({ y: v })} />
        {sized && <Stepper label={`Width  ${Math.round(el.w ?? 18)}%`} value={el.w ?? 18} step={2} min={4} max={100} onValueChange={v => onPatch({ w: v })} />}
        {sized && <Stepper label={`Height  ${Math.round(el.h ?? 18)}%`} value={el.h ?? 18} step={2} min={4} max={100} onValueChange={v => onPatch({ h: v })} />}
        <Toggle label={el.kind === 'panel' ? 'Open at start' : 'Visible'} isOn={el.visible} onIsOnChange={v => onPatch({ visible: v })} />
        <Button label="Bring Forward" systemImage="square.2.layers.3d.top.filled" onPress={() => onLayer(1)} />
        <Button label="Send Backward" systemImage="square.2.layers.3d.bottom.filled" onPress={() => onLayer(-1)} />
      </Section>
      <Section>
        {el.kind === 'button' && <Button label="Tap Actions" systemImage="hand.tap" onPress={onEditLogic} />}
        <Button label="Delete" role="destructive" onPress={onDelete} />
      </Section>
    </Form>
  );
}

// Logic tab: pick a button, then edit its "On Tap" steps.
function LogicTab({ iface, onChange, elementId, setElementId }: {
  iface: IfaceState; onChange: (next: IfaceState) => void;
  elementId: string | null; setElementId: (id: string | null) => void;
}) {
  const buttons = iface.elements.filter(e => e.kind === 'button');
  const panels = iface.elements.filter(e => e.kind === 'panel');
  const el = buttons.find(b => b.id === elementId) ?? buttons[0];
  if (!el) {
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section><Text>Add a button on the Design tab to give it tap actions.</Text></Section>
      </Form>
    );
  }
  const wf = iface.workflows.find(w => w.elementId === el.id);
  const steps = wf?.steps ?? [];
  const setSteps = (next: IfaceStep[]) => {
    const others = iface.workflows.filter(w => w.elementId !== el.id);
    const updated: IfaceWorkflow = wf ? { ...wf, steps: next } : { id: `wf_${el.id}`, elementId: el.id, enabled: true, steps: next };
    onChange({ ...iface, workflows: [...others, updated] });
  };
  const patchStep = (id: string, p: Partial<IfaceStep>) => setSteps(steps.map(s => (s.id === id ? { ...s, ...p } : s)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };

  return (
    <Form modifiers={[scrollContentBackground('hidden')]}>
      <Section title="Button">
        <Picker label="When tapped" selection={el.id} onSelectionChange={(id: string) => setElementId(id)} modifiers={[pickerStyle('menu')]}>
          {buttons.map(b => <Text key={b.id} modifiers={[tag(b.id)]}>{b.label || 'Button'}</Text>)}
        </Picker>
      </Section>
      {steps.map((st, i) => {
        const meta = ACTIONS.find(a => a.type === st.type);
        return (
          <Section key={st.id} title={`${i + 1}. ${meta?.label ?? st.type}`}>
            {(st.type === 'openPanel' || st.type === 'closePanel' || st.type === 'togglePanel') && (
              <Picker label="Panel" selection={String(st.params.targetId ?? '')}
                onSelectionChange={(v: string) => patchStep(st.id, { params: { ...st.params, targetId: v } })} modifiers={[pickerStyle('menu')]}>
                <Text modifiers={[tag('')]}>None</Text>
                {panels.map(p => <Text key={p.id} modifiers={[tag(p.id)]}>{p.label || 'Panel'}</Text>)}
              </Picker>
            )}
            {st.type === 'showToast' && <PlainField key={`${st.id}-t`} initial={String(st.params.text ?? '')} placeholder="Message" onChange={t => patchStep(st.id, { params: { ...st.params, text: t } })} />}
            {st.type === 'fireCustomEvent' && <PlainField key={`${st.id}-e`} initial={String(st.params.eventName ?? '')} placeholder="Event name" onChange={t => patchStep(st.id, { params: { ...st.params, eventName: t } })} />}
            {st.type === 'playSound' && <PlainField key={`${st.id}-s`} initial={String(st.params.soundName ?? '')} placeholder="Sound name" onChange={t => patchStep(st.id, { params: { ...st.params, soundName: t } })} />}
            {st.type === 'wait' && (
              <Stepper label={`Wait  ${(Number(st.params.ms) || 0) / 1000}s`} value={Number(st.params.ms) || 0} step={250} min={0} max={10000}
                onValueChange={v => patchStep(st.id, { params: { ...st.params, ms: v } })} />
            )}
            <Toggle label="Enabled" isOn={st.enabled} onIsOnChange={v => patchStep(st.id, { enabled: v })} />
            <HStack spacing={12}>
              <Button label="Up" systemImage="arrow.up" onPress={() => move(i, -1)} modifiers={[buttonStyle('borderless')]} />
              <Button label="Down" systemImage="arrow.down" onPress={() => move(i, 1)} modifiers={[buttonStyle('borderless')]} />
              <Spacer />
              <Button label="Remove" role="destructive" onPress={() => setSteps(steps.filter(s => s.id !== st.id))} modifiers={[buttonStyle('borderless')]} />
            </HStack>
          </Section>
        );
      })}
      <Section>
        <Menu label="Add Action" systemImage="plus.circle.fill">
          {ACTIONS.map(a => <Button key={a.type} label={a.label} systemImage={a.icon as any} onPress={() => setSteps([...steps, blankStep(a.type)])} />)}
        </Menu>
        {steps.length === 0 && (
          <HStack><Image systemName="info.circle" size={13} color="gray" /><Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(2)]}>{` ${describe(el)} does nothing when tapped yet.`}</Text></HStack>
        )}
      </Section>
    </Form>
  );
}

function PlainField({ initial, placeholder, onChange }: { initial: string; placeholder: string; onChange: (v: string) => void }) {
  const text = useNativeState(initial);
  return <TextField text={text} placeholder={placeholder} onTextChange={onChange} />;
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8,8,10,0.96)' },
  header: { height: 56 + 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: 4 },
  canvas: {
    borderRadius: 18, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  empty: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: 'rgba(235,235,245,0.5)', fontSize: 14, textAlign: 'center' },
  el: { position: 'absolute', justifyContent: 'center' },
  elRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inspector: { borderRadius: 22, overflow: 'hidden' },
  logic: { flex: 1, borderRadius: 22, overflow: 'hidden' },
});
