import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CSV_MAX_ROWS, parseAppRegistryCsv } from './parser';

const TEMPLATE_PATH = resolve(__dirname, '../../../templates/app-registry-template.csv');

describe('parseAppRegistryCsv — template integration', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');

  it('parses the shipped template without any errors', () => {
    const r = parseAppRegistryCsv(template);
    expect(r.fatal).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.valid.length).toBeGreaterThan(0);
  });

  it('explodes pipe-separated aliases on the first row', () => {
    const r = parseAppRegistryCsv(template);
    const first = r.valid[0];
    expect(first.data.name).toBe('Skyline Runners');
    expect(first.data.aliases).toEqual(['Skyline', 'Skyline Runners: Endless']);
  });

  it('parses the inactive app (Legacy Heroes) with active=false', () => {
    const r = parseAppRegistryCsv(template);
    const legacy = r.valid.find((row) => row.data.name === 'Legacy Heroes');
    expect(legacy).toBeDefined();
    expect(legacy?.data.active).toBe(false);
  });
});

describe('parseAppRegistryCsv — fatal errors', () => {
  it('rejects empty input', () => {
    const r = parseAppRegistryCsv('');
    expect(r.fatal).toBe('CSV is empty');
  });

  it('rejects whitespace-only input', () => {
    const r = parseAppRegistryCsv('   \n\n  ');
    expect(r.fatal).toBe('CSV is empty');
  });

  it('rejects input missing the `name` header', () => {
    const r = parseAppRegistryCsv('foo,active\nbar,true\n');
    expect(r.fatal).toContain('name');
  });

  it('rejects input missing the `active` header', () => {
    const r = parseAppRegistryCsv('name,display_name\nX,Y\n');
    expect(r.fatal).toContain('active');
  });

  it('rejects input exceeding CSV_MAX_ROWS', () => {
    const header = 'name,active\n';
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `app${i},true`).join('\n');
    const r = parseAppRegistryCsv(header + rows);
    expect(r.fatal).toContain('Too many rows');
  });
});

describe('parseAppRegistryCsv — row-level errors', () => {
  it('reports invalid email and keeps other rows valid', () => {
    const csv = [
      'name,team_owner_email,active',
      'Good App,linh@company.com,true',
      'Bad App,not-an-email,true',
    ].join('\n');
    const r = parseAppRegistryCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].data.name).toBe('Good App');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].rowNumber).toBe(2);
    expect(r.errors[0].errors.some((e) => e.path === 'team_owner_email')).toBe(true);
  });

  it('reports missing required name field', () => {
    const csv = 'name,active\n,true\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.valid).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].rowNumber).toBe(1);
    expect(r.errors[0].errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('attaches the raw row to each error for UI rendering', () => {
    const csv = 'name,active\nX,maybe\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].raw).toEqual({ name: 'X', active: 'maybe' });
  });

  it('collects multiple errors from a single row', () => {
    const csv = 'name,team_owner_email,active\n,not-an-email,maybe\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseAppRegistryCsv — edge cases', () => {
  it('handles quoted commas inside display_name', () => {
    const csv = [
      'name,display_name,active',
      '"Dragon Guild","Dragon Guild: Fantasy Wars, Season 2",true',
    ].join('\n');
    const r = parseAppRegistryCsv(csv);
    expect(r.fatal).toBeUndefined();
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].data.display_name).toBe('Dragon Guild: Fantasy Wars, Season 2');
  });

  it('handles escaped quotes inside a field', () => {
    const csv = [
      'name,display_name,active',
      '"Quoted","Say ""Hello""",true',
    ].join('\n');
    const r = parseAppRegistryCsv(csv);
    expect(r.valid[0].data.display_name).toBe('Say "Hello"');
  });

  it('is case-insensitive on headers', () => {
    const csv = 'Name,Active\nX,true\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.fatal).toBeUndefined();
    expect(r.valid).toHaveLength(1);
  });

  it('skips trailing empty rows via papaparse greedy mode', () => {
    const csv = 'name,active\nApp,true\n,\n,\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
  });

  it('numbers rows relative to data, not file lines', () => {
    const csv = 'name,active\nA,true\nB,nope\nC,true\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.valid).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].rowNumber).toBe(2);
  });

  it('preserves alias pipe-split ordering', () => {
    const csv = 'name,aliases,active\nX,B|A|C,true\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.valid[0].data.aliases).toEqual(['B', 'A', 'C']);
  });

  it('allows ignoring unknown columns', () => {
    const csv = 'name,active,legacy_field\nX,true,ignored\n';
    const r = parseAppRegistryCsv(csv);
    expect(r.valid).toHaveLength(1);
    expect(r.fatal).toBeUndefined();
  });
});
