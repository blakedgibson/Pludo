// store.ts — enforcement state + audit trail.
//
//  • StrikeTracker     escalating auto-mutes for repeat offenders
//  • DuplicateTracker  repeated-message spam in chat
//  • logEvent()        every reject/flag → ring buffer + Supabase moderation_events
//  • reports           user reports → content_reports (with verified snapshots)
//  • custom terms      admin-managed lexicon additions → moderation_terms
//
// Supabase writes are best-effort (service-role key) so moderation keeps
// working when the DB is down or migration 016 isn't applied yet; the
// in-memory buffers still feed the admin queue for this server's lifetime.

import { randomUUID } from 'crypto';
import type { Severity, Category } from './lexicon.js';
import { addCustomTerm, removeCustomTerm } from './lexicon.js';
import type { ModerationContext, Violation } from './engine.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

async function sb(path: string, init: RequestInit): Promise<unknown | null> {
  if (!SUPABASE_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      if (r.status !== 404) console.warn(`[moderation] supabase ${init.method ?? 'GET'} ${path.split('?')[0]} → ${r.status}`);
      return null;
    }
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  } catch (e) {
    console.warn(`[moderation] supabase error: ${(e as Error).message}`);
    return null;
  }
}

// ── Strikes / auto-mute ──────────────────────────────────────────────────────

const STRIKE_WINDOW_MS = 10 * 60_000;
const STRIKES_TO_MUTE  = 3;
const BASE_MUTE_MS     = 60_000;
const MAX_MUTE_MS      = 60 * 60_000;

export class StrikeTracker {
  private strikes = new Map<string, number[]>();
  private mutes = new Map<string, { until: number; count: number }>();

  /** Records a violation. high-severity counts as two strikes. */
  record(key: string, severity: Severity, now = Date.now()): { strikes: number; mutedUntil: number } {
    const list = (this.strikes.get(key) ?? []).filter(t => now - t < STRIKE_WINDOW_MS);
    list.push(now);
    if (severity === 'high') list.push(now);
    this.strikes.set(key, list);
    if (list.length >= STRIKES_TO_MUTE) {
      const prev = this.mutes.get(key);
      const count = (prev?.count ?? 0) + 1;
      const until = now + Math.min(BASE_MUTE_MS * 2 ** (count - 1), MAX_MUTE_MS);
      this.mutes.set(key, { until, count });
      this.strikes.set(key, []);
      return { strikes: list.length, mutedUntil: until };
    }
    return { strikes: list.length, mutedUntil: 0 };
  }

  /** Remaining mute in ms (0 if not muted). */
  mutedFor(key: string, now = Date.now()): number {
    const m = this.mutes.get(key);
    return m && m.until > now ? m.until - now : 0;
  }

  mute(key: string, ms: number, now = Date.now()) {
    const prev = this.mutes.get(key);
    this.mutes.set(key, { until: now + ms, count: (prev?.count ?? 0) + 1 });
  }

  unmute(key: string) { const m = this.mutes.get(key); if (m) m.until = 0; }

  prune(now = Date.now()) {
    for (const [k, v] of this.strikes) if (!v.some(t => now - t < STRIKE_WINDOW_MS)) this.strikes.delete(k);
    // Keep mute history (escalation count) for 24h after expiry.
    for (const [k, v] of this.mutes) if (now - v.until > 24 * 60 * 60_000) this.mutes.delete(k);
  }
}

// ── Duplicate / repeated-message spam ────────────────────────────────────────

const DUP_WINDOW_MS = 30_000;
const DUP_MAX       = 2;   // 3rd identical message within the window is rejected

export class DuplicateTracker {
  private recent = new Map<string, Array<{ text: string; at: number }>>();
  isRepeat(key: string, text: string, now = Date.now()): boolean {
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const list = (this.recent.get(key) ?? []).filter(e => now - e.at < DUP_WINDOW_MS);
    const same = list.filter(e => e.text === norm).length;
    list.push({ text: norm, at: now });
    this.recent.set(key, list.slice(-10));
    return same >= DUP_MAX;
  }
  prune(now = Date.now()) {
    for (const [k, v] of this.recent) if (!v.some(e => now - e.at < DUP_WINDOW_MS)) this.recent.delete(k);
  }
}

export const strikes = new StrikeTracker();
export const duplicates = new DuplicateTracker();
setInterval(() => { strikes.prune(); duplicates.prune(); }, 5 * 60_000).unref();

// ── Audit events ─────────────────────────────────────────────────────────────

export interface ModerationEvent {
  id: string;
  at: string;
  context: ModerationContext | 'image' | 'report';
  action: string;
  actorId?: string;          // user id, or `ip:<addr>` / client id when anonymous
  actorName?: string;
  targetType?: string;
  targetId?: string;
  excerpt: string;           // truncated offending text (or image URL)
  categories: Category[];
  matches: string[];
  source: 'lexicon' | 'ai' | 'strike' | 'admin';
}

const EVENT_BUFFER = 1000;
const events: ModerationEvent[] = [];

export function logEvent(e: Omit<ModerationEvent, 'id' | 'at'> & { violations?: Violation[] }): ModerationEvent {
  const { violations, ...rest } = e;
  const ev: ModerationEvent = {
    id: randomUUID(), at: new Date().toISOString(), ...rest,
    excerpt: rest.excerpt.slice(0, 300),
    categories: [...new Set([...(rest.categories ?? []), ...(violations ?? []).map(v => v.category)])],
    matches: [...new Set([...(rest.matches ?? []), ...(violations ?? []).map(v => v.match ?? '').filter(Boolean)])],
  };
  events.push(ev);
  if (events.length > EVENT_BUFFER) events.splice(0, events.length - EVENT_BUFFER);
  console.warn(`[moderation] ${ev.action} ${ev.context} actor=${ev.actorName ?? ev.actorId ?? '?'} cats=${ev.categories.join(',')}`);
  void sb('moderation_events', {
    method: 'POST',
    body: JSON.stringify({
      id: ev.id, context: ev.context, action: ev.action, actor_id: ev.actorId ?? null,
      actor_name: ev.actorName ?? null, target_type: ev.targetType ?? null, target_id: ev.targetId ?? null,
      excerpt: ev.excerpt, categories: ev.categories, matches: ev.matches, source: ev.source,
    }),
  });
  return ev;
}

export function recentEvents(limit = 200): ModerationEvent[] {
  return events.slice(-limit).reverse();
}

// ── User reports ─────────────────────────────────────────────────────────────

export type ReportTarget = 'user' | 'game' | 'chat' | 'comment' | 'avatar_item' | 'asset';
export const REPORT_REASONS = [
  'harassment', 'hate', 'sexual', 'self_harm', 'violence', 'scam', 'personal_info',
  'inappropriate_name', 'inappropriate_game', 'inappropriate_model', 'cheating', 'other',
] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export interface Report {
  id: string;
  createdAt: string;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  details: string;
  snapshot: string;          // server-verified copy of the reported content when available
  verified: boolean;         // true when `snapshot` came from server state, not the client
  status: 'open' | 'dismissed' | 'actioned';
  resolution?: string;
  priority: number;          // 1 (urgent) … 3
}

const reports = new Map<string, Report>();
const reportRate = new Map<string, number[]>();

const URGENT: ReportReason[] = ['self_harm', 'sexual', 'personal_info', 'violence'];

export function reportAllowed(reporterId: string, now = Date.now()): boolean {
  const list = (reportRate.get(reporterId) ?? []).filter(t => now - t < 60 * 60_000);
  if (list.length >= 20) return false;
  list.push(now); reportRate.set(reporterId, list);
  return true;
}

export function createReport(r: Omit<Report, 'id' | 'createdAt' | 'status' | 'priority'>): Report {
  const dup = [...reports.values()].find(x =>
    x.status === 'open' && x.reporterId === r.reporterId && x.targetType === r.targetType && x.targetId === r.targetId);
  if (dup) return dup;
  // Priority: urgent reasons, or targets reported by 3+ distinct users.
  const others = new Set([...reports.values()]
    .filter(x => x.status === 'open' && x.targetType === r.targetType && x.targetId === r.targetId)
    .map(x => x.reporterId));
  const priority = URGENT.includes(r.reason) ? 1 : others.size >= 2 ? 1 : others.size >= 1 ? 2 : 3;
  const report: Report = { ...r, id: randomUUID(), createdAt: new Date().toISOString(), status: 'open', priority };
  reports.set(report.id, report);
  void sb('content_reports', {
    method: 'POST',
    body: JSON.stringify({
      id: report.id, reporter_id: report.reporterId, target_type: report.targetType, target_id: report.targetId,
      reason: report.reason, details: report.details, snapshot: report.snapshot, verified: report.verified,
      status: report.status, priority: report.priority,
    }),
  });
  return report;
}

export function listReports(status: Report['status'] | 'all' = 'open'): Report[] {
  return [...reports.values()]
    .filter(r => status === 'all' || r.status === status)
    .sort((a, b) => a.priority - b.priority || b.createdAt.localeCompare(a.createdAt));
}

export function resolveReport(id: string, status: 'dismissed' | 'actioned', resolution: string): Report | null {
  const r = reports.get(id);
  if (!r) return null;
  r.status = status; r.resolution = resolution.slice(0, 500);
  void sb(`content_reports?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, resolution: r.resolution, resolved_at: new Date().toISOString() }),
  });
  return r;
}

export function getReport(id: string): Report | undefined { return reports.get(id); }

/** Loads open reports + custom terms from Supabase at startup. */
export async function loadModerationState(): Promise<void> {
  const rows = await sb('content_reports?status=eq.open&order=created_at.desc&limit=500', { method: 'GET' }) as Array<Record<string, unknown>> | null;
  for (const row of rows ?? []) {
    reports.set(String(row.id), {
      id: String(row.id), createdAt: String(row.created_at), reporterId: String(row.reporter_id),
      targetType: row.target_type as ReportTarget, targetId: String(row.target_id), reason: row.reason as ReportReason,
      details: String(row.details ?? ''), snapshot: String(row.snapshot ?? ''), verified: !!row.verified,
      status: 'open', priority: Number(row.priority ?? 3),
    });
  }
  const terms = await sb('moderation_terms?select=term,category,severity', { method: 'GET' }) as Array<{ term: string; category: Category; severity: Severity }> | null;
  for (const t of terms ?? []) addCustomTerm(t.term, t.category, t.severity);
  if (rows || terms) console.log(`[moderation] loaded ${rows?.length ?? 0} open reports, ${terms?.length ?? 0} custom terms`);
}

export async function persistCustomTerm(term: string, category: Category, severity: Severity): Promise<void> {
  addCustomTerm(term, category, severity);
  await sb('moderation_terms', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ term: term.toLowerCase().trim(), category, severity }),
  });
}

export async function deleteCustomTerm(term: string): Promise<void> {
  removeCustomTerm(term);
  await sb(`moderation_terms?term=eq.${encodeURIComponent(term.toLowerCase().trim())}`, { method: 'DELETE' });
}
