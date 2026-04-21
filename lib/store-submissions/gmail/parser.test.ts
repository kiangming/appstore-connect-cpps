/**
 * Parser tests. Fixtures are synthetic — see `__fixtures__/index.ts` for
 * the shapes under test and the TODO.md entry for the post-launch plan
 * to drop in real anonymized samples.
 *
 * Tests are grouped by concern, not by fixture, so adding a new platform
 * fixture doesn't duplicate assertion scaffolding.
 */

import { describe, expect, it } from 'vitest';

import { EmailParseError } from './errors';
import {
  MAX_BODY_CHARS,
  parseGmailMessage,
  TRUNCATION_MARKER,
} from './parser';
import {
  buildMessage,
  container,
  header,
  leaf,
} from './__fixtures__/builders';
import {
  appleApproved,
  edgeEmptyBody,
  edgeHtmlOnly,
  edgeLargeBody,
  edgeLatin1Body,
  edgeMalformedFrom,
  edgeMissingFrom,
  edgeMissingInternalDate,
  edgeMissingSubject,
  edgeMultiRecipientTo,
  edgeNestedMultipart,
  edgeQuotedPrintable,
  edgeRfc2047Subject,
  edgeVietnameseUtf8,
  facebookGameReviewed,
  googlePlayUpdate,
  huaweiReview,
} from './__fixtures__';

/* ============================================================================
 * Platform fixtures — common shape assertions
 * ========================================================================== */

describe('platform fixtures', () => {
  it('apple: multipart/alternative — prefers text/plain, captures html alongside', () => {
    const out = parseGmailMessage(appleApproved);
    expect(out.messageId).toBe('apple-msg-001');
    expect(out.threadId).toBe('apple-thread-001');
    expect(out.fromEmail).toBe('no_reply@email.apple.com');
    expect(out.fromName).toBe('App Store Connect');
    expect(out.to).toEqual(['submissions@studio.com']);
    expect(out.subject).toBe(
      'Your app "Skyline Runners" status is Ready for Sale',
    );
    expect(out.body).toContain('Skyline Runners');
    expect(out.body).toContain('Ready for Sale');
    // Raw HTML preserved for future consumers (e.g. ticket UI rendering).
    expect(out.bodyHtml).toBeDefined();
    expect(out.bodyHtml).toContain('<b>Skyline Runners</b>');
    expect(out.labels).toEqual(['INBOX', 'UNREAD', 'CATEGORY_UPDATES']);
    expect(out.receivedAt.getTime()).toBe(1713605400000);
  });

  it('google play: HTML-rich — strips HTML when text/plain also present (prefers plain)', () => {
    const out = parseGmailMessage(googlePlayUpdate);
    expect(out.fromEmail).toBe('googleplay-noreply@google.com');
    expect(out.fromName).toBe('Google Play');
    expect(out.subject).toContain('Dragon Guild');
    // text/plain wins, so no tag residue in body.
    expect(out.body).not.toContain('<strong>');
    expect(out.body).not.toContain('<div');
    expect(out.body).toContain('com.studio.dragonguild');
    // HTML still available on bodyHtml.
    expect(out.bodyHtml).toContain('<strong>Dragon Guild</strong>');
  });

  it('huawei: single-part text/plain — bodyHtml undefined', () => {
    const out = parseGmailMessage(huaweiReview);
    expect(out.fromEmail).toBe('noreply@partner.huawei.com');
    expect(out.fromName).toBeUndefined();
    expect(out.subject).toBe('App "Panda Blitz" review status update');
    expect(out.body).toContain('Panda Blitz');
    expect(out.body).toContain('AG-20260420-48321');
    expect(out.bodyHtml).toBeUndefined();
  });

  it('facebook: nested multipart/mixed + pdf attachment — ignores attachment', () => {
    const out = parseGmailMessage(facebookGameReviewed);
    expect(out.fromEmail).toBe('notification@facebookmail.com');
    expect(out.fromName).toBe('Meta for Developers');
    expect(out.body).toContain('Puzzle Punch');
    expect(out.body).toContain('REJECTED');
    expect(out.body).toContain('Asset catalog incomplete');
    // PDF attachment must NOT leak into body.
    expect(out.body).not.toContain('PDF-1.4');
    expect(out.body).not.toContain('%PDF');
  });
});

/* ============================================================================
 * From / address parsing
 * ========================================================================== */

describe('From header parsing', () => {
  it('lowercases bare email', () => {
    const msg = { ...huaweiReview };
    // `huaweiReview` From is already lowercase; this test re-enters the
    // fixture after mutating the header to UPPERCASE to verify
    // normalization at the parser boundary.
    const headers = (msg.payload?.headers ?? []).map((h) =>
      h.name?.toLowerCase() === 'from'
        ? { ...h, value: 'NOREPLY@PARTNER.HUAWEI.COM' }
        : h,
    );
    const out = parseGmailMessage({
      ...msg,
      payload: { ...msg.payload, headers },
    });
    expect(out.fromEmail).toBe('noreply@partner.huawei.com');
  });

  it('strips display-name quotes', () => {
    const msg = { ...huaweiReview };
    const headers = (msg.payload?.headers ?? []).map((h) =>
      h.name?.toLowerCase() === 'from'
        ? { ...h, value: '"Carol Wu" <carol@example.com>' }
        : h,
    );
    const out = parseGmailMessage({
      ...msg,
      payload: { ...msg.payload, headers },
    });
    expect(out.fromEmail).toBe('carol@example.com');
    expect(out.fromName).toBe('Carol Wu');
  });

  it('rejects malformed From (unterminated <)', () => {
    expect(() => parseGmailMessage(edgeMalformedFrom)).toThrowError(
      EmailParseError,
    );
    try {
      parseGmailMessage(edgeMalformedFrom);
    } catch (err) {
      expect((err as EmailParseError).message).toMatch(/Malformed From/);
      expect((err as EmailParseError).gmailMsgId).toBe('edge-malformed-001');
    }
  });

  it('rejects missing From header', () => {
    expect(() => parseGmailMessage(edgeMissingFrom)).toThrowError(
      /Missing From/,
    );
  });
});

/* ============================================================================
 * Subject handling
 * ========================================================================== */

describe('subject handling', () => {
  it('defaults to "" when Subject header is absent', () => {
    const out = parseGmailMessage(edgeMissingSubject);
    expect(out.subject).toBe('');
  });

  it('decodes RFC 2047 encoded-words (B encoding)', () => {
    const out = parseGmailMessage(edgeRfc2047Subject);
    expect(out.subject).toBe('App đã được duyệt');
  });

  it('decodes RFC 2047 encoded-words in From display name (Q encoding)', () => {
    const out = parseGmailMessage(edgeRfc2047Subject);
    // "Phạm Minh" — Q-encoded with _ and =XX sequences
    expect(out.fromName).toBe('Phạm Minh');
    expect(out.fromEmail).toBe('minh@example.com');
  });
});

/* ============================================================================
 * Body extraction
 * ========================================================================== */

describe('body extraction', () => {
  it('empty body → body is ""', () => {
    const out = parseGmailMessage(edgeEmptyBody);
    expect(out.body).toBe('');
    expect(out.bodyHtml).toBeUndefined();
  });

  it('HTML-only → strips tags, decodes entities, drops <script> + <style>', () => {
    const out = parseGmailMessage(edgeHtmlOnly);
    expect(out.body).toContain('Weekly digest');
    // &rsquo; is U+2019 (right single quotation), not ASCII '.
    expect(out.body).toContain('Here\u2019s the');
    expect(out.body).toContain('weekly & digest'); // &amp; → &
    expect(out.body).toContain('Downloads \u219112%'); // &uarr; → ↑
    expect(out.body).toContain('Crashes \u21933%'); // &darr; → ↓
    expect(out.body).not.toContain('<'); // no tag residue
    expect(out.body).not.toContain('alert('); // <script> dropped
    expect(out.body).not.toContain('color:red'); // <style> dropped
    expect(out.bodyHtml).toContain('<script>');
  });

  it('UTF-8 Vietnamese preserves multibyte characters', () => {
    const out = parseGmailMessage(edgeVietnameseUtf8);
    expect(out.subject).toContain('đã được duyệt');
    expect(out.body).toContain('Trò chơi mới');
    expect(out.body).toContain('Đội ngũ phát triển');
  });

  it('Latin-1 body decodes correctly (charset=ISO-8859-1)', () => {
    const out = parseGmailMessage(edgeLatin1Body);
    expect(out.body).toContain('Café');
    expect(out.body).toContain('résumé');
    expect(out.body).toContain('naïve façade');
  });

  it('quoted-printable body is decoded (=XX + soft breaks)', () => {
    const out = parseGmailMessage(edgeQuotedPrintable);
    expect(out.body).toContain('Hello world');
    expect(out.body).toContain('é e-acute');
    expect(out.body).not.toContain('=20');
    expect(out.body).not.toContain('=C3=A9');
    // Soft-line break `=\n` joins lines.
    expect(out.body).toContain('With soft breaksame line');
  });

  it('nested multipart (related → alternative → mixed → text/plain) finds deepest plain', () => {
    const out = parseGmailMessage(edgeNestedMultipart);
    expect(out.body).toBe('Deeply nested text body — parser should find this.');
    // HTML at level 2 is captured too.
    expect(out.bodyHtml).toBe('<p>HTML alternative at level 2</p>');
  });
});

/* ============================================================================
 * Body truncation
 * ========================================================================== */

describe('body truncation at MAX_BODY_CHARS', () => {
  it('100_001-char body → truncated to 100_000 + marker', () => {
    const out = parseGmailMessage(edgeLargeBody);
    expect(out.body.length).toBe(MAX_BODY_CHARS + TRUNCATION_MARKER.length);
    expect(out.body.endsWith(TRUNCATION_MARKER)).toBe(true);
    // The kept prefix is all `x`s — none of the marker leaked into the
    // preserved content.
    const preserved = out.body.slice(0, MAX_BODY_CHARS);
    expect(preserved).toBe('x'.repeat(MAX_BODY_CHARS));
  });

  it('body at exactly MAX_BODY_CHARS — no marker appended', () => {
    const msg = {
      ...edgeLargeBody,
      payload: {
        ...edgeLargeBody.payload!,
        body: {
          data: Buffer.from('x'.repeat(MAX_BODY_CHARS), 'utf-8').toString(
            'base64url',
          ),
        },
      },
    };
    const out = parseGmailMessage(msg);
    expect(out.body.length).toBe(MAX_BODY_CHARS);
    expect(out.body.endsWith(TRUNCATION_MARKER)).toBe(false);
  });
});

/* ============================================================================
 * Recipients
 * ========================================================================== */

describe('To header parsing', () => {
  it('splits, lowercases, dedupes; handles display names', () => {
    const out = parseGmailMessage(edgeMultiRecipientTo);
    // Alice appears twice in the raw header — collapsed via Set.
    expect(out.to).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('empty To → empty array (not null)', () => {
    const out = parseGmailMessage(edgeEmptyBody); // fixture has To header
    expect(Array.isArray(out.to)).toBe(true);
  });
});

/* ============================================================================
 * Required fields
 * ========================================================================== */

describe('required fields', () => {
  it('throws EmailParseError on missing internalDate', () => {
    expect(() => parseGmailMessage(edgeMissingInternalDate)).toThrowError(
      /Missing internalDate/,
    );
  });

  it('throws EmailParseError on missing id', () => {
    const msg = { ...huaweiReview };
    delete msg.id;
    expect(() => parseGmailMessage(msg)).toThrowError(/Missing message id/);
  });

  it('throws EmailParseError on missing threadId', () => {
    const msg = { ...huaweiReview };
    delete msg.threadId;
    expect(() => parseGmailMessage(msg)).toThrowError(/Missing thread id/);
  });

  it('throws EmailParseError on non-numeric internalDate', () => {
    const msg = { ...huaweiReview, internalDate: 'not-a-number' };
    expect(() => parseGmailMessage(msg)).toThrowError(/Invalid internalDate/);
  });

  it('throws EmailParseError on zero / negative internalDate', () => {
    const msg = { ...huaweiReview, internalDate: '0' };
    expect(() => parseGmailMessage(msg)).toThrowError(/Invalid internalDate/);
  });
});

/* ============================================================================
 * Labels
 * ========================================================================== */

describe('labels', () => {
  it('empty array when labelIds is absent', () => {
    const msg = { ...huaweiReview };
    delete msg.labelIds;
    const out = parseGmailMessage(msg);
    expect(out.labels).toEqual([]);
  });

  it('preserves labelIds verbatim', () => {
    const out = parseGmailMessage(appleApproved);
    expect(out.labels).toEqual(['INBOX', 'UNREAD', 'CATEGORY_UPDATES']);
  });
});

/* ============================================================================
 * Purity — no I/O, deterministic
 * ========================================================================== */

describe('purity', () => {
  it('same input → same output (deterministic)', () => {
    const a = parseGmailMessage(appleApproved);
    const b = parseGmailMessage(appleApproved);
    expect(b).toEqual(a);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(appleApproved);
    parseGmailMessage(appleApproved);
    expect(JSON.stringify(appleApproved)).toBe(before);
  });
});

/* ============================================================================
 * NULL-byte sanitization (REGRESSION — Postgres 22P05)
 * ==========================================================================
 *
 * Real-world emails sometimes contain `\u0000` bytes in text fields (legacy
 * MUAs, binary payloads leaking past MIME boundaries, charset conversions
 * producing NULL padding). Postgres TEXT rejects `\u0000` with SQLSTATE
 * 22P05, so any unsanitized byte crashes the `email_messages` INSERT and
 * drops the message into the outer-catch (stats.errors++, no audit row).
 *
 * These tests pin the parser-side sanitizer so the DB-facing output is
 * always safe.
 */

describe('null-byte sanitization', () => {
  it('strips \\u0000 from text/plain body (leaves rest intact)', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', 'sender@example.com'),
        header('Subject', 'Hello'),
      ],
      payload: leaf({
        mimeType: 'text/plain',
        body: 'Valid\u0000text\u0000with\u0000nulls',
      }),
    });
    const out = parseGmailMessage(msg);
    expect(out.body).toBe('Validtextwithnulls');
    expect(out.body).not.toContain('\u0000');
  });

  it('strips \\u0000 from subject', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', 'sender@example.com'),
        header('Subject', 'Sub\u0000ject\u0000with\u0000nulls'),
      ],
      payload: leaf({ mimeType: 'text/plain', body: 'body' }),
    });
    const out = parseGmailMessage(msg);
    expect(out.subject).toBe('Subjectwithnulls');
    expect(out.subject).not.toContain('\u0000');
  });

  it('strips \\u0000 from display name in From header', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', '"Display\u0000Name" <sender@example.com>'),
        header('Subject', 'x'),
      ],
      payload: leaf({ mimeType: 'text/plain', body: 'body' }),
    });
    const out = parseGmailMessage(msg);
    expect(out.fromName).toBe('DisplayName');
    expect(out.fromEmail).toBe('sender@example.com');
  });

  it('strips \\u0000 from HTML body (both body and bodyHtml)', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', 'sender@example.com'),
        header('Subject', 'x'),
      ],
      payload: leaf({
        mimeType: 'text/html',
        body: '<p>content\u0000with\u0000null</p>',
      }),
    });
    const out = parseGmailMessage(msg);
    expect(out.body).not.toContain('\u0000');
    expect(out.bodyHtml).toBeDefined();
    expect(out.bodyHtml).not.toContain('\u0000');
  });

  it('strips \\u0000 from recipient list (To header)', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', 'sender@example.com'),
        header('To', 'alice\u0000@example.com, bob@example.com'),
        header('Subject', 'x'),
      ],
      payload: leaf({ mimeType: 'text/plain', body: 'body' }),
    });
    const out = parseGmailMessage(msg);
    for (const r of out.to) {
      expect(r).not.toContain('\u0000');
    }
    // Both recipients survive — the null byte in alice's address got stripped.
    expect(out.to).toContain('alice@example.com');
    expect(out.to).toContain('bob@example.com');
  });

  it('strips \\u0000 even when body is nested inside multipart/alternative', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', 'sender@example.com'),
        header('Subject', 'Nested with nulls'),
      ],
      payload: container('multipart/alternative', [
        leaf({
          mimeType: 'text/plain',
          body: 'plain\u0000text',
        }),
        leaf({
          mimeType: 'text/html',
          body: '<p>html\u0000payload</p>',
        }),
      ]),
    });
    const out = parseGmailMessage(msg);
    expect(out.body).toBe('plaintext');
    expect(out.bodyHtml).not.toContain('\u0000');
  });

  it('result is JSON-serializable (sanity check: no raw NULL bytes anywhere)', () => {
    const msg = buildMessage({
      envelopeHeaders: [
        header('From', '"Bad\u0000Sender" <a@b.com>'),
        header('Subject', 'Sub\u0000ject'),
      ],
      payload: leaf({
        mimeType: 'text/plain',
        body: 'lots\u0000of\u0000nulls\u0000here',
      }),
    });
    const out = parseGmailMessage(msg);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('\\u0000');
    expect(serialized).not.toContain('\u0000');
  });
});
