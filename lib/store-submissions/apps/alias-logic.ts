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

import { re2Test } from '../regex/re2';
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

// -- Conflict detection ----------------------------------------------------

export type AliasConflictType =
  | 'duplicate_text'
  | 'new_regex_covers_existing_text'
  | 'existing_regex_covers_new_text';

export type AliasConflict = {
  type: AliasConflictType;
  against: ExistingAlias;
  message: string;
};

/**
 * Detect semantic conflicts between a proposed alias and the existing aliases
 * for the same app.
 *
 * Conflicts caught:
 *   1. `duplicate_text` — case-insensitive exact match between two text
 *      aliases. New alias would never be reached by the classifier.
 *   2. `existing_regex_covers_new_text` — the new text alias is already
 *      matched by a regex alias. New alias is redundant (but not harmful;
 *      returned as a warning for UI).
 *   3. `new_regex_covers_existing_text` — the new regex alias would match an
 *      existing text alias. The text alias becomes redundant.
 *
 * NOT caught (intentionally):
 *   - Two regex aliases overlapping — hard to compute soundly without
 *     formal language intersection.
 *   - AUTO_HISTORICAL duplicates of current AUTO_CURRENT during rename —
 *     that's exactly the intended state (§2.2).
 */
export function detectAliasConflicts(
  newAlias: AliasInput,
  existingAliases: ExistingAlias[],
): AliasConflict[] {
  const conflicts: AliasConflict[] = [];

  const newText = newAlias.alias_text?.trim().toLowerCase();
  const newRegex = newAlias.alias_regex;

  for (const existing of existingAliases) {
    const existingText = existing.alias_text?.trim().toLowerCase();

    if (newText && existingText && newText === existingText) {
      conflicts.push({
        type: 'duplicate_text',
        against: existing,
        message: `Alias "${newAlias.alias_text}" already exists (source_type=${existing.source_type})`,
      });
      continue;
    }

    if (newText && existing.alias_regex && re2Test(existing.alias_regex, newAlias.alias_text!)) {
      conflicts.push({
        type: 'existing_regex_covers_new_text',
        against: existing,
        message: `Text alias "${newAlias.alias_text}" is already matched by existing regex /${existing.alias_regex}/`,
      });
      continue;
    }

    if (newRegex && existing.alias_text && re2Test(newRegex, existing.alias_text)) {
      conflicts.push({
        type: 'new_regex_covers_existing_text',
        against: existing,
        message: `New regex /${newRegex}/ already covers existing text alias "${existing.alias_text}"`,
      });
    }
  }

  return conflicts;
}
