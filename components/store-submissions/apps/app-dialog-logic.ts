/**
 * Pure submit-logic helpers for AppDialog.
 *
 * Extracted so the behavior (validation + action-plan generation) can be
 * unit-tested without a DOM. AppDialog.tsx consumes these at submit time and
 * dispatches the resulting plan against Server Actions.
 */

import type {
  AppListRow,
  AppPlatformBindingRecord,
} from '@/lib/store-submissions/queries/apps';
import type {
  CreateAppActionInput,
  PlatformKey,
} from '@/lib/store-submissions/schemas/app';

export const PLATFORM_KEYS: readonly PlatformKey[] = [
  'apple',
  'google',
  'huawei',
  'facebook',
] as const;

export type FormBinding = {
  enabled: boolean;
  platform_ref: string;
  console_url: string;
};

export type FormState = {
  name: string;
  display_name: string;
  team_owner_id: string;
  active: boolean;
  bindings: Record<PlatformKey, FormBinding>;
};

export type UpdateAppPatch = {
  display_name?: string | null;
  team_owner_id?: string | null;
  active?: boolean;
};

export type EditAction =
  | { kind: 'rename'; new_name: string }
  | { kind: 'update'; patch: UpdateAppPatch }
  | {
      kind: 'upsertBinding';
      platform: PlatformKey;
      platform_ref?: string;
      console_url?: string;
    }
  | { kind: 'removeBinding'; platform: PlatformKey };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateFormState(form: FormState): ValidationResult {
  if (form.name.trim() === '') {
    return { ok: false, error: 'Name is required' };
  }
  const enabledCount = PLATFORM_KEYS.filter((k) => form.bindings[k].enabled).length;
  if (enabledCount === 0) {
    return { ok: false, error: 'Please select at least one platform' };
  }
  return { ok: true };
}

export function buildCreatePayload(form: FormState): CreateAppActionInput {
  return {
    name: form.name.trim(),
    display_name: form.display_name.trim() || undefined,
    team_owner_id: form.team_owner_id || null,
    active: form.active,
    platform_bindings: PLATFORM_KEYS.filter((k) => form.bindings[k].enabled).map(
      (k) => ({
        platform: k,
        platform_ref: form.bindings[k].platform_ref.trim() || undefined,
        console_url: form.bindings[k].console_url.trim() || undefined,
      }),
    ),
  };
}

/**
 * Diff form vs original app into an ordered action plan. Order matters: rename
 * first (alias transaction), then update (scalar fields), then binding mutations.
 *
 * Binding scenarios:
 *   1. hadBinding && !wants  → removeBinding
 *   2. !hadBinding && wants  → upsertBinding (insert; ref/url may be undefined)
 *   3. hadBinding && wants && (ref or url changed) → upsertBinding (update)
 *   4. hadBinding && wants && unchanged → skipped (no action)
 *
 * platform_ref / console_url are emitted as `undefined` (not `""`) when blank
 * so the Zod schema at the action boundary accepts them and the DB stores NULL.
 */
export function buildEditActionPlan(
  form: FormState,
  original: AppListRow,
): EditAction[] {
  const actions: EditAction[] = [];

  if (form.name.trim() !== original.name) {
    actions.push({ kind: 'rename', new_name: form.name.trim() });
  }

  const patch: UpdateAppPatch = {};
  if ((form.display_name.trim() || null) !== (original.display_name ?? null)) {
    patch.display_name = form.display_name.trim() || null;
  }
  if ((form.team_owner_id || null) !== (original.team_owner_id ?? null)) {
    patch.team_owner_id = form.team_owner_id || null;
  }
  if (form.active !== original.active) {
    patch.active = form.active;
  }
  if (Object.keys(patch).length > 0) {
    actions.push({ kind: 'update', patch });
  }

  for (const key of PLATFORM_KEYS) {
    const originalBinding: AppPlatformBindingRecord | undefined = original.bindings.find(
      (b) => b.platform_key === key,
    );
    const nextRef = form.bindings[key].platform_ref.trim();
    const nextUrl = form.bindings[key].console_url.trim();
    const hadBinding = originalBinding !== undefined;
    const wantsBinding = form.bindings[key].enabled;

    if (hadBinding && !wantsBinding) {
      actions.push({ kind: 'removeBinding', platform: key });
      continue;
    }

    if (wantsBinding) {
      const changed =
        !hadBinding ||
        (originalBinding?.platform_ref ?? '') !== nextRef ||
        (originalBinding?.console_url ?? '') !== nextUrl;
      if (changed) {
        actions.push({
          kind: 'upsertBinding',
          platform: key,
          platform_ref: nextRef || undefined,
          console_url: nextUrl || undefined,
        });
      }
    }
  }

  return actions;
}
