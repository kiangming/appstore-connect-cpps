/**
 * Server-only alias conflict detection.
 *
 * Extracted from ./alias-logic.ts so that alias-logic stays client-safe
 * (generateSlugFromName + deriveAliasChangesOnRename are consumed by Client
 * Components). `re2Test` pulls in `re2-wasm`, which drags Node's `fs` into
 * the browser bundle and breaks `next build`.
 *
 * Only Server Actions / server-side classifiers should import this module.
 */

import { re2Test } from '../regex/re2';
import type { AliasInput } from '../schemas/app';
import type { ExistingAlias } from './alias-logic';

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
