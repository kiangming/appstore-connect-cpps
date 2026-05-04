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
  decodeRfc2047,
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
  edgeAppleMislabelChinese,
  edgeAppleMislabelEmoji,
  edgeAppleMislabelJapanese,
  edgeAppleMislabelMixedEncoding,
  edgeAppleMislabelUtf8,
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
  edgeRfc2047ContinuationSubject,
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
 * PR-14 — Apple "QP mislabel" decode regression
 * ==========================================================================
 *
 * Production bug discovered via diagnostic API route on TICKET-10009
 * (gmail_msg_id=19dd4987eaf7f79d, app "Đấu Trường Chân Lý"). Apple emits
 * `Content-Transfer-Encoding: QUOTED-PRINTABLE` headers for parts whose
 * body bytes are actually raw UTF-8 — no `=XX` escapes anywhere in the
 * bytes. The pre-fix parser's `raw.toString('ascii')` step masks UTF-8
 * lead/continuation bytes with `& 0x7F`, producing spurious `=` and
 * control bytes that fool the QP-detection regex; `decodeQuotedPrintable`
 * then mangles the data further.
 *
 * Concrete trace from the production message: byte `0xBD` (tail of `ý`)
 * masks to `0x3D` (`=`); the following `\r\n` triggers the `/=\r?\n/`
 * branch of the detect regex; QP "soft-break removal" drops bytes; the
 * "decoded" string surfaces as `D\u0010a:%u TrF0a;\u001dng ChC"n L`.
 *
 * The fix (14.2) replaces the string-keyed decoder with a byte-keyed
 * walker that operates on the raw `Buffer` — bytes ≥ 0x80 pass through
 * unchanged so mislabeled UTF-8 is preserved, while genuine `=XX` /
 * `=\r?\n` escapes are still decoded for legitimately-QP-encoded bodies.
 *
 *   Layer 1 (subject):   RFC 2047 continuation-line collapse  [PR-18]
 *   Layer 2 (bodyHtml):  mixed `=3D` + raw UTF-8 (Apple's HTML shape)
 *   Layer 3 (body):      pure raw UTF-8 mislabeled as QP
 *   Layer 4 (excerpt):   500-char JS slice of decoded body
 *
 * Layer 1 was deferred on PR-14 and resolved in PR-18: `decodeRfc2047`
 * was running per-encoded-word decode BEFORE the collapse pass, so the
 * `?=` / `=?` markers were consumed first and the collapse regex
 * `\?=\s+=\?` ran on a string that no longer contained them — orphan
 * "\r\n " from the RFC 5322 fold leaked into the decoded subject. PR-18
 * swaps the order: collapse first (markers preserved), decode second.
 */

describe('PR-14 — Apple mislabeled QP body decodes correctly', () => {
  // Split into one `it` per layer so a regression on one stage doesn't
  // mask another. The mislabel fixture has identical bytes Apple sent
  // to TICKET-10009 — passes mean the byte-level decoder handles
  // production data; failures localize to the exact decode stage.

  it('layer 1 — subject: RFC 2047 continuation-line collapse (PR-18)', () => {
    // Apple wire form: a single logical phrase split across two
    // `=?UTF-8?B?…?=` words because the combined encoded-word would
    // exceed RFC 2047's 75-char-per-word cap. The fixture's two parts
    // decode to "App đã được duyệt - phần 1" and " phần 2 của tiêu
    // đề dài" — note the leading space on part 2 is *content*, not the
    // CRLF+WSP separator (which §6.2 mandates we drop).
    const out = parseGmailMessage(edgeRfc2047ContinuationSubject);
    expect(out.subject).toBe('App đã được duyệt - phần 1 phần 2 của tiêu đề dài');
    // Pre-PR-18 fingerprint: `\r\n ` between the two decoded parts —
    // the fold separator leaking through because the per-word decode
    // ran before the collapse pass and consumed the `?=`/`=?` markers
    // the collapse regex needed.
    expect(out.subject).not.toMatch(/\r|\n/);
    expect(out.subject).not.toMatch(/\s{2,}/);
  });

  it('layer 2 — bodyHtml: mixed `=3D` attribute escapes + inline raw UTF-8', () => {
    const out = parseGmailMessage(edgeAppleMislabelUtf8);
    expect(out.bodyHtml).toBeDefined();
    // Apple's mislabel: app name written as raw UTF-8 inside HTML even
    // though the part is announced as QP. Byte-level decoder must
    // pass these bytes through unchanged.
    expect(out.bodyHtml!).toContain('Đấu Trường Chân Lý');
    // …while still decoding genuine `=3D` attribute escapes that share
    // the same body. A "skip QP if any byte ≥ 0x80" shortcut would
    // leave `xmlns=3D"…"` in the output and fail the next assertion.
    expect(out.bodyHtml!).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(out.bodyHtml!).not.toContain('xmlns=3D');
    // No control-byte residue from a false-positive QP false-decode.
    expect(out.bodyHtml!).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it('layer 3 — body: pure raw UTF-8 mislabeled as QP (the production failure mode)', () => {
    const out = parseGmailMessage(edgeAppleMislabelUtf8);
    // body is what sync.ts persists as email_messages.raw_body_text and
    // what the SQL RPC slices into ticket_entries snapshot.body_excerpt.
    expect(out.body).toContain('Đấu Trường Chân Lý');
    expect(out.body).toContain('App Name: Đấu Trường Chân Lý');
    // Pre-fix output contained `D\u0010a:%u TrF0a;\u001dng ChC"n L` —
    // mask any control-byte residue.
    expect(out.body).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
    expect(out.body).not.toContain('Da:%u');
  });

  it('layer 4 — 500-char excerpt: UTF-8 codepoints preserved through JS slice', () => {
    const out = parseGmailMessage(edgeAppleMislabelUtf8);
    const excerpt = out.body.slice(0, 500);
    expect(excerpt).toContain('Đấu Trường Chân Lý');
    expect(excerpt).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
  });
});

/* ============================================================================
 * PR-14.3 — Charset coverage (CJK + emoji + mixed encoding)
 * ==========================================================================
 *
 * Same mislabel pattern as Layer 3 above, exercised across the byte
 * ranges production has hit. The shared assertion shape: target name
 * decodes verbatim, no control-byte residue (the pre-fix corruption
 * fingerprint), no `=XX` escape leakage. One `it` per fixture so a
 * regression on one charset doesn't mask the others.
 */

describe('PR-14.3 — byte-level decoder charset coverage', () => {
  it('Chinese (3-byte UTF-8 sequences, 0xE0–0xEF lead bytes)', () => {
    const out = parseGmailMessage(edgeAppleMislabelChinese);
    expect(out.body).toContain('彈彈英雄');
    expect(out.body).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
    expect(out.body).not.toMatch(/=[0-9A-F]{2}/i);
  });

  it('Japanese mixed scripts (hiragana + katakana + kanji + ASCII transitions)', () => {
    const out = parseGmailMessage(edgeAppleMislabelJapanese);
    expect(out.body).toContain('テスト『日本語アプリ』ゲーム');
    expect(out.body).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
    expect(out.body).not.toMatch(/=[0-9A-F]{2}/i);
  });

  it('Emoji (4-byte UTF-8 sequences → UTF-16 surrogate pairs)', () => {
    const out = parseGmailMessage(edgeAppleMislabelEmoji);
    expect(out.body).toContain('🎮 Crystal Quest 🐉');
    // Emoji are length-2 in JS strings (surrogate pair); confirm both
    // halves of 🎮 (U+1F3AE) survived the byte→string conversion.
    expect(out.body).toContain('\uD83C\uDFAE');
    expect(out.body).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it('mixed encoding: `=C3=A9` (real QP) and raw UTF-8 `0xC3 0xA9` decode identically to `é`', () => {
    const out = parseGmailMessage(edgeAppleMislabelMixedEncoding);
    expect(out.body).toContain('QP-form: café');
    expect(out.body).toContain('Raw-form: café');
    expect(out.body).not.toMatch(/=[0-9A-F]{2}/i);
    expect(out.body).not.toMatch(/[\x01-\x08\x0B\x0C\x0E-\x1F]/);
  });
});

/* ============================================================================
 * PR-18 — RFC 2047 continuation-line collapse edge cases
 * ==========================================================================
 *
 * Layer 1 of the PR-14 deferred list. The integration test above
 * (`PR-14 layer 1`) covers the Apple-realistic Vietnamese subject end
 * to end through `parseGmailMessage`. The cases below probe the
 * decoder directly so a regression on collapse semantics localizes to
 * `decodeRfc2047` instead of cascading through fixture construction.
 *
 *   Test 2: single-space separator (Gmail API's typical unfolded form)
 *   Test 3: mixed B + Q encodings adjacent (collapse is encoding-agnostic)
 *   Test 4: encoded-word adjacent to plain text — whitespace MUST
 *           survive (regression guard for the `\?=\s+=\?` boundary)
 */

describe('PR-18 — RFC 2047 continuation-line collapse', () => {
  it('single-space separator between adjacent encoded-words is collapsed', () => {
    // Gmail's API generally pre-unfolds RFC 5322 folds to a single space.
    // §6.2 still says drop it — the space is the fold residue, not content.
    const part1 = Buffer.from('Hello', 'utf-8').toString('base64');
    const part2 = Buffer.from('World', 'utf-8').toString('base64');
    const input = `=?UTF-8?B?${part1}?= =?UTF-8?B?${part2}?=`;
    expect(decodeRfc2047(input)).toBe('HelloWorld');
  });

  it('mixed B and Q encodings adjacent — collapse is encoding-agnostic', () => {
    // Real Apple subjects sometimes mix encodings across continuation
    // segments. The collapse regex matches on `?=…=?` markers only, so
    // it doesn't care whether B or Q sits inside.
    const part1 = `=?UTF-8?B?${Buffer.from('Hello', 'utf-8').toString('base64')}?=`;
    const part2 = '=?UTF-8?Q?World?=';
    const input = `${part1}\r\n ${part2}`;
    expect(decodeRfc2047(input)).toBe('HelloWorld');
  });

  it('whitespace between encoded-word and plain text is preserved', () => {
    // Critical regression guard. The collapse regex is `\?=\s+=\?` —
    // it requires `=?…?=` boundaries on BOTH sides. A plain-text run
    // following an encoded-word has no `=?` opener, so the regex won't
    // match and the surrounding whitespace stays put. If someone ever
    // loosens this regex the assertion below catches it.
    const part1 = `=?UTF-8?B?${Buffer.from('Hello', 'utf-8').toString('base64')}?=`;
    expect(decodeRfc2047(`${part1} World`)).toBe('Hello World');
    // Symmetric case: plain text → encoded-word.
    expect(decodeRfc2047(`Hello ${part1}`)).toBe('Hello Hello');
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
