import { describe, expect, it } from 'vitest';

import type { ExistingAlias } from './alias-logic';
import {
  SLUG_MAX_LENGTH,
  InvalidSlugError,
  deriveAliasChangesOnRename,
  generateSlugFromName,
} from './alias-logic';

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
  it('returns an empty array when old and new names are identical', () => {
    expect(deriveAliasChangesOnRename('Skyline', 'Skyline', [])).toEqual([]);
  });

  it('treats whitespace-only differences as a noop', () => {
    expect(deriveAliasChangesOnRename('Skyline', '  Skyline  ', [])).toEqual([]);
  });

  it('throws when newName is empty', () => {
    expect(() => deriveAliasChangesOnRename('Skyline', '', [])).toThrow();
  });

  it('throws when newName is whitespace-only', () => {
    expect(() => deriveAliasChangesOnRename('Skyline', '   ', [])).toThrow();
  });

  it('demotes the existing AUTO_CURRENT row and inserts a new AUTO_CURRENT', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    expect(changes).toEqual([
      { kind: 'DEMOTE', aliasId: 'a1', previousName: 'Skyline' },
      { kind: 'INSERT', aliasText: 'Skyline Runners', sourceType: 'AUTO_CURRENT' },
    ]);
  });

  it('does not demote MANUAL, REGEX, or AUTO_HISTORICAL aliases', () => {
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
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline 2', aliases);
    const demoted = changes.filter((c) => c.kind === 'DEMOTE');
    expect(demoted).toEqual([{ kind: 'DEMOTE', aliasId: 'a1', previousName: 'Skyline' }]);
  });

  it('defensively demotes multiple AUTO_CURRENT rows (corrupt state)', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'A', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'A', source_type: 'AUTO_CURRENT' }),
    ];
    const changes = deriveAliasChangesOnRename('A', 'B', aliases);
    const demoted = changes.filter((c) => c.kind === 'DEMOTE');
    expect(demoted.map((d) => (d as { aliasId: string }).aliasId).sort()).toEqual(['a1', 'a2']);
    expect(
      demoted.every((d) => (d as { previousName: string }).previousName === 'A'),
    ).toBe(true);
  });

  it('inserts a new AUTO_CURRENT when aliases list is empty', () => {
    const changes = deriveAliasChangesOnRename('A', 'B', []);
    expect(changes).toEqual([
      { kind: 'INSERT', aliasText: 'B', sourceType: 'AUTO_CURRENT' },
    ]);
  });

  it('trims oldName and newName before comparing', () => {
    const changes = deriveAliasChangesOnRename('  Skyline ', 'Skyline Runners', [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
    ]);
    expect(changes).toEqual([
      { kind: 'DEMOTE', aliasId: 'a1', previousName: 'Skyline' },
      { kind: 'INSERT', aliasText: 'Skyline Runners', sourceType: 'AUTO_CURRENT' },
    ]);
  });

  it('PROMOTES an existing MANUAL alias that matches the new name instead of inserting', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'Skyline Runners', source_type: 'MANUAL' }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    expect(changes).toEqual([
      { kind: 'DEMOTE', aliasId: 'a1', previousName: 'Skyline' },
      { kind: 'PROMOTE', aliasId: 'a2' },
    ]);
    expect(changes.some((c) => c.kind === 'INSERT')).toBe(false);
  });

  it('PROMOTES case-insensitively (user typed different case)', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'skyline runners', source_type: 'MANUAL' }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    expect(changes.find((c) => c.kind === 'PROMOTE')).toEqual({
      kind: 'PROMOTE',
      aliasId: 'a2',
    });
  });

  it('PROMOTES an AUTO_HISTORICAL alias when its text matches the new name (re-rename)', () => {
    // Scenario: user renamed Skyline → Skyline Runners (creating AUTO_HISTORICAL
    // "Skyline"), then renamed back to "Skyline". The historical row should be
    // promoted rather than inserting a duplicate.
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline Runners', source_type: 'AUTO_CURRENT' }),
      makeAlias({
        id: 'a2',
        alias_text: 'Skyline',
        source_type: 'AUTO_HISTORICAL',
        previous_name: 'Skyline',
      }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline Runners', 'Skyline', aliases);
    expect(changes).toEqual([
      { kind: 'DEMOTE', aliasId: 'a1', previousName: 'Skyline Runners' },
      { kind: 'PROMOTE', aliasId: 'a2' },
    ]);
  });

  it('does not promote a REGEX alias even if it would match the new name text', () => {
    // REGEX aliases do not carry alias_text; the promotion match is by text only.
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_regex: 'Skyline Runners', source_type: 'REGEX' }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    expect(changes.find((c) => c.kind === 'PROMOTE')).toBeUndefined();
    expect(changes.find((c) => c.kind === 'INSERT')).toBeDefined();
  });

  it('picks the first non-AUTO_CURRENT match when multiple aliases share the new name (corrupt state)', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Skyline', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'Skyline Runners', source_type: 'MANUAL' }),
      makeAlias({ id: 'a3', alias_text: 'Skyline Runners', source_type: 'MANUAL' }),
    ];
    const changes = deriveAliasChangesOnRename('Skyline', 'Skyline Runners', aliases);
    const promote = changes.find((c) => c.kind === 'PROMOTE');
    expect(promote).toEqual({ kind: 'PROMOTE', aliasId: 'a2' });
  });

  it('applies DEMOTEs before the INSERT/PROMOTE so the caller can replay the array in order', () => {
    const aliases: ExistingAlias[] = [
      makeAlias({ id: 'a1', alias_text: 'Old', source_type: 'AUTO_CURRENT' }),
      makeAlias({ id: 'a2', alias_text: 'New', source_type: 'MANUAL' }),
    ];
    const changes = deriveAliasChangesOnRename('Old', 'New', aliases);
    const demoteIdx = changes.findIndex((c) => c.kind === 'DEMOTE');
    const promoteIdx = changes.findIndex((c) => c.kind === 'PROMOTE');
    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(promoteIdx).toBeGreaterThan(demoteIdx);
  });
});
