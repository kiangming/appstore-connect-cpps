/**
 * Apple App Store Connect "submission complete" email — HTML payload extractor.
 *
 * Apple submission notifications arrive as `multipart/alternative` with a
 * minimal `text/plain` part (Submission ID + App Name only) and a rich
 * `text/html` part that carries the actual structured information under
 * an `<h2>Accepted items</h2>` section. The text/plain part has no
 * type signal — without HTML parsing the classifier always lands in
 * UNCLASSIFIED_TYPE for Apple.
 *
 * This module is the HTML side of that. It walks the DOM under the
 * "Accepted items" heading and emits a typed `ExtractedPayload` for the
 * 4 type variants we've sampled in production. The classifier (PR-11.4)
 * consumes the structured payload instead of regexing the body.
 *
 * **Pure.** No I/O, no DB, no logging, no Sentry, no env reads. The
 * classifier (and the parser before it) maintain the same contract.
 * Sentry "extractor returned empty for Apple sender" alerting is wired
 * at the sync.ts call site, NOT here — keeping this module test-pure.
 *
 * **Apple-only.** Google Play, Huawei AppGallery, and Facebook Instant
 * Games each have their own templates; future PR-12+ adds platform
 * dispatch (`extractGoogle`, `extractHuawei`, `extractFacebook`). The
 * shared `ExtractedPayload` shape is the contract — extractors agree on
 * the result type, not on the input template.
 *
 * **Type variants** (sampled 2026-04 from prod fixtures):
 *   - APP_VERSION              `<h3>App Version</h3><p>{version} for {os}</p>`
 *   - IN_APP_EVENTS            `<h3>In-App Events ({count})</h3>` (no body)
 *   - CUSTOM_PRODUCT_PAGE      `<h3>Custom Product Pages </h3><p>{name}<br>{uuid}<br></p>`
 *                              (note trailing space in the heading)
 *   - PRODUCT_PAGE_OPTIMIZATION `<h3>Product Page Optimization</h3><p>{version_code}</p>`
 *   - UNKNOWN                  unrecognized heading — preserved verbatim so
 *                              Manager UI + Sentry can flag the new variant.
 *
 * **Failure modes** (all return `{ accepted_items: [] }`):
 *   - `html` is null/undefined/empty
 *   - HTML doesn't parse
 *   - No `<h2>Accepted items</h2>` element present
 *   - "Accepted items" exists but no `<h3>` siblings follow
 *
 * Empty result is the signal sync.ts uses to fire the Sentry alert.
 */

import { parse } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';

export type AcceptedItemType =
  | 'APP_VERSION'
  | 'IN_APP_EVENTS'
  | 'CUSTOM_PRODUCT_PAGE'
  | 'PRODUCT_PAGE_OPTIMIZATION'
  | 'UNKNOWN';

export interface AcceptedItem {
  /** Discriminator. Type-specific fields are present per variant; consumers
   *  must narrow on `type` before reading. */
  type: AcceptedItemType;
  /** Verbatim heading text, untrimmed (preserves trailing space from the
   *  Apple "Custom Product Pages " template — useful for debugging if
   *  Apple ever flips the trailing whitespace). */
  raw_heading: string;
  /** Plain-text body (post `<br>`→\n + tag strip). May be empty. Always
   *  present so reclassify UI / Sentry can show the raw extracted text
   *  without re-fetching the HTML. */
  raw_body: string;

  // Type-specific fields. Populated only for the matching variant.
  version?: string;       // APP_VERSION
  platform?: string;      // APP_VERSION   ("iOS", "macOS", "tvOS", "watchOS")
  count?: number;         // IN_APP_EVENTS
  name?: string;          // CUSTOM_PRODUCT_PAGE
  uuid?: string;          // CUSTOM_PRODUCT_PAGE
  version_code?: string;  // PRODUCT_PAGE_OPTIMIZATION
}

export interface ExtractedPayload {
  accepted_items: AcceptedItem[];
}

export function extractApple(
  html: string | null | undefined,
): ExtractedPayload {
  if (!html) return { accepted_items: [] };

  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return { accepted_items: [] };
  }

  const acceptedH2 = root
    .querySelectorAll('h2')
    .find((h) => h.text.trim() === 'Accepted items');
  if (!acceptedH2) return { accepted_items: [] };

  const items: AcceptedItem[] = [];
  let cursor: HTMLElement | null = acceptedH2.nextElementSibling;

  while (cursor) {
    if (cursor.tagName === 'H3') {
      const heading = cursor.text;
      const bodyEl = findTypeBody(cursor);
      const body = bodyEl ? extractBodyText(bodyEl) : '';
      items.push(buildItem(heading, body));
    }
    cursor = cursor.nextElementSibling;
  }

  return { accepted_items: items };
}

/**
 * Find the body `<p>` immediately following an `<h3>`, distinguishing it
 * from the CTA "View in App Store Connect" `<p>` and the footer
 * "Please note..." `<p>` that share the same parent.
 *
 * Heuristic: type-body `<p>` is the immediate next-element sibling AND
 * does not contain an `<a>` anchor. The CTA `<p>` always wraps an `<a>`,
 * so its presence signals end-of-type-body. Footer `<p>` only appears
 * after the CTA, so we never reach it for the body lookup.
 *
 * Returns null when the heading has no body — e.g. `In-App Events (N)`
 * where the count is encoded in the heading itself.
 */
function findTypeBody(h3: HTMLElement): HTMLElement | null {
  const next = h3.nextElementSibling;
  if (!next || next.tagName !== 'P') return null;
  if (next.querySelector('a')) return null;
  return next;
}

function extractBodyText(p: HTMLElement): string {
  // Preserve `<br>` line structure (CPP body uses `name<br>uuid<br>`)
  // before stripping the surrounding tags. node-html-parser's `.text`
  // collapses across `<br>` so we can't rely on it for multi-line bodies.
  const withNewlines = p.innerHTML.replace(/<br\s*\/?>/gi, '\n');
  const stripped = withNewlines.replace(/<[^>]+>/g, '');
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n: string) =>
      String.fromCodePoint(Number(n)),
    );
  return decoded
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildItem(heading: string, body: string): AcceptedItem {
  const trimmed = heading.trim();
  const base = { raw_heading: heading, raw_body: body };

  if (trimmed === 'App Version') {
    // Body is "1.0.13\nfor\niOS" after `<br>`/whitespace normalization.
    // Flatten to single-line then anchor on " for " to split.
    const flat = body.replace(/\s+/g, ' ').trim();
    const m = flat.match(/^(.+?)\s+for\s+(\S+)$/);
    if (m) {
      return {
        type: 'APP_VERSION',
        ...base,
        version: m[1].trim(),
        platform: m[2].trim(),
      };
    }
    return { type: 'APP_VERSION', ...base };
  }

  const iae = trimmed.match(/^In-App Events\s*\((\d+)\)$/);
  if (iae) {
    return {
      type: 'IN_APP_EVENTS',
      ...base,
      count: Number(iae[1]),
    };
  }

  if (trimmed === 'Custom Product Pages') {
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const item: AcceptedItem = { type: 'CUSTOM_PRODUCT_PAGE', ...base };
    if (lines.length === 1 && isUuid(lines[0])) {
      // Single-line body that's pure UUID — name was omitted.
      item.uuid = lines[0];
    } else {
      if (lines.length >= 1) item.name = lines[0];
      if (lines.length >= 2) item.uuid = lines[1];
    }
    return item;
  }

  if (trimmed === 'Product Page Optimization') {
    const code = body.trim();
    if (code) return { type: 'PRODUCT_PAGE_OPTIMIZATION', ...base, version_code: code };
    return { type: 'PRODUCT_PAGE_OPTIMIZATION', ...base };
  }

  return { type: 'UNKNOWN', ...base };
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
