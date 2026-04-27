/**
 * Apple App Store Connect submission email — HTML payload extractor.
 *
 * Apple submission notifications arrive as `multipart/alternative` with a
 * minimal `text/plain` part (Submission ID + App Name only) and a rich
 * `text/html` part that carries the actual structured information. PR-11
 * shipped the acceptance side ("Review of your X submission is complete")
 * which uses an `<h2>Accepted items</h2>` anchor; PR-12 adds the rejection
 * side ("There's an issue with your X submission") which uses a different
 * HTML layout — no h2, h3 sits directly after the "...resolve the issues..."
 * paragraph.
 *
 * Both layouts share identical h3 headings + body shapes per type:
 *   APP_VERSION                `<h3>App Version</h3><p>{version} for {os}</p>`
 *   IN_APP_EVENTS              `<h3>In-App Events [(N)]</h3>` (count only on accept)
 *   CUSTOM_PRODUCT_PAGE        `<h3>Custom Product Pages [ ]</h3>` (trailing space)
 *                              `<p>{name}<br>{uuid}<br></p>`
 *   PRODUCT_PAGE_OPTIMIZATION  `<h3>Product Page Optimization</h3><p>{code}</p>`
 *   UNKNOWN                    unrecognized — preserved verbatim so Manager
 *                              UI + Sentry can flag a new variant.
 *
 * **Pure.** No I/O, no DB, no logging, no Sentry, no env reads. The
 * classifier (and the parser before it) maintain the same contract.
 * Sentry "extractor returned UNKNOWN heading" alerting is wired at the
 * sync.ts call site, NOT here — keeping this module test-pure.
 *
 * **Apple-only.** Google Play, Huawei AppGallery, and Facebook Instant
 * Games each have their own templates; future PRs add platform dispatch
 * (`extractGoogle`, etc.). The `ExtractedPayload` shape is the contract —
 * extractors agree on the result type, not on the input template.
 *
 * **Outcome detection** (PR-12). The `outcome` field is **audit-only** —
 * the classifier does not read it. `tickets.latest_outcome` is driven by
 * `subject_patterns` via PR-9's `find_or_create_ticket_tx` RPC, which is
 * the single source of truth for outcome. Surfacing outcome here is for
 * UI debugging + Sentry telemetry only. See docs/store-submissions/03-
 * email-rule-engine.md §3.5.
 *
 * Detection order:
 *   1. Subject contains "There's an issue with" → REJECTED (rejection
 *      branch)
 *   2. `<h2>Accepted items</h2>` present → ACCEPTED (acceptance branch)
 *   3. Paragraph "...resolve the issues..." present (subject signal
 *      missing or unrecognized but the HTML still tells us) → REJECTED
 *   4. Otherwise → null + empty items (graceful fallback).
 *
 * **Failure modes** (all return `{ outcome: null, items: [] }`):
 *   - `html` is null/undefined/empty
 *   - HTML doesn't parse
 *   - No anchor heading/paragraph for either branch
 *
 * Empty `items` is the signal sync.ts uses to fire the Sentry alert when
 * an Apple email returns nothing meaningful.
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
  count?: number;         // IN_APP_EVENTS — undefined on rejection variant
  name?: string;          // CUSTOM_PRODUCT_PAGE
  uuid?: string;          // CUSTOM_PRODUCT_PAGE
  version_code?: string;  // PRODUCT_PAGE_OPTIMIZATION
}

export interface ExtractedPayload {
  /**
   * Submission outcome derived from subject + HTML markers. **Audit-only**
   * — see module doc; classifier does NOT consume this field.
   *   - 'ACCEPTED'  acceptance template (h2 "Accepted items" anchor)
   *   - 'REJECTED'  rejection template (subject "There's an issue with" or
   *                 paragraph "...resolve the issues...")
   *   - null        neither marker matched (graceful fallback)
   */
  outcome: 'ACCEPTED' | 'REJECTED' | null;
  /**
   * Type-bearing entries. Empty array when no anchor section was found.
   * Renamed from `accepted_items` in PR-12 to cover both acceptance +
   * rejection. Production rows pre-PR-12 are NULL extracted_payload, so
   * no dual-shape read path is needed — see PR-12.5 backfill.
   */
  items: AcceptedItem[];
  /** UUID from a "Submission ID: ..." line in the HTML body. Optional —
   *  not all template variants surface it inline (text/plain may be the
   *  authoritative source for some). */
  submission_id?: string;
  /** Display name from an "App Name: ..." line. Optional, same caveat. */
  app_name?: string;
}

export function extractApple(
  html: string | null | undefined,
  subject?: string,
): ExtractedPayload {
  if (!html) return { outcome: null, items: [] };

  let root: HTMLElement;
  try {
    root = parse(html);
  } catch {
    return { outcome: null, items: [] };
  }

  const subjectIsRejection =
    !!subject && /there's an issue with/i.test(subject);

  let outcome: 'ACCEPTED' | 'REJECTED' | null;
  let items: AcceptedItem[];

  if (subjectIsRejection) {
    // Subject is authoritative when it carries the rejection marker — even
    // if the HTML anchor paragraph is missing/malformed we still classify
    // the outcome correctly. items=[] in that case (Sentry-visible signal).
    const anchor = findRejectionItemsAnchor(root);
    outcome = 'REJECTED';
    items = anchor ? collectItemsFromCursor(anchor.nextElementSibling) : [];
  } else {
    const acceptedH2 = findAcceptedItemsHeading(root);
    if (acceptedH2) {
      outcome = 'ACCEPTED';
      items = collectItemsFromCursor(acceptedH2.nextElementSibling);
    } else {
      // Subject didn't say rejection (or wasn't passed) and there's no
      // "Accepted items" h2. Try the rejection HTML marker as a last
      // resort — the message may be a rejection where Apple changed
      // subject phrasing, or where the caller didn't pass `subject`.
      const rejectionAnchor = findRejectionItemsAnchor(root);
      if (rejectionAnchor) {
        outcome = 'REJECTED';
        items = collectItemsFromCursor(rejectionAnchor.nextElementSibling);
      } else {
        outcome = null;
        items = [];
      }
    }
  }

  const meta = extractIdAndName(root);
  const result: ExtractedPayload = { outcome, items };
  if (meta.submission_id) result.submission_id = meta.submission_id;
  if (meta.app_name) result.app_name = meta.app_name;
  return result;
}

/**
 * Acceptance-branch anchor: `<h2>Accepted items</h2>`.
 * Returns the heading element so the caller can walk forward through
 * `nextElementSibling` collecting `<h3>` items.
 */
function findAcceptedItemsHeading(root: HTMLElement): HTMLElement | null {
  return (
    root
      .querySelectorAll('h2')
      .find((h) => h.text.trim() === 'Accepted items') ?? null
  );
}

/**
 * Rejection-branch anchor: the paragraph that introduces the items list
 * — text contains "resolve the issues". Apple's rejection template has
 * no h2 above the h3s, so we anchor on this sentence instead.
 */
function findRejectionItemsAnchor(root: HTMLElement): HTMLElement | null {
  return (
    root
      .querySelectorAll('p')
      .find((p) => /resolve the issues/i.test(p.text)) ?? null
  );
}

/**
 * Walk forward from `start` collecting `<h3>` items + their body `<p>`
 * until siblings exhaust. Shared by both acceptance + rejection branches
 * — heading patterns + body conventions are identical between the two
 * Apple templates, only the anchor differs.
 */
function collectItemsFromCursor(
  start: HTMLElement | null,
): AcceptedItem[] {
  const items: AcceptedItem[] = [];
  let cursor: HTMLElement | null = start;
  while (cursor) {
    if (cursor.tagName === 'H3') {
      const heading = cursor.text;
      const bodyEl = findTypeBody(cursor);
      const body = bodyEl ? extractBodyText(bodyEl) : '';
      items.push(buildItem(heading, body));
    }
    cursor = cursor.nextElementSibling;
  }
  return items;
}

/**
 * Find the body `<p>` immediately following an `<h3>`, distinguishing it
 * from the CTA "View in App Store Connect" / "App Review page" `<p>` and
 * the footer `<p>` that share the same parent.
 *
 * Heuristic: type-body `<p>` is the immediate next-element sibling AND
 * does not contain an `<a>` anchor. The CTA `<p>` always wraps an `<a>`,
 * so its presence signals end-of-type-body.
 *
 * Returns null when the heading has no body — e.g. acceptance variant
 * `In-App Events (N)` where the count is encoded in the heading itself,
 * or rejection variant `In-App Events ` where there is no immediate
 * type-body paragraph at all.
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

  // PR-12: count is optional. Acceptance variant is "In-App Events (N)";
  // rejection variant is "In-App Events" with no parens — count stays
  // undefined for the rejection branch.
  const iae = trimmed.match(/^In-App Events(?:\s*\((\d+)\))?$/);
  if (iae) {
    const item: AcceptedItem = { type: 'IN_APP_EVENTS', ...base };
    if (iae[1]) item.count = Number(iae[1]);
    return item;
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

/**
 * Extract `Submission ID:` UUID + `App Name:` value from the HTML body.
 *
 * Both Apple acceptance + rejection templates carry these labels inline
 * inside a body `<p>` (alongside Submitted timestamp / Submitted by /
 * Number of items). Two layouts observed in production:
 *   - same line: "App Name: Foo"
 *   - split line (after <br>): "App Name:" / "Foo"
 *
 * We normalize via `extractBodyText` (which preserves `<br>` as `\n`),
 * then scan paragraph-by-paragraph until both fields are found. First
 * match wins — Apple emits each label exactly once per email.
 */
function extractIdAndName(
  root: HTMLElement,
): { submission_id?: string; app_name?: string } {
  let submission_id: string | undefined;
  let app_name: string | undefined;

  for (const p of root.querySelectorAll('p')) {
    const text = extractBodyText(p);
    if (!text) continue;

    if (!submission_id) {
      const m = text.match(
        /Submission ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      );
      if (m) submission_id = m[1];
    }
    if (!app_name) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const sameLine = lines[i].match(/^App Name:\s*(\S.*?)\s*$/i);
        if (sameLine) {
          app_name = sameLine[1];
          break;
        }
        if (/^App Name:\s*$/i.test(lines[i]) && lines[i + 1]) {
          app_name = lines[i + 1].trim();
          break;
        }
      }
    }
    if (submission_id && app_name) break;
  }
  return { submission_id, app_name };
}
