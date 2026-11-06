/**
 * Per-domain learnings (borrowed from ego-lite `src/learning/`).
 *
 * Ego stores a directory per site with a manifest of domains, markdown notes
 * and per-site JS tools. Only the notes carry over here: our agents already
 * have the round API, so a stored *tool* would duplicate it, while a stored
 * *fact* ("the login button lives in the shadow root under #app", "the consent
 * wall eats the first click") saves rediscovery every session.
 *
 * Matching mirrors ego's `domainMatches`: an exact hostname, or `*.example.com`
 * for any subdomain. No regex: a stored pattern is user data and must not be
 * able to become a code path.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface DomainLearning {
  id: string;
  domainPattern: string;
  note: string;
  createdAt: number;
}

interface LearningRow {
  id: string;
  domain_pattern: string;
  note: string;
  created_at: number;
}

/** True when `hostname` matches a stored pattern (`example.com` or `*.example.com`). */
export function domainMatches(hostname: string, pattern: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const normalized = String(pattern || '').toLowerCase().replace(/\.$/, '');
  if (!host || !normalized) return false;
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalized;
}

/** Extracts the hostname from a URL, or '' when it is not parseable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function toLearning(row: LearningRow): DomainLearning {
  return {
    id: row.id,
    domainPattern: row.domain_pattern,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function listLearnings(): DomainLearning[] {
  const stmt = getDb().prepare(
    'SELECT id, domain_pattern, note, created_at FROM domain_learnings ORDER BY created_at DESC'
  );
  // SAFETY: the SELECT projection matches LearningRow field-for-field; sql.js
  // rows are untyped, so the assertion records that correspondence.
  const rows: LearningRow[] = stmt.all() as unknown as LearningRow[];
  return rows.map(toLearning);
}

/** Notes whose pattern matches `url`'s hostname, newest first. */
export function learningsForUrl(url: string): DomainLearning[] {
  const host = hostnameOf(url);
  if (!host) return [];
  return listLearnings().filter((l) => domainMatches(host, l.domainPattern));
}

export function addLearning(domainPattern: string, note: string): DomainLearning {
  const pattern = String(domainPattern || '').trim();
  const text = String(note || '').trim();
  if (!pattern) throw new Error('domain pattern is required');
  if (!text) throw new Error('note is required');
  const created: DomainLearning = {
    id: `lrn_${randomUUID()}`,
    domainPattern: pattern,
    note: text,
    createdAt: Date.now(),
  };
  getDb()
    .prepare('INSERT INTO domain_learnings (id, domain_pattern, note, created_at) VALUES (?, ?, ?, ?)')
    .run(created.id, created.domainPattern, created.note, created.createdAt);
  return created;
}

export function deleteLearning(id: string): boolean {
  const res = getDb().prepare('DELETE FROM domain_learnings WHERE id = ?').run(id);
  return res.changes > 0;
}
