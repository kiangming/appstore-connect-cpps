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

describe('extractApple — fixture parses', () => {
  it('App Version: extracts version + platform', () => {
    const html = loadAppleHtml('apple-app-version.eml');
    const out = extractApple(html);
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0]).toMatchObject({
      type: 'APP_VERSION',
      version: '1.0.13',
      platform: 'iOS',
    });
    expect(out.accepted_items[0].raw_heading.trim()).toBe('App Version');
  });

  it('In-App Events: extracts count from heading, no body', () => {
    const html = loadAppleHtml('apple-in-app-events.eml');
    const out = extractApple(html);
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0]).toMatchObject({
      type: 'IN_APP_EVENTS',
      count: 5,
    });
    // No body paragraph for this variant — the count lives in the heading.
    expect(out.accepted_items[0].raw_body).toBe('');
  });

  it('Custom Product Pages: extracts name + uuid from <br>-separated body', () => {
    const html = loadAppleHtml('apple-custom-product-pages.eml');
    const out = extractApple(html);
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0]).toMatchObject({
      type: 'CUSTOM_PRODUCT_PAGE',
      name: 'CPP 2004',
      uuid: 'e2232a07-7cdb-4418-bf62-77ad22da36dc',
    });
    // Apple's heading carries a trailing space — preserve raw, trim semantically.
    expect(out.accepted_items[0].raw_heading).toMatch(/Custom Product Pages\s*$/);
  });

  it('Product Page Optimization: extracts numeric version code', () => {
    const html = loadAppleHtml('apple-product-page-optimization.eml');
    const out = extractApple(html);
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0]).toMatchObject({
      type: 'PRODUCT_PAGE_OPTIMIZATION',
      version_code: '230426',
    });
  });
});

describe('extractApple — graceful fallbacks', () => {
  it('returns empty payload for null/undefined/empty input', () => {
    expect(extractApple(null).accepted_items).toEqual([]);
    expect(extractApple(undefined).accepted_items).toEqual([]);
    expect(extractApple('').accepted_items).toEqual([]);
  });

  it('returns empty payload when "Accepted items" section is absent', () => {
    const html =
      '<html><body><h2>Submission Information</h2><p>some text</p></body></html>';
    expect(extractApple(html).accepted_items).toEqual([]);
  });

  it('emits UNKNOWN for an unrecognized heading rather than dropping it', () => {
    const html =
      '<html><body>' +
      '<h2>Accepted items</h2>' +
      '<h3>Future Apple Type</h3>' +
      '<p>some new payload</p>' +
      '</body></html>';
    const out = extractApple(html);
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0]).toMatchObject({
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
    expect(out.accepted_items).toHaveLength(1);
    expect(out.accepted_items[0].type).toBe('APP_VERSION');
    expect(out.accepted_items[0].raw_body).toBe('');
    expect(out.accepted_items[0].version).toBeUndefined();
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
    expect(out.accepted_items).toHaveLength(2);
    expect(out.accepted_items[0]).toMatchObject({
      type: 'APP_VERSION',
      version: '2.0.0',
      platform: 'iOS',
    });
    expect(out.accepted_items[1]).toMatchObject({
      type: 'IN_APP_EVENTS',
      count: 3,
    });
  });
});
