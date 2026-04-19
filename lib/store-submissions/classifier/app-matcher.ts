/**
 * Step 3 — extracted app name → app_id.
 *
 * **Priority** (spec §3.3): exact text match across *all* apps FIRST, then
 * fall back to regex match across *all* apps. Do not interleave — an
 * unambiguous text match must always win over a permissive regex.
 *
 * Text match is **case-insensitive** after trim (app aliases like
 * "Skyline Runners" should match "skyline runners" in a subject). Regex
 * alias matches are **case-sensitive** — authors opt in via regex flags
 * if they want i-mode (e.g. `(?i)pattern`, supported by RE2).
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.3.
 */

import { re2Test } from '../regex/re2';

import type { AppMatch, AppWithAliases } from './types';

function normalizeText(s: string): string {
  return s.trim().toLowerCase();
}

export function matchApp(
  extractedName: string | null,
  apps: AppWithAliases[],
): AppMatch | null {
  if (!extractedName) return null;
  const normalized = normalizeText(extractedName);
  if (normalized === '') return null;

  // Pass 1 — exact text aliases across all apps.
  for (const app of apps) {
    for (const alias of app.aliases) {
      if (!alias.alias_text) continue;
      if (normalizeText(alias.alias_text) === normalized) {
        return {
          app_id: app.id,
          app_name: app.name,
          matched_alias: {
            kind: 'text',
            value: alias.alias_text,
            source_type: alias.source_type,
          },
        };
      }
    }
  }

  // Pass 2 — regex aliases across all apps (only after all text aliases miss).
  for (const app of apps) {
    for (const alias of app.aliases) {
      if (!alias.alias_regex) continue;
      // Test against the original extractedName (pre-normalize), so a
      // regex author can match against exact casing if they chose to.
      if (re2Test(alias.alias_regex, extractedName)) {
        return {
          app_id: app.id,
          app_name: app.name,
          matched_alias: {
            kind: 'regex',
            value: alias.alias_regex,
            source_type: alias.source_type,
          },
        };
      }
    }
  }

  return null;
}
