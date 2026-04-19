import { describe, expect, it } from 'vitest';

import {
  aliasSchema,
  createAppSchema,
  csvRowSchema,
  platformBindingInputSchema,
  slugSchema,
  updateAppSchema,
} from './app';

describe('slugSchema', () => {
  it.each([
    ['dragon-guild'],
    ['ca-sau-do'],
    ['skyline-runners-2'],
    ['a'],
    ['a1'],
    ['a-b-c'],
  ])('accepts %p', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    [''],
    ['Dragon-Guild'], // uppercase
    ['dragon_guild'], // underscore
    ['-dragon'], // leading hyphen
    ['dragon-'], // trailing hyphen
    ['dragon--guild'], // double hyphen
    ['dragon guild'], // space
    ['a'.repeat(51)], // too long
  ])('rejects %p', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });
});

describe('platformBindingInputSchema', () => {
  it('accepts a minimal binding', () => {
    const r = platformBindingInputSchema.safeParse({ platform: 'apple' });
    expect(r.success).toBe(true);
  });

  it('accepts a full binding', () => {
    const r = platformBindingInputSchema.safeParse({
      platform: 'google',
      platform_ref: 'com.studio.skylinerunners',
      console_url: 'https://play.google.com/console/u/0/app/123',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown platform key', () => {
    const r = platformBindingInputSchema.safeParse({ platform: 'nintendo' });
    expect(r.success).toBe(false);
  });

  it('rejects malformed console_url', () => {
    const r = platformBindingInputSchema.safeParse({
      platform: 'apple',
      console_url: 'not a url',
    });
    expect(r.success).toBe(false);
  });
});

describe('aliasSchema — XOR invariant', () => {
  it('accepts alias_text alone', () => {
    const r = aliasSchema.safeParse({ alias_text: 'Skyline', source_type: 'MANUAL' });
    expect(r.success).toBe(true);
  });

  it('accepts alias_regex alone', () => {
    const r = aliasSchema.safeParse({ alias_regex: 'Skyline.*', source_type: 'REGEX' });
    expect(r.success).toBe(true);
  });

  it('rejects both alias_text and alias_regex set', () => {
    const r = aliasSchema.safeParse({
      alias_text: 'Skyline',
      alias_regex: 'Skyline.*',
      source_type: 'MANUAL',
    });
    expect(r.success).toBe(false);
  });

  it('rejects neither set', () => {
    const r = aliasSchema.safeParse({ source_type: 'MANUAL' });
    expect(r.success).toBe(false);
  });
});

describe('aliasSchema — source_type rules', () => {
  it('requires previous_name when AUTO_HISTORICAL', () => {
    const r = aliasSchema.safeParse({ alias_text: 'OldName', source_type: 'AUTO_HISTORICAL' });
    expect(r.success).toBe(false);
  });

  it('accepts AUTO_HISTORICAL with previous_name', () => {
    const r = aliasSchema.safeParse({
      alias_text: 'OldName',
      source_type: 'AUTO_HISTORICAL',
      previous_name: 'OldName',
    });
    expect(r.success).toBe(true);
  });

  it('rejects REGEX source_type with only alias_text', () => {
    const r = aliasSchema.safeParse({ alias_text: 'Skyline', source_type: 'REGEX' });
    expect(r.success).toBe(false);
  });

  it('accepts AUTO_CURRENT with alias_text', () => {
    const r = aliasSchema.safeParse({ alias_text: 'Skyline Runners', source_type: 'AUTO_CURRENT' });
    expect(r.success).toBe(true);
  });
});

describe('aliasSchema — alias_regex validation', () => {
  it('rejects a permissive .* regex', () => {
    const r = aliasSchema.safeParse({ alias_regex: '.*', source_type: 'REGEX' });
    expect(r.success).toBe(false);
  });

  it('rejects an uncompilable regex', () => {
    const r = aliasSchema.safeParse({ alias_regex: '(unclosed', source_type: 'REGEX' });
    expect(r.success).toBe(false);
  });

  it('accepts a reasonable prefix regex', () => {
    const r = aliasSchema.safeParse({ alias_regex: 'Skyline.*', source_type: 'REGEX' });
    expect(r.success).toBe(true);
  });
});

describe('createAppSchema', () => {
  it('accepts a minimal input and defaults active/platform_bindings', () => {
    const r = createAppSchema.safeParse({ name: 'Skyline Runners', slug: 'skyline-runners' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.active).toBe(true);
      expect(r.data.platform_bindings).toEqual([]);
    }
  });

  it('accepts a full input with platform bindings', () => {
    const r = createAppSchema.safeParse({
      name: 'Dragon Guild',
      display_name: 'Dragon Guild: Fantasy Wars',
      slug: 'dragon-guild',
      team_owner_id: '11111111-1111-4111-8111-111111111111',
      active: true,
      platform_bindings: [
        { platform: 'apple', platform_ref: 'com.studio.dragonguild' },
        { platform: 'huawei', platform_ref: '107892345' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(createAppSchema.safeParse({ name: '', slug: 'x' }).success).toBe(false);
  });

  it('rejects malformed slug', () => {
    expect(createAppSchema.safeParse({ name: 'X', slug: 'Bad Slug' }).success).toBe(false);
  });

  it('rejects non-uuid team_owner_id', () => {
    const r = createAppSchema.safeParse({
      name: 'X',
      slug: 'x',
      team_owner_id: 'not-a-uuid',
    });
    expect(r.success).toBe(false);
  });

  it('accepts null team_owner_id', () => {
    const r = createAppSchema.safeParse({ name: 'X', slug: 'x', team_owner_id: null });
    expect(r.success).toBe(true);
  });
});

describe('updateAppSchema', () => {
  it('requires id', () => {
    expect(updateAppSchema.safeParse({ name: 'New Name' }).success).toBe(false);
  });

  it('accepts partial update', () => {
    const r = updateAppSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Renamed',
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid id', () => {
    expect(
      updateAppSchema.safeParse({ id: 'not-uuid', name: 'X' }).success,
    ).toBe(false);
  });
});

describe('csvRowSchema', () => {
  it('accepts a complete row matching the template', () => {
    const row = {
      name: 'Skyline Runners',
      display_name: '',
      aliases: 'Skyline|Skyline Runners: Endless',
      apple_bundle_id: 'com.studio.skylinerunners',
      google_package_name: 'com.studio.skylinerunners',
      huawei_app_id: '',
      facebook_app_id: '9284715620',
      team_owner_email: 'linh@company.com',
      active: 'true',
    };
    const r = csvRowSchema.safeParse(row);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.aliases).toEqual(['Skyline', 'Skyline Runners: Endless']);
      expect(r.data.display_name).toBeUndefined();
      expect(r.data.huawei_app_id).toBeUndefined();
      expect(r.data.active).toBe(true);
      expect(r.data.team_owner_email).toBe('linh@company.com');
    }
  });

  it('parses active="false" as false', () => {
    const r = csvRowSchema.safeParse({ name: 'X', active: 'false' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.active).toBe(false);
  });

  it('parses active="0" as false and "1" as true', () => {
    expect((csvRowSchema.parse({ name: 'X', active: '0' })).active).toBe(false);
    expect((csvRowSchema.parse({ name: 'X', active: '1' })).active).toBe(true);
  });

  it('handles empty aliases string as empty array', () => {
    const r = csvRowSchema.safeParse({ name: 'X', aliases: '', active: 'true' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aliases).toEqual([]);
  });

  it('trims and filters empty pipe-separated tokens', () => {
    const r = csvRowSchema.safeParse({
      name: 'X',
      aliases: 'A | B ||  C ',
      active: 'true',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aliases).toEqual(['A', 'B', 'C']);
  });

  it('rejects missing name', () => {
    expect(csvRowSchema.safeParse({ name: '', active: 'true' }).success).toBe(false);
  });

  it('rejects invalid team_owner_email', () => {
    const r = csvRowSchema.safeParse({
      name: 'X',
      team_owner_email: 'not-an-email',
      active: 'true',
    });
    expect(r.success).toBe(false);
  });

  it('accepts empty team_owner_email as undefined', () => {
    const r = csvRowSchema.safeParse({ name: 'X', team_owner_email: '', active: 'true' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.team_owner_email).toBeUndefined();
  });

  it('lowercases team_owner_email', () => {
    const r = csvRowSchema.parse({
      name: 'X',
      team_owner_email: 'Linh@Company.COM',
      active: 'true',
    });
    expect(r.team_owner_email).toBe('linh@company.com');
  });

  it('treats missing active (empty string) as false', () => {
    const r = csvRowSchema.safeParse({ name: 'X', active: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.active).toBe(false);
  });

  it('rejects active with unrecognised token ("maybe")', () => {
    const r = csvRowSchema.safeParse({ name: 'X', active: 'maybe' });
    expect(r.success).toBe(false);
  });

  it('passes a non-string active through as-is (boolean true)', () => {
    const r = csvRowSchema.safeParse({ name: 'X', active: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.active).toBe(true);
  });
});
