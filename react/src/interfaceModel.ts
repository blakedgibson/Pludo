// ── Interface Builder data model ────────────────────────────────────────────
// Shared between the editor (CreateScreen.tsx's Interface Builder — Design
// canvas + Logic tab) and the runtime (App.tsx, which renders elements and
// interprets workflows during play). Keep both in lockstep with this file
// rather than letting either side drift its own copy of the shape.
//
// Free-form: x/y/w/h are all 0–100, percentages of the Design canvas box.
// No parent/child nesting in v1 — panels are just another positionable box;
// stack anything on top of one with zIndex instead of nesting it inside.
export type IfaceElementKind = 'button' | 'text' | 'image' | 'panel';
export type IfaceElement = {
  id: string;
  kind: IfaceElementKind;
  x: number; y: number;   // top-left, 0–100
  w?: number; h?: number; // 0–100, panel/image only — button/text auto-size
  zIndex?: number;
  visible: boolean;       // toggled at runtime by openPanel/closePanel/togglePanel
  label?: string;         // button/text/panel (panel's title)
  body?: string;          // panel only — paragraph text under the title
  icon?: string;          // button/image — material-symbol name; legacy emoji rendered as-is
  bgColor?: string; textColor?: string; cornerRadius?: number;
};

// Deliberately small — one flat ordered step list per interactive element,
// triggered by "On Tap", no guards/conditions. Bubble-style but kept simple.
export type IfaceActionType = 'openPanel' | 'closePanel' | 'togglePanel' | 'showToast' | 'fireCustomEvent' | 'playSound' | 'wait';
export type IfaceStep = { id: string; type: IfaceActionType; params: Record<string, any>; enabled: boolean };
export type IfaceWorkflow = { id: string; elementId: string; enabled: boolean; steps: IfaceStep[] };

export const IFACE_ACTION_META: Record<IfaceActionType, { label: string; icon: string; help: string }> = {
  openPanel:       { label: 'Open Panel',     icon: 'open_in_full',       help: 'Shows a panel element' },
  closePanel:      { label: 'Close Panel',    icon: 'close_fullscreen',   help: 'Hides a panel element' },
  togglePanel:     { label: 'Toggle Panel',   icon: 'flip',               help: 'Shows the panel if hidden, hides it if shown' },
  showToast:       { label: 'Show Message',   icon: 'chat_bubble',        help: 'Pops up a short message on screen' },
  fireCustomEvent: { label: 'Fire Game Event',icon: 'bolt',               help: 'Runs Interface.OnButton("name", fn) in your Lua script' },
  playSound:       { label: 'Play Sound',     icon: 'volume_up',          help: 'Plays a sound effect' },
  wait:            { label: 'Wait',           icon: 'timer',              help: 'Pauses before running the next step' },
};
export const IFACE_ACTION_ORDER: IfaceActionType[] = ['openPanel', 'closePanel', 'togglePanel', 'showToast', 'fireCustomEvent', 'playSound', 'wait'];

export const IFACE_KIND_META: Record<IfaceElementKind, { label: string; icon: string }> = {
  button: { label: 'Button', icon: 'smart_button' },
  text:   { label: 'Text',   icon: 'text_fields' },
  image:  { label: 'Image',  icon: 'image' },
  panel:  { label: 'Panel',  icon: 'dashboard' },
};
export const IFACE_COLOR_SWATCHES = [
  'rgba(0,0,0,0.60)', 'rgba(255,255,255,0.14)', 'rgba(30,140,255,0.55)',
  'rgba(255,69,58,0.55)', 'rgba(52,199,89,0.55)', 'rgba(255,214,10,0.55)', 'rgba(191,90,242,0.55)',
];

// Material Symbol names are lowercase ascii snake_case (e.g. "open_in_full").
// Legacy migrated elements keep their original emoji string in `icon` (see
// migrateHudButtonsToInterface below) — this tells the two apart so callers
// can route to <icon set="material-rounded"> vs. plain emoji text.
export function isMaterialIconName(icon: string): boolean {
  return /^[a-z0-9_]+$/.test(icon);
}

export function ifaceUid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankIfaceStep(type: IfaceActionType): IfaceStep {
  const params: Record<string, any> =
    type === 'openPanel' || type === 'closePanel' || type === 'togglePanel' ? { targetId: '' } :
    type === 'showToast' ? { text: '' } :
    type === 'fireCustomEvent' ? { eventName: '' } :
    type === 'playSound' ? { soundName: '' } :
    /* wait */ { ms: 500 };
  return { id: ifaceUid('step'), type, params, enabled: true };
}

export function defaultIfaceElement(kind: IfaceElementKind, x: number, y: number): IfaceElement {
  switch (kind) {
    case 'button': return { id: ifaceUid('el'), kind, x, y, visible: true, label: 'Button', icon: 'star', bgColor: 'rgba(0,0,0,0.60)', textColor: '#ffffff' };
    case 'text':   return { id: ifaceUid('el'), kind, x, y, visible: true, label: 'Text', textColor: '#ffffff' };
    case 'image':  return { id: ifaceUid('el'), kind, x, y, w: 18, h: 18, visible: true, icon: 'image', bgColor: 'rgba(255,255,255,0.10)' };
    case 'panel':  return { id: ifaceUid('el'), kind, x, y, w: 70, h: 34, visible: true, label: 'Panel', bgColor: 'rgba(18,18,24,0.96)', textColor: '#ffffff' };
  }
}

// Old saves only have flat HudButton[] (anchor + one canned action). Convert
// once into the richer element+workflow shape so reopening the builder (or
// loading an un-migrated old game at runtime) shows something instead of a
// blank screen. Anchors become an approximate starting x/y — free to drag
// anywhere afterwards in the editor.
export function migrateHudButtonsToInterface(btns: Array<{ id: string; label: string; icon: string; anchor: string; action: string; panelTitle?: string; panelBody?: string; eventName?: string }>): { elements: IfaceElement[]; workflows: IfaceWorkflow[] } {
  const ANCHOR_POS: Record<string, { x: number; y: number }> = {
    'top-left':      { x: 6,  y: 8  },
    'top-center':    { x: 40, y: 8  },
    'top-right':     { x: 74, y: 8  },
    'bottom-left':   { x: 6,  y: 80 },
    'bottom-center': { x: 40, y: 80 },
    'bottom-right':  { x: 74, y: 80 },
  };
  const elements: IfaceElement[] = [];
  const workflows: IfaceWorkflow[] = [];
  const stackOffset: Record<string, number> = {};
  for (const btn of btns) {
    const pos = ANCHOR_POS[btn.anchor] ?? ANCHOR_POS['bottom-right'];
    const dy = stackOffset[btn.anchor] ?? 0;
    stackOffset[btn.anchor] = dy + 9;
    const btnEl: IfaceElement = {
      id: `mig_${btn.id}`, kind: 'button', x: pos.x, y: Math.min(90, pos.y + dy), visible: true,
      label: btn.label, icon: btn.icon, bgColor: 'rgba(0,0,0,0.60)', textColor: '#ffffff',
    };
    elements.push(btnEl);
    const steps: IfaceStep[] = [];
    if (btn.action === 'event') {
      steps.push({ ...blankIfaceStep('fireCustomEvent'), params: { eventName: btn.eventName ?? '' } });
    } else if (btn.action === 'leaderboard') {
      steps.push({ ...blankIfaceStep('fireCustomEvent'), params: { eventName: '__openLeaderboard' } });
    } else {
      const panelId = `mig_panel_${btn.id}`;
      elements.push({
        id: panelId, kind: 'panel', x: 10, y: 30, w: 80, h: 40, visible: false, zIndex: 10,
        label: btn.panelTitle ?? '', body: btn.panelBody ?? '', bgColor: 'rgba(18,18,24,0.98)', textColor: '#ffffff',
      });
      steps.push({ ...blankIfaceStep('openPanel'), params: { targetId: panelId } });
    }
    workflows.push({ id: `mig_wf_${btn.id}`, elementId: btnEl.id, enabled: true, steps });
  }
  return { elements, workflows };
}
