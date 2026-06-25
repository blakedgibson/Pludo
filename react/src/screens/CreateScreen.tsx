import React, { useState, useEffect, useRef } from 'react';
import { C } from '../theme';
import { safeAreaTop, safeAreaBottom, safeAreaLeft, safeAreaRight } from '../safeArea';
import { AssetItem } from '../types';
import { Pressable } from '../components/Pressable';
import { SkeletonGameCard } from '../components/Skeleton';

// ── Supabase ──────────────────────────────────────────────────────────────────
const SB_URL      = 'https://daahlworuhbdindjepyg.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhYWhsd29ydWhiZGluZGplcHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODc1MzIsImV4cCI6MjA5MzE2MzUzMn0.2bZa49XuHTBxb-LgqStR_1ouevs-qrFOHGQAZCCxLeQ';

async function fetchMyGamesFromSupabase(userId: string, userAccessToken: string, creatorName: string): Promise<GameStub[]> {
  const bearer = userAccessToken || SB_ANON_KEY;
  let filter = '';
  if (userId) {
    filter = `&created_by_user_id=eq.${encodeURIComponent(userId)}`;
  } else if (creatorName) {
    filter = `&creator_name=eq.${encodeURIComponent(creatorName)}`;
  }
  // Order by updated_at so the most-recently-edited game sits at the top of My
  // Games. updated_at is bumped on every editor autosave, script update, and
  // publish (api-server PATCHes forge_games.updated_at), and defaults to
  // created_at on a fresh forge — so a brand-new game still lands at the top.
  const url = `${SB_URL}/rest/v1/forge_games?select=id,title,description,genre,plays,game_code,thumbnail_url${filter}&order=updated_at.desc`;
  const r = await fetch(url, {
    headers: { 'apikey': SB_ANON_KEY, 'Authorization': `Bearer ${bearer}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  const rows = await r.json() as Array<{
    id: number; title: string; description: string;
    genre: string; plays: number; game_code: string | null;
    thumbnail_url: string | null;
  }>;
  return rows.map(row => ({
    id:           row.id,
    title:        row.title,
    description:  row.description,
    genre:        row.genre,
    plays:        row.plays ?? 0,
    hasCode:      !!(row.game_code),
    thumbnailUrl: row.thumbnail_url ?? '',
  }));
}

// ── Editor bottom-sheet drag constants ───────────────────────────────────────
const SHEET_COLLAPSED = 104;
const SHEET_HALF      = 439;
const SHEET_FULL      = 760;
const SHEET_LERP      = 0.28;
const SNAP_TO_FULL    = SHEET_FULL  * 0.75;
const SNAP_TO_HALF    = SHEET_COLLAPSED + (SHEET_HALF - SHEET_COLLAPSED) * 0.40;

// Editor runs in landscape; centered popups/sheets cap at these widths so they
// don't stretch edge-to-edge across the wide viewport.
const EDITOR_MODAL_MAX_WIDTH  = 420;
const EDITOR_SHEET_MAX_WIDTH  = 520;
const EDITOR_BANNER_MAX_WIDTH = 480;

function editorPointerY(): number {
  return (Globals['getPointerY'] as any)?.() ?? 0;
}
function editorPointerX(): number {
  return (Globals['getPointerX'] as any)?.() ?? 0;
}
function editorScreenH(): number {
  return (Globals['getScreenHeight'] as any)?.() ?? 844;
}

interface GameStub {
  id: number;
  title: string;
  description: string;
  genre: string;
  plays: number;
  hasCode: boolean;
  thumbnailUrl: string;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

type Phase = 'prompt' | 'done' | 'editing';

const BUILD_STEPS = [
  'Analyzing concept...',
  'Designing mechanics...',
  'Writing game engine...',
  'Building Unity world...',
  'Polishing details...',
  'Finalizing build...',
];

// ── Per-object editor settings ───────────────────────────────────────────────
// Driven by the Settings (gear) panel that pops out of the top bar when an
// object is selected. The React side owns the source of truth (so the panel
// stays consistent across selections); each mutation is mirrored to Unity via
// editorSetObjectSetting(objectId, key, value) so behaviors like Invisible /
// Weight / Move take effect live.
type ObjectSettings = {
  destroyable: boolean;
  healthRegen: boolean;
  infiniteLives: boolean;
  explode: boolean;
  healthPoints: string;
  extraLives: string;
  invisible: boolean;
  physics: boolean;
  weight: string;
  move: boolean;
  horizontal: boolean;
  horizontalSpeed: string;
  horizontalDistance: string;
  vertical: boolean;
  verticalSpeed: string;
  verticalDistance: string;
};
const DEFAULT_OBJECT_SETTINGS: ObjectSettings = {
  destroyable: false,
  healthRegen: false,
  infiniteLives: false,
  explode: false,
  healthPoints: '',
  extraLives: '',
  invisible: false,
  physics: false,
  weight: '',
  move: false,
  horizontal: false,
  horizontalSpeed: '',
  horizontalDistance: '',
  vertical: false,
  verticalSpeed: '',
  verticalDistance: '',
};
// The selected object id is the name half of Unity's "name|coords" payload.
function selectedObjectId(selectedObj: string): string {
  return (selectedObj.split('|')[0] ?? '').trim();
}
function pushObjectSetting(objectId: string, key: keyof ObjectSettings, value: boolean | string) {
  if (!objectId) return;
  try {
    (Globals as any).editorSetObjectSetting?.(
      objectId,
      key,
      typeof value === 'boolean' ? (value ? 'true' : 'false') : value,
    );
  } catch { /* bridge not ready — settings still persisted in React state */ }
}

// ── Custom Logic (visual node-based programming) ─────────────────────────────
// A behavior graph is a single chain — Execute (root) → zero-or-more Condition
// nodes ("IF") → zero-or-more Action nodes ("THEN"). It evaluates top-to-bottom:
// when every condition is satisfied, every action fires in order. The React
// side owns the source of truth and mirrors the JSON to Unity through
// editorSetObjectLogic(objectId, graphJSON) — the engine compiles the graph
// into a live behavior on the selected object.
type ConditionType =
  | 'enterZone'      // Player enters this object's trigger volume
  | 'healthBelow'    // Object's health drops below threshold
  | 'timer'          // N seconds have elapsed since spawn
  | 'collision'      // Object collides with another tagged object
  | 'destroyed'      // Object has been destroyed
  | 'gameStart';     // Fires once at game start
type ActionType =
  | 'changeBehavior' // NPC state machine — Guard / Follow / Flee
  | 'addForce'       // Apply physics impulse (x, y, z)
  | 'attachObject'   // Snap another object onto this one with offset
  | 'cameraLookAt'   // Force game camera to focus on a target
  | 'spawn'          // Instantiate another asset at this object's position
  | 'playSound'      // Play a sound effect by name
  | 'showMessage'    // Display a HUD message
  | 'awardPoints';   // Add points to the player's score
type LogicNodeKind = 'execute' | 'condition' | 'action';
type LogicNode = {
  id: string;
  kind: LogicNodeKind;
  type?: ConditionType | ActionType;       // unused for the execute root
  params: Record<string, string>;
};
type LogicGraph = { nodes: LogicNode[] };

const EXECUTE_ROOT: LogicNode = { id: 'execute', kind: 'execute', params: {} };
const DEFAULT_LOGIC_GRAPH: LogicGraph = { nodes: [EXECUTE_ROOT] };

const CONDITION_CATALOG: { type: ConditionType; label: string; icon: string; fields: { key: string; label: string; placeholder?: string }[] }[] = [
  { type: 'enterZone',   label: 'Player Enters Zone', icon: 'login',         fields: [] },
  { type: 'healthBelow', label: 'Health Below',       icon: 'favorite',      fields: [{ key: 'threshold', label: 'Threshold (%)', placeholder: '50' }] },
  { type: 'timer',       label: 'Timer Finishes',     icon: 'timer',         fields: [{ key: 'seconds',   label: 'After (seconds)', placeholder: '3' }] },
  { type: 'collision',   label: 'On Collision',       icon: 'compare_arrows', fields: [{ key: 'tag',      label: 'With Tag',       placeholder: 'Player' }] },
  { type: 'destroyed',   label: 'Object Destroyed',   icon: 'block',         fields: [] },
  { type: 'gameStart',   label: 'Game Start',         icon: 'play_circle',   fields: [] },
];
const ACTION_CATALOG: { type: ActionType; label: string; icon: string; fields: { key: string; label: string; placeholder?: string }[] }[] = [
  { type: 'changeBehavior', label: 'Change Behavior',  icon: 'psychology',     fields: [{ key: 'state', label: 'State', placeholder: 'Guard | Follow | Flee' }] },
  { type: 'addForce',       label: 'Add Force',        icon: 'rocket_launch',  fields: [
    { key: 'x', label: 'Force X', placeholder: '0' },
    { key: 'y', label: 'Force Y', placeholder: '5' },
    { key: 'z', label: 'Force Z', placeholder: '0' },
  ]},
  { type: 'attachObject',   label: 'Attach Object',    icon: 'attach_file',    fields: [
    { key: 'target', label: 'Target Object', placeholder: 'Key' },
    { key: 'offset', label: 'Offset (x,y,z)', placeholder: '0,1,0' },
  ]},
  { type: 'cameraLookAt',   label: 'Camera Look At',   icon: 'videocam',       fields: [{ key: 'target', label: 'Target Object', placeholder: 'Boss' }] },
  { type: 'spawn',          label: 'Spawn Object',     icon: 'add_circle',     fields: [{ key: 'asset', label: 'Asset Name', placeholder: 'Coin' }] },
  { type: 'playSound',      label: 'Play Sound',       icon: 'volume_up',      fields: [{ key: 'name',  label: 'Sound', placeholder: 'pickup' }] },
  { type: 'showMessage',    label: 'Show Message',     icon: 'chat_bubble',    fields: [{ key: 'text',  label: 'Message', placeholder: 'Level cleared!' }] },
  { type: 'awardPoints',    label: 'Award Points',     icon: 'star',           fields: [{ key: 'points', label: 'Points', placeholder: '100' }] },
];
function conditionMeta(t?: ConditionType) { return CONDITION_CATALOG.find(c => c.type === t); }
function actionMeta(t?: ActionType)       { return ACTION_CATALOG.find(a => a.type === t); }

function pushObjectLogic(objectId: string, graph: LogicGraph) {
  if (!objectId) return;
  try { (Globals as any).editorSetObjectLogic?.(objectId, JSON.stringify(graph)); }
  catch { /* bridge not ready — graph still persisted in React state */ }
}
async function aiGenerateLogicGraph(objectId: string, prompt: string): Promise<LogicGraph | null> {
  if (!objectId || !prompt.trim()) return null;
  // Prefer the C# bridge if it's wired (so the request rides the same auth/session
  // pipeline as the AI chat). Fall back to a direct call to the api-server.
  try {
    const bridge = (Globals as any).aiGenerateLogicGraph;
    if (typeof bridge === 'function') {
      const raw = await bridge(objectId, prompt);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && Array.isArray(parsed?.nodes)) return parsed as LogicGraph;
    }
  } catch { /* fall through to fetch */ }
  try {
    const r = await apiPost<{ graph: LogicGraph }>('/ai/logic-graph', { objectId, prompt });
    return r?.graph ?? null;
  } catch { return null; }
}

// Strip leading emoji/symbol decorations from AI-generated titles
// (e.g. "🎮 Cyberpunk Runner" → "Cyberpunk Runner") while preserving the body.
const stripDecorative = (s: string) =>
  (s ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

function baseUrl(): string {
  try { return (Globals as any).apiBaseUrl ?? 'http://localhost:4000'; } catch { return 'http://localhost:4000'; }
}

function getGlobal(name: string): string {
  try { return (Globals as any)[name]?.() ?? ''; } catch { return ''; }
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

// ── Dot spinner ───────────────────────────────────────────────────────────────

function Dots() {
  const [dot, setDot] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDot(d => (d + 1) % 4), 380);
    return () => clearInterval(t);
  }, []);
  return (
    <view style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {[0, 1, 2].map(i => (
        <icon
          key={i}
          set={i < dot ? 'material-rounded-filled' : 'material-rounded'}
          style={{ fontSize: 12, color: C.green, lineHeight: 12 }}
        >circle</icon>
      ))}
    </view>
  );
}

// ── Circular icon button ──────────────────────────────────────────────────────

function CircBtn({ icon, label, onClick, active, size = 44, color }: {
  icon: string; label?: string; onClick: () => void; active?: boolean; size?: number; color?: string;
}) {
  const bg = active ? (color ?? C.green) : 'rgba(22,22,24,0.92)';
  const fg = active ? '#000' : (color ?? C.text);
  const iconSize = Math.round(size * 0.5);
  return (
    <view style={{ alignItems: 'center', gap: 4 }}>
      <button onClick={onClick} style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: bg,
        borderWidth: 1.5,
        borderColor: active ? (color ?? C.green) : 'rgba(255,255,255,0.14)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set={active ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: iconSize, color: fg, lineHeight: iconSize }}>{icon}</icon>
      </button>
      {label ? <text style={{ fontSize: 9, color: C.secondary, textAlign: 'center' }}>{label}</text> : null}
    </view>
  );
}

// ── Publish confirmation modal ────────────────────────────────────────────────

function PublishModal({ onConfirm, onCancel, publishing }: {
  onConfirm: () => void; onCancel: () => void; publishing: boolean;
}) {
  return (
    <view style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignItems: 'center', justifyContent: 'center',
      paddingLeft: 28, paddingRight: 28,
    }}>
      <view style={{
        backgroundColor: C.card, borderRadius: 22,
        padding: 24, width: '100%', maxWidth: EDITOR_MODAL_MAX_WIDTH,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
        gap: 14,
      }}>
        <view style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(48,209,88,0.15)', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', borderWidth: 2, borderColor: C.green }}>
          <icon set="material-rounded-filled" style={{ fontSize: 28, color: C.green, lineHeight: 28 }}>rocket_launch</icon>
        </view>
        <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', textAlign: 'center' }}>Publish Game?</text>
        <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center', lineHeight: 20 }}>
          Your game will appear in the Games tab for everyone to play.
        </text>
        <view style={{ gap: 10, marginTop: 4 }}>
          <Pressable
            onClick={onConfirm}
            disabled={publishing}
            style={{
              backgroundColor: C.green, borderRadius: 14,
              paddingTop: 15, paddingBottom: 15, alignItems: 'center',
            }}
          >
            <text style={{ fontSize: 16, color: '#000', fontWeight: 'bold' }}>
              {publishing ? 'Publishing...' : 'Publish Now'}
            </text>
          </Pressable>
          <Pressable onClick={onCancel} style={{
            backgroundColor: 'transparent', borderRadius: 14,
            paddingTop: 12, paddingBottom: 12, alignItems: 'center',
          }}>
            <text style={{ fontSize: 15, color: C.secondary }}>Cancel</text>
          </Pressable>
        </view>
      </view>
    </view>
  );
}

// ── Done / game ready screen ──────────────────────────────────────────────────

function DoneScreen({ game, onEdit, onCreateAnother, onPlay }: {
  game: GameStub;
  onEdit: () => void;
  onCreateAnother: () => void;
  onPlay: () => void;
}) {
  return (
    <view style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <view style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(48,209,88,0.15)', alignItems: 'center', justifyContent: 'center', marginBottom: 20, borderWidth: 2, borderColor: C.green }}>
        <icon set="material-rounded-filled" style={{ fontSize: 36, color: C.green, lineHeight: 36 }}>check</icon>
      </view>
      <text style={{ fontSize: 24, color: C.text, fontWeight: 'bold', textAlign: 'center', marginBottom: 6 }}>
        {stripDecorative(game.title)}
      </text>
      <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center', marginBottom: 32, lineHeight: 20 }}>
        {stripDecorative(game.description) || 'Your game is ready!'}
      </text>
      <view style={{ width: '100%', gap: 10 }}>
        <Pressable onClick={onPlay} style={{
          backgroundColor: C.green, borderRadius: 16,
          paddingTop: 16, paddingBottom: 16, alignItems: 'center',
        }}>
          <text style={{ fontSize: 16, color: C.bg, fontWeight: 'bold' }}>Play Game</text>
        </Pressable>
        <Pressable onClick={onEdit} style={{
          backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border,
          paddingTop: 14, paddingBottom: 14, alignItems: 'center',
          flexDirection: 'row', justifyContent: 'center', gap: 8,
        }}>
          <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>edit</icon>
          <text style={{ fontSize: 15, color: C.text, fontWeight: 'bold' }}>Edit with AI</text>
        </Pressable>
        <button onClick={onCreateAnother} style={{
          backgroundColor: 'rgba(0,0,0,0)', borderRadius: 16, borderWidth: 0,
          paddingTop: 12, paddingBottom: 12, alignItems: 'center',
          flexDirection: 'row', justifyContent: 'center', gap: 6,
        }}>
          <icon set="material-rounded" style={{ fontSize: 16, color: C.green, lineHeight: 16 }}>add</icon>
          <text style={{ fontSize: 14, color: C.green }}>Create another</text>
        </button>
      </view>
    </view>
  );
}

// ── Play-anyway confirmation modal ────────────────────────────────────────────

function PlayAnywayModal({ done, total, onWait, onPlayAnyway }: {
  done: number; total: number; onWait: () => void; onPlayAnyway: () => void;
}) {
  const progress = total > 0 ? `${done} of ${total} model${total === 1 ? '' : 's'} ready.` : '';
  return (
    <view style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignItems: 'center', justifyContent: 'center',
      paddingLeft: 28, paddingRight: 28,
    }}>
      <view style={{
        backgroundColor: C.card, borderRadius: 22,
        padding: 24, width: '100%', maxWidth: EDITOR_MODAL_MAX_WIDTH,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
        gap: 14,
      }}>
        <view style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(245,158,11,0.15)', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', borderWidth: 2, borderColor: '#F59E0B' }}>
          <icon set="material-rounded" style={{ fontSize: 28, color: '#F59E0B', lineHeight: 28 }}>hourglass_top</icon>
        </view>
        <text style={{ fontSize: 20, color: C.text, fontWeight: 'bold', textAlign: 'center' }}>3D Models Loading</text>
        <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center', lineHeight: 20 }}>
          {progress ? `${progress} ` : ''}{'You can play now with placeholder shapes, or wait for the full 3D experience.'}
        </text>
        <view style={{ gap: 10, marginTop: 4 }}>
          <button onClick={onPlayAnyway} style={{
            backgroundColor: '#F59E0B', borderRadius: 14, borderWidth: 0,
            paddingTop: 15, paddingBottom: 15, alignItems: 'center',
          }}>
            <text style={{ fontSize: 16, color: '#000', fontWeight: 'bold' }}>Play Now</text>
          </button>
          <button onClick={onWait} style={{
            backgroundColor: 'transparent', borderRadius: 14, borderWidth: 0,
            paddingTop: 12, paddingBottom: 12, alignItems: 'center',
          }}>
            <text style={{ fontSize: 15, color: C.secondary }}>Wait for Full Models</text>
          </button>
        </view>
      </view>
    </view>
  );
}

// ── Per-object settings panel ────────────────────────────────────────────────
// Renders behavior toggles (Destroyable / Invisible / Physics / Move) and
// their sub-fields. Toggling Destroyable / Physics / Move reveals nested
// inputs without losing previously-typed values — onChange writes to the
// EditorScreen's settings record, which is also pushed to Unity live.

function ToggleRow({ label, value, onValueChange }: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <Pressable
      onClick={() => onValueChange(!value)}
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8, paddingBottom: 8,
      }}
    >
      <text style={{ fontSize: 13, color: C.text, flex: 1 }}>{label}</text>
      <view style={{
        width: 36, height: 20, borderRadius: 10,
        backgroundColor: value ? C.blue : 'rgba(255,255,255,0.15)',
        padding: 2,
        alignItems: value ? 'flex-end' : 'flex-start',
        justifyContent: 'center',
      }}>
        <view style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' }} />
      </view>
    </Pressable>
  );
}

function FieldRow({ label, value, onChangeText, placeholder }: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <view style={{ paddingTop: 6, paddingBottom: 6 }}>
      <text style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>{label}</text>
      <view style={{
        backgroundColor: C.surface,
        borderRadius: 8,
        paddingLeft: 10, paddingRight: 10,
        paddingTop: 4, paddingBottom: 4,
      }}>
        <input
          value={value}
          onChange={(val: any) => onChangeText(String(val ?? ''))}
          placeholder={placeholder ?? ''}
          style={{
            fontSize: 13, color: C.text,
            backgroundColor: 'transparent', borderWidth: 0, minHeight: 26,
          }}
        />
      </view>
    </view>
  );
}

function ObjectSettingsPanel({ settings, objectName, size, onChange, onClose, onPointerDown, onPointerUp }: {
  settings: ObjectSettings;
  objectName: string;
  size: 'default' | 'full';
  onChange: <K extends keyof ObjectSettings>(key: K, value: ObjectSettings[K]) => void;
  onClose: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
}) {
  return (
    <view
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{
      position: 'absolute',
      left: safeAreaLeft() + 6,
      top: safeAreaTop() + 56,
      bottom: safeAreaBottom() + 12,
      ...(size === 'full' ? { right: safeAreaRight() + 6 } : { width: 280 }),
      backgroundColor: 'rgba(20,20,22,0.94)',
      borderRadius: 14,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
      zIndex: 50,
      flexDirection: 'column',
    } as any}>
      {/* Header */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 14, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
      }}>
        <icon set="material-rounded-filled" style={{ fontSize: 18, color: C.blue, lineHeight: 18, marginRight: 8 }}>settings</icon>
        <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold', flex: 1 }}>
          {objectName || 'Object Settings'}
        </text>
        <button
          onClick={onClose}
          style={{
            width: 28, height: 28, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>close</icon>
        </button>
      </view>

      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ paddingLeft: 14, paddingRight: 14, paddingTop: 6, paddingBottom: 12 }}>
          {/* ── Destroyable ── */}
          <ToggleRow
            label="Destroyable"
            value={settings.destroyable}
            onValueChange={(v) => onChange('destroyable', v)}
          />
          {settings.destroyable ? (
            <view style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(30,140,255,0.30)', marginTop: 2, marginBottom: 6 }}>
              <ToggleRow
                label="Health Regeneration"
                value={settings.healthRegen}
                onValueChange={(v) => onChange('healthRegen', v)}
              />
              <ToggleRow
                label="Infinite Lives"
                value={settings.infiniteLives}
                onValueChange={(v) => onChange('infiniteLives', v)}
              />
              <ToggleRow
                label="Explode"
                value={settings.explode}
                onValueChange={(v) => onChange('explode', v)}
              />
              <FieldRow
                label="Health Points"
                value={settings.healthPoints}
                onChangeText={(v) => onChange('healthPoints', v)}
                placeholder="100"
              />
              <FieldRow
                label="Extra Lives"
                value={settings.extraLives}
                onChangeText={(v) => onChange('extraLives', v)}
                placeholder="0"
              />
            </view>
          ) : null}

          <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginTop: 4, marginBottom: 4 }} />

          {/* ── Invisible ── */}
          <ToggleRow
            label="Invisible"
            value={settings.invisible}
            onValueChange={(v) => onChange('invisible', v)}
          />

          <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginTop: 4, marginBottom: 4 }} />

          {/* ── Physics ── */}
          <ToggleRow
            label="Physics"
            value={settings.physics}
            onValueChange={(v) => onChange('physics', v)}
          />
          {settings.physics ? (
            <view style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(30,140,255,0.30)', marginTop: 2, marginBottom: 6 }}>
              <FieldRow
                label="Weight"
                value={settings.weight}
                onChangeText={(v) => onChange('weight', v)}
                placeholder="1.0"
              />
            </view>
          ) : null}

          <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginTop: 4, marginBottom: 4 }} />

          {/* ── Move ── */}
          <ToggleRow
            label="Move"
            value={settings.move}
            onValueChange={(v) => onChange('move', v)}
          />
          {settings.move ? (
            <view style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(30,140,255,0.30)', marginTop: 2, marginBottom: 6 }}>
              <ToggleRow
                label="Horizontally"
                value={settings.horizontal}
                onValueChange={(v) => onChange('horizontal', v)}
              />
              {settings.horizontal ? (
                <view style={{ paddingLeft: 10 }}>
                  <FieldRow
                    label="Movement Speed"
                    value={settings.horizontalSpeed}
                    onChangeText={(v) => onChange('horizontalSpeed', v)}
                    placeholder="2.0"
                  />
                  <FieldRow
                    label="Distance"
                    value={settings.horizontalDistance}
                    onChangeText={(v) => onChange('horizontalDistance', v)}
                    placeholder="5.0"
                  />
                </view>
              ) : null}
              <ToggleRow
                label="Vertically"
                value={settings.vertical}
                onValueChange={(v) => onChange('vertical', v)}
              />
              {settings.vertical ? (
                <view style={{ paddingLeft: 10 }}>
                  <FieldRow
                    label="Movement Speed"
                    value={settings.verticalSpeed}
                    onChangeText={(v) => onChange('verticalSpeed', v)}
                    placeholder="2.0"
                  />
                  <FieldRow
                    label="Distance"
                    value={settings.verticalDistance}
                    onChangeText={(v) => onChange('verticalDistance', v)}
                    placeholder="3.0"
                  />
                </view>
              ) : null}
            </view>
          ) : null}
        </view>
      </scroll>
    </view>
  );
}

// ── Custom Logic panel ───────────────────────────────────────────────────────
// Visual node-based programming for the currently-selected object. Layout
// mirrors ObjectSettingsPanel (left-docked column, same top offset, same
// pointer-down camera gate) so opening it feels identical to opening the gear
// panel — but where Settings exposes pre-canned toggles, Custom Logic lets the
// user assemble an Execute → Condition(s) → Action(s) chain by tapping nodes
// from a palette and editing their parameters in place.
//
// The graph is a single linear chain. Conditions are AND-joined; actions fire
// top-to-bottom when every condition is satisfied. Each onChange writes through
// to Unity via pushObjectLogic so the new behavior is live the moment the user
// edits a field.

function NodeCard({
  accent, icon, title, subtitle, onDelete, children,
}: {
  accent: string;
  icon: string;
  title: string;
  subtitle?: string;
  onDelete?: () => void;
  children?: any;
}) {
  return (
    <view style={{
      backgroundColor: 'rgba(28,28,32,0.92)',
      borderRadius: 10,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
      paddingLeft: 10, paddingRight: 8, paddingTop: 8, paddingBottom: 10,
    }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <view style={{
          width: 24, height: 24, borderRadius: 6,
          backgroundColor: accent,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <icon set="material-rounded-filled" style={{ fontSize: 14, color: '#000', lineHeight: 14 }}>{icon}</icon>
        </view>
        <view style={{ flex: 1 }}>
          <text style={{ fontSize: 12, color: C.text, fontWeight: 'bold' }}>{title}</text>
          {subtitle ? <text style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>{subtitle}</text> : null}
        </view>
        {onDelete ? (
          <button
            onClick={onDelete}
            style={{
              width: 22, height: 22, borderRadius: 11,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 0,
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 13, color: C.textMuted, lineHeight: 13 }}>close</icon>
          </button>
        ) : null}
      </view>
      {children ? <view style={{ marginTop: 8 }}>{children}</view> : null}
    </view>
  );
}

function Connector() {
  return (
    <view style={{ alignItems: 'center', paddingTop: 2, paddingBottom: 2 }}>
      <view style={{ width: 2, height: 12, backgroundColor: 'rgba(255,255,255,0.25)' }} />
      <icon set="material-rounded" style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 14, marginTop: -2 }}>expand_more</icon>
    </view>
  );
}

function NodeFields({ fields, params, onChange }: {
  fields: { key: string; label: string; placeholder?: string }[];
  params: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (!fields.length) return null;
  return (
    <view style={{ flexDirection: 'column', gap: 4 }}>
      {fields.map(f => (
        <view key={f.key} style={{ flexDirection: 'column' }}>
          <text style={{ fontSize: 10, color: C.textMuted, marginBottom: 2 }}>{f.label}</text>
          <view style={{
            backgroundColor: C.surface,
            borderRadius: 6,
            paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2,
          }}>
            <input
              value={params[f.key] ?? ''}
              onChange={(val: any) => onChange(f.key, String(val ?? ''))}
              placeholder={f.placeholder ?? ''}
              style={{
                fontSize: 12, color: C.text,
                backgroundColor: 'transparent', borderWidth: 0, minHeight: 22,
              }}
            />
          </view>
        </view>
      ))}
    </view>
  );
}

function CatalogPicker({ kind, onPick, onCancel }: {
  kind: 'condition' | 'action';
  onPick: (type: ConditionType | ActionType) => void;
  onCancel: () => void;
}) {
  const items = kind === 'condition'
    ? CONDITION_CATALOG.map(c => ({ type: c.type as ConditionType | ActionType, label: c.label, icon: c.icon }))
    : ACTION_CATALOG.map(a => ({ type: a.type as ConditionType | ActionType, label: a.label, icon: a.icon }));
  const accent = kind === 'condition' ? '#fcd34d' : '#34d399';
  return (
    <view style={{
      backgroundColor: 'rgba(18,18,22,0.96)',
      borderRadius: 10,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
      paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
      gap: 6,
    }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
        <text style={{ flex: 1, fontSize: 12, color: C.text, fontWeight: 'bold' }}>
          Add {kind === 'condition' ? 'Condition' : 'Action'}
        </text>
        <button
          onClick={onCancel}
          style={{
            width: 22, height: 22, borderRadius: 11,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 0,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 13, color: C.textMuted, lineHeight: 13 }}>close</icon>
        </button>
      </view>
      {items.map(it => (
        <button
          key={it.type}
          onClick={() => onPick(it.type)}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: 'rgba(255,255,255,0.04)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
            borderRadius: 8,
            paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6,
          }}
        >
          <view style={{
            width: 22, height: 22, borderRadius: 6,
            backgroundColor: accent,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <icon set="material-rounded-filled" style={{ fontSize: 13, color: '#000', lineHeight: 13 }}>{it.icon}</icon>
          </view>
          <text style={{ fontSize: 12, color: C.text, flex: 1 }}>{it.label}</text>
          <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>add</icon>
        </button>
      ))}
    </view>
  );
}

function CustomLogicPanel({ graph, objectName, size, onChange, onClose, onPointerDown, onPointerUp }: {
  graph: LogicGraph;
  objectName: string;
  size: 'default' | 'full';
  onChange: (next: LogicGraph) => void;
  onClose: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
}) {
  const [picker, setPicker] = useState<null | 'condition' | 'action'>(null);
  const [aiPrompt, setAiPrompt]   = useState('');
  const [aiBusy,   setAiBusy]     = useState(false);
  const [aiError,  setAiError]    = useState('');

  const conditions = graph.nodes.filter(n => n.kind === 'condition');
  const actions    = graph.nodes.filter(n => n.kind === 'action');

  function freshId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
  }

  function addNode(kind: 'condition' | 'action', type: ConditionType | ActionType) {
    const meta = kind === 'condition' ? conditionMeta(type as ConditionType) : actionMeta(type as ActionType);
    const params: Record<string, string> = {};
    (meta?.fields ?? []).forEach(f => { params[f.key] = ''; });
    const next: LogicNode = { id: freshId(kind), kind, type, params };
    onChange({ nodes: [...graph.nodes, next] });
    setPicker(null);
  }
  function removeNode(id: string) {
    onChange({ nodes: graph.nodes.filter(n => n.id !== id) });
  }
  function patchNode(id: string, key: string, value: string) {
    onChange({
      nodes: graph.nodes.map(n =>
        n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n,
      ),
    });
  }

  async function runAi() {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    setAiBusy(true);
    setAiError('');
    try {
      const generated = await aiGenerateLogicGraph(objectName, prompt);
      if (generated && Array.isArray(generated.nodes) && generated.nodes.length > 0) {
        // Ensure exactly one Execute root sits at the head of the chain.
        const withoutRoot = generated.nodes.filter(n => n.kind !== 'execute');
        onChange({ nodes: [EXECUTE_ROOT, ...withoutRoot] });
        setAiPrompt('');
      } else {
        setAiError("Couldn't build a graph from that prompt. Try rephrasing it.");
      }
    } catch {
      setAiError('AI generation failed. Check your connection and try again.');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <view
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        left: safeAreaLeft() + 6,
        top: safeAreaTop() + 56,
        bottom: safeAreaBottom() + 12,
        ...(size === 'full' ? { right: safeAreaRight() + 6 } : { width: 320 }),
        backgroundColor: 'rgba(20,20,22,0.94)',
        borderRadius: 14,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        zIndex: 50,
        flexDirection: 'column',
      } as any}
    >
      {/* Header */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 14, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
      }}>
        <icon set="material-rounded-filled" style={{ fontSize: 18, color: C.blue, lineHeight: 18, marginRight: 8 }}>code</icon>
        <view style={{ flex: 1 }}>
          <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold' }}>Custom Logic</text>
          <text style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>
            {objectName || 'Selected Object'}
          </text>
        </view>
        <button
          onClick={onClose}
          style={{
            width: 28, height: 28, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>close</icon>
        </button>
      </view>

      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 12, flexDirection: 'column', gap: 4 }}>

          {/* ── Execute root — always present, cannot be deleted ── */}
          <NodeCard
            accent={C.blue}
            icon="play_arrow"
            title="Execute"
            subtitle="Start of behavior graph"
          />

          {/* ── Conditions ("IF") ── */}
          {conditions.length > 0 ? <Connector /> : null}
          {conditions.map((n, i) => {
            const meta = conditionMeta(n.type as ConditionType);
            return (
              <React.Fragment key={n.id}>
                {i > 0 ? <Connector /> : null}
                <NodeCard
                  accent="#fcd34d"
                  icon={meta?.icon ?? 'rule'}
                  title={`IF — ${meta?.label ?? 'Condition'}`}
                  subtitle="Condition"
                  onDelete={() => removeNode(n.id)}
                >
                  <NodeFields
                    fields={meta?.fields ?? []}
                    params={n.params}
                    onChange={(k, v) => patchNode(n.id, k, v)}
                  />
                </NodeCard>
              </React.Fragment>
            );
          })}

          {/* + Add Condition */}
          <Connector />
          {picker === 'condition' ? (
            <CatalogPicker
              kind="condition"
              onCancel={() => setPicker(null)}
              onPick={t => addNode('condition', t)}
            />
          ) : (
            <button
              onClick={() => setPicker('condition')}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                backgroundColor: 'rgba(252,211,77,0.10)',
                borderWidth: 1, borderColor: 'rgba(252,211,77,0.35)',
                borderRadius: 8,
                paddingTop: 8, paddingBottom: 8,
              }}
            >
              <icon set="material-rounded" style={{ fontSize: 14, color: '#fcd34d', lineHeight: 14 }}>add</icon>
              <text style={{ fontSize: 12, color: '#fcd34d', fontWeight: 'bold' }}>Add Condition</text>
            </button>
          )}

          {/* ── Actions ("THEN") ── */}
          <Connector />
          {actions.map((n, i) => {
            const meta = actionMeta(n.type as ActionType);
            return (
              <React.Fragment key={n.id}>
                {i > 0 ? <Connector /> : null}
                <NodeCard
                  accent="#34d399"
                  icon={meta?.icon ?? 'bolt'}
                  title={`THEN — ${meta?.label ?? 'Action'}`}
                  subtitle="Action"
                  onDelete={() => removeNode(n.id)}
                >
                  <NodeFields
                    fields={meta?.fields ?? []}
                    params={n.params}
                    onChange={(k, v) => patchNode(n.id, k, v)}
                  />
                </NodeCard>
              </React.Fragment>
            );
          })}

          {/* + Add Action */}
          {actions.length > 0 ? <Connector /> : null}
          {picker === 'action' ? (
            <CatalogPicker
              kind="action"
              onCancel={() => setPicker(null)}
              onPick={t => addNode('action', t)}
            />
          ) : (
            <button
              onClick={() => setPicker('action')}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                backgroundColor: 'rgba(52,211,153,0.10)',
                borderWidth: 1, borderColor: 'rgba(52,211,153,0.35)',
                borderRadius: 8,
                paddingTop: 8, paddingBottom: 8,
              }}
            >
              <icon set="material-rounded" style={{ fontSize: 14, color: '#34d399', lineHeight: 14 }}>add</icon>
              <text style={{ fontSize: 12, color: '#34d399', fontWeight: 'bold' }}>Add Action</text>
            </button>
          )}

          {/* ── Generative AI prompt — text → graph ─────────────────────────── */}
          <view style={{
            marginTop: 10,
            backgroundColor: 'rgba(125,211,252,0.07)',
            borderRadius: 10,
            borderWidth: 1, borderColor: 'rgba(125,211,252,0.25)',
            paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 10,
          }}>
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <icon set="material-rounded-filled" style={{ fontSize: 14, color: '#7dd3fc', lineHeight: 14 }}>auto_awesome</icon>
              <text style={{ fontSize: 12, color: '#7dd3fc', fontWeight: 'bold' }}>Describe with AI</text>
            </view>
            <text style={{ fontSize: 10, color: C.textMuted, marginBottom: 6 }}>
              Type what this object should do. AI will assemble the nodes for you.
            </text>
            <view style={{
              backgroundColor: C.surface,
              borderRadius: 8,
              paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2,
              marginBottom: 6,
            }}>
              <input
                value={aiPrompt}
                onChange={(val: any) => setAiPrompt(String(val ?? ''))}
                placeholder="e.g. Chase the player only when they hold a sword"
                style={{
                  fontSize: 12, color: C.text,
                  backgroundColor: 'transparent', borderWidth: 0, minHeight: 28,
                }}
              />
            </view>
            <button
              onClick={runAi}
              style={{
                backgroundColor: aiBusy ? 'rgba(125,211,252,0.35)' : '#7dd3fc',
                borderRadius: 8, borderWidth: 0,
                paddingTop: 8, paddingBottom: 8,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <text style={{ fontSize: 12, color: '#000', fontWeight: 'bold' }}>
                {aiBusy ? 'Generating…' : 'Generate Graph'}
              </text>
            </button>
            {aiError ? (
              <text style={{ fontSize: 10, color: '#ff453a', marginTop: 6 }}>{aiError}</text>
            ) : null}
          </view>

        </view>
      </scroll>
    </view>
  );
}

// ── AI Game Editor ─────────────────────────────────────────────────────────────

function EditorScreen({ game, onBack, onEditingChange, onOpenShop, editorAssets, buildJobId, onBuildComplete, initialPrompt }: {
  game: GameStub;
  onBack: () => void;
  onEditingChange?: (v: boolean) => void;
  onOpenShop?: () => void;
  editorAssets?: AssetItem[];
  buildJobId?: string;
  onBuildComplete?: (g: GameStub) => void;
  initialPrompt?: string;
}) {
  const isInitialBuild = !!buildJobId;

  // The chat sheet is hidden by default — the new editor chrome puts AI access
  // behind the top-left "AI" button, so the game viewport is unobstructed until
  // the user explicitly opens chat. Auto-opens during the initial build so the
  // user sees the streaming AI status.
  // Unified left-dock modal state. Each modal (chat / settings / custom logic)
  // shares this slot and one is active at a time. The size dimension cycles
  // collapsed-knob → default panel → full-screen via swipe gestures inside
  // the modal:
  //   • swipe left  → full → default → knob → close (activeModal = null)
  //   • swipe right → knob → default → full
  // Tapping the top-bar button toggles between knob and default for that
  // modal (or activates it at default when a different modal was active).
  // The button shows "selected" chrome when its modal is active AND not
  // in the knob state, so collapsing to the knob (via swipe-left) visually
  // deselects the top-bar button as requested.
  type ModalKind = 'chat' | 'settings' | 'logic';
  type ModalSize = 'knob' | 'default' | 'full';
  const [activeModal, setActiveModal] = useState<ModalKind | null>(isInitialBuild ? 'chat' : null);
  const [modalSize,   setModalSize]   = useState<ModalSize>('default');
  const [sheetH,      setSheetH]      = useState(SHEET_COLLAPSED);
  const [input,       setInput]       = useState('');
  const [history,     setHistory]     = useState<ChatMsg[]>(
    isInitialBuild
      ? [
          ...(initialPrompt ? [{ role: 'user' as const, content: initialPrompt }] : []),
          { role: 'assistant', content: BUILD_STEPS[0] },
        ]
      : []
  );
  const [sending,     setSending]     = useState(false);
  const [gameData,      setGameData]      = useState(game);
  // Mirror the latest gameData into a ref so the mount effect's cleanup (which
  // closes over the initial value) can stash the *current* game on play-launch.
  const gameDataRef = useRef(gameData);
  gameDataRef.current = gameData;
  const [isBuilding,    setIsBuilding]    = useState(isInitialBuild);
  const [buildStep,     setBuildStep]     = useState(0);
  // True once Meshy asset generation is complete — play is blocked until then.
  const [assetsReady,   setAssetsReady]   = useState(!isInitialBuild);
  // Progress counters for the script_ready window (Lua done, Meshy still running).
  const [assetsProgress, setAssetsProgress] = useState<{done: number; total: number}>({done: 0, total: 0});
  const [showPlayModal,  setShowPlayModal]  = useState(false);
  const [keyboardH,     setKeyboardH]     = useState(0);
  const [previewError,  setPreviewError]  = useState('');
  // Bumped when polled safe-area insets change — forces a re-render so the
  // inline safeArea*() calls in JSX pick up landscape values once the
  // rotation has actually committed.
  const [, setSafeAreaVersion]            = useState(0);

  // Editor toolbar state
  // Select mode is always on in the editor — there's no toggle button. It's a
  // constant on the React side; the effect below keeps Unity's SelectActive
  // asserted to match.
  const selectMode = true;
  const [selectedObj, setSelectedObj] = useState('');

  // Per-object settings panel (gear button on the selection top bar). Keyed by
  // the object name so re-selecting the same model restores its toggles.
  const [objectSettings, setObjectSettings] = useState<Record<string, ObjectSettings>>({});
  const currentObjectId   = selectedObjectId(selectedObj);
  const currentObjSetting = objectSettings[currentObjectId] ?? DEFAULT_OBJECT_SETTINGS;
  function updateObjSetting<K extends keyof ObjectSettings>(key: K, value: ObjectSettings[K]) {
    if (!currentObjectId) return;
    setObjectSettings(prev => ({
      ...prev,
      [currentObjectId]: { ...(prev[currentObjectId] ?? DEFAULT_OBJECT_SETTINGS), [key]: value },
    }));
    pushObjectSetting(currentObjectId, key, value);
  }

  // Per-object Custom Logic graphs.
  const [objectGraphs, setObjectGraphs] = useState<Record<string, LogicGraph>>({});
  const currentObjGraph = objectGraphs[currentObjectId] ?? DEFAULT_LOGIC_GRAPH;
  function updateObjGraph(next: LogicGraph) {
    if (!currentObjectId) return;
    setObjectGraphs(prev => ({ ...prev, [currentObjectId]: next }));
    pushObjectLogic(currentObjectId, next);
  }

  // ── Derived modal flags (compat with existing JSX checks). These read
  // TRUE only when the modal is "expanded" (default or full), not when it
  // has been collapsed to a knob. The button-selected state on the top bar
  // is therefore the same as the expanded check, automatically satisfying
  // "swipe-left collapses → button unselects."
  const chatOpen        = activeModal === 'chat'     && modalSize !== 'knob';
  const showSettings    = activeModal === 'settings' && modalSize !== 'knob';
  const showCustomLogic = activeModal === 'logic'    && modalSize !== 'knob';
  // Truthy when ANY of the three panels is in knob state — used by the
  // edge-knob renderer below the modal section.
  const knobActive      = activeModal !== null && modalSize === 'knob';

  // Tapping a top-bar button: if a different modal was active, switch to it
  // at default size. If the same modal was already expanded, collapse to a
  // knob (which visually deselects the button). If the same modal was on a
  // knob, expand it back to default.
  function openModal(kind: ModalKind) {
    if (activeModal !== kind) { setActiveModal(kind); setModalSize('default'); return; }
    setModalSize(s => s === 'knob' ? 'default' : 'knob');
  }
  function openChat()        { openModal('chat'); }
  function openSettings()    { openModal('settings'); }
  function openCustomLogic() { openModal('logic'); }
  function closeModal()      { setActiveModal(null); setModalSize('default'); }
  // Swipe gestures inside the modal step the size up/down. Left from knob
  // dismisses the modal entirely; right from full is a no-op (already max).
  function modalSwipeLeft() {
    if (!activeModal) return;
    if (modalSize === 'full')        setModalSize('default');
    else if (modalSize === 'default') setModalSize('knob');
    else                              closeModal();
  }
  function modalSwipeRight() {
    if (!activeModal) return;
    if (modalSize === 'knob')        setModalSize('default');
    else if (modalSize === 'default') setModalSize('full');
  }
  // Touch-tracker that turns horizontal drags into swipe-left / swipe-right
  // dispatches. Pure x/y delta on pointer-up against the position recorded
  // on pointer-down (queried via the Unity bridge so it works the same on
  // touch and mouse). Filters out short or mostly-vertical drags so tapping
  // a toggle or scrolling the panel content doesn't accidentally swipe.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  function modalPointerDown() {
    swipeStartRef.current = { x: editorPointerX(), y: editorPointerY() };
  }
  function modalPointerUp() {
    const s = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!s) return;
    const dx = editorPointerX() - s.x;
    const dy = editorPointerY() - s.y;
    const SWIPE_THRESHOLD = 50; // canvas reference units
    if (Math.abs(dx) < SWIPE_THRESHOLD)           return;
    if (Math.abs(dx) < Math.abs(dy))              return; // mostly vertical
    if (dx < 0) modalSwipeLeft();
    else        modalSwipeRight();
  }

  // While the settings panel is open, lock the editor camera + select-tap
  // globally. Pointer-bubble suppression through nested <view>/<scroll>/
  // <Pressable> trees is fragile in ReactUnity — taps on toggles can still
  // leak through and clear the selection, which closes the panel under the
  // user. This is the reliable version: SheetDragging=true makes
  // EditorCameraController.HandleInput early-exit every frame, so _tapDown
  // never becomes true and ProcessSelectTap is a no-op. The cost is the
  // user can't pan/zoom the camera while the panel is open — closing the
  // panel (Edit again, or the X in the panel header) restores camera input.
  // Single SheetDragging lock for every left-dock panel (Settings / Custom
  // Logic / AI chat). Two separate useEffects with independent deps could
  // step on each other during a panel-to-panel transition: the closing
  // panel's cleanup would run AFTER the opening panel's setup and release
  // the lock. Watching the boolean union avoids that — the lock flips only
  // when ALL panels are closed.
  const anyLeftPanelOpen = chatOpen || showSettings || showCustomLogic;
  useEffect(() => {
    if (!anyLeftPanelOpen) return;
    try { (Globals as any).setEditorSheetDragging?.('true');  } catch {}
    return () => {
      try { (Globals as any).setEditorSheetDragging?.('false'); } catch {}
    };
  }, [anyLeftPanelOpen]);

  // Safety net for the camera lock above. Settings / Custom Logic are
  // selection-scoped — their panels only render while `selectedObj` is set, but
  // `activeModal` lives independently. If the selection ever clears while one is
  // open (e.g. a stray select-tap on Unity's side), the panel unmounts but
  // `activeModal` would stay 'settings'/'logic', keeping anyLeftPanelOpen true
  // and SheetDragging locked with nothing on screen to dismiss it. Closing the
  // modal here releases the lock so the camera can move again.
  useEffect(() => {
    if (!selectedObj && (activeModal === 'settings' || activeModal === 'logic')) {
      closeModal();
    }
  }, [selectedObj, activeModal]);

  // ── Left-panel framing ──────────────────────────────────────────────────
  // When a left-docked panel (Settings / Custom Logic) opens, we want two
  // things to happen in lockstep:
  //   1. The editor camera glides so the selection sits at the centre of
  //      the visible right-of-panel area (handled in C# by
  //      EditorCameraController.BeginRightAreaFraming).
  //   2. The screen-fixed overlay buttons that live on the left edge
  //      (top-left hamburger/menu bar, bottom-left undo/redo + asset
  //      strip) slide right so the panel doesn't overlap them.
  //
  // Both motions use the same eased lerp so they feel like one transition.
  // The shift target retargets smoothly when toggling between Settings ↔
  // Custom Logic (their widths differ), and animates back to 0 on close.
  const SETTINGS_PANEL_WIDTH = 280;
  const LOGIC_PANEL_WIDTH    = 320;
  const PANEL_GAP            = 12;
  const leftPanelOpen        = (selectMode && !!selectedObj && (showSettings || showCustomLogic));
  const leftPanelRightEdge   = showCustomLogic
    ? safeAreaLeft() + 6 + LOGIC_PANEL_WIDTH
    : safeAreaLeft() + 6 + SETTINGS_PANEL_WIDTH;
  const shiftTarget          = leftPanelOpen ? (leftPanelRightEdge + PANEL_GAP - safeAreaLeft()) : 0;
  // Shift is now a hard set, not a 60 Hz lerp. The previous setInterval-based
  // animation re-rendered the entire EditorScreen ~60× per second; combined
  // with the polling useEffects below (selectMode, _selectedObject, selBounds,
  // _editorError, sheetH, keyboardH, …) ReactUnity choked and the UI froze
  // when a panel opened. A single state write on toggle is plenty — the
  // camera framing on the Unity side still glides, so the eye reads it as
  // animated even though the bar/strip snap.
  const [editorShift, setEditorShift] = useState(0);
  useEffect(() => {
    setEditorShift(shiftTarget);
  }, [shiftTarget]);

  // Drive the C# camera framing alongside the UI shift. We send the panel's
  // right-edge x in React canvas reference units; Unity converts to pixels
  // and centres the selection between that edge and the screen's right edge.
  // Re-fires whenever the panel identity changes (Settings ↔ Custom Logic)
  // so the framing retargets with the new width.
  useEffect(() => {
    if (leftPanelOpen) {
      try { (Globals as any).editorFrameSelectionRight?.(leftPanelRightEdge); } catch {}
      return () => {
        try { (Globals as any).editorClearSelectionFraming?.(); } catch {}
      };
    }
  }, [leftPanelOpen, leftPanelRightEdge]);

  // Publish modal state
  const [showPublish, setShowPublish] = useState(false);
  const [publishing,  setPublishing]  = useState(false);
  const [published,   setPublished]   = useState(false);

  // Hamburger menu state — replaces the top-left/right toolbar rows
  const [menuOpen, setMenuOpen] = useState(false);

  // "Tools" dropdown navigation. The default top bar shows a single Tools
  // button; tapping it drills into the Tools submenu (Terrain / Style /
  // Interface / Player), Style drills into (Textures / Lighting / Sky / Sound),
  // and those leaves show preset rows. The hamburger X steps back one level.
  type ToolsMenu = 'none' | 'tools' | 'style' | 'sky' | 'lighting' | 'textures' | 'player' | 'interface';
  const [toolsMenu, setToolsMenu] = useState<ToolsMenu>('none');

  // Live scene-style + player settings, mirrored from Unity's SceneSettings so
  // the preset rows can highlight the active choice and the Player steppers show
  // real values. Seeded from editorGetSceneSettings when the Tools menu opens.
  const [skyPreset,      setSkyPreset]      = useState('');
  const [lightingPreset, setLightingPreset] = useState('');
  const [groundPreset,   setGroundPreset]   = useState('');
  const [playerSpeed,    setPlayerSpeed]    = useState(5);
  const [playerJump,     setPlayerJump]     = useState(2);

  // ── Interface (HUD button editor) ─────────────────────────────────────────
  type HudButton = {
    id: string; label: string; icon: string; anchor: string;
    action: 'panel' | 'leaderboard' | 'event';
    panelTitle: string; panelBody: string; eventName: string;
  };
  const IFACE_ICONS = ['🎮','🛒','🗺️','🏆','💬','📜','⚙️','❓','⚔️','🧪','🎁','🔔'];
  const IFACE_ANCHORS = [
    { key: 'top-left',      label: 'Top Left' },
    { key: 'top-center',    label: 'Top Center' },
    { key: 'top-right',     label: 'Top Right' },
    { key: 'bottom-left',   label: 'Bottom Left' },
    { key: 'bottom-center', label: 'Bottom Center' },
    { key: 'bottom-right',  label: 'Bottom Right' },
  ];
  const IFACE_ACTIONS = [
    { key: 'panel',       label: 'Info Panel',   desc: 'Shows a text dialog' },
    { key: 'leaderboard', label: 'Leaderboard',  desc: 'Shows player scores' },
    { key: 'event',       label: 'Game Event',   desc: 'Fires a Lua event' },
  ] as const;
  const [hudButtons,    setHudButtons]    = useState<HudButton[]>([]);
  const [ifaceEditing,  setIfaceEditing]  = useState<HudButton | null | 'new'>(null);
  const [btnDraft, setBtnDraft] = useState<Omit<HudButton,'id'>>({
    label: '', icon: '🎮', anchor: 'bottom-right',
    action: 'panel', panelTitle: '', panelBody: '', eventName: '',
  });

  function saveHudButtons(btns: HudButton[]) {
    setHudButtons(btns);
    try { (Globals as any).editorSetHudButtons?.(JSON.stringify(btns)); } catch {}
  }

  function openAddHudBtn() {
    setBtnDraft({ label: '', icon: '🎮', anchor: 'bottom-right', action: 'panel', panelTitle: '', panelBody: '', eventName: '' });
    setIfaceEditing('new');
  }

  function openEditHudBtn(btn: HudButton) {
    setBtnDraft({ label: btn.label, icon: btn.icon, anchor: btn.anchor, action: btn.action, panelTitle: btn.panelTitle, panelBody: btn.panelBody, eventName: btn.eventName });
    setIfaceEditing(btn);
  }

  function commitHudBtn() {
    if (!btnDraft.label.trim()) return;
    let next: HudButton[];
    if (ifaceEditing === 'new') {
      next = [...hudButtons, { ...btnDraft, id: `btn_${Date.now()}` }];
    } else {
      next = hudButtons.map(b => b.id === (ifaceEditing as HudButton).id ? { ...btnDraft, id: b.id } : b);
    }
    saveHudButtons(next);
    setIfaceEditing(null);
  }

  function deleteHudBtn(id: string) {
    saveHudButtons(hudButtons.filter(b => b.id !== id));
  }

  function seedSceneSettings() {
    try {
      const raw = (Globals as any).editorGetSceneSettings?.();
      if (!raw) return;
      const s = JSON.parse(String(raw));
      setSkyPreset(String(s.sky ?? ''));
      setLightingPreset(String(s.lighting ?? ''));
      setGroundPreset(String(s.ground ?? ''));
      if (typeof s.speed === 'number') setPlayerSpeed(s.speed);
      if (typeof s.jump  === 'number') setPlayerJump(s.jump);
      if (Array.isArray(s.hudButtons)) setHudButtons(s.hudButtons);
    } catch {}
  }
  function styleBridge(name: string, arg: unknown) {
    try { (Globals as any)[name]?.(arg); } catch {}
  }

  // Terrain-builder mode — when true the top bar swaps from
  // Play / AI / Terrain Builder / Publish / Leave to a terrain-tools row
  // (Raise / Lower / Flatten / Smooth / Paint + Exit). Exit returns to false.
  const [terrainMode, setTerrainMode] = useState(false);
  const [terrainTool, setTerrainTool] = useState<'raise' | 'lower' | 'flatten' | 'smooth' | null>(null);
  const terrainBrushing = useRef(false);
  const lastBrushMs     = useRef(0);
  // Hold-fire timer — set on pointer down, cleared on pointer up. A quick tap
  // (up before 150 ms) cancels the first scheduled fire so terrain only edits
  // on hold-or-drag.
  const holdFireTimer   = useRef<any>(null);

  function enterTerrainMode() {
    setToolsMenu('none');
    setTerrainMode(true);
    setTerrainTool(null);
    // Gate the editor camera FIRST so the brush overlay gets exclusive
    // single-finger touch from the moment terrain mode is entered.
    try { (Globals as any).setTerrainModeActive?.(true); } catch {}
    try { (Globals as any).showTerrainBuilder?.(true); } catch {}
    try { (Globals as any).setTerrainTool?.(''); } catch {}
  }
  function exitTerrainMode() {
    setTerrainTool(null);
    setTerrainMode(false);
    try { (Globals as any).setTerrainTool?.(''); } catch {}
    try { (Globals as any).showTerrainBuilder?.(false); } catch {}
    try { (Globals as any).setTerrainModeActive?.(false); } catch {}
  }
  // Throttled brush fire — applyTerrainBrush rebuilds the mesh + collider, so
  // ~50 ms between strokes keeps stroke density visible without thrashing.
  function fireBrush() {
    const now = Date.now();
    if (now - lastBrushMs.current < 50) return;
    lastBrushMs.current = now;
    try {
      (Globals as any).applyTerrainBrush?.(
        editorPointerX(),
        editorPointerY(),
        4.0,   // radius (m)
        0.6,   // strength
      );
    } catch {}
  }
  // Hold-and-drag gating: pointer-down arms a timer that first fires after
  // 150 ms and then loops every 80 ms. A drag fires earlier through
  // onPointerMove. A pure tap (release before 150 ms) cancels the timer in
  // stopHoldFire and never triggers the brush.
  function startHoldFire() {
    if (holdFireTimer.current) clearTimeout(holdFireTimer.current);
    const tick = () => {
      if (!terrainBrushing.current) return;
      fireBrush();
      holdFireTimer.current = setTimeout(tick, 80);
    };
    holdFireTimer.current = setTimeout(tick, 150);
  }
  function stopHoldFire() {
    if (holdFireTimer.current) {
      clearTimeout(holdFireTimer.current);
      holdFireTimer.current = null;
    }
  }

  // ── Session-based undo/redo ────────────────────────────────────────────────
  // One unified, in-memory history of the WHOLE editor — Lua script + the full
  // EditorState snapshot (object transforms/settings/logic, placed assets,
  // deletions, terrain) — captured per settled edit on the same debounce as
  // autosave. Lives only for this editing session (a ref, never persisted): the
  // canonical draft is forge_games.editor_state_json, the stack is just for
  // undo/redo while the editor is open. Each entry pairs the script with the
  // editor-state JSON so reverting across an AI script edit reloads the script,
  // while a plain object tweak reverts in-place via editorApplyStateExact.
  type EditEntry = { script: string; editorState: string };
  const editHistory   = useRef<EditEntry[]>([]);
  const historyIdx    = useRef<number>(-1);
  // Bumped on every push/undo/redo so canUndo/canRedo (derived from the refs)
  // recompute — refs alone don't trigger a re-render.
  const [historyVersion, setHistoryVersion] = useState(0);
  // True while applyHistoryEntry is reverting, so the autosave poll doesn't
  // record the revert itself as a fresh edit (which would corrupt the stack).
  const isApplyingHistoryRef = useRef(false);
  // Pending timers (staggered re-apply passes + the release) from the CURRENT
  // undo/redo. Cleared at the start of the next undo/redo so a rapid undo→redo
  // can't let the prior operation's late passes re-apply a stale state and snap
  // the object back ("glitch").
  const historyApplyTimersRef = useRef<any[]>([]);
  // Most recent Lua script for the active game, used as the script field for
  // edit entries that don't change the script (object tweaks, placement, …).
  const baselineScriptRef = useRef<string>('');
  // The saved editor-state draft the session opened with — the exact snapshot the
  // scene is restored FROM. It's complete (a full prior Capture), pre-edit, and
  // deterministic, which makes it the correct undo FLOOR: reverting to it
  // reproduces the session's starting scene without destroying any asset. Fetched
  // best-effort (~300 ms after mount); '' until then / for a brand-new game.
  const savedFloorRef     = useRef<string>('');
  // Guards one-time history seeding once the game's code is available.
  const historySeededRef  = useRef(false);
  const HISTORY_CAP = 100;

  function pushHistoryState(editorState: string, script?: string) {
    const scr = script ?? editHistory.current[historyIdx.current]?.script ?? baselineScriptRef.current;
    // Drop any redo branch, then append the new snapshot.
    editHistory.current = editHistory.current.slice(0, historyIdx.current + 1);
    editHistory.current.push({ script: scr, editorState: editorState || '{}' });
    if (editHistory.current.length > HISTORY_CAP) editHistory.current.shift();
    historyIdx.current = editHistory.current.length - 1;
    setHistoryVersion(v => v + 1);
    try { console.log(`[UNDODIAG] pushHistoryState → idx=${historyIdx.current} len=${editHistory.current.length}`); } catch {}
  }

  const animRef         = useRef<any>(null);
  const sheetHRef       = useRef(SHEET_COLLAPSED);
  const lastDragY       = useRef(0);
  const hasDragged      = useRef(false);
  const scriptLoadedRef = useRef(false);
  const lastAssetsDone  = useRef(-1);
  const lastTapRef      = useRef(0);
  const playLaunchedRef = useRef(false);
  // Asset tile the user pressed down on — read by the pointer-up handler so
  // we know which model to spawn when the gesture lifts. Plain ref (not state)
  // because the handlers run within the same gesture and we don't need a
  // re-render.
  const armedAssetRef   = useRef<AssetItem | null>(null);
  // Screen-pixel position (Unity space) where the current strip press started.
  // handleEditorRelease compares it to the release point to tell a TAP (drop
  // in front of the camera) from a DRAG (place at the release point).
  const armDownPosRef   = useRef<{ x: number; y: number } | null>(null);
  // Mirror of armedAssetRef as state so the trash icon can render while the
  // user drags a strip tile across the viewport. We render the same trash UI
  // used for placed-object drags so the user sees a consistent "release here
  // to cancel" affordance. Set on pointerDown, cleared on pointerUp/Cancel.
  const [armedDragging, setArmedDragging] = useState(false);
  // Drive C# SheetDragging off the React state instead of inline in the tile
  // event handlers. Tile onPointerUp is unreliable here — the user releases
  // over the 3D viewport (outside the tile bounds), so ReactUnity routes the
  // up event to the viewport, NOT the tile, and the inline setter never
  // fires. A useEffect ensures setEditorSheetDragging stays in lockstep with
  // armedDragging regardless of which element actually receives the release.
  useEffect(() => {
    try { (Globals as any).setEditorSheetDragging?.(armedDragging ? 'true' : 'false'); } catch {}
  }, [armedDragging]);

  // Swipe-and-hold for the selection-overlay handles. The user presses a handle
  // and then DRAGS: the pointer's displacement from the press point sets a
  // continuous VELOCITY for that handle's action, and the swipe DIRECTION sets
  // the sign — swipe one way to grow/lift/spin forward, the other way to
  // reverse. Each handle reads one axis of the swipe:
  //   'rotYaw'   — rotate left/right  (world-up)      ← horizontal swipe
  //   'rotPitch' — rotate up/down     (camera-right)  ↕ vertical swipe
  //   'moveVert' — move up/down       (world-Y)       ↕ vertical swipe
  //   'scale'    — make small/big                     ↕ vertical swipe (up=big)
  // Swipe further to go faster, hold the finger still inside the dead-zone to
  // pause, release to end. Holding without moving does nothing — there's no
  // auto-repeat. We poll Unity's raw pointer each tick (works the same on touch
  // + mouse and keeps tracking after the finger leaves the 36 px handle, which a
  // one-finger swipe does immediately) and drive the matching bridge with a
  // per-tick delta. isPointerDown owns the release — onPointerLeave/Up can't,
  // since the finger is already off the handle. The editor camera is locked
  // (setEditorSheetDragging) for the duration so the same drag manipulates the
  // model instead of panning the view or clearing the selection. Cleaned up on
  // unmount so a stuck timer can't keep firing.
  type ManipKind = 'rotYaw' | 'rotPitch' | 'moveVert' | 'scale';
  const manipIntervalRef = useRef<any>(null);
  const manipOriginRef   = useRef<{ x: number; y: number } | null>(null);
  const manipKindRef     = useRef<ManipKind>('rotYaw');
  function stopManipulating() {
    if (manipIntervalRef.current) {
      clearInterval(manipIntervalRef.current);
      manipIntervalRef.current = null;
    }
    manipOriginRef.current = null;
    try { (Globals as any).setEditorSheetDragging?.('false'); } catch {}
  }
  function startManipulating(kind: ManipKind) {
    stopManipulating();
    manipKindRef.current   = kind;
    // Seed with the press position; updated each tick so `manipOriginRef`
    // always holds the PREVIOUS tick's pointer position — delta = current - last.
    manipOriginRef.current = { x: editorPointerX(), y: editorPointerY() };
    try { (Globals as any).setEditorSheetDragging?.('true'); } catch {}
    const TICK_MS   = 33;   // ~30 Hz
    const NOISE_PX  = 0.4;  // sub-pixel noise floor — ignore tiny jitter
    // Per-pixel sensitivity in Unity screen-pixel space.  Values are tuned for
    // a 844-pt-tall reference screen; divide by the pixel-to-reference ratio so
    // fast-move screens feel equally responsive.
    const pxScale   = (editorScreenH() || 844) / 844;
    const ROT_PX    = 0.45 / pxScale;  // degrees per px (rotate)
    const MOV_PX    = 0.015 / pxScale; // world-units per px (move up/down)
    const SCL_PX    = 0.006 / pxScale; // additive scale per px (scale)
    const tick = () => {
      // Finger lifted anywhere on screen → stop. Event-routing-independent.
      let down = true;
      try { down = String((Globals as any).isPointerDown?.() ?? 'true') === 'true'; } catch {}
      const last = manipOriginRef.current;
      if (!down || !last) { stopManipulating(); return; }
      const k  = manipKindRef.current;
      const cx = editorPointerX();
      const cy = editorPointerY();
      // Per-tick delta: how far the finger actually moved since the last frame.
      // Total accumulated delta equals total finger travel — the object tracks
      // the finger 1:1 rather than ramping up a velocity.
      const dx = cx - last.x;
      const dy = cy - last.y;
      manipOriginRef.current = { x: cx, y: cy };
      // Yaw reads horizontal; everything else reads vertical.
      // Unity pointer origin is bottom-left so +Y is upward on screen.
      const delta = k === 'rotYaw' ? dx : dy;
      if (Math.abs(delta) < NOISE_PX) return;
      try {
        switch (k) {
          case 'rotYaw':
            // Negate: drag left (negative dx) → rotate left.
            (Globals as any).editorRotateSelectedAxis?.('yaw', -dx * ROT_PX);
            break;
          case 'rotPitch':
            (Globals as any).editorRotateSelectedAxis?.('pitch', dy * ROT_PX);
            break;
          case 'moveVert':
            (Globals as any).editorMoveSelectedVertical?.(dy * MOV_PX);
            break;
          case 'scale':
            // factor > 1 = grow (drag up / positive dy), < 1 = shrink.
            (Globals as any).editorScaleSelected?.(1 + dy * SCL_PX);
            break;
        }
      } catch {}
    };
    manipIntervalRef.current = setInterval(tick, TICK_MS);
  }
  useEffect(() => () => stopManipulating(), []);

  // ── Editor state autosave + restore ───────────────────────────────────────
  // Every mutation routed through EditorCameraController.MarkStateDirty bumps
  // C# Globals._editorStateRev. We poll it on a 250 ms cadence; once it
  // changes we arm a 1.5 s debounce timer that calls editorCaptureState() and
  // PATCHes /api/game/:id/editor-state. The PATCHed row IS the canonical
  // unpublished draft — no version history, no manual Save button. On editor
  // open (non-initial-build) we fetch the persisted editor_state_json and
  // reapply it with a small retries window so async Meshy asset swaps still
  // get their tweaks.
  // rev value of the last state we CONFIRMED to Supabase (or the baseline set at
  // load/restore/undo settle points). The poll treats anything past this as
  // unsaved work. Advanced only on a confirmed write so a failed save stays
  // dirty and is retried rather than silently lost.
  const lastSavedRevRef       = useRef(-1);
  // rev observed on the previous poll tick — used to debounce (re-arm only while
  // edits keep coming) and to detect a stuck-dirty state that needs a retry.
  const lastSeenRevRef        = useRef(-1);
  // Camera-pose rev (Globals._editorCameraRev). Tracked separately from the edit
  // rev so a pan/orbit/zoom triggers a debounced save (re-capturing the camera
  // pose so reopen frames the scene where the user left it) WITHOUT pushing an
  // undo-stack entry — the camera is deliberately excluded from undo.
  const lastSavedCamRevRef    = useRef(-1);
  const lastSeenCamRevRef     = useRef(-1);
  // rev of the last edit pushed onto the undo stack, so persist retries of the
  // same edit don't pile up duplicate history entries.
  const lastPushedRevRef      = useRef(-1);
  // An edit captured before the undo stack finished seeding. The seed effect
  // back-fills it as the first post-baseline entry so no edit escapes undo.
  const pendingHistoryRef     = useRef<string>('');
  const saveDebounceRef       = useRef<any>(null);
  const editorStateAppliedRef = useRef(false);
  // Gates the autosave poll so it can't persist a capture taken mid-load. On
  // reopen the game reload bumps _editorStateRev (terrain baseline, asset
  // placement) while objects are still spawning AND while the saved state is
  // being reapplied at +1.2/3/6 s. Without this gate the poll captures that
  // half-assembled scene at ~1.5 s and PATCHes it over the good saved draft —
  // so the NEXT reopen restores a degraded state ("edits gone on reopen"). Held
  // false until the restore window closes (or, on a fresh build, briefly).
  const restoreSettledRef     = useRef(false);
  // Holds the most recent in-flight payload so the unmount path can do a
  // synchronous keepalive flush even if the debounce timer hasn't fired yet.
  const pendingStateRef       = useRef<string>('');

  function captureEditorStateJson(): string {
    try { return (Globals as any).editorCaptureState?.() ?? ''; } catch { return ''; }
  }

  // Returns true ONLY on a confirmed write. A non-OK response (e.g. 403 from an
  // expired auth token or an RLS ownership mismatch — both of which the server
  // returns instead of throwing) yields false so the caller keeps the state
  // dirty and the poll retries it, instead of silently dropping the edit.
  async function persistEditorStateJson(json: string): Promise<boolean> {
    if (!gameData?.id || !json || json === '{}') return false;
    let parsed: any;
    try { parsed = JSON.parse(json); } catch { return false; }
    try {
      const res = await fetch(`${baseUrl()}/api/game/${gameData.id}/editor-state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editorState: parsed, userAccessToken: getGlobal('getAccessToken') }),
      });
      return !!res && res.ok;
    } catch { return false; }
  }

  useEffect(() => {
    if (!gameData?.id) return;

    // Persist the current scene as the canonical draft. (Undo-stack pushes are
    // handled by the dedicated, gate-independent undo tracker below — NOT here —
    // so an edit is recorded for undo the moment it happens, even while autosave
    // is still gated behind restore.) The saved baseline (lastSavedRevRef) only
    // advances on a CONFIRMED write, so an offline / auth-expired save leaves the
    // state dirty and the poll retries.
    const saveNow = async () => {
      saveDebounceRef.current = null;
      if (isApplyingHistoryRef.current || !restoreSettledRef.current) return;
      const rev    = Number((Globals as any)._editorStateRev ?? 0);
      const camRev = Number((Globals as any)._editorCameraRev ?? 0);
      const json = captureEditorStateJson();
      // Renderer not ready / empty capture — leave it dirty; the poll re-arms.
      if (!json || json === '{}') return;
      if (await persistEditorStateJson(json)) {
        lastSavedRevRef.current    = rev;
        lastSeenRevRef.current     = rev;
        lastSavedCamRevRef.current = camRev;
        lastSeenCamRevRef.current  = camRev;
      }
    };

    const poll = setInterval(() => {
      try {
        const rev    = Number((Globals as any)._editorStateRev ?? 0);
        const camRev = Number((Globals as any)._editorCameraRev ?? 0);
        // While the game is loading / the saved state is being reapplied, or an
        // undo/redo revert is in flight, the scene is being assembled by the
        // engine — not the user. Don't save here. CRUCIALLY, do NOT re-baseline
        // the EDIT rev (_editorStateRev): restore/script/undo-apply never bump it
        // (only genuine user edits do), so folding it into the baseline every tick
        // is what silently swallowed an edit made WHILE the restore window was
        // still open — the "second edit session doesn't save" bug. The edit rev is
        // pinned once at mount (gate effect) and by the undo release; leaving it
        // alone here means an edit made during restore is still detected and saved
        // the instant the gate opens. The CAMERA rev does move during restore
        // (ApplyView), so it stays baselined so the restored pose isn't re-saved.
        if (!restoreSettledRef.current || isApplyingHistoryRef.current) {
          lastSeenCamRevRef.current  = camRev;
          lastSavedCamRevRef.current = camRev;
          return;
        }
        // Dirty if EITHER an edit or the camera pose changed since the last save.
        if (rev === lastSavedRevRef.current && camRev === lastSavedCamRevRef.current) return;
        // Cache the current capture immediately so a sudden unmount can ship it
        // even if the debounce timer never fires.
        pendingStateRef.current = captureEditorStateJson();
        if (rev !== lastSeenRevRef.current || camRev !== lastSeenCamRevRef.current) {
          // Changes still arriving — (re)arm the debounce so we save once quiet.
          lastSeenRevRef.current    = rev;
          lastSeenCamRevRef.current = camRev;
          if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
          saveDebounceRef.current = setTimeout(saveNow, 1500);
        } else if (!saveDebounceRef.current) {
          // Dirty and stable but no save scheduled (a prior save failed) — retry.
          saveDebounceRef.current = setTimeout(saveNow, 1500);
        }
      } catch { /* renderer not ready */ }
    }, 250);
    return () => {
      clearInterval(poll);
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
      // Final-flush on unmount / leave / disconnect. fetch + keepalive lets the
      // request survive the scene transition that's about to nuke this React
      // tree. Skip while a revert is mid-flight, or while the game is still
      // loading (gate shut) — flushing a half-assembled scene would clobber the
      // good draft.
      if (isApplyingHistoryRef.current || !restoreSettledRef.current || !gameData?.id) return;
      // Capture FRESH here rather than trusting pendingStateRef: a last edit made
      // <1.5 s before leaving (e.g. a terrain stroke) fired its rev bump but its
      // debounced save never ran, and pendingStateRef lags the 250 ms poll — a
      // fresh capture guarantees the very last change reaches Supabase. Fall back
      // to the cached payload if capture fails during teardown.
      let json = '';
      try { json = captureEditorStateJson(); } catch {}
      if (!json || json === '{}') json = pendingStateRef.current;
      if (!json) return;
      let parsed: any;
      try { parsed = JSON.parse(json); } catch { return; }
      try {
        fetch(`${baseUrl()}/api/game/${gameData.id}/editor-state`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ editorState: parsed, userAccessToken: getGlobal('getAccessToken') }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* ignore — browser may not support keepalive */ }
    };
  }, [gameData?.id]);

  // NOTE: React no longer re-applies the saved editor_state_json on reopen.
  // Unity's loadGameForEdit restore (LuauGameRunner.ReapplyEditorStateLater)
  // is authoritative — it reconciles the saved snapshot until every placed
  // asset is present (verified: all assets back within ~2 s) and then STOPS,
  // and it bails out the instant the user makes an edit so it can't revert it.
  // The old React-side staggered editorApplyState passes ([1.2/3/6 s]) were a
  // redundant second restore that re-wrote the saved transform onto an object
  // the user had just moved/rotated/scaled — the autosave poll then captured
  // and persisted that reverted value. That asymmetry (a freshly *added* object
  // isn't in the snapshot so it survived, but an *edit* to an existing object
  // got reverted) was exactly the "add saves but edits don't" bug. Removing the
  // React reapply leaves Unity as the single restore authority and lets edits
  // made any time after load persist. `editorStateAppliedRef` is retained only
  // to avoid touching unrelated call sites.
  void editorStateAppliedRef;

  // ── Undo/redo is strictly per editing SESSION ──────────────────────────────
  // Entering the editor must start with an EMPTY, dimmed undo/redo stack that can
  // only revert edits made in THIS session — never carry entries (or a still-lit
  // button) over from a previous time the user had this (or another) game open.
  // EditorScreen normally remounts per session, so its refs are already fresh,
  // but we reset explicitly (keyed on the session's game id) so the guarantee
  // holds even on any path that reuses the instance. Runs before the seed/gate
  // effects below, so they re-seed a clean floor afterwards.
  useEffect(() => {
    editHistory.current       = [];
    historyIdx.current        = -1;
    historySeededRef.current  = false;
    pendingHistoryRef.current = '';
    baselineScriptRef.current = '';
    lastPushedRevRef.current  = -1;
    isApplyingHistoryRef.current = false;
    for (const tid of historyApplyTimersRef.current) clearTimeout(tid);
    historyApplyTimersRef.current = [];
    setHistoryVersion(v => v + 1); // recompute canUndo/canRedo → dimmed
    try { console.log(`[UNDODIAG] SESSION RESET (game=${game.id}) — undo/redo cleared & dimmed`); } catch {}
  }, [game.id]);

  // Open the autosave gate once the load/restore window has actually closed.
  // Unity raises `_editorRestoreComplete` when its editor-state restore has
  // settled (all placed assets respawned, or the safety cap elapsed) and the
  // staggered reapply passes are done — so it's safe to capture without
  // clobbering the draft, and any rev bump from here on is a genuine user edit.
  // We poll for that signal instead of waiting a blind fixed delay: with
  // disk-cached assets the editor is interactive in ~1-2 s, and the old fixed
  // 6.8 s gate meant every edit made in that gap was silently folded into the
  // baseline (never autosaved, never pushed onto the undo stack) — the root of
  // "autosave only works sometimes" and "undo/redo do nothing". A hard fallback
  // still opens the gate if the signal is ever missed, so it can never hang.
  useEffect(() => {
    if (!gameData?.id) return;
    restoreSettledRef.current = false;
    // Pin the EDIT-rev baseline ONCE, now, before the scene is restored. Restore
    // never bumps _editorStateRev, so this stays valid through the whole restore;
    // any bump above it — even an edit made while restore is still running — is a
    // genuine edit that must be saved (NOT folded into the baseline). This is what
    // makes edits in a second editing session persist.
    try {
      const rev = Number((Globals as any)._editorStateRev ?? 0);
      lastSavedRevRef.current = rev;
      lastSeenRevRef.current  = rev;
    } catch {}
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      // Absorb only the CAMERA changes the restore itself made (ApplyView), so the
      // restored pose isn't needlessly re-saved. Deliberately do NOT touch the edit
      // rev here — re-pinning it would re-introduce the fold that drops an edit made
      // during the restore window.
      try {
        const camRev = Number((Globals as any)._editorCameraRev ?? 0);
        lastSavedCamRevRef.current = camRev;
        lastSeenCamRevRef.current  = camRev;
      } catch {}
      // NB: this gate governs AUTOSAVE-PERSIST timing only. The undo FLOOR and
      // pushes are owned by the dedicated, gate-independent undo tracker below —
      // so undo records edits from the moment the scene is ready, without waiting
      // for this gate (which can be as late as the 8 s fallback for Meshy-heavy
      // games whose restore-complete signal lags).
      restoreSettledRef.current = true;
      try { console.log(`[UNDODIAG] GATE OPEN (autosave-persist)`); } catch {}
    };
    const poll = setInterval(() => {
      let sig = '';
      try { sig = String((Globals as any)._editorRestoreComplete ?? ''); } catch {}
      if (sig === 'true') { clearInterval(poll); open(); }
    }, 150);
    // Fallback: open anyway after a generous ceiling if the signal never arrives
    // (e.g. an older Unity build without it, or a restore that stalls).
    const fallback = setTimeout(() => { try { console.log('[UNDODIAG] GATE OPEN (autosave) via FALLBACK timer'); } catch {} clearInterval(poll); open(); }, isInitialBuild ? 2500 : 8000);
    return () => { clearInterval(poll); clearTimeout(fallback); };
  }, [gameData?.id, isInitialBuild]);

  // Best-effort fetch of the game's saved draft + Lua script. Populates:
  //   • savedFloorRef  — the undo FLOOR (the snapshot the scene is restored from).
  //   • baselineScriptRef — the script, ONLY needed so an undo that crosses an AI
  //     script edit reloads the right Lua (object/transform/terrain/placement
  //     reverts run in-place via editorApplyStateExact and don't need it).
  // Neither gates anything: if the fetch is slow/fails/returns no code, the undo
  // tracker falls back to a settled live capture for the floor and undo still
  // works for everything but the rare cross-script-edit case.
  useEffect(() => {
    if (!gameData?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet<{ gameCode?: string; editorStateJson?: string }>(`/api/game/${gameData.id}`);
        if (cancelled) return;
        const saved = (r as any)?.editorStateJson || '';
        if (saved && saved !== '{}') savedFloorRef.current = saved;
        const code = (r as any)?.gameCode || '';
        if (!code) return; // still generating / no script — undo still works
        baselineScriptRef.current = code;
        // Upgrade the seeded baseline entry's (still-empty) script so a later
        // cross-AI-edit revert reloads the correct Lua. Never touches idx/stack.
        const floor = editHistory.current[0];
        if (floor && !floor.script) floor.script = code;
      } catch { /* leave empty — non-script undo unaffected */ }
    })();
    return () => { cancelled = true; };
  }, [gameData?.id, gameData?.hasCode]);

  // ── Undo/redo stack tracker — INDEPENDENT of the autosave gate ─────────────
  // The undo stack must record edits from the moment the scene is ready, NOT wait
  // for the autosave gate (which opens only once every placed asset has respawned
  // — up to ~20 s for Meshy-heavy games, or the 8 s fallback). Tying undo to that
  // gate meant edits in the first several seconds were folded into the floor and
  // weren't undoable — the core "I move something then undo and nothing happens"
  // bug. This effect owns the stack end-to-end:
  //   1. FLOOR — seed once from the saved draft the scene was restored from
  //      (complete, pre-edit, deterministic; arrives ~300 ms via the fetch). For a
  //      brand-new game with no draft, fall back to a settled live capture.
  //   2. PUSH — once seeded, watch the EDIT rev (NOT the camera rev, so camera
  //      moves never create entries). When it advances past the last pushed rev
  //      and then goes quiet (~600 ms debounce — coalesces a continuous gesture
  //      like a terrain stroke or swipe-rotate into ONE entry), capture and push.
  // Reverts (isApplyingHistoryRef) never record. Buttons stay dimmed (idx 0) until
  // the first genuine edit, because lastPushedRev is pinned to the floor's rev.
  useEffect(() => {
    if (!gameData?.id) return;
    const t0 = Date.now();
    let pushDebounce: any = null;
    let lastChangeRev = -1;
    const readRev = () => { try { return Number((Globals as any)._editorStateRev ?? 0); } catch { return 0; } };
    // The edit-rev at mount = the floor's zero-edit rev. Restore (asset respawn,
    // EditorState.Apply) never bumps the edit-rev, so this stays valid through the
    // whole load. Baselining lastPushedRev to THIS (not the live rev at seed time)
    // means even an edit made in the ~300 ms before the saved draft arrives still
    // pushes as the first undo entry instead of folding into the floor.
    const mountRev = readRev();
    const hasObjects = (cap: string) =>
      !!cap && cap !== '{}' && cap.indexOf('"objects"') !== -1 && !/"objects"\s*:\s*\[\s*\]/.test(cap);
    const seedFloor = (state: string, why: string) => {
      if (historySeededRef.current) return;
      editHistory.current = [{ script: baselineScriptRef.current || '', editorState: state || '{}' }];
      historyIdx.current  = 0;
      historySeededRef.current = true;
      lastPushedRevRef.current = mountRev; // first real edit pushes; camera/restore don't
      setHistoryVersion(v => v + 1);
      try { console.log(`[UNDODIAG] FLOOR seeded (${why}) len=${(state || '{}').length} lastPushed=${lastPushedRevRef.current}`); } catch {}
    };
    const tick = setInterval(() => {
      try {
        if (!historySeededRef.current) {
          // Prefer the saved draft (complete + pre-edit). Falls back to a settled
          // live capture for a new game, with a hard ceiling so undo always works.
          const waited = Date.now() - t0;
          if (savedFloorRef.current) seedFloor(savedFloorRef.current, 'saved-draft');
          else {
            const cap = captureEditorStateJson();
            if (waited > 2500 && hasObjects(cap)) seedFloor(cap, 'live-capture');
            else if (waited > 6000)               seedFloor(cap || '{}', 'ceiling');
          }
          return;
        }
        if (isApplyingHistoryRef.current) { lastChangeRev = -1; return; }
        const rev = readRev();
        if (rev === lastPushedRevRef.current) return; // nothing new since last push
        if (rev !== lastChangeRev) {
          // edit-rev still advancing — (re)arm the debounce so a continuous gesture
          // coalesces into a single undo entry.
          lastChangeRev = rev;
          if (pushDebounce) clearTimeout(pushDebounce);
          pushDebounce = setTimeout(() => {
            if (isApplyingHistoryRef.current) return;
            const r = readRev();
            if (r === lastPushedRevRef.current) return;
            const json = captureEditorStateJson();
            if (!json || json === '{}') return;
            lastPushedRevRef.current = r;
            pushHistoryState(json);
          }, 600);
        }
      } catch { /* renderer not ready */ }
    }, 200);
    return () => { clearInterval(tick); if (pushDebounce) clearTimeout(pushDebounce); };
  }, [gameData?.id]);

  // ── Enter edit mode ───────────────────────────────────────────────────────

  useEffect(() => {
    // Safety net: ensure the screen is in landscape before anything renders.
    // openGame/forge already call this synchronously before mounting the
    // editor, but new entry points (e.g. DoneScreen → setPhase('editing'))
    // bypass them. The orientation manager is idempotent so this is a no-op
    // when already rotating/landscape.
    try { (Globals as any).enterEditorOrientation?.(); } catch {}

    onEditingChange?.(true);
    if (isInitialBuild) {
      try { (Globals as any).startBuildPreview?.(); } catch {}
    } else {
      try { (Globals as any).loadGameForEdit?.(game.id); } catch {}
    }
    return () => {
      // Don't exit or clear editing state when play launched this unmount —
      // the running game would be killed before Unity sets _gameActive=true.
      if (!playLaunchedRef.current) {
        onEditingChange?.(false);
        try { (Globals as any).exitGame?.(); } catch {}
      } else {
        // Play launched: App is about to replace the whole tree with the
        // GameHUD, unmounting CreateScreen. Stash the open game so CreateScreen
        // re-enters the editor — not the game list — when the player leaves.
        _resumeEditSession = gameDataRef.current;
      }
      // Reset editor camera mode & select when leaving
      try { (Globals as any).setEditorSelectMode?.('false'); } catch {}
    };
  }, []);

  // ── Poll keyboard height — keeps input bar above the soft keyboard ────────

  useEffect(() => {
    const t = setInterval(() => {
      try {
        const kh = (Globals as any).getKeyboardHeight?.() ?? 0;
        setKeyboardH(typeof kh === 'number' ? Math.round(kh) : 0);
      } catch {}
    }, 150);
    return () => clearInterval(t);
  }, []);

  // ── Force a single re-render after the landscape rotation commits ────────
  // The editor mounts BEFORE the rotation visually commits, so on first
  // render IsLandscape() in GameLauncher.cs reads portrait dims and returns
  // portrait insets. The fade + rotate + settle takes ~700 ms; one timed
  // bump after that picks up the landscape insets. Single setTimeout — no
  // polling loop, no continuous re-renders.
  useEffect(() => {
    const t = setTimeout(() => setSafeAreaVersion(v => v + 1), 900);
    return () => clearTimeout(t);
  }, []);

  // ── Poll Unity _selectedObject global ────────────────────────────────────

  useEffect(() => {
    if (!selectMode) return;
    const t = setInterval(() => {
      try {
        const val = String((Globals as any)._selectedObject ?? '');
        setSelectedObj(val);
      } catch {}
    }, 150);
    return () => clearInterval(t);
  }, [selectMode]);

  // ── Keep Unity in select mode ────────────────────────────────────────────
  // Select mode is always on now (no toggle button). Assert it to Unity until
  // SelectActive is live — this covers the mount window where
  // EditorCameraController.Instance isn't ready yet, and re-arms it if any
  // legacy path ever turns it off. Deselecting an object goes through
  // editorClearSelection (which keeps the mode on), so this never fights a
  // deselect. Modal dismissal on a Unity-side selection clear is handled by the
  // selectedObj→closeModal effect above, not here.
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const v = String((Globals as any)._editorSelectMode ?? '');
        if (v !== 'true') { try { (Globals as any).setEditorSelectMode?.('true'); } catch {} }
      } catch {}
    }, 200);
    return () => clearInterval(t);
  }, []);

  // ── Poll Unity _editorDraggingObject — true while the user is moving a
  // previously-selected object. Drives the asset-strip → trash-icon swap.
  const [draggingObj, setDraggingObj] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const v = String((Globals as any)._editorDraggingObject ?? '') === 'true';
        setDraggingObj(prev => prev === v ? prev : v);
      } catch {}
    }, 100);
    return () => clearInterval(t);
  }, []);

  // ── Strip-drag release watchdog ───────────────────────────────────────────
  // The asset strip lives inside a ReactUnity <scroll>. When the user presses a
  // tile and drags toward the viewport, the ScrollRect hijacks the gesture and
  // ReactUnity fires onPointerCancel BEFORE the finger lifts — which used to
  // disarm the asset, so the release placed nothing. Rather than depend on
  // React's pointer events bubbling out of the scroll, poll Unity's raw pointer
  // state while a tile is armed and place the model the instant the pointer
  // lifts. Event-routing-independent, so it works regardless of what the scroll
  // does with the gesture. If isPointerDown isn't available it defaults to
  // "down" and we fall back to the root onPointerUp path below.
  useEffect(() => {
    if (!armedDragging) return;
    let done = false;
    let dragStarted = false;   // true once the finger crossed TAP_SLOP
    const TAP_SLOP = 50;       // Unity device pixels — mirrors C# IsOverTrash logic
    const t = setInterval(() => {
      if (done) return;
      let isDown = true;
      try { isDown = String((Globals as any).isPointerDown?.() ?? 'true') === 'true'; } catch {}

      if (!isDown) {
        done = true;
        if (dragStarted) {
          // C# move-selected path owns this gesture now — it already handled
          // placement/trash on release. Just clear React armed state.
          armDownPosRef.current = null;
          setArmedDragging(false);
        } else {
          // Finger lifted without crossing TAP_SLOP → treat as a tap.
          handleEditorRelease();
        }
      } else if (!dragStarted) {
        // Poll position to detect when the drag crosses TAP_SLOP.
        const downPos = armDownPosRef.current;
        if (downPos) {
          try {
            const px = editorPointerX(), py = editorPointerY();
            if (Math.hypot(px - downPos.x, py - downPos.y) >= TAP_SLOP) {
              dragStarted = true;
              const asset = armedAssetRef.current;
              // Null out immediately so the transparent-overlay onPointerUp
              // fires handleEditorRelease as a no-op if it races with us.
              armedAssetRef.current = null;
              if (asset) {
                try {
                  // Spawn the actual asset under the finger and enter move mode.
                  (Globals as any).editorBeginAssetDrag?.(
                    asset.cacheKey, asset.modelUrl, asset.isHumanoid, asset.sizeHint ?? 0, px, py);
                } catch {}
              }
            }
          } catch {}
        }
      }
    }, 33);
    return () => clearInterval(t);
  }, [armedDragging]);

  // ── Poll Unity _editorSelBoundsRef — screen-space bounding box of the
  // currently-selected GameObject, in React canvas reference units (top-left
  // origin). Format: "left,top,right,bottom". Empty when nothing selected or
  // the user is dragging the model (trash icon takes over). 33ms (~30fps)
  // keeps the overlay glued to the model while the user orbits the camera.
  const [selBounds, setSelBounds] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const raw = String((Globals as any)._editorSelBoundsRef ?? '').trim();
        if (!raw) { setSelBounds(prev => prev === null ? prev : null); return; }
        const parts = raw.split(',').map(Number);
        if (parts.length !== 4 || parts.some(n => !isFinite(n))) {
          setSelBounds(prev => prev === null ? prev : null);
          return;
        }
        const [left, top, right, bottom] = parts;
        setSelBounds(prev => {
          if (prev && prev.left === left && prev.top === top && prev.right === right && prev.bottom === bottom) return prev;
          return { left, top, right, bottom };
        });
      } catch {}
    }, 33);
    return () => clearInterval(t);
  }, []);

  // ── Poll Unity _editorError global (preview-mode script failures) ────────

  // While Claude is streaming partial Lua every 3 s, MoonSharp can briefly fail
  // to parse a chunk that was truncated mid-block. Unity already suppresses the
  // banner in that path, but we also gate it here so any in-flight error string
  // from before isBuilding flipped doesn't get latched into state.
  const isStreamingParseNoise = (msg: string) => {
    if (!msg) return false;
    return /Preview error|Script error|'end' expected|<eof>|unexpected symbol|unfinished|near '\)'|near '\['/i.test(msg);
  };

  useEffect(() => {
    const t = setInterval(() => {
      try {
        const val = String((Globals as any)._editorError ?? '');
        if (isBuilding && isStreamingParseNoise(val)) {
          // Drop noisy partial-parse errors during generation, and also wipe the
          // global so a stale value doesn't reappear after building finishes.
          if (val) { try { (Globals as any)._editorError = ''; } catch {} }
          if (previewError) setPreviewError('');
          return;
        }
        if (val !== previewError) setPreviewError(val);
      } catch {}
    }, 300);
    return () => clearInterval(t);
  }, [previewError, isBuilding]);

  // Clear any latched banner the moment a build starts so it doesn't stick
  // around behind the new "Building..." UI.
  useEffect(() => {
    if (isBuilding && previewError) {
      setPreviewError('');
      try { (Globals as any)._editorError = ''; } catch {}
    }
  }, [isBuilding]);

  // ── Build polling ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!buildJobId) return;

    const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — if still pending, something is wrong
    const buildStartedAt   = Date.now();

    let stepIdx = 1;
    const stepTimer = setInterval(() => {
      if (stepIdx < BUILD_STEPS.length) {
        setHistory(prev => [...prev, { role: 'assistant', content: BUILD_STEPS[stepIdx] }]);
        setBuildStep(stepIdx);
        stepIdx++;
      }
    }, 2200);

    let lastLuauLength = 0;
    const partialTimer = setInterval(async () => {
      try {
        const r = await apiGet<{ status: string; partialLuau?: string }>(
          `/api/forge-game/partial/${buildJobId}`
        );
        const luau = r.partialLuau ?? '';
        const newlineCount = (luau.match(/\n/g) ?? []).length;
        if (newlineCount >= 3 && luau.length > lastLuauLength + 80) {
          lastLuauLength = luau.length;
          try { (Globals as any).runPartialScript?.(luau); } catch {}
        }
        if (r.status !== 'pending') clearInterval(partialTimer);
      } catch {}
    }, 3000);

    const pollTimer = setInterval(async () => {
      try {
        const r = await apiGet<{
          status: string;
          game?: GameStub;
          error?: string;
          assetsTotal?: number;
          assetsDone?: number;
        }>(`/api/forge-game/status/${buildJobId}`);

        if ((r.status === 'script_ready' || r.status === 'done') && r.game) {
          if (!scriptLoadedRef.current) {
            scriptLoadedRef.current = true;
            clearInterval(stepTimer);
            clearInterval(partialTimer);
            setGameData(r.game);
            setIsBuilding(false);
            try { (Globals as any).loadGameForEdit?.(r.game.id); } catch {}
            // Undo/redo history is seeded by the dedicated effect once the
            // game's Lua code is fetchable (the status payload omits gameCode).
            if (r.status === 'script_ready') {
              const total = r.assetsTotal ?? 0;
              setHistory(prev => [...prev, {
                role: 'assistant',
                content: total > 0
                  ? `Game script ready! Generating ${total} 3D model${total === 1 ? '' : 's'} with Meshy AI — hang tight...`
                  : 'Game script ready! Setting up world...',
              }]);
            }
          }

          // Live asset counter during script_ready phase
          if (r.status === 'script_ready') {
            const done  = r.assetsDone  ?? 0;
            const total = r.assetsTotal ?? 0;
            if (total > 0) setAssetsProgress({ done, total });
            if (total > 0 && done !== lastAssetsDone.current) {
              lastAssetsDone.current = done;
              setHistory(prev => {
                const idx = [...prev].map(m => m.content).lastIndexOf(
                  prev.find(m => m.content.includes('3D model') || m.content.includes('Finalizing'))?.content ?? ''
                );
                if (idx < 0) return prev;
                const next = [...prev];
                next[idx] = { ...next[idx], content: `Building 3D models... ${done} / ${total} ready` };
                return next;
              });
            }
          }

          if (r.status === 'done') {
            clearInterval(pollTimer);
            setAssetsReady(true);
            setAssetsProgress({ done: 0, total: 0 });
            setShowPlayModal(false);
            const total = r.assetsTotal ?? 0;

            // Replace the progress message with a "materializing" beat before the reload
            setHistory(prev => {
              const marker = prev.slice().reverse().find(
                m => m.role === 'assistant' && (m.content.includes('3D model') || m.content.includes('Finalizing'))
              );
              if (!marker) return prev;
              const idx = prev.lastIndexOf(marker);
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                content: total > 0
                  ? `All ${total} model${total === 1 ? '' : 's'} ready — materializing world...`
                  : 'Models ready — materializing world...',
              };
              return next;
            });

            setTimeout(() => {
              onBuildComplete?.(r.game!);
              // Surface Claude's chat reply if it included one in the JSON output.
              // Falls back to the canned "ready" message for older games that
              // were forged before the `reply` field was added to the schema.
              const claudeReply = ((r.game as any)?.forgeReply as string | undefined)?.trim();
              const readyContent = claudeReply
                ? `"${stripDecorative(r.game!.title)}" is ready!\n\n${claudeReply}`
                : `"${stripDecorative(r.game!.title)}" is ready! Play it or describe changes.`;
              setHistory(prev => [...prev, {
                role: 'assistant',
                content: readyContent,
              }]);
              try { (Globals as any).loadGameForEdit?.(r.game!.id); } catch {}
            }, 1400);
          }
        } else if (r.status === 'error') {
          clearInterval(stepTimer); clearInterval(partialTimer); clearInterval(pollTimer);
          setIsBuilding(false);
          setHistory(prev => [...prev, { role: 'assistant', content: `Build failed: ${r.error ?? 'Try a different prompt.'}` }]);
        } else if (r.status === 'pending' && !scriptLoadedRef.current) {
          // Still pending — check if we've been waiting too long
          if (Date.now() - buildStartedAt > BUILD_TIMEOUT_MS) {
            clearInterval(stepTimer); clearInterval(partialTimer); clearInterval(pollTimer);
            setIsBuilding(false);
            setHistory(prev => [...prev, {
              role: 'assistant',
              content: 'Build timed out after 5 minutes. The AI service may be busy — please try again.',
            }]);
          }
        }
      } catch {}
    }, 2500);

    return () => { clearInterval(stepTimer); clearInterval(partialTimer); clearInterval(pollTimer); };
  }, [buildJobId]);

  useEffect(() => () => { if (animRef.current) clearInterval(animRef.current); }, []);

  // ── Sheet animation ────────────────────────────────────────────────────────

  function slideTo(target: number) {
    if (animRef.current) clearInterval(animRef.current);
    animRef.current = setInterval(() => {
      setSheetH(prev => {
        const next = prev + (target - prev) * SHEET_LERP;
        const done = Math.abs(target - next) < 1;
        const h    = done ? target : next;
        sheetHRef.current = h;
        if (done) { clearInterval(animRef.current); animRef.current = null; }
        return h;
      });
    }, 16);
  }

  function handlePointerDown(_e: any) {
    if (animRef.current) { clearInterval(animRef.current); animRef.current = null; }
    hasDragged.current = false;
    lastDragY.current  = editorPointerY();
    try { (Globals as any).setEditorSheetDragging?.('true'); } catch {}
  }

  function handleBeginDrag(_e: any) {
    hasDragged.current = true;
    lastDragY.current  = editorPointerY();
  }

  function handleDrag(_e: any) {
    hasDragged.current = true;
    const y    = editorPointerY();
    const dy   = y - lastDragY.current;
    lastDragY.current = y;
    const scale = editorScreenH() / 844;
    const dyRef = dy / (scale || 1);
    const newH  = Math.max(SHEET_COLLAPSED, Math.min(SHEET_FULL, sheetHRef.current + dyRef));
    sheetHRef.current = newH;
    setSheetH(newH);
  }

  function handlePointerUp(_e: any) {
    try { (Globals as any).setEditorSheetDragging?.('false'); } catch {}
    if (!hasDragged.current) {
      const cur  = sheetHRef.current;
      const next = cur <= SHEET_COLLAPSED + 10 ? SHEET_HALF : cur < SHEET_FULL - 10 ? SHEET_FULL : SHEET_COLLAPSED;
      slideTo(next);
      return;
    }
    hasDragged.current = false;
    const h = sheetHRef.current;
    if      (h > SNAP_TO_FULL) slideTo(SHEET_FULL);
    else if (h > SNAP_TO_HALF) slideTo(SHEET_HALF);
    else                       slideTo(SHEET_COLLAPSED);
  }

  // ── Asset polling ──────────────────────────────────────────────────────────

  async function pollAssets(jobId: string, gameId: number, deferredReply?: string) {
    const PENDING_MSG = 'Generating 3D models with Meshy.ai...';
    const replaceMsg = (next: string) =>
      setHistory(prev => {
        const idx = [...prev].map(m => m.content).lastIndexOf(PENDING_MSG);
        return idx < 0 ? prev : prev.map((m, i) => i === idx ? { ...m, content: next } : m);
      });
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const r = await apiGet<{ status: string; error?: string }>(`/api/edit-game/assets/${jobId}`);
        if (r.status === 'done') {
          setAssetsReady(true);
          if (deferredReply) {
            setHistory(prev => {
              const idx = [...prev].map(m => m.content).lastIndexOf(PENDING_MSG);
              const updated = [...prev];
              const readyMsg: ChatMsg = { role: 'assistant', content: '3D models ready! Reloading game world...' };
              const replyMsg: ChatMsg = { role: 'assistant', content: deferredReply };
              if (idx < 0) return [...updated, replyMsg, readyMsg];
              updated.splice(idx, 1, replyMsg, readyMsg);
              return updated;
            });
          } else {
            replaceMsg('3D models ready! Reloading game world...');
          }
          try { (Globals as any).loadGameForEdit?.(gameId); } catch {}
          return;
        }
        if (r.status === 'error') {
          replaceMsg(`3D model generation failed: ${r.error ?? 'unknown error'}`);
          return;
        }
      } catch {}
    }
    replaceMsg('3D model generation timed out.');
  }

  // ── Send AI message ────────────────────────────────────────────────────────

  async function sendMessage() {
    if (isBuilding) return;
    const rawMsg = input.trim();
    if (!rawMsg || sending) return;
    setInput('');

    // Inject selected object context into the message if in select mode
    let msg = rawMsg;
    if (selectMode && selectedObj) {
      const [objName, coords] = selectedObj.split('|');
      msg = `[Selected object: "${objName}" at position ${coords ?? 'unknown'}]\n${rawMsg}`;
    }

    const next: ChatMsg[] = [...history, { role: 'user', content: rawMsg }]; // show raw in chat
    setHistory(next);
    setSending(true);
    if (!chatOpen) { setActiveModal('chat'); setModalSize('default'); }

    try {
      const r = await apiPost<{ reply: string; luau_script: string; assetJobId?: string }>('/api/edit-game', {
        gameId:          gameData.id,
        userMessage:     msg,
        history:         history.slice(-10),
        userAccessToken: getGlobal('getAccessToken'),
      });

      // Record the AI script edit as one unified history entry (new script +
      // the current editor-state tweaks) so undo reverts the whole change.
      if (r.luau_script) {
        baselineScriptRef.current = r.luau_script;
        if (historySeededRef.current) pushHistoryState(captureEditorStateJson() || '{}', r.luau_script);
      }

      if (r.assetJobId) {
        setAssetsReady(false);
        setHistory([...next, { role: 'assistant', content: 'Generating 3D models with Meshy.ai...' }]);
        pollAssets(r.assetJobId, gameData.id, r.reply);
      } else {
        setHistory([...next, { role: 'assistant', content: r.reply }]);
      }
      setGameData(g => ({ ...g, hasCode: true }));
      try { (Globals as any).loadGameForEdit?.(gameData.id); } catch {}
    } catch {
      setHistory([...next, { role: 'assistant', content: 'Sorry, something went wrong. Try again.' }]);
    } finally {
      setSending(false);
    }
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  // Revert the editor to history entry `idx`. Two paths:
  //   • script changed (crossing an AI edit, or a deletion that needs a script
  //     object rehydrated) → PUT the script, reload the game (re-runs Lua), then
  //     reapply the saved editor state at the usual retry delays.
  //   • script unchanged → editorApplyStateExact reverts in-place (fast, no
  //     Meshy reload). It returns "reload" when it can't rehydrate a deleted
  //     script object in-place, in which case we fall back to the reload path.
  async function applyHistoryEntry(idx: number) {
    const entry = editHistory.current[idx];
    if (!entry || !gameData?.id) return;
    // Cancel the previous undo/redo's still-pending re-apply + release timers so
    // they can't fire late and overwrite THIS revert with a stale state — the
    // object snapping back and forth on a quick undo→redo. track() registers each
    // timer this invocation schedules so the NEXT invocation can clear them.
    for (const tid of historyApplyTimersRef.current) clearTimeout(tid);
    historyApplyTimersRef.current = [];
    const track = (tid: any) => { historyApplyTimersRef.current.push(tid); return tid; };
    const prev = editHistory.current[historyIdx.current];
    historyIdx.current = idx;
    setHistoryVersion(v => v + 1);
    isApplyingHistoryRef.current = true;
    // Drop any pending autosave/history capture so the revert isn't re-recorded.
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    pendingStateRef.current = '';

    let didReload = false;
    const reloadWith = (script: string) => {
      didReload = true;
      baselineScriptRef.current = script;
      try {
        fetch(`${baseUrl()}/api/game/${gameData.id}/script`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ luau_script: script, userAccessToken: getGlobal('getAccessToken') }),
        }).catch(() => {});
      } catch {}
      try { (Globals as any).loadGameForEdit?.(gameData.id); } catch {}
      // Reapply the editor state after the script re-creates its objects; the
      // C# applier is idempotent so the staggered passes are harmless.
      for (const d of [1200, 3000, 6000]) {
        track(setTimeout(() => { try { (Globals as any).editorApplyState?.(entry.editorState); } catch {} }, d));
      }
    };

    const runExact = (): string => {
      try { return String((Globals as any).editorApplyStateExact?.(entry.editorState) ?? 'ok'); }
      catch { return 'ok'; }
    };

    const scriptChanged = !prev || prev.script !== entry.script;
    try { console.log(`[UNDODIAG] applyHistoryEntry idx=${idx} scriptChanged=${scriptChanged} entryStateLen=${(entry.editorState||'').length} prevStateLen=${(prev?.editorState||'').length} sameState=${prev?.editorState === entry.editorState}`); } catch {}
    if (scriptChanged && entry.script) {
      reloadWith(entry.script);
    } else {
      const status = runExact();
      try { console.log(`[UNDODIAG] runExact → ${status}`); } catch {}
      if (status === 'reload') {
        reloadWith(entry.script || baselineScriptRef.current);
      } else {
        // Objects placed via Meshy assets respawn ASYNC, and a just-finished
        // reload may still be spawning script objects, so a single pass can miss
        // most of them ("N objects not present"). ApplyExact is idempotent —
        // re-run it a few times to catch objects as they appear, mirroring the
        // load-restore staggered reapply.
        for (const d of [400, 1200, 3000]) track(setTimeout(runExact, d));
      }
    }

    // Re-baseline the dirty rev so the poll treats the reverted scene as settled
    // and doesn't push it back onto the stack. Both paths keep mutating the scene
    // after this point (the reload re-runs Lua up to +6 s; the in-place path
    // re-applies up to +3 s to catch async-spawning objects), so hold the guard
    // until those settle.
    //
    // IMPORTANT: register this timer NOW (before the persist await below) so the
    // next undo/redo invocation can cancel it synchronously. Registering after the
    // await creates a window where a rapid second undo starts, clears the timer
    // list, and then undo1's release fires AFTER undo2 completes — releasing the
    // guard early and letting the push tracker record a spurious entry.
    const release = () => {
      try {
        const rev    = Number((Globals as any)._editorStateRev ?? 0);
        const camRev = Number((Globals as any)._editorCameraRev ?? 0);
        lastSavedRevRef.current    = rev;
        lastSeenRevRef.current     = rev;
        lastPushedRevRef.current   = rev;
        lastSavedCamRevRef.current = camRev;
        lastSeenCamRevRef.current  = camRev;
      } catch {}
      pendingStateRef.current = '';
      isApplyingHistoryRef.current = false;
      // Re-sync the Tools-panel display (sky/lighting/ground/speed/jump) with
      // the reverted scene so the menu shows the correct active preset when the
      // user opens it after an undo/redo.
      try { seedSceneSettings(); } catch {}
    };
    track(setTimeout(release, didReload ? 6500 : 3500));

    // Persist the reverted snapshot as the canonical draft (fire-and-forget after
    // the timers are registered so any subsequent undo doesn't race with this).
    await persistEditorStateJson(entry.editorState);
  }

  function undo() {
    if (historyIdx.current > 0) applyHistoryEntry(historyIdx.current - 1);
  }

  function redo() {
    if (historyIdx.current < editHistory.current.length - 1)
      applyHistoryEntry(historyIdx.current + 1);
  }

  // ── Camera & select controls ───────────────────────────────────────────────

  function resetCamera() {
    try { (Globals as any).resetEditorCamera?.(); } catch {}
  }

  // ── Double-tap preview to collapse sheet ──────────────────────────────────

  function handlePreviewTap() {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      slideTo(SHEET_COLLAPSED);
    }
    lastTapRef.current = now;
  }

  // ── Launch play ────────────────────────────────────────────────────────────

  function launchPlay() {
    // Signal the mount-cleanup not to call exitGame/onEditingChange — the game
    // is about to start and those calls would kill it before _gameActive=true.
    playLaunchedRef.current = true;
    try { (Globals as any).playGameFromEditor?.(gameData.id); } catch {}
  }

  // ── Publish ────────────────────────────────────────────────────────────────

  async function confirmPublish() {
    setPublishing(true);
    try {
      await apiPost(`/api/game/${gameData.id}/publish`, { userAccessToken: getGlobal('getAccessToken') });
      setPublished(true);
      setShowPublish(false);
      setHistory(prev => [...prev, { role: 'assistant', content: '🎉 Game published! It now appears in the Home and Explore tabs for everyone to play.' }]);
      // Tell Home and Explore to refetch if they're currently mounted; tab switches
      // already trigger a fresh fetch via the conditional render in App.tsx.
      try { (Globals as any)._refreshHomeContent?.(); } catch {}
      try { (Globals as any)._refreshExploreContent?.(); } catch {}
    } catch (e: any) {
      setShowPublish(false);
      const detail = String(e?.message ?? '').slice(0, 80);
      setHistory(prev => [...prev, { role: 'assistant', content: `Could not publish${detail ? ` (${detail})` : ''} — please try again.` }]);
    } finally {
      setPublishing(false);
    }
  }

  const screenH  = editorScreenH();
  // When chat is closed the sheet occupies zero space, so bottom-anchored
  // floating buttons sit directly above the safe-area inset. When open, they
  // ride on top of the sheet and shift with its drag.
  // Chat used to be a bottom sheet — `h` was its rendered height pushing the
  // viewport buttons (asset strip, trash, select-mode) upward. The chat now
  // docks as a left-edge panel (matching Settings / Custom Logic), so it no
  // longer steals vertical space. `h` stays defined (= 0) so the existing
  // `bottom: h + …` expressions keep type-checking without surgical rewrites,
  // and `expanded` collapses to a plain chatOpen alias.
  const h        = 0;
  const expanded = chatOpen;
  // historyVersion is read so these recompute whenever the stack changes (the
  // values live on refs, which don't themselves trigger a re-render).
  const canUndo  = historyVersion >= 0 && historyIdx.current > 0;
  const canRedo  = historyVersion >= 0 && historyIdx.current < editHistory.current.length - 1;

  // Root-level pointer release handler — handles the asset-strip drop when
  // the user releases over the 3D viewport (the common case). ReactUnity
  // routes onPointerUp to the topmost element under the release point, NOT
  // the original press target, so the tile's own onPointerUp won't fire
  // unless the user happens to release back over the tile. Putting the
  // handler on the root view guarantees we always get the release event.
  function handleEditorRelease() {
    const asset = armedAssetRef.current;
    if (!asset) return;
    armedAssetRef.current = null;
    const down = armDownPosRef.current;
    armDownPosRef.current = null;
    setArmedDragging(false);
    try {
      const ux = editorPointerX(), uy = editorPointerY();
      // Tap vs drag: if the finger barely moved between press and release it's
      // a TAP → drop the model in front of the camera (viewport centre) via
      // editorAddAssetCenter. A real drag → place at the release point via
      // editorPlaceAsset (which also checks the trash drop-zone to cancel).
      // TAP_SLOP is in Unity device pixels (getPointerX/Y read the raw pointer
      // position). ~50px is forgiving enough that a shaky tap still counts as a
      // tap, while a real drag-to-place moves far more than this.
      const TAP_SLOP = 50;
      const moved = down ? Math.hypot(ux - down.x, uy - down.y) : Infinity;
      if (moved < TAP_SLOP) {
        (Globals as any).editorAddAssetCenter?.(
          asset.cacheKey, asset.modelUrl, asset.isHumanoid, asset.sizeHint ?? 0,
        );
      } else {
        (Globals as any).editorPlaceAsset?.(
          asset.cacheKey, asset.modelUrl, ux, uy, asset.isHumanoid, asset.sizeHint ?? 0,
        );
      }
    } catch { /* bridge not ready — drop is a no-op */ }
  }
  // NOTE: onPointerCancel must NOT disarm the asset. ReactUnity fires a cancel
  // when the host <scroll> steals the drag gesture, which happens mid-drag with
  // the finger still down. Disarming there orphaned every drop. The strip-drag
  // release watchdog (polling isPointerDown) owns the real release now, so cancel
  // is intentionally a no-op — the watchdog places the asset when the finger
  // actually lifts (and editorPlaceAsset still honours the trash drop-zone).
  function handleEditorReleaseCancel() { /* intentionally no-op — see note above */ }

  return (
    <view
      // `editor-passthrough`: the C# editor camera (EditorCameraController.
      // IsPointerOverUI) raycasts the UI to decide whether a tap is "over UI"
      // and should be ignored. This full-screen root + the double-tap area are
      // transparent gesture-capture layers that must NOT count as UI, or tapping
      // the viewport could never select / move a 3D object. Real chrome (buttons,
      // panels) carries no such class, so it blocks the select-tap as intended.
      className="editor-passthrough"
      onPointerUp={handleEditorRelease}
      onPointerCancel={handleEditorReleaseCancel}
      style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0)', position: 'relative' }}>

      {/* ── Terrain brush capture overlay ──────────────────────────────────
          Active only when terrainMode AND a tool is selected. Sits over the
          full viewport but BELOW the hamburger top bar (zIndex 5 < 10) so the
          Exit button is still tappable. onPointerMove keeps applyTerrainBrush
          firing while the user drags; the C# side throttles via mesh rebuild
          but we also throttle here so a fast drag doesn't queue 60 calls/s.
          When no tool is selected the overlay is gone — normal pan/zoom
          camera controls work through the underlying viewport. */}
      {terrainMode && terrainTool ? (
        <view
          onPointerDown={() => { terrainBrushing.current = true; startHoldFire(); }}
          onPointerMove={() => { if (terrainBrushing.current) fireBrush(); }}
          onPointerUp={() => { terrainBrushing.current = false; stopHoldFire(); }}
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            // ReactUnity drops pointer events on fully-transparent views — use
            // a near-zero alpha so the overlay still catches drags but reads as
            // invisible (the underlying scene shows through unchanged).
            backgroundColor: 'rgba(0,0,0,0.005)', zIndex: 5,
          }}
        />
      ) : null}

      {/* Dim backdrop when sheet is nearly full */}
      {h > SHEET_FULL * 0.85 ? (
        <view style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} />
      ) : null}

      {/* ── Top-left hamburger + top-bar menu ──────────────────────────────
          Hamburger button at the top-left safe-area corner toggles a
          horizontal top bar (Play / AI / Build / Publish / Leave) instead of
          a vertical dropdown. The bar extends to the right of the hamburger
          so the 3D viewport below it stays unobstructed. Chrome matches the
          chat UI: rgba(20,20,22,0.78) bg + rgba(255,255,255,0.10) border. */}
      <view style={{
        position: 'absolute', top: safeAreaTop(), left: safeAreaLeft() + editorShift,
        zIndex: 10,
        flexDirection: 'row', alignItems: 'center', gap: 8,
      }}>
        <button
          // Triple-duty button. Icon + action depends on context:
          //   • Object selected → X, taps deselect (clears the selection on
          //     Unity but stays in select mode, which is always on; the
          //     _selectedObject poll then hides the Edit/Custom Logic bar +
          //     settings panel).
          //   • Terrain mode    → X, first tap exits terrain mode.
          //   • Default         → ☰ / X toggles the menu open/closed.
          // The chrome stays identical so the button doesn't shift around.
          onClick={() => {
            if (selectMode && selectedObj) {
              // Deselect the current object but stay in select mode (it's
              // always on now). editorClearSelection drops the highlight +
              // _selectedObject on Unity without flipping SelectActive off.
              try { (Globals as any).editorClearSelection?.(); } catch {}
              return;
            }
            if (terrainMode) { exitTerrainMode(); return; }
            // Step back out of the Tools submenus one level at a time.
            if (toolsMenu === 'sky' || toolsMenu === 'lighting' || toolsMenu === 'textures') { setToolsMenu('style'); return; }
            if (toolsMenu === 'player') { setToolsMenu('tools'); return; }
            if (toolsMenu === 'style') { setToolsMenu('tools'); return; }
            if (toolsMenu === 'interface') { setIfaceEditing(null); setToolsMenu('tools'); return; }
            if (toolsMenu === 'tools') { setToolsMenu('none'); return; }
            setMenuOpen(o => !o);
          }}
          style={{
            width: 44, height: 44, borderRadius: 12,
            backgroundColor: 'rgba(20,20,22,0.78)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>
            {((selectMode && selectedObj) || menuOpen) ? 'close' : 'menu'}
          </icon>
        </button>

        {(selectMode && selectedObj) ? (
          /* ── Object-selected top bar — Edit (gear / settings) + Custom Logic.
              Replaces the default Play/AI/Terrain/Publish/Leave row whenever a
              model is selected. Edit toggles the per-object settings panel on
              the left edge; Custom Logic is a placeholder for the code editor.
              onPointerDown/Up suppress the editor camera + select-tap during
              interaction so tapping Edit (or its transparent children) doesn't
              fall through and clear the selection. */
          <view
            onPointerDown={() => { try { (Globals as any).setEditorSheetDragging?.('true'); } catch {} }}
            onPointerUp={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
            onPointerCancel={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
            style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
            <button
              onClick={openSettings}
              style={{
                height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: showSettings ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
                borderWidth: 0,
              }}
            >
              <icon set={showSettings ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 18, color: showSettings ? C.blue : C.text, lineHeight: 18 }}>settings</icon>
              <text style={{ fontSize: 13, color: showSettings ? C.blue : C.text, fontWeight: 'bold' }}>Edit</text>
            </button>
            <button
              onClick={openCustomLogic}
              style={{
                height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: showCustomLogic ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
                borderWidth: 0,
              }}
            >
              <icon set={showCustomLogic ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 18, color: showCustomLogic ? C.blue : C.text, lineHeight: 18 }}>code</icon>
              <text style={{ fontSize: 13, color: showCustomLogic ? C.blue : C.text, fontWeight: 'bold' }}>Custom Logic</text>
            </button>
          </view>
        ) : menuOpen ? (
          terrainMode ? (
            /* ── Terrain-builder top bar — Raise / Lower / Flatten / Smooth / Paint + Exit ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              {([
                { tool: 'raise',   icon: 'arrow_upward',   label: 'Raise'   },
                { tool: 'lower',   icon: 'arrow_downward', label: 'Lower'   },
                { tool: 'flatten', icon: 'horizontal_rule', label: 'Flatten' },
                { tool: 'smooth',  icon: 'blur_on',        label: 'Smooth'  },
              ] as const).map(t => {
                const active = terrainTool === t.tool;
                return (
                  <button
                    key={t.tool}
                    onClick={() => {
                      setTerrainTool(prev => prev === t.tool ? null : t.tool);
                      try { (Globals as any).setTerrainTool?.(active ? '' : t.tool); } catch {}
                    }}
                    style={{
                      height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      backgroundColor: active ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
                      borderWidth: 0,
                    }}
                  >
                    <icon set={active ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 18, color: active ? C.blue : C.text, lineHeight: 18 }}>{t.icon}</icon>
                    <text style={{ fontSize: 13, color: active ? C.blue : C.text, fontWeight: 'bold' }}>{t.label}</text>
                  </button>
                );
              })}
              {/* Exit lives on the hamburger X to the left of this bar — first
                  tap leaves terrain mode, second tap closes the menu. */}
            </view>
          ) : toolsMenu === 'tools' ? (
            /* ── Tools submenu — Terrain Builder / Style. The hamburger X steps
                back to the default bar. ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              <button
                onClick={enterTerrainMode}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>landscape</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Terrain</text>
              </button>
              <button
                onClick={() => setToolsMenu('style')}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>palette</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Style</text>
              </button>
              <button
                onClick={() => { seedSceneSettings(); setIfaceEditing(null); setToolsMenu('interface'); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>dashboard</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Interface</text>
              </button>
              <button
                onClick={() => setToolsMenu('player')}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>person</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Player</text>
              </button>
            </view>
          ) : toolsMenu === 'style' ? (
            /* ── Style submenu — Textures / Lighting / Sky / Sound. The hamburger
                X steps back to the Tools submenu. ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              {([
                { key: 'textures', icon: 'texture',    label: 'Textures', go: 'textures' as ToolsMenu },
                { key: 'lighting', icon: 'light_mode', label: 'Lighting', go: 'lighting' as ToolsMenu },
                { key: 'sky',      icon: 'cloud',      label: 'Sky',      go: 'sky'      as ToolsMenu },
              ] as const).map(s => (
                <button
                  key={s.key}
                  onClick={() => { if (s.go) setToolsMenu(s.go); /* Sound: TODO background-music picker */ }}
                  style={{
                    height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                  }}
                >
                  <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>{s.icon}</icon>
                  <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>{s.label}</text>
                </button>
              ))}
            </view>
          ) : (toolsMenu === 'sky' || toolsMenu === 'lighting' || toolsMenu === 'textures') ? (
            /* ── Style leaf — preset row for Sky / Lighting / Textures. ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              {(() => {
                const SKY = [
                  { key: '',            label: 'Default' },
                  { key: 'midday',      label: 'Day'     },
                  { key: 'golden_hour', label: 'Sunset'  },
                  { key: 'night',       label: 'Night'   },
                  { key: 'overcast',    label: 'Cloudy'  },
                ];
                const LIGHT = [
                  { key: 'day',         label: 'Bright'  },
                  { key: 'overcast',    label: 'Soft'    },
                  { key: 'golden_hour', label: 'Golden'  },
                  { key: 'night',       label: 'Dim'     },
                ];
                const GROUND = [
                  { key: '',      label: 'Gray'  },
                  { key: 'grass', label: 'Grass' },
                  { key: 'dirt',  label: 'Dirt'  },
                  { key: 'sand',  label: 'Sand'  },
                  { key: 'stone', label: 'Stone' },
                  { key: 'snow',  label: 'Snow'  },
                ];
                const cfg = toolsMenu === 'sky'
                  ? { list: SKY,   active: skyPreset,      set: setSkyPreset,      bridge: 'editorSetSky' }
                  : toolsMenu === 'lighting'
                  ? { list: LIGHT, active: lightingPreset, set: setLightingPreset, bridge: 'editorSetLighting' }
                  : { list: GROUND, active: groundPreset,  set: setGroundPreset,   bridge: 'editorSetGround' };
                return cfg.list.map(p => {
                  const on = cfg.active === p.key;
                  return (
                    <button
                      key={p.key || 'default'}
                      onClick={() => { cfg.set(p.key); styleBridge(cfg.bridge, p.key); }}
                      style={{
                        height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                        flexDirection: 'row', alignItems: 'center',
                        backgroundColor: on ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
                        borderWidth: 0,
                      }}
                    >
                      <text style={{ fontSize: 13, color: on ? C.blue : C.text, fontWeight: 'bold' }}>{p.label}</text>
                    </button>
                  );
                });
              })()}
            </view>
          ) : toolsMenu === 'player' ? (
            /* ── Player leaf — walk speed + jump steppers. ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 8, paddingRight: 8,
              flexDirection: 'row', alignItems: 'center', gap: 4,
            }}>
              {([
                { label: 'Speed', icon: 'directions_run', value: playerSpeed, set: setPlayerSpeed, bridge: 'editorSetPlayerSpeed', step: 1,   min: 1,   max: 20, dp: 0 },
                { label: 'Jump',  icon: 'height',         value: playerJump,  set: setPlayerJump,  bridge: 'editorSetPlayerJump',  step: 0.5, min: 0.5, max: 8,  dp: 1 },
              ] as const).map(st => {
                const apply = (nv: number) => {
                  const clamped = Math.max(st.min, Math.min(st.max, Math.round(nv / st.step) * st.step));
                  st.set(clamped);
                  styleBridge(st.bridge, clamped);
                };
                return (
                  <view key={st.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    <icon set="material-rounded" style={{ fontSize: 16, color: C.secondary, lineHeight: 16, marginRight: 2 }}>{st.icon}</icon>
                    <button onClick={() => apply(st.value - st.step)} style={{ width: 26, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>remove</icon>
                    </button>
                    <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', minWidth: 32, textAlign: 'center' } as any}>{st.value.toFixed(st.dp)}</text>
                    <button onClick={() => apply(st.value + st.step)} style={{ width: 26, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>add</icon>
                    </button>
                  </view>
                );
              })}
            </view>
          ) : toolsMenu === 'interface' ? (
            /* ── Interface — shows a compact "Interface" label + "+" in the bar.
                The actual button list/editor floats as a panel below the bar
                (rendered separately further down, outside this flexRow). */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 12, paddingRight: 8,
              flexDirection: 'row', alignItems: 'center', gap: 6,
              minWidth: 160,
            }}>
              <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>dashboard</icon>
              <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', flex: 1 }}>Interface</text>
              <button
                onClick={openAddHudBtn}
                style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 0 }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>add</icon>
              </button>
            </view>
          ) : (
            /* ── Default editor top bar — Play / Tools / Publish / Leave ── */
            <view style={{
              height: 44,
              backgroundColor: 'rgba(20,20,22,0.78)',
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              {/* Play */}
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (isBuilding) return;
                  if (assetsReady) launchPlay();
                  else setShowPlayModal(true);
                }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded-filled" style={{ fontSize: 18, color: isBuilding ? C.secondary : assetsReady ? C.green : '#F59E0B', lineHeight: 18 }}>
                  {isBuilding ? 'hourglass_top' : 'play_arrow'}
                </icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>
                  {isBuilding ? 'Building' :
                    assetsReady ? 'Play' :
                    assetsProgress.total > 0 ? `Play (${assetsProgress.done}/${assetsProgress.total})` : 'Play'}
                </text>
              </button>
              {/* Tools — opens a submenu (Terrain / Style / Interface / Player) */}
              <button
                onClick={() => { seedSceneSettings(); setToolsMenu('tools'); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>build</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Tools</text>
              </button>
              {/* Publish */}
              <button
                onClick={() => { setMenuOpen(false); setShowPublish(true); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set={published ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 18, color: published ? C.green : C.text, lineHeight: 18 }}>{published ? 'check_circle' : 'rocket_launch'}</icon>
                <text style={{ fontSize: 13, color: published ? C.green : C.text, fontWeight: 'bold' }}>
                  {published ? 'Published' : 'Publish'}
                </text>
              </button>
              {/* Save is fully automatic now — there is no manual Save button.
                  Every edit (move/rotate/scale/duplicate/trash/settings/logic)
                  bumps _editorStateRev and PATCHes editor-state 1.5 s later;
                  on unmount/disconnect a keepalive fetch flushes the pending
                  capture so the last edit can never be lost. */}
              {/* Vertical divider */}
              <view style={{ width: 1, height: 22, backgroundColor: 'rgba(255,255,255,0.08)', marginLeft: 4, marginRight: 4 }} />
              {/* Leave */}
              <button
                onClick={() => { setMenuOpen(false); onBack(); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>arrow_back</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Leave</text>
              </button>
            </view>
          )
        ) : null}
      </view>

      {/* ── Interface modal — full-screen overlay ─────────────────────────────── */}
      {toolsMenu === 'interface' ? (
        <view
          onPointerDown={() => { try { (Globals as any).setEditorSheetDragging?.('true'); } catch {} }}
          onPointerUp={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
          onPointerCancel={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 20,
            backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
        <view style={{
          width: 320,
          backgroundColor: 'rgba(16,16,20,0.98)',
          borderRadius: 18,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
        }}>
          {/* Modal header */}
          <view style={{
            flexDirection: 'row', alignItems: 'center',
            paddingLeft: 14, paddingRight: 10, paddingTop: 13, paddingBottom: 13,
            borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
          }}>
            <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18, marginRight: 8 }}>dashboard</icon>
            <text style={{ flex: 1, fontSize: 14, color: '#fff', fontWeight: 'bold' }}>
              {ifaceEditing !== null ? (ifaceEditing === 'new' ? 'Add Button' : 'Edit Button') : 'Interface Buttons'}
            </text>
            {ifaceEditing !== null ? (
              <button onClick={() => setIfaceEditing(null)} style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>arrow_back</icon>
              </button>
            ) : (
              <view style={{ flexDirection: 'row', gap: 6 }}>
                <button onClick={openAddHudBtn} style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 0 }}>
                  <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>add</icon>
                </button>
                <button onClick={() => { setToolsMenu('tools'); }} style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                  <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>close</icon>
                </button>
              </view>
            )}
          </view>
          {ifaceEditing !== null ? (
            /* ── Add / Edit form ── */
            <view style={{ padding: 14, flexDirection: 'column', gap: 10 }}>
              {/* Label */}
              <view style={{ flexDirection: 'column', gap: 4 }}>
                <text style={{ fontSize: 11, color: C.secondary, fontWeight: 'bold' }}>BUTTON LABEL</text>
                <input
                  value={btnDraft.label}
                  onChange={(e: any) => setBtnDraft(d => ({ ...d, label: e?.target?.value ?? e }))}
                  placeholder="e.g. Shop, Map, Info…"
                  maxLength={20}
                  style={{
                    fontSize: 13, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)',
                    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
                    paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                  }}
                />
              </view>
              {/* Icon picker */}
              <view style={{ flexDirection: 'column', gap: 4 }}>
                <text style={{ fontSize: 11, color: C.secondary, fontWeight: 'bold' }}>ICON</text>
                <view style={{ flexDirection: 'row', flexWrap: 'wrap' as any, gap: 4 }}>
                  {IFACE_ICONS.map(ico => (
                    <button key={ico} onClick={() => setBtnDraft(d => ({ ...d, icon: ico }))} style={{
                      width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: btnDraft.icon === ico ? 'rgba(30,140,255,0.25)' : 'rgba(255,255,255,0.07)',
                      borderWidth: 1, borderColor: btnDraft.icon === ico ? C.blue : 'rgba(255,255,255,0.08)',
                    }}>
                      <text style={{ fontSize: 18 }}>{ico}</text>
                    </button>
                  ))}
                </view>
              </view>
              {/* Position picker */}
              <view style={{ flexDirection: 'column', gap: 4 }}>
                <text style={{ fontSize: 11, color: C.secondary, fontWeight: 'bold' }}>POSITION</text>
                <view style={{ flexDirection: 'row', flexWrap: 'wrap' as any, gap: 4 }}>
                  {IFACE_ANCHORS.map(a => (
                    <button key={a.key} onClick={() => setBtnDraft(d => ({ ...d, anchor: a.key }))} style={{
                      paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                      borderRadius: 7, borderWidth: 1,
                      backgroundColor: btnDraft.anchor === a.key ? 'rgba(30,140,255,0.22)' : 'rgba(255,255,255,0.07)',
                      borderColor: btnDraft.anchor === a.key ? C.blue : 'rgba(255,255,255,0.08)',
                    }}>
                      <text style={{ fontSize: 11, color: btnDraft.anchor === a.key ? C.blue : C.text, fontWeight: 'bold' }}>{a.label}</text>
                    </button>
                  ))}
                </view>
              </view>
              {/* Action picker */}
              <view style={{ flexDirection: 'column', gap: 4 }}>
                <text style={{ fontSize: 11, color: C.secondary, fontWeight: 'bold' }}>ACTION</text>
                <view style={{ flexDirection: 'column', gap: 4 }}>
                  {IFACE_ACTIONS.map(ac => (
                    <button key={ac.key} onClick={() => setBtnDraft(d => ({ ...d, action: ac.key }))} style={{
                      flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingLeft: 10, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
                      borderRadius: 9, borderWidth: 1,
                      backgroundColor: btnDraft.action === ac.key ? 'rgba(30,140,255,0.18)' : 'rgba(255,255,255,0.05)',
                      borderColor: btnDraft.action === ac.key ? C.blue : 'rgba(255,255,255,0.08)',
                    }}>
                      <view style={{ flex: 1, flexDirection: 'column', gap: 1 }}>
                        <text style={{ fontSize: 12, color: btnDraft.action === ac.key ? C.blue : C.text, fontWeight: 'bold' }}>{ac.label}</text>
                        <text style={{ fontSize: 10, color: C.secondary }}>{ac.desc}</text>
                      </view>
                      {btnDraft.action === ac.key ? (
                        <icon set="material-rounded-filled" style={{ fontSize: 14, color: C.blue, lineHeight: 14 }}>check_circle</icon>
                      ) : null}
                    </button>
                  ))}
                </view>
              </view>
              {/* Action-specific params */}
              {btnDraft.action === 'panel' ? (
                <view style={{ flexDirection: 'column', gap: 6 }}>
                  <input
                    value={btnDraft.panelTitle}
                    onChange={(e: any) => setBtnDraft(d => ({ ...d, panelTitle: e?.target?.value ?? e }))}
                    placeholder="Panel title…"
                    maxLength={60}
                    style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
                  />
                  <input
                    value={btnDraft.panelBody}
                    onChange={(e: any) => setBtnDraft(d => ({ ...d, panelBody: e?.target?.value ?? e }))}
                    placeholder="Panel body text…"
                    maxLength={300}
                    style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
                  />
                </view>
              ) : btnDraft.action === 'event' ? (
                <view style={{ flexDirection: 'column', gap: 4 }}>
                  <text style={{ fontSize: 10, color: C.secondary }}>Event name (Lua: Interface.OnButton("name", fn))</text>
                  <input
                    value={btnDraft.eventName}
                    onChange={(e: any) => setBtnDraft(d => ({ ...d, eventName: (e?.target?.value ?? e).replace(/\s/g,'') }))}
                    placeholder="e.g. openShop"
                    maxLength={40}
                    style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
                  />
                </view>
              ) : null}
              {/* Save / Cancel */}
              <view style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>
                <button onClick={() => setIfaceEditing(null)} style={{ flex: 1, paddingTop: 9, paddingBottom: 9, borderRadius: 9, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 0 }}>
                  <text style={{ fontSize: 12, color: C.secondary, fontWeight: 'bold' }}>Cancel</text>
                </button>
                <button onClick={commitHudBtn} style={{ flex: 1, paddingTop: 9, paddingBottom: 9, borderRadius: 9, alignItems: 'center', backgroundColor: btnDraft.label.trim() ? C.blue : 'rgba(30,140,255,0.25)', borderWidth: 0 }}>
                  <text style={{ fontSize: 12, color: '#fff', fontWeight: 'bold' }}>{ifaceEditing === 'new' ? 'Add Button' : 'Save'}</text>
                </button>
              </view>
            </view>
          ) : hudButtons.length === 0 ? (
            /* ── Empty state ── */
            <view style={{ padding: 20, alignItems: 'center', gap: 8 }}>
              <icon set="material-rounded" style={{ fontSize: 32, color: C.secondary, lineHeight: 32 }}>dashboard</icon>
              <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', textAlign: 'center' as any }}>No buttons yet</text>
              <text style={{ fontSize: 12, color: C.secondary, textAlign: 'center' as any }}>Tap + to add a button players can press during your game.</text>
              <button onClick={openAddHudBtn} style={{ marginTop: 4, paddingLeft: 18, paddingRight: 18, paddingTop: 8, paddingBottom: 8, borderRadius: 10, backgroundColor: C.blue, borderWidth: 0 }}>
                <text style={{ fontSize: 13, color: '#fff', fontWeight: 'bold' }}>Add Button</text>
              </button>
            </view>
          ) : (
            /* ── Button list ── */
            <view style={{ flexDirection: 'column' }}>
              {hudButtons.map((btn, i) => (
                <view key={btn.id} style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  paddingLeft: 12, paddingRight: 10, paddingTop: 10, paddingBottom: 10,
                  borderBottomWidth: i < hudButtons.length - 1 ? 1 : 0,
                  borderColor: 'rgba(255,255,255,0.07)',
                }}>
                  <text style={{ fontSize: 20, lineHeight: 20, minWidth: 24, textAlign: 'center' as any }}>{btn.icon}</text>
                  <view style={{ flex: 1, flexDirection: 'column', gap: 2 }}>
                    <text style={{ fontSize: 13, color: '#fff', fontWeight: 'bold' }}>{btn.label}</text>
                    <text style={{ fontSize: 10, color: C.secondary }}>
                      {IFACE_ACTIONS.find(a => a.key === btn.action)?.label ?? btn.action}
                      {' · '}{IFACE_ANCHORS.find(a => a.key === btn.anchor)?.label ?? btn.anchor}
                    </text>
                  </view>
                  <button onClick={() => openEditHudBtn(btn)} style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                    <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>edit</icon>
                  </button>
                  <button onClick={() => deleteHudBtn(btn.id)} style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,69,58,0.12)', borderWidth: 0 }}>
                    <icon set="material-rounded" style={{ fontSize: 16, color: '#ff453a', lineHeight: 16 }}>delete</icon>
                  </button>
                </view>
              ))}
              <view style={{ padding: 10, paddingTop: 8 }}>
                <button onClick={openAddHudBtn} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 8, paddingBottom: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' }}>
                  <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>add</icon>
                  <text style={{ fontSize: 12, color: C.text, fontWeight: 'bold' }}>Add Button</text>
                </button>
              </view>
            </view>
          )}
        </view>
        </view>
      ) : null}

      {/* ── Top-right corner: Undo / Redo. Mirrors the top-left menu bar's
          vertical position. No editorShift — the left-docked panels open on the
          opposite edge, so these never need to slide out of their way. */}
      <view style={{
        position: 'absolute',
        top: safeAreaTop(), right: safeAreaRight(),
        zIndex: 10,
        flexDirection: 'row', gap: 8,
      }}>
        <button
          onClick={undo}
          style={{
            width: 44, height: 44, borderRadius: 12,
            backgroundColor: 'rgba(20,20,22,0.78)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
            opacity: canUndo ? 1 : 0.4,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>undo</icon>
        </button>
        <button
          onClick={redo}
          style={{
            width: 44, height: 44, borderRadius: 12,
            backgroundColor: 'rgba(20,20,22,0.78)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
            opacity: canRedo ? 1 : 0.4,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>redo</icon>
        </button>
      </view>

      {/* Preview error banner — shown when Unity reports a script failure in preview mode.
          Hidden during isBuilding so users don't see scary parse errors from streaming
          partials that get auto-completed/skipped a frame later. */}
      {previewError && !isBuilding ? (
        <view style={{
          position: 'absolute',
          top: safeAreaTop() + 48,
          left: 0, right: 0,
          alignItems: 'center',
          paddingLeft: safeAreaLeft() + 12, paddingRight: safeAreaRight() + 12,
        }}>
        <view style={{
          width: '100%', maxWidth: EDITOR_BANNER_MAX_WIDTH,
          backgroundColor: 'rgba(200,48,48,0.88)',
          borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,80,80,0.5)',
          paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
          flexDirection: 'row', alignItems: 'center', gap: 8,
        }}>
          <text style={{ fontSize: 13, color: '#fff', flex: 1 }}>{previewError}</text>
          <button onClick={() => { setPreviewError(''); try { (Globals as any)._editorError = ''; } catch {} }} style={{
            paddingLeft: 8, paddingRight: 8,
          }}>
            <icon set="material-rounded" style={{ fontSize: 16, color: 'rgba(255,255,255,0.7)', lineHeight: 16 }}>close</icon>
          </button>
        </view>
        </view>
      ) : null}

      {/* Double-tap area: covers game preview above toolbar; collapses sheet on
          double-tap. `editor-passthrough` so the C# select-tap raycast doesn't
          treat this gesture-capture layer as blocking UI (see root view note). */}
      <view
        className="editor-passthrough"
        onPointerDown={handlePreviewTap}
        style={{
          position: 'absolute',
          top: 54,
          bottom: h + keyboardH + 72,
          left: 0, right: 0,
        }}
      />

      {/* ── Bottom-left column: horizontal model strip ────────────────────
          The strip is a placeholder list of game assets until a Globals API
          surfaces the actual loaded models. The wrapper sits just above the
          collapsible bottom sheet (h+keyboardH), so it shifts up cleanly when
          the user drags the sheet. (Undo/Redo moved to the top-right corner.) */}
      <view style={{
        position: 'absolute',
        // Flush against the safe-area bottom — pads above the home-indicator
        // inset so the strip lands on the yellow safe-rect border, not the
        // screen edge. When the AI chat sheet is open the column rides on top
        // of it (sheet height + 12 gap); the sheet itself extends past the
        // safe area visually but its input row already pads for the indicator.
        bottom: h + keyboardH + (safeAreaBottom()),
        // Flush at the left safe-area border; right margin reserves room for
        // the bottom-right column (56 wide + 12 gap = 68). `editorShift`
        // slides the whole column right when a left-docked panel opens so
        // the buttons + asset strip don't disappear behind it.
        left: safeAreaLeft() + editorShift, right: safeAreaRight() + 68,
        flexDirection: 'column', gap: 8,
      }}>
        {/* Model strip — horizontal scroll of asset thumbnails.
            Per-game (App.tsx routes Assets-modal applies into a Record keyed
            by editingGameId, so opening Game A vs Game B shows their own
            lists). Tiles are flush — no gap, no padding between cells.
            Empty on a fresh game; users add models via the Assets picker
            (the + button), and the list persists across sessions via the
            `editor.assetsByGame` pref written from App.tsx.
            The strip stays visible while an object is selected and while
            adding a model (tap or drag from a tile), but HIDES while the user
            is actively moving a placed object (`draggingObj`) so the centered
            trash drop-zone has the bottom edge to itself — dragging an object
            onto the strip footprint should read as "drop on trash", not "drop
            on the bar". We only hide on `draggingObj`, never on `armedDragging`
            (a strip-tile placement drag): the pressed tile MUST stay mounted or
            ReactUnity orphans the drag (the root pointerUp/Cancel that drives
            placement + state-reset depends on the tree staying alive). */}
        {!draggingObj ? (
        <scroll
          horizontal
          className="pludo-scroll"
          style={{ flexShrink: 0, opacity: 1 } as any}>
          <view style={{ flexDirection: 'row', alignItems: 'center' }}>
            {(editorAssets ?? []).map(a => {
              // Drag-to-place: arm on pointer-down; on pointer-up read the
              // live screen-pixel position from Unity and ask the bridge to
              // spawn the model there. The tile stays in the strip — we
              // never splice editorAssets, so the user can drop the same
              // model into the scene as many times as they want.
              const hasThumb = !!a.thumbnailUrl;
              return (
                <view
                  key={a.cacheKey}
                  onPointerDown={() => {
                    armedAssetRef.current = a;
                    // Record the press point so the watchdog can distinguish
                    // a tap (asset drops at viewport centre) from a drag (asset
                    // spawns under the finger and enters move-selected mode).
                    try { armDownPosRef.current = { x: editorPointerX(), y: editorPointerY() }; }
                    catch { armDownPosRef.current = null; }
                    setArmedDragging(true);
                    // Set SheetDragging synchronously so the camera controller
                    // doesn't pan on the very first Update tick.
                    try { (Globals as any).setEditorSheetDragging?.('true'); } catch {}
                  }}
                  style={{
                    width: 56, height: 56,
                    backgroundColor: '#1a1a1a',
                    alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                    position: 'relative',
                  }}>
                  {hasThumb ? (
                    <image
                      src={a.thumbnailUrl}
                      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, objectFit: 'cover' } as any}
                    />
                  ) : (
                    <text style={{ fontSize: 14, color: '#fff', fontWeight: 'bold' }}>
                      {(() => {
                        const words = a.prompt.match(/[A-Za-z]+/g) ?? [];
                        return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '●';
                      })()}
                    </text>
                  )}
                </view>
              );
            })}
          </view>
        </scroll>
        ) : null}
      </view>

      {/* ── Selection overlay — white square framing the selected 3D model.
          Each edge handle is a swipe-and-hold: left = rotate up/down, right =
          move up/down, bottom = rotate left/right; top-left duplicates and
          top-right scales (swipe up=bigger). Directional arrow glyphs hint the
          swipe axis (↕ / ↔). Position is
          driven by `_editorSelBoundsRef` (published by EditorCameraController
          at ~60 fps from the model's projected world AABB). Hidden while
          the user is dragging the model — the trash icon takes over. */}
      {selectMode && selBounds && !draggingObj ? (() => {
        const minSize = 80;
        let { left, top, right, bottom } = selBounds;
        // Pad so the frame doesn't crowd the model on screen and so the
        // buttons sit clearly outside the silhouette.
        const pad = 8;
        left   -= pad; top    -= pad;
        right  += pad; bottom += pad;
        // Enforce a minimum on-screen size — a far-away model can project
        // to a 10-px box and the buttons would all overlap.
        const cx = (left + right) / 2;
        const cy = (top + bottom) / 2;
        if (right - left < minSize)  { left = cx - minSize / 2; right  = cx + minSize / 2; }
        if (bottom - top < minSize)  { top  = cy - minSize / 2; bottom = cy + minSize / 2; }
        const w = right - left;
        const h = bottom - top;
        const btn = 36;     // square button size
        const frameZ = 140; // below trash (150), above HUD (default)
        return (
          <>
            {/* White outline frame. `editor-passthrough` so its rect (which sits
                over the selected object) never blocks a select-tap — the actual
                handle buttons below carry no such class and stay interactive. */}
            <view className="editor-passthrough" style={{
              position: 'absolute',
              left, top, width: w, height: h,
              borderWidth: 2, borderColor: '#ffffff',
              backgroundColor: 'rgba(0,0,0,0)',
              zIndex: frameZ,
            } as any} />
            {/* Top-left: Duplicate */}
            <button
              onClick={() => { try { (Globals as any).editorDuplicateSelected?.(); } catch {} }}
              style={{
                position: 'absolute',
                left: left - btn / 2, top: top - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                backgroundColor: 'rgba(20,20,22,0.92)',
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 18, color: '#fff', lineHeight: 18 }}>content_copy</icon>
            </button>
            {/* Top-right: swipe to scale — drag vertically to make the object
                bigger (swipe up) or smaller (swipe down). Release (isPointerDown
                poll) ends the swipe. */}
            <view
              onPointerDown={() => startManipulating('scale')}
              style={{
                position: 'absolute',
                left: right - btn / 2, top: top - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                backgroundColor: 'rgba(20,20,22,0.92)',
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 18, color: '#fff', lineHeight: 18 }}>aspect_ratio</icon>
            </view>
            {/* Left edge: swipe to rotate up/down (pitch) — drag vertically to
                nod the object toward/away from the camera (camera-right axis,
                projected horizontally). Release (isPointerDown poll) ends it. */}
            <view
              onPointerDown={() => startManipulating('rotPitch')}
              style={{
                position: 'absolute',
                left: left - btn / 2, top: (top + bottom) / 2 - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                backgroundColor: 'rgba(20,20,22,0.92)',
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 20, color: '#fff', lineHeight: 20 }}>swap_vert</icon>
            </view>
            {/* Right edge: swipe to move up/down — drag vertically to lift
                (swipe up) or lower (swipe down) the object along world-Y.
                Release (isPointerDown poll) ends the swipe. */}
            <view
              onPointerDown={() => startManipulating('moveVert')}
              style={{
                position: 'absolute',
                left: right - btn / 2, top: (top + bottom) / 2 - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                backgroundColor: 'rgba(20,20,22,0.92)',
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 20, color: '#fff', lineHeight: 20 }}>height</icon>
            </view>
            {/* Bottom edge: swipe to rotate left/right (yaw) — drag horizontally
                to spin the object left-to-right on the ground plane (world-up
                axis). Release (isPointerDown poll) ends the swipe. */}
            <view
              onPointerDown={() => startManipulating('rotYaw')}
              style={{
                position: 'absolute',
                left: (left + right) / 2 - btn / 2, top: bottom - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                backgroundColor: 'rgba(20,20,22,0.92)',
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 20, color: '#fff', lineHeight: 20 }}>swap_horiz</icon>
            </view>
          </>
        );
      })() : null}

      {/* ── Per-object settings panel — opens from the Edit (gear) button on
          the object-selected top bar. Docked to the left safe-area edge,
          beneath the top bar. Owns Destroyable / Invisible / Physics / Move
          and their sub-fields; each change is mirrored to Unity via
          pushObjectSetting so behaviors apply live. */}
      {(selectMode && selectedObj && showSettings) ? (
        <ObjectSettingsPanel
          settings={currentObjSetting}
          objectName={currentObjectId}
          size={modalSize === 'full' ? 'full' : 'default'}
          onChange={updateObjSetting}
          onClose={closeModal}
          onPointerDown={modalPointerDown}
          onPointerUp={modalPointerUp}
        />
      ) : null}

      {/* ── Custom Logic panel — opens from the Custom Logic (code) button on
          the object-selected top bar. Shares the same left-dock slot as the
          settings panel, so the two are mutually exclusive (opening one closes
          the other). Each per-object graph is keyed by object id and mirrored
          to Unity through pushObjectLogic so behavior nodes apply live. */}
      {(selectMode && selectedObj && showCustomLogic) ? (
        <CustomLogicPanel
          graph={currentObjGraph}
          objectName={currentObjectId}
          size={modalSize === 'full' ? 'full' : 'default'}
          onChange={updateObjGraph}
          onClose={closeModal}
          onPointerDown={modalPointerDown}
          onPointerUp={modalPointerUp}
        />
      ) : null}

      {/* ── Trash — bottom-center, takes over the asset strip's footprint.
          Visible ONLY while the user is actively moving an asset (a placed-
          object drag or a strip-tile placement drag); it is NOT shown for a
          mere selection. It's a passive VIEW drop-zone — C# does the hit math
          and the root onPointerUp owns the release. It MUST stay a
          non-interactive view (never a button) or ReactUnity would route the
          strip-tile drop to this element instead of the root handler, breaking
          placement/cancel.
          Drag hit math (both C# paths read TrashBottomReferenceY + canvas
          scale to derive the same Unity-pixel drop center):
            • Placed-object drag → EditorCameraController.UpdateMovingSel
              destroys the object when released within TrashRadiusPx.
            • Strip-tile drag → GameLauncher.editorPlaceAsset skips the
              placement when released within TrashRadiusPx. */}
      {(() => {
        const dragging = draggingObj || armedDragging;
        if (!dragging) return null;
        // Sit at the same bottom edge the asset strip used (and shift up with
        // the chat sheet, identical to the strip's wrapper math) so the trash
        // takes over the strip's footprint instead of floating mid-screen.
        // Keep `bottom` in sync with TrashBottomReferenceY in
        // EditorCameraController.cs — the C# side reads safeAreaBottom from
        // Globals and re-derives the drop-zone center.
        const wrapStyle = {
          position: 'absolute',
          bottom: h + keyboardH + (safeAreaBottom()),
          left: '50%',
          marginLeft: -36,
          width: 72, height: 72, borderRadius: 36,
          backgroundColor: 'rgba(255,69,58,0.92)',
          borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)',
          alignItems: 'center', justifyContent: 'center',
          zIndex: 150,
        } as any;
        const trashIcon = (
          <icon set="material-rounded" style={{ fontSize: 36, color: '#fff', lineHeight: 36 }}>delete</icon>
        );
        // Always a passive drop-zone — only rendered mid-drag, so there is no
        // tap-to-delete mode anymore.
        return (
          <view style={wrapStyle}>{trashIcon}</view>
        );
      })()}

      {/* ── Strip-drag release capture ─────────────────────────────────────
          While a strip tile is armed, lay a transparent full-screen view on
          TOP of everything. ReactUnity routes onPointerUp to the topmost
          element under the release point (NOT the press target), so without
          this the release is swallowed whenever the user lifts over an
          overlay — the top bar, the side-button columns, the selection box,
          or the trash icon that appears mid-drag. When that happened neither
          handleEditorRelease nor handleEditorReleaseCancel fired, so
          armedDragging stayed true → the armedDragging effect kept
          setEditorSheetDragging('true') → EditorCameraController.HandleInput
          early-returned forever and the whole editor looked frozen (no pan,
          no tap, no select). Being topmost guarantees this layer receives the
          release in every case, so placement runs and the drag state always
          clears. Transparent + mounted only while armed, so it never blocks
          normal interaction. */}
      {armedDragging ? (
        <view
          onPointerUp={handleEditorRelease}
          onPointerCancel={handleEditorReleaseCancel}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 9999,
            backgroundColor: 'rgba(0,0,0,0)',
          } as any}
        />
      ) : null}

      {/* ── Bottom-right column: asset-shop plus ──────────────────────────
          Flush at the safe-area bottom. Select mode is always on now, so the
          old Select toggle that lived above this is gone. */}
      <view style={{
        position: 'absolute',
        bottom: h + keyboardH + (safeAreaBottom()),
        right: safeAreaRight(),
        flexDirection: 'column', gap: 8,
        alignItems: 'flex-end',
      }}>
        <button
          onClick={() => onOpenShop?.()}
          style={{
            width: 56, height: 56, borderRadius: 12,
            backgroundColor: 'rgba(20,20,22,0.78)',
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 28, color: C.text, lineHeight: 28 }}>add_circle</icon>
        </button>
      </view>

      {/* AI chat panel removed — the editor no longer has an AI assistant. */}

      {/* ── Collapsed knob — visible when the active modal has been collapsed
          via swipe-left. Tap or swipe-right to re-expand to the default
          panel. Icon mirrors the modal it represents so the user can tell at
          a glance what was collapsed. */}
      {knobActive ? (
        <view
          onPointerDown={modalPointerDown}
          onPointerUp={modalPointerUp}
          onClick={() => setModalSize('default')}
          style={{
            position: 'absolute',
            left: safeAreaLeft(),
            top: safeAreaTop() + 56,
            width: 22, height: 90,
            backgroundColor: 'rgba(20,20,22,0.94)',
            borderTopRightRadius: 11, borderBottomRightRadius: 11,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
            zIndex: 50,
          } as any}
        >
          <icon
            set="material-rounded-filled"
            style={{ fontSize: 16, color: C.blue, lineHeight: 16 }}
          >
            {activeModal === 'chat' ? 'auto_awesome'
              : activeModal === 'settings' ? 'settings'
              : 'code'}
          </icon>
        </view>
      ) : null}

      {/* Publish confirmation modal */}
      {showPublish ? (
        <PublishModal
          onConfirm={confirmPublish}
          onCancel={() => setShowPublish(false)}
          publishing={publishing}
        />
      ) : null}


      {/* Play-anyway modal — shown during script_ready when user taps play */}
      {showPlayModal ? (
        <PlayAnywayModal
          done={assetsProgress.done}
          total={assetsProgress.total}
          onWait={() => setShowPlayModal(false)}
          onPlayAnyway={() => { setShowPlayModal(false); launchPlay(); }}
        />
      ) : null}

    </view>
  );
}

// ── Module-level job cache ────────────────────────────────────────────────────
// Persists across CreateScreen unmounts (tab switches). Maps gameId → jobId.
// Source of truth for which games are currently generating on this device.
const _jobCache = new Map<number, string>();

// Survives the CreateScreen unmount that happens when play is launched from the
// editor (the GameHUD replaces the entire render tree). Holds the game that was
// open in the editor so the next CreateScreen mount can resume editing it
// instead of falling back to the prompt/game-list phase. Consumed once on mount.
let _resumeEditSession: GameStub | null = null;

// ── Main CreateScreen ─────────────────────────────────────────────────────────

export function CreateScreen({ onEditingChange, onEditingGameChange, onOpenShop, editorAssets }: {
  onEditingChange?: (v: boolean) => void;
  // Reports the active game's id (or null when not editing) so App.tsx can
  // route the Assets modal's onApply into the correct per-game asset bucket.
  // Editor strip differs between games because of this.
  onEditingGameChange?: (gameId: number | null) => void;
  onOpenShop?: () => void;
  editorAssets?: AssetItem[];
}) {
  // If the user just left a game they were play-testing from the editor,
  // resume that editing session (set by EditorScreen's unmount on play-launch)
  // rather than dropping them back on the game list. Consume it once.
  const [activeGame,    setActiveGame]    = useState<GameStub | null>(() => {
    const r = _resumeEditSession;
    _resumeEditSession = null;
    return r;
  });
  const [phase,         setPhase]         = useState<Phase>(activeGame ? 'editing' : 'prompt');
  const [prompt,        setPrompt]        = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');

  // Mirror the active game's id to the App-level state so the per-game
  // editorAssets map is keyed correctly. Null when the user is in the
  // prompt/list phase (no game open).
  useEffect(() => {
    onEditingGameChange?.(activeGame?.id ?? null);
  }, [activeGame?.id, onEditingGameChange]);
  const [myGames,       setMyGames]       = useState<GameStub[]>([]);
  const [gamesLoading,  setGamesLoading]  = useState(true);
  const [buildJobId,    setBuildJobId]    = useState('');
  const [forging,       setForging]       = useState(false);
  const [forgeError,    setForgeError]    = useState('');

  // Always refetch on mount — this runs every time the Create tab becomes active.
  useEffect(() => { loadMyGames(); }, []);

  // ── Background polling for pending jobs in prompt phase ───────────────────
  // Runs whenever we're showing the game list AND there are pending jobs tracked
  // in the module-level cache. This is what keeps the list live after back-navigation
  // or tab-switch, because the EditorScreen polling dies with the component but this
  // loop survives as long as the Create tab is active.
  useEffect(() => {
    if (phase !== 'prompt') return;

    const JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 min client-side timeout
    const jobStartTimes = new Map<string, number>(); // jobId → first-seen timestamp
    let cancelled = false;
    let delay = 3000;

    async function tick() {
      if (cancelled) return;

      const entries = [..._jobCache.entries()];

      for (const [gameId, jobId] of entries) {
        if (cancelled) return;

        const startedAt = jobStartTimes.get(jobId) ?? Date.now();
        jobStartTimes.set(jobId, startedAt);

        if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
          _jobCache.delete(gameId);
          setMyGames(prev => prev.map(g =>
            g.id === gameId
              ? { ...g, hasCode: false, description: 'Generation timed out — please try again.' }
              : g
          ));
          continue;
        }

        try {
          const r = await apiGet<{
            status: string;
            game?: Record<string, unknown>;
            assetsTotal?: number;
            assetsDone?: number;
            error?: string;
          }>(`/api/forge-game/status/${jobId}`);

          delay = 3000; // successful response → reset to base interval

          if (r.status === 'script_ready' && r.game) {
            setMyGames(prev => prev.map(g =>
              g.id === gameId
                ? {
                    id:           gameId,
                    title:        String(r.game!.title        ?? g.title),
                    description:  String(r.game!.description  ?? g.description),
                    genre:        String(r.game!.genre        ?? g.genre),
                    plays:        g.plays,
                    hasCode:      true,
                    thumbnailUrl: String(r.game!.thumbnail_url ?? r.game!.thumbnailUrl ?? g.thumbnailUrl),
                  }
                : g
            ));
          } else if (r.status === 'done' && r.game) {
            _jobCache.delete(gameId);
            setMyGames(prev => prev.map(g =>
              g.id === gameId
                ? {
                    id:           gameId,
                    title:        String(r.game!.title        ?? g.title),
                    description:  String(r.game!.description  ?? g.description),
                    genre:        String(r.game!.genre        ?? g.genre),
                    plays:        g.plays,
                    hasCode:      true,
                    thumbnailUrl: String(r.game!.thumbnail_url ?? r.game!.thumbnailUrl ?? g.thumbnailUrl),
                  }
                : g
            ));
          } else if (r.status === 'error') {
            _jobCache.delete(gameId);
            const errMsg = r.error ?? 'Generation failed. Try a different prompt.';
            setMyGames(prev => prev.map(g =>
              g.id === gameId ? { ...g, hasCode: false, description: errMsg } : g
            ));
          }
        } catch {
          // Network failure — double the wait before next attempt, cap at 30s
          delay = Math.min(delay * 2, 30_000);
        }
      }

      if (!cancelled) setTimeout(tick, delay);
    }

    const handle = setTimeout(tick, delay);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [phase]);

  async function loadMyGames(attempt = 0) {
    const userId          = getGlobal('currentUserId');
    const userAccessToken = getGlobal('getAccessToken');
    const creatorName     = getGlobal('currentUsername');

    // Auth globals not ready yet — retry up to 8 times (once per second)
    if (!userId && !creatorName) {
      if (attempt < 8) setTimeout(() => loadMyGames(attempt + 1), 1000);
      return;
    }

    try {
      const games = await fetchMyGamesFromSupabase(userId, userAccessToken, creatorName);
      // Supabase is the authoritative source for final state. Merge with local
      // knowledge of which games are still generating so cards show live status.
      setMyGames(games);

      // For any games Supabase returns as not-yet-complete, try to recover
      // the jobId so background polling can track them through to completion.
      const incompleteGames = games.filter(g => !g.hasCode);
      for (const g of incompleteGames) {
        if (_jobCache.has(g.id)) continue; // already tracked

        // App relaunch path: local cache is empty but the server job may still be
        // alive within its 45-min TTL. Ask the server for the jobId by gameId.
        try {
          const r = await apiGet<{ found: boolean; jobId?: string; status?: string }>(
            `/api/forge-game/find-by-game/${g.id}`
          );
          if (r.found && r.jobId && r.status !== 'error' && r.status !== 'done') {
            _jobCache.set(g.id, r.jobId);
          }
        } catch {}
      }
    } catch (err) {
      console.error('[CreateScreen] Supabase fetch failed:', err);
    } finally {
      setGamesLoading(false);
    }
  }

  async function createBlankGame() {
    if (forging) return;
    setForging(true);
    setForgeError('');
    try {
      const r = await apiPost<{ gameId: number }>('/api/create-blank-game', {
        creatorName:     getGlobal('currentUsername') || 'Player',
        userId:          getGlobal('currentUserId'),
        userAccessToken: getGlobal('getAccessToken'),
      });

      const stub: GameStub = {
        id: r.gameId, title: 'Untitled Game',
        description: '', genre: '', plays: 0, hasCode: true,
        thumbnailUrl: '',
      };
      setMyGames(prev => [stub, ...prev.filter(x => x.id !== r.gameId)]);
      // openGame flips orientation and opens the editor on a blank baseplate
      // (no AI build — buildJobId stays empty).
      openGame(stub);
    } catch {
      setForgeError('Could not create a new game. Check your connection and try again.');
    } finally {
      setForging(false);
    }
  }

  function openGame(game: GameStub) {
    // Kick the orientation flip off before the editor mounts so the editor
    // UI is laid out in landscape from the first frame. EditorScreen's
    // useEffect still calls loadGameForEdit, which re-issues the rotation —
    // the second call is a no-op since we're already landscape.
    try { (Globals as any).enterEditorOrientation?.(); } catch {}
    setActiveGame(game);
    setBuildJobId('');
    setPhase('editing');
  }

  function playGame(gameId: number) {
    try { (Globals as any).loadGame?.(gameId); } catch {}
  }

  if (phase === 'done' && activeGame) {
    return (
      <DoneScreen
        game={activeGame}
        onEdit={() => setPhase('editing')}
        onCreateAnother={() => { setPhase('prompt'); setPrompt(''); setActiveGame(null); setBuildJobId(''); loadMyGames(); }}
        onPlay={() => playGame(activeGame.id)}
      />
    );
  }

  if (phase === 'editing' && activeGame) {
    return (
      <EditorScreen
        game={activeGame}
        buildJobId={buildJobId || undefined}
        initialPrompt={initialPrompt || undefined}
        onBuildComplete={g => {
          // Remove from pending cache — this job is complete.
          _jobCache.delete(g.id);
          setActiveGame(g);
          setBuildJobId('');
          setMyGames(prev => [{ ...g, plays: g.plays ?? 0, hasCode: true }, ...prev.filter(x => x.id !== g.id)]);
        }}
        onBack={() => {
          // Do NOT clear buildJobId here. The prompt-phase polling effect picks it
          // up from _jobCache and continues tracking the job in the background.
          setPhase('prompt');
          setActiveGame(null);
          loadMyGames();
        }}
        onEditingChange={onEditingChange}
        onOpenShop={onOpenShop}
        editorAssets={editorAssets}
      />
    );
  }

  // ── Prompt (default) ──────────────────────────────────────────────────────

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>

      {/* ── Fixed header ── */}
      <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 6 }}>
        <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5 }}>Create</text>
      </view>

      {/* ── Create New Game button + error ── */}
      <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 16 }}>
        <button
          onClick={createBlankGame}
          style={{
            height: 56, borderRadius: 16,
            backgroundColor: forging ? C.surface : C.green,
            borderWidth: 0,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            marginBottom: 8,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: forging ? C.secondary : C.bg, lineHeight: 22 }}>add</icon>
          <text style={{ fontSize: 16, color: forging ? C.secondary : C.bg, fontWeight: 'bold' }}>
            {forging ? 'Creating...' : 'Create New Game'}
          </text>
        </button>

        {forgeError ? (
          <view style={{ backgroundColor: 'rgba(255,69,58,0.10)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,69,58,0.28)', paddingLeft: 14, paddingRight: 14, paddingTop: 12, paddingBottom: 12, marginBottom: 8 }}>
            <text style={{ fontSize: 14, color: '#ff453a', textAlign: 'center' }}>{forgeError}</text>
          </view>
        ) : null}
      </view>

      {/* ── Scrollable game grid ── */}
      {React.createElement('style', { scope: ':root' }, `
        .my-games-scroll::scrollbar, .my-games-scroll::scrollbar-thumb { width: 0; height: 0; background-color: rgba(0,0,0,0); }
        .my-game-title-overlay { backdrop-filter: blur(20px); }
      `)}
      <scroll className="pludo-scroll my-games-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16 }}>
        <view style={{ paddingBottom: 32 }}>

          {gamesLoading ? (
            <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              {[0, 1, 2, 3].map(i => <SkeletonGameCard key={i} />)}
            </view>
          ) : myGames.length === 0 ? (
            <view style={{ alignItems: 'center', paddingTop: 16, paddingBottom: 8, gap: 6 }}>
              <text style={{ fontSize: 15, color: C.secondary, textAlign: 'center' }}>No games yet — build your first one above</text>
            </view>
          ) : (
            <view style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              {myGames.map(g => {
                const failed = g.description?.includes('failed') || g.description?.includes('timed out');
                return (
                  <button
                    key={g.id}
                    onClick={() => openGame(g)}
                    style={{
                      width: '48%', marginBottom: 10,
                      padding: 0, borderRadius: 14, overflow: 'hidden',
                      borderWidth: 1, borderColor: g.hasCode ? C.border : 'rgba(255,149,0,0.3)',
                      backgroundColor: C.surface, position: 'relative',
                    }}
                  >
                    {/* Relative-positioned spacer drives the button's height to a
                        16:9 box. We use aspectRatio (not the paddingTop:%-trick)
                        because ReactUnity's CSS parser collapses fractional
                        percentage strings to 0, which made tiles invisible. */}
                    <view style={{ width: '100%', aspectRatio: 16 / 9 }} />
                    {g.thumbnailUrl ? (
                      <image
                        src={g.thumbnailUrl}
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, objectFit: 'cover' } as any}
                      />
                    ) : (
                      <view style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                        <icon set="material-rounded" style={{ fontSize: 48, color: C.secondary, lineHeight: 48 }}>
                          {failed ? 'error_outline' : 'sports_esports'}
                        </icon>
                      </view>
                    )}
                    <view
                      className="my-game-title-overlay"
                      style={{
                        position: 'absolute', left: 0, right: 0, bottom: 0,
                        paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10,
                        backgroundColor: 'rgba(0,0,0,0.35)',
                        borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
                      }}
                    >
                      <text style={{ fontSize: 13, color: '#fff', fontWeight: 'bold', maxLines: 1, textOverflow: 'ellipsis' } as any}>
                        {stripDecorative(g.title) || (failed ? 'Failed' : 'Generating...')}
                      </text>
                    </view>
                  </button>
                );
              })}
            </view>
          )}
        </view>

      </scroll>
    </view>
  );
}
