import React, { useState, useEffect, useRef } from 'react';
import { C } from '../theme';
import { safeAreaTop, safeAreaBottom, safeAreaLeft, safeAreaRight, landscapeReady } from '../safeArea';
import { isTablet, refScreenWidth, refScreenHeight } from '../responsive';
import { AssetItem } from '../types';
import { Pressable } from '../components/Pressable';
import { SkeletonGameCard } from '../components/Skeleton';
import { IconPicker } from '../components/IconPicker';
import {
  IfaceElementKind, IfaceElement, IfaceActionType, IfaceStep, IfaceWorkflow,
  IFACE_ACTION_META, IFACE_ACTION_ORDER, IFACE_KIND_META, IFACE_COLOR_SWATCHES,
  ifaceUid, blankIfaceStep, defaultIfaceElement, migrateHudButtonsToInterface, isMaterialIconName,
} from '../interfaceModel';
import { GlassButton } from '../components/GlassButton';
import { glass } from '../glass';

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
// On tablet the landscape canvas is width-pinned exactly at the phone
// reference (see MobileOrientationManager.ApplyCanvasReference) but gains
// bonus height — panels/modals get a modest width bump and lean on that
// extra vertical room rather than crowding the 3D viewport.
const EDITOR_TABLET             = isTablet();
const EDITOR_MODAL_MAX_WIDTH    = EDITOR_TABLET ? 520 : 420;
const EDITOR_SHEET_MAX_WIDTH    = EDITOR_TABLET ? 620 : 520;
const EDITOR_BANNER_MAX_WIDTH   = EDITOR_TABLET ? 560 : 480;
const EDITOR_SIDE_PANEL_WIDTH   = EDITOR_TABLET ? 360 : 280; // ObjectSettingsPanel
const EDITOR_LOGIC_PANEL_WIDTH  = EDITOR_TABLET ? 420 : 320; // CustomLogicPanel
// Interface Builder — full-screen editor (Design canvas + Logic workflow tab).
// Header/tab-bar/palette heights are fixed constants (not measured) so the
// canvas rect below can be computed analytically, the same way anchorStyle()
// derives HUD positions elsewhere in this file — there's no DOM measurement
// API in this ReactUnity setup.
const IFACE_HEADER_H  = 52;
const IFACE_TABBAR_H  = 44;
const IFACE_PALETTE_H = 68;
const IFACE_PAD       = 10;
const IFACE_INSPECTOR_H = EDITOR_TABLET ? 240 : 210;

const EDITOR_ASSET_TILE_SIZE    = EDITOR_TABLET ?  72 :  56; // bottom asset/model strip

function editorPointerY(): number {
  return (Globals['getPointerY'] as any)?.() ?? 0;
}
function editorPointerX(): number {
  return (Globals['getPointerX'] as any)?.() ?? 0;
}
// Same pointer, pre-converted by Unity into React reference units (top-left
// origin) — the same coordinate space every <view style={{top,left}}> is laid
// out in. Used by the Interface Builder canvas for 2D drag-and-drop, since
// there's no DOM measurement API here to convert raw device pixels ourselves.
function editorPointerRefX(): number {
  return (Globals['getPointerRefX'] as any)?.() ?? 0;
}
function editorPointerRefY(): number {
  return (Globals['getPointerRefY'] as any)?.() ?? 0;
}
function editorScreenH(): number {
  return (Globals['getScreenHeight'] as any)?.() ?? 844;
}
// Viewport width in React reference units (NOT raw pixels — see getUiWidth in
// GameLauncher). Used by the Custom Logic panel to decide whether a
// three-column layout actually fits; falls back to the portrait phone
// reference so a missing bridge degrades to the stacked layout.
function editorUiWidth(): number {
  const v = Number((Globals['getUiWidth'] as any)?.());
  return isFinite(v) && v > 0 ? v : 390;
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

// ── Custom Logic (workflow editor) ───────────────────────────────────────────
// Modeled on Bubble.io's Workflow tab. An object owns a LIST of workflows; each
// workflow is one EVENT (the trigger) plus an ordered list of numbered STEPS
// (actions) that run top-to-bottom when the event fires. Both the event and any
// individual step can carry an "Only when" guard list — AND-joined predicates
// that must hold for the event to start / the step to run. A disabled step is
// skipped without being deleted, and a disabled workflow never triggers.
//
// The React side owns the source of truth and mirrors the JSON to Unity through
// editorSetObjectLogic(objectId, graphJSON) — the engine compiles the workflows
// into live behavior on the selected object.
// Every trigger a workflow can listen for. Names follow Struckd's Muse Behavior
// "Conditions" — the same vocabulary is reused for mid-chain checks and guards.
type ConditionType =
  | 'onAim'                     // On Aim
  | 'onAttack'                  // On Attack
  | 'collision'                 // On Collision
  | 'onCollisionWithObject'     // On Collision with Object
  | 'onDamage'                  // On Damage
  | 'onDash'                    // On Dash
  | 'destroyed'                 // On Death
  | 'onDialog'                  // On Dialog
  | 'onDoor'                    // On Door
  | 'onEquip'                   // On Equip
  | 'gameStart'                 // On Game Start
  | 'onGround'                  // On Ground
  | 'onHealthRegen'             // On Health Regeneration
  | 'onInteract'                // On Interact
  | 'onInventoryChange'         // On Inventory change
  | 'onJump'                    // On Jump
  | 'onMount'                   // On Mount
  | 'onPickup'                  // On Pickup
  | 'enterZone'                 // On Proximity
  | 'onReload'                  // On Reload
  | 'onWeaponChange'            // On Weapon change
  | 'onWeaponScope';            // On Weapon Scope

// Every node that can sit in a workflow's step list, in the four families the
// palette groups them under.
type ActionType =
  // System
  | 'execute'                           // System · Execute
  // Action
  | 'addForce'                          // Action · Add Force
  | 'attachObject'                      // Action · Attach Object
  | 'cameraLookAt'                      // Action · Camera look at
  | 'changeBehavior'                    // Action · Change Behavior
  | 'changeCamera'                      // Action · Change Camera
  | 'changeDoor'                        // Action · Change Door
  | 'changeEnvironment'                 // Action · Change Environment
  | 'changeStat'                        // Action · Change Stat
  | 'changeTeam'                        // Action · Change Team
  | 'changeWeather'                     // Action · Change Weather
  | 'clearInventory'                    // Action · Clear Inventory
  | 'convertToString'                   // Action · Convert to string
  | 'dealDamage'                        // Action · Deal Damage
  | 'destroy'                           // Action · Destroy
  | 'detachObject'                      // Action · Detach Object
  | 'endGame'                           // Action · End Game
  | 'heal'                              // Action · Heal
  | 'endGameAsTeam'                     // Action · End Game as Team
  | 'lookAt'                            // Action · Look at
  | 'moveToObject'                      // Action · Move to Object
  | 'moveToVector'                      // Action · Move to Vector
  | 'playAnimation'                     // Action · Play Animation
  | 'playSound'                         // Action · Play Sound
  | 'position'                          // Action · Position
  | 'rotate'                            // Action · Rotate
  | 'scale'                             // Action · Scale
  | 'spawn'                             // Action · Spawn
  | 'spawnAtObject'                     // Action · Spawn at Object
  | 'startDialogue'                     // Action · Start Dialogue
  | 'textBubble'                        // Action · Text Bubble
  | 'textOnObject'                      // Action · Text on Object
  | 'showMessage'                       // Action · Text on Screen
  | 'toggleCollision'                   // Action · Toggle Collision
  | 'togglePhysics'                     // Action · Toggle Physics
  | 'toggleVisibility'                  // Action · Toggle Visibility
  | 'walkToObject'                      // Action · Walk to Object
  | 'walkToVector'                      // Action · Walk to Vector
  | 'check_onAim'                       // Condition · On Aim
  | 'check_onAttack'                    // Condition · On Attack
  | 'check_collision'                   // Condition · On Collision
  | 'check_onCollisionWithObject'       // Condition · On Collision with Object
  | 'check_onDamage'                    // Condition · On Damage
  | 'check_onDash'                      // Condition · On Dash
  | 'check_destroyed'                   // Condition · On Death
  | 'check_onDialog'                    // Condition · On Dialog
  | 'check_onDoor'                      // Condition · On Door
  | 'check_onEquip'                     // Condition · On Equip
  | 'check_gameStart'                   // Condition · On Game Start
  | 'check_onGround'                    // Condition · On Ground
  | 'check_onHealthRegen'               // Condition · On Health Regeneration
  | 'check_onInteract'                  // Condition · On Interact
  | 'check_onInventoryChange'           // Condition · On Inventory change
  | 'check_onJump'                      // Condition · On Jump
  | 'check_onMount'                     // Condition · On Mount
  | 'check_onPickup'                    // Condition · On Pickup
  | 'check_enterZone'                   // Condition · On Proximity
  | 'check_onReload'                    // Condition · On Reload
  | 'check_onWeaponChange'              // Condition · On Weapon change
  | 'check_onWeaponScope'               // Condition · On Weapon Scope
  | 'sequence'                          // Flow · Sequence
  | 'tryInOrder'                        // Flow · Try In Order
  | 'random'                            // Flow · Random
  | 'runInParallel'                     // Flow · Run In Parallel
  | 'runInParallelUntilAnyCompletes'    // Flow · Run In Parallel Until Any Completes
  | 'runInParallelUntilAnyFails'        // Flow · Run In Parallel Until Any Fails
  | 'runInParallelUntilAnySucceeds'     // Flow · Run In Parallel Until Any Succeeds
  | 'waitForAll'                        // Flow · Wait For All
  | 'waitForAny'                        // Flow · Wait For Any
  | 'repeat'                            // Flow · Repeat
  | 'repeatUntilSuccess'                // Flow · Repeat Until Success
  | 'repeatUntilFailure'                // Flow · Repeat Until Failure
  | 'repeatWhileCondition'              // Flow · Repeat While Condition
  | 'inverter'                          // Flow · Inverter
  | 'succeeder'                         // Flow · Succeeder
  | 'timeOut'                           // Flow · Time Out
  | 'setVariable'                       // Logic · Set Variable
  | 'addToString'                       // Logic · Add to string
  | 'math'                              // Logic · Math
  | 'randomFloat'                       // Logic · Random Float
  | 'ifCheck'                           // Logic · If
  | 'ifBranch'                          // Logic · If Branch
  | 'comparePoints'                     // Logic · Compare Points
  | 'awardPoints'                       // Logic · Set Points
  | 'getStat'                           // Logic · Get Stat
  | 'getEnvironment'                    // Logic · Get Environment
  | 'getObjectVector'                   // Logic · Get Object Vector
  | 'addVector'                         // Logic · Add Vector
  | 'multiplyVector'                    // Logic · Multiply Vector
  | 'randomVector'                      // Logic · Random Vector
  | 'getVectorElement'                  // Logic · Get Vector Element
  | 'setVectorElement'                  // Logic · Set Vector Element
  | 'saveAimDirection'                  // Logic · Save Aim Direction
  | 'saveDistance'                      // Logic · Save Distance
  | 'wait';                              // Logic · Wait

// Palette families. Order here is the order the palette renders them in.
type NodeGroup = 'System' | 'Action' | 'Condition' | 'Flow' | 'Logic';

type LogicField = {
  key: string;
  label: string;
  placeholder?: string;
  // 'vector' is one field holding "x,y,z" — it renders as a single X/Y/Z box
  // with one link button, the way Struckd shows a direction or an offset.
  kind?: 'text' | 'select' | 'toggle' | 'vector';
  options?: string[];
  hint?: string;
  // Struckd doesn't hang "(specific)" off every object slot — dialogue
  // partners, sound sources, spawn anchors and the like just take whatever
  // object you link, no "any vs this one" distinction to make.
  noSpecific?: boolean;
  // Toggle fields only: shows a 🔗 beside the switch so the boolean can be
  // bound to a variable instead of flipped by hand.
  linkable?: boolean;
};

// An "Only when" predicate. AND-joined with its siblings; `negate` flips it to
// "is not", mirroring Bubble's ability to invert a condition expression.
type LogicGuard = {
  id: string;
  type: ConditionType;
  negate: boolean;
  params: Record<string, string>;
};
// One numbered step in a workflow. `enabled: false` keeps the step in the
// canvas (greyed, struck through) but skips it at runtime.
type LogicStep = {
  id: string;
  type: ActionType;
  params: Record<string, string>;
  guards: LogicGuard[];
  enabled: boolean;
};
type LogicWorkflow = {
  id: string;
  name: string;                 // blank → the canvas falls back to the event label
  color: string;                // list-rail label color, Bubble's workflow colors
  enabled: boolean;
  event: { type: ConditionType; params: Record<string, string> };
  guards: LogicGuard[];         // event-level "Only when"
  steps: LogicStep[];
};
// ── Variables ───────────────────────────────────────────────────────────────
// A variable gives something in the scene a name the creator chose, so workflow
// fields can say {{Front Door}} instead of "Model_game-assets/v1/3b17…glb#e5".
// Three things can be named:
//   asset     — a top-level object in the scene (placed model or script object)
//   part      — an element connected to an asset (a child of that object)
//   interface — a HUD button from the Interface panel
// Variables live on the graph, so they travel with the object through
// editorSetObjectLogic → EditorObjectLogic → the editor-state autosave.
type LogicVarSource = 'asset' | 'part' | 'interface';
type LogicVariable = {
  id: string;
  name: string;            // the handle: {{name}}
  source: LogicVarSource;
  target: string;          // object name / child element name / HUD event name
  owner?: string;          // 'part' only — the asset the element hangs off
};
type LogicGraph = { workflows: LogicWorkflow[]; variables: LogicVariable[] };

const DEFAULT_LOGIC_GRAPH: LogicGraph = { workflows: [], variables: [] };

const VAR_SOURCE_META: Record<LogicVarSource, { label: string; icon: string; accent: string }> = {
  asset:     { label: 'Asset',     icon: 'view_in_ar',   accent: '#5B9CFF' },
  part:      { label: 'Element',   icon: 'account_tree', accent: '#c084fc' },
  interface: { label: 'Interface', icon: 'smart_button', accent: '#34d399' },
};

// Bubble tags workflows with one of eight colors so the list rail is scannable.
const WORKFLOW_COLORS = ['#5B9CFF', '#34d399', '#fcd34d', '#f87171', '#c084fc', '#22d3ee', '#fb923c', '#94a3b8'];

// ── Event catalog (what starts a workflow) ──────────────────────────────────
// Modelled on Struckd's Muse Behavior "Conditions" — every trigger is an
// "On <something>" the game raises. The same vocabulary doubles as mid-chain
// checks (the Condition family in the node palette) and as "Only when" guards,
// so one set of names covers the whole wire format.
const EVENT_CATALOG: {
  type: ConditionType; label: string; icon: string; category: string;
  summary: (p: Record<string, string>) => string;
  fields: LogicField[];
}[] = [
  {
    type: 'onAim', label: 'On Aim', icon: 'gps_fixed', category: 'Combat',
    summary: () => 'When the player aims a weapon',
    fields: [],
  },
  {
    type: 'onAttack', label: 'On Attack', icon: 'sports_martial_arts', category: 'Combat',
    summary: () => 'When this object attacks',
    fields: [],
  },
  {
    type: 'collision', label: 'On Collision', icon: 'compare_arrows', category: 'Contact',
    summary: () => 'When this object collides with anything',
    fields: [
      { key: 'tag', label: 'With tag', placeholder: 'Player' },
    ],
  },
  {
    type: 'onCollisionWithObject', label: 'On Collision with Object', icon: 'merge_type', category: 'Contact',
    summary: () => 'When this object collides with a specific object',
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'onDamage', label: 'On Damage', icon: 'heart_broken', category: 'Combat',
    summary: () => 'When this object takes damage',
    fields: [],
  },
  {
    type: 'onDash', label: 'On Dash', icon: 'bolt', category: 'Movement',
    summary: () => 'When the player dashes',
    fields: [],
  },
  {
    type: 'destroyed', label: 'On Death', icon: 'dangerous', category: 'State',
    summary: () => 'When this object dies or is destroyed',
    fields: [],
  },
  {
    type: 'onDialog', label: 'On Dialog', icon: 'forum', category: 'Interaction',
    summary: () => 'When a dialogue starts',
    fields: [],
  },
  {
    type: 'onDoor', label: 'On Door', icon: 'door_front', category: 'Interaction',
    summary: () => 'When a door opens or closes',
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'onEquip', label: 'On Equip', icon: 'inventory_2', category: 'Interaction',
    summary: () => 'When an item is equipped',
    fields: [
      { key: 'item', label: 'Item', placeholder: 'Sword' },
    ],
  },
  {
    type: 'gameStart', label: 'On Game Start', icon: 'play_circle', category: 'State',
    summary: () => 'When the game starts',
    fields: [],
  },
  {
    type: 'onGround', label: 'On Ground', icon: 'terrain', category: 'Movement',
    summary: () => 'When the object lands on the ground',
    fields: [],
  },
  {
    type: 'onHealthRegen', label: 'On Health Regeneration', icon: 'healing', category: 'State',
    summary: () => 'When this object regenerates health',
    fields: [],
  },
  {
    type: 'onInteract', label: 'On Interact', icon: 'touch_app', category: 'Interaction',
    summary: () => 'When the player interacts with the object',
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'onInventoryChange', label: 'On Inventory change', icon: 'inventory', category: 'State',
    summary: () => 'When the inventory contents change',
    fields: [],
  },
  {
    type: 'onJump', label: 'On Jump', icon: 'trending_up', category: 'Movement',
    summary: () => 'When the player jumps',
    fields: [],
  },
  {
    type: 'onMount', label: 'On Mount', icon: 'two_wheeler', category: 'Movement',
    summary: () => 'When the player mounts a vehicle or animal',
    fields: [],
  },
  {
    type: 'onPickup', label: 'On Pickup', icon: 'back_hand', category: 'Interaction',
    summary: () => 'When an item is picked up',
    fields: [
      { key: 'item', label: 'Item', placeholder: 'Coin' },
    ],
  },
  {
    type: 'enterZone', label: 'On Proximity', icon: 'sensors', category: 'Contact',
    summary: () => 'When the player comes within range',
    fields: [
      { key: 'range', label: 'Range', placeholder: '5' },
    ],
  },
  {
    type: 'onReload', label: 'On Reload', icon: 'autorenew', category: 'Combat',
    summary: () => 'When a weapon is reloaded',
    fields: [],
  },
  {
    type: 'onWeaponChange', label: 'On Weapon change', icon: 'swap_horiz', category: 'Combat',
    summary: () => 'When the equipped weapon changes',
    fields: [],
  },
  {
    type: 'onWeaponScope', label: 'On Weapon Scope', icon: 'center_focus_strong', category: 'Combat',
    summary: () => 'When the player scopes in',
    fields: [],
  },
];

// ── Guard catalog ("Only when") ─────────────────────────────────────────────
// State predicates only — an event fires at an instant, a guard has to be
// answerable at any instant. Same ConditionType union as events so the wire
// format stays one vocabulary end to end.
const GUARD_CATALOG: {
  type: ConditionType; label: string; icon: string;
  summary: (p: Record<string, string>, negate: boolean) => string;
  fields: LogicField[];
}[] = [
  {
    type: 'onGround', label: 'On Ground', icon: 'terrain',
    summary: (_p, n) => n ? 'Not: the object is on the ground' : 'The object is on the ground',
    fields: [],
  },
  {
    type: 'enterZone', label: 'On Proximity', icon: 'sensors',
    summary: (_p, n) => n ? 'Not: the player is within range' : 'The player is within range',
    fields: [
      { key: 'range', label: 'Range', placeholder: '5' },
    ],
  },
  {
    type: 'onMount', label: 'On Mount', icon: 'two_wheeler',
    summary: (_p, n) => n ? 'Not: the player is mounted' : 'The player is mounted',
    fields: [],
  },
  {
    type: 'onWeaponScope', label: 'On Weapon Scope', icon: 'center_focus_strong',
    summary: (_p, n) => n ? 'Not: the player is scoped in' : 'The player is scoped in',
    fields: [],
  },
  {
    type: 'onAim', label: 'On Aim', icon: 'gps_fixed',
    summary: (_p, n) => n ? 'Not: the player is aiming' : 'The player is aiming',
    fields: [],
  },
  {
    type: 'destroyed', label: 'On Death', icon: 'dangerous',
    summary: (_p, n) => n ? 'Not: this object is dead' : 'This object is dead',
    fields: [],
  },
  {
    type: 'collision', label: 'On Collision', icon: 'compare_arrows',
    summary: (_p, n) => n ? 'Not: this object is touching something' : 'This object is touching something',
    fields: [
      { key: 'tag', label: 'With tag', placeholder: 'Player' },
    ],
  },
  {
    type: 'onCollisionWithObject', label: 'On Collision with Object', icon: 'merge_type',
    summary: (_p, n) => n ? 'Not: this object is touching that object' : 'This object is touching that object',
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'onDialog', label: 'On Dialog', icon: 'forum',
    summary: (_p, n) => n ? 'Not: a dialogue is open' : 'A dialogue is open',
    fields: [],
  },
  {
    type: 'onDoor', label: 'On Door', icon: 'door_front',
    summary: (_p, n) => n ? 'Not: the door is open' : 'The door is open',
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'onEquip', label: 'On Equip', icon: 'inventory_2',
    summary: (_p, n) => n ? 'Not: the item is equipped' : 'The item is equipped',
    fields: [
      { key: 'item', label: 'Item', placeholder: 'Sword' },
    ],
  },
  {
    type: 'gameStart', label: 'On Game Start', icon: 'play_circle',
    summary: (_p, n) => n ? 'Not: the game has started' : 'The game has started',
    fields: [],
  },
];

// ── Node catalog (everything the "+" palette can insert) ────────────────────
// The four families mirror Struckd's Muse Behavior palette: Action (changes the
// world), Condition (gates the rest of the chain), Flow (behaviour-tree control
// nodes) and Logic (reads and writes variables). `group` is the palette's
// top-level family, `category` the caption inside it.
const ACTION_CATALOG: {
  type: ActionType; label: string; icon: string; group: NodeGroup; category: string;
  // The node's inline sentence. `{key}` slots are replaced by live controls on
  // the canvas — this is how a node is edited, Struckd-style, without a panel.
  template: string;
  summary: (p: Record<string, string>) => string;
  fields: LogicField[];
}[] = [
  // ── System ──────────────────────────────────────────────────────────────
  {
    type: 'execute', label: 'Execute', icon: 'play_circle', group: 'System', category: 'Root',
    template: 'Execute',
    summary: () => 'Start of the workflow',
    fields: [
      { key: 'repeat', label: 'Repeat', kind: 'toggle', hint: 'Run the tree again as soon as it finishes.' },
    ],
  },

  // ── Action ──────────────────────────────────────────────────────────────
  {
    type: 'addForce', label: 'Add Force', icon: 'rocket_launch', group: 'Action', category: 'Physics',
    template: 'Force {target} to move in direction of {direction}',
    summary: p => `Force ${p.target || 'this object'} in direction (${p.direction || '0,0,0'})`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'direction', label: 'Direction', kind: 'vector' },
    ],
  },
  {
    type: 'attachObject', label: 'Attach Object', icon: 'attach_file', group: 'Action', category: 'Object',
    template: 'Attach {target} to {parent} and set local position to {offset}',
    summary: p => `Attach ${p.target || 'an object'} to ${p.parent || 'another object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object' },
      { key: 'parent', label: 'Attach to', placeholder: 'Parent' },
      { key: 'offset', label: 'Local position', kind: 'vector' },
    ],
  },
  {
    type: 'cameraLookAt', label: 'Camera look at', icon: 'videocam', group: 'Action', category: 'Camera',
    template: 'Camera look at {target} for {seconds} seconds',
    summary: p => `Camera looks at ${p.target || 'this object'} for ${p.seconds || '0'}s`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'seconds', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'changeBehavior', label: 'Change Behavior', icon: 'psychology', group: 'Action', category: 'Character',
    template: 'Change {target} behavior to {state}',
    summary: p => `Behaviour of ${p.target || 'this object'} becomes ${p.state || 'Default'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Character' },
      { key: 'state', label: 'Behaviour', kind: 'select', options: ['Default', 'Guard', 'Follow', 'Flee', 'Wander'] },
    ],
  },
  {
    type: 'changeCamera', label: 'Change Camera', icon: 'switch_video', group: 'Action', category: 'Camera',
    template: 'Change {target} camera to {view}',
    summary: p => `Camera becomes ${p.view || 'Third Person'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Character' },
      { key: 'view', label: 'View', kind: 'select', options: ['First Person', 'Third Person', 'Top Down'] },
    ],
  },
  {
    type: 'changeDoor', label: 'Change Door', icon: 'door_front', group: 'Action', category: 'World',
    template: 'Change {target} door to {state}',
    summary: p => `${p.state || 'Open'} ${p.target || 'the door'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'state', label: 'State', kind: 'select', options: ['Open', 'Close'] },
    ],
  },
  {
    type: 'changeEnvironment', label: 'Change Environment', icon: 'public', group: 'Action', category: 'World',
    template: 'Change {setting} {mode} {value}',
    summary: p => `Change ${p.setting || 'Gravity'} ${p.mode || 'to'} ${p.value || '0'}`,
    fields: [
      { key: 'setting', label: 'Setting', kind: 'select', options: ['Gravity', 'Light Intensity', 'Fog Density', 'Ambient Light'] },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'value', label: 'Value', placeholder: '0' },
    ],
  },
  {
    type: 'changeStat', label: 'Change Stat', icon: 'tune', group: 'Action', category: 'Character',
    template: 'Change {stat} of {target} {mode} {value}',
    summary: p => `Change ${p.stat || 'Health'} of ${p.target || 'this object'} ${p.mode || 'to'} ${p.value || '0'}`,
    fields: [
      { key: 'stat', label: 'Stat', kind: 'select', options: ['Health', 'Score', 'Movement Speed', 'Jump Height'] },
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'value', label: 'Value', placeholder: '0' },
    ],
  },
  {
    type: 'changeTeam', label: 'Change Team', icon: 'groups', group: 'Action', category: 'Character',
    template: 'Change {target} team to {team}',
    summary: p => `${p.target || 'This object'} joins the ${p.team || 'Neutral'} team`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Agent', noSpecific: true },
      { key: 'team', label: 'Team', kind: 'select', options: ['Neutral', 'Blue', 'Red', 'Orange', 'Green'] },
    ],
  },
  {
    type: 'changeWeather', label: 'Change Weather', icon: 'cloud', group: 'Action', category: 'World',
    template: 'Change weather to {weather}',
    summary: p => `Weather becomes ${p.weather || 'Clear'}`,
    fields: [
      { key: 'weather', label: 'Weather', kind: 'select', options: ['Clear', 'Cloudy', 'Overcast', 'Foggy', 'Stormy'] },
    ],
  },
  {
    type: 'clearInventory', label: 'Clear Inventory', icon: 'remove_shopping_cart', group: 'Action', category: 'Inventory',
    template: 'Clears the inventory of {target}',
    summary: p => `Clears the inventory of ${p.target || 'the player'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'convertToString', label: 'Convert to string', icon: 'text_fields', group: 'Action', category: 'Interface',
    template: 'Store {value} as text in {variable}',
    summary: p => `Store ${p.value || 'a value'} as text in ${p.variable || 'variable'}`,
    fields: [
      { key: 'value', label: 'Value or variable', placeholder: 'score' },
      { key: 'variable', label: 'Save to variable', placeholder: 'scoreText' },
    ],
  },
  {
    type: 'dealDamage', label: 'Deal Damage', icon: 'heart_broken', group: 'Action', category: 'Combat',
    template: '{target} takes {amount} damage',
    summary: p => `${p.target || 'This object'} takes ${p.amount || '0'} damage`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'amount', label: 'Damage', placeholder: '0' },
    ],
  },
  {
    type: 'heal', label: 'Heal', icon: 'healing', group: 'Action', category: 'Combat',
    template: '{target} is healed by {amount}',
    summary: p => `${p.target || 'This object'} is healed by ${p.amount || '0'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'amount', label: 'Amount', placeholder: '0' },
    ],
  },
  {
    type: 'destroy', label: 'Destroy', icon: 'delete_forever', group: 'Action', category: 'Object',
    template: 'Destroy {target}',
    summary: p => `Destroy ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'detachObject', label: 'Detach Object', icon: 'link_off', group: 'Action', category: 'Object',
    template: 'Detach {target}',
    summary: p => `Detach ${p.target || 'the attached object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
    ],
  },
  {
    type: 'endGame', label: 'End Game', icon: 'flag', group: 'Action', category: 'Game',
    template: 'End Game and {outcome}',
    summary: p => `End the game — ${p.outcome || 'Win'}`,
    fields: [
      { key: 'outcome', label: 'Outcome', kind: 'select', options: ['Win', 'Lose'] },
    ],
  },
  {
    type: 'endGameAsTeam', label: 'End Game as Team', icon: 'emoji_events', group: 'Action', category: 'Game',
    template: 'End Game as {team} Team and {outcome}',
    summary: p => `Team ${p.team || 'Neutral'} ${p.outcome || 'Win'}s the game`,
    fields: [
      { key: 'team', label: 'Team', kind: 'select', options: ['Neutral', 'Blue', 'Red', 'Orange', 'Green'] },
      { key: 'outcome', label: 'Outcome', kind: 'select', options: ['Win', 'Lose'] },
    ],
  },
  {
    type: 'lookAt', label: 'Look at', icon: 'visibility', group: 'Action', category: 'Character',
    template: 'Look at {target}',
    summary: p => `Look at ${p.target || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
    ],
  },
  {
    type: 'moveToObject', label: 'Move to Object', icon: 'my_location', group: 'Action', category: 'Movement',
    template: 'Move {target} towards {to} with {speed} speed',
    summary: p => `Move ${p.target || 'this object'} towards ${p.to || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'to', label: 'Towards', placeholder: 'Object', noSpecific: true },
      { key: 'speed', label: 'Speed', placeholder: '0' },
    ],
  },
  {
    type: 'moveToVector', label: 'Move to Vector', icon: 'near_me', group: 'Action', category: 'Movement',
    template: 'Move {target} {mode} {position} with {speed} speed',
    summary: p => `Move ${p.target || 'this object'} ${p.mode || 'to'} (${p.position || '0,0,0'})`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'position', label: 'Position', kind: 'vector' },
      { key: 'speed', label: 'Speed', placeholder: '0' },
    ],
  },
  {
    type: 'playAnimation', label: 'Play Animation', icon: 'directions_run', group: 'Action', category: 'Character',
    template: 'Play {target} {animation} animation',
    summary: p => `Play the ${p.animation || 'Idle'} animation on ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'animation', label: 'Animation', kind: 'select', options: ['Idle', 'Jump', 'Attack', 'Take Damage', 'Die'] },
    ],
  },
  {
    type: 'playSound', label: 'Play Sound', icon: 'volume_up', group: 'Action', category: 'Audio',
    template: 'Play {name} on object {target}',
    summary: p => `Play ${p.name || 'Pickup'} on ${p.target || 'this object'}`,
    fields: [
      { key: 'name', label: 'Sound', kind: 'select', options: ['Jump', 'Pickup', 'Hit', 'Win', 'Lose', 'Explosion', 'Footstep', 'Ambient Forest', 'Ambient Cave', 'Ambient Space'] },
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
    ],
  },
  {
    type: 'position', label: 'Position', icon: 'place', group: 'Action', category: 'Movement',
    template: 'Position {target} {mode} {position} in {duration} seconds',
    summary: p => `Position ${p.target || 'this object'} ${p.mode || 'to'} (${p.position || '0,0,0'})`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'position', label: 'Position', kind: 'vector' },
      { key: 'duration', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'rotate', label: 'Rotate', icon: 'rotate_right', group: 'Action', category: 'Movement',
    template: 'Rotate {target} {mode} {rotation} degree in {duration} seconds',
    summary: p => `Rotate ${p.target || 'this object'} ${p.mode || 'to'} (${p.rotation || '0,0,0'}) degrees`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'rotation', label: 'Rotation', kind: 'vector' },
      { key: 'duration', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'scale', label: 'Scale', icon: 'aspect_ratio', group: 'Action', category: 'Object',
    template: 'Scale {target} {mode} {scale} scale in {duration} seconds',
    summary: p => `Scale ${p.target || 'this object'} ${p.mode || 'to'} (${p.scale || '0,0,0'})`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'scale', label: 'Scale', kind: 'vector' },
      { key: 'duration', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'spawn', label: 'Spawn', icon: 'add_circle', group: 'Action', category: 'Object',
    template: 'Spawn an {asset} at the position {position} and set {variable} as the newly created asset',
    summary: p => `Spawn ${p.asset || 'an object'} and store it in ${p.variable || 'a variable'}`,
    fields: [
      { key: 'asset', label: 'Object', placeholder: 'Coin', noSpecific: true },
      { key: 'position', label: 'Position', kind: 'vector' },
      { key: 'variable', label: 'Save to variable', placeholder: 'Reference' },
    ],
  },
  {
    type: 'spawnAtObject', label: 'Spawn at Object', icon: 'control_point_duplicate', group: 'Action', category: 'Object',
    template: 'Spawn an {asset} at an {target} with offset {offset} and set {variable} as the newly created asset',
    summary: p => `Spawn ${p.asset || 'an object'} at ${p.target || 'an object'} and store it in ${p.variable || 'a variable'}`,
    fields: [
      { key: 'asset', label: 'Object', placeholder: 'Coin', noSpecific: true },
      { key: 'target', label: 'Object', placeholder: 'Agent', noSpecific: true },
      { key: 'offset', label: 'Offset', kind: 'vector' },
      { key: 'variable', label: 'Save to variable', placeholder: 'Reference' },
    ],
  },
  {
    type: 'startDialogue', label: 'Start Dialogue', icon: 'forum', group: 'Action', category: 'Interface',
    template: 'Start dialogue with {target}',
    summary: p => `Start dialogue with ${p.target || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
    ],
  },
  {
    type: 'textBubble', label: 'Text Bubble', icon: 'chat_bubble', group: 'Action', category: 'Interface',
    template: 'Show speech bubble for {target} with text {text} and duration {seconds}',
    summary: p => `Bubble "${p.text || 'Hello'}" above ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
      { key: 'text', label: 'Text or variable', placeholder: 'Hello!' },
      { key: 'seconds', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'textOnObject', label: 'Text on Object', icon: 'title', group: 'Action', category: 'Interface',
    template: 'Change text of {target} to {text}',
    summary: p => `Change text of ${p.target || 'a text object'} to "${p.text || '…'}"`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'text', label: 'Text or variable', placeholder: 'Score: 0' },
    ],
  },
  {
    type: 'showMessage', label: 'Text on Screen', icon: 'chat', group: 'Action', category: 'Interface',
    template: 'Show text {text} on screen for {seconds} seconds',
    summary: p => `Show "${p.text || 'message'}" for ${p.seconds || '0'}s`,
    fields: [
      { key: 'text', label: 'Text or variable', placeholder: 'Level cleared!' },
      { key: 'seconds', label: 'Seconds', placeholder: '0' },
    ],
  },
  {
    type: 'toggleCollision', label: 'Toggle Collision', icon: 'blur_on', group: 'Action', category: 'Physics',
    template: 'Toggle {target} collision to {on}',
    summary: p => `Collision ${p.on === 'true' ? 'on' : 'off'} for ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'on', label: '', kind: 'toggle', linkable: true, hint: 'Off makes the object non-solid — things pass through it.' },
    ],
  },
  {
    type: 'togglePhysics', label: 'Toggle Physics', icon: 'speed', group: 'Action', category: 'Physics',
    template: 'Toggle {target} physics to {on}',
    summary: p => `Physics ${p.on === 'true' ? 'on' : 'off'} for ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'on', label: '', kind: 'toggle', linkable: true, hint: 'Off freezes the object in place — no gravity, no forces.' },
    ],
  },
  {
    type: 'toggleVisibility', label: 'Toggle Visibility', icon: 'visibility_off', group: 'Action', category: 'Object',
    template: 'Toggle {target} visibility to {on}',
    summary: p => `${p.on === 'true' ? 'Show' : 'Hide'} ${p.target || 'this object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'on', label: '', kind: 'toggle', linkable: true, hint: 'Hidden objects are still in the scene and can still collide.' },
    ],
  },
  {
    type: 'walkToObject', label: 'Walk to Object', icon: 'directions_walk', group: 'Action', category: 'Movement',
    template: '{target} walks toward {to} with {speed} speed',
    summary: p => `${p.target || 'This object'} walks toward ${p.to || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'to', label: 'Towards', placeholder: 'Object', noSpecific: true },
      { key: 'speed', label: 'Speed', placeholder: '0' },
    ],
  },
  {
    type: 'walkToVector', label: 'Walk to Vector', icon: 'directions', group: 'Action', category: 'Movement',
    template: '{target} walks {mode} {position} with {speed} speed',
    summary: p => `${p.target || 'This object'} walks ${p.mode || 'to'} (${p.position || '0,0,0'})`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['to', 'by'] },
      { key: 'position', label: 'Position', kind: 'vector' },
      { key: 'speed', label: 'Speed', placeholder: '0' },
    ],
  },

  // ── Condition — the event vocabulary, checked mid-chain ──────────────────
  {
    type: 'check_onAim', label: 'On Aim', icon: 'gps_fixed', group: 'Condition', category: 'Combat',
    template: 'When {target} is aiming at {to}',
    summary: p => `When ${p.target || 'this object'} is aiming at ${p.to || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
      { key: 'to', label: 'At', placeholder: 'Object' },
    ],
  },
  {
    type: 'check_onAttack', label: 'On Attack', icon: 'sports_martial_arts', group: 'Condition', category: 'Combat',
    template: 'When {target} attacks',
    summary: p => `When ${p.target || 'this object'} attacks`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_collision', label: 'On Collision', icon: 'compare_arrows', group: 'Condition', category: 'Contact',
    template: 'When {target} is colliding',
    summary: p => `When ${p.target || 'this object'} is colliding`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onCollisionWithObject', label: 'On Collision with Object', icon: 'merge_type', group: 'Condition', category: 'Contact',
    template: 'When {target} is colliding with {to}',
    summary: p => `When ${p.target || 'this object'} is colliding with ${p.to || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'to', label: 'With', placeholder: 'Object' },
    ],
  },
  {
    type: 'check_onDamage', label: 'On Damage', icon: 'heart_broken', group: 'Condition', category: 'Combat',
    template: 'When {target} {mode} damage',
    summary: p => `When ${p.target || 'this object'} ${p.mode || 'takes'} damage`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['deals', 'takes'] },
    ],
  },
  {
    type: 'check_onDash', label: 'On Dash', icon: 'bolt', group: 'Condition', category: 'Movement',
    template: 'When {target} dashes',
    summary: p => `When ${p.target || 'this object'} dashes`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_destroyed', label: 'On Death', icon: 'dangerous', group: 'Condition', category: 'State',
    template: 'When {target} dies',
    summary: p => `When ${p.target || 'this object'} dies`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onDialog', label: 'On Dialog', icon: 'forum', group: 'Condition', category: 'Interaction',
    template: 'When {target} dialogue {mode}',
    summary: p => `When ${p.target || 'this object'}'s dialogue ${p.mode || 'starts'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['starts', 'ends'] },
    ],
  },
  {
    type: 'check_onDoor', label: 'On Door', icon: 'door_front', group: 'Condition', category: 'Interaction',
    template: 'When {target} door {state}',
    summary: p => `When ${p.target || 'the'} door ${p.state || 'open'}s`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target', noSpecific: true },
      { key: 'state', label: 'State', kind: 'select', options: ['open', 'close'] },
    ],
  },
  {
    type: 'check_onEquip', label: 'On Equip', icon: 'inventory_2', group: 'Condition', category: 'Interaction',
    template: 'When {target} {mode} an item',
    summary: p => `When ${p.target || 'this object'} ${p.mode || 'equip'}s an item`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['equip', 'unequip'] },
    ],
  },
  {
    type: 'check_gameStart', label: 'On Game Start', icon: 'play_circle', group: 'Condition', category: 'State',
    template: 'When game starts',
    summary: p => `When the game starts`,
    fields: [],
  },
  {
    type: 'check_onGround', label: 'On Ground', icon: 'terrain', group: 'Condition', category: 'Movement',
    template: 'When {target} becomes {state}',
    summary: p => `When ${p.target || 'this object'} becomes ${p.state || 'grounded'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'state', label: 'State', kind: 'select', options: ['grounded', 'airborne'] },
    ],
  },
  {
    type: 'check_onHealthRegen', label: 'On Health Regeneration', icon: 'healing', group: 'Condition', category: 'State',
    template: 'When {target} regenerates health',
    summary: p => `When ${p.target || 'this object'} regenerates health`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onInteract', label: 'On Interact', icon: 'touch_app', group: 'Condition', category: 'Interaction',
    template: 'When {mode} with {target}',
    summary: p => `When the player ${p.mode || 'tap'}s ${p.target || 'this object'}`,
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['tap', 'hold'] },
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onInventoryChange', label: 'On Inventory change', icon: 'inventory', group: 'Condition', category: 'State',
    template: 'When the inventory is {mode}',
    summary: p => `When the inventory is ${p.mode || 'opened'}`,
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['opened', 'closed'] },
    ],
  },
  {
    type: 'check_onJump', label: 'On Jump', icon: 'trending_up', group: 'Condition', category: 'Movement',
    template: 'When {target} jumps',
    summary: p => `When ${p.target || 'this object'} jumps`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onMount', label: 'On Mount', icon: 'two_wheeler', group: 'Condition', category: 'Movement',
    template: 'When {target} {mode}',
    summary: p => `When ${p.target || 'this object'} ${p.mode || 'mounts'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['mounts', 'dismounts'] },
    ],
  },
  {
    type: 'check_onPickup', label: 'On Pickup', icon: 'back_hand', group: 'Condition', category: 'Interaction',
    template: 'When {target} is picked up',
    summary: p => `When ${p.target || 'this object'} is picked up`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_enterZone', label: 'On Proximity', icon: 'sensors', group: 'Condition', category: 'Contact',
    template: '{target} is closer than {range} to {to}',
    summary: p => `${p.target || 'This object'} is closer than ${p.range || '0'} to ${p.to || 'an object'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'range', label: 'Range', placeholder: '0' },
      { key: 'to', label: 'To', placeholder: 'Object' },
    ],
  },
  {
    type: 'check_onReload', label: 'On Reload', icon: 'autorenew', group: 'Condition', category: 'Combat',
    template: 'When {target} reloads their weapon',
    summary: p => `When ${p.target || 'this object'} reloads their weapon`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onWeaponChange', label: 'On Weapon change', icon: 'swap_horiz', group: 'Condition', category: 'Combat',
    template: 'When {target} changes weapon',
    summary: p => `When ${p.target || 'this object'} changes weapon`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
    ],
  },
  {
    type: 'check_onWeaponScope', label: 'On Weapon Scope', icon: 'center_focus_strong', group: 'Condition', category: 'Combat',
    template: 'When {target} {mode}',
    summary: p => `When ${p.target || 'this object'} ${p.mode || 'scopes'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Target' },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['scopes', 'unscopes'] },
    ],
  },

  // ── Flow — behaviour-tree control, straight from Muse Behavior ───────────
  {
    type: 'sequence', label: 'Sequence', icon: 'format_list_numbered', group: 'Flow', category: 'Order',
    template: 'Run the nodes below in order until one fails',
    summary: () => 'Run the nodes below in order until one fails',
    fields: [],
  },
  {
    type: 'tryInOrder', label: 'Try In Order', icon: 'alt_route', group: 'Flow', category: 'Order',
    template: 'Run the nodes below until one succeeds',
    summary: () => 'Run the nodes below until one succeeds',
    fields: [],
  },
  {
    type: 'random', label: 'Random', icon: 'shuffle', group: 'Flow', category: 'Order',
    template: 'Run one of the branches below at random',
    summary: () => 'Run one of the branches below at random',
    fields: [],
  },
  {
    type: 'runInParallel', label: 'Run In Parallel', icon: 'call_split', group: 'Flow', category: 'Parallel',
    template: 'Run every branch below at the same time',
    summary: () => 'Run every branch below at the same time',
    fields: [],
  },
  {
    type: 'runInParallelUntilAnyCompletes', label: 'Run In Parallel Until Any Completes', icon: 'call_split', group: 'Flow', category: 'Parallel',
    template: 'Run in parallel, stop when any branch finishes',
    summary: () => 'Run in parallel, stop when any branch finishes',
    fields: [],
  },
  {
    type: 'runInParallelUntilAnyFails', label: 'Run In Parallel Until Any Fails', icon: 'call_split', group: 'Flow', category: 'Parallel',
    template: 'Run in parallel, stop when any branch fails',
    summary: () => 'Run in parallel, stop when any branch fails',
    fields: [],
  },
  {
    type: 'runInParallelUntilAnySucceeds', label: 'Run In Parallel Until Any Succeeds', icon: 'call_split', group: 'Flow', category: 'Parallel',
    template: 'Run in parallel, stop when any branch succeeds',
    summary: () => 'Run in parallel, stop when any branch succeeds',
    fields: [],
  },
  {
    type: 'waitForAll', label: 'Wait For All', icon: 'merge', group: 'Flow', category: 'Parallel',
    template: 'Wait until every incoming branch arrives',
    summary: () => 'Wait until every incoming branch arrives',
    fields: [],
  },
  {
    type: 'waitForAny', label: 'Wait For Any', icon: 'merge_type', group: 'Flow', category: 'Parallel',
    template: 'Carry on as soon as any branch arrives',
    summary: () => 'Carry on as soon as any branch arrives',
    fields: [],
  },
  {
    type: 'repeat', label: 'Repeat', icon: 'repeat', group: 'Flow', category: 'Repetition',
    template: 'Repeat the nodes below {times}x',
    summary: p => `Repeat the nodes below ${p.times || '3'}x`,
    fields: [
      { key: 'times', label: 'Times', placeholder: '3' },
    ],
  },
  {
    type: 'repeatUntilSuccess', label: 'Repeat Until Success', icon: 'repeat_one', group: 'Flow', category: 'Repetition',
    template: 'Repeat the nodes below until they succeed',
    summary: () => 'Repeat the nodes below until they succeed',
    fields: [],
  },
  {
    type: 'repeatUntilFailure', label: 'Repeat Until Failure', icon: 'repeat_on', group: 'Flow', category: 'Repetition',
    template: 'Repeat the nodes below until they fail',
    summary: () => 'Repeat the nodes below until they fail',
    fields: [],
  },
  {
    type: 'repeatWhileCondition', label: 'Repeat While Condition', icon: 'sync', group: 'Flow', category: 'Repetition',
    template: 'Repeat while {condition} is true',
    summary: p => `Repeat while ${p.condition || 'the condition'} is true`,
    fields: [
      { key: 'condition', label: 'Condition or variable', placeholder: 'doorOpen' },
    ],
  },
  {
    type: 'inverter', label: 'Inverter', icon: 'change_circle', group: 'Flow', category: 'Result',
    template: 'Flip the result of the node below',
    summary: () => 'Flip the result of the node below',
    fields: [],
  },
  {
    type: 'succeeder', label: 'Succeeder', icon: 'check_circle', group: 'Flow', category: 'Result',
    template: 'Always report success',
    summary: () => 'Always report success',
    fields: [],
  },
  {
    type: 'timeOut', label: 'Time Out', icon: 'hourglass_bottom', group: 'Flow', category: 'Result',
    template: 'Give up after {frames} frames',
    summary: p => `Give up after ${p.frames || '60'} frames`,
    fields: [
      { key: 'frames', label: 'Frames', placeholder: '60' },
    ],
  },

  // ── Logic ───────────────────────────────────────────────────────────────
  {
    type: 'setVariable', label: 'Set Variable', icon: 'data_object', group: 'Logic', category: 'Variables',
    template: 'Set {name} to {value}',
    summary: p => `Set ${p.name || 'variable'} to ${p.value || '0'}`,
    fields: [
      { key: 'name', label: 'Variable', placeholder: 'doorOpen' },
      { key: 'value', label: 'Value', placeholder: 'true' },
    ],
  },
  {
    type: 'addToString', label: 'Add to string', icon: 'text_fields', group: 'Logic', category: 'Variables',
    template: 'Append “{text}” to {name}',
    summary: p => `Append “${p.text || '…'}” to ${p.name || 'a string'}`,
    fields: [
      { key: 'name', label: 'String variable', placeholder: 'message' },
      { key: 'text', label: 'Text to add', placeholder: ' points' },
    ],
  },
  {
    type: 'math', label: 'Math', icon: 'calculate', group: 'Logic', category: 'Math',
    template: '{variable} = {left} {op} {right}',
    summary: p => `${p.variable || 'result'} = ${p.left || 'a'} ${p.op || '+'} ${p.right || 'b'}`,
    fields: [
      { key: 'left', label: 'Left', placeholder: 'score' },
      { key: 'op', label: 'Operation', kind: 'select', options: ['+', '-', '×', '÷'] },
      { key: 'right', label: 'Right', placeholder: '10' },
      { key: 'variable', label: 'Save to variable', placeholder: 'score' },
    ],
  },
  {
    type: 'randomFloat', label: 'Random Float', icon: 'casino', group: 'Logic', category: 'Math',
    template: '{variable} = random {min}–{max}',
    summary: p => `${p.variable || 'roll'} = random ${p.min || '0'}–${p.max || '1'}`,
    fields: [
      { key: 'min', label: 'Minimum', placeholder: '0' },
      { key: 'max', label: 'Maximum', placeholder: '1' },
      { key: 'variable', label: 'Save to variable', placeholder: 'roll' },
    ],
  },
  {
    type: 'ifCheck', label: 'If', icon: 'rule', group: 'Logic', category: 'Branching',
    template: 'Continue only if {left} {op} {right}',
    summary: p => `Continue only if ${p.left || 'a'} ${p.op || '='} ${p.right || 'b'}`,
    fields: [
      { key: 'left', label: 'Left', placeholder: 'score' },
      { key: 'op', label: 'Operator', kind: 'select', options: ['=', '!=', '>', '<', '>=', '<='] },
      { key: 'right', label: 'Right', placeholder: '10' },
    ],
  },
  {
    type: 'ifBranch', label: 'If Branch', icon: 'alt_route', group: 'Logic', category: 'Branching',
    template: 'Branch on {left} {op} {right}',
    summary: p => `Branch on ${p.left || 'a'} ${p.op || '='} ${p.right || 'b'}`,
    fields: [
      { key: 'left', label: 'Left', placeholder: 'score' },
      { key: 'op', label: 'Operator', kind: 'select', options: ['=', '!=', '>', '<', '>=', '<='] },
      { key: 'right', label: 'Right', placeholder: '10' },
    ],
  },
  {
    type: 'comparePoints', label: 'Compare Points', icon: 'balance', group: 'Logic', category: 'Game',
    template: 'Compare points: {left} {op} {right}',
    summary: p => `Compare points: ${p.left || 'Player'} ${p.op || '>'} ${p.right || '10'}`,
    fields: [
      { key: 'left', label: 'Player or team', placeholder: 'Player' },
      { key: 'op', label: 'Operator', kind: 'select', options: ['=', '!=', '>', '<', '>=', '<='] },
      { key: 'right', label: 'Player, team or number', placeholder: '10' },
    ],
  },
  {
    type: 'awardPoints', label: 'Set Points', icon: 'star', group: 'Logic', category: 'Game',
    template: 'Set points of {target} to {points}',
    summary: p => `Set points of ${p.target || 'Player'} to ${p.points || '100'}`,
    fields: [
      { key: 'target', label: 'Player or team', placeholder: 'Player' },
      { key: 'points', label: 'Points', placeholder: '100' },
    ],
  },
  {
    type: 'getStat', label: 'Get Stat', icon: 'monitoring', group: 'Logic', category: 'Game',
    template: 'Read {stat} into {variable}',
    summary: p => `Read ${p.stat || 'a stat'} into ${p.variable || 'a variable'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
      { key: 'stat', label: 'Stat', kind: 'select', options: ['MaxHealthPoints', 'CurrentHealthPoints', 'ExtraLives', 'MovementSpeed', 'AttackPower', 'JumpPower', 'RewardedPoints', 'EnemyDetectionRange', 'Weight', 'EngineMaxSpeed', 'EnginePower', 'BrakePower'] },
      { key: 'variable', label: 'Save to variable', placeholder: 'health' },
    ],
  },
  {
    type: 'getEnvironment', label: 'Get Environment', icon: 'public', group: 'Logic', category: 'Game',
    template: 'Read {setting} into {variable}',
    summary: p => `Read ${p.setting || 'Gravity'} into ${p.variable || 'a variable'}`,
    fields: [
      { key: 'setting', label: 'Setting', kind: 'select', options: ['Gravity', 'Water height', 'Light intensity', 'Fog intensity'] },
      { key: 'variable', label: 'Save to variable', placeholder: 'gravity' },
    ],
  },
  {
    type: 'getObjectVector', label: 'Get Object Vector', icon: 'my_location', group: 'Logic', category: 'Vectors',
    template: 'Store the position of {target} in {variable}',
    summary: p => `Store the position of ${p.target || 'an object'} in ${p.variable || 'a variable'}`,
    fields: [
      { key: 'target', label: 'Object', placeholder: 'Object name' },
      { key: 'variable', label: 'Save to variable', placeholder: 'spot' },
    ],
  },
  {
    type: 'addVector', label: 'Add Vector', icon: 'add', group: 'Logic', category: 'Vectors',
    template: '{variable} = {a} + {b}',
    summary: p => `${p.variable || 'result'} = ${p.a || 'A'} + ${p.b || 'B'}`,
    fields: [
      { key: 'a', label: 'Vector A', placeholder: 'spot' },
      { key: 'b', label: 'Vector B', placeholder: '0,1,0' },
      { key: 'variable', label: 'Save to variable', placeholder: 'above' },
    ],
  },
  {
    type: 'multiplyVector', label: 'Multiply Vector', icon: 'functions', group: 'Logic', category: 'Vectors',
    template: '{variable} = {vector} × {factor}',
    summary: p => `${p.variable || 'result'} = ${p.vector || 'vector'} × ${p.factor || '2'}`,
    fields: [
      { key: 'vector', label: 'Vector', placeholder: 'dir' },
      { key: 'factor', label: 'Multiply by', placeholder: '2' },
      { key: 'variable', label: 'Save to variable', placeholder: 'far' },
    ],
  },
  {
    type: 'randomVector', label: 'Random Vector', icon: 'casino', group: 'Logic', category: 'Vectors',
    template: '{variable} = random point',
    summary: p => `${p.variable || 'spot'} = random point`,
    fields: [
      { key: 'min', label: 'Minimum (x,y,z)', placeholder: '-5,0,-5' },
      { key: 'max', label: 'Maximum (x,y,z)', placeholder: '5,0,5' },
      { key: 'variable', label: 'Save to variable', placeholder: 'spot' },
    ],
  },
  {
    type: 'getVectorElement', label: 'Get Vector Element', icon: 'list', group: 'Logic', category: 'Vectors',
    template: 'Read {axis} of {vector} into {variable}',
    summary: p => `Read ${p.axis || 'X'} of ${p.vector || 'a vector'} into ${p.variable || 'a variable'}`,
    fields: [
      { key: 'vector', label: 'Vector', placeholder: 'spot' },
      { key: 'axis', label: 'Axis', kind: 'select', options: ['X', 'Y', 'Z'] },
      { key: 'variable', label: 'Save to variable', placeholder: 'height' },
    ],
  },
  {
    type: 'setVectorElement', label: 'Set Vector Element', icon: 'edit_note', group: 'Logic', category: 'Vectors',
    template: 'Set {axis} of {vector} to {value}',
    summary: p => `Set ${p.axis || 'X'} of ${p.vector || 'a vector'} to ${p.value || '0'}`,
    fields: [
      { key: 'vector', label: 'Vector', placeholder: 'spot' },
      { key: 'axis', label: 'Axis', kind: 'select', options: ['X', 'Y', 'Z'] },
      { key: 'value', label: 'Value', placeholder: '5' },
    ],
  },
  {
    type: 'saveAimDirection', label: 'Save Aim Direction', icon: 'gps_fixed', group: 'Logic', category: 'Vectors',
    template: 'Store the aim direction in {variable}',
    summary: p => `Store the aim direction in ${p.variable || 'a variable'}`,
    fields: [
      { key: 'variable', label: 'Save to variable', placeholder: 'aim' },
    ],
  },
  {
    type: 'saveDistance', label: 'Save Distance', icon: 'straighten', group: 'Logic', category: 'Vectors',
    template: 'Store the distance {from} → {to} in {variable}',
    summary: p => `Store the distance ${p.from || 'A'} → ${p.to || 'B'} in ${p.variable || 'a variable'}`,
    fields: [
      { key: 'from', label: 'From object', placeholder: 'Player' },
      { key: 'to', label: 'To object', placeholder: 'Enemy' },
      { key: 'variable', label: 'Save to variable', placeholder: 'dist' },
    ],
  },
  {
    type: 'wait', label: 'Wait', icon: 'hourglass_empty', group: 'Logic', category: 'Timing',
    template: 'Wait for {seconds} seconds',
    summary: p => `Wait ${p.seconds || '0'}s`,
    fields: [
      { key: 'seconds', label: 'Seconds', placeholder: '0' },
    ],
  },
];

// Palette families in render order, each with its own accent so a node reads as
// System / Action / Condition / Flow / Logic at a glance in the palette AND on
// the canvas. System comes first — it is the root every workflow hangs off.
const NODE_GROUP_ORDER: NodeGroup[] = ['System', 'Action', 'Condition', 'Flow', 'Logic'];
const NODE_GROUP_META: Record<NodeGroup, { icon: string; accent: string }> = {
  System:    { icon: 'play_circle',  accent: '#cbd5e1' },
  Action:    { icon: 'bolt',         accent: '#34d399' },
  Condition: { icon: 'rule',         accent: '#fcd34d' },
  Flow:      { icon: 'alt_route',    accent: '#22d3ee' },
  Logic:     { icon: 'data_object',  accent: '#c084fc' },
};

// Everything the "+" palette may insert. Execute is excluded: every workflow is
// born with one at step 0 and there is never a second, so offering it in the
// palette could only ever produce an invalid chain.
const INSERTABLE_CATALOG = ACTION_CATALOG.filter(a => a.type !== 'execute');

// Top-level groups → the category captions inside them → the nodes themselves.
// A group left empty by the Execute exclusion (System) drops out entirely.
const NODE_GROUPS: {
  name: NodeGroup; icon: string; accent: string;
  categories: { name: string; items: typeof ACTION_CATALOG }[];
  items: typeof ACTION_CATALOG;
}[] = NODE_GROUP_ORDER.map(name => {
  const items = INSERTABLE_CATALOG.filter(a => a.group === name);
  const categories = items.reduce<{ name: string; items: typeof ACTION_CATALOG }[]>((acc, a) => {
    const bucket = acc.find(c => c.name === a.category);
    if (bucket) bucket.items.push(a);
    else acc.push({ name: a.category, items: [a] });
    return acc;
  }, []);
  return { name, icon: NODE_GROUP_META[name].icon, accent: NODE_GROUP_META[name].accent, categories, items };
}).filter(g => g.items.length > 0);

// ── Help text ───────────────────────────────────────────────────────────────
// One plain-English sentence per node, revealed by the ⓘ next to it in the
// palettes and shown at the top of the node editor. Action wording follows
// Struckd's published node list; Flow wording follows Muse Behavior's own
// definitions. Condition and Logic wording is derived from the node names —
// those two families are not documented publicly.
const NODE_HELP: Record<ActionType, string> = {
  execute: 'The root of a workflow — everything below it runs when the trigger fires. Every workflow starts with one, and it cannot be moved or removed.',
  addForce: 'Applies a directional force to the object. Needs physics on and a weight under 10 — the longer the direction vector, the stronger the push.',
  attachObject: 'Sticks one object onto another at an offset — X is left, Y is above, Z is behind. The attached object should have physics off.',
  cameraLookAt: 'Points the game camera at an object.',
  changeBehavior: 'Switches an NPC behaviour pattern: Default, Guard (stands still), Follow, Flee, Roams (wanders randomly) or Deathmatch (hunts and fights).',
  changeCamera: 'Switches the player perspective between first person, third person and top-down.',
  changeDoor: 'Opens or closes a door or gate.',
  changeEnvironment: 'Adjusts one world setting: gravity (0.5–2), water height (0–12), light intensity (0–3) or fog intensity (0–50).',
  changeStat: 'Changes one of an object’s stats — health, lives, movement speed, attack power, jump power, reward points, detection range, weight or vehicle engine values.',
  changeTeam: 'Reassigns a playable object to another team.',
  changeWeather: 'Sets the weather to Clear, Rain, Storm, Snow, Blizzard or Sandstorm.',
  clearInventory: 'Removes everything from an inventory.',
  convertToString: 'Turns a number or vector into text so it can be shown in a text bubble, on an object or on screen.',
  dealDamage: 'Inflicts damage on a destroyable object.',
  heal: 'Restores health to a destroyable object.',
  destroy: 'Destroys a destroyable object.',
  detachObject: 'Separates an object that was attached earlier.',
  endGame: 'Ends the play session and shows the win or lose screen.',
  endGameAsTeam: 'Ends the game for a whole team, marking that team as the winner or the loser.',
  lookAt: 'Makes a character face another object. Players turn in first person; NPCs can look anywhere.',
  moveToObject: 'Slides this object towards another one. Speed 0.2 is slow, 20 and up is very fast.',
  moveToVector: 'Slides this object to a set of coordinates. Speed 0.2 is slow, 20 and up is very fast.',
  playAnimation: 'Plays a character animation: idle, jump, attack, hit, die or the current weapon’s attack.',
  playSound: 'Plays a sound from an object.',
  position: 'Moves an object to a position over a duration. A duration of 0 teleports it instantly.',
  rotate: 'Turns an object by a number of degrees over a set time.',
  scale: 'Resizes an object per axis. Positive values grow it; values between 0 and -1 shrink it.',
  spawn: 'Spawns an object at a position. The object has to exist in the scene already — it stays hidden until it is spawned.',
  spawnAtObject: 'Spawns an object at another object’s position, with an optional offset.',
  startDialogue: 'Starts a conversation with an object that already has dialogue set up.',
  textBubble: 'Shows a speech bubble above an object for a few seconds. The text comes from a string variable.',
  textOnObject: 'Rewrites the content of a Custom Text asset in the scene.',
  showMessage: 'Shows a message on the player’s screen for a few seconds.',
  toggleCollision: 'Turns an object’s hitbox on or off.',
  togglePhysics: 'Turns an object’s physics on or off.',
  toggleVisibility: 'Shows or hides an object.',
  walkToObject: 'Makes an NPC find a path and walk to another object. The path has to be clear of obstacles.',
  walkToVector: 'Makes a character find a path and walk to a set of coordinates. The path has to be clear of obstacles.',
  check_onAim: 'Checks whether the player is aiming right now. The nodes below only run when the check passes.',
  check_onAttack: 'Checks whether this object is attacking right now. The nodes below only run when the check passes.',
  check_collision: 'Checks whether this object is touching something right now. The nodes below only run when the check passes.',
  check_onCollisionWithObject: 'Checks whether this object is touching that object right now. The nodes below only run when the check passes.',
  check_onDamage: 'Checks whether this object has just taken damage right now. The nodes below only run when the check passes.',
  check_onDash: 'Checks whether the player is dashing right now. The nodes below only run when the check passes.',
  check_destroyed: 'Checks whether this object is dead right now. The nodes below only run when the check passes.',
  check_onDialog: 'Checks whether a dialogue is open right now. The nodes below only run when the check passes.',
  check_onDoor: 'Checks whether the door is open right now. The nodes below only run when the check passes.',
  check_onEquip: 'Checks whether the item is equipped right now. The nodes below only run when the check passes.',
  check_gameStart: 'Checks whether the game has started right now. The nodes below only run when the check passes.',
  check_onGround: 'Checks whether the object is on the ground right now. The nodes below only run when the check passes.',
  check_onHealthRegen: 'Checks whether this object is regenerating health right now. The nodes below only run when the check passes.',
  check_onInteract: 'Checks whether the player is interacting with it right now. The nodes below only run when the check passes.',
  check_onInventoryChange: 'Checks whether the inventory changed right now. The nodes below only run when the check passes.',
  check_onJump: 'Checks whether the player is jumping right now. The nodes below only run when the check passes.',
  check_onMount: 'Checks whether the player is mounted right now. The nodes below only run when the check passes.',
  check_onPickup: 'Checks whether the item has been picked up right now. The nodes below only run when the check passes.',
  check_enterZone: 'Checks whether the player is within range right now. The nodes below only run when the check passes.',
  check_onReload: 'Checks whether a weapon is reloading right now. The nodes below only run when the check passes.',
  check_onWeaponChange: 'Checks whether the weapon has changed right now. The nodes below only run when the check passes.',
  check_onWeaponScope: 'Checks whether the player is scoped in right now. The nodes below only run when the check passes.',
  sequence: 'Runs the nodes below one after another until one of them fails, or they all succeed.',
  tryInOrder: 'Runs the nodes below one after another until one of them succeeds — the fallback pattern.',
  random: 'Picks one of the branches below at random and runs it.',
  runInParallel: 'Runs all the branches below simultaneously.',
  runInParallelUntilAnyCompletes: 'Runs all the branches at once and stops as soon as one of them finishes, whether it succeeded or failed.',
  runInParallelUntilAnyFails: 'Runs all the branches at once and stops as soon as one of them fails.',
  runInParallelUntilAnySucceeds: 'Runs all the branches at once and stops as soon as one of them succeeds.',
  waitForAll: 'Holds until every branch feeding into it has reached this point, then carries on.',
  waitForAny: 'Carries on as soon as any one of the branches feeding into it reaches this point.',
  repeat: 'Repeats the nodes below the given number of times.',
  repeatUntilSuccess: 'Keeps re-running the branch below until it finally succeeds.',
  repeatUntilFailure: 'Keeps re-running the branch below until it fails.',
  repeatWhileCondition: 'Keeps re-running the branch below for as long as the condition stays true.',
  inverter: 'Flips the result of the node below: success becomes failure and failure becomes success.',
  succeeder: 'Always reports success, whatever the node below actually does — useful to stop one failure ending a sequence.',
  timeOut: 'Gives the branch below a deadline: after the set number of frames it is abandoned.',
  setVariable: 'Stores a value in a variable that later nodes and workflows can read.',
  addToString: 'Adds more text onto the end of a string variable — handy for building score or name lines.',
  math: 'Runs a calculation on two numbers or variables and stores the result in a variable.',
  randomFloat: 'Picks a random decimal number between two values and stores it in a variable.',
  ifCheck: 'Compares two values and only lets the graph continue when the test passes.',
  ifBranch: 'Sends the graph down one of two paths depending on whether the comparison holds.',
  comparePoints: 'Compares two score values — use it to check who is ahead, or whether a score target has been hit.',
  awardPoints: 'Sets the score for a player or team.',
  getStat: 'Reads one of an object’s stats into a variable so you can test or display it.',
  getEnvironment: 'Reads a world setting — gravity, water height, light or fog — into a variable.',
  getObjectVector: 'Stores an object’s position as a vector variable.',
  addVector: 'Adds two vectors together and stores the result — the way to offset a position.',
  multiplyVector: 'Scales a vector by a number — same direction, longer or shorter.',
  randomVector: 'Picks a random point between two corners and stores it — good for scattering spawns.',
  getVectorElement: 'Pulls one axis out of a vector as a plain number.',
  setVectorElement: 'Overwrites one axis of a vector, leaving the other two alone.',
  saveAimDirection: 'Stores where the player is currently aiming as a vector — fire projectiles along it.',
  saveDistance: 'Measures the distance between two objects into a variable.',
  wait: 'Pauses this branch for a number of seconds before carrying on.',
};
const EVENT_HELP: Record<ConditionType, string> = {
  onAim: 'Starts the workflow when the player aims a weapon.',
  onAttack: 'Starts the workflow when this object attacks.',
  collision: 'Starts the workflow when this object collides with anything.',
  onCollisionWithObject: 'Starts the workflow when this object collides with a specific object.',
  onDamage: 'Starts the workflow when this object takes damage.',
  onDash: 'Starts the workflow when the player dashes.',
  destroyed: 'Starts the workflow when this object dies or is destroyed.',
  onDialog: 'Starts the workflow when a dialogue starts.',
  onDoor: 'Starts the workflow when a door opens or closes.',
  onEquip: 'Starts the workflow when an item is equipped.',
  gameStart: 'Starts the workflow when the game starts.',
  onGround: 'Starts the workflow when the object lands on the ground.',
  onHealthRegen: 'Starts the workflow when this object regenerates health.',
  onInteract: 'Starts the workflow when the player interacts with the object.',
  onInventoryChange: 'Starts the workflow when the inventory contents change.',
  onJump: 'Starts the workflow when the player jumps.',
  onMount: 'Starts the workflow when the player mounts a vehicle or animal.',
  onPickup: 'Starts the workflow when an item is picked up.',
  enterZone: 'Starts the workflow when the player comes within range.',
  onReload: 'Starts the workflow when a weapon is reloaded.',
  onWeaponChange: 'Starts the workflow when the equipped weapon changes.',
  onWeaponScope: 'Starts the workflow when the player scopes in.',
};
const GUARD_HELP: Partial<Record<ConditionType, string>> = {
  onGround: 'Only runs while the object is on the ground.',
  enterZone: 'Only runs while the player is within range.',
  onMount: 'Only runs while the player is mounted.',
  onWeaponScope: 'Only runs while the player is scoped in.',
  onAim: 'Only runs while the player is aiming.',
  destroyed: 'Only runs while this object is dead.',
  collision: 'Only runs while this object is touching something.',
  onCollisionWithObject: 'Only runs while this object is touching that object.',
  onDialog: 'Only runs while a dialogue is open.',
  onDoor: 'Only runs while the door is open.',
  onEquip: 'Only runs while the item is equipped.',
  gameStart: 'Only runs while the game has started.',
};

// Native shell: a serializable copy of the logic catalogs (the summary
// functions stay here — the native editor renders from `template` + fields).
function logicCatalogJson(): string {
  return JSON.stringify({
    events: EVENT_CATALOG.map(e => ({
      type: e.type, label: e.label, icon: e.icon, category: e.category, fields: e.fields,
      help: EVENT_HELP[e.type] ?? '',
    })),
    guards: GUARD_CATALOG.map(g => ({
      type: g.type, label: g.label, icon: g.icon, fields: g.fields, help: GUARD_HELP[g.type] ?? '',
    })),
    actions: ACTION_CATALOG.map(a => ({
      type: a.type, label: a.label, icon: a.icon, group: a.group, category: a.category,
      template: a.template, fields: a.fields, help: NODE_HELP[a.type] ?? '',
    })),
    groups: NODE_GROUP_ORDER.map(name => ({ name, accent: NODE_GROUP_META[name].accent })),
    colors: WORKFLOW_COLORS,
  });
}

function nodeAccent(t?: ActionType): string {
  const g = actionMeta(t)?.group;
  return g ? NODE_GROUP_META[g].accent : LOGIC_STEP_ACCENT;
}
// Tint/border washes for a node's accent. ReactUnity parses rgba() strings, so
// the group palette only has to carry one hex per family.
function accentWash(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function eventMeta(t?: ConditionType)  { return EVENT_CATALOG.find(e => e.type === t); }
function guardMeta(t?: ConditionType)  { return GUARD_CATALOG.find(g => g.type === t); }
function actionMeta(t?: ActionType)    { return ACTION_CATALOG.find(a => a.type === t); }

function logicId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}
function blankParams(fields: LogicField[]): Record<string, string> {
  const p: Record<string, string> = {};
  fields.forEach(f => { p[f.key] = ''; });
  return p;
}
// Struckd's System Execute node: the root every behaviour tree hangs off. It is
// step 0 of every workflow — seeded here, re-seeded on load, and pinned in the
// editor (no move, no delete).
function executeStep(): LogicStep {
  return { id: logicId('step'), type: 'execute', params: {}, guards: [], enabled: true };
}
// Exactly one Execute, always at index 0. A stored chain can arrive without one
// (authored before the root existed) or with one buried mid-chain (hand-edited
// JSON); both collapse to the same shape here, reusing the existing root's id so
// a live selection survives the normalize pass.
function withExecuteRoot(steps: LogicStep[]): LogicStep[] {
  const root = steps.find(s => s.type === 'execute');
  const rest = steps.filter(s => s.type !== 'execute');
  return [root ?? executeStep(), ...rest];
}
function newWorkflow(type: ConditionType): LogicWorkflow {
  const meta = eventMeta(type);
  return {
    id: logicId('wf'),
    name: '',
    color: WORKFLOW_COLORS[0],
    enabled: true,
    event: { type, params: blankParams(meta?.fields ?? []) },
    guards: [],
    steps: [executeStep()],
  };
}
function workflowTitle(wf: LogicWorkflow): string {
  return wf.name.trim() || eventMeta(wf.event.type)?.label || 'Workflow';
}
function guardSummary(guards: LogicGuard[]): string {
  if (!guards.length) return '';
  return guards
    .map(g => guardMeta(g.type)?.summary(g.params, g.negate) ?? 'Condition')
    .join(' and ');
}

// Tolerant reader for whatever shape came back from storage. Graphs authored
// before the workflow editor were a single Execute → conditions → actions
// chain; fold those into one workflow (first condition becomes the event, the
// rest become its "Only when", actions become the steps) so nobody's existing
// object logic evaporates on upgrade.
function normalizeLogicGraph(raw: any): LogicGraph {
  if (!raw || typeof raw !== 'object') return DEFAULT_LOGIC_GRAPH;

  if (Array.isArray(raw.workflows)) {
    const workflows = raw.workflows
      .filter((w: any) => w && typeof w === 'object' && eventMeta(w?.event?.type))
      .map((w: any): LogicWorkflow => ({
        id: typeof w.id === 'string' && w.id ? w.id : logicId('wf'),
        name: typeof w.name === 'string' ? w.name : '',
        color: typeof w.color === 'string' ? w.color : WORKFLOW_COLORS[0],
        enabled: w.enabled !== false,
        event: { type: w.event.type, params: { ...(w.event.params ?? {}) } },
        guards: normalizeGuards(w.guards),
        steps: withExecuteRoot(Array.isArray(w.steps)
          ? w.steps
              .filter((s: any) => s && actionMeta(s.type))
              .map((s: any): LogicStep => ({
                id: typeof s.id === 'string' && s.id ? s.id : logicId('step'),
                type: s.type,
                params: { ...(s.params ?? {}) },
                guards: normalizeGuards(s.guards),
                enabled: s.enabled !== false,
              }))
          : []),
      }));
    return { workflows, variables: normalizeVariables(raw.variables) };
  }

  // Legacy { nodes: [...] } chain.
  if (Array.isArray(raw.nodes)) {
    const conditions = raw.nodes.filter((n: any) => n?.kind === 'condition' && eventMeta(n.type));
    const actions    = raw.nodes.filter((n: any) => n?.kind === 'action' && actionMeta(n.type));
    if (!conditions.length && !actions.length) return DEFAULT_LOGIC_GRAPH;
    const [trigger, ...rest] = conditions;
    const wf = newWorkflow(trigger?.type ?? 'gameStart');
    wf.event.params = { ...(trigger?.params ?? {}) };
    wf.guards = rest
      .filter((c: any) => guardMeta(c.type))
      .map((c: any): LogicGuard => ({ id: logicId('guard'), type: c.type, negate: false, params: { ...(c.params ?? {}) } }));
    wf.steps = withExecuteRoot(actions.map((a: any): LogicStep => ({
      id: logicId('step'), type: a.type, params: { ...(a.params ?? {}) }, guards: [], enabled: true,
    })));
    return { workflows: [wf], variables: normalizeVariables(raw.variables) };
  }

  return DEFAULT_LOGIC_GRAPH;
}
function normalizeVariables(raw: any): LogicVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: any) => v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim())
    .map((v: any): LogicVariable => ({
      id: typeof v.id === 'string' && v.id ? v.id : logicId('var'),
      name: String(v.name).trim(),
      source: v.source === 'part' || v.source === 'interface' ? v.source : 'asset',
      target: typeof v.target === 'string' ? v.target : '',
      ...(typeof v.owner === 'string' && v.owner ? { owner: v.owner } : {}),
    }));
}
function normalizeGuards(raw: any): LogicGuard[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g: any) => g && guardMeta(g.type))
    .map((g: any): LogicGuard => ({
      id: typeof g.id === 'string' && g.id ? g.id : logicId('guard'),
      type: g.type,
      negate: !!g.negate,
      params: { ...(g.params ?? {}) },
    }));
}

function pushObjectLogic(objectId: string, graph: LogicGraph) {
  if (!objectId) return;
  try { (Globals as any).editorSetObjectLogic?.(objectId, JSON.stringify(graph)); }
  catch { /* bridge not ready — graph still persisted in React state */ }
}

// HUD buttons authored in the Interface panel, mirrored into SceneSettings.
// The Lua-visible handle is the button's event name where it has one, so that
// is what a variable binds to; otherwise the label identifies it.
function readInterfaceElements(): { label: string; target: string }[] {
  const raw = getGlobal('editorGetSceneSettings');
  if (!raw) return [];
  try {
    const s = JSON.parse(raw);
    if (!Array.isArray(s?.hudButtons)) return [];
    return s.hudButtons
      .filter((b: any) => b && typeof b === 'object')
      .map((b: any) => ({
        label: String(b.label ?? b.eventName ?? 'Button'),
        target: String(b.eventName || b.label || b.id || ''),
      }))
      .filter((b: any) => b.target);
  } catch { return []; }
}

// Variable names go into workflow fields as {{name}}, so the braces themselves
// are the one thing a name cannot contain.
function sanitizeVarName(raw: string): string {
  return raw.replace(/[{}]/g, '').replace(/\s+/g, ' ').trimStart().slice(0, 40);
}
// Seeds the name box from whatever is being named: "Model_barn.glb#e3" → "Barn".
function suggestVarName(target: string, taken: string[]): string {
  const leaf = target.split('/').pop() ?? target;
  const base = sanitizeVarName(
    leaf.replace(/#e\d+$/i, '')
        .replace(/\.(glb|gltf|fbx|obj)$/i, '')
        .replace(/^(Model|Structure|Object)[._]/i, '')
        .replace(/[._]+/g, ' ')
        .trim()
  ) || 'Object';
  const used = new Set(taken.map(t => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const cand = `${base} ${n}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
}

// Strip leading emoji/symbol decorations from AI-generated titles
// (e.g. "🎮 Cyberpunk Runner" → "Cyberpunk Runner") while preserving the body.
const stripDecorative = (s: string) =>
  (s ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

function baseUrl(): string {
  try { return (Globals as any).apiBaseUrl ?? 'http://localhost:4000'; } catch { return 'http://localhost:4000'; }
}

// True inside the React Native shell (NativeShellBridge registers getHostMode).
function isHostedByNative(): boolean {
  try { return String((Globals as any).getHostMode?.() ?? '') === 'native'; } catch { return false; }
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
      <GlassButton onClick={onClick} style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: bg,
        borderWidth: 1.5,
        borderColor: active ? (color ?? C.green) : 'rgba(255,255,255,0.14)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set={active ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: iconSize, color: fg, lineHeight: iconSize }}>{icon}</icon>
      </GlassButton>
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
        <GlassButton onClick={onCreateAnother} style={{
          backgroundColor: 'rgba(0,0,0,0)', borderRadius: 16, borderWidth: 0,
          paddingTop: 12, paddingBottom: 12, alignItems: 'center',
          flexDirection: 'row', justifyContent: 'center', gap: 6,
        }}>
          <icon set="material-rounded" style={{ fontSize: 16, color: C.green, lineHeight: 16 }}>add</icon>
          <text style={{ fontSize: 14, color: C.green }}>Create another</text>
        </GlassButton>
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
          <GlassButton onClick={onPlayAnyway} style={{
            backgroundColor: '#F59E0B', borderRadius: 14, borderWidth: 0,
            paddingTop: 15, paddingBottom: 15, alignItems: 'center',
          }}>
            <text style={{ fontSize: 16, color: '#000', fontWeight: 'bold' }}>Play Now</text>
          </GlassButton>
          <GlassButton onClick={onWait} style={{
            backgroundColor: 'transparent', borderRadius: 14, borderWidth: 0,
            paddingTop: 12, paddingBottom: 12, alignItems: 'center',
          }}>
            <text style={{ fontSize: 15, color: C.secondary }}>Wait for Full Models</text>
          </GlassButton>
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

// ── Shared docked-panel chrome ───────────────────────────────────────────────
// Every side panel (Edit / Workflow / Interface picker) carries the same expand
// control in its header: one tap swaps between the docked column and a
// full-screen sheet. The swipe gestures still drive the same state — this is
// the discoverable version of them, since a swipe is invisible until you know
// it exists.
function PanelExpandButton({ size, onToggle }: {
  size: 'default' | 'full';
  onToggle: () => void;
}) {
  return (
    <Pressable
      onClick={onToggle}
      style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
    >
      <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>
        {size === 'full' ? 'close_fullscreen' : 'open_in_full'}
      </icon>
    </Pressable>
  );
}

// ── iPhone-Settings-style list pieces ────────────────────────────────────────
// Rounded grouped card + rows that show their current value and a chevron.
// Tapping a row drills into that entry's own page instead of flipping a switch
// in place — the same navigation model as SettingsScreen, scaled down to the
// docked editor panel.
function SettingsGroup({ title, footer, children }: {
  title?: string;
  footer?: string;
  children?: any;
}) {
  return (
    <view style={{ flexDirection: 'column', marginBottom: 14 }}>
      {title ? (
        <text style={{
          fontSize: 10, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1,
          marginLeft: 4, marginBottom: 6,
        }}>
          {title.toUpperCase()}
        </text>
      ) : null}
      <view style={{
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 12,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
        flexDirection: 'column',
        overflow: 'hidden',
      } as any}>
        {children}
      </view>
      {footer ? (
        <text style={{ fontSize: 10, color: C.textMuted, marginLeft: 4, marginTop: 6, lineHeight: 14 }}>
          {footer}
        </text>
      ) : null}
    </view>
  );
}

function SettingsNavRow({ icon, label, value, active, onOpen, last }: {
  icon: string;
  label: string;
  value: string;
  active: boolean;
  onOpen: () => void;
  last?: boolean;
}) {
  return (
    <view style={{ flexDirection: 'column' }}>
      <Pressable
        onClick={onOpen}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          paddingLeft: 10, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
        }}
      >
        <view style={{
          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
          backgroundColor: active ? 'rgba(30,140,255,0.22)' : 'rgba(255,255,255,0.07)',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <icon
            set={active ? 'material-rounded-filled' : 'material-rounded'}
            style={{ fontSize: 17, color: active ? C.blue : C.textMuted, lineHeight: 17 }}
          >
            {icon}
          </icon>
        </view>
        <text style={{ flex: 1, fontSize: 13, color: C.text }}>{label}</text>
        <text style={{ fontSize: 11, color: active ? C.blue : C.textMuted }}>{value}</text>
        <icon set="material-rounded" style={{ fontSize: 16, color: C.secondary, lineHeight: 16 }}>chevron_right</icon>
      </Pressable>
      {last ? null : (
        <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginLeft: 50 }} />
      )}
    </view>
  );
}

// Row wrapper that gives ToggleRow / FieldRow the grouped-card insets without
// changing either component (ToggleRow is shared with the Workflow inspector).
function SettingsCell({ children, last }: { children?: any; last?: boolean }) {
  return (
    <view style={{ flexDirection: 'column' }}>
      <view style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 2, paddingBottom: 2 }}>
        {children}
      </view>
      {last ? null : (
        <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.07)', marginLeft: 12 }} />
      )}
    </view>
  );
}

// ── Edit panel: the functions an object can carry ────────────────────────────
// One entry per behavior. The index lists these with their current state; each
// one owns a detail page holding its master switch and sub-fields.
type ObjectFn = 'destroyable' | 'invisible' | 'physics' | 'move';

const OBJECT_FN_META: { key: ObjectFn; label: string; icon: string; blurb: string }[] = [
  { key: 'destroyable', label: 'Destroyable', icon: 'heart_broken',
    blurb: 'Give the object health so players can damage and destroy it.' },
  { key: 'invisible',   label: 'Invisible',   icon: 'visibility_off',
    blurb: 'Hide the object during play. It still exists and still collides — only its mesh is hidden.' },
  { key: 'physics',     label: 'Physics',     icon: 'scale',
    blurb: 'Let gravity and collisions push the object around instead of pinning it in place.' },
  { key: 'move',        label: 'Move',        icon: 'open_with',
    blurb: 'Drive the object back and forth on its own, with no player input.' },
];

// Right-hand summary on an index row — the iOS "detail text" that saves the
// user a drill-down just to see whether something is on.
function objectFnSummary(fn: ObjectFn, s: ObjectSettings): string {
  switch (fn) {
    case 'destroyable': {
      if (!s.destroyable) return 'Off';
      const hp = s.healthPoints.trim() || '100';
      return s.infiniteLives ? `${hp} HP · ∞` : `${hp} HP`;
    }
    case 'invisible':
      return s.invisible ? 'On' : 'Off';
    case 'physics':
      return s.physics ? `Weight ${s.weight.trim() || '1.0'}` : 'Off';
    case 'move': {
      if (!s.move) return 'Off';
      if (s.horizontal && s.vertical) return 'Both axes';
      if (s.horizontal)               return 'Horizontal';
      if (s.vertical)                 return 'Vertical';
      return 'On';
    }
  }
}

function objectFnActive(fn: ObjectFn, s: ObjectSettings): boolean {
  return fn === 'destroyable' ? s.destroyable
       : fn === 'invisible'   ? s.invisible
       : fn === 'physics'     ? s.physics
       : s.move;
}

function ObjectSettingsPanel({ settings, size, onChange, onClose, onToggleSize, onPointerDown, onPointerUp }: {
  settings: ObjectSettings;
  size: 'default' | 'full';
  onChange: <K extends keyof ObjectSettings>(key: K, value: ObjectSettings[K]) => void;
  onClose: () => void;
  onToggleSize: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
}) {
  // Which page the panel is showing — the function list, or one function's own
  // settings. Reset to the list every time the panel is reopened (the component
  // unmounts with the panel), matching how Settings.app returns to its root.
  const [page, setPage] = useState<'index' | ObjectFn>('index');
  const meta = OBJECT_FN_META.find(m => m.key === page);
  // Full-screen stretches the rows across a landscape viewport; cap the reading
  // width and centre it so the list doesn't become one long horizontal rule.
  const bodyMaxWidth = size === 'full' ? 620 : undefined;

  return (
    <view
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{
      position: 'absolute',
      left: safeAreaLeft(),
      top: safeAreaTop(),
      bottom: safeAreaBottom(),
      ...(size === 'full' ? { right: safeAreaRight() + 6 } : { width: EDITOR_SIDE_PANEL_WIDTH }),
      ...glass({ fill: 'rgba(20,20,22,0.94)' }),
      // Flush against the top/left/bottom safe-area edges now — only the
      // free (right) corners stay rounded, otherwise the flush sides would
      // show a sliver of the game view peeking through the rounded corners.
      borderTopRightRadius: 14, borderBottomRightRadius: 14,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
      zIndex: 50,
      flexDirection: 'column',
    } as any}>
      {/* Header — on a detail page the leading slot becomes a back chevron
          labelled with the parent list, exactly like a pushed Settings.app
          screen. Expand + close stay put so the chrome never jumps. */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: meta ? 6 : 14, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
      }}>
        {meta ? (
          <Pressable
            onClick={() => setPage('index')}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 2,
              height: 28, borderRadius: 8, paddingLeft: 4, paddingRight: 8,
              flexShrink: 0,
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 18, color: C.blue, lineHeight: 18 }}>chevron_left</icon>
            <text style={{ fontSize: 12, color: C.blue }}>Edit</text>
          </Pressable>
        ) : (
          <icon set="material-rounded-filled" style={{ fontSize: 18, color: C.blue, lineHeight: 18, marginRight: 8 }}>settings</icon>
        )}
        <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold', flex: 1 }}>
          {meta ? meta.label : 'Edit'}
        </text>
        <PanelExpandButton size={size} onToggle={onToggleSize} />
        <GlassButton
          onClick={onClose}
          style={{
            width: 28, height: 28, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>close</icon>
        </GlassButton>
      </view>

      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{
          paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: 16,
          width: '100%',
          ...(bodyMaxWidth ? { maxWidth: bodyMaxWidth, alignSelf: 'center' } : null),
        } as any}>

          {/* ── Index: one row per function, each drilling into its own page ── */}
          {!meta ? (
            <SettingsGroup title="Behavior" footer="Pick a behavior to set it up. Changes apply to this object right away.">
              {OBJECT_FN_META.map((m, i) => (
                <SettingsNavRow
                  key={m.key}
                  icon={m.icon}
                  label={m.label}
                  value={objectFnSummary(m.key, settings)}
                  active={objectFnActive(m.key, settings)}
                  onOpen={() => setPage(m.key)}
                  last={i === OBJECT_FN_META.length - 1}
                />
              ))}
            </SettingsGroup>
          ) : null}

          {/* ── Destroyable ── */}
          {page === 'destroyable' ? (
            <>
              <SettingsGroup footer={OBJECT_FN_META[0].blurb}>
                <SettingsCell last>
                  <ToggleRow
                    label="Destroyable"
                    value={settings.destroyable}
                    onValueChange={(v) => onChange('destroyable', v)}
                  />
                </SettingsCell>
              </SettingsGroup>
              {settings.destroyable ? (
                <>
                  <SettingsGroup title="Health">
                    <SettingsCell>
                      <FieldRow
                        label="Health Points"
                        value={settings.healthPoints}
                        onChangeText={(v) => onChange('healthPoints', v)}
                        placeholder="100"
                      />
                    </SettingsCell>
                    <SettingsCell last>
                      <ToggleRow
                        label="Health Regeneration"
                        value={settings.healthRegen}
                        onValueChange={(v) => onChange('healthRegen', v)}
                      />
                    </SettingsCell>
                  </SettingsGroup>
                  <SettingsGroup title="Lives">
                    <SettingsCell>
                      <FieldRow
                        label="Extra Lives"
                        value={settings.extraLives}
                        onChangeText={(v) => onChange('extraLives', v)}
                        placeholder="0"
                      />
                    </SettingsCell>
                    <SettingsCell last>
                      <ToggleRow
                        label="Infinite Lives"
                        value={settings.infiniteLives}
                        onValueChange={(v) => onChange('infiniteLives', v)}
                      />
                    </SettingsCell>
                  </SettingsGroup>
                  <SettingsGroup title="On destroy" footer="Explode spawns a burst at the object's position when its health runs out.">
                    <SettingsCell last>
                      <ToggleRow
                        label="Explode"
                        value={settings.explode}
                        onValueChange={(v) => onChange('explode', v)}
                      />
                    </SettingsCell>
                  </SettingsGroup>
                </>
              ) : null}
            </>
          ) : null}

          {/* ── Invisible ── */}
          {page === 'invisible' ? (
            <SettingsGroup footer={OBJECT_FN_META[1].blurb}>
              <SettingsCell last>
                <ToggleRow
                  label="Invisible"
                  value={settings.invisible}
                  onValueChange={(v) => onChange('invisible', v)}
                />
              </SettingsCell>
            </SettingsGroup>
          ) : null}

          {/* ── Physics ── */}
          {page === 'physics' ? (
            <>
              <SettingsGroup footer={OBJECT_FN_META[2].blurb}>
                <SettingsCell last>
                  <ToggleRow
                    label="Physics"
                    value={settings.physics}
                    onValueChange={(v) => onChange('physics', v)}
                  />
                </SettingsCell>
              </SettingsGroup>
              {settings.physics ? (
                <SettingsGroup title="Mass" footer="Heavier objects take more force to push and fall harder.">
                  <SettingsCell last>
                    <FieldRow
                      label="Weight"
                      value={settings.weight}
                      onChangeText={(v) => onChange('weight', v)}
                      placeholder="1.0"
                    />
                  </SettingsCell>
                </SettingsGroup>
              ) : null}
            </>
          ) : null}

          {/* ── Move ── */}
          {page === 'move' ? (
            <>
              <SettingsGroup footer={OBJECT_FN_META[3].blurb}>
                <SettingsCell last>
                  <ToggleRow
                    label="Move"
                    value={settings.move}
                    onValueChange={(v) => onChange('move', v)}
                  />
                </SettingsCell>
              </SettingsGroup>
              {settings.move ? (
                <>
                  <SettingsGroup title="Horizontally">
                    <SettingsCell last={!settings.horizontal}>
                      <ToggleRow
                        label="Horizontally"
                        value={settings.horizontal}
                        onValueChange={(v) => onChange('horizontal', v)}
                      />
                    </SettingsCell>
                    {settings.horizontal ? (
                      <>
                        <SettingsCell>
                          <FieldRow
                            label="Movement Speed"
                            value={settings.horizontalSpeed}
                            onChangeText={(v) => onChange('horizontalSpeed', v)}
                            placeholder="2.0"
                          />
                        </SettingsCell>
                        <SettingsCell last>
                          <FieldRow
                            label="Distance"
                            value={settings.horizontalDistance}
                            onChangeText={(v) => onChange('horizontalDistance', v)}
                            placeholder="5.0"
                          />
                        </SettingsCell>
                      </>
                    ) : null}
                  </SettingsGroup>
                  <SettingsGroup title="Vertically">
                    <SettingsCell last={!settings.vertical}>
                      <ToggleRow
                        label="Vertically"
                        value={settings.vertical}
                        onValueChange={(v) => onChange('vertical', v)}
                      />
                    </SettingsCell>
                    {settings.vertical ? (
                      <>
                        <SettingsCell>
                          <FieldRow
                            label="Movement Speed"
                            value={settings.verticalSpeed}
                            onChangeText={(v) => onChange('verticalSpeed', v)}
                            placeholder="2.0"
                          />
                        </SettingsCell>
                        <SettingsCell last>
                          <FieldRow
                            label="Distance"
                            value={settings.verticalDistance}
                            onChangeText={(v) => onChange('verticalDistance', v)}
                            placeholder="3.0"
                          />
                        </SettingsCell>
                      </>
                    ) : null}
                  </SettingsGroup>
                </>
              ) : null}
            </>
          ) : null}

        </view>
      </scroll>
    </view>
  );
}

// ── Custom Logic panel ───────────────────────────────────────────────────────
// A workflow editor modeled on Bubble.io's Workflow tab, with game-editor
// vocabulary in place of Bubble's web actions. Three regions, same as Bubble:
//
//   ┌──────────┬───────────────────────────┬──────────────┐
//   │ Workflow │  Canvas                   │  Properties  │
//   │ list     │   Event card              │  Properties  │
//   │ (search, │     ↓  + (add step)       │  Execution   │
//   │  New)    │   Step 1 …                │  Only when   │
//   └──────────┴───────────────────────────┴──────────────┘
//
// The panel is left-docked like ObjectSettingsPanel. At default width there
// isn't room for three columns, so the regions become a navigation stack
// (list → canvas → properties) with a back button — Bubble's own back-button
// affordance, applied to a phone-sized viewport. Swiping the panel to full
// size lays all three out side by side.
//
// Every mutation writes the whole graph back through onChange, which mirrors
// it to Unity via pushObjectLogic so behavior is live on the next Play.

const LOGIC_EVENT_ACCENT = '#5B9CFF';
const LOGIC_STEP_ACCENT  = '#34d399';
const LOGIC_GUARD_ACCENT = '#fcd34d';

type LogicSelection =
  | { kind: 'none' }
  | { kind: 'step'; id: string };

// ── Small shared pieces ─────────────────────────────────────────────────────

function LogicSectionLabel({ text }: { text: string }) {
  return (
    <view style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 6 }}>
      <text style={{ flex: 1, fontSize: 10, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1 }}>
        {text.toUpperCase()}
      </text>
    </view>
  );
}

// Variables defined on the open graph. Any field, however deep in the
// inspector, can offer them without threading props through every layer.
// Struckd's Blackboard always carries a built-in "Self" — the object the
// workflows run on. It is not stored on the graph (nothing to store: it is
// whatever object owns the logic), but every field can link to it.
const SELF_VARIABLE: LogicVariable = {
  id: 'var_self', name: 'Self', source: 'asset', target: '(this object)',
};

const LogicVarsContext = React.createContext<LogicVariable[]>([SELF_VARIABLE]);

// A text field plus the "{ }" affordance that drops a variable into it. The
// menu is per-field state, which is why this is a component and not a branch
// inside LogicFields' map.
function LogicTextField({ field, value, onChange }: {
  field: LogicField;
  value: string;
  onChange: (value: string) => void;
}) {
  const variables = React.useContext(LogicVarsContext);
  const [picking, setPicking] = useState(false);

  function insert(v: LogicVariable) {
    const token = `{{${v.name}}}`;
    // Empty field → the variable IS the value. Otherwise append, letting the
    // creator build "{{Door}} opened by {{Player}}" style strings.
    onChange(!value ? token : /\s$/.test(value) ? `${value}${token}` : `${value} ${token}`);
    setPicking(false);
  }

  return (
    <view style={{ flexDirection: 'column' }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
        <text style={{ flex: 1, fontSize: 10, color: C.textMuted }}>{field.label}</text>
        {variables.length ? (
          <Pressable
            onClick={() => setPicking(p => !p)}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 3,
              borderRadius: 5,
              backgroundColor: picking ? 'rgba(91,156,255,0.18)' : 'rgba(255,255,255,0.06)',
              paddingLeft: 5, paddingRight: 6, paddingTop: 2, paddingBottom: 2,
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 11, color: picking ? C.primary : C.textMuted, lineHeight: 11 }}>data_object</icon>
            <text style={{ fontSize: 9, color: picking ? C.primary : C.textMuted, fontWeight: 'bold' }}>Variable</text>
          </Pressable>
        ) : null}
      </view>
      <view style={{
        backgroundColor: C.surface,
        borderRadius: 6,
        paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2,
      }}>
        <input
          value={value}
          onChange={(val: any) => onChange(String(val ?? ''))}
          placeholder={field.placeholder ?? ''}
          style={{
            fontSize: 12, color: C.text,
            backgroundColor: 'transparent', borderWidth: 0, minHeight: 24,
          }}
        />
      </view>
      {picking && variables.length ? (
        <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
          {variables.map(v => {
            const meta = VAR_SOURCE_META[v.source];
            return (
              <Pressable
                key={v.id}
                onClick={() => insert(v)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 4,
                  borderRadius: 6,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                  paddingLeft: 6, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 11, color: meta.accent, lineHeight: 11 }}>{meta.icon}</icon>
                <text style={{ fontSize: 10.5, color: C.text }}>{v.name}</text>
              </Pressable>
            );
          })}
        </view>
      ) : null}
      {field.hint ? (
        <text style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{field.hint}</text>
      ) : null}
    </view>
  );
}

function LogicFields({ fields, params, onChange }: {
  fields: LogicField[];
  params: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (!fields.length) return null;
  return (
    <view style={{ flexDirection: 'column', gap: 10 }}>
      {fields.map(f => {
        const value = params[f.key] ?? '';

        // Switch — stored as 'true' / '' so the wire format stays strings.
        if (f.kind === 'toggle') {
          return (
            <view key={f.key} style={{ flexDirection: 'column' }}>
              <ToggleRow
                label={f.label}
                value={value === 'true'}
                onValueChange={v => onChange(f.key, v ? 'true' : '')}
              />
              {f.hint ? (
                <text style={{ fontSize: 10, color: C.textMuted, marginTop: -4 }}>{f.hint}</text>
              ) : null}
            </view>
          );
        }

        // Choice chips — one tap instead of typing a magic word.
        if (f.kind === 'select' && f.options?.length) {
          const active = value || f.options[0];
          return (
            <view key={f.key} style={{ flexDirection: 'column' }}>
              <text style={{ fontSize: 10, color: C.textMuted, marginBottom: 5 }}>{f.label}</text>
              <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {f.options.map(opt => {
                  const on = opt === active;
                  return (
                    <Pressable
                      key={opt}
                      onClick={() => onChange(f.key, opt)}
                      style={{
                        borderRadius: 7,
                        borderWidth: 1,
                        borderColor: on ? C.primary : 'rgba(255,255,255,0.14)',
                        backgroundColor: on ? 'rgba(91,156,255,0.16)' : 'rgba(255,255,255,0.04)',
                        paddingLeft: 11, paddingRight: 11, paddingTop: 6, paddingBottom: 6,
                      }}
                    >
                      <text style={{ fontSize: 11.5, color: on ? C.primary : C.text, fontWeight: on ? 'bold' : 'normal' }}>
                        {opt}
                      </text>
                    </Pressable>
                  );
                })}
              </view>
              {f.hint ? (
                <text style={{ fontSize: 10, color: C.textMuted, marginTop: 5 }}>{f.hint}</text>
              ) : null}
            </view>
          );
        }

        return (
          <LogicTextField
            key={f.key}
            field={f}
            value={value}
            onChange={v => onChange(f.key, v)}
          />
        );
      })}
    </view>
  );
}

// One row in any of the pickers (nodes, events, conditions). Tapping the row
// inserts the node; the ⓘ on the right expands a one-line explanation instead.
// The two are siblings, never nested — ReactUnity bubbles clicks, so an ⓘ
// inside the row's Pressable would also insert the node.
function PickerRow({ icon: iconName, accent, label, meta, help, onPick }: {
  icon: string;
  accent: string;
  label: string;
  meta?: string;
  help?: string;
  onPick: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <view style={{ flexDirection: 'column' }}>
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        borderRadius: 6,
        backgroundColor: open ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0)',
      }}>
        <Pressable
          onClick={onPick}
          style={{
            flex: 1, width: 1,
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingLeft: 6, paddingRight: 4, paddingTop: 7, paddingBottom: 7,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 14, color: accent, lineHeight: 14 }}>{iconName}</icon>
          <text style={{ flex: 1, width: 1, fontSize: 11.5, color: C.text }}>{label}</text>
          {meta ? <text style={{ fontSize: 9.5, color: C.textMuted }}>{meta}</text> : null}
        </Pressable>
        <Pressable
          onClick={() => setOpen(!open)}
          style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon
            set={open ? 'material-rounded-filled' : 'material-rounded'}
            style={{ fontSize: 15, color: open ? C.primary : C.textMuted, lineHeight: 15 }}
          >
            info
          </icon>
        </Pressable>
      </view>
      {open ? (
        <text style={{
          fontSize: 10.5, color: C.textMuted, lineHeight: 15,
          paddingLeft: 28, paddingRight: 30, paddingBottom: 7,
        }}>
          {help || 'No description yet.'}
        </text>
      ) : null}
    </view>
  );
}

// Bubble's "Only when" block: an AND-joined predicate list that gates either
// the whole workflow (when attached to the event) or a single step.
function OnlyWhenEditor({ guards, onChange }: {
  guards: LogicGuard[];
  onChange: (next: LogicGuard[]) => void;
}) {
  const [picking, setPicking] = useState(false);

  function addGuard(type: ConditionType) {
    const meta = guardMeta(type);
    onChange([...guards, { id: logicId('guard'), type, negate: false, params: blankParams(meta?.fields ?? []) }]);
    setPicking(false);
  }
  function patchGuard(id: string, key: string, value: string) {
    onChange(guards.map(g => (g.id === id ? { ...g, params: { ...g.params, [key]: value } } : g)));
  }

  return (
    <view style={{ flexDirection: 'column' }}>
      {guards.length === 0 && !picking ? (
        <text style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>
          Always runs. Add a condition to restrict it.
        </text>
      ) : null}

      {guards.map((g, i) => {
        const meta = guardMeta(g.type);
        return (
          <view
            key={g.id}
            style={{
              backgroundColor: 'rgba(252,211,77,0.06)',
              borderWidth: 1, borderColor: 'rgba(252,211,77,0.28)',
              borderRadius: 8,
              paddingLeft: 8, paddingRight: 6, paddingTop: 6, paddingBottom: 8,
              marginBottom: 6,
            }}
          >
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <text style={{ fontSize: 9, color: LOGIC_GUARD_ACCENT, fontWeight: 'bold', width: 36 }}>
                {i === 0 ? 'WHEN' : 'AND'}
              </text>
              <icon set="material-rounded" style={{ fontSize: 13, color: LOGIC_GUARD_ACCENT, lineHeight: 13 }}>
                {meta?.icon ?? 'rule'}
              </icon>
              <text style={{ flex: 1, fontSize: 11, color: C.text }}>
                {meta?.summary(g.params, g.negate) ?? 'Condition'}
              </text>
              <Pressable
                onClick={() => onChange(guards.map(x => (x.id === g.id ? { ...x, negate: !x.negate } : x)))}
                style={{
                  paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2,
                  borderRadius: 5,
                  backgroundColor: g.negate ? 'rgba(255,69,58,0.20)' : 'rgba(255,255,255,0.07)',
                }}
              >
                <text style={{ fontSize: 9, color: g.negate ? C.red : C.textMuted, fontWeight: 'bold' }}>NOT</text>
              </Pressable>
              <Pressable
                onClick={() => onChange(guards.filter(x => x.id !== g.id))}
                style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
              >
                <icon set="material-rounded" style={{ fontSize: 13, color: C.textMuted, lineHeight: 13 }}>close</icon>
              </Pressable>
            </view>
            {meta?.fields.length ? (
              <view style={{ marginTop: 6, paddingLeft: 32 }}>
                <LogicFields
                  fields={meta.fields}
                  params={g.params}
                  onChange={(k, v) => patchGuard(g.id, k, v)}
                />
              </view>
            ) : null}
          </view>
        );
      })}

      {picking ? (
        <view style={{
          ...glass({ fill: 'rgba(18,18,22,0.96)' }),
          borderRadius: 8,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
          paddingTop: 6, paddingBottom: 6, paddingLeft: 6, paddingRight: 6,
          gap: 4,
        }}>
          <view style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
            <text style={{ flex: 1, fontSize: 11, color: C.text, fontWeight: 'bold' }}>Add condition</text>
            <Pressable
              onClick={() => setPicking(false)}
              style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
            >
              <icon set="material-rounded" style={{ fontSize: 13, color: C.textMuted, lineHeight: 13 }}>close</icon>
            </Pressable>
          </view>
          {GUARD_CATALOG.map(g => (
            <PickerRow
              key={g.type}
              icon={g.icon}
              accent={LOGIC_GUARD_ACCENT}
              label={g.label}
              help={GUARD_HELP[g.type]}
              onPick={() => addGuard(g.type)}
            />
          ))}
        </view>
      ) : (
        <Pressable
          onClick={() => setPicking(true)}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
            borderWidth: 1, borderColor: 'rgba(252,211,77,0.35)',
            backgroundColor: 'rgba(252,211,77,0.08)',
            borderRadius: 8,
            paddingTop: 7, paddingBottom: 7,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 13, color: LOGIC_GUARD_ACCENT, lineHeight: 13 }}>add</icon>
          <text style={{ fontSize: 11, color: LOGIC_GUARD_ACCENT, fontWeight: 'bold' }}>Add condition</text>
        </Pressable>
      )}
    </view>
  );
}

// ── Workflow list rail ──────────────────────────────────────────────────────
// Bubble's left panel: a search box, a count header ("ON THIS PAGE 48" → ours
// is scoped to the selected object), and one row per workflow showing the
// event on the first line and its "Only when" on the second.

function WorkflowListRail({ workflows, selectedId, onSelect, onNew, onDuplicate, onDelete }: {
  workflows: LogicWorkflow[];
  selectedId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState('');

  const q = query.trim().toLowerCase();
  const shown = q
    ? workflows.filter(w => {
        const meta = eventMeta(w.event.type);
        const hay = [
          workflowTitle(w),
          meta?.label ?? '',
          guardSummary(w.guards),
          ...w.steps.map(s => actionMeta(s.type)?.label ?? ''),
        ].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : workflows;

  // Empty object: no title, no search, no count header, no empty-state copy —
  // just the "New" button, which is the only thing there is to do here.
  if (workflows.length === 0) {
    return (
      <view style={{ flex: 1, height: 1, flexDirection: 'column' } as any}>
        <view style={{
          flexDirection: 'row', alignItems: 'center',
          paddingLeft: 10, paddingRight: 8, paddingTop: 8, paddingBottom: 6,
        }}>
          <Pressable
            onClick={onNew}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 3,
              backgroundColor: C.primary,
              borderRadius: 6,
              paddingLeft: 7, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 12, color: C.onPrimary, lineHeight: 12 }}>add</icon>
            <text style={{ fontSize: 11, color: C.onPrimary, fontWeight: 'bold' }}>New</text>
          </Pressable>
        </view>
      </view>
    );
  }

  return (
    <view style={{ flex: 1, height: 1, flexDirection: 'column' } as any}>
      {/* Title row + New */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 10, paddingRight: 8, paddingTop: 8, paddingBottom: 6,
      }}>
        <text style={{ flex: 1, fontSize: 13, color: C.text, fontWeight: 'bold' }}>Workflows</text>
        <Pressable
          onClick={onNew}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 3,
            backgroundColor: C.primary,
            borderRadius: 6,
            paddingLeft: 7, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 12, color: C.onPrimary, lineHeight: 12 }}>add</icon>
          <text style={{ fontSize: 11, color: C.onPrimary, fontWeight: 'bold' }}>New</text>
        </Pressable>
      </view>

      {/* Search */}
      <view style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        marginLeft: 10, marginRight: 10, marginBottom: 6,
        backgroundColor: C.surface,
        borderRadius: 7,
        paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2,
      }}>
        <icon set="material-rounded" style={{ fontSize: 13, color: C.textMuted, lineHeight: 13 }}>search</icon>
        <input
          value={query}
          onChange={(val: any) => setQuery(String(val ?? ''))}
          placeholder="Search workflows"
          style={{
            flex: 1, fontSize: 11, color: C.text,
            backgroundColor: 'transparent', borderWidth: 0, minHeight: 24,
          }}
        />
      </view>

      {/* Count header — Bubble's "ON THIS PAGE  48" */}
      <view style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingLeft: 10, paddingRight: 10, paddingBottom: 4,
      }}>
        <text style={{ fontSize: 9, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1 }}>
          ON THIS OBJECT
        </text>
        <view style={{
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderRadius: 4, paddingLeft: 5, paddingRight: 5, paddingTop: 1, paddingBottom: 1,
        }}>
          <text style={{ fontSize: 9, color: C.textMuted, fontWeight: 'bold' }}>{String(workflows.length)}</text>
        </view>
      </view>

      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 10, flexDirection: 'column', gap: 3 }}>
          {shown.length === 0 ? (
            <text style={{ fontSize: 11, color: C.textMuted, paddingLeft: 4, paddingTop: 8 }}>
              No workflows match that search.
            </text>
          ) : null}

          {shown.map(w => {
            const meta     = eventMeta(w.event.type);
            const selected = w.id === selectedId;
            const only     = guardSummary(w.guards);
            return (
              <view key={w.id} style={{ flexDirection: 'column' }}>
                {/* Row select and the "…" menu are siblings, not nested
                    Pressables — ReactUnity bubbles clicks, so a nested menu
                    button would also fire the row's onClick. */}
                <view style={{
                  flexDirection: 'row', alignItems: 'center',
                  backgroundColor: selected ? 'rgba(91,156,255,0.16)' : 'rgba(0,0,0,0)',
                  borderRadius: 7,
                }}>
                  <Pressable
                    onClick={() => { setMenuFor(''); onSelect(w.id); }}
                    style={{
                      flex: 1, width: 1,
                      flexDirection: 'row', alignItems: 'center', gap: 7,
                      paddingLeft: 7, paddingRight: 2, paddingTop: 6, paddingBottom: 6,
                    }}
                  >
                    <view style={{
                      width: 22, height: 22, borderRadius: 6,
                      backgroundColor: w.enabled ? w.color : 'rgba(255,255,255,0.10)',
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <icon
                        set="material-rounded-filled"
                        style={{ fontSize: 12, color: w.enabled ? '#000' : C.textMuted, lineHeight: 12 }}
                      >
                        {meta?.icon ?? 'bolt'}
                      </icon>
                    </view>
                    <view style={{ flex: 1, width: 1 }}>
                      <text
                        style={{
                          fontSize: 11.5,
                          color: w.enabled ? C.text : C.textMuted,
                          fontWeight: selected ? 'bold' : 'normal',
                        }}
                      >
                        {workflowTitle(w)}
                      </text>
                      <text style={{ fontSize: 9.5, color: C.textMuted, marginTop: 1 }}>
                        {only
                          ? `Only when ${only}`
                          : `${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'}`}
                      </text>
                    </view>
                  </Pressable>
                  <Pressable
                    onClick={() => setMenuFor(menuFor === w.id ? '' : w.id)}
                    style={{ width: 26, height: 30, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <icon set="material-rounded" style={{ fontSize: 15, color: C.textMuted, lineHeight: 15 }}>more_horiz</icon>
                  </Pressable>
                </view>

                {menuFor === w.id ? (
                  <view style={{
                    flexDirection: 'row', gap: 6,
                    marginLeft: 34, marginRight: 4, marginTop: 2, marginBottom: 4,
                  }}>
                    <Pressable
                      onClick={() => { onDuplicate(w.id); setMenuFor(''); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 4,
                        backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 6,
                        paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                      }}
                    >
                      <icon set="material-rounded" style={{ fontSize: 12, color: C.textMuted, lineHeight: 12 }}>content_copy</icon>
                      <text style={{ fontSize: 10, color: C.text }}>Duplicate</text>
                    </Pressable>
                    <Pressable
                      onClick={() => { onDelete(w.id); setMenuFor(''); }}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 4,
                        backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 6,
                        paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                      }}
                    >
                      <icon set="material-rounded" style={{ fontSize: 12, color: C.red, lineHeight: 12 }}>delete</icon>
                      <text style={{ fontSize: 10, color: C.red }}>Delete</text>
                    </Pressable>
                  </view>
                ) : null}
              </view>
            );
          })}
        </view>
      </scroll>
    </view>
  );
}

// ── Event picker ────────────────────────────────────────────────────────────
// Bubble's "Click here to add an event". Categories match its Element / General
// split, with game triggers instead of DOM ones.

function EventPicker({ title, onPick, onCancel }: {
  title: string;
  onPick: (type: ConditionType) => void;
  onCancel: () => void;
}) {
  const categories = EVENT_CATALOG.reduce<{ name: string; items: typeof EVENT_CATALOG }[]>((acc, e) => {
    const bucket = acc.find(c => c.name === e.category);
    if (bucket) bucket.items.push(e);
    else acc.push({ name: e.category, items: [e] });
    return acc;
  }, []);

  return (
    <view style={{
      ...glass({ fill: 'rgba(18,18,22,0.98)' }),
      borderRadius: 10,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
      paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
    }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <text style={{ flex: 1, fontSize: 12, color: C.text, fontWeight: 'bold' }}>{title}</text>
        <Pressable
          onClick={onCancel}
          style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>close</icon>
        </Pressable>
      </view>
      {categories.map(cat => (
        <view key={cat.name} style={{ flexDirection: 'column', marginTop: 4 }}>
          <text style={{ fontSize: 9, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1, marginBottom: 3 }}>
            {cat.name.toUpperCase()}
          </text>
          {cat.items.map(e => (
            <PickerRow
              key={e.type}
              icon={e.icon}
              accent={LOGIC_EVENT_ACCENT}
              label={e.label}
              help={EVENT_HELP[e.type]}
              onPick={() => onPick(e.type)}
            />
          ))}
        </view>
      ))}
    </view>
  );
}

// ── Action palette ──────────────────────────────────────────────────────────
// The popover behind Bubble's "+" — a search field over four expandable family
// rows: Action, Condition, Flow, Logic. Each family keeps its own sub-captions
// (Action → Object / Physics / Camera / Audio / Interface / Game, Logic →
// Variables / Branching, …) so a long family still scans as a short list.

function ActionPalette({ onPick, onCancel }: {
  onPick: (type: ActionType) => void;
  onCancel: () => void;
}) {
  const [query, setQuery]       = useState('');
  const [expanded, setExpanded] = useState('');

  const q = query.trim().toLowerCase();
  const matches = q
    ? INSERTABLE_CATALOG.filter(a =>
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q))
    : [];

  return (
    <view style={{
      ...glass({ fill: 'rgba(18,18,22,0.98)' }),
      borderRadius: 10,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
      paddingTop: 6, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
    }}>
      {/* Search row */}
      <view style={{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
        paddingBottom: 6, marginBottom: 6,
      }}>
        <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>search</icon>
        <input
          value={query}
          onChange={(val: any) => setQuery(String(val ?? ''))}
          placeholder="Search nodes"
          style={{
            flex: 1, fontSize: 12, color: C.text,
            backgroundColor: 'transparent', borderWidth: 0, minHeight: 26,
          }}
        />
        <Pressable
          onClick={onCancel}
          style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>close</icon>
        </Pressable>
      </view>

      {q ? (
        matches.length ? (
          matches.map(a => (
            <PickerRow
              key={a.type}
              icon={a.icon}
              accent={NODE_GROUP_META[a.group].accent}
              label={a.label}
              meta={`${a.group} · ${a.category}`}
              help={NODE_HELP[a.type]}
              onPick={() => onPick(a.type)}
            />
          ))
        ) : (
          <text style={{ fontSize: 11, color: C.textMuted, paddingLeft: 6, paddingTop: 4, paddingBottom: 4 }}>
            No nodes match “{query.trim()}”.
          </text>
        )
      ) : (
        NODE_GROUPS.map(grp => {
          const open = expanded === grp.name;
          return (
            <view key={grp.name} style={{ flexDirection: 'column' }}>
              <Pressable
                onClick={() => setExpanded(open ? '' : grp.name)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  borderRadius: 6,
                  paddingLeft: 6, paddingRight: 6, paddingTop: 7, paddingBottom: 7,
                  backgroundColor: open ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0)',
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 14, color: grp.accent, lineHeight: 14 }}>{grp.icon}</icon>
                <text style={{ flex: 1, fontSize: 12, color: C.text }}>{grp.name}</text>
                <text style={{ fontSize: 9.5, color: C.textMuted }}>{String(grp.items.length)}</text>
                <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>
                  {open ? 'expand_more' : 'chevron_right'}
                </icon>
              </Pressable>
              {open ? (
                <view style={{ flexDirection: 'column', paddingLeft: 14, paddingBottom: 4 }}>
                  {grp.categories.map(cat => (
                    <view key={cat.name} style={{ flexDirection: 'column' }}>
                      {grp.categories.length > 1 ? (
                        <text style={{
                          fontSize: 9, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1,
                          paddingLeft: 6, paddingTop: 4, paddingBottom: 2,
                        }}>
                          {cat.name.toUpperCase()}
                        </text>
                      ) : null}
                      {cat.items.map(a => (
                        <PickerRow
                          key={a.type}
                          icon={a.icon}
                          accent={grp.accent}
                          label={a.label}
                          help={NODE_HELP[a.type]}
                          onPick={() => onPick(a.type)}
                        />
                      ))}
                    </view>
                  ))}
                </view>
              ) : null}
            </view>
          );
        })
      )}
    </view>
  );
}

// ── Canvas ──────────────────────────────────────────────────────────────────

function LogicConnector({ onAdd }: { onAdd?: () => void }) {
  return (
    <view style={{ alignItems: 'center', paddingTop: 2, paddingBottom: 2 }}>
      <view style={{ width: 2, height: 10, backgroundColor: 'rgba(255,255,255,0.22)' }} />
      {onAdd ? (
        <Pressable
          onClick={onAdd}
          style={{
            width: 20, height: 20, borderRadius: 10,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(91,156,255,0.18)',
            borderWidth: 1, borderColor: 'rgba(91,156,255,0.55)',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 12, color: C.primary, lineHeight: 12 }}>add</icon>
        </Pressable>
      ) : (
        <icon set="material-rounded" style={{ fontSize: 13, color: 'rgba(255,255,255,0.40)', lineHeight: 13 }}>expand_more</icon>
      )}
      <view style={{ width: 2, height: 10, backgroundColor: 'rgba(255,255,255,0.22)' }} />
    </view>
  );
}

// ── Inline node editing ─────────────────────────────────────────────────────
// Struckd (and Unity Behavior underneath it) puts the whole editor in the node:
// each node reads as a sentence with its parameters embedded as live controls,
// and any slot can be linked to a Blackboard variable instead of a literal. We
// do the same — `template` supplies the sentence, `{key}` marks a slot, and the
// link button swaps a slot over to a {{variable}} reference.

type TemplatePart = { text: string } | { slot: string };

function parseTemplate(t: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let rest = t;
  for (;;) {
    const at = rest.indexOf('{');
    const end = at < 0 ? -1 : rest.indexOf('}', at);
    if (at < 0 || end < 0) { if (rest) parts.push({ text: rest }); return parts; }
    if (at > 0) parts.push({ text: rest.slice(0, at) });
    parts.push({ slot: rest.slice(at + 1, end) });
    rest = rest.slice(end + 1);
  }
}

// '{{Front Door}}' → 'Front Door'. Anything else is a literal value.
function boundVariable(value: string): string {
  const m = /^\{\{(.+)\}\}$/.exec((value ?? '').trim());
  return m ? m[1] : '';
}

// Fields that name something in the scene. Struckd hangs a "(specific)" switch
// off these: on means that one object, off means any object of the same kind.
// Keyed by field key because every object slot in the catalog is built from the
// same handful of keys.
const OBJECT_FIELD_KEYS = new Set(['target', 'parent', 'asset', 'from', 'to']);
const isObjectField = (f: LogicField) => !f.kind && !f.noSpecific && OBJECT_FIELD_KEYS.has(f.key);
const specificKey    = (key: string) => `${key}Specific`;

// The "(specific ●)" switch that rides alongside an object slot.
function SpecificToggle({ on, accent, onToggle }: {
  on: boolean;
  accent: string;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onClick={onToggle}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingLeft: 2, paddingRight: 2,
      }}
    >
      <text style={{ fontSize: 11, color: C.textMuted }}>(specific</text>
      <view style={{
        width: 20, height: 12, borderRadius: 6,
        backgroundColor: on ? accent : 'rgba(255,255,255,0.20)',
        padding: 1.5,
        alignItems: on ? 'flex-end' : 'flex-start', justifyContent: 'center',
      }}>
        <view style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#fff' }} />
      </view>
      <text style={{ fontSize: 11, color: C.textMuted }}>)</text>
    </Pressable>
  );
}

// One editable slot inside a node sentence. Text slots type in place, selects
// and variable links open their list under the sentence (`onOpen`) so nothing
// has to float above the canvas.
function NodeSlot({ field, value, accent, open, onOpen, onChange }: {
  field: LogicField;
  value: string;
  accent: string;
  open: boolean;
  onOpen: (key: string) => void;
  onChange: (value: string) => void;
}) {
  const bound = boundVariable(value);

  if (bound) {
    return (
      <Pressable
        onClick={() => onOpen(open ? '' : field.key)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 3,
          borderRadius: 6,
          borderWidth: 1, borderColor: open ? C.primary : 'rgba(91,156,255,0.45)',
          backgroundColor: 'rgba(91,156,255,0.16)',
          paddingLeft: 6, paddingRight: 7, paddingTop: 3, paddingBottom: 3,
        }}
      >
        <icon set="material-rounded" style={{ fontSize: 11, color: C.primary, lineHeight: 11 }}>link</icon>
        <text style={{ fontSize: 11.5, color: C.primary, fontWeight: 'bold' }}>{bound}</text>
      </Pressable>
    );
  }

  if (field.kind === 'toggle') {
    const on = value === 'true';
    // A toggle inline in a sentence usually needs no baked-in label — the
    // words around it already say what it means ("Toggle X collision to ⚪").
    // `linkable` adds the same 🔗 a text/vector slot gets, so a boolean can
    // come from a variable instead of being flipped by hand.
    return (
      <view style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <Pressable
          onClick={() => onChange(on ? '' : 'true')}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            borderRadius: 10,
            borderWidth: 1, borderColor: on ? accent : 'rgba(255,255,255,0.18)',
            backgroundColor: on ? accentWash(accent, 0.18) : 'rgba(255,255,255,0.05)',
            paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2,
          }}
        >
          {field.label ? (
            <text style={{ fontSize: 10.5, color: on ? accent : C.textMuted, fontWeight: 'bold' }}>
              {field.label}
            </text>
          ) : null}
          <view style={{
            width: 18, height: 11, borderRadius: 6,
            backgroundColor: on ? accent : 'rgba(255,255,255,0.20)',
            padding: 1.5,
            alignItems: on ? 'flex-end' : 'flex-start', justifyContent: 'center',
          }}>
            <view style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />
          </view>
        </Pressable>
        {field.linkable ? (
          <Pressable
            onClick={() => onOpen(open ? '' : field.key)}
            style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}
          >
            <icon set="material-rounded" style={{ fontSize: 11, color: open ? C.primary : C.textMuted, lineHeight: 11 }}>link</icon>
          </Pressable>
        ) : null}
      </view>
    );
  }

  if (field.kind === 'vector') {
    const axes = (value || '').split(',');
    const setAxis = (i: number, v: string) => {
      const next = [axes[0] ?? '', axes[1] ?? '', axes[2] ?? ''];
      next[i] = v;
      onChange(next.join(','));
    };
    return (
      <view style={{
        flexDirection: 'row', alignItems: 'center', gap: 2,
        borderRadius: 6,
        borderWidth: 1, borderColor: open ? C.primary : 'rgba(255,255,255,0.16)',
        backgroundColor: 'rgba(0,0,0,0.35)',
        paddingLeft: 6, paddingRight: 2,
      }}>
        {['X', 'Y', 'Z'].map((ax, i) => (
          <view key={ax} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <text style={{ fontSize: 10.5, color: C.textMuted }}>{ax}</text>
            <input
              value={axes[i] ?? ''}
              onChange={(val: any) => setAxis(i, String(val ?? ''))}
              placeholder="0"
              style={{
                width: 26, fontSize: 11.5, color: C.text,
                backgroundColor: 'transparent', borderWidth: 0, minHeight: 22,
              }}
            />
          </view>
        ))}
        <Pressable
          onClick={() => onOpen(open ? '' : field.key)}
          style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon set="material-rounded" style={{ fontSize: 12, color: open ? C.primary : C.textMuted, lineHeight: 12 }}>link</icon>
        </Pressable>
      </view>
    );
  }

  if (field.kind === 'select') {
    return (
      <Pressable
        onClick={() => onOpen(open ? '' : field.key)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 3,
          borderRadius: 6,
          borderWidth: 1, borderColor: open ? C.primary : 'rgba(255,255,255,0.16)',
          backgroundColor: 'rgba(255,255,255,0.07)',
          paddingLeft: 7, paddingRight: 5, paddingTop: 3, paddingBottom: 3,
        }}
      >
        <text style={{ fontSize: 11.5, color: C.text }}>{value || field.options?.[0] || field.label}</text>
        <icon set="material-rounded" style={{ fontSize: 12, color: C.textMuted, lineHeight: 12 }}>expand_more</icon>
      </Pressable>
    );
  }

  // Literal text / number: typed in place, with the link button beside it.
  return (
    <view style={{
      flexDirection: 'row', alignItems: 'center',
      borderRadius: 6,
      borderWidth: 1, borderColor: open ? C.primary : 'rgba(255,255,255,0.16)',
      backgroundColor: 'rgba(0,0,0,0.35)',
      paddingLeft: 6, paddingRight: 2,
    }}>
      <input
        value={value}
        onChange={(val: any) => onChange(String(val ?? ''))}
        placeholder={field.placeholder ?? field.label}
        style={{
          width: 58, fontSize: 11.5, color: C.text,
          backgroundColor: 'transparent', borderWidth: 0, minHeight: 22,
        }}
      />
      <Pressable
        onClick={() => onOpen(open ? '' : field.key)}
        style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
      >
        <icon set="material-rounded" style={{ fontSize: 12, color: open ? C.primary : C.textMuted, lineHeight: 12 }}>link</icon>
      </Pressable>
    </view>
  );
}

// The picker that opens under a sentence: the select's options, or the
// variables this slot can be linked to.
function NodeSlotPicker({ field, value, onChange, onClose }: {
  field: LogicField;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const variables = React.useContext(LogicVarsContext);
  const bound = boundVariable(value);
  const linkable = field.kind !== 'toggle' || field.linkable;

  return (
    <view style={{
      flexDirection: 'column', gap: 6,
      marginTop: 7,
      borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
      paddingTop: 7,
    }}>
      <text style={{ fontSize: 9, color: C.textMuted, fontWeight: 'bold', letterSpacing: 1 }}>
        {field.label.toUpperCase()}
      </text>
      {isObjectField(field) ? (
        <text style={{ fontSize: 9.5, color: C.textMuted, lineHeight: 14 }}>
          “specific” on means this exact object; off means any object of the same kind.
        </text>
      ) : null}

      {field.kind === 'select' && field.options?.length ? (
        <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
          {field.options.map(opt => {
            const on = (value || field.options?.[0]) === opt;
            return (
              <Pressable
                key={opt}
                onClick={() => { onChange(opt); onClose(); }}
                style={{
                  borderRadius: 6,
                  borderWidth: 1, borderColor: on ? C.primary : 'rgba(255,255,255,0.14)',
                  backgroundColor: on ? 'rgba(91,156,255,0.16)' : 'rgba(255,255,255,0.04)',
                  paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                }}
              >
                <text style={{ fontSize: 11, color: on ? C.primary : C.text }}>{opt}</text>
              </Pressable>
            );
          })}
        </view>
      ) : null}

      {linkable ? (
        <>
          <text style={{ fontSize: 9.5, color: C.textMuted }}>
            {variables.length ? 'Link to a variable' : 'No variables yet — add one in the Variables panel.'}
          </text>
          <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
            {variables.map(v => {
              const meta = VAR_SOURCE_META[v.source];
              const on   = bound === v.name;
              return (
                <Pressable
                  key={v.id}
                  onClick={() => { onChange(`{{${v.name}}}`); onClose(); }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 4,
                    borderRadius: 6,
                    borderWidth: 1, borderColor: on ? C.primary : 'rgba(255,255,255,0.14)',
                    backgroundColor: on ? 'rgba(91,156,255,0.16)' : 'rgba(255,255,255,0.04)',
                    paddingLeft: 6, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                  }}
                >
                  <icon set="material-rounded" style={{ fontSize: 11, color: meta.accent, lineHeight: 11 }}>{meta.icon}</icon>
                  <text style={{ fontSize: 10.5, color: C.text }}>{v.name}</text>
                </Pressable>
              );
            })}
            {bound ? (
              <Pressable
                onClick={() => { onChange(''); onClose(); }}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 4,
                  borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                  paddingLeft: 6, paddingRight: 8, paddingTop: 4, paddingBottom: 4,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 11, color: C.red, lineHeight: 11 }}>link_off</icon>
                <text style={{ fontSize: 10.5, color: C.red }}>Unlink</text>
              </Pressable>
            ) : null}
          </view>
        </>
      ) : null}
    </view>
  );
}

// A node on the canvas. Everything about it is edited right here: the sentence
// slots, the leftover fields, and — once selected — the reorder / duplicate /
// delete / skip controls.
function WorkflowNode({ step, meta, accent, selected, dimmed, pinned, onSelect, onPatch }: {
  step: LogicStep;
  meta?: typeof ACTION_CATALOG[number];
  accent: string;
  selected: boolean;
  dimmed?: boolean;
  pinned?: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<LogicStep>) => void;
}) {
  const [openSlot, setOpenSlot] = useState('');

  const fields   = meta?.fields ?? [];
  const parts    = parseTemplate(meta?.template ?? meta?.label ?? 'Node');
  const inline   = new Set(parts.flatMap(p => ('slot' in p ? [p.slot] : [])));
  const leftover = fields.filter(f => !inline.has(f.key));
  const openField = fields.find(f => f.key === openSlot);

  function set(key: string, value: string) {
    onPatch({ params: { ...step.params, [key]: value } });
  }

  // The pinned root is a plain view: it has no toolbar to open, and the trigger
  // chip it carries needs its own taps (a nested Pressable would bubble).
  const Shell: any = pinned ? 'view' : Pressable;

  return (
    <Shell
      {...(pinned ? {} : { onClick: onSelect })}
      style={{
        flexDirection: 'column',
        backgroundColor: selected ? 'rgba(91,156,255,0.10)' : 'rgba(30,30,34,0.94)',
        borderRadius: 10,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? C.primary : 'rgba(255,255,255,0.10)',
        paddingLeft: 8, paddingRight: 8, paddingTop: 8, paddingBottom: 8,
        opacity: dimmed ? 0.5 : 1,
      }}
    >
      {/* The sentence. Wraps like text, but every slot is live. */}
      <view style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
        <view style={{
          width: 24, height: 24, borderRadius: 7,
          backgroundColor: accent,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <icon set="material-rounded-filled" style={{ fontSize: 13, color: '#000', lineHeight: 13 }}>
            {meta?.icon ?? 'bolt'}
          </icon>
        </view>

        {parts.map((part, i) => {
          if ('text' in part) {
            const t = part.text.trim();
            if (!t) return null;
            return (
              <text key={`t${i}`} style={{ fontSize: 11.5, color: C.text }}>{t}</text>
            );
          }
          const field = fields.find(f => f.key === part.slot);
          if (!field) return null;
          const slot = (
            <NodeSlot
              field={field}
              value={step.params[field.key] ?? ''}
              accent={accent}
              open={openSlot === field.key}
              onOpen={k => setOpenSlot(k)}
              onChange={v => set(field.key, v)}
            />
          );
          if (!isObjectField(field)) return <React.Fragment key={`s${i}`}>{slot}</React.Fragment>;
          return (
            <view key={`s${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {slot}
              <SpecificToggle
                on={step.params[specificKey(field.key)] === 'true'}
                accent={accent}
                onToggle={() => set(specificKey(field.key), step.params[specificKey(field.key)] === 'true' ? '' : 'true')}
              />
            </view>
          );
        })}

        {!step.enabled ? (
          <view style={{
            backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 4,
            paddingLeft: 5, paddingRight: 5, paddingTop: 1, paddingBottom: 1,
          }}>
            <text style={{ fontSize: 9, color: C.textMuted, fontWeight: 'bold' }}>SKIPPED</text>
          </view>
        ) : null}
      </view>

      {/* Fields the sentence does not mention (the Execute root's Repeat, and
          any node whose template leaves a parameter out). */}
      {leftover.map(f => (
        <view
          key={f.key}
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, paddingLeft: 31 }}
        >
          {f.kind === 'toggle' ? null : (
            <text style={{ fontSize: 11, color: C.textMuted }}>{f.label}</text>
          )}
          <NodeSlot
            field={f}
            value={step.params[f.key] ?? ''}
            accent={accent}
            open={openSlot === f.key}
            onOpen={k => setOpenSlot(k)}
            onChange={v => set(f.key, v)}
          />
          {isObjectField(f) ? (
            <SpecificToggle
              on={step.params[specificKey(f.key)] === 'true'}
              accent={accent}
              onToggle={() => set(specificKey(f.key), step.params[specificKey(f.key)] === 'true' ? '' : 'true')}
            />
          ) : null}
        </view>
      ))}

      {openField ? (
        <NodeSlotPicker
          field={openField}
          value={step.params[openField.key] ?? ''}
          onChange={v => set(openField.key, v)}
          onClose={() => setOpenSlot('')}
        />
      ) : null}

    </Shell>
  );
}

function WorkflowCanvas({ workflow, selection, onSelect, onChange }: {
  workflow: LogicWorkflow;
  selection: LogicSelection;
  onSelect: (sel: LogicSelection) => void;
  onChange: (next: LogicWorkflow) => void;
}) {
  // null = closed; otherwise the index the new step is inserted at.
  const [paletteAt, setPaletteAt] = useState<number | null>(null);

  // Node edits happen on the canvas now, so the canvas owns the step ops too.
  const rooted = workflow.steps[0]?.type === 'execute';

  function addStep(type: ActionType, at: number) {
    // The palette never offers Execute, and nothing may land above the root.
    if (type === 'execute') { setPaletteAt(null); return; }
    const meta = actionMeta(type);
    const step: LogicStep = {
      id: logicId('step'),
      type,
      params: blankParams(meta?.fields ?? []),
      guards: [],
      enabled: true,
    };
    const steps = [...workflow.steps];
    steps.splice(Math.max(at, rooted ? 1 : 0), 0, step);
    onChange({ ...workflow, steps });
    setPaletteAt(null);
    onSelect({ kind: 'step', id: step.id });
  }

  function patchStep(id: string, patch: Partial<LogicStep>) {
    onChange({ ...workflow, steps: workflow.steps.map(s => (s.id === id ? { ...s, ...patch } : s)) });
  }
  function moveStep(id: string, delta: number) {
    const i = workflow.steps.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= workflow.steps.length) return;
    if (rooted && (i === 0 || j === 0)) return;   // the Execute root stays put
    const steps = [...workflow.steps];
    const [moved] = steps.splice(i, 1);
    steps.splice(j, 0, moved);
    onChange({ ...workflow, steps });
  }
  function duplicateStep(id: string) {
    const i = workflow.steps.findIndex(s => s.id === id);
    if (i < 0) return;
    const src  = workflow.steps[i];
    if (src.type === 'execute') return;   // one root, never a copy of it
    const copy: LogicStep = {
      ...src,
      id: logicId('step'),
      params: { ...src.params },
      guards: src.guards.map(g => ({ ...g, id: logicId('guard'), params: { ...g.params } })),
    };
    const steps = [...workflow.steps];
    steps.splice(i + 1, 0, copy);
    onChange({ ...workflow, steps });
    onSelect({ kind: 'step', id: copy.id });
  }
  function deleteStep(id: string) {
    if (workflow.steps.find(s => s.id === id)?.type === 'execute') return;
    // Delete and nothing else. The selection is left pointing at an id that no
    // longer exists, so the action bar just closes — no jump to the trigger.
    onChange({ ...workflow, steps: workflow.steps.filter(s => s.id !== id) });
  }

  const selected = (s: LogicSelection) =>
    s.kind === selection.kind && (s.kind !== 'step' || (selection.kind === 'step' && selection.id === s.id));

  const selectedIdx  = selection.kind === 'step' ? workflow.steps.findIndex(s => s.id === selection.id) : -1;
  const selectedStep = selectedIdx >= 0 ? workflow.steps[selectedIdx] : undefined;
  const selectedIsRoot = selectedIdx === 0 && selectedStep?.type === 'execute';

  return (
    <view style={{ flex: 1, height: 1, flexDirection: 'column' } as any}>
      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: 16, flexDirection: 'column' }}>
          {/* Steps, each preceded by an insertion point (except the first, which
              sits at the top of the chain now that the event card is gone). */}
          {workflow.steps.map((step, i) => {
            const meta = actionMeta(step.type);
            return (
              <React.Fragment key={step.id}>
                {paletteAt === i ? (
                  <view style={{ marginTop: 8, marginBottom: 8 }}>
                    <ActionPalette onPick={t => addStep(t, i)} onCancel={() => setPaletteAt(null)} />
                  </view>
                ) : i > 0 ? (
                  <LogicConnector onAdd={() => setPaletteAt(i)} />
                ) : null}
                <WorkflowNode
                  step={step}
                  meta={meta}
                  accent={nodeAccent(step.type)}
                  selected={selected({ kind: 'step', id: step.id })}
                  dimmed={!workflow.enabled}
                  pinned={i === 0 && step.type === 'execute'}
                  onSelect={() => onSelect({ kind: 'step', id: step.id })}
                  onPatch={patch => patchStep(step.id, patch)}
                />
              </React.Fragment>
            );
          })}

          {/* Trailing insertion point */}
          {paletteAt === workflow.steps.length ? (
            <view style={{ marginTop: 8 }}>
              <ActionPalette
                onPick={t => addStep(t, workflow.steps.length)}
                onCancel={() => setPaletteAt(null)}
              />
            </view>
          ) : (
            <LogicConnector onAdd={() => setPaletteAt(workflow.steps.length)} />
          )}
        </view>
      </scroll>

      {/* Actions for the selected node. Off the card, so a node is only ever
          its sentence — but reorder / duplicate / skip / delete stay reachable. */}
      {selectedStep && !selectedIsRoot ? (
        <view style={{
          flexDirection: 'row', alignItems: 'center', gap: 6,
          borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
          paddingLeft: 10, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
        }}>
          <Pressable
            onClick={() => moveStep(selectedStep.id, -1)}
            style={{ width: 30, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: 'rgba(255,255,255,0.06)', opacity: selectedIdx > (rooted ? 1 : 0) ? 1 : 0.35 }}
          >
            <icon set="material-rounded" style={{ fontSize: 15, color: C.text, lineHeight: 15 }}>arrow_upward</icon>
          </Pressable>
          <Pressable
            onClick={() => moveStep(selectedStep.id, 1)}
            style={{ width: 30, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: 'rgba(255,255,255,0.06)', opacity: selectedIdx < workflow.steps.length - 1 ? 1 : 0.35 }}
          >
            <icon set="material-rounded" style={{ fontSize: 15, color: C.text, lineHeight: 15 }}>arrow_downward</icon>
          </Pressable>
          <Pressable
            onClick={() => duplicateStep(selectedStep.id)}
            style={{ width: 30, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: 'rgba(255,255,255,0.06)' }}
          >
            <icon set="material-rounded" style={{ fontSize: 15, color: C.text, lineHeight: 15 }}>content_copy</icon>
          </Pressable>
          <Pressable
            onClick={() => patchStep(selectedStep.id, { enabled: !selectedStep.enabled })}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, borderRadius: 7,
                     backgroundColor: 'rgba(255,255,255,0.06)', paddingLeft: 9, paddingRight: 10 }}
          >
            <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>
              {selectedStep.enabled ? 'visibility' : 'visibility_off'}
            </icon>
            <text style={{ fontSize: 11, color: C.textMuted }}>{selectedStep.enabled ? 'On' : 'Skipped'}</text>
          </Pressable>
          <view style={{ flex: 1, width: 1 }} />
          <Pressable
            onClick={() => deleteStep(selectedStep.id)}
            style={{ width: 30, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: 'rgba(255,69,58,0.16)' }}
          >
            <icon set="material-rounded" style={{ fontSize: 15, color: C.red, lineHeight: 15 }}>delete</icon>
          </Pressable>
        </view>
      ) : null}
    </view>
  );
}

// ── Properties inspector ────────────────────────────────────────────────────
// Bubble's right-hand panel: a Properties block for the selected node, an
// Execution options block, and the Only when condition block.

// ── Variables ───────────────────────────────────────────────────────────────
// Names the creator gives to things in the scene so workflows can refer to them.
// Adding one is a two-step flow: pick WHAT is being named (an asset, an element
// connected to an asset, or an Interface button), then choose the name. The
// listing is re-read from Unity each time the flow opens, because objects come
// and go while the panel is docked.

function VarPickRow({ icon: iconName, accent, label, meta, onPick }: {
  icon: string;
  accent: string;
  label: string;
  meta?: string;
  onPick: () => void;
}) {
  return (
    <Pressable
      onClick={onPick}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderRadius: 8,
        paddingLeft: 8, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
      }}
    >
      <view style={{
        width: 24, height: 24, borderRadius: 7,
        backgroundColor: accent,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded-filled" style={{ fontSize: 13, color: '#000', lineHeight: 13 }}>{iconName}</icon>
      </view>
      <view style={{ flex: 1, width: 1 }}>
        <text style={{ fontSize: 11.5, color: C.text }}>{label}</text>
        {meta ? <text style={{ fontSize: 9.5, color: C.textMuted, marginTop: 1 }}>{meta}</text> : null}
      </view>
      <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>chevron_right</icon>
    </Pressable>
  );
}

function VariablesPane({ variables, onChange, onPickInterface, onPickInViewport }: {
  variables: LogicVariable[];
  onChange: (next: LogicVariable[]) => void;
  // Interface picking docks to the right of the screen instead of living
  // inline here — that panel is owned by CustomLogicPanel, which is the only
  // place with a screen-relative (not left-panel-relative) absolute context.
  // Passed the id of the variable being (re)assigned.
  onPickInterface: (varId: string) => void;
  // Asset/Element Assign — clears the screen down to the bare 3D viewport and
  // reports the next object the user taps. Owned by EditorScreen, the only
  // level that can hide the rest of the editor chrome.
  onPickInViewport: (varId: string) => void;
}) {
  // "+" drops an unnamed, unassigned slot straight into the list (Struckd's
  // pattern) — naming and target-picking both happen afterward, in place, via
  // the row's own textbox and Assign button.
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  function addUnassignedVar(source: LogicVarSource) {
    const base = source === 'interface' ? 'New Button' : 'New Object';
    const taken = new Set(variables.map(v => v.name.toLowerCase()));
    let name = base, n = 2;
    while (taken.has(name.toLowerCase())) { name = `${base} ${n}`; n++; }
    onChange([...variables, { id: logicId('var'), name, source, target: '' }]);
    setAddMenuOpen(false);
  }

  // Assign routes to whichever picker fits the variable's source. Both kinds
  // report back to this same row (by id) — neither ever creates a new one.
  function openAssign(v: LogicVariable) {
    if (v.source === 'interface') onPickInterface(v.id);
    else                          onPickInViewport(v.id);
  }

  const duplicate = (n: string, selfId?: string) =>
    variables.some(v => v.id !== selfId && v.name.toLowerCase() === n.trim().toLowerCase());

  // ── List ──────────────────────────────────────────────────────────────────
  return (
    <view style={{ flex: 1, height: 1, flexDirection: 'column' } as any}>
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 12, paddingRight: 10, paddingTop: 10, paddingBottom: 8,
      }}>
        <view style={{ flex: 1, width: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <text style={{ fontSize: 12.5, color: C.text, fontWeight: 'bold' }}>Variables</text>
          <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>expand_more</icon>
        </view>
        <Pressable
          onClick={() => setAddMenuOpen(o => !o)}
          style={{
            width: 26, height: 26, borderRadius: 13,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: addMenuOpen ? 'rgba(91,156,255,0.20)' : 'rgba(255,255,255,0.06)',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 15, color: addMenuOpen ? C.primary : C.text, lineHeight: 15 }}>add</icon>
        </Pressable>
      </view>

      {/* "+" dropdown — Asset / Interface. Sits inline right under the header,
          matching this file's other menu popovers (WorkflowListRail's "…"). */}
      {addMenuOpen ? (
        <view style={{
          marginLeft: 12, marginRight: 12, marginBottom: 8,
          backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 8,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
          flexDirection: 'column',
        } as any}>
          <Pressable
            onClick={() => addUnassignedVar('asset')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 9, paddingBottom: 9 }}
          >
            <icon set="material-rounded" style={{ fontSize: 14, color: VAR_SOURCE_META.asset.accent, lineHeight: 14 }}>{VAR_SOURCE_META.asset.icon}</icon>
            <text style={{ fontSize: 12, color: C.text }}>Asset</text>
          </Pressable>
          <view style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <Pressable
            onClick={() => addUnassignedVar('interface')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 9, paddingBottom: 9 }}
          >
            <icon set="material-rounded" style={{ fontSize: 14, color: VAR_SOURCE_META.interface.accent, lineHeight: 14 }}>{VAR_SOURCE_META.interface.icon}</icon>
            <text style={{ fontSize: 12, color: C.text }}>Interface</text>
          </Pressable>
        </view>
      ) : null}

      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 16, flexDirection: 'column', gap: 6 }}>
          {/* Built in, always there, never editable — like Struckd's Self. */}
          <view style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingLeft: 8, paddingRight: 8, paddingTop: 7, paddingBottom: 7,
          }}>
            <view style={{
              width: 24, height: 24, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.14)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <icon set="material-rounded-filled" style={{ fontSize: 13, color: C.text, lineHeight: 13 }}>adjust</icon>
            </view>
            <view style={{ flex: 1, width: 1 }}>
              <text style={{ fontSize: 11.5, color: C.text, fontWeight: 'bold' }}>Self</text>
              <text style={{ fontSize: 9.5, color: C.textMuted, marginTop: 1 }}>
                The object these workflows run on
              </text>
            </view>
            <text style={{ fontSize: 10, color: C.textMuted }}>Object</text>
          </view>

          {variables.length === 0 ? (
            <text style={{ fontSize: 11, color: C.textMuted, lineHeight: 16 }}>
              Name an asset or an Interface button, and every workflow field on
              this object can use it as {'{{name}}'}.
            </text>
          ) : null}

          {variables.map(v => {
            const meta = VAR_SOURCE_META[v.source];
            const bad  = duplicate(v.name, v.id);
            const assignedLabel = v.source === 'part' && v.owner ? `${v.target} · ${v.owner}` : v.target;
            return (
              <view
                key={v.id}
                style={{
                  flexDirection: 'column',
                  backgroundColor: 'rgba(255,255,255,0.04)',
                  borderRadius: 8,
                  borderWidth: 1, borderColor: bad ? 'rgba(255,69,58,0.55)' : 'rgba(255,255,255,0.08)',
                  paddingLeft: 8, paddingRight: 8, paddingTop: 7, paddingBottom: 7,
                }}
              >
                <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {/* Name — the {{handle}} workflow fields will refer to. */}
                  <view style={{
                    flex: 1, width: 1,
                    backgroundColor: C.surface, borderRadius: 6,
                    paddingLeft: 7, paddingRight: 7, paddingTop: 1, paddingBottom: 1,
                  }}>
                    <input
                      value={v.name}
                      onChange={(val: any) => onChange(variables.map(x =>
                        x.id === v.id ? { ...x, name: sanitizeVarName(String(val ?? '')) } : x))}
                      placeholder="Name"
                      style={{ fontSize: 11.5, color: C.text, backgroundColor: 'transparent', borderWidth: 0, minHeight: 24 }}
                    />
                  </view>
                  {/* What it's currently pointing at. */}
                  <view style={{ flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 84 }}>
                    <icon set="material-rounded-filled" style={{ fontSize: 10, color: meta.accent, lineHeight: 10 }}>{meta.icon}</icon>
                    <text
                      style={{
                        fontSize: 10, color: v.target ? C.text : C.textMuted, flex: 1, width: 1,
                        maxLines: 1, textOverflow: 'ellipsis',
                      } as any}
                    >
                      {v.target ? assignedLabel : 'Not assigned'}
                    </text>
                  </view>
                  {/* Assign — (re)opens the picker that fits this variable's source. */}
                  <Pressable
                    onClick={() => openAssign(v)}
                    style={{
                      paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5,
                      borderRadius: 12, backgroundColor: 'rgba(91,156,255,0.16)',
                    }}
                  >
                    <text style={{ fontSize: 10.5, color: C.primary, fontWeight: 'bold' }}>Assign</text>
                  </Pressable>
                  <Pressable
                    onClick={() => onChange(variables.filter(x => x.id !== v.id))}
                    style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <icon set="material-rounded" style={{ fontSize: 14, color: C.textMuted, lineHeight: 14 }}>delete</icon>
                  </Pressable>
                </view>
                {bad ? (
                  <text style={{ fontSize: 9.5, color: C.red, marginTop: 4, marginLeft: 2 }}>
                    Duplicate name — workflows cannot tell these apart.
                  </text>
                ) : null}
              </view>
            );
          })}
        </view>
      </scroll>
    </view>
  );
}

// Docked to the right of the screen — the Workflow panel already owns the
// left edge, and this is opened from inside it, so it needs its own
// screen-relative absolute context rather than nesting inside that panel's
// box (which would anchor "right" to the panel's own edge, not the screen's).
function IfacePickerPanel({ onPick, onClose }: {
  onPick: (target: string) => void;
  onClose: () => void;
}) {
  const [iface, setIface] = useState<{ label: string; target: string }[]>([]);
  useEffect(() => { setIface(readInterfaceElements()); }, []);
  // Self-owned size — this picker is opened from inside the Workflow panel
  // rather than from the top bar, so it isn't part of the shared modal slot.
  const [size, setSize] = useState<'default' | 'full'>('default');

  return (
    <view style={{
      position: 'absolute',
      right: safeAreaRight(),
      top: safeAreaTop(),
      bottom: safeAreaBottom(),
      ...(size === 'full' ? { left: safeAreaLeft() + 6 } : { width: EDITOR_SIDE_PANEL_WIDTH }),
      ...glass({ fill: 'rgba(20,20,22,0.94)' }),
      borderTopLeftRadius: 14, borderBottomLeftRadius: 14,
      borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
      zIndex: 55,
      flexDirection: 'column',
    } as any}>
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 14, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
      }}>
        <text style={{ flex: 1, fontSize: 13, color: C.text, fontWeight: 'bold' }}>Pick an Interface</text>
        <PanelExpandButton size={size} onToggle={() => setSize(s => s === 'full' ? 'default' : 'full')} />
        <Pressable
          onClick={onClose}
          style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>close</icon>
        </Pressable>
      </view>
      <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
        <view style={{ padding: 10, flexDirection: 'column', gap: 5 }}>
          {iface.length ? (
            iface.map(b => (
              <VarPickRow
                key={b.target}
                icon={VAR_SOURCE_META.interface.icon}
                accent={VAR_SOURCE_META.interface.accent}
                label={b.label}
                meta="Interface button"
                onPick={() => onPick(b.target)}
              />
            ))
          ) : (
            <text style={{ fontSize: 11, color: C.textMuted, paddingTop: 8 }}>
              No Interface buttons yet — add them from Tools › Interface.
            </text>
          )}
        </view>
      </scroll>
    </view>
  );
}

// ── Interface Builder — shared element rendering ────────────────────────────

function renderIfaceElementContent(el: IfaceElement) {
  switch (el.kind) {
    case 'button':
      return (
        <view style={{
          flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: el.bgColor ?? 'rgba(0,0,0,0.60)',
          borderRadius: el.cornerRadius ?? 10, paddingLeft: 12, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
        }}>
          {el.icon ? (isMaterialIconName(el.icon) ? (
            <icon set="material-rounded" style={{ fontSize: 16, lineHeight: 16, color: el.textColor ?? '#fff' }}>{el.icon}</icon>
          ) : (
            <text style={{ fontSize: 16, lineHeight: 16 }}>{el.icon}</text>
          )) : null}
          <text style={{ fontSize: 12, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label || 'Button'}</text>
        </view>
      );
    case 'text':
      return <text style={{ fontSize: 13, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label || 'Text'}</text>;
    case 'image':
      return (
        <view style={{
          width: '100%', height: '100%', minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center',
          backgroundColor: el.bgColor ?? 'rgba(255,255,255,0.10)', borderRadius: el.cornerRadius ?? 10,
        }}>
          {el.icon && !isMaterialIconName(el.icon) ? (
            <text style={{ fontSize: 24, lineHeight: 24 }}>{el.icon}</text>
          ) : (
            <icon set="material-rounded" style={{ fontSize: 24, lineHeight: 24, color: el.textColor ?? C.text }}>{el.icon || 'image'}</icon>
          )}
        </view>
      );
    case 'panel':
      return (
        <view style={{
          width: '100%', height: '100%', minWidth: 100, minHeight: 60,
          backgroundColor: el.bgColor ?? 'rgba(18,18,24,0.96)', borderRadius: el.cornerRadius ?? 14,
          padding: 12, flexDirection: 'column', gap: 4,
        }}>
          {el.label ? <text style={{ fontSize: 13, color: el.textColor ?? '#fff', fontWeight: 'bold' }}>{el.label}</text> : null}
          {el.body ? <text style={{ fontSize: 11, color: el.textColor ?? '#fff', opacity: 0.85 }}>{el.body}</text> : null}
        </view>
      );
  }
}

function ElementInspector({ el, onChange, onDelete, onOpenLogic, hasWorkflow }: {
  el: IfaceElement;
  onChange: (patch: Partial<IfaceElement>) => void;
  onDelete: () => void;
  onOpenLogic: () => void;
  hasWorkflow: boolean;
}) {
  const [showIconPicker, setShowIconPicker] = useState(false);
  const canHaveLogic = el.kind === 'button' || el.kind === 'image';
  return (
    <scroll style={{ flex: 1, height: 1 }}>
      <view style={{ padding: 12, flexDirection: 'column', gap: 10 }}>
        <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <icon set="material-rounded" style={{ fontSize: 16, color: C.blue, lineHeight: 16 }}>{IFACE_KIND_META[el.kind].icon}</icon>
          <text style={{ flex: 1, fontSize: 13, color: '#fff', fontWeight: 'bold' }}>{IFACE_KIND_META[el.kind].label}</text>
          {canHaveLogic ? (
            <GlassButton onClick={onOpenLogic} style={{
              flexDirection: 'row', alignItems: 'center', gap: 4,
              paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5, borderRadius: 8,
              backgroundColor: 'rgba(30,140,255,0.18)', borderWidth: 0,
            }}>
              <icon set="material-rounded" style={{ fontSize: 13, color: C.blue, lineHeight: 13 }}>bolt</icon>
              <text style={{ fontSize: 11, color: C.blue, fontWeight: 'bold' }}>{hasWorkflow ? 'Edit Logic' : 'Add Logic'}</text>
            </GlassButton>
          ) : null}
          <GlassButton onClick={onDelete} style={{ width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,69,58,0.14)', borderWidth: 0 }}>
            <icon set="material-rounded" style={{ fontSize: 15, color: '#ff453a', lineHeight: 15 }}>delete</icon>
          </GlassButton>
        </view>

        {(el.kind === 'button' || el.kind === 'text' || el.kind === 'panel') ? (
          <view style={{ flexDirection: 'column', gap: 4 }}>
            <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>{el.kind === 'panel' ? 'TITLE' : 'LABEL'}</text>
            <input
              value={el.label ?? ''}
              onChange={(e: any) => onChange({ label: e?.target?.value ?? e })}
              maxLength={60}
              style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
            />
          </view>
        ) : null}

        {el.kind === 'panel' ? (
          <view style={{ flexDirection: 'column', gap: 4 }}>
            <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>BODY TEXT</text>
            <input
              value={el.body ?? ''}
              onChange={(e: any) => onChange({ body: e?.target?.value ?? e })}
              maxLength={300}
              style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
            />
          </view>
        ) : null}

        {(el.kind === 'button' || el.kind === 'image') ? (
          <view style={{ flexDirection: 'column', gap: 4 }}>
            <view style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>ICON</text>
              <GlassButton onClick={() => setShowIconPicker(v => !v)} style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 0 }}>
                <text style={{ fontSize: 10, color: C.text }}>{showIconPicker ? 'Hide' : 'Browse'}</text>
              </GlassButton>
            </view>
            {showIconPicker ? (
              <IconPicker value={el.icon} onPick={(name) => onChange({ icon: name })} />
            ) : el.icon ? (
              <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {isMaterialIconName(el.icon) ? (
                  <icon set="material-rounded" style={{ fontSize: 20, color: C.text, lineHeight: 20 }}>{el.icon}</icon>
                ) : (
                  <text style={{ fontSize: 20, lineHeight: 20 }}>{el.icon}</text>
                )}
                <text style={{ fontSize: 11, color: C.secondary }}>{el.icon}</text>
              </view>
            ) : null}
          </view>
        ) : null}

        {(el.kind === 'image' || el.kind === 'panel') ? (
          <view style={{ flexDirection: 'row', gap: 8 }}>
            <view style={{ flex: 1, flexDirection: 'column', gap: 4 }}>
              <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>WIDTH %</text>
              <input
                value={String(el.w ?? 20)}
                onChange={(e: any) => { const n = Number(e?.target?.value ?? e); if (isFinite(n)) onChange({ w: Math.max(4, Math.min(100, n)) }); }}
                style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
              />
            </view>
            <view style={{ flex: 1, flexDirection: 'column', gap: 4 }}>
              <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>HEIGHT %</text>
              <input
                value={String(el.h ?? 20)}
                onChange={(e: any) => { const n = Number(e?.target?.value ?? e); if (isFinite(n)) onChange({ h: Math.max(4, Math.min(100, n)) }); }}
                style={{ fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 }}
              />
            </view>
          </view>
        ) : null}

        <view style={{ flexDirection: 'column', gap: 4 }}>
          <text style={{ fontSize: 10, color: C.secondary, fontWeight: 'bold' }}>COLOR</text>
          <view style={{ flexDirection: 'row', gap: 6 }}>
            {IFACE_COLOR_SWATCHES.map(c => (
              <GlassButton key={c} onClick={() => onChange({ bgColor: c })} style={{
                width: 26, height: 26, borderRadius: 13, backgroundColor: c,
                borderWidth: el.bgColor === c ? 2 : 1, borderColor: el.bgColor === c ? C.blue : 'rgba(255,255,255,0.2)',
              }} />
            ))}
          </view>
        </view>
      </view>
    </scroll>
  );
}

// Design tab — drag-and-drop canvas. Placement/reposition uses the same
// poll-while-pointer-down pattern as the 3D asset-drag flow above (there's no
// onPointerMove-with-local-coords API here), converted into canvas-relative
// percentages via editorPointerRefX/Y (Unity-side ref-unit conversion) minus
// the canvas's own analytically-known rect (see IFACE_* layout constants).
function InterfaceCanvasPanel({ elements, workflows, selectedId, onSelect, onChange, onOpenLogicForSelected }: {
  elements: IfaceElement[];
  workflows: IfaceWorkflow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: IfaceElement[]) => void;
  onOpenLogicForSelected: () => void;
}) {
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const [placingKind, setPlacingKind] = useState<IfaceElementKind | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; inBounds: boolean } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  function canvasRect() {
    const top    = safeAreaTop() + IFACE_HEADER_H + IFACE_TABBAR_H + IFACE_PALETTE_H + IFACE_PAD;
    const left   = safeAreaLeft() + IFACE_PAD;
    const width  = Math.max(40, refScreenWidth()  - safeAreaLeft() - safeAreaRight() - IFACE_PAD * 2);
    const height = Math.max(40, refScreenHeight() - top - safeAreaBottom() - IFACE_PAD);
    return { top, left, width, height };
  }

  useEffect(() => {
    if (!placingKind) return;
    let placed = false;
    const t = setInterval(() => {
      let down = true;
      try { down = String((Globals as any).isPointerDown?.() ?? 'true') === 'true'; } catch {}
      const rect = canvasRect();
      const rx = editorPointerRefX(), ry = editorPointerRefY();
      const px = ((rx - rect.left) / rect.width) * 100;
      const py = ((ry - rect.top) / rect.height) * 100;
      const inBounds = px >= -2 && px <= 102 && py >= -2 && py <= 102;
      if (down) {
        setGhost({ x: Math.max(0, Math.min(96, px)), y: Math.max(0, Math.min(96, py)), inBounds });
      } else {
        clearInterval(t);
        if (inBounds && !placed) {
          placed = true;
          const el = defaultIfaceElement(placingKind, Math.max(0, Math.min(96, px)), Math.max(0, Math.min(96, py)));
          onChange([...elementsRef.current, el]);
          onSelect(el.id);
        }
        setPlacingKind(null);
        setGhost(null);
      }
    }, 33);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placingKind]);

  useEffect(() => {
    if (!movingId) return;
    const t = setInterval(() => {
      let down = true;
      try { down = String((Globals as any).isPointerDown?.() ?? 'true') === 'true'; } catch {}
      const rect = canvasRect();
      const rx = editorPointerRefX(), ry = editorPointerRefY();
      const px = Math.max(0, Math.min(96, ((rx - rect.left) / rect.width) * 100));
      const py = Math.max(0, Math.min(96, ((ry - rect.top) / rect.height) * 100));
      onChange(elementsRef.current.map(e => e.id === movingId ? { ...e, x: px, y: py } : e));
      if (!down) { clearInterval(t); setMovingId(null); }
    }, 33);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movingId]);

  const rect = canvasRect();
  const sorted = [...elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  const selected = elements.find(e => e.id === selectedId) ?? null;
  const kinds: IfaceElementKind[] = ['button', 'text', 'image', 'panel'];

  return (
    <>
      {/* Palette — press and hold, drag onto the canvas, release to drop */}
      <view style={{
        position: 'absolute', top: safeAreaTop() + IFACE_HEADER_H + IFACE_TABBAR_H, left: 0, right: 0, height: IFACE_PALETTE_H,
        flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: IFACE_PAD, paddingRight: IFACE_PAD,
        borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
      }}>
        {kinds.map(kind => (
          <GlassButton key={kind}
            onPointerDown={() => setPlacingKind(kind)}
            style={{
              flex: 1, flexDirection: 'column', alignItems: 'center', gap: 3,
              paddingTop: 8, paddingBottom: 8, borderRadius: 10,
              backgroundColor: placingKind === kind ? 'rgba(30,140,255,0.22)' : 'rgba(255,255,255,0.06)',
              borderWidth: 1, borderColor: placingKind === kind ? C.blue : 'rgba(255,255,255,0.09)',
            }}
          >
            <icon set="material-rounded" style={{ fontSize: 18, lineHeight: 18, color: placingKind === kind ? C.blue : C.text }}>{IFACE_KIND_META[kind].icon}</icon>
            <text style={{ fontSize: 10, color: placingKind === kind ? C.blue : C.text, fontWeight: 'bold' }}>{IFACE_KIND_META[kind].label}</text>
          </GlassButton>
        ))}
      </view>

      {/* Canvas */}
      <view style={{
        position: 'absolute', top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 22, borderWidth: 2, borderColor: 'rgba(255,255,255,0.10)',
        overflow: 'hidden',
      }}>
        {elements.length === 0 && !placingKind ? (
          <view style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ fontSize: 12, color: C.secondary, textAlign: 'center' as any, paddingLeft: 30, paddingRight: 30 }}>
              Empty screen — press and drag a Button, Text, Image or Panel from above to get started
            </text>
          </view>
        ) : null}
        {sorted.map(el => (
          <GlassButton key={el.id}
            onClick={() => onSelect(el.id)}
            onPointerDown={() => { if (selectedId === el.id) setMovingId(el.id); }}
            style={{
              position: 'absolute',
              left: `${el.x}%`, top: `${el.y}%`,
              width: el.w != null ? `${el.w}%` : undefined,
              height: el.h != null ? `${el.h}%` : undefined,
              borderWidth: selectedId === el.id ? 2 : 0, borderColor: C.blue,
              borderRadius: (el.cornerRadius ?? (el.kind === 'panel' ? 14 : 10)) + (selectedId === el.id ? 2 : 0),
              opacity: el.visible ? 1 : 0.4,
            }}
          >
            {renderIfaceElementContent(el)}
          </GlassButton>
        ))}
        {placingKind && ghost && ghost.inBounds ? (
          <view style={{ position: 'absolute', left: `${ghost.x}%`, top: `${ghost.y}%`, opacity: 0.55 }}>
            {renderIfaceElementContent(defaultIfaceElement(placingKind, 0, 0))}
          </view>
        ) : null}
      </view>

      {/* Inspector — bottom overlay; fixed height keeps canvasRect() stable */}
      {selected ? (
        <view style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: IFACE_INSPECTOR_H,
          ...glass({ fill: 'rgba(14,14,18,0.98)' }), borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
        }}>
          <ElementInspector
            el={selected}
            onChange={(patch) => onChange(elements.map(e => e.id === selected.id ? { ...e, ...patch } : e))}
            onDelete={() => { onChange(elements.filter(e => e.id !== selected.id)); onSelect(null); }}
            onOpenLogic={onOpenLogicForSelected}
            hasWorkflow={workflows.some(w => w.elementId === selected.id && w.steps.length > 0)}
          />
        </view>
      ) : null}
    </>
  );
}

function renderIfaceStepParams(step: IfaceStep, panels: IfaceElement[], onParam: (key: string, value: any) => void) {
  const fieldStyle = { fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', paddingLeft: 9, paddingRight: 9, paddingTop: 5, paddingBottom: 5 } as any;
  switch (step.type) {
    case 'openPanel':
    case 'closePanel':
    case 'togglePanel':
      return panels.length === 0 ? (
        <text style={{ fontSize: 11, color: C.secondary }}>Add a Panel on the Design tab first.</text>
      ) : (
        <view style={{ flexDirection: 'row', flexWrap: 'wrap' as any, gap: 4 }}>
          {panels.map(p => (
            <GlassButton key={p.id} onClick={() => onParam('targetId', p.id)} style={{
              paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, borderRadius: 7, borderWidth: 1,
              backgroundColor: step.params.targetId === p.id ? 'rgba(30,140,255,0.22)' : 'rgba(255,255,255,0.06)',
              borderColor: step.params.targetId === p.id ? C.blue : 'rgba(255,255,255,0.09)',
            }}>
              <text style={{ fontSize: 11, color: step.params.targetId === p.id ? C.blue : C.text, fontWeight: 'bold' }}>{p.label || 'Panel'}</text>
            </GlassButton>
          ))}
        </view>
      );
    case 'showToast':
      return (
        <input value={step.params.text ?? ''} onChange={(e: any) => onParam('text', e?.target?.value ?? e)} placeholder="Message text…" maxLength={120} style={fieldStyle} />
      );
    case 'fireCustomEvent':
      return (
        <view style={{ flexDirection: 'column', gap: 3 }}>
          <text style={{ fontSize: 10, color: C.secondary }}>Lua: Interface.OnButton("name", fn)</text>
          <input value={step.params.eventName ?? ''} onChange={(e: any) => onParam('eventName', String(e?.target?.value ?? e).replace(/\s/g, ''))} placeholder="e.g. openShop" maxLength={40} style={fieldStyle} />
        </view>
      );
    case 'playSound':
      return (
        <input value={step.params.soundName ?? ''} onChange={(e: any) => onParam('soundName', e?.target?.value ?? e)} placeholder="Sound name…" maxLength={40} style={fieldStyle} />
      );
    case 'wait':
      return (
        <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input
            value={String(step.params.ms ?? 500)}
            onChange={(e: any) => { const n = Number(e?.target?.value ?? e); onParam('ms', isFinite(n) ? Math.max(0, n) : 0); }}
            placeholder="500"
            style={{ ...fieldStyle, width: 70 }}
          />
          <text style={{ fontSize: 11, color: C.secondary }}>milliseconds</text>
        </view>
      );
    default:
      return null;
  }
}

// Logic tab — one flat ordered step list per interactive (button/image)
// element, "On Tap" only. Deliberately smaller than Custom Logic's full
// event/guard vocabulary — this is the "make it really easy" surface.
function InterfaceLogicPanel({ elements, workflows, selectedElementId, onSelectElement, onChangeWorkflows }: {
  elements: IfaceElement[];
  workflows: IfaceWorkflow[];
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
  onChangeWorkflows: (next: IfaceWorkflow[]) => void;
}) {
  const interactive = elements.filter(e => e.kind === 'button' || e.kind === 'image');
  const panels = elements.filter(e => e.kind === 'panel');
  const activeId = selectedElementId && interactive.some(e => e.id === selectedElementId) ? selectedElementId : (interactive[0]?.id ?? null);
  const workflow = activeId ? workflows.find(w => w.elementId === activeId) : undefined;
  const steps = workflow?.steps ?? [];
  const [addingAt, setAddingAt] = useState<number | null>(null);

  function commitSteps(next: IfaceStep[]) {
    if (!activeId) return;
    const existing = workflows.find(w => w.elementId === activeId);
    if (existing) onChangeWorkflows(workflows.map(w => w.id === existing.id ? { ...w, steps: next } : w));
    else onChangeWorkflows([...workflows, { id: ifaceUid('wf'), elementId: activeId, enabled: true, steps: next }]);
  }
  function addStep(type: IfaceActionType, at: number) {
    const next = [...steps];
    next.splice(at, 0, blankIfaceStep(type));
    commitSteps(next);
    setAddingAt(null);
  }
  function updateStep(id: string, patch: Partial<IfaceStep>) {
    commitSteps(steps.map(s => s.id === id ? { ...s, ...patch } : s));
  }
  function updateStepParam(id: string, key: string, value: any) {
    commitSteps(steps.map(s => s.id === id ? { ...s, params: { ...s.params, [key]: value } } : s));
  }
  function moveStep(id: string, dir: -1 | 1) {
    const i = steps.findIndex(s => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    commitSteps(next);
  }
  function deleteStep(id: string) {
    commitSteps(steps.filter(s => s.id !== id));
  }

  return (
    <scroll style={{ flex: 1, height: 1 }}>
      <view style={{ padding: 14, flexDirection: 'column', gap: 14 }}>
        {interactive.length === 0 ? (
          <view style={{ alignItems: 'center', gap: 8, paddingTop: 30 }}>
            <icon set="material-rounded" style={{ fontSize: 32, color: C.secondary, lineHeight: 32 }}>bolt</icon>
            <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', textAlign: 'center' as any }}>No tappable elements yet</text>
            <text style={{ fontSize: 12, color: C.secondary, textAlign: 'center' as any }}>Add a Button or Image on the Design tab, then wire up what happens when it's tapped.</text>
          </view>
        ) : (
          <>
            <view style={{ flexDirection: 'column', gap: 6 }}>
              <text style={{ fontSize: 11, color: C.secondary, fontWeight: 'bold' }}>ON TAP —</text>
              <view style={{ flexDirection: 'row', flexWrap: 'wrap' as any, gap: 6 }}>
                {interactive.map(el => {
                  const wf = workflows.find(w => w.elementId === el.id);
                  const active = el.id === activeId;
                  return (
                    <GlassButton key={el.id} onClick={() => onSelectElement(el.id)} style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingLeft: 10, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
                      borderRadius: 9, borderWidth: 1,
                      backgroundColor: active ? 'rgba(30,140,255,0.20)' : 'rgba(255,255,255,0.06)',
                      borderColor: active ? C.blue : 'rgba(255,255,255,0.09)',
                    }}>
                      {el.icon ? (isMaterialIconName(el.icon) ? (
                        <icon set="material-rounded" style={{ fontSize: 14, lineHeight: 14, color: active ? C.blue : C.text }}>{el.icon}</icon>
                      ) : (
                        <text style={{ fontSize: 14, lineHeight: 14 }}>{el.icon}</text>
                      )) : null}
                      <text style={{ fontSize: 12, color: active ? C.blue : C.text, fontWeight: 'bold' }}>{el.label || el.kind}</text>
                      {wf && wf.steps.length > 0 ? (
                        <view style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' }}>
                          <text style={{ fontSize: 9, color: C.text, fontWeight: 'bold' }}>{wf.steps.length}</text>
                        </view>
                      ) : null}
                    </GlassButton>
                  );
                })}
              </view>
            </view>

            <view style={{ flexDirection: 'column', gap: 8 }}>
              {steps.length === 0 ? (
                <text style={{ fontSize: 12, color: C.secondary }}>No steps yet — add one below.</text>
              ) : steps.map((step) => (
                <view key={step.id} style={{
                  backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
                  padding: 10, flexDirection: 'column', gap: 8, opacity: step.enabled ? 1 : 0.45,
                }}>
                  <view style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <icon set="material-rounded" style={{ fontSize: 16, color: C.blue, lineHeight: 16 }}>{IFACE_ACTION_META[step.type].icon}</icon>
                    <text style={{ flex: 1, fontSize: 13, color: '#fff', fontWeight: 'bold' }}>{IFACE_ACTION_META[step.type].label}</text>
                    <GlassButton onClick={() => moveStep(step.id, -1)} style={{ width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 13, color: C.text, lineHeight: 13 }}>arrow_upward</icon>
                    </GlassButton>
                    <GlassButton onClick={() => moveStep(step.id, 1)} style={{ width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 13, color: C.text, lineHeight: 13 }}>arrow_downward</icon>
                    </GlassButton>
                    <GlassButton onClick={() => updateStep(step.id, { enabled: !step.enabled })} style={{ width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 13, color: C.text, lineHeight: 13 }}>{step.enabled ? 'visibility' : 'visibility_off'}</icon>
                    </GlassButton>
                    <GlassButton onClick={() => deleteStep(step.id)} style={{ width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,69,58,0.14)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 13, color: '#ff453a', lineHeight: 13 }}>delete</icon>
                    </GlassButton>
                  </view>
                  {renderIfaceStepParams(step, panels, (k, v) => updateStepParam(step.id, k, v))}
                </view>
              ))}
              {addingAt !== null ? (
                <view style={{ flexDirection: 'column', gap: 4, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: 8 }}>
                  {IFACE_ACTION_ORDER.map(t => (
                    <GlassButton key={t} onClick={() => addStep(t, addingAt)} style={{
                      flexDirection: 'row', alignItems: 'center', gap: 8,
                      paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, borderRadius: 8, borderWidth: 0,
                      backgroundColor: 'rgba(255,255,255,0.04)',
                    }}>
                      <icon set="material-rounded" style={{ fontSize: 15, color: C.blue, lineHeight: 15 }}>{IFACE_ACTION_META[t].icon}</icon>
                      <view style={{ flex: 1, flexDirection: 'column' }}>
                        <text style={{ fontSize: 12, color: '#fff', fontWeight: 'bold' }}>{IFACE_ACTION_META[t].label}</text>
                        <text style={{ fontSize: 10, color: C.secondary }}>{IFACE_ACTION_META[t].help}</text>
                      </view>
                    </GlassButton>
                  ))}
                  <GlassButton onClick={() => setAddingAt(null)} style={{ alignItems: 'center', paddingTop: 6, borderWidth: 0, backgroundColor: 'rgba(0,0,0,0)' }}>
                    <text style={{ fontSize: 11, color: C.secondary }}>Cancel</text>
                  </GlassButton>
                </view>
              ) : (
                <GlassButton onClick={() => setAddingAt(steps.length)} style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                  paddingTop: 9, paddingBottom: 9, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                }}>
                  <icon set="material-rounded" style={{ fontSize: 15, color: C.text, lineHeight: 15 }}>add</icon>
                  <text style={{ fontSize: 12, color: C.text, fontWeight: 'bold' }}>Add Step</text>
                </GlassButton>
              )}
            </view>
          </>
        )}
      </view>
    </scroll>
  );
}

// ── Panel shell ─────────────────────────────────────────────────────────────

function CustomLogicPanel({ graph, size, onChange, onClose, onToggleSize, onPointerDown, onPointerUp, onPickInViewport }: {
  graph: LogicGraph;
  size: 'default' | 'full';
  onChange: (next: LogicGraph) => void;
  onClose: () => void;
  onToggleSize: () => void;
  onPointerDown: () => void;
  onPointerUp: () => void;
  // Asset/Element Assign — owned by EditorScreen, which is the only level
  // that can clear the whole screen down to the bare 3D viewport and listen
  // for the next object tap.
  onPickInViewport: (varId: string) => void;
}) {
  // Tolerant read — a graph authored before the workflow editor arrives as the
  // old Execute → conditions → actions chain and is folded into one workflow.
  const normalized = React.useMemo(() => normalizeLogicGraph(graph), [graph]);
  const workflows  = normalized.workflows;
  const variables  = normalized.variables;

  const [selectedId, setSelectedId] = useState('');
  const [selection,  setSelection]  = useState<LogicSelection>({ kind: 'none' });
  // Narrow layout only: which region is on screen. The list rail is a wide-layout
  // affordance now — opening the panel drops you straight on the canvas.
  const [pane, setPane] = useState<'list' | 'canvas'>('canvas');
  const [addingEvent, setAddingEvent] = useState(false);
  // Variables takes over the whole body when open — it is about the object as a
  // whole, not about whichever workflow happens to be selected.
  const [showVars, setShowVars] = useState(false);
  // Interface picking docks to the right of the screen — owned here, not by
  // VariablesPane, since only this level's absolute positioning is relative
  // to the screen rather than to the (left-docked) Workflow panel's own box.
  const [ifacePicker, setIfacePicker] = useState(false);
  // Which variable an in-flight Interface pick will assign into — set when
  // Assign is pressed on an existing (possibly still-unassigned) interface
  // variable, so IfacePickerPanel's onPick updates that row instead of
  // appending a new one.
  const [ifaceAssignId, setIfaceAssignId] = useState<string | null>(null);
  // An object with no workflows yet still gets a canvas: the trigger row and the
  // Execute root are on screen from the first frame, so "add a node" reads as
  // continuing a chain rather than conjuring one. It is a real workflow object,
  // just not in the graph yet — the first edit or selection commits it, which
  // keeps merely opening the panel from writing logic onto every object.
  const [draft, setDraft] = useState<LogicWorkflow>(() => newWorkflow('gameStart'));

  // Full-screen and three-column are two different things. `full` is purely how
  // much of the screen the panel covers (the header's expand button / the swipe
  // gestures own it). `wide` is whether the covered area is roomy enough for the
  // rail + canvas side by side — rail and inspector are fixed-width, so the
  // canvas needs whatever is left to still be usable. On a narrow screen going
  // full-screen still gets the user the extra room; it just keeps the stacked
  // list → canvas → properties navigation inside it.
  const railW    = EDITOR_TABLET ? 240 : 210;
  const full     = size === 'full';
  const wide     = full && editorUiWidth() >= railW + 260;
  const current  = workflows.find(w => w.id === selectedId);

  // Collapsing from the three-column layout back to the narrow stack: land on
  // the canvas of whatever was open rather than bouncing the user to the list.
  useEffect(() => {
    if (!wide && pane === 'list') setPane('canvas');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide]);

  // Opening the panel on an object that already has workflows lands on the
  // first one, so the canvas is never an empty "pick something" screen.
  useEffect(() => {
    if (!selectedId && workflows.length) setSelectedId(workflows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, selectedId]);

  // Single write path — every mutation ships the whole graph, so the half not
  // being edited (workflows vs variables) has to travel with it.
  function writeGraph(next: LogicGraph) {
    onChange(next);
  }
  function commit(next: LogicWorkflow) {
    writeGraph({ workflows: workflows.map(w => (w.id === next.id ? next : w)), variables });
  }
  function openWorkflow(id: string) {
    setSelectedId(id);
    setSelection({ kind: 'none' });
    if (!wide) setPane('canvas');
  }
  function createWorkflow(type: ConditionType) {
    const wf = newWorkflow(type);
    wf.color = WORKFLOW_COLORS[workflows.length % WORKFLOW_COLORS.length];
    writeGraph({ workflows: [...workflows, wf], variables });
    setAddingEvent(false);
    openWorkflow(wf.id);
  }
  // Commits the on-screen draft into the graph, keeping every id it already
  // showed (so a selection made in the same gesture still resolves) and giving
  // it the next workflow color. "Game starts" is the draft's default trigger;
  // the trigger row at the top of the canvas changes it.
  //
  // Adding a node fires onChange and then onSelect within one gesture, and both
  // route here off the same render's closure — so the id of whatever has already
  // been written is remembered, and the follow-up (which carries the pre-edit
  // draft) is dropped instead of appending a second, stepless workflow.
  const committedDraftId = useRef('');
  function materializeDraft(next: LogicWorkflow) {
    if (committedDraftId.current === next.id) return;
    committedDraftId.current = next.id;
    const wf: LogicWorkflow = {
      ...next,
      color: WORKFLOW_COLORS[workflows.length % WORKFLOW_COLORS.length],
    };
    writeGraph({ workflows: [...workflows, wf], variables });
    setDraft(newWorkflow('gameStart'));
    setSelectedId(wf.id);
  }
  function duplicateWorkflow(id: string) {
    const src = workflows.find(w => w.id === id);
    if (!src) return;
    const copy: LogicWorkflow = {
      ...src,
      id: logicId('wf'),
      name: `${workflowTitle(src)} copy`,
      event: { ...src.event, params: { ...src.event.params } },
      guards: src.guards.map(g => ({ ...g, id: logicId('guard'), params: { ...g.params } })),
      steps: src.steps.map(s => ({
        ...s,
        id: logicId('step'),
        params: { ...s.params },
        guards: s.guards.map(g => ({ ...g, id: logicId('guard'), params: { ...g.params } })),
      })),
    };
    writeGraph({ workflows: [...workflows, copy], variables });
    openWorkflow(copy.id);
  }
  function deleteWorkflow(id: string) {
    writeGraph({ workflows: workflows.filter(w => w.id !== id), variables });
    if (selectedId === id) {
      setSelectedId('');
      if (!wide) setPane('canvas');
    }
  }
  function selectNode(sel: LogicSelection) {
    setSelection(sel);
  }

  return (
    <LogicVarsContext.Provider value={[SELF_VARIABLE, ...variables]}>
    <view
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        left: safeAreaLeft(),
        top: safeAreaTop(),
        bottom: safeAreaBottom(),
        ...(full ? { right: safeAreaRight() + 6 } : { width: EDITOR_LOGIC_PANEL_WIDTH }),
        ...glass({ fill: 'rgba(20,20,22,0.94)' }),
        // Flush against the top/left/bottom safe-area edges — only the free
        // (right) corners stay rounded.
        borderTopRightRadius: 14, borderBottomRightRadius: 14,
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
          <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold' }}>Workflow</text>
        </view>
        {/* Variables — names for the assets, connected elements and Interface
            buttons this object's workflows refer to. Takes the slot the trigger
            shortcut used to hold; the trigger now has its own card at the top
            of the canvas, which is a better home for it anyway. */}
        <Pressable
          onClick={() => setShowVars(v => !v)}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 5,
            height: 28, borderRadius: 8,
            backgroundColor: showVars ? 'rgba(91,156,255,0.20)' : 'rgba(255,255,255,0.06)',
            paddingLeft: 8, paddingRight: 9,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 15, color: showVars ? C.primary : C.text, lineHeight: 15 }}>data_object</icon>
          <text style={{ fontSize: 11, color: showVars ? C.primary : C.text, fontWeight: 'bold' }}>Variables</text>
          {variables.length ? (
            <view style={{
              backgroundColor: showVars ? 'rgba(91,156,255,0.30)' : 'rgba(255,255,255,0.10)',
              borderRadius: 4, paddingLeft: 4, paddingRight: 4, paddingTop: 1, paddingBottom: 1,
            }}>
              <text style={{ fontSize: 9, color: showVars ? C.primary : C.textMuted, fontWeight: 'bold' }}>
                {String(variables.length)}
              </text>
            </view>
          ) : null}
        </Pressable>
        <view style={{ width: 4 }} />
        <PanelExpandButton size={size} onToggle={onToggleSize} />
        <Pressable
          onClick={onClose}
          style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
        >
          <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>close</icon>
        </Pressable>
      </view>

      {/* Body */}
      <view style={{ flex: 1, height: 1, flexDirection: wide ? 'row' : 'column' } as any}>
        {/* Variables replaces the three columns while it is open. */}
        {showVars ? (
          <view style={{ flex: 1, ...(wide ? { width: 1 } : { height: 1 }), flexDirection: 'column' } as any}>
            <VariablesPane
              variables={variables}
              onChange={next => writeGraph({ workflows, variables: next })}
              onPickInterface={varId => { setIfaceAssignId(varId); setIfacePicker(true); }}
              onPickInViewport={onPickInViewport}
            />
          </view>
        ) : null}

        {/* Workflow list rail — wide layout only */}
        {!showVars && wide ? (
          <view style={{
            width: railW, borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.08)',
            flexDirection: 'column',
          } as any}>
            <WorkflowListRail
              workflows={workflows}
              selectedId={selectedId}
              onSelect={openWorkflow}
              onNew={() => setAddingEvent(true)}
              onDuplicate={duplicateWorkflow}
              onDelete={deleteWorkflow}
            />
          </view>
        ) : null}

        {/* Canvas. The `flex: 1` + 1px seed idiom only applies on the MAIN axis:
            in the wide row layout the seed goes on width (height stretches),
            in the narrow column layout it goes on height. Seeding both pins the
            cross axis to 1px and collapses the scroll viewport. */}
        {!showVars ? (
          <view style={{
            flex: 1,
            ...(wide ? { width: 1 } : { height: 1 }),
            flexDirection: 'column',
          } as any}>
            {current ? (
              <WorkflowCanvas
                workflow={current}
                selection={selection}
                onSelect={selectNode}
                onChange={commit}
              />
            ) : (
              /* Nothing authored yet — same canvas, running on the draft. Any
                 edit (adding a node) or any selection (tapping Execute or the
                 trigger row) commits the draft to the graph first, so the
                 workflow exists by the time the inspector needs it. */
              <WorkflowCanvas
                workflow={draft}
                selection={selection}
                onSelect={sel => { materializeDraft(draft); selectNode(sel); }}
                onChange={materializeDraft}
              />
            )}
          </view>
        ) : null}

      </view>

      {/* New-workflow event picker — Bubble opens the event list before it will
          give you a canvas, so a workflow can never exist without a trigger. */}
      {addingEvent ? (
        <view style={{
          position: 'absolute',
          left: 10, right: 10, top: 56, bottom: 10,
          ...glass({ fill: 'rgba(10,10,12,0.96)' }),
          borderRadius: 12,
          zIndex: 60,
          flexDirection: 'column',
        } as any}>
          <scroll style={{ flex: 1, height: 1 } as any} className="pludo-scroll">
            <view style={{ padding: 8 }}>
              <EventPicker
                title="Click here to add an event"
                onPick={createWorkflow}
                onCancel={() => setAddingEvent(false)}
              />
            </view>
          </scroll>
        </view>
      ) : null}
    </view>

    {/* Sibling of the main panel, not nested inside it — its own screen-relative
        absolute context is what lets "right: safeAreaRight()" dock it to the
        true right edge of the screen instead of the left panel's own edge. */}
    {ifacePicker ? (
      <IfacePickerPanel
        onPick={target => {
          writeGraph({
            workflows,
            variables: ifaceAssignId
              ? variables.map(v => v.id === ifaceAssignId ? { ...v, target } : v)
              : [...variables, {
                  id: logicId('var'),
                  name: suggestVarName(target, variables.map(v => v.name)),
                  source: 'interface',
                  target,
                }],
          });
          setIfacePicker(false);
          setIfaceAssignId(null);
        }}
        onClose={() => { setIfacePicker(false); setIfaceAssignId(null); }}
      />
    ) : null}
    </LogicVarsContext.Provider>
  );
}

// ── AI Game Editor ─────────────────────────────────────────────────────────────

function EditorScreen({ game, onBack, onEditingChange, onOpenShop, onApplyAssets, editorAssets, buildJobId, onBuildComplete, initialPrompt }: {
  game: GameStub;
  onBack: () => void;
  onEditingChange?: (v: boolean) => void;
  onOpenShop?: () => void;
  // Native shell: the native asset library adds its picks through this.
  onApplyAssets?: (picked: AssetItem[]) => void;
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
  type ModalSize = 'default' | 'full';
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
  // Bumped once just after the rotation gate opens — forces a re-render so the
  // inline safeArea*() calls in JSX pick up landscape values even if
  // Screen.safeArea lands a frame behind the screen dimensions.
  const [, setSafeAreaVersion]            = useState(0);
  // Gates the whole editor chrome until the landscape rotation has physically
  // committed, then latches true for the rest of the session (a later portrait
  // blip must not blink the UI away). Seeded from the live signal so remounts
  // that are ALREADY landscape — returning from a play-test, say — paint their
  // chrome on the very first frame; entering from the portrait lobby seeds
  // false and waits. See the gating effect below.
  const [orientReady,   setOrientReady]   = useState(() => landscapeReady());

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

  // ── Variables → Assign: click an object in the 3D viewport ─────────────────
  // Custom Logic's Variables tab (Assign, on an asset/element row) drops down
  // to the bare game preview so the user can tap the object directly instead
  // of hunting it in a text list — id of the variable being assigned, or null
  // when not picking. Owned here (not by CustomLogicPanel) because clearing
  // the rest of the editor chrome (top bar, asset strip, the panel itself)
  // needs this component's own render tree.
  const [pickingVar, setPickingVar] = useState<string | null>(null);
  function beginPickObject(varId: string) {
    setPickingVar(varId);
    try { (Globals as any).editorBeginPickObject?.(); } catch {}
  }
  function cancelPickObject() {
    setPickingVar(null);
    try { (Globals as any).editorCancelPickObject?.(); } catch {}
  }
  // Poll for EditorCameraController.ProcessPickTap's result. Unity clears
  // _editorPickResult at the start of every pick session (BeginPickObject),
  // so the first non-empty read here is always fresh — no ack round-trip
  // needed. A hit also restores the previously-selected object's highlight
  // on the Unity side, so by the time this fires the screen is already back
  // to how it looked before Assign was pressed; we just need to write the
  // pick into the variable and stop polling.
  useEffect(() => {
    if (!pickingVar) return;
    const varId = pickingVar;
    const t = setInterval(() => {
      try {
        const val = String((Globals as any)._editorPickResult ?? '');
        if (!val) return;
        setPickingVar(null);
        setObjectGraphs(prev => {
          const g = prev[currentObjectId] ?? DEFAULT_LOGIC_GRAPH;
          const next = { ...g, variables: g.variables.map(v => v.id === varId ? { ...v, target: val } : v) };
          pushObjectLogic(currentObjectId, next);
          return { ...prev, [currentObjectId]: next };
        });
      } catch {}
    }, 100);
    return () => clearInterval(t);
  }, [pickingVar, currentObjectId]);

  // ── Derived modal flags (compat with existing JSX checks). These read
  // TRUE only when the modal is "expanded" (default or full), not when it
  const chatOpen        = activeModal === 'chat';
  const showSettings    = activeModal === 'settings';
  const showCustomLogic = activeModal === 'logic';

  // Tapping a top-bar button: switch to a different modal at default size, or
  // close the current one if it was already the active modal.
  function openModal(kind: ModalKind) {
    if (activeModal !== kind) { setActiveModal(kind); setModalSize('default'); return; }
    closeModal();
  }
  function openChat()        { openModal('chat'); }
  function openSettings()    { openModal('settings'); }
  function openCustomLogic() { openModal('logic'); }
  function closeModal()      { setActiveModal(null); setModalSize('default'); }
  // Swipe gestures inside the modal step the size up/down. Left from default
  // dismisses the modal entirely; right from full is a no-op (already max).
  function modalSwipeLeft() {
    if (!activeModal) return;
    if (modalSize === 'full') setModalSize('default');
    else                      closeModal();
  }
  function modalSwipeRight() {
    if (!activeModal) return;
    if (modalSize === 'default') setModalSize('full');
  }
  // Header expand button on every docked panel — the tappable equivalent of the
  // swipe gestures, so full-screen isn't a hidden feature.
  function toggleModalSize() {
    setModalSize(s => (s === 'full' ? 'default' : 'full'));
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
  // Excludes pickingVar: Assign hides the panel (and every other camera-lock
  // reason) so the user can pan/tap the bare viewport, even though the
  // underlying activeModal is still 'logic' underneath it.
  const anyLeftPanelOpen = !pickingVar && (chatOpen || showSettings || showCustomLogic);
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
  // Widths match the panels' own EDITOR_SIDE_PANEL_WIDTH / EDITOR_LOGIC_PANEL_WIDTH
  // (device-aware — wider on tablet) and the flush-left edge they now dock to,
  // so the shift always clears the panel's actual right edge on any device.
  // A full-screen panel covers the viewport outright, so there is no
  // right-of-panel area left to frame the selection in and no exposed left-edge
  // chrome to slide out of the way — the shift/framing pair only applies to the
  // docked size.
  const PANEL_GAP            = 12;
  const leftPanelOpen        = (selectMode && !!selectedObj && (showSettings || showCustomLogic) && modalSize !== 'full');
  const leftPanelRightEdge   = showCustomLogic
    ? safeAreaLeft() + EDITOR_LOGIC_PANEL_WIDTH
    : safeAreaLeft() + EDITOR_SIDE_PANEL_WIDTH;
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

  // ── Interface Builder (Design canvas + Logic workflow tab) ─────────────────
  // Replaces the old flat HUD-button list/form editor. Old saves only carried
  // HudButton[] (anchor + one canned action, read via editorGetSceneSettings's
  // s.hudButtons) — migrateHudButtonsToInterface (module scope, near the type
  // definitions) converts that once into the richer shape below; the builder
  // always writes IfaceElement/IfaceWorkflow from here on.
  const [interfaceElements,  setInterfaceElementsState]  = useState<IfaceElement[]>([]);
  const [interfaceWorkflows, setInterfaceWorkflowsState] = useState<IfaceWorkflow[]>([]);
  const [ifaceTab,      setIfaceTab]      = useState<'design' | 'logic'>('design');
  const [ifaceSelected, setIfaceSelected] = useState<string | null>(null);
  const ifaceMigratedRef = useRef(false);

  function pushInterfaceElements(next: IfaceElement[]) {
    setInterfaceElementsState(next);
    try { (Globals as any).editorSetInterfaceElements?.(JSON.stringify(next)); } catch {}
  }
  function pushInterfaceWorkflows(next: IfaceWorkflow[]) {
    setInterfaceWorkflowsState(next);
    try { (Globals as any).editorSetInterfaceWorkflows?.(JSON.stringify(next)); } catch {}
  }
  function workflowForElement(elementId: string): IfaceWorkflow | undefined {
    return interfaceWorkflows.find(w => w.elementId === elementId);
  }
  function ensureWorkflowForElement(elementId: string): IfaceWorkflow {
    const existing = workflowForElement(elementId);
    if (existing) return existing;
    const created: IfaceWorkflow = { id: `wf_${elementId}`, elementId, enabled: true, steps: [] };
    pushInterfaceWorkflows([...interfaceWorkflows, created]);
    return created;
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
      if (Array.isArray(s.interfaceElements) && s.interfaceElements.length > 0) {
        setInterfaceElementsState(s.interfaceElements);
      } else if (Array.isArray(s.hudButtons) && s.hudButtons.length > 0 && !ifaceMigratedRef.current) {
        // Old save with only legacy HUD buttons — migrate once into the new
        // Interface Builder shape so it opens pre-populated instead of blank.
        ifaceMigratedRef.current = true;
        const { elements, workflows } = migrateHudButtonsToInterface(s.hudButtons);
        pushInterfaceElements(elements);
        pushInterfaceWorkflows(workflows);
      }
      if (Array.isArray(s.interfaceWorkflows) && s.interfaceWorkflows.length > 0) {
        setInterfaceWorkflowsState(s.interfaceWorkflows);
      }
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

  // ── Hold the chrome back until the landscape rotation commits ────────────
  // The editor mounts BEFORE the rotation visually commits. During that window
  // the React canvas is still portrait-shaped (390 reference units wide) while
  // MobileOrientationManager has already switched the layout to landscape
  // units (844 wide), and GameLauncher's safe-area getters still read portrait
  // insets (side insets 0). A landscape layout drawn into that canvas bunches
  // every panel into the top-left corner, then snaps outward the frame the
  // rotation lands — the "UI glitches to the corner while the editor loads"
  // bug. It was especially visible while models stream in, because a frame
  // that would normally last 16 ms can stall for hundreds.
  //
  // This used to be a blind 900 ms timer that bumped a re-render — which left
  // the mislaid layout on screen (and interactive) for the whole window. Now
  // we wait on Unity's real signal and render nothing but the transparent
  // passthrough root until it's true; Unity's own loading overlay covers the
  // screen in the meantime, so nothing is lost.
  //
  // The poll is deliberately SHORT-LIVED — it stops the moment the gate opens
  // (worst case, at the fallback below). A previous attempt at this left a
  // permanent 10 Hz inset poll running and the editor started black-screening;
  // the 10 Hz re-render cadence and ReactUnity's canvas rebuilds don't mix.
  // Once landscape has committed the insets are static, so there is nothing
  // left to watch.
  useEffect(() => {
    let poll = 0 as any;
    let settle = 0 as any;
    const open = () => {
      // Idempotent — the poll and the fallback can both reach here.
      clearInterval(poll);
      clearTimeout(settle);
      setOrientReady(true);
      // Screen.safeArea can land a frame or two after the dimensions flip, so
      // take one more inset reading shortly after opening the gate.
      settle = setTimeout(() => setSafeAreaVersion(v => v + 1), 250);
    };
    if (landscapeReady()) open();
    else {
      poll = setInterval(() => { if (landscapeReady()) open(); }, 60);
    }
    // Safety net: never leave the editor with no UI at all. If the bridge is
    // missing (older Unity build) or the screen never reports landscape (Device
    // Simulator wedged in portrait, desktop player), show the chrome anyway —
    // which is exactly the pre-fix behaviour, one glitchy relayout and all.
    const fallback = setTimeout(open, 2000);
    return () => { clearInterval(poll); clearTimeout(settle); clearTimeout(fallback); };
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
      const pubRes = await fetch(`${baseUrl()}/api/game/${gameData.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAccessToken: getGlobal('getAccessToken') }),
      });
      if (!pubRes.ok) {
        const body = await pubRes.json().catch(() => ({})) as { error?: string; moderation?: boolean };
        if (body.moderation) {
          setShowPublish(false);
          setHistory(prev => [...prev, { role: 'assistant', content: `🚫 Can't publish yet: ${body.error ?? 'this game doesn’t meet our community guidelines.'} Rename the game or edit its description, then try again.` }]);
          return;
        }
        throw new Error(String(pubRes.status));
      }
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

  // ── Native shell: native editor chrome ─────────────────────────────────────
  // Inside the React Native app, the editor's RESTING chrome — the ☰ menu
  // (Play / Tools / Publish / Leave) and undo/redo — is drawn natively (Liquid
  // Glass) over Unity's view. This screen reports the state that chrome needs
  // and runs the commands it sends back. Contextual bars (object selected,
  // terrain tools, Tools drill-downs) stay here for now: when one is open the
  // editor isn't "at rest" and the native menu steps aside.
  const hostedByNative = isHostedByNative();
  // Unity's default Play/Tools/Publish/Leave bar is never shown in the native
  // shell (the native ☰ menu is): whichever path lands on it — stepping out of
  // Tools, exiting terrain mode — closes it so the native menu takes over.
  useEffect(() => {
    if (hostedByNative && menuOpen && !terrainMode && toolsMenu === 'none') setMenuOpen(false);
  }, [hostedByNative, menuOpen, terrainMode, toolsMenu]);
  const chromeAtRest   = !(selectMode && selectedObj) && !terrainMode && toolsMenu === 'none' && !menuOpen && !pickingVar;
  // Phase 2: an object selection (Edit / Workflow bar + the Edit side panel) is
  // native too. Custom Logic, terrain and the Interface Builder stay here.
  // Phase 4: Custom Logic and the terrain toolbar are native as well.
  const nativeSelection = hostedByNative && selectMode && !!selectedObj && !pickingVar
                          && !terrainMode && toolsMenu === 'none';
  const nativeTerrain   = hostedByNative && terrainMode && !pickingVar;
  // Phase 5: the Interface Builder is native too.
  const nativeInterface = hostedByNative && toolsMenu === 'interface' && !pickingVar;
  const hostChromeMode  = chromeAtRest ? 'rest' : nativeSelection ? 'selected' : nativeTerrain ? 'terrain'
                        : nativeInterface ? 'interface' : 'other';
  const hostIfaceJson   = nativeInterface ? JSON.stringify({ elements: interfaceElements, workflows: interfaceWorkflows }) : '';
  const playLabel      = isBuilding ? 'Building…' :
                         assetsReady ? 'Play' :
                         assetsProgress.total > 0 ? `Play (${assetsProgress.done}/${assetsProgress.total})` : 'Play';

  // The native Tools menu shows the active Sky / Lighting / Ground preset and
  // the Player panel shows live speed/jump, so re-read Unity's SceneSettings
  // whenever the editor comes back to rest (undo/redo can change them too).
  useEffect(() => {
    if (hostedByNative && chromeAtRest) seedSceneSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostedByNative, chromeAtRest, canUndo, canRedo]);

  // ReactUnity dialogs/sheets drawn over the editor (Publish, Play-loading,
  // AI chat): the native chrome steps aside while one is up.
  const hostOverlay = showPublish || showPlayModal || activeModal === 'chat';
  const hostSettingsJson = JSON.stringify(currentObjSetting);
  const hostLogicJson = JSON.stringify(currentObjGraph);
  // Phase 3: the asset strip is native — report this game's strip contents.
  const hostAssetsJson = JSON.stringify((editorAssets ?? []).map(a => ({
    cacheKey: a.cacheKey, prompt: a.prompt, title: a.title, thumbnailUrl: a.thumbnailUrl,
  })));
  useEffect(() => {
    if (!hostedByNative) return;
    try {
      (Globals as any).notifyHost?.(JSON.stringify({
        type: 'editorState', active: true, atRest: chromeAtRest, mode: hostChromeMode, overlay: hostOverlay,
        canUndo, canRedo, playLabel, playEnabled: !isBuilding, published, picking: !!pickingVar,
        objectId: nativeSelection ? currentObjectId : '',
        settingsOpen: nativeSelection && showSettings,
        logicOpen: nativeSelection && showCustomLogic,
        logic: nativeSelection && showCustomLogic ? JSON.parse(hostLogicJson) : null,
        terrainTool: terrainTool ?? '',
        iface: hostIfaceJson ? JSON.parse(hostIfaceJson) : null,
        settings: JSON.parse(hostSettingsJson),
        scene: { sky: skyPreset, lighting: lightingPreset, ground: groundPreset, speed: playerSpeed, jump: playerJump },
        assets: JSON.parse(hostAssetsJson),
        // The strip (and +) only belong on screen when no contextual Unity UI
        // (terrain tools, Custom Logic, Interface Builder) has taken over.
        stripVisible: !pickingVar && !terrainMode && toolsMenu !== 'interface',
      }));
    } catch { /* bridge not ready */ }
  }, [hostedByNative, chromeAtRest, hostChromeMode, hostOverlay, canUndo, canRedo, playLabel, isBuilding, published, pickingVar,
      nativeSelection, currentObjectId, showSettings, hostSettingsJson, showCustomLogic, hostLogicJson, terrainTool, hostIfaceJson,
      skyPreset, lightingPreset, groundPreset, playerSpeed, playerJump, hostAssetsJson, terrainMode, toolsMenu, showCustomLogic, modalSize]);

  useEffect(() => {
    if (!hostedByNative) return;
    return () => {
      try { (Globals as any).notifyHost?.(JSON.stringify({ type: 'editorState', active: false })); } catch {}
    };
  }, [hostedByNative]);

  // Latest handlers for host commands (a ref so the poll never sees stale state).
  const hostCommandRef = useRef<(cmd: string) => void>(() => {});
  hostCommandRef.current = (raw: string) => {
    // "name" or "name:arg" (arg may itself contain ':' — JSON for settings).
    const sep = raw.indexOf(':');
    const cmd = sep < 0 ? raw : raw.slice(0, sep);
    const arg = sep < 0 ? '' : raw.slice(sep + 1);
    const stepNum = (v: string, step: number, min: number, max: number) =>
      Math.max(min, Math.min(max, Math.round((parseFloat(v) || 0) / step) * step));
    switch (cmd) {
      // ── Object selection (phase 2) ──
      case 'deselect':   try { (Globals as any).editorClearSelection?.(); } catch {} return;
      case 'edit':       openSettings(); return;
      case 'workflow':   openCustomLogic(); return;
      case 'closePanel': closeModal(); return;
      // ── Custom Logic (phase 4) ──
      case 'logic': {
        try { updateObjGraph(normalizeLogicGraph(JSON.parse(arg))); } catch {}
        return;
      }
      case 'logicCatalog':
        try { (Globals as any).notifyHost?.(`{"type":"logicCatalog","catalog":${logicCatalogJson()}}`); } catch {}
        return;
      case 'pickVar': if (arg) beginPickObject(arg); return;
      // ── Terrain toolbar (phase 4) ──
      case 'terrainTool': {
        const t = (['raise', 'lower', 'flatten', 'smooth'] as const).find(x => x === arg) ?? null;
        setTerrainTool(t);
        try { (Globals as any).setTerrainTool?.(t ?? ''); } catch {}
        return;
      }
      case 'terrainExit': exitTerrainMode(); return;
      // ── Interface Builder (phase 5) ──
      case 'iface': {
        try {
          const { elements, workflows } = JSON.parse(arg);
          if (Array.isArray(elements)) pushInterfaceElements(elements);
          if (Array.isArray(workflows)) pushInterfaceWorkflows(workflows);
        } catch {}
        return;
      }
      case 'ifaceClose': setIfaceSelected(null); setToolsMenu('none'); return;
      case 'setting': {
        try {
          const { key, value } = JSON.parse(arg);
          if (key in DEFAULT_OBJECT_SETTINGS) updateObjSetting(key as keyof ObjectSettings, value);
        } catch {}
        return;
      }
      // ── Tools (phase 2): leaves that stay in ReactUnity ──
      case 'terrain':   setMenuOpen(true); enterTerrainMode(); return;
      case 'interface':
        seedSceneSettings(); setIfaceSelected(null); setIfaceTab('design');
        setMenuOpen(true); setToolsMenu('interface');
        return;
      // ── Tools (phase 2): style presets + player tuning set natively ──
      case 'sky':      setSkyPreset(arg);      styleBridge('editorSetSky', arg);      return;
      case 'lighting': setLightingPreset(arg); styleBridge('editorSetLighting', arg); return;
      case 'ground':   setGroundPreset(arg);   styleBridge('editorSetGround', arg);   return;
      // ── Asset strip (phase 3) ──
      case 'assetCenter': {
        const a = (editorAssets ?? []).find(x => x.cacheKey === arg);
        if (a) try { (Globals as any).editorAddAssetCenter?.(a.cacheKey, a.modelUrl, a.isHumanoid, a.sizeHint ?? 0); } catch {}
        return;
      }
      case 'assetPlace': {
        // {key, fx, fy}: release point as fractions of the screen, top-left
        // origin → Unity screen pixels, bottom-left origin.
        try {
          const { key, fx, fy } = JSON.parse(arg);
          const a = (editorAssets ?? []).find(x => x.cacheKey === key);
          const G = Globals as any;
          const H = Number(G.getScreenHeight?.() ?? 0);
          const W = H * Number(G.getRefScreenWidth?.() ?? 0) / Math.max(Number(G.getRefScreenHeight?.() ?? 1), 1);
          if (a && W > 0 && H > 0) {
            G.editorPlaceAsset?.(a.cacheKey, a.modelUrl, fx * W, (1 - fy) * H, a.isHumanoid, a.sizeHint ?? 0);
          }
        } catch {}
        return;
      }
      case 'addAssets': {
        try {
          const picked = JSON.parse(arg) as AssetItem[];
          if (Array.isArray(picked) && picked.length) onApplyAssets?.(picked);
        } catch {}
        return;
      }
      case 'speed': { const v = stepNum(arg, 1, 1, 20);    setPlayerSpeed(v); styleBridge('editorSetPlayerSpeed', v); return; }
      case 'jump':  { const v = stepNum(arg, 0.5, 0.5, 8); setPlayerJump(v);  styleBridge('editorSetPlayerJump', v);  return; }
      case 'play':
        if (isBuilding) return;
        if (assetsReady) launchPlay(); else setShowPlayModal(true);
        return;
      case 'tools':   seedSceneSettings(); setMenuOpen(true); setToolsMenu('tools'); return;
      case 'publish': setShowPublish(true); return;
      case 'leave':   onBack(); return;
      case 'undo':    undo(); return;
      case 'redo':    redo(); return;
    }
  };
  useEffect(() => {
    if (!hostedByNative) return;
    const t = setInterval(() => {
      try {
        const cmd = String((Globals as any).takeEditorCommand?.() ?? '');
        if (cmd) hostCommandRef.current(cmd);
      } catch { /* bridge not ready */ }
    }, 100);
    return () => clearInterval(t);
  }, [hostedByNative]);

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

  // ── Rotation gate ─────────────────────────────────────────────────────────
  // Every hook above has already run, so bailing out here is safe. Until the
  // screen is physically landscape the chrome would be laid out against a
  // portrait-shaped canvas and land in the top-left corner, so render only the
  // transparent passthrough root — the 3D viewport and Unity's loading overlay
  // stay visible, and there is no misplaced UI to see or tap. See the gating
  // effect for the full explanation.
  if (!orientReady) {
    return (
      <view
        className="editor-passthrough"
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0)', position: 'relative' }}
      />
    );
  }

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
      {!pickingVar && !(hostedByNative && (chromeAtRest || nativeSelection || nativeTerrain || nativeInterface)) ? (
      <view style={{
        position: 'absolute', top: safeAreaTop(), left: safeAreaLeft() + editorShift,
        zIndex: 10,
        flexDirection: 'row', alignItems: 'center', gap: 8,
      }}>
        <GlassButton
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
            if (toolsMenu === 'interface') { setIfaceSelected(null); setToolsMenu(hostedByNative ? 'none' : 'tools'); return; }
            // Native shell: the default Play/Tools/Publish/Leave bar is drawn
            // natively, so stepping out of Tools returns straight to it.
            if (toolsMenu === 'tools') { setToolsMenu('none'); if (hostedByNative) setMenuOpen(false); return; }
            setMenuOpen(o => !o);
          }}
          style={{
            width: 44, height: 44, borderRadius: 12,
            ...glass({ fill: 'rgba(20,20,22,0.78)' }),
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>
            {((selectMode && selectedObj) || menuOpen) ? 'close' : 'menu'}
          </icon>
        </GlassButton>

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
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
            <GlassButton
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
            </GlassButton>
            <GlassButton
              onClick={openCustomLogic}
              style={{
                height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: showCustomLogic ? 'rgba(30,140,255,0.22)' : 'rgba(0,0,0,0)',
                borderWidth: 0,
              }}
            >
              <icon set={showCustomLogic ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 18, color: showCustomLogic ? C.blue : C.text, lineHeight: 18 }}>code</icon>
              <text style={{ fontSize: 13, color: showCustomLogic ? C.blue : C.text, fontWeight: 'bold' }}>Workflow</text>
            </GlassButton>
          </view>
        ) : menuOpen ? (
          terrainMode ? (
            /* ── Terrain-builder top bar — Raise / Lower / Flatten / Smooth / Paint + Exit ── */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
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
                  <GlassButton
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
                  </GlassButton>
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
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              <GlassButton
                onClick={enterTerrainMode}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>landscape</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Terrain</text>
              </GlassButton>
              <GlassButton
                onClick={() => setToolsMenu('style')}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>palette</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Style</text>
              </GlassButton>
              <GlassButton
                onClick={() => { seedSceneSettings(); setIfaceSelected(null); setIfaceTab('design'); setToolsMenu('interface'); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>dashboard</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Interface</text>
              </GlassButton>
              <GlassButton
                onClick={() => setToolsMenu('player')}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>person</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Player</text>
              </GlassButton>
            </view>
          ) : toolsMenu === 'style' ? (
            /* ── Style submenu — Textures / Lighting / Sky / Sound. The hamburger
                X steps back to the Tools submenu. ── */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
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
                <GlassButton
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
                </GlassButton>
              ))}
            </view>
          ) : (toolsMenu === 'sky' || toolsMenu === 'lighting' || toolsMenu === 'textures') ? (
            /* ── Style leaf — preset row for Sky / Lighting / Textures. ── */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
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
                    <GlassButton
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
                    </GlassButton>
                  );
                });
              })()}
            </view>
          ) : toolsMenu === 'player' ? (
            /* ── Player leaf — walk speed + jump steppers. ── */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
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
                    <GlassButton onClick={() => apply(st.value - st.step)} style={{ width: 26, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>remove</icon>
                    </GlassButton>
                    <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', minWidth: 32, textAlign: 'center' } as any}>{st.value.toFixed(st.dp)}</text>
                    <GlassButton onClick={() => apply(st.value + st.step)} style={{ width: 26, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}>
                      <icon set="material-rounded" style={{ fontSize: 16, color: C.text, lineHeight: 16 }}>add</icon>
                    </GlassButton>
                  </view>
                );
              })}
            </view>
          ) : toolsMenu === 'interface' ? (
            /* ── Interface — this leaf bar sits behind the full-screen Interface
                Builder (rendered separately, further down) which fully covers
                it, so it's just a placeholder label for the sliver of frame
                (if any) around that overlay. */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 12, paddingRight: 12,
              flexDirection: 'row', alignItems: 'center', gap: 6,
              minWidth: 160,
            }}>
              <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>dashboard</icon>
              <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold', flex: 1 }}>Interface</text>
            </view>
          ) : (
            /* ── Default editor top bar — Play / Tools / Publish / Leave ── */
            <view style={{
              height: 44,
              ...glass({ fill: 'rgba(20,20,22,0.78)' }),
              borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
              paddingLeft: 6, paddingRight: 6,
              flexDirection: 'row', alignItems: 'center', gap: 2,
            }}>
              {/* Play */}
              <GlassButton
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
              </GlassButton>
              {/* Tools — opens a submenu (Terrain / Style / Interface / Player) */}
              <GlassButton
                onClick={() => { seedSceneSettings(); setToolsMenu('tools'); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>build</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Tools</text>
              </GlassButton>
              {/* Publish */}
              <GlassButton
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
              </GlassButton>
              {/* Save is fully automatic now — there is no manual Save button.
                  Every edit (move/rotate/scale/duplicate/trash/settings/logic)
                  bumps _editorStateRev and PATCHes editor-state 1.5 s later;
                  on unmount/disconnect a keepalive fetch flushes the pending
                  capture so the last edit can never be lost. */}
              {/* Vertical divider */}
              <view style={{ width: 1, height: 22, backgroundColor: 'rgba(255,255,255,0.08)', marginLeft: 4, marginRight: 4 }} />
              {/* Leave */}
              <GlassButton
                onClick={() => { setMenuOpen(false); onBack(); }}
                style={{
                  height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0,
                }}
              >
                <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>arrow_back</icon>
                <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>Leave</text>
              </GlassButton>
            </view>
          )
        ) : null}
      </view>
      ) : null}

      {/* ── Interface Builder — full-screen editor (Design canvas + Logic tab) ── */}
      {toolsMenu === 'interface' && !hostedByNative ? (
        <view
          onPointerDown={() => { try { (Globals as any).setEditorSheetDragging?.('true'); } catch {} }}
          onPointerUp={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
          onPointerCancel={() => { try { (Globals as any).setEditorSheetDragging?.('false'); } catch {} }}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 20,
            backgroundColor: 'rgba(8,8,10,0.98)',
          }}
        >
          {/* Header */}
          <view style={{
            position: 'absolute', top: safeAreaTop(), left: safeAreaLeft(), right: safeAreaRight(), height: IFACE_HEADER_H,
            flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 10,
            borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
          }}>
            <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18, marginRight: 8 }}>dashboard</icon>
            <text style={{ flex: 1, fontSize: 14, color: '#fff', fontWeight: 'bold' }}>Interface Builder</text>
            <GlassButton
              onClick={() => { setIfaceSelected(null); setToolsMenu(hostedByNative ? 'none' : 'tools'); }}
              style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 0 }}
            >
              <icon set="material-rounded" style={{ fontSize: 18, color: C.text, lineHeight: 18 }}>close</icon>
            </GlassButton>
          </view>

          {/* Design | Logic segmented control — Bubble.io-style split between
              laying out the screen and wiring up what taps do. */}
          <view style={{
            position: 'absolute', top: safeAreaTop() + IFACE_HEADER_H, left: safeAreaLeft() + IFACE_PAD, right: safeAreaRight() + IFACE_PAD, height: IFACE_TABBAR_H,
            flexDirection: 'row', alignItems: 'center', gap: 8,
          }}>
            {(['design', 'logic'] as const).map(tab => (
              <GlassButton key={tab} onClick={() => setIfaceTab(tab)} style={{
                flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
                paddingTop: 8, paddingBottom: 8, borderRadius: 10,
                backgroundColor: ifaceTab === tab ? 'rgba(30,140,255,0.22)' : 'rgba(255,255,255,0.05)',
                borderWidth: 1, borderColor: ifaceTab === tab ? C.blue : 'rgba(255,255,255,0.09)',
              }}>
                <icon set="material-rounded" style={{ fontSize: 15, lineHeight: 15, color: ifaceTab === tab ? C.blue : C.text }}>{tab === 'design' ? 'brush' : 'bolt'}</icon>
                <text style={{ fontSize: 12, color: ifaceTab === tab ? C.blue : C.text, fontWeight: 'bold' }}>{tab === 'design' ? 'Design' : 'Logic'}</text>
              </GlassButton>
            ))}
          </view>

          {ifaceTab === 'design' ? (
            <InterfaceCanvasPanel
              elements={interfaceElements}
              workflows={interfaceWorkflows}
              selectedId={ifaceSelected}
              onSelect={setIfaceSelected}
              onChange={pushInterfaceElements}
              onOpenLogicForSelected={() => { if (ifaceSelected) ensureWorkflowForElement(ifaceSelected); setIfaceTab('logic'); }}
            />
          ) : (
            <view style={{
              position: 'absolute',
              top: safeAreaTop() + IFACE_HEADER_H + IFACE_TABBAR_H, left: safeAreaLeft(), right: safeAreaRight(), bottom: safeAreaBottom(),
            }}>
              <InterfaceLogicPanel
                elements={interfaceElements}
                workflows={interfaceWorkflows}
                selectedElementId={ifaceSelected}
                onSelectElement={setIfaceSelected}
                onChangeWorkflows={pushInterfaceWorkflows}
              />
            </view>
          )}
        </view>
      ) : null}

      {/* ── Top-right corner: Undo / Redo. Mirrors the top-left menu bar's
          vertical position. No editorShift — the left-docked panels open on the
          opposite edge, so these never need to slide out of their way.
          Native shell draws these natively instead. */}
      {!pickingVar && !hostedByNative ? (
      <view style={{
        position: 'absolute',
        top: safeAreaTop(), right: safeAreaRight(),
        zIndex: 10,
        flexDirection: 'row', gap: 8,
      }}>
        <GlassButton
          onClick={undo}
          style={{
            width: 44, height: 44, borderRadius: 12,
            ...glass({ fill: 'rgba(20,20,22,0.78)' }),
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
            opacity: canUndo ? 1 : 0.4,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>undo</icon>
        </GlassButton>
        <GlassButton
          onClick={redo}
          style={{
            width: 44, height: 44, borderRadius: 12,
            ...glass({ fill: 'rgba(20,20,22,0.78)' }),
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
            opacity: canRedo ? 1 : 0.4,
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 22, color: C.text, lineHeight: 22 }}>redo</icon>
        </GlassButton>
      </view>
      ) : null}

      {/* Preview error banner — shown when Unity reports a script failure in preview mode,
          or (LOAD_FAILED: prefix) when the initial game-data fetch itself failed (e.g. the
          api-server is unreachable). The latter gets a Retry button since there's nothing
          else prompting the user to try again — see GameLauncher.LaunchAsync's
          keepEditorOpenOnError path, which leaves this banner up instead of bouncing back
          to the lobby. Hidden during isBuilding so users don't see scary parse errors from
          streaming partials that get auto-completed/skipped a frame later. */}
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
          <text style={{ fontSize: 13, color: '#fff', flex: 1 }}>
            {previewError.startsWith('LOAD_FAILED:') ? previewError.slice('LOAD_FAILED:'.length) : previewError}
          </text>
          {previewError.startsWith('LOAD_FAILED:') ? (
            <GlassButton onClick={() => {
              setPreviewError(''); try { (Globals as any)._editorError = ''; } catch {}
              try { (Globals as any).loadGameForEdit?.(game.id); } catch {}
            }} style={{
              paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4,
              borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.18)',
            }}>
              <text style={{ fontSize: 12, color: '#fff', fontWeight: '600' }}>Retry</text>
            </GlassButton>
          ) : null}
          <GlassButton onClick={() => { setPreviewError(''); try { (Globals as any)._editorError = ''; } catch {} }} style={{
            paddingLeft: 8, paddingRight: 8,
          }}>
            <icon set="material-rounded" style={{ fontSize: 16, color: 'rgba(255,255,255,0.7)', lineHeight: 16 }}>close</icon>
          </GlassButton>
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
      {!pickingVar && !hostedByNative ? (
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
                    width: EDITOR_ASSET_TILE_SIZE, height: EDITOR_ASSET_TILE_SIZE,
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
      ) : null}

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
            <GlassButton
              onClick={() => { try { (Globals as any).editorDuplicateSelected?.(); } catch {} }}
              style={{
                position: 'absolute',
                left: left - btn / 2, top: top - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                ...glass({ fill: 'rgba(20,20,22,0.92)' }),
                borderWidth: 2, borderColor: '#ffffff',
                alignItems: 'center', justifyContent: 'center',
                zIndex: frameZ + 1,
              } as any}>
              <icon set="material-rounded" style={{ fontSize: 18, color: '#fff', lineHeight: 18 }}>content_copy</icon>
            </GlassButton>
            {/* Top-right: swipe to scale — drag vertically to make the object
                bigger (swipe up) or smaller (swipe down). Release (isPointerDown
                poll) ends the swipe. */}
            <view
              onPointerDown={() => startManipulating('scale')}
              style={{
                position: 'absolute',
                left: right - btn / 2, top: top - btn / 2,
                width: btn, height: btn, borderRadius: btn / 2,
                ...glass({ fill: 'rgba(20,20,22,0.92)' }),
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
                ...glass({ fill: 'rgba(20,20,22,0.92)' }),
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
                ...glass({ fill: 'rgba(20,20,22,0.92)' }),
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
                ...glass({ fill: 'rgba(20,20,22,0.92)' }),
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
      {(selectMode && selectedObj && showSettings && !pickingVar && !hostedByNative) ? (
        <ObjectSettingsPanel
          settings={currentObjSetting}
          size={modalSize === 'full' ? 'full' : 'default'}
          onChange={updateObjSetting}
          onClose={closeModal}
          onToggleSize={toggleModalSize}
          onPointerDown={modalPointerDown}
          onPointerUp={modalPointerUp}
        />
      ) : null}

      {/* ── Custom Logic panel — opens from the Custom Logic (code) button on
          the object-selected top bar. Shares the same left-dock slot as the
          settings panel, so the two are mutually exclusive (opening one closes
          the other). Each per-object graph is keyed by object id and mirrored
          to Unity through pushObjectLogic so behavior nodes apply live. */}
      {(selectMode && selectedObj && showCustomLogic && !pickingVar && !hostedByNative) ? (
        <CustomLogicPanel
          graph={currentObjGraph}
          size={modalSize === 'full' ? 'full' : 'default'}
          onChange={updateObjGraph}
          onClose={closeModal}
          onToggleSize={toggleModalSize}
          onPointerDown={modalPointerDown}
          onPointerUp={modalPointerUp}
          onPickInViewport={beginPickObject}
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
      {!pickingVar && !hostedByNative ? (
      <view style={{
        position: 'absolute',
        bottom: h + keyboardH + (safeAreaBottom()),
        right: safeAreaRight(),
        flexDirection: 'column', gap: 8,
        alignItems: 'flex-end',
      }}>
        <GlassButton
          onClick={() => onOpenShop?.()}
          style={{
            width: 56, height: 56, borderRadius: 12,
            ...glass({ fill: 'rgba(20,20,22,0.78)' }),
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <icon set="material-rounded" style={{ fontSize: 28, color: C.text, lineHeight: 28 }}>add_circle</icon>
        </GlassButton>
      </view>
      ) : null}

      {/* AI chat panel removed — the editor no longer has an AI assistant. */}

      {/* ── Click-to-assign pill — shown while pickingVar is set (Variables'
          Assign button on an asset/element row). The rest of the chrome is
          hidden above so this is the only UI on screen besides the bare 3D
          viewport; the root view already forwards taps to Unity as normal,
          so the camera keeps panning/zooming and the next object tap resolves
          the pick (EditorCameraController.ProcessPickTap). X cancels back to
          exactly how the screen looked before Assign was pressed. */}
      {pickingVar ? (
        <view style={{
          position: 'absolute',
          left: safeAreaLeft() + 16, right: safeAreaRight() + 16,
          bottom: safeAreaBottom() + 16,
          ...glass({ fill: 'rgba(20,20,22,0.92)' }),
          borderRadius: 14,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
          flexDirection: 'row', alignItems: 'center',
          paddingLeft: 16, paddingRight: 8, paddingTop: 10, paddingBottom: 10,
          zIndex: 20,
        }}>
          <text style={{ flex: 1, width: 1, fontSize: 13, color: C.text }}>
            Click on an object to assign
          </text>
          <Pressable
            onClick={cancelPickObject}
            style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }}
          >
            <icon set="material-rounded" style={{ fontSize: 17, color: C.textMuted, lineHeight: 17 }}>close</icon>
          </Pressable>
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

export function CreateScreen({ onEditingChange, onEditingGameChange, onOpenShop, onApplyAssets, editorAssets, initialEditGame, startNewGame, onExitEditor }: {
  onEditingChange?: (v: boolean) => void;
  // Reports the active game's id (or null when not editing) so App.tsx can
  // route the Assets modal's onApply into the correct per-game asset bucket.
  // Editor strip differs between games because of this.
  onEditingGameChange?: (gameId: number | null) => void;
  onOpenShop?: () => void;
  onApplyAssets?: (picked: AssetItem[]) => void;
  editorAssets?: AssetItem[];
  // Native shell: open this game straight in the editor on mount (the game
  // drawer's owner-only "Edit"). Ignored when resuming a play-test session.
  initialEditGame?: GameStub;
  // Native shell "+" button: create a blank game on mount and open its editor.
  startNewGame?: boolean;
  // Native shell: leaving the editor exits the creator (back to the native app)
  // instead of showing the Create game list.
  onExitEditor?: () => void;
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
  const openedInitialRef = useRef(false);
  useEffect(() => {
    if (openedInitialRef.current || activeGame) return;
    if (initialEditGame) { openedInitialRef.current = true; openGame(initialEditGame); }
    else if (startNewGame) { openedInitialRef.current = true; createBlankGame(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          if (onExitEditor) { onExitEditor(); return; }
          // Do NOT clear buildJobId here. The prompt-phase polling effect picks it
          // up from _jobCache and continues tracking the job in the background.
          setPhase('prompt');
          setActiveGame(null);
          loadMyGames();
        }}
        onEditingChange={onEditingChange}
        onOpenShop={onOpenShop}
        onApplyAssets={onApplyAssets}
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
        <GlassButton
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
        </GlassButton>

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
                  <GlassButton
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
                  </GlassButton>
                );
              })}
            </view>
          )}
        </view>

      </scroll>
    </view>
  );
}
