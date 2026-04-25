/**
 * Step 4 — email → type + payload.
 *
 * Two-tier match (PR-11):
 *
 *   Priority 1 — structured payload (PR-11). When `email.extracted_payload`
 *   has a non-UNKNOWN first item, take its slug as authoritative and
 *   populate `payload` directly from the AcceptedItem's typed fields.
 *
 *   Priority 2 — legacy body keyword (pre-PR-11 behavior). Iterate active
 *   types by `sort_order` ASC; first `body.includes(body_keyword)` wins.
 *   Optional `payload_extract_regex` extracts named-group captures.
 *
 * Why two tiers: Apple's text/plain part carries only Submission ID + App
 * Name — the type signal lives in the HTML alternative. Pre-PR-11 the
 * keyword path always missed for Apple emails and fell through to
 * UNCLASSIFIED_TYPE. The HTML extractor (PR-11.1) parses the structure;
 * the keyword path now serves legacy rows + non-Apple platforms +
 * UNKNOWN headings (graceful degradation when Apple introduces a new
 * template variant).
 *
 * Inactive types skipped at every step.
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.4.
 */

import type {
  AcceptedItem,
  AcceptedItemType,
} from '../gmail/html-extractor';
import { re2Exec } from '../regex/re2';

import type { EmailInput, RulesSnapshot, TypeMatch } from './types';

/**
 * Map extractor type discriminator → DB type slug.
 *
 * Returns null for UNKNOWN — the caller already gates on
 * `firstItem.type !== 'UNKNOWN'`, so this defensive null only fires if a
 * future AcceptedItemType variant is added without updating this switch.
 */
export function mapExtractorTypeToSlug(
  type: AcceptedItemType,
): string | null {
  switch (type) {
    case 'APP_VERSION':
      return 'app';
    case 'IN_APP_EVENTS':
      return 'iae';
    case 'CUSTOM_PRODUCT_PAGE':
      return 'cpp';
    case 'PRODUCT_PAGE_OPTIMIZATION':
      return 'ppo';
    case 'UNKNOWN':
      return null;
  }
}

/**
 * Build the `TypeMatch.payload` Record from an AcceptedItem's typed
 * fields. Output keys mirror the extractor's native field names
 * (version, platform, count, name, uuid, version_code) — opaque to the
 * downstream ticket engine, which stores them as JSONB on
 * `tickets.type_payloads`.
 */
function payloadFromExtractedItem(item: AcceptedItem): Record<string, string> {
  const out: Record<string, string> = {};
  if (item.version) out.version = item.version;
  if (item.platform) out.platform = item.platform;
  if (item.count !== undefined) out.count = String(item.count);
  if (item.name) out.name = item.name;
  if (item.uuid) out.uuid = item.uuid;
  if (item.version_code) out.version_code = item.version_code;
  return out;
}

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
  email: EmailInput,
  rules: RulesSnapshot,
): TypeMatch | null {
  const active = rules.types.filter((t) => t.active);
  active.sort((a, b) => a.sort_order - b.sort_order);

  // Priority 1: structured payload from HTML extractor (PR-11).
  const firstItem = email.extracted_payload?.accepted_items[0];
  if (firstItem && firstItem.type !== 'UNKNOWN') {
    const slug = mapExtractorTypeToSlug(firstItem.type);
    if (slug) {
      const matched = active.find((t) => t.slug === slug);
      if (matched) {
        return {
          type_id: matched.id,
          type_slug: matched.slug,
          type_name: matched.name,
          payload: payloadFromExtractedItem(firstItem),
        };
      }
      // Slug recognized but no active DB row for it — config gap (e.g.
      // PPO type not seeded yet on the platform). Fall through to the
      // body keyword path so the email still has a chance to classify.
    }
  }

  // Priority 2: legacy body keyword match.
  for (const type of active) {
    if (!email.body.includes(type.body_keyword)) continue;

    return {
      type_id: type.id,
      type_slug: type.slug,
      type_name: type.name,
      payload: extractPayload(email.body, type.payload_extract_regex),
    };
  }
  return null;
}
