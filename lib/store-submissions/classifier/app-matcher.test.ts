import { afterEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';

import { matchApp } from './app-matcher';
import type { AppAlias, AppWithAliases } from './types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';

function app(
  id: string,
  name: string,
  aliases: AppAlias[],
): AppWithAliases {
  return {
    id,
    name,
    aliases,
    platform_bindings: [{ platform_id: PLATFORM_ID }],
  };
}

const text = (t: string, st: AppAlias['source_type'] = 'AUTO_CURRENT'): AppAlias => ({
  alias_text: t,
  alias_regex: null,
  source_type: st,
});

const rx = (re: string, st: AppAlias['source_type'] = 'REGEX'): AppAlias => ({
  alias_text: null,
  alias_regex: re,
  source_type: st,
});

afterEach(__resetRe2CacheForTests);

describe('matchApp — text matching', () => {
  it('matches exact (case-insensitive, trimmed) alias_text', () => {
    const apps = [app('a1', 'Skyline Runners', [text('Skyline Runners')])];
    const r = matchApp('  SKYLINE runners  ', apps);
    expect(r?.app_id).toBe('a1');
    expect(r?.matched_alias).toEqual({
      kind: 'text',
      value: 'Skyline Runners',
      source_type: 'AUTO_CURRENT',
    });
  });

  it('returns null for empty / whitespace / null input', () => {
    const apps = [app('a1', 'X', [text('X')])];
    expect(matchApp(null, apps)).toBeNull();
    expect(matchApp('', apps)).toBeNull();
    expect(matchApp('   ', apps)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const apps = [app('a1', 'A', [text('A')])];
    expect(matchApp('Unrelated', apps)).toBeNull();
  });

  it('preserves source_type in trace (AUTO_HISTORICAL alias exposes the old-name link)', () => {
    const apps = [
      app('a1', 'Skyline Runners', [
        text('Skyline Runners'),
        text('Skyline Prime', 'AUTO_HISTORICAL'),
      ]),
    ];
    const r = matchApp('Skyline Prime', apps);
    expect(r?.matched_alias.source_type).toBe('AUTO_HISTORICAL');
  });
});

describe('matchApp — priority: text wins over regex', () => {
  it('returns text match even when a regex alias on a DIFFERENT app also matches', () => {
    // extractedName = "Skyline Runners"
    // appA has text alias "Skyline Runners"
    // appB has regex alias ".+" which also matches
    // Spec §3.3: text wins
    const appA = app('a1', 'App A', [text('Skyline Runners')]);
    const appB = app('a2', 'App B', [rx('^Skyline.+$')]);
    const r = matchApp('Skyline Runners', [appB, appA]); // input order deliberately reversed
    expect(r?.app_id).toBe('a1');
    expect(r?.matched_alias.kind).toBe('text');
  });

  it('falls back to regex only when ALL text aliases miss', () => {
    const appA = app('a1', 'App A', [text('Different')]);
    const appB = app('a2', 'App B', [rx('^Skyline.+$')]);
    const r = matchApp('Skyline Runners', [appA, appB]);
    expect(r?.app_id).toBe('a2');
    expect(r?.matched_alias.kind).toBe('regex');
  });
});

describe('matchApp — regex matching', () => {
  it('matches with anchored regex', () => {
    const apps = [app('a1', 'Quest', [rx('^Puzzle Quest( Saga)?$')])];
    const r = matchApp('Puzzle Quest Saga', apps);
    expect(r?.app_id).toBe('a1');
    expect(r?.matched_alias.value).toBe('^Puzzle Quest( Saga)?$');
  });

  it('first regex alias across apps wins (no specificity scoring)', () => {
    const apps = [
      app('first', 'First', [rx('Sky')]),
      app('second', 'Second', [rx('Skyline')]),
    ];
    const r = matchApp('Skyline Runners', apps);
    expect(r?.app_id).toBe('first');
  });

  it('is case-sensitive by default on regex aliases', () => {
    const apps = [app('a1', 'X', [rx('^Skyline$')])];
    expect(matchApp('skyline', apps)).toBeNull();
    expect(matchApp('Skyline', apps)?.app_id).toBe('a1');
  });

  it('does not catastrophically backtrack on adversarial input (ReDoS guard)', () => {
    const apps = [app('a1', 'X', [rx('(a+)+b')])];
    const adversarial = 'a'.repeat(10_000) + 'X';
    const start = performance.now();
    const r = matchApp(adversarial, apps);
    const elapsed = performance.now() - start;
    expect(r).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });
});
