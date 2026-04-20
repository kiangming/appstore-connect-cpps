/**
 * Pure helpers for the Email Rules editor — kept free of React/Next imports
 * so they can be unit-tested in the node vitest environment.
 *
 * The editor holds a DraftState (subset of PlatformRules mirroring only the
 * editable fields) and compares it against the snapshot loaded at page
 * mount. `isDraftDirty` is the sole dirty predicate used by the Save button,
 * the beforeunload warning, and the tab-switch confirm.
 */

import {
  InvalidSlugError,
  generateSlugFromName,
} from '@/lib/store-submissions/apps/alias-logic';
import type {
  PlatformRow,
  PlatformRules,
  SenderRow,
  SubjectPatternRow,
  SubmissionIdPatternRow,
  TypeRow,
} from '@/lib/store-submissions/queries/rules';
import type { PlatformKey } from '@/lib/store-submissions/schemas/app';

/**
 * Platforms are hard-coded in the classifier
 * (lib/store-submissions/classifier/types.ts) and cannot be added from the
 * UI — matches the "no Add platform button" decision in Chunk 3 scope.
 */
export const PLATFORM_KEYS: readonly PlatformKey[] = [
  'apple',
  'google',
  'huawei',
  'facebook',
] as const;

export const PLATFORM_LABELS: Record<PlatformKey, string> = {
  apple: 'Apple',
  google: 'Google Play',
  huawei: 'Huawei',
  facebook: 'Facebook',
};

/**
 * Draft row shapes — identical to the DB row shapes minus `platform_id`
 * (implicit from the active tab) and with `id` optional so rows newly added
 * in the editor don't need to fabricate one. Save action's zod schema has
 * the same optional-id convention.
 */
export interface SenderDraft {
  id?: string;
  email: string;
  is_primary: boolean;
  active: boolean;
}

export interface SubjectPatternDraft {
  id?: string;
  outcome: 'APPROVED' | 'REJECTED' | 'IN_REVIEW';
  regex: string;
  priority: number;
  example_subject: string | null;
  active: boolean;
}

export interface TypeDraft {
  id?: string;
  name: string;
  slug: string;
  body_keyword: string;
  payload_extract_regex: string | null;
  sort_order: number;
  active: boolean;
}

export interface SubmissionIdPatternDraft {
  id?: string;
  body_regex: string;
  active: boolean;
}

export interface DraftState {
  senders: SenderDraft[];
  subject_patterns: SubjectPatternDraft[];
  types: TypeDraft[];
  submission_id_patterns: SubmissionIdPatternDraft[];
}

// -- Conversions ---------------------------------------------------------

const fromSenderRow = (r: SenderRow): SenderDraft => ({
  id: r.id,
  email: r.email,
  is_primary: r.is_primary,
  active: r.active,
});

const fromSubjectRow = (r: SubjectPatternRow): SubjectPatternDraft => ({
  id: r.id,
  outcome: r.outcome,
  regex: r.regex,
  priority: r.priority,
  example_subject: r.example_subject,
  active: r.active,
});

const fromTypeRow = (r: TypeRow): TypeDraft => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  body_keyword: r.body_keyword,
  payload_extract_regex: r.payload_extract_regex,
  sort_order: r.sort_order,
  active: r.active,
});

const fromSubIdRow = (r: SubmissionIdPatternRow): SubmissionIdPatternDraft => ({
  id: r.id,
  body_regex: r.body_regex,
  active: r.active,
});

/**
 * Snapshot → DraftState. Preserves existing row order so the initial
 * render matches the loaded data; Chunk 3.2 tables will apply their own
 * sort-on-render (by priority / sort_order).
 */
export function buildDraftState(rules: PlatformRules): DraftState {
  return {
    senders: rules.senders.map(fromSenderRow),
    subject_patterns: rules.subject_patterns.map(fromSubjectRow),
    types: rules.types.map(fromTypeRow),
    submission_id_patterns: rules.submission_id_patterns.map(fromSubIdRow),
  };
}

/**
 * Deep equality check via JSON.stringify. Deterministic because every field
 * in the draft shape is a string, number, boolean, or null — no Date, no
 * undefined, no class instance. Order-sensitive by design: reordering rows
 * counts as a change (priority/sort_order edits flow through it).
 */
export function isDraftDirty(original: DraftState, current: DraftState): boolean {
  return JSON.stringify(original) !== JSON.stringify(current);
}

// -- Platform tab resolution --------------------------------------------

// -- Row operations (pure, immutable) -----------------------------------

/**
 * Replace row at `index` with a shallow-merged patch. Returns a new array;
 * never mutates the input. Used by every table as the "edit a field" path.
 */
export function updateRow<T>(rows: T[], index: number, patch: Partial<T>): T[] {
  if (index < 0 || index >= rows.length) return rows;
  const copy = rows.slice();
  const current = copy[index] as T;
  copy[index] = { ...current, ...patch };
  return copy;
}

export function addRow<T>(rows: T[], newRow: T): T[] {
  return [...rows, newRow];
}

export function removeRow<T>(rows: T[], index: number): T[] {
  if (index < 0 || index >= rows.length) return rows;
  return rows.slice(0, index).concat(rows.slice(index + 1));
}

/**
 * Enforce the "exactly one (or zero) primary sender" invariant. Setting a
 * row's `is_primary` to true clears the flag on every other row; setting
 * to false just clears that row's flag (leaving the rest untouched).
 *
 * UX note: nothing stops a Manager from un-primary-ing the last primary
 * and saving with no primary. Zod on the save path allows it — the
 * classifier never requires a `is_primary` sender, it only uses `active`.
 */
export function setPrimarySender<T extends { is_primary: boolean }>(
  senders: T[],
  index: number,
  nextValue: boolean,
): T[] {
  if (index < 0 || index >= senders.length) return senders;
  return senders.map((s, i) => {
    if (i === index) return { ...s, is_primary: nextValue };
    if (nextValue && s.is_primary) return { ...s, is_primary: false };
    return s;
  });
}

/**
 * Stable sort by a numeric field (ascending). Stable so rows with the same
 * priority/sort_order don't jump around when unrelated rows are edited.
 * `Array.prototype.sort` on V8 is stable as of ES2019, so we rely on that.
 */
export function sortByNumericField<T>(rows: T[], field: keyof T): T[] {
  return [...rows].sort((a, b) => {
    const av = a[field] as unknown as number;
    const bv = b[field] as unknown as number;
    return av - bv;
  });
}

/**
 * Return one past the max of a numeric field, or `1` if the list is empty.
 * Used when a new row is added so it lands at the end of the sorted view
 * without colliding on priority/sort_order.
 */
export function nextNumericField<T>(rows: T[], field: keyof T): number {
  if (rows.length === 0) return 1;
  const values = rows
    .map((r) => r[field] as unknown as number)
    .filter((n) => Number.isFinite(n));
  if (values.length === 0) return 1;
  return Math.max(...values) + 1;
}

/**
 * Safe wrapper around generateSlugFromName — empty/invalid names return ""
 * so the types-table auto-derive-on-blur UX never throws. Manager can type
 * a slug by hand when the derivation fails (e.g. name="!!!").
 */
export function safeSlugFromName(name: string): string {
  if (!name || name.trim() === '') return '';
  try {
    return generateSlugFromName(name);
  } catch (err) {
    if (err instanceof InvalidSlugError) return '';
    throw err;
  }
}

function isPlatformKey(v: string | undefined | null): v is PlatformKey {
  return (
    v === 'apple' || v === 'google' || v === 'huawei' || v === 'facebook'
  );
}

/**
 * Pick which platform tab to render.
 *
 *   1. If the URL's `?platform=<key>` matches a hard-coded key AND the seed
 *      has that platform active, use it.
 *   2. Else fall back to the first active platform (typically `apple`).
 *   3. If no platform is active at all (unexpected — seed not applied),
 *      returns `null` so the page can render an empty-state.
 *
 * `queryValue` accepts string | string[] | undefined to match Next's
 * searchParams shape; array values are treated as "use the first element".
 */
export function resolvePlatformKey(
  queryValue: string | string[] | undefined,
  platforms: PlatformRow[],
): PlatformKey | null {
  const requested = Array.isArray(queryValue) ? queryValue[0] : queryValue;
  const activeKeys = new Set(
    platforms.filter((p) => p.active).map((p) => p.key),
  );
  if (isPlatformKey(requested) && activeKeys.has(requested)) {
    return requested;
  }
  for (const k of PLATFORM_KEYS) {
    if (activeKeys.has(k)) return k;
  }
  return null;
}
