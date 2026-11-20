// moderation/index.ts — high-level helpers the HTTP + WebSocket layers call.
// Each helper = lexicon pass (sync) → optional AI pass (async) → audit log.

import { moderateText, safeDisplayName, type ModerationContext, type ModerationResult } from './engine.js';
import { reviewText, reviewImage, aiEnabled, type AiReview } from './ai.js';
import { logEvent, strikes } from './store.js';
import type { Category } from './lexicon.js';

export { moderateText, safeDisplayName } from './engine.js';
export type { ModerationContext, ModerationResult } from './engine.js';
export { strikes, duplicates, logEvent, loadModerationState, createReport, reportAllowed } from './store.js';
export { aiEnabled } from './ai.js';

export interface Actor { id?: string; name?: string; }

export interface Decision {
  ok: boolean;
  text: string;
  userMessage?: string;
  review?: AiReview | null;
  flagged?: boolean;
}

const AI_BLOCK_MESSAGE = 'This doesn’t meet Pludo’s community guidelines. Please change it and try again.';

/** Lexicon-only check with audit logging (usernames, titles, comments, chat). */
export function check(text: unknown, context: ModerationContext, actor: Actor = {}, opts: { strict?: boolean; targetType?: string; targetId?: string } = {}): ModerationResult {
  const r = moderateText(text, context, { strict: opts.strict });
  const loggable = r.violations.filter(v => v.category !== 'format' && (v.action === 'reject' || v.action === 'flag'));
  if (loggable.length > 0) {
    logEvent({
      context, action: r.ok ? 'flag' : 'reject', actorId: actor.id, actorName: actor.name,
      targetType: opts.targetType, targetId: opts.targetId, excerpt: String(text ?? ''),
      categories: [], matches: [], source: 'lexicon', violations: loggable,
    });
  }
  return r;
}

/** Strike a user for a rejected message; returns remaining mute ms (0 if none). */
export function strike(key: string, r: ModerationResult): number {
  const sev = r.violations.some(v => v.action === 'reject' && v.severity === 'high') ? 'high' : 'medium';
  const { mutedUntil } = strikes.record(key, sev);
  if (mutedUntil) {
    logEvent({ context: r.context, action: 'auto_mute', actorId: key, excerpt: `muted until ${new Date(mutedUntil).toISOString()}`, categories: [], matches: [], source: 'strike' });
    return mutedUntil - Date.now();
  }
  return 0;
}

function aiDecision(review: AiReview | null, kind: ModerationContext | 'image', excerpt: string, actor: Actor, target?: { type?: string; id?: string }): { ok: boolean; flagged: boolean } {
  if (!review || review.verdict === 'allow') return { ok: true, flagged: false };
  logEvent({
    context: kind, action: review.verdict === 'block' ? 'reject' : 'flag', actorId: actor.id, actorName: actor.name,
    targetType: target?.type, targetId: target?.id, excerpt: `${excerpt} — AI: ${review.reason}`,
    categories: review.categories as Category[], matches: [], source: 'ai',
  });
  return { ok: review.verdict !== 'block', flagged: review.verdict === 'review' };
}

/**
 * Publishing a game: title + description must pass the lexicon, then the AI
 * reviewer. AI unavailability fails OPEN (logged) so publishing never hard-
 * depends on an external API; the lexicon still applies.
 */
export async function checkPublish(title: string, description: string, actor: Actor, gameId: string): Promise<Decision & { title: string; description: string }> {
  const t = check(title, 'game_title', actor, { targetType: 'game', targetId: gameId });
  if (!t.ok) return { ok: false, text: '', title, description, userMessage: `Title: ${t.userMessage}` };
  const d = check(description, 'game_description', actor, { targetType: 'game', targetId: gameId });
  if (!d.ok) return { ok: false, text: '', title, description, userMessage: `Description: ${d.userMessage}` };
  const review = await reviewText('published game listing', { title: t.text, description: d.text });
  const ai = aiDecision(review, 'game_title', `${t.text} | ${d.text}`, actor, { type: 'game', id: gameId });
  if (!review && aiEnabled()) logEvent({ context: 'game_title', action: 'ai_unavailable', actorId: actor.id, targetType: 'game', targetId: gameId, excerpt: t.text, categories: [], matches: [], source: 'ai' });
  return {
    ok: ai.ok, flagged: ai.flagged, review, text: '', title: t.text, description: d.text,
    ...(ai.ok ? {} : { userMessage: AI_BLOCK_MESSAGE }),
  };
}

/** Prompts that drive generation (forge, edit, avatar items, raw Meshy). */
export async function checkGenerationPrompt(prompt: string, context: 'prompt' | 'asset_prompt', actor: Actor, opts: { ai?: boolean } = {}): Promise<Decision> {
  const r = check(prompt, context, actor);
  if (!r.ok) return { ok: false, text: '', userMessage: r.userMessage ?? 'This prompt violates our usage policy.' };
  if (!opts.ai) return { ok: true, text: r.text };
  const review = await reviewText(context === 'asset_prompt' ? '3D model generation prompt' : 'game generation prompt', { prompt: r.text });
  const ai = aiDecision(review, context, r.text, actor);
  return { ok: ai.ok, flagged: ai.flagged, review, text: r.text, ...(ai.ok ? {} : { userMessage: AI_BLOCK_MESSAGE }) };
}

/**
 * Post-generation check of a 3D model via its rendered thumbnail. Text
 * prompts can be innocuous while the generated mesh is not (or vice versa),
 * so every user-requested model is looked at before it's saved/listed.
 * Fails OPEN when the reviewer is unavailable, but logs for manual review.
 */
export async function checkModelThumbnail(thumbnailUrl: string | undefined, label: string, actor: Actor, target: { type: string; id?: string }): Promise<Decision> {
  if (!thumbnailUrl) return { ok: true, text: '' };
  const review = await reviewImage('3D model', thumbnailUrl, label);
  if (!review && aiEnabled()) {
    logEvent({ context: 'image', action: 'ai_unavailable', actorId: actor.id, actorName: actor.name, targetType: target.type, targetId: target.id, excerpt: thumbnailUrl, categories: [], matches: [], source: 'ai' });
  }
  const ai = aiDecision(review, 'image', `${label} ${thumbnailUrl}`, actor, target);
  return { ok: ai.ok, flagged: ai.flagged, review, text: '', ...(ai.ok ? {} : { userMessage: 'The generated model didn’t pass our content review. Try a different description.' }) };
}

/** Moderates AI-generated listing text (forge output) — swaps in safe defaults. */
export function sanitizeGeneratedListing(title: string, description: string): { title: string; description: string } {
  const t = moderateText(title, 'game_title');
  const d = moderateText(description, 'game_description');
  return { title: t.ok ? t.text : 'Untitled Game', description: d.ok ? d.text : '' };
}

export { safeDisplayName as safeName };
