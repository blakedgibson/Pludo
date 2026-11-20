// engine.ts — synchronous, deterministic text moderation for every UGC surface.
//
// One entry point, moderateText(text, context), with a per-surface Policy:
//
//   username / display_name / item_name — identifiers: strictest, substring scan,
//                                          impersonation, no PII, no links
//   game_title / game_description       — public listings: no profanity, no PII/links
//   chat / comment                      — conversation: censor mild, reject severe,
//                                          block grooming / off-platform / scams
//   prompt / asset_prompt               — generation inputs (forge, edit, Meshy)
//
// The AI reviewer (ai.ts) is a second, asynchronous layer used for publishing
// and 3D generation; this layer is cheap enough for every chat message.

import { tokenize, tokenForms, splitIdentifier, squash, baseNormalize, leetVariants, phraseForms, type Token } from './normalize.js';
import {
  lookupToken, substringTerms, allPhrases, rank, ALLOWLIST, isProseSubstringTerm,
  RESERVED_SUBSTRINGS, RESERVED_TOKENS, type Category, type Severity, type Term,
} from './lexicon.js';
import { detectPii, maskPii, type PiiHit } from './pii.js';

export type ModerationContext =
  | 'username' | 'display_name' | 'item_name'
  | 'game_title' | 'game_description'
  | 'chat' | 'comment'
  | 'prompt' | 'asset_prompt';

export type Action = 'allow' | 'flag' | 'censor' | 'reject';

export interface Violation {
  category: Category;
  severity: Severity;
  action: Action;
  /** Matched lexicon term / pii kind. Logged server-side, never sent to clients. */
  match?: string;
}

export interface ModerationResult {
  ok: boolean;                 // false ⇒ caller must not store / broadcast the text
  action: Action;              // most severe action taken
  text: string;                // cleaned text (censored / masked / trimmed)
  violations: Violation[];
  userMessage?: string;        // safe to show to the author when !ok
  context: ModerationContext;
}

export interface ModerateOptions {
  /** Under-13 / unknown-age audiences. Defaults to true for chat & comments. */
  strict?: boolean;
}

interface Policy {
  minLen: number;
  maxLen: number;
  bySeverity: Record<Severity, Action>;
  byCategory?: Partial<Record<Category, Action>>;
  identifier: boolean;          // split camelCase/digits + substring-scan all severities
  pii: Action;                  // email / phone / address / handle
  links: Action;
  impersonation: Action | 'off';
  spam: boolean;
  format?: { re: RegExp; message: string };
}

const NAME_CATS: Partial<Record<Category, Action>> = {
  sexual: 'reject', hate: 'reject', drugs: 'reject', extremism: 'reject', csam: 'reject',
  harassment: 'reject', grooming: 'reject', scam: 'reject', off_platform: 'reject', self_harm: 'reject',
};
const CONVO_CATS: Partial<Record<Category, Action>> = {
  csam: 'reject', grooming: 'reject', scam: 'reject', off_platform: 'reject', self_harm: 'reject',
  threat: 'reject', extremism: 'reject', harassment: 'reject',
};

const POLICIES: Record<ModerationContext, (strict: boolean) => Policy> = {
  username: () => ({
    minLen: 3, maxLen: 32, identifier: true, pii: 'reject', links: 'reject', impersonation: 'reject', spam: false,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' }, byCategory: NAME_CATS,
    format: { re: /^[A-Za-z0-9_]+$/, message: 'Usernames can only use letters, numbers, and underscores.' },
  }),
  display_name: () => ({
    minLen: 1, maxLen: 32, identifier: true, pii: 'reject', links: 'reject', impersonation: 'reject', spam: true,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' }, byCategory: NAME_CATS,
  }),
  item_name: () => ({
    minLen: 1, maxLen: 60, identifier: true, pii: 'reject', links: 'reject', impersonation: 'flag', spam: true,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' }, byCategory: NAME_CATS,
  }),
  game_title: () => ({
    minLen: 1, maxLen: 80, identifier: true, pii: 'reject', links: 'reject', impersonation: 'flag', spam: true,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' }, byCategory: NAME_CATS,
  }),
  game_description: () => ({
    minLen: 0, maxLen: 1000, identifier: false, pii: 'reject', links: 'reject', impersonation: 'off', spam: true,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' },
    byCategory: { ...NAME_CATS, drugs: 'flag', harassment: 'flag' },
  }),
  chat: (strict) => ({
    minLen: 1, maxLen: 200, identifier: false, pii: strict ? 'reject' : 'censor', links: 'censor', impersonation: 'off', spam: true,
    bySeverity: { low: strict ? 'censor' : 'allow', medium: 'censor', high: 'reject' },
    byCategory: { ...CONVO_CATS, sexual: strict ? 'reject' : 'censor' },
  }),
  comment: (strict) => ({
    minLen: 1, maxLen: 500, identifier: false, pii: strict ? 'reject' : 'censor', links: 'censor', impersonation: 'off', spam: true,
    bySeverity: { low: strict ? 'censor' : 'allow', medium: 'censor', high: 'reject' },
    byCategory: { ...CONVO_CATS, sexual: 'reject' },
  }),
  prompt: () => ({
    minLen: 0, maxLen: 4000, identifier: false, pii: 'flag', links: 'flag', impersonation: 'off', spam: false,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' },
    // Game prompts legitimately mention villains, drug busts, insults between NPCs.
    byCategory: { drugs: 'flag', harassment: 'flag', grooming: 'flag', off_platform: 'flag', sexual: 'reject' },
  }),
  asset_prompt: () => ({
    minLen: 0, maxLen: 2000, identifier: false, pii: 'flag', links: 'flag', impersonation: 'off', spam: false,
    bySeverity: { low: 'allow', medium: 'reject', high: 'reject' },
    byCategory: { harassment: 'flag', grooming: 'flag', off_platform: 'flag', sexual: 'reject', drugs: 'reject' },
  }),
};

const USER_MESSAGES: Partial<Record<Category, string>> = {
  csam:          'This content is not allowed on Pludo.',
  sexual:        'Sexual content is not allowed on Pludo.',
  hate:          'Hateful language is not allowed on Pludo.',
  extremism:     'Extremist content is not allowed on Pludo.',
  threat:        'Threats and violent language toward people are not allowed.',
  harassment:    'Please be kind — bullying isn’t allowed.',
  grooming:      'For everyone’s safety, you can’t ask for pictures, secrets, or where people live.',
  self_harm:     'It sounds like you might be going through something hard. You’re not alone — please talk to someone you trust, or reach a crisis line (in the US, call or text 988).',
  profanity:     'Please keep it clean — that language isn’t allowed here.',
  drugs:         'References to drugs aren’t allowed here.',
  scam:          'Messages that look like scams or ask for account details aren’t allowed.',
  pii:           'For your safety, don’t share personal info like phone numbers, emails, or addresses.',
  off_platform:  'For your safety, you can’t share social media or contact info.',
  link:          'Links aren’t allowed here.',
  impersonation: 'Names can’t pretend to be Pludo staff or official accounts.',
  spam:          'That looks like spam.',
};

// ── Matching helpers ─────────────────────────────────────────────────────────

const ALLOW_SORTED = [...ALLOWLIST].sort((a, b) => b.length - a.length);
function maskAllowlisted(s: string): string {
  let out = s;
  for (const w of ALLOW_SORTED) if (out.includes(w)) out = out.split(w).join('#'.repeat(w.length));
  return out;
}

interface Hit { term: Term | { term: string; category: Category; severity: Severity }; tokens?: [number, number]; }

/** Exact-then-substring lookup over all comparable forms of a chunk of text. */
function matchForms(forms: string[], substring: boolean): Term[] {
  const found: Term[] = [];
  for (const f of forms) {
    const t = lookupToken(f);
    if (t) found.push(t);
  }
  if (substring) {
    for (const f of forms) {
      const masked = maskAllowlisted(f);
      for (const t of substringTerms()) if (masked.includes(t.term)) found.push(t);
    }
  }
  return found;
}

function scanLexicon(text: string, tokens: Token[], policy: Policy): Hit[] {
  const hits: Hit[] = [];

  // 1. Phrases across the whole message.
  const forms = phraseForms(text);
  for (const p of allPhrases()) {
    const needle = ` ${p.phrase} `;
    if (forms.some(f => f.includes(needle))) hits.push({ term: { term: p.phrase, category: p.category, severity: p.severity } });
  }

  // 2. Per token. Substring scan is always on for identifiers; for prose we
  //    only substring-scan medium/high to keep false positives near zero.
  tokens.forEach((tok, i) => {
    const tf = tokenForms(tok.raw);
    const exactHits = matchForms(tf, false);
    for (const t of exactHits) hits.push({ term: t, tokens: [i, i] });
    if (exactHits.length === 0) {
      for (const t of matchForms(tf, true)) {
        if (!policy.identifier && !isProseSubstringTerm(t)) continue;
        hits.push({ term: t, tokens: [i, i] });
      }
    }
    if (policy.identifier) {
      for (const part of splitIdentifier(tok.raw)) {
        const pf = new Set<string>();
        for (const v of leetVariants(part)) { const sq = squash(v); if (sq) pf.add(sq); }
        for (const t of matchForms([...pf], false)) hits.push({ term: t, tokens: [i, i] });
      }
    }
  });

  // 3. Spaced-out letters: "f u c k", "n i g g e r".
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart >= 0 && end - runStart >= 3) {
      const joined = tokens.slice(runStart, end).map(t => t.raw).join('');
      for (const t of matchForms(tokenForms(joined), true)) {
        // Deliberately spaced-out letters are evasion, so any high-severity
        // stem counts here even in prose ("a s w a s t i k a").
        if (!policy.identifier && !isProseSubstringTerm(t) && !(t.severity === 'high' && t.term.length >= 5) && !lookupToken(squash(joined))) continue;
        hits.push({ term: t, tokens: [runStart, end - 1] });
      }
    }
    runStart = -1;
  };
  tokens.forEach((tok, i) => {
    const single = tokenForms(tok.raw).some(f => f.length === 1);
    if (single) { if (runStart < 0) runStart = i; }
    else flush(i);
  });
  flush(tokens.length);

  return hits;
}

function checkImpersonation(text: string): string | null {
  const squashed = maskAllowlisted(squash(leetVariants(baseNormalize(text))[0]));
  for (const r of RESERVED_SUBSTRINGS) if (squashed.includes(r)) return r;
  const parts = splitIdentifier(text).flatMap(p => leetVariants(p).map(squash));
  for (const r of RESERVED_TOKENS) if (parts.includes(r)) return r;
  return null;
}

function cleanForOutput(raw: string, spam: boolean): string {
  let s = raw.normalize('NFC')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1');                 // zalgo → at most 2 marks
  if (spam) s = s.replace(/(.)\1{7,}/gu, '$1$1$1');     // "!!!!!!!!!!!" → "!!!"
  return s.replace(/\s{3,}/g, '  ').trim();
}

const ACTION_RANK: Record<Action, number> = { allow: 0, flag: 1, censor: 2, reject: 3 };

// ── Public API ───────────────────────────────────────────────────────────────

export function moderateText(input: unknown, context: ModerationContext, opts: ModerateOptions = {}): ModerationResult {
  const strict = opts.strict ?? (context === 'chat' || context === 'comment');
  const policy = POLICIES[context](strict);
  const raw = typeof input === 'string' ? input : '';
  let text = cleanForOutput(raw, policy.spam);
  const violations: Violation[] = [];

  const finish = (): ModerationResult => {
    const worst = violations.reduce<Action>((a, v) => (ACTION_RANK[v.action] > ACTION_RANK[a] ? v.action : a), 'allow');
    const ok = worst !== 'reject';
    const rejectV = violations.filter(v => v.action === 'reject')
      .sort((a, b) => rank(b.severity) - rank(a.severity))
      // self-harm message takes priority so a struggling user gets resources
      .sort((a, b) => Number(b.category === 'self_harm') - Number(a.category === 'self_harm'))[0];
    return {
      ok, action: worst, text: ok ? text : '', violations, context,
      ...(rejectV ? { userMessage: USER_MESSAGES[rejectV.category] ?? 'That isn’t allowed on Pludo.' } : {}),
    };
  };

  // Length / format
  if (Math.max(text.length, raw.trim().length) > policy.maxLen) {
    if (context === 'chat' || context === 'comment' || context.endsWith('name') || context === 'username') {
      violations.push({ category: 'format', severity: 'low', action: 'reject', match: `length>${policy.maxLen}` });
      const r = finish(); r.userMessage = `Too long — keep it under ${policy.maxLen} characters.`; return r;
    }
    text = text.slice(0, policy.maxLen);
  }
  if (text.replace(/\s/g, '').length < policy.minLen) {
    violations.push({ category: 'format', severity: 'low', action: 'reject', match: `length<${policy.minLen}` });
    const r = finish(); r.userMessage = policy.minLen > 1 ? `Must be at least ${policy.minLen} characters.` : 'Can’t be empty.'; return r;
  }
  if (policy.format && !policy.format.re.test(text)) {
    violations.push({ category: 'format', severity: 'low', action: 'reject', match: 'format' });
    const r = finish(); r.userMessage = policy.format.message; return r;
  }

  // Spam heuristics
  if (policy.spam) {
    if (/\S{60,}/.test(text) && !/https?:\/\//.test(text)) violations.push({ category: 'spam', severity: 'low', action: 'reject', match: 'long-token' });
  }

  // Lexicon
  const tokens = tokenize(text);
  const hits = scanLexicon(text, tokens, policy);
  const censorTokens = new Set<number>();
  for (const h of hits) {
    const { category, severity, term } = h.term;
    let action: Action = policy.byCategory?.[category] ?? policy.bySeverity[severity];
    // Category overrides may soften but never below the severity rule for 'high'.
    if (severity === 'high' && ACTION_RANK[action] < ACTION_RANK[policy.bySeverity.high]) action = policy.bySeverity.high;
    // Can only censor something we can locate; otherwise escalate to reject.
    if (action === 'censor' && !h.tokens) action = 'reject';
    if (action === 'censor' && h.tokens) for (let i = h.tokens[0]; i <= h.tokens[1]; i++) censorTokens.add(i);
    if (action !== 'allow') violations.push({ category, severity, action, match: term });
  }

  // PII / links / off-platform handles
  const pii = detectPii(text);
  const piiToMask: PiiHit[] = [];
  for (const p of pii) {
    const category: Category = p.kind === 'url' ? 'link' : p.kind === 'handle' ? 'off_platform' : 'pii';
    let action: Action = p.kind === 'url' ? policy.links : p.kind === 'handle' ? (policy.byCategory?.off_platform ?? policy.pii) : policy.pii;
    if (action === 'censor') piiToMask.push(p);
    if (action !== 'allow') violations.push({ category, severity: p.kind === 'url' ? 'medium' : 'high', action, match: p.kind });
  }

  // Impersonation
  if (policy.impersonation !== 'off') {
    const r = checkImpersonation(text);
    if (r) violations.push({ category: 'impersonation', severity: 'medium', action: policy.impersonation, match: r });
  }

  // Apply censoring (tokens first, by original spans, then PII masks).
  if (censorTokens.size > 0) {
    let out = '';
    let cursor = 0;
    tokens.forEach((t, i) => {
      out += text.slice(cursor, t.start);
      out += censorTokens.has(i) ? censorToken(t.raw) : t.raw;
      cursor = t.end;
    });
    text = out + text.slice(cursor);
  }
  if (piiToMask.length > 0) text = maskPii(text, detectPii(text).filter(p => piiToMask.some(q => q.kind === p.kind)));

  return finish();
}

/** Keeps leading/trailing punctuation so "shit!" → "****!". */
function censorToken(raw: string): string {
  const m = raw.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  if (!m || !m[2]) return '*'.repeat(raw.length);
  return m[1] + '*'.repeat([...m[2]].length) + m[3];
}

/** Convenience: replacement for unsafe identifiers shown to other players. */
export function safeDisplayName(name: unknown, fallbackSeed = ''): string {
  const r = moderateText(typeof name === 'string' ? name : '', 'display_name');
  if (r.ok && r.text) return r.text;
  let h = 0;
  for (const c of fallbackSeed || String(Math.random())) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `Player${(h % 9000) + 1000}`;
}
