/**
 * Step 5 — optional submission_id extraction.
 *
 * Iterate active patterns in DB order; first named-group `submission_id`
 * capture wins, trimmed. Returns null when no pattern matches — this is
 * **not an error**; submission_id is nice-to-have reference data and
 * CLASSIFIED results remain valid without it.
 *
 * **Cardinality**: one submission_id per email (spec §3.5 returns
 * `string | null`). Accumulation across multiple emails into the
 * `tickets.submission_ids TEXT[]` column is the ticket engine's concern
 * (spec §4 / PR-9), not the classifier's.
 *
 * Regex is **case-sensitive** by default; authors opt in to i-mode via
 * `(?i)` prefix if they want casing tolerance.
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.5.
 */

import { re2Exec } from '../regex/re2';

import type { RulesSnapshot, SubmissionIdMatch } from './types';

export function extractSubmissionId(
  body: string,
  rules: RulesSnapshot,
): SubmissionIdMatch | null {
  for (const pattern of rules.submission_id_patterns) {
    if (!pattern.active) continue;
    const match = re2Exec(pattern.body_regex, body);
    const captured = match?.groups?.submission_id?.trim();
    if (captured && captured.length > 0) {
      return {
        pattern_id: pattern.id,
        submission_id: captured,
      };
    }
  }
  return null;
}
