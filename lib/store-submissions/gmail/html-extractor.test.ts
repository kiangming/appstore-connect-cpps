/**
 * Tests for the Apple HTML payload extractor.
 *
 * Real `.eml` fixtures (multipart/alternative, QP-encoded HTML) live in
 * `__fixtures__/apple/`. The `loadAppleHtml` helper below extracts and
 * decodes the `text/html` part — duplicating the production parser's QP
 * decode rather than importing it to keep this test independent of
 * `parser.ts` changes (the extractor's contract is "give me HTML and
 * I'll give you a payload" — fixture sourcing is test infra).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractApple } from './html-extractor';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'apple');

function loadAppleHtml(file: string): string {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');

  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/);
  if (!boundaryMatch) {
    throw new Error(`No multipart boundary in ${file}`);
  }
  const boundary = `--${boundaryMatch[1]}`;
  const parts = raw.split(boundary);

  for (const part of parts) {
    if (!/Content-Type:\s*text\/html/i.test(part)) continue;

    // Body sits after the first blank line (CRLF or LF).
    const sepCrlf = part.indexOf('\r\n\r\n');
    const sepLf = part.indexOf('\n\n');
    let bodyStart: number;
    if (sepCrlf >= 0) {
      bodyStart = sepCrlf + 4;
    } else if (sepLf >= 0) {
      bodyStart = sepLf + 2;
    } else {
      throw new Error(`No header/body separator in ${file}`);
    }
    return decodeQuotedPrintable(part.slice(bodyStart));
  }
  throw new Error(`No text/html part in ${file}`);
}

function decodeQuotedPrintable(input: string): string {
  // Soft line breaks (`=` at line end) join physical lines into one.
  const cleaned = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(cleaned.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString('utf-8');
}

/* ============================================================================
 * Acceptance template — `<h2>Accepted items</h2>` anchor (PR-11)
 * ========================================================================== */

describe('extractApple — acceptance fixtures', () => {
  it('App Version: extracts version + platform + outcome=ACCEPTED', () => {
    const html = loadAppleHtml('apple-app-version.eml');
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'APP_VERSION',
      version: '1.0.13',
      platform: 'iOS',
    });
    expect(out.items[0].raw_heading.trim()).toBe('App Version');
    // Submission ID + App Name surface from inline body labels (PR-12).
    expect(out.submission_id).toBe('274d69b5-1de3-4647-be95-2e312f5da046');
    expect(out.app_name).toBe('Crossfire: Legends');
  });

  it('In-App Events: count from heading parens, no body', () => {
    const html = loadAppleHtml('apple-in-app-events.eml');
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'IN_APP_EVENTS',
      count: 5,
    });
    // No body paragraph for this variant — the count lives in the heading.
    expect(out.items[0].raw_body).toBe('');
  });

  it('Custom Product Pages: extracts name + uuid from <br>-separated body', () => {
    const html = loadAppleHtml('apple-custom-product-pages.eml');
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'CUSTOM_PRODUCT_PAGE',
      name: 'CPP 2004',
      uuid: 'e2232a07-7cdb-4418-bf62-77ad22da36dc',
    });
    // Apple's heading carries a trailing space — preserve raw, trim semantically.
    expect(out.items[0].raw_heading).toMatch(/Custom Product Pages\s*$/);
  });

  it('Product Page Optimization: extracts numeric version code', () => {
    const html = loadAppleHtml('apple-product-page-optimization.eml');
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'PRODUCT_PAGE_OPTIMIZATION',
      version_code: '230426',
    });
  });
});

/* ============================================================================
 * Rejection template — "There's an issue with your X submission" (PR-12)
 *
 * Rejection emails have no `<h2>Accepted items</h2>`; the h3 items list
 * sits directly after a paragraph containing "...resolve the issues...".
 * Subject signal "There's an issue with" drives the branch; HTML anchor
 * paragraph is the fallback when subject isn't passed.
 *
 * Heading shapes are identical to acceptance (App Version / In-App Events /
 * Custom Product Pages / Product Page Optimization), but IAE rejection
 * lacks the `(N)` count parens — count stays undefined.
 * ========================================================================== */

const REJECTION_SUBJECT = "There's an issue with your X submission.";

describe('extractApple — rejection fixtures', () => {
  it('App Version rejection: outcome=REJECTED + version + platform + ids', () => {
    const html = loadAppleHtml('apple-rejection-app-version.eml');
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'APP_VERSION',
      version: '1.4.5',
      platform: 'iOS',
    });
    expect(out.submission_id).toBe('2e45dd5f-acb5-4d00-b927-70bd3eca962f');
    expect(out.app_name).toBe('Chơi Ngay Game Vui Vẻ VNG');
  });

  it('In-App Events rejection: type=IN_APP_EVENTS + count undefined + raw_body has event id', () => {
    const html = loadAppleHtml('apple-rejection-in-app-events.eml');
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].type).toBe('IN_APP_EVENTS');
    // Rejection variant heading has no `(N)` parens — count is undefined.
    expect(out.items[0].count).toBeUndefined();
    // Trailing-space heading tolerated (parity with PR-11 CPP behavior).
    expect(out.items[0].raw_heading).toMatch(/In-App Events\s*$/);
    // Body text contains the descriptive blurb + numeric event ID; surface
    // raw_body for Manager debugging.
    expect(out.items[0].raw_body).toContain('6762174500');
    expect(out.submission_id).toBe('cef7a6e6-9f70-40b1-a256-12d51bfbe55c');
    expect(out.app_name).toBe('彈彈堂 Origin');
  });

  it('Custom Product Pages rejection: extracts name + uuid', () => {
    const html = loadAppleHtml('apple-rejection-custom-product-pages.eml');
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'CUSTOM_PRODUCT_PAGE',
      name: '3KF - Set 2',
      uuid: '52a6a7d2-bd60-4b0f-a147-98856b3dc2a7',
    });
    expect(out.submission_id).toBe('3e543c2a-e7aa-4b22-98e0-a24b083cf121');
    expect(out.app_name).toBe('Tam Quốc Huyễn Tướng VNG');
  });

  it('Product Page Optimization rejection: extracts version_code', () => {
    const html = loadAppleHtml('apple-rejection-product-page-optimization.eml');
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'PRODUCT_PAGE_OPTIMIZATION',
      version_code: 'CPO 0903',
    });
    expect(out.submission_id).toBe('9b56a268-9a31-40e1-9ad6-4b5c2a74c68a');
    expect(out.app_name).toBe('Nghịch Thủy Hàn');
  });
});

/* ============================================================================
 * Outcome detection edge cases
 * ========================================================================== */

describe('extractApple — outcome detection', () => {
  it('subject mismatch + h2 present → ACCEPTED (h2 is the fallback signal)', () => {
    // Caller didn't pass a subject (or subject didn't match the rejection
    // marker). HTML still contains `<h2>Accepted items</h2>` → ACCEPTED.
    const html = loadAppleHtml('apple-app-version.eml');
    const out = extractApple(html); // no subject
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
  });

  it('subject says rejection but HTML lacks anchor → outcome=REJECTED, items=[]', () => {
    // Subject is authoritative when it carries the rejection marker —
    // even if the HTML anchor is missing/malformed we classify the
    // outcome correctly. Empty items is the Sentry-visible signal that
    // Apple may have changed the rejection HTML template.
    const html =
      '<html><body><p>Some unrelated rejection variant body.</p></body></html>';
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toEqual([]);
  });

  it('no subject + HTML rejection anchor → outcome=REJECTED (fallback)', () => {
    // Rejection HTML even without subject signal still classifies — the
    // "...resolve the issues..." paragraph is the HTML-side anchor.
    const html = loadAppleHtml('apple-rejection-app-version.eml');
    const out = extractApple(html); // no subject
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].type).toBe('APP_VERSION');
  });

  it('subject says acceptance but HTML has rejection anchor → REJECTED', () => {
    // Defensive: subject doesn't say "issue", h2 absent, but HTML has
    // the rejection paragraph. Falls through h2 → rejection-anchor path.
    const html = loadAppleHtml('apple-rejection-product-page-optimization.eml');
    const out = extractApple(html, 'Review of your Foo submission is complete');
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
  });
});

/* ============================================================================
 * Graceful fallbacks
 * ========================================================================== */

describe('extractApple — graceful fallbacks', () => {
  it('returns null+empty payload for null/undefined/empty input', () => {
    expect(extractApple(null)).toEqual({ outcome: null, items: [] });
    expect(extractApple(undefined)).toEqual({ outcome: null, items: [] });
    expect(extractApple('')).toEqual({ outcome: null, items: [] });
  });

  it('returns null+empty when neither acceptance nor rejection anchor present', () => {
    const html =
      '<html><body><h2>Submission Information</h2><p>some text</p></body></html>';
    const out = extractApple(html);
    expect(out.outcome).toBeNull();
    expect(out.items).toEqual([]);
  });

  it('emits UNKNOWN for an unrecognized heading rather than dropping it', () => {
    const html =
      '<html><body>' +
      '<h2>Accepted items</h2>' +
      '<h3>Future Apple Type</h3>' +
      '<p>some new payload</p>' +
      '</body></html>';
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      type: 'UNKNOWN',
      raw_heading: 'Future Apple Type',
      raw_body: 'some new payload',
    });
  });

  it('skips CTA paragraph when collecting body (anchor presence = stop)', () => {
    const html =
      '<html><body>' +
      '<h2>Accepted items</h2>' +
      '<h3>App Version</h3>' +
      '<p><a href="x">View in App Store Connect</a></p>' +
      '</body></html>';
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].type).toBe('APP_VERSION');
    expect(out.items[0].raw_body).toBe('');
    expect(out.items[0].version).toBeUndefined();
  });

  it('handles multiple accepted items in one email (sequential h3)', () => {
    const html =
      '<html><body>' +
      '<h2>Accepted items</h2>' +
      '<h3>App Version</h3>' +
      '<p>2.0.0 for iOS</p>' +
      '<h3>In-App Events (3)</h3>' +
      '</body></html>';
    const out = extractApple(html);
    expect(out.outcome).toBe('ACCEPTED');
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      type: 'APP_VERSION',
      version: '2.0.0',
      platform: 'iOS',
    });
    expect(out.items[1]).toMatchObject({
      type: 'IN_APP_EVENTS',
      count: 3,
    });
  });

  it('IN_APP_EVENTS with no parens (rejection-style heading) parses with count=undefined', () => {
    // Synthetic rejection-style fragment to lock in the relaxed regex.
    const html =
      '<html><body>' +
      '<p>We look forward to working with you to resolve the issues with the following items:</p>' +
      '<h3>In-App Events</h3>' +
      '<p>some descriptive body</p>' +
      '</body></html>';
    const out = extractApple(html, REJECTION_SUBJECT);
    expect(out.outcome).toBe('REJECTED');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].type).toBe('IN_APP_EVENTS');
    expect(out.items[0].count).toBeUndefined();
    expect(out.items[0].raw_body).toBe('some descriptive body');
  });
});
