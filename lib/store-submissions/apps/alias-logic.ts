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

export type AliasDemotion = {
  id: string;
  previous_name: string;
};

export type AliasAddition = {
  alias_text: string;
  source_type: Extract<AliasSourceType, 'AUTO_CURRENT'>;
};

export type AliasRenamePlan =
  | { kind: 'noop'; reason: 'unchanged' }
  | {
      kind: 'rename';
      demote: AliasDemotion[];
      add: AliasAddition;
    };

/**
 * Compute the alias change plan when renaming an app from oldName → newName.
 *
 * The returned plan is a pure description:
 *   - `demote[]` — existing AUTO_CURRENT rows that the caller must UPDATE to
 *     AUTO_HISTORICAL + set `previous_name` = oldName.
 *   - `add` — a new AUTO_CURRENT row to INSERT with alias_text = newName.
 *
 * There should only ever be one AUTO_CURRENT row per app per the data model,
 * but we defensively demote *every* AUTO_CURRENT we're given — that way a
 * corrupt state with two AUTO_CURRENT rows converges back to a valid one.
 *
 * Returns `kind: 'noop'` when oldName === newName after trimming; caller
 * should skip the transaction entirely.
 */
export function deriveAliasChangesOnRename(
  oldName: string,
  newName: string,
  currentAliases: ExistingAlias[],
): AliasRenamePlan {
  const trimmedOld = oldName.trim();
  const trimmedNew = newName.trim();

  if (trimmedNew === '') {
    throw new Error('newName cannot be empty');
  }

  if (trimmedOld === trimmedNew) {
    return { kind: 'noop', reason: 'unchanged' };
  }

  const demote = currentAliases
    .filter((a) => a.source_type === 'AUTO_CURRENT')
    .map((a) => ({ id: a.id, previous_name: trimmedOld }));

  return {
    kind: 'rename',
    demote,
    add: { alias_text: trimmedNew, source_type: 'AUTO_CURRENT' },
  };
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
