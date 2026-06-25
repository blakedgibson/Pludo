// prompt-validation.ts — All server-side validation for /api/forge-game prompts.
// Functions are pure and exported so they can be unit-tested independently.
// Execution order: validatePromptLength → filterContent → (Claude call) → scanLuaScript → validateManifest

// ── Constants ─────────────────────────────────────────────────────────────────

export const MIN_PROMPT_NONWS = 3;    // minimum non-whitespace characters
export const MAX_PROMPT_LENGTH = 2000; // total character limit

// ── 1. Length validation ──────────────────────────────────────────────────────

export interface ValidationResult {
  ok: true;
}
export interface ValidationError {
  ok: false;
  error: string;
  code: 400 | 422;
}
export type PromptCheck = ValidationResult | ValidationError;

export function validatePromptLength(prompt: string): PromptCheck {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false, code: 400,
      error: `Prompt is too long (${prompt.length} chars). Maximum is ${MAX_PROMPT_LENGTH} characters.`,
    };
  }
  const nonWS = prompt.replace(/\s/g, '').length;
  if (nonWS < MIN_PROMPT_NONWS) {
    return {
      ok: false, code: 400,
      error: 'Prompt is too short. Describe your game in at least a few words.',
    };
  }
  return { ok: true };
}

// ── 2. Content filter ─────────────────────────────────────────────────────────
// First-pass blocklist. Claude has its own safety guardrails as a second layer.
// Patterns use word-boundary anchors to avoid false positives on substrings.

const BLOCKED_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /\b(rape|sexual\s+assault|child\s+porn|cp\b|loli)\b/i,            category: 'sexual violence / CSAM' },
  { re: /\b(fuck|shit|cock|pussy|cunt|dick|bitch|asshole)\b/i,             category: 'profanity' },
  { re: /\b(nigg(er|a)s?|faggots?|trann(y|ies)|kikes?|spics?|chinks?|wetbacks?|gooks?)\b/i, category: 'hate speech' },
  { re: /\b(genocide|ethnic\s+cleansing|mass\s+murder|torture\s+porn)\b/i, category: 'extreme violence' },
  { re: /\bkill\s+(trump|biden|obama|putin|musk|zuckerberg|elon)\b/i,       category: 'real-person targeting' },
];

export interface ContentFilterResult {
  ok: boolean;
  category?: string;
}

export function filterContent(prompt: string): ContentFilterResult {
  for (const { re, category } of BLOCKED_PATTERNS) {
    if (re.test(prompt)) return { ok: false, category };
  }
  return { ok: true };
}

// ── 2b. In-game chat moderation ───────────────────────────────────────────────
// Lighter-touch than filterContent: the chat surface should accept normal
// conversation, mask casual profanity, and only block messages that contain
// truly disallowed content (hate speech, sexual violence, real-person violent
// targeting). Rate-limiting is the room's responsibility — this is purely
// content classification.

export interface ChatModerationResult {
  ok: true;
  text: string;          // possibly censored ('shit' → '****')
  censored: boolean;     // true if any masking happened
}
export interface ChatModerationReject {
  ok: false;
  reason: string;        // user-facing reason
  category: string;      // for logs
}
export type ChatModeration = ChatModerationResult | ChatModerationReject;

// Same pattern shape as BLOCKED_PATTERNS but with a per-pattern action.
// 'censor' replaces the matched substring with the appropriate number of *s
// so the conversation can continue; 'reject' kills the message entirely.
const CHAT_PATTERNS: Array<{ re: RegExp; category: string; action: 'censor' | 'reject' }> = [
  { re: /\b(rape|sexual\s+assault|child\s+porn|cp|loli)\b/i,                                      category: 'sexual violence / CSAM',  action: 'reject' },
  { re: /\b(nigg(?:er|a)s?|faggots?|trann(?:y|ies)|kikes?|spics?|chinks?|wetbacks?|gooks?)\b/i,    category: 'hate speech',             action: 'reject' },
  { re: /\b(genocide|ethnic\s+cleansing|mass\s+murder)\b/i,                                       category: 'extreme violence',        action: 'reject' },
  { re: /\bkill\s+(trump|biden|obama|putin|musk|zuckerberg|elon)\b/i,                              category: 'real-person targeting',   action: 'reject' },
  { re: /\b(fuck|shit|cock|pussy|cunt|dick|bitch|asshole|bastard|piss)\b/i,                        category: 'profanity',               action: 'censor' },
];

export function moderateChat(text: string): ChatModeration {
  for (const { re, category, action } of CHAT_PATTERNS) {
    if (action === 'reject' && re.test(text)) {
      return { ok: false, category, reason: 'Message blocked by moderation.' };
    }
  }
  let censored = false;
  let cleaned = text;
  for (const { re, action } of CHAT_PATTERNS) {
    if (action !== 'censor') continue;
    cleaned = cleaned.replace(new RegExp(re.source, re.flags.replace('g', '') + 'g'),
      (match) => { censored = true; return '*'.repeat(match.length); });
  }
  return { ok: true, text: cleaned, censored };
}

// ── 3. Lua script security scan ───────────────────────────────────────────────
// Runs on Claude's returned luau_script BEFORE it is stored or hot-reloaded.
// Any match → reject the entire generation and log a security event.
// The LuaRuntime sandbox nil's these out at runtime too, but defence-in-depth
// means we want to detect and reject rather than silently neutralise.

const DANGEROUS_LUA: Array<{ re: RegExp; label: string }> = [
  { re: /\bos\s*\.\s*\w+/,       label: 'os.*' },
  { re: /\bio\s*\.\s*\w+/,       label: 'io.*' },
  { re: /\brequire\s*\(/,        label: 'require()' },
  { re: /\bdofile\s*\(/,         label: 'dofile()' },
  { re: /\bloadfile\s*\(/,       label: 'loadfile()' },
  { re: /\bload\s*\(\s*['"]/,    label: 'load(string)' },  // load("...") — not bare identifier
  { re: /\bdebug\s*\.\s*\w+/,    label: 'debug.*' },
  { re: /\bpackage\s*\.\s*\w+/,  label: 'package.*' },
];

export interface ScriptScanResult {
  safe: boolean;
  violations: string[];
}

export function scanLuaScript(script: string): ScriptScanResult {
  const violations: string[] = [];
  for (const { re, label } of DANGEROUS_LUA) {
    if (re.test(script)) violations.push(label);
  }
  return { safe: violations.length === 0, violations };
}

// ── 4. Manifest hard validation ───────────────────────────────────────────────
// Independent of Claude following instructions. Each entry must reference an
// existing catalog asset by key (validated downstream by resolveCatalogManifest).
// Caps the count at MAX_ASSETS to keep scene complexity and Claude's focus sane.

export interface ManifestItem {
  id: string;
  asset: string;       // catalog key selected from the shared library
  is_humanoid: boolean;
  size_hint?: number;  // real-world longest dimension in meters (height for humanoids)
}

export interface ManifestValidationResult {
  items: ManifestItem[];    // validated items — all valid entries kept
  warnings: string[];
  droppedCount: number;
}

// IDs reserved for procedural Structure.* geometry. Claude should not request
// these via Meshy — they're built from primitives at runtime. We strip them
// here in case a generated game slips through with a stray "terrain" entry.
const RESERVED_STRUCTURAL_IDS = new Set([
  'terrain', 'ground', 'floor', 'wall', 'walls', 'platform', 'building',
  'structure', 'fence', 'barrier', 'ramp', 'roof', 'ceiling',
]);

export function validateManifest(raw: unknown): ManifestValidationResult {
  const warnings: string[] = [];
  const arr = Array.isArray(raw) ? raw : [];

  // Keep only items with correct shape; drop invalid ones
  const shapeValid = arr.filter((m): m is ManifestItem => {
    if (m === null || typeof m !== 'object') return false;
    const item = m as ManifestItem;
    if (typeof item.id !== 'string' || item.id.trim() === '') return false;
    if (typeof item.asset !== 'string' || item.asset.trim() === '') return false;
    if (typeof item.is_humanoid !== 'boolean') return false;
    // size_hint is optional; if present must be a positive number
    if (item.size_hint !== undefined && (typeof item.size_hint !== 'number' || item.size_hint <= 0))
      return false;
    return true;
  });

  // Strip structural ids — those geometries live in the procedural Structure.*
  // tier, not as catalog props. A stray "terrain"/"ground" entry would reference
  // a redundant tile the Lua never uses.
  const structuralDropped: string[] = [];
  const valid = shapeValid.filter(m => {
    const idLc = m.id.toLowerCase();
    if (RESERVED_STRUCTURAL_IDS.has(idLc) || idLc.endsWith('_terrain') || idLc.startsWith('terrain_')) {
      structuralDropped.push(m.id);
      return false;
    }
    return true;
  });
  if (structuralDropped.length > 0)
    warnings.push(`Dropped ${structuralDropped.length} structural manifest id(s) — those belong to Structure.* (${structuralDropped.join(', ')})`);

  const MAX_ASSETS = 6;
  const dropped = arr.length - shapeValid.length;
  if (dropped > 0) warnings.push(`${dropped} manifest item(s) had invalid shape and were dropped`);

  // Hard cap — truncate to 6 even if Claude returned more
  const capped = valid.slice(0, MAX_ASSETS);
  if (valid.length > MAX_ASSETS)
    warnings.push(`Manifest had ${valid.length} entries — truncated to ${MAX_ASSETS} (asset cap)`);

  // 0 entries is now valid — a game with only Structure.* primitives and no
  // small interactive props is a legitimate (if minimal) shape.
  return { items: capped, warnings, droppedCount: dropped };
}

// ── 4b. Object-placement validation ──────────────────────────────────────────
// Catches scripts where Claude clusters every Object.Create at or near the
// origin. The play area is 80×80 (X ∈ [-40,40], Z ∈ [-40,40]); a script that
// places its non-terrain objects within 10 units of (0,0,0) wastes the world.
// This is advisory — caller decides whether to regenerate or warn the user.

export interface PlacementValidationResult {
  valid: boolean;
  warning?: string;
  positionsChecked: number;
}

export function validateObjectPlacement(script: string): PlacementValidationResult {
  // Match :SetPosition(x, y, z) — supports negatives and decimals. We skip
  // SetPosition calls that reference loop variables (e.g. tx * terrainSize)
  // since those are computed at runtime; only literal-coord calls are checked.
  const positionRegex = /:\s*SetPosition\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g;
  const positions: { x: number; y: number; z: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = positionRegex.exec(script)) !== null) {
    positions.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) });
  }

  if (positions.length < 3) return { valid: true, positionsChecked: positions.length };

  // Cluster check: every literal-position object packed within 10 units of origin.
  const clusteredCount = positions.filter(p => Math.abs(p.x) < 10 && Math.abs(p.z) < 10).length;
  if (clusteredCount === positions.length) {
    return {
      valid: false,
      positionsChecked: positions.length,
      warning: `All ${positions.length} hard-coded Object.Create positions cluster within 10 units of origin. The play area is 80×80 (X,Z ∈ [-40,40]) — spread objects out per the spatial placement rules.`,
    };
  }

  // Duplicate-position check: 3+ objects sharing the exact same (x, z).
  const xzCounts = new Map<string, number>();
  for (const p of positions) {
    const k = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    xzCounts.set(k, (xzCounts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of xzCounts) {
    if (n >= 3) {
      return {
        valid: false,
        positionsChecked: positions.length,
        warning: `${n} objects share the same (X,Z) position ${k} — vary placement so objects don't visually stack.`,
      };
    }
  }

  return { valid: true, positionsChecked: positions.length };
}

// ── 5. System-prompt leak detection ──────────────────────────────────────────
// If Claude echoes back portions of its own system prompt, strip and log it.

const SYSTEM_PROMPT_MARKERS = [
  'You are Pludo',
  'LUAU_FORGE_SYSTEM',
  'MoonSharp Luau sandbox',
  'MANDATORY: every game MUST have',
];

export function detectSystemPromptLeak(text: string): boolean {
  return SYSTEM_PROMPT_MARKERS.some(m => text.includes(m));
}
