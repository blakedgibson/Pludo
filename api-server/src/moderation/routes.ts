// routes.ts — HTTP surface for moderation.
//
// Public:
//   POST /api/moderation/check       { context, text }  → pre-validate a username/title/etc.
//   POST /api/report                 { targetType, targetId, reason, details?, userAccessToken }
//
// Admin (header `x-moderation-token: $MODERATION_ADMIN_TOKEN`):
//   GET    /api/moderation/queue             open reports + recent events
//   POST   /api/moderation/reports/:id       { status: 'dismissed'|'actioned', resolution }
//   POST   /api/moderation/games/:id/unpublish
//   POST   /api/moderation/mute              { key, minutes }   (key = user id / chat key)
//   GET    /api/moderation/terms
//   POST   /api/moderation/terms             { term, category, severity }
//   DELETE /api/moderation/terms/:term

import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { moderateText, type ModerationContext } from './engine.js';
import {
  createReport, listReports, resolveReport, recentEvents, reportAllowed, logEvent, strikes,
  persistCustomTerm, deleteCustomTerm, REPORT_REASONS, type ReportReason, type ReportTarget,
} from './store.js';
import { listCustomTerms, type Category, type Severity } from './lexicon.js';
import { aiEnabled } from './ai.js';

export interface ModerationDeps {
  userIdFromJwt(jwt: string): string;
  rateLimit(windowMs: number, max: number): (req: Request, res: Response, next: () => void) => void;
  /** Server-side copy of the reported content, so reports can't be forged. */
  snapshotFor(targetType: ReportTarget, targetId: string): Promise<string | null>;
  unpublishGame(id: number): Promise<boolean>;
}

const PUBLIC_CONTEXTS: ModerationContext[] = ['username', 'display_name', 'item_name', 'game_title', 'game_description', 'comment'];
const TARGETS: ReportTarget[] = ['user', 'game', 'chat', 'comment', 'avatar_item', 'asset'];
const CATEGORIES: Category[] = ['csam', 'sexual', 'hate', 'extremism', 'threat', 'self_harm', 'harassment', 'grooming', 'profanity', 'drugs', 'scam', 'impersonation'];
const SEVERITIES: Severity[] = ['low', 'medium', 'high'];

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MODERATION_ADMIN_TOKEN ?? '';
  if (expected.length < 16) { res.status(503).json({ error: 'Moderation admin is not configured (set MODERATION_ADMIN_TOKEN, 16+ chars).' }); return; }
  const got = String(req.headers['x-moderation-token'] ?? '');
  const a = Buffer.from(got), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

export function moderationRouter(deps: ModerationDeps): Router {
  const r = Router();

  // ── Public ────────────────────────────────────────────────────────────────

  r.post('/api/moderation/check', deps.rateLimit(60_000, 60), (req, res) => {
    const { context, text } = (req.body ?? {}) as { context?: ModerationContext; text?: string };
    if (!context || !PUBLIC_CONTEXTS.includes(context)) { res.status(400).json({ error: `context must be one of ${PUBLIC_CONTEXTS.join(', ')}` }); return; }
    const m = moderateText(String(text ?? ''), context);
    // Never echo matched terms back — that turns the endpoint into an oracle for evasion.
    res.json({ ok: m.ok, text: m.ok ? m.text : undefined, message: m.ok ? undefined : m.userMessage });
  });

  r.post('/api/report', deps.rateLimit(60_000, 10), async (req, res) => {
    const { targetType, targetId, reason, details = '', userAccessToken = '', snapshot = '' } =
      (req.body ?? {}) as { targetType?: ReportTarget; targetId?: string; reason?: ReportReason; details?: string; userAccessToken?: string; snapshot?: string };
    const reporterId = userAccessToken ? deps.userIdFromJwt(userAccessToken) : '';
    if (!reporterId) { res.status(401).json({ error: 'sign-in required to report' }); return; }
    if (!targetType || !TARGETS.includes(targetType)) { res.status(400).json({ error: 'invalid targetType' }); return; }
    if (!targetId || String(targetId).length > 128) { res.status(400).json({ error: 'invalid targetId' }); return; }
    if (!reason || !REPORT_REASONS.includes(reason)) { res.status(400).json({ error: `reason must be one of ${REPORT_REASONS.join(', ')}` }); return; }
    if (!reportAllowed(reporterId)) { res.status(429).json({ error: 'You’ve sent a lot of reports. Please try again later.' }); return; }

    const server = await deps.snapshotFor(targetType, String(targetId)).catch(() => null);
    const report = createReport({
      reporterId, targetType, targetId: String(targetId), reason,
      details: String(details).slice(0, 1000),
      snapshot: (server ?? String(snapshot)).slice(0, 2000),
      verified: server != null,
    });
    logEvent({ context: 'report', action: 'report', actorId: reporterId, targetType, targetId: String(targetId), excerpt: `${reason}: ${report.snapshot}`, categories: [], matches: [], source: 'lexicon' });
    res.json({ ok: true, reportId: report.id });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────

  r.get('/api/moderation/queue', requireAdmin, (req, res) => {
    const status = String(req.query.status ?? 'open') as 'open' | 'dismissed' | 'actioned' | 'all';
    res.json({ aiEnabled: aiEnabled(), reports: listReports(status), events: recentEvents(Number(req.query.limit ?? 200)) });
  });

  r.post('/api/moderation/reports/:id', requireAdmin, (req, res) => {
    const { status, resolution = '' } = (req.body ?? {}) as { status?: 'dismissed' | 'actioned'; resolution?: string };
    if (status !== 'dismissed' && status !== 'actioned') { res.status(400).json({ error: 'status must be dismissed|actioned' }); return; }
    const rep = resolveReport(String(req.params.id), status, String(resolution));
    if (!rep) { res.status(404).json({ error: 'report not found' }); return; }
    logEvent({ context: 'report', action: `report_${status}`, targetType: rep.targetType, targetId: rep.targetId, excerpt: resolution, categories: [], matches: [], source: 'admin' });
    res.json({ ok: true, report: rep });
  });

  r.post('/api/moderation/games/:id/unpublish', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'bad id' }); return; }
    const ok = await deps.unpublishGame(id);
    if (!ok) { res.status(404).json({ error: 'game not found' }); return; }
    logEvent({ context: 'game_title', action: 'unpublish', targetType: 'game', targetId: String(id), excerpt: '', categories: [], matches: [], source: 'admin' });
    res.json({ ok: true });
  });

  r.post('/api/moderation/mute', requireAdmin, (req, res) => {
    const { key, minutes } = (req.body ?? {}) as { key?: string; minutes?: number };
    if (!key) { res.status(400).json({ error: 'key required' }); return; }
    const mins = Math.max(0, Math.min(Number(minutes ?? 60), 7 * 24 * 60));
    if (mins === 0) strikes.unmute(key); else strikes.mute(key, mins * 60_000);
    logEvent({ context: 'chat', action: mins ? 'admin_mute' : 'admin_unmute', actorId: key, excerpt: `${mins} min`, categories: [], matches: [], source: 'admin' });
    res.json({ ok: true });
  });

  r.get('/api/moderation/terms', requireAdmin, (_req, res) => res.json({ terms: listCustomTerms() }));

  r.post('/api/moderation/terms', requireAdmin, async (req, res) => {
    const { term, category, severity } = (req.body ?? {}) as { term?: string; category?: Category; severity?: Severity };
    if (!term || term.trim().length < 2 || term.length > 80) { res.status(400).json({ error: 'term must be 2-80 chars' }); return; }
    if (!category || !CATEGORIES.includes(category)) { res.status(400).json({ error: `category must be one of ${CATEGORIES.join(', ')}` }); return; }
    if (!severity || !SEVERITIES.includes(severity)) { res.status(400).json({ error: 'severity must be low|medium|high' }); return; }
    await persistCustomTerm(term, category, severity);
    res.json({ ok: true });
  });

  r.delete('/api/moderation/terms/:term', requireAdmin, async (req, res) => {
    await deleteCustomTerm(String(req.params.term));
    res.json({ ok: true });
  });

  return r;
}
