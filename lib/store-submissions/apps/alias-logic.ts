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
 * Generate a URL-friendly slug from an app name.
 *
 * - NFD-decomposes and strips Unicode combining marks → drops diacritics
 *   (Vietnamese, French, Spanish, etc.).
 * - Maps Vietnamese đ/Đ manually because they are precomposed code points,
 *   not composed characters, and NFD leaves them intact.
 * - Lowercases, replaces runs of non-ASCII-alphanumeric with a single hyphen,
 *   trims leading/trailing hyphens.
 * - Truncates at SLUG_MAX_LENGTH (50) to leave room for collision suffixes
 *   like `-2`, `-3` that the caller applies in PR-4.
 *
 * Returns the candidate slug — callers MUST check for collisions against the
 * database before using it.
 *
 * Throws InvalidSlugError when the input is empty or contains no characters
 * that map to ASCII alphanumerics (e.g., "!!!" or "  ").
 */
export function generateSlugFromName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidSlugError(name, 'input is empty or whitespace-only');
  }

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

  if (slug === '') {
    throw new InvalidSlugError(name, 'no ASCII alphanumerics remain after normalization');
  }
  return slug;
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
