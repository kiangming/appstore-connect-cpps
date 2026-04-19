/**
 * Step 2 — subject → outcome + extracted_app_name.
 *
 * Patterns iterate by `priority` ASC (lower priority number = earlier in
 * sort order). First match wins. Regex is **case-sensitive** — they are
 * user-authored and may deliberately encode case (e.g. "In Review" vs
 * "in review"). The save-time validator enforces the `(?<app_name>...)`
 * named group on every pattern (see regex/validators.ts), but we check
 * defensively at match time and return null app_name if absent.
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.2.
 */

import { re2Exec } from '../regex/re2';

import type { RulesSnapshot, SubjectMatch } from './types';

export function matchSubject(
  subject: string,
  rules: RulesSnapshot,
): SubjectMatch | null {
  const active = rules.subject_patterns.filter((p) => p.active);
  // Stable ascending sort on priority — equal priorities keep DB order.
  active.sort((a, b) => a.priority - b.priority);

  for (const pattern of active) {
    const match = re2Exec(pattern.regex, subject);
    if (!match) continue;

    const captured = match.groups?.app_name?.trim() ?? null;
    return {
      pattern_id: pattern.id,
      outcome: pattern.outcome,
      extracted_app_name: captured && captured.length > 0 ? captured : null,
      matched_pattern: pattern.regex,
    };
  }
  return null;
}
