import { describe, it, expect } from 'vitest';
import { toSetCookieParams } from '../../../src/main/proxy/cookieInjector';

describe('toSetCookieParams', () => {
  it('builds setCookie params from a stored cookie row', () => {
    const params = toSetCookieParams({
      name: 'session_id',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      expires: 1893456789.7,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(params).toMatchObject({
      name: 'session_id',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      expires: 1893456789,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  });

  it('returns null when name or domain is missing', () => {
    expect(toSetCookieParams({ value: 'x', domain: '.a.com' })).toBeNull();
    expect(toSetCookieParams({ name: 'n', value: 'x' })).toBeNull();
    expect(toSetCookieParams({})).toBeNull();
  });

  it('drops unknown sameSite values instead of failing', () => {
    const params = toSetCookieParams({ name: 'n', value: 'v', domain: '.a.com', sameSite: 'weird' });
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty('sameSite');
  });

  it('drops non-positive expires instead of failing', () => {
    const params = toSetCookieParams({ name: 'n', value: 'v', domain: '.a.com', expires: -5 });
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty('expires');
  });

  it('stringifies non-string values', () => {
    const params = toSetCookieParams({ name: 'n', value: 42, domain: '.a.com' });
    expect(params?.value).toBe('42');
  });

  it('returns null when cookie value is empty or whitespace, preventing session clobbering', () => {
    expect(toSetCookieParams({ name: 'session_id', value: '', domain: '.a.com' })).toBeNull();
    expect(toSetCookieParams({ name: 'session_id', value: '   ', domain: '.a.com' })).toBeNull();
  });
});
