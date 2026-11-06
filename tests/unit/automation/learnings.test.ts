import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../../src/main/db';
import {
  addLearning,
  deleteLearning,
  domainMatches,
  hostnameOf,
  learningsForUrl,
  listLearnings,
} from '../../../src/main/automation/learnings';

describe('domain learnings — per-domain knowledge (ego-lite site skills)', () => {
  beforeAll(async () => {
    await initDb();
  });
  afterAll(() => {
    closeDb();
  });

  it('matches an exact hostname and a wildcard subdomain, and nothing else', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('example.com', '*.example.com')).toBe(true);
    expect(domainMatches('www.example.com', '*.example.com')).toBe(true);
    // A wildcard must not swallow a lookalike registrable domain.
    expect(domainMatches('notexample.com', '*.example.com')).toBe(false);
    expect(domainMatches('example.com.evil.test', '*.example.com')).toBe(false);
    expect(domainMatches('other.com', 'example.com')).toBe(false);
  });

  it('normalizes case and a trailing dot on both sides', () => {
    expect(domainMatches('EXAMPLE.com.', 'example.COM')).toBe(true);
    expect(domainMatches('example.com', '*.Example.com.')).toBe(true);
  });

  it('extracts a hostname and degrades to empty on garbage', () => {
    expect(hostnameOf('https://Sub.Example.com/path?q=1')).toBe('sub.example.com');
    expect(hostnameOf('not a url')).toBe('');
    expect(hostnameOf('')).toBe('');
  });

  it('returns the notes that match a URL and nothing for an unknown host', () => {
    const created = addLearning('learn.example.com', 'The consent wall eats the first click.');
    addLearning('*.shop.test', 'Prices render only after the currency cookie is set.');

    const hits = learningsForUrl('https://learn.example.com/lesson/1');
    expect(hits.map((l) => l.id)).toContain(created.id);
    expect(hits.every((l) => domainMatches('learn.example.com', l.domainPattern))).toBe(true);

    const sub = learningsForUrl('https://eu.shop.test/cart');
    expect(sub.some((l) => l.domainPattern === '*.shop.test')).toBe(true);

    expect(learningsForUrl('https://unrelated.test/')).toEqual([]);
    expect(learningsForUrl('garbage')).toEqual([]);
  });

  it('refuses an empty pattern or note instead of storing a note that can never match', () => {
    expect(() => addLearning('', 'x')).toThrow(/pattern/);
    expect(() => addLearning('example.com', '   ')).toThrow(/note/);
  });

  it('deletes by id and reports whether anything was removed', () => {
    const l = addLearning('delete.example.com', 'temporary');
    expect(deleteLearning(l.id)).toBe(true);
    expect(deleteLearning(l.id)).toBe(false);
    expect(listLearnings().some((x) => x.id === l.id)).toBe(false);
  });
});
