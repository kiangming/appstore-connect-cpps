import { beforeEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';
import type { ExistingAlias } from './alias-logic';
import {
  SLUG_MAX_LENGTH,
  InvalidSlugError,
  deriveAliasChangesOnRename,
  detectAliasConflicts,
  generateSlugFromName,
} from './alias-logic';

beforeEach(() => {
  __resetRe2CacheForTests();
});

describe('generateSlugFromName — ASCII', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(generateSlugFromName('Skyline Runners')).toBe('skyline-runners');
  });

  it('collapses multiple consecutive spaces', () => {
    expect(generateSlugFromName('Tap  Tap   Empire')).toBe('tap-tap-empire');
  });

  it('strips punctuation and symbols', () => {
    expect(generateSlugFromName('Dragon Guild: Fantasy Wars!')).toBe(
      'dragon-guild-fantasy-wars',
    );
  });

  it('trims leading and trailing hyphens from punctuation at edges', () => {
    expect(generateSlugFromName('!Puzzle Quest!')).toBe('puzzle-quest');
  });

  it('preserves digits', () => {
    expect(generateSlugFromName('Realm Defenders 2')).toBe('realm-defenders-2');
  });
});

describe('generateSlugFromName — Vietnamese', () => {
  it('strips diacritics from vowels', () => {
    expect(generateSlugFromName('Cá Sấu Đỏ')).toBe('ca-sau-do');
  });

  it('handles uppercase Vietnamese', () => {
    expect(generateSlugFromName('ĐẶNG QUANG')).toBe('dang-quang');
  });

  it('handles mixed-case đ/Đ', () => {
    expect(generateSlugFromName('Đội Đỏ và đen')).toBe('doi-do-va-den');
  });

  it('handles combined Vietnamese tone marks', () => {
    // Tiếng, Việt have multiple combining marks per letter
    expect(generateSlugFromName('Tiếng Việt')).toBe('tieng-viet');
  });

  it('handles non-Latin diacritic scripts (French/Spanish) for completeness', () => {
    expect(generateSlugFromName('Café Español')).toBe('cafe-espanol');
  });
});

describe('generateSlugFromName — truncation', () => {
  it('truncates to SLUG_MAX_LENGTH characters', () => {
    const long = 'a'.repeat(60);
    const slug = generateSlugFromName(long);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug).toBe('a'.repeat(SLUG_MAX_LENGTH));
  });

  it('re-trims trailing hyphens after slice ends on a separator', () => {
    // 'abcd efgh ijkl mnop qrst uvwx yzab cdef ghij ' — slicing at 50 might end on a hyphen
    const name = 'ab cd ef gh ij kl mn op qr st uv wx yz ab cd ef gh ij';
    const slug = generateSlugFromName(name);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });
});

describe('generateSlugFromName — error cases', () => {
  it('throws InvalidSlugError on empty string', () => {
    expect(() => generateSlugFromName('')).toThrow(InvalidSlugError);
  });

  it('throws InvalidSlugError on whitespace-only', () => {
    expect(() => generateSlugFromName('   \t\n ')).toThrow(InvalidSlugError);
  });

  it('throws InvalidSlugError when only punctuation remains', () => {
    try {
      generateSlugFromName('!!!???');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSlugError);
      const e = err as InvalidSlugError;
      expect(e.input).toBe('!!!???');
      expect(e.reason).toContain('no ASCII alphanumerics');
      expect(e.name).toBe('InvalidSlugError');
    }
  });

  it('throws InvalidSlugError when only non-Latin diacritics remain with no base letters', () => {
    // A standalone combining mark (unlikely from real input but defensive)
    expect(() => generateSlugFromName('\u0301\u0302')).toThrow(InvalidSlugError);
  });

  it('throws InvalidSlugError for non-string input', () => {
    // @ts-expect-error — runtime guard for misuse
    expect(() => generateSlugFromName(null)).toThrow(InvalidSlugError);
  });
});

// -- Rename plan -----------------------------------------------------------

const makeAlias = (overrides: Partial<ExistingAlias> & { id: string }): ExistingAlias => ({
  id: overrides.id,
  alias_text: overrides.alias_text,
  alias_regex: overrides.alias_regex,
  source_type: overrides.source_type ?? 'AUTO_CURRENT',
  previous_name: overrides.previous_name,
});

describe('deriveAliasChangesOnRename', () => {
  it('returns noop when old and new names are identical', () => {
    const plan = deriveAliasChangesOnRename('Skyline', 'Skyline', []);
    expect(plan.kind).toBe('noop');
  });

  it('treats whitespace-only differences as noop', () => {
    const plan = deriveAliasChangesOnRename('Skyline', '  Skyline  ', []);
    expect(plan.kind).toBe('noop');
  });

  it('throws when newName is empty', () => {
    expect(() => deriveAliasChangesOnRename('Skyline', '', [])).toThrow();
  });

  it('throws when newName is whitespace-only', () => {
    expect(() => deriveAliasChangesOnRename('Skyline', '   ', [])).toThrow();
  });

  it('demotes the existing AUTO_CURRENT row and adds a new one', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
    ];
    const plan = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    expect(plan.kind).toBe('rename');
    if (plan.kind !== 'rename') throw new Error('unreachable');
    expect(plan.demote).toEqual([{ id: 'a1', previous_name: 'Skyline' }]);
    expect(plan.add).toEqual({ alias_text: 'Skyline Runners', source_type: 'AUTO_CURRENT' });
  });

  it('ignores MANUAL, REGEX, and AUTO_HISTORICAL aliases', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'SKY', source_type: 'MANUAL' }),
      makeAlias({ id: 'a3', alias_regex: 'Skyline.*', source_type: 'REGEX' }),
      makeAlias({
        id: 'a4',
        alias_text: 'Old Name',
        source_type: 'AUTO_HISTORICAL',
        previous_name: 'Old Name',
      }),
    ];
    const plan = deriveAliasChangesOnRename('Skyline', 'Skyline 2', aliases);
    if (plan.kind !== 'rename') throw new Error('unreachable');
    expect(plan.demote).toHaveLength(1);
    expect(plan.demote[0].id).toBe('a1');
  });

  it('defensively demotes multiple AUTO_CURRENT rows (corrupt state)', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'A', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'A', source_type: 'AUTO_CURRENT' }),
    ];
    const plan = deriveAliasChangesOnRename('A', 'B', aliases);
    if (plan.kind !== 'rename') throw new Error('unreachable');
    expect(plan.demote.map((d) => d.id).sort()).toEqual(['a1', 'a2']);
    expect(plan.demote.every((d) => d.previous_name === 'A')).toBe(true);
  });

  it('handles empty aliases list (nothing to demote, still adds new)', () => {
    const plan = deriveAliasChangesOnRename('A', 'B', []);
    if (plan.kind !== 'rename') throw new Error('unreachable');
    expect(plan.demote).toEqual([]);
    expect(plan.add.alias_text).toBe('B');
  });

  it('trims oldName and newName before comparing', () => {
    const plan = deriveAliasChangesOnRename('  Skyline ', 'Skyline Runners', [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
    ]);
    if (plan.kind !== 'rename') throw new Error('unreachable');
    expect(plan.demote[0].previous_name).toBe('Skyline');
    expect(plan.add.alias_text).toBe('Skyline Runners');
  });
});

// -- Conflict detection ----------------------------------------------------

describe('detectAliasConflicts', () => {
  it('returns [] when existingAliases is empty', () => {
    expect(detectAliasConflicts({ alias_text: 'X', source_type: 'MANUAL' }, [])).toEqual([]);
  });

  it('detects a case-insensitive duplicate text alias', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'MANUAL' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: 'SKYLINE', source_type: 'MANUAL' },
      existing,
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('duplicate_text');
    expect(result[0].against.id).toBe('a1');
  });

  it('trims whitespace in duplicate detection', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'MANUAL' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: '  skyline  ', source_type: 'MANUAL' },
      existing,
    );
    expect(result).toHaveLength(1);
  });

  it('detects when an existing regex already matches the new text alias', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_regex: 'Skyline.*', source_type: 'REGEX' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: 'Skyline Runners', source_type: 'MANUAL' },
      existing,
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('existing_regex_covers_new_text');
  });

  it('detects when the new regex covers an existing text alias', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline Runners', source_type: 'MANUAL' }),
    ];
    const result = detectAliasConflicts(
      { alias_regex: 'Skyline.*', source_type: 'REGEX' },
      existing,
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('new_regex_covers_existing_text');
  });

  it('returns empty when text aliases do not overlap', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Dragon', source_type: 'MANUAL' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: 'Skyline', source_type: 'MANUAL' },
      existing,
    );
    expect(result).toEqual([]);
  });

  it('returns empty when an existing regex does not match the new text', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_regex: '^Dragon.*', source_type: 'REGEX' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: 'Skyline', source_type: 'MANUAL' },
      existing,
    );
    expect(result).toEqual([]);
  });

  it('does not compare regex-vs-regex (intentionally skipped)', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_regex: 'Skyline.*', source_type: 'REGEX' }),
    ];
    const result = detectAliasConflicts(
      { alias_regex: 'Sky.*', source_type: 'REGEX' },
      existing,
    );
    expect(result).toEqual([]);
  });

  it('records one conflict per existing alias it hits', () => {
    const existing: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_regex: 'Skyline.*', source_type: 'REGEX' }),
    ];
    const result = detectAliasConflicts(
      { alias_text: 'Skyline', source_type: 'MANUAL' },
      existing,
    );
    // One duplicate_text (vs a1) + one existing_regex_covers_new_text (vs a2)
    expect(result).toHaveLength(2);
    const types = result.map((c) => c.type).sort();
    expect(types).toEqual(['duplicate_text', 'existing_regex_covers_new_text']);
  });
});
