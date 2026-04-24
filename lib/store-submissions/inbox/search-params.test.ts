import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTicketsQueryFromSearchParams } from './search-params';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTicketsQueryFromSearchParams', () => {
  it('returns defaults on empty input', () => {
    const q = parseTicketsQueryFromSearchParams({});
    expect(q.sort).toBe('opened_at_desc');
    expect(q.limit).toBe(50);
    expect(q.state).toBeUndefined();
    expect(q.bucket).toBeUndefined();
  });

  it('parses single state value', () => {
    const q = parseTicketsQueryFromSearchParams({ state: 'NEW' });
    expect(q.state).toBe('NEW');
  });

  it('parses state as array (Open-tab pattern)', () => {
    const q = parseTicketsQueryFromSearchParams({
      state: ['NEW', 'IN_REVIEW', 'REJECTED'],
    });
    expect(q.state).toEqual(['NEW', 'IN_REVIEW', 'REJECTED']);
  });

  it('coerces limit from string', () => {
    const q = parseTicketsQueryFromSearchParams({ limit: '25' });
    expect(q.limit).toBe(25);
  });

  it('falls back to defaults on invalid state enum', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = parseTicketsQueryFromSearchParams({ state: 'NOT_A_STATE' });
    // Whole-shape rejection → empty defaults.
    expect(q.state).toBeUndefined();
    expect(q.sort).toBe('opened_at_desc');
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to defaults on malformed cursor length', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Cursor > 500 chars violates max()
    const huge = 'x'.repeat(501);
    const q = parseTicketsQueryFromSearchParams({ cursor: huge });
    expect(q.cursor).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('takes first value when non-array fields arrive as arrays', () => {
    // e.g. ?sort=priority_desc&sort=opened_at_desc — take first.
    const q = parseTicketsQueryFromSearchParams({
      sort: ['priority_desc', 'opened_at_desc'],
    });
    expect(q.sort).toBe('priority_desc');
  });

  it('accepts bucket + platform_key + search combined', () => {
    const q = parseTicketsQueryFromSearchParams({
      bucket: 'unclassified_app',
      platform_key: 'apple',
      search: 'TK-12',
    });
    expect(q.bucket).toBe('unclassified_app');
    expect(q.platform_key).toBe('apple');
    expect(q.search).toBe('TK-12');
  });
});
