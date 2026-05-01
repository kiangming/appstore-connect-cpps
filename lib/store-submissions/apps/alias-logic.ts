/**
 * Pure functions for App Registry alias logic.
 *
 * All side effects (DB writes, transactions, slug-collision loops) live in
 * Server Actions in PR-4. These helpers decide WHAT to change; the caller
 * decides HOW to persist it.
 *
 * See docs/store-submissions/01-data-model.md §2.2 for the rename → demote
 * AUTO_CURRENT → insert new AUTO_CURRENT sequence.
 */

import type { AliasInput, AliasSourceType } from '../schemas/app';

export class InvalidSlugError extends Error {
  constructor(
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Cannot generate slug from "${input}": ${reason}`);
    this.name = 'InvalidSlugError';
  }
}

export const SLUG_MAX_LENGTH = 50;

/**
 * Below this many ASCII alphanumerics in the normalized output, the slug is
 * considered too thin to be human-meaningful (e.g. "彈彈英雄" → "", "創世紀戰M…"
 * → "m") and we fall back to a deterministic hash. Set to 3 so 2-letter
 * abbreviations ("VN") hash but 3-letter acronyms ("TFT") survive.
 */
export const SLUG_MIN_MEANINGFUL_LENGTH = 3;

/**
 * FNV-1a 32-bit hash. Pure TS — no Node `crypto` import — so this module stays
 * importable from Client Components (AppDialog uses generateSlugFromName for
 * the live slug preview). 4B output space is more than sufficient for our
 * ~200-app scope; the apps.slug UNIQUE constraint catches any collision and
 * suggestAvailableSlug appends a numeric suffix.
 */
function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Try to generate a clean ASCII slug from `name` using NFD + diacritic strip
 * + đ/Đ map + lowercase + non-alphanumeric → hyphen + truncate.
 *
 * Returns `null` when:
 *   - input is not a non-empty string after trim, OR
 *   - the normalized result has fewer than SLUG_MIN_MEANINGFUL_LENGTH ASCII
 *     alphanumerics (CJK names, emoji, pure punctuation, 1-2 char Latin).
 *
 * Callers that want a guaranteed slug should layer their own fallback on top
 * (apps use a hash; type-slug derivation in TypesTable returns "" so the
 * Manager types the slug manually).
 */
export function tryGenerateAsciiSlug(name: string): string | null {
  if (typeof name !== 'string' || name.trim() === '') return null;

  const deaccented = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

  const slug = deaccented
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');

  return slug.replace(/-/g, '').length < SLUG_MIN_MEANINGFUL_LENGTH ? null : slug;
}

/**
 * Generate a URL-friendly slug from an app name.
 *
 * - Latin/Vietnamese/French/Spanish names normalize to a clean ASCII slug
 *   (`tryGenerateAsciiSlug`).
 * - CJK names, emoji-only names, pure punctuation, and 1-2 char Latin
 *   abbreviations fall back to a deterministic `app-<8 hex>` hash slug —
 *   unblocks app registry creation for non-Latin names without changing any
 *   existing slug.
 *
 * Returns the candidate slug — callers MUST check for collisions against the
 * database before using it.
 *
 * Throws InvalidSlugError only when the input is empty, whitespace-only, or
 * not a string. Any non-empty input produces a slug.
 */
export function generateSlugFromName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidSlugError(name, 'input is empty or whitespace-only');
  }
  return tryGenerateAsciiSlug(name) ?? `app-${fnv1a32Hex(name)}`;
}

// -- Rename plan -----------------------------------------------------------

export type ExistingAlias = AliasInput & { id: string };

/**
 * Single atomic change in the rename plan. Callers apply these in array order
 * inside a single transaction (DEMOTE first, then INSERT or PROMOTE).
 *
 *  - DEMOTE: UPDATE app_aliases SET source_type='AUTO_HISTORICAL',
 *            previous_name=<previousName> WHERE id=<aliasId>.
 *  - INSERT: INSERT a new AUTO_CURRENT row with alias_text=<aliasText>.
 *  - PROMOTE: UPDATE app_aliases SET source_type='AUTO_CURRENT',
 *             previous_name=NULL WHERE id=<aliasId>. Used when the user
 *             already owned a MANUAL / REGEX / AUTO_HISTORICAL alias whose
 *             alias_text matches the new name — promoting avoids inserting a
 *             duplicate row that would violate the (app_id, lower(alias_text))
 *             matching semantics.
 */
export type AliasChange =
  | { kind: 'DEMOTE'; aliasId: string; previousName: string }
  | { kind: 'INSERT'; aliasText: string; sourceType: Extract<AliasSourceType, 'AUTO_CURRENT'> }
  | { kind: 'PROMOTE'; aliasId: string };

/**
 * Compute the ordered list of alias changes to apply when renaming an app
 * from oldName → newName.
 *
 *   1. DEMOTE every AUTO_CURRENT row (usually one; multiple tolerated for
 *      corrupt-state recovery) with previous_name = oldName.
 *   2. If an existing non-AUTO_CURRENT alias already has alias_text matching
 *      newName (case-insensitive, trimmed), PROMOTE that row instead of
 *      inserting a new one. Prevents the duplicate-row scenario where a user
 *      had "Skyline Runners" as a MANUAL alias before renaming to it.
 *   3. Otherwise, INSERT a new AUTO_CURRENT row with alias_text = newName.
 *
 * Returns an empty array when oldName === newName (trimmed) — caller should
 * skip the rename transaction entirely.
 *
 * Pure function. DB writes, ordering, and transactional rollback are the
 * caller's responsibility (see rename_app_tx RPC in PR-4 migration).
 *
 * Throws when newName is empty/whitespace-only.
 */
export function deriveAliasChangesOnRename(
  oldName: string,
  newName: string,
  currentAliases: ExistingAlias[],
): AliasChange[] {
  const trimmedOld = oldName.trim();
  const trimmedNew = newName.trim();

  if (trimmedNew === '') {
    throw new Error('newName cannot be empty');
  }

  if (trimmedOld === trimmedNew) {
    return [];
  }

  const changes: AliasChange[] = [];

  for (const a of currentAliases) {
    if (a.source_type === 'AUTO_CURRENT') {
      changes.push({ kind: 'DEMOTE', aliasId: a.id, previousName: trimmedOld });
    }
  }

  const lowerNew = trimmedNew.toLowerCase();
  const promoteTarget = currentAliases.find(
    (a) =>
      a.source_type !== 'AUTO_CURRENT' &&
      typeof a.alias_text === 'string' &&
      a.alias_text.trim().toLowerCase() === lowerNew,
  );

  if (promoteTarget) {
    changes.push({ kind: 'PROMOTE', aliasId: promoteTarget.id });
  } else {
    changes.push({ kind: 'INSERT', aliasText: trimmedNew, sourceType: 'AUTO_CURRENT' });
  }

  return changes;
}

// Alias conflict detection moved to ./alias-conflicts.ts — it depends on
// `re2-wasm` which is server-only, and keeping this module import-free of
// re2 lets Client Components consume generateSlugFromName without pulling
// Node's `fs` into the browser bundle.
