/**
 * Step 4 — body → type + payload.
 *
 * Types iterate by `sort_order` ASC. Two-stage match (spec §3.4):
 *   4a. Cheap `body.includes(body_keyword)` substring filter —
 *       **case-sensitive** per spec (`.includes` default).
 *   4b. Optional `payload_extract_regex` → named-group captures.
 *       If the regex is present but fails to match, we still return the
 *       type with an empty payload rather than falling through to the
 *       next type — keyword alone is sufficient to identify the type,
 *       and a missing payload is a rule-authoring concern not a
 *       classification failure.
 *
 * Inactive types skipped.
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.4.
 */

import { re2Exec } from '../regex/re2';

import type { RulesSnapshot, TypeMatch } from './types';

function extractPayload(
  bodyText: string,
  payloadRegex: string | null,
): Record<string, string> {
  if (!payloadRegex) return {};
  const match = re2Exec(payloadRegex, bodyText);
  const groups = match?.groups;
  if (!groups) return {};
  // `RegExpMatchArray.groups` is a prototype-less object at runtime; copy
  // defensively into a plain Record and drop undefined values (happens for
  // optional groups that didn't participate in the match).
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    if (typeof value === 'string') payload[key] = value;
  }
  return payload;
}

export function matchType(
  body: string,
  rules: RulesSnapshot,
): TypeMatch | null {
  const active = rules.types.filter((t) => t.active);
  active.sort((a, b) => a.sort_order - b.sort_order);

  for (const type of active) {
    if (!body.includes(type.body_keyword)) continue;

    return {
      type_id: type.id,
      type_slug: type.slug,
      type_name: type.name,
      payload: extractPayload(body, type.payload_extract_regex),
    };
  }
  return null;
}
