import { beforeEach, describe, expect, it } from 'vitest';

import { __resetRe2CacheForTests } from '../regex/re2';
import type { ExistingAlias } from './alias-logic';
import { detectAliasConflicts } from './alias-conflicts';

beforeEach(() => {
  __resetRe2CacheForTests();
});

const makeAlias = (overrides: Partial<ExistingAlias> & { id: string }): ExistingAlias => ({
  id: overrides.id,
  alias_text: overrides.alias_text,
  alias_regex: overrides.alias_regex,
  source_type: overrides.source_type ?? 'AUTO_CURRENT',
  previous_name: overrides.previous_name,
});

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
