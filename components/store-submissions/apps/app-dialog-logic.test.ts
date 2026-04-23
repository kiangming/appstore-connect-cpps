import { describe, expect, it } from 'vitest';

import type {
  AppListRow,
  AppPlatformBindingRecord,
} from '@/lib/store-submissions/queries/apps';

import {
  buildCreatePayload,
  buildEditActionPlan,
  validateFormState,
  type FormState,
} from './app-dialog-logic';

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    name: '',
    display_name: '',
    team_owner_id: '',
    active: true,
    bindings: {
      apple: { enabled: false, platform_ref: '', console_url: '' },
      google: { enabled: false, platform_ref: '', console_url: '' },
      huawei: { enabled: false, platform_ref: '', console_url: '' },
      facebook: { enabled: false, platform_ref: '', console_url: '' },
    },
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppListRow> = {}): AppListRow {
  return {
    id: 'app-1',
    slug: 'test-app',
    name: 'Test App',
    display_name: null,
    team_owner_id: null,
    active: true,
    tracking_since: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: null,
    aliases: [],
    bindings: [],
    team_owner_email: null,
    team_owner_display_name: null,
    ...overrides,
  };
}

function makeBinding(
  overrides: Partial<AppPlatformBindingRecord> = {},
): AppPlatformBindingRecord {
  return {
    id: 'binding-1',
    app_id: 'app-1',
    platform_id: 'platform-apple',
    platform_key: 'apple',
    platform_display_name: 'Apple App Store',
    platform_ref: null,
    console_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('validateFormState', () => {
  it('rejects empty name', () => {
    expect(validateFormState(makeForm({ name: '' }))).toEqual({
      ok: false,
      error: 'Name is required',
    });
  });

  it('rejects zero enabled platforms', () => {
    expect(validateFormState(makeForm({ name: 'My App' }))).toEqual({
      ok: false,
      error: 'Please select at least one platform',
    });
  });

  it('accepts name + at least one platform enabled', () => {
    const form = makeForm({
      name: 'My App',
      bindings: {
        apple: { enabled: true, platform_ref: '', console_url: '' },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    expect(validateFormState(form)).toEqual({ ok: true });
  });
});

describe('buildCreatePayload', () => {
  // The original bug: user checks a platform but leaves ref blank; old code
  // dropped the binding, app got zero bindings, classifier missed it.
  it('includes binding for checked platform even without ref', () => {
    const form = makeForm({
      name: 'My App',
      bindings: {
        apple: { enabled: true, platform_ref: '', console_url: '' },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    const payload = buildCreatePayload(form);
    expect(payload.platform_bindings).toEqual([
      { platform: 'apple', platform_ref: undefined, console_url: undefined },
    ]);
  });

  it('emits multi-platform bindings with mixed refs', () => {
    const form = makeForm({
      name: 'Multi App',
      bindings: {
        apple: { enabled: true, platform_ref: 'com.example', console_url: '' },
        google: { enabled: true, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    const payload = buildCreatePayload(form);
    expect(payload.platform_bindings).toEqual([
      { platform: 'apple', platform_ref: 'com.example', console_url: undefined },
      { platform: 'google', platform_ref: undefined, console_url: undefined },
    ]);
  });
});

describe('buildEditActionPlan', () => {
  it('DELETE: unchecking an existing binding emits removeBinding', () => {
    const app = makeApp({
      bindings: [
        makeBinding({ platform_key: 'apple', platform_ref: 'com.example' }),
      ],
    });
    const form = makeForm({ name: 'Test App' });
    expect(buildEditActionPlan(form, app)).toEqual([
      { kind: 'removeBinding', platform: 'apple' },
    ]);
  });

  it('UPDATE: clearing ref on existing binding emits upsert with platform_ref undefined (not empty string)', () => {
    const app = makeApp({
      bindings: [
        makeBinding({ platform_key: 'apple', platform_ref: 'com.example' }),
      ],
    });
    const form = makeForm({
      name: 'Test App',
      bindings: {
        apple: { enabled: true, platform_ref: '', console_url: '' },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    const plan = buildEditActionPlan(form, app);
    expect(plan).toEqual([
      {
        kind: 'upsertBinding',
        platform: 'apple',
        platform_ref: undefined,
        console_url: undefined,
      },
    ]);
    // Zod setPlatformBindingInputSchema.platform_ref has .min(1) — passing ""
    // would be rejected at the action boundary. Guard the contract explicitly.
    const action = plan[0];
    if (action.kind !== 'upsertBinding') throw new Error('expected upsertBinding');
    expect(action.platform_ref).toBeUndefined();
    expect(action.platform_ref).not.toBe('');
  });

  it('CREATE: checking a new platform without ref emits upsert with platform_ref undefined', () => {
    const app = makeApp({
      bindings: [
        makeBinding({ platform_key: 'apple', platform_ref: 'com.example' }),
      ],
    });
    const form = makeForm({
      name: 'Test App',
      bindings: {
        apple: { enabled: true, platform_ref: 'com.example', console_url: '' },
        google: { enabled: true, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    expect(buildEditActionPlan(form, app)).toEqual([
      {
        kind: 'upsertBinding',
        platform: 'google',
        platform_ref: undefined,
        console_url: undefined,
      },
    ]);
  });

  it('skips unchanged binding (no action emitted)', () => {
    const app = makeApp({
      bindings: [
        makeBinding({
          platform_key: 'apple',
          platform_ref: 'com.example',
          console_url: 'https://example.com',
        }),
      ],
    });
    const form = makeForm({
      name: 'Test App',
      bindings: {
        apple: {
          enabled: true,
          platform_ref: 'com.example',
          console_url: 'https://example.com',
        },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    expect(buildEditActionPlan(form, app)).toEqual([]);
  });

  it('only name change emits rename only (no binding actions)', () => {
    const app = makeApp({
      name: 'Old Name',
      bindings: [
        makeBinding({ platform_key: 'apple', platform_ref: 'com.example' }),
      ],
    });
    const form = makeForm({
      name: 'New Name',
      bindings: {
        apple: { enabled: true, platform_ref: 'com.example', console_url: '' },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    expect(buildEditActionPlan(form, app)).toEqual([
      { kind: 'rename', new_name: 'New Name' },
    ]);
  });

  it('scalar-field changes emit a single update action', () => {
    const app = makeApp({
      name: 'Test App',
      display_name: null,
      active: true,
      bindings: [
        makeBinding({ platform_key: 'apple', platform_ref: 'com.example' }),
      ],
    });
    const form = makeForm({
      name: 'Test App',
      display_name: 'Test App Display',
      active: false,
      bindings: {
        apple: { enabled: true, platform_ref: 'com.example', console_url: '' },
        google: { enabled: false, platform_ref: '', console_url: '' },
        huawei: { enabled: false, platform_ref: '', console_url: '' },
        facebook: { enabled: false, platform_ref: '', console_url: '' },
      },
    });
    expect(buildEditActionPlan(form, app)).toEqual([
      {
        kind: 'update',
        patch: { display_name: 'Test App Display', active: false },
      },
    ]);
  });
});
