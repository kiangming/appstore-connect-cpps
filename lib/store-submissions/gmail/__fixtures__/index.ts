/**
 * Gmail message fixtures for parser tests. Organized by category:
 *
 *   Platform fixtures (realistic shapes we expect in prod):
 *     - appleApproved        multipart/alternative (text + HTML)
 *     - googlePlayUpdate     multipart/alternative (HTML-rich)
 *     - huaweiReview         single-part text/plain
 *     - facebookGameReviewed nested multipart/mixed → multipart/alternative
 *
 *   Edge-case fixtures (stress the parser):
 *     - edgeEmptyBody        subject only, no text body
 *     - edgeHtmlOnly         text/html alone — triggers HTML→text fallback
 *     - edgeVietnameseUtf8   Vietnamese subject + body (multibyte UTF-8)
 *     - edgeMalformedFrom    unterminated `<` — parseAddress rejects
 *     - edgeNestedMultipart  3-level multipart/related → multipart/alternative
 *     - edgeLargeBody        >100KB body — exercises truncation cap
 *     - edgeMissingSubject   no Subject header — defaults to ""
 *     - edgeLatin1Body       charset=ISO-8859-1 (non-UTF8 path)
 *     - edgeQuotedPrintable  Content-Transfer-Encoding: quoted-printable body
 *     - edgeRfc2047Subject   =?UTF-8?B?...?= encoded-word subject
 *     - edgeRfc2047ContinuationSubject  RFC 2047 §6.2 — adjacent encoded-words
 *                            separated by CRLF+WSP (Apple wire form for long
 *                            multibyte subjects). Drives the Layer 1 collapse
 *                            test from PR-14's deferred list.
 *     - edgeMultiRecipientTo comma-separated To header → deduped list
 *     - edgeMissingInternalDate  required field missing — parser throws
 *
 * These are SYNTHETIC. Post-launch: replace with real anonymized samples
 * from the shared mailbox (see TODO.md [PR-7 polish]).
 */

import {
  b64u,
  buildMessage,
  container,
  header,
  leaf,
  type Message,
} from './builders';

/* ============================================================================
 * Platform fixtures
 * ========================================================================== */

export const appleApproved: Message = buildMessage({
  id: 'apple-msg-001',
  threadId: 'apple-thread-001',
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  internalDate: '1713605400000', // 2026-04-20T09:30:00Z
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'submissions@studio.com'),
    header(
      'Subject',
      'Your app "Skyline Runners" status is Ready for Sale',
    ),
    header('Date', 'Fri, 20 Apr 2026 09:30:00 +0000'),
  ],
  payload: container('multipart/alternative', [
    leaf({
      mimeType: 'text/plain',
      body:
        'Hello,\n\n' +
        'The status of your app "Skyline Runners" (version 1.4.2) has changed to Ready for Sale.\n\n' +
        'Apple Developer Team',
    }),
    leaf({
      mimeType: 'text/html',
      body:
        '<html><body><p>Hello,</p>' +
        '<p>The status of your app <b>Skyline Runners</b> (version 1.4.2) has changed to <b>Ready for Sale</b>.</p>' +
        '<p>Apple Developer Team</p></body></html>',
    }),
  ]),
});

export const googlePlayUpdate: Message = buildMessage({
  id: 'gplay-msg-001',
  threadId: 'gplay-thread-001',
  labelIds: ['INBOX'],
  internalDate: '1713608000000',
  envelopeHeaders: [
    header('From', 'Google Play <googleplay-noreply@google.com>'),
    header('To', 'submissions@studio.com'),
    header('Subject', '[Google Play] Update on your submission: "Dragon Guild"'),
    header('Date', 'Fri, 20 Apr 2026 10:13:20 +0000'),
  ],
  payload: container('multipart/alternative', [
    leaf({
      mimeType: 'text/plain',
      body:
        'Your submission for Dragon Guild (com.studio.dragonguild) was approved.\n' +
        'Publishing status: LIVE.\n' +
        'Console link: https://play.google.com/console/u/0/developers/.../app-bundle-explorer',
    }),
    leaf({
      mimeType: 'text/html',
      body:
        '<div style="font-family:Roboto">' +
        '<h2>Submission update</h2>' +
        '<p>Your submission for <strong>Dragon Guild</strong> (com.studio.dragonguild) was <em>approved</em>.</p>' +
        '<p>Publishing status: <b>LIVE</b>.</p>' +
        '<a href="https://play.google.com/console/u/0/developers/">Console link</a>' +
        '</div>',
    }),
  ]),
});

export const huaweiReview: Message = buildMessage({
  id: 'huawei-msg-001',
  threadId: 'huawei-thread-001',
  internalDate: '1713620000000',
  envelopeHeaders: [
    header('From', 'noreply@partner.huawei.com'),
    header('To', 'submissions@studio.com'),
    header('Subject', 'App "Panda Blitz" review status update'),
    header('Date', 'Fri, 20 Apr 2026 13:33:20 +0000'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body:
      'Dear Developer,\n\n' +
      'The review of your app "Panda Blitz" (PackageName: com.studio.pandablitz) has completed.\n' +
      'Result: Approved.\n' +
      'Audit ID: AG-20260420-48321\n\n' +
      'Huawei AppGallery',
  }),
});

export const facebookGameReviewed: Message = buildMessage({
  id: 'fb-msg-001',
  threadId: 'fb-thread-001',
  internalDate: '1713622000000',
  envelopeHeaders: [
    header('From', 'Meta for Developers <notification@facebookmail.com>'),
    header('To', 'submissions@studio.com'),
    header(
      'Subject',
      'Your Instant Game "Puzzle Punch" has been reviewed',
    ),
  ],
  payload: container('multipart/mixed', [
    container('multipart/alternative', [
      leaf({
        mimeType: 'text/plain',
        body:
          'Your Instant Game "Puzzle Punch" (app_id: 123456789012345) has been reviewed.\n' +
          'Decision: REJECTED\n' +
          'Reason: Asset catalog incomplete — please upload required 1200x628 share image.',
      }),
      leaf({
        mimeType: 'text/html',
        body:
          '<table><tr><td>Your Instant Game <strong>Puzzle Punch</strong> (app_id: 123456789012345) has been reviewed.</td></tr>' +
          '<tr><td>Decision: <span style="color:red">REJECTED</span></td></tr>' +
          '<tr><td>Reason: Asset catalog incomplete — please upload required 1200x628 share image.</td></tr></table>',
      }),
    ]),
    // Synthetic attachment part — parser should ignore.
    leaf({
      mimeType: 'application/pdf',
      body: '%PDF-1.4 (fake attachment content)',
      headers: [header('Content-Disposition', 'attachment; filename="review-details.pdf"')],
    }),
  ]),
});

/* ============================================================================
 * Edge cases
 * ========================================================================== */

export const edgeEmptyBody: Message = buildMessage({
  id: 'edge-empty-001',
  threadId: 'edge-empty-t1',
  internalDate: '1713624000000',
  envelopeHeaders: [
    header('From', 'sender@example.com'),
    header('To', 'me@example.com'),
    header('Subject', 'Subject only, no body'),
  ],
  payload: {
    mimeType: 'text/plain',
    headers: [header('Content-Type', 'text/plain; charset=UTF-8')],
    body: { size: 0 }, // no `data` → empty body
  },
});

export const edgeHtmlOnly: Message = buildMessage({
  id: 'edge-html-001',
  threadId: 'edge-html-t1',
  internalDate: '1713625000000',
  envelopeHeaders: [
    header('From', 'newsletter@marketing.example'),
    header('To', 'me@example.com'),
    header('Subject', 'HTML-only newsletter'),
  ],
  payload: leaf({
    mimeType: 'text/html',
    body:
      '<html><body>' +
      '<h1>Weekly digest</h1>' +
      '<p>Here&rsquo;s the <strong>weekly &amp; digest</strong> for your apps.</p>' +
      '<ul><li>Downloads &uarr;12%</li><li>Crashes &darr;3%</li></ul>' +
      '<script>alert("hi")</script>' +
      '<style>body{color:red}</style>' +
      '</body></html>',
  }),
});

export const edgeVietnameseUtf8: Message = buildMessage({
  id: 'edge-vn-001',
  threadId: 'edge-vn-t1',
  internalDate: '1713626000000',
  envelopeHeaders: [
    header('From', 'Đội ngũ App Store <team@appstore.example>'),
    header('To', 'me@example.com'),
    header('Subject', 'App đã được duyệt — "Trò chơi mới"'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body:
      'Xin chào,\n\n' +
      'App của bạn đã được duyệt và sẽ sớm xuất hiện trên App Store.\n' +
      'Tên ứng dụng: Trò chơi mới\n' +
      'Trân trọng,\nĐội ngũ phát triển',
  }),
});

export const edgeMalformedFrom: Message = buildMessage({
  id: 'edge-malformed-001',
  threadId: 'edge-malformed-t1',
  internalDate: '1713627000000',
  envelopeHeaders: [
    header('From', 'John <notanemail'), // unterminated bracket
    header('Subject', 'Malformed From — parser rejects'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: 'Body content doesn\'t matter; parser throws on the From header.',
  }),
});

// 4-level nesting: multipart/related → multipart/alternative → multipart/mixed → text/plain
export const edgeNestedMultipart: Message = buildMessage({
  id: 'edge-nested-001',
  threadId: 'edge-nested-t1',
  internalDate: '1713628000000',
  envelopeHeaders: [
    header('From', 'deep@example.com'),
    header('To', 'me@example.com'),
    header('Subject', 'Deeply nested multipart'),
  ],
  payload: container('multipart/related', [
    container('multipart/alternative', [
      container('multipart/mixed', [
        leaf({
          mimeType: 'text/plain',
          body: 'Deeply nested text body — parser should find this.',
        }),
      ]),
      leaf({
        mimeType: 'text/html',
        body: '<p>HTML alternative at level 2</p>',
      }),
    ]),
    // Inline image (simulated) — ignored.
    leaf({
      mimeType: 'image/png',
      body: 'fake-png-bytes',
      headers: [header('Content-Disposition', 'inline; filename="banner.png"')],
    }),
  ]),
});

export const edgeLargeBody: Message = buildMessage({
  id: 'edge-large-001',
  threadId: 'edge-large-t1',
  internalDate: '1713629000000',
  envelopeHeaders: [
    header('From', 'verbose@example.com'),
    header('To', 'me@example.com'),
    header('Subject', 'Very long body'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    // 100_001 `x`s — crosses the 100_000 char cap by exactly 1.
    body: 'x'.repeat(100_001),
  }),
});

export const edgeMissingSubject: Message = buildMessage({
  id: 'edge-nosubj-001',
  threadId: 'edge-nosubj-t1',
  internalDate: '1713630000000',
  envelopeHeaders: [
    header('From', 'terse@example.com'),
    header('To', 'me@example.com'),
    // No Subject header.
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: 'Body without a subject.',
  }),
});

export const edgeLatin1Body: Message = buildMessage({
  id: 'edge-latin-001',
  threadId: 'edge-latin-t1',
  internalDate: '1713631000000',
  envelopeHeaders: [
    header('From', 'legacy@example.com'),
    header('To', 'me@example.com'),
    header('Subject', 'Latin-1 encoded body'),
  ],
  // "Café — résumé" in latin1. We encode the characters directly.
  payload: leaf({
    mimeType: 'text/plain',
    charset: 'latin1',
    body: 'Café résumé — naïve façade',
  }),
});

// Quoted-printable body: manually construct the `data` so Gmail's base64url
// wraps a quoted-printable payload. Parser must undo the QP encoding.
export const edgeQuotedPrintable: Message = buildMessage({
  id: 'edge-qp-001',
  threadId: 'edge-qp-t1',
  internalDate: '1713632000000',
  envelopeHeaders: [
    header('From', 'qp@example.com'),
    header('To', 'me@example.com'),
    header('Subject', 'Quoted-printable body'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: '', // placeholder — we set preEncodedData below
    transferEncoding: 'quoted-printable',
    preEncodedData: b64u(
      // Raw QP: "Hello=20world=0AWith soft break=\nsame line.\n=C3=A9 e-acute."
      // After QP decode + UTF-8: "Hello world\nWith soft breaksame line.\né e-acute."
      'Hello=20world=0AWith soft break=\nsame line.\n=C3=A9 e-acute.',
      'ascii',
    ),
  }),
});

export const edgeRfc2047Subject: Message = buildMessage({
  id: 'edge-rfc2047-001',
  threadId: 'edge-rfc2047-t1',
  internalDate: '1713633000000',
  envelopeHeaders: [
    header('From', '=?UTF-8?Q?Ph=E1=BA=A1m_Minh?= <minh@example.com>'),
    header('To', 'me@example.com'),
    // "=?UTF-8?B?<base64 of 'App đã được duyệt'>?="
    header(
      'Subject',
      `=?UTF-8?B?${Buffer.from('App đã được duyệt', 'utf-8').toString('base64')}?=`,
    ),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: 'Plain body.',
  }),
});

// RFC 2047 §6.2: adjacent encoded-words separated by linear-white-space
// (CRLF + WSP) collapse on display — the whitespace is ignored. Apple's
// wire form for long multibyte subjects: a single logical phrase split
// across two `=?UTF-8?B?…?=` words because the combined encoded-word
// length would exceed RFC 2047's 75-char-per-word cap.
//
// This fixture mirrors that shape with a Vietnamese app-name template
// ("App đã được duyệt - phần 1" + " phần 2 của tiêu đề dài"). Each part
// is a self-contained UTF-8 string; concatenation after collapse must
// yield "App đã được duyệt - phần 1 phần 2 của tiêu đề dài" — the
// inter-part space comes from the *content* of part2, NOT from the
// separator (which §6.2 mandates we drop).
//
// Pre-PR-18 bug: `decodeRfc2047` ran the per-encoded-word decode pass
// BEFORE the collapse pass, so by the time `\?=\s+=\?` ran the markers
// were gone and orphan "\r\n " leaked into the decoded subject.
export const edgeRfc2047ContinuationSubject: Message = (() => {
  const part1 = Buffer.from('App đã được duyệt - phần 1', 'utf-8').toString('base64');
  const part2 = Buffer.from(' phần 2 của tiêu đề dài', 'utf-8').toString('base64');
  return buildMessage({
    id: 'edge-rfc2047-cont-001',
    threadId: 'edge-rfc2047-cont-t1',
    internalDate: '1713633500000',
    envelopeHeaders: [
      header('From', 'App Store Connect <no_reply@email.apple.com>'),
      header('To', 'me@example.com'),
      // CRLF + single space — the RFC 5322 fold pattern Apple emits for
      // subjects whose encoded-word would exceed 75 chars.
      header('Subject', `=?UTF-8?B?${part1}?=\r\n =?UTF-8?B?${part2}?=`),
    ],
    payload: leaf({
      mimeType: 'text/plain',
      body: 'Plain body.',
    }),
  });
})();

export const edgeMultiRecipientTo: Message = buildMessage({
  id: 'edge-multito-001',
  threadId: 'edge-multito-t1',
  internalDate: '1713634000000',
  envelopeHeaders: [
    header('From', 'blast@example.com'),
    header(
      'To',
      'Alice <alice@example.com>, bob@example.com, "Carol Wu" <carol@example.com>, alice@example.com',
    ),
    header('Subject', 'Blast to multiple recipients'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: 'Message for the team.',
  }),
});

export const edgeMissingInternalDate: Message = (() => {
  const msg = buildMessage({
    id: 'edge-nodate-001',
    threadId: 'edge-nodate-t1',
    envelopeHeaders: [
      header('From', 'nodate@example.com'),
      header('To', 'me@example.com'),
      header('Subject', 'Missing internalDate'),
    ],
    payload: leaf({
      mimeType: 'text/plain',
      body: 'body',
    }),
  });
  delete msg.internalDate;
  return msg;
})();

export const edgeMissingFrom: Message = buildMessage({
  id: 'edge-nofrom-001',
  threadId: 'edge-nofrom-t1',
  internalDate: '1713635000000',
  envelopeHeaders: [
    // No From header.
    header('To', 'me@example.com'),
    header('Subject', 'Missing From'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    body: 'body',
  }),
});

/* ============================================================================
 * PR-14 diagnostic — Apple "QP mislabel" production reproduction
 * ==========================================================================
 *
 * The bug: Apple emits some templates with `Content-Transfer-Encoding:
 * QUOTED-PRINTABLE` headers, but the body bytes are actually raw UTF-8
 * (no `=XX` escapes). Diagnosed via the diagnostic API route on
 * gmail_msg_id=19dd4987eaf7f79d (TICKET-10009, "Đấu Trường Chân Lý").
 *
 * The pre-fix parser hits this path:
 *   1. Reads CTE header → "quoted-printable"
 *   2. Calls `raw.toString('ascii')` to detect QP escapes — but ASCII
 *      decode masks every byte with `& 0x7F`, so UTF-8 lead/continuation
 *      bytes (≥ 0x80) become spurious printable ASCII (e.g. `0xC4` → `D`,
 *      `0xBD` → `=`).
 *   3. The fake `=` byte at position N — followed by CRLF or by two
 *      hex-looking masked bytes — fools the regex
 *      `/=[0-9A-Fa-f]{2}|=\r?\n/`.
 *   4. `decodeQuotedPrintable` runs on the masked-ASCII string and
 *      mangles the data further (soft-breaks dropped, false `=XX`
 *      escapes "decoded").
 *
 * The fixture below mirrors the real-world shape we pulled from Gmail:
 *   - multipart/alternative with text/plain + text/html
 *   - Both parts headered as QUOTED-PRINTABLE
 *   - text/plain body: pure raw UTF-8 (Apple's mislabel for plain text)
 *   - text/html body: mixed — `=3D` for `=` in attributes (real QP) PLUS
 *     raw UTF-8 for the inline app name (the same mislabel)
 *
 * Why the mixed HTML matters: the byte-level decoder must handle BOTH
 * — decode `=3D` correctly AND pass UTF-8 bytes through unchanged. A
 * naive "skip QP entirely if any byte ≥ 0x80" fix would break the
 * `=3D` decode and leave HTML attributes broken.
 *
 * RFC 2047 Q-encoded subject is preserved from the real fixture so the
 * deferred Layer-1 continuation-line bug (PR-15+) stays observable.
 */

// "Đấu Trường Chân Lý" — bytes confirmed via diagnostic hex dump:
//   c4 90  e1 ba a5  75  20  54 72  c6 b0  e1 bb 9d  6e 67  20  43 68
//   c3 a2  6e  20  4c  c3 bd
const TFT_NAME = 'Đấu Trường Chân Lý';

export const edgeAppleMislabelUtf8: Message = buildMessage({
  id: 'apple-mislabel-utf8-001',
  threadId: 'apple-mislabel-t1',
  internalDate: '1777388247000', // 2026-04-28T14:57:27Z (real TICKET-10009 ts)
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'store.admin@vng.com.vn'),
    // Subject is RFC-2047-decoded by a separate code path
    // (`decodeRfc2047`) that does NOT have the ASCII-mask bug. Real
    // production data shows subjects render correctly even when bodies
    // are corrupted, so we use a plain string here — the diagnostic
    // suite's Layer 1 (continuation-line) test is the dedicated probe
    // for the orthogonal RFC-2047 issue and uses its own fixture
    // shape (kept on the deferred PR-15+ list).
    header('Subject', `Review of your ${TFT_NAME} (iOS) submission is complete.`),
    header('Date', 'Tue, 28 Apr 2026 14:57:27 +0000'),
  ],
  payload: container('multipart/alternative', [
    // text/plain — Apple's mislabel: header announces QP, body is raw
    // UTF-8 (zero `=XX` escapes anywhere in the bytes).
    leaf({
      mimeType: 'text/plain',
      transferEncoding: 'QUOTED-PRINTABLE',
      // body field encoded as UTF-8 by the leaf() builder — exactly
      // what Apple actually puts on the wire.
      body:
        'Hello,\r\n\r\n' +
        'Review of your submission has been completed. It is now eligible for distribution.\r\n\r\n' +
        'Submission ID: 2210ae22-9265-4fb2-a361-396bf26787ee\r\n' +
        `App Name: ${TFT_NAME}\r\n\r\n` +
        'Best regards,\r\nApp Store Review',
    }),
    // text/html — mixed: `=3D` in attributes (real QP) PLUS inline raw
    // UTF-8 for the app name (Apple's mislabel for the same name in
    // the same email). preEncodedData lets us hand-craft the byte mix
    // since builders.ts otherwise UTF-8-encodes the whole `body`.
    leaf({
      mimeType: 'text/html',
      transferEncoding: 'QUOTED-PRINTABLE',
      body: '', // ignored when preEncodedData is set
      preEncodedData: b64u(
        Buffer.concat([
          Buffer.from(
            '<html xmlns=3D"http://www.w3.org/1999/xhtml">' +
              '<head><title>Review of your ',
            'utf-8',
          ),
          Buffer.from(TFT_NAME, 'utf-8'), // raw UTF-8 inline
          Buffer.from(
            ' (iOS) submission is complete.</title></head>' +
              '<body><p>App Name: ',
            'utf-8',
          ),
          Buffer.from(TFT_NAME, 'utf-8'), // raw UTF-8 inline (again)
          Buffer.from('</p></body></html>', 'utf-8'),
        ]),
      ),
    }),
  ]),
});

/* ============================================================================
 * PR-14.3 — Apple "QP mislabel" charset coverage
 * ==========================================================================
 *
 * Same mislabel pattern as `edgeAppleMislabelUtf8` (CTE: QUOTED-PRINTABLE
 * header, body bytes raw UTF-8) extended over additional Unicode ranges
 * that production has hit (Q-A diagnostic listed 4 distinct apps;
 * Vietnamese is covered above). Each fixture is minimal — just enough
 * envelope + a body line containing the target string — because the
 * byte-level decoder is one code path: charset coverage is about
 * proving every UTF-8 byte sequence pattern survives the walker, not
 * about exercising the rest of the parser.
 *
 * Byte-pattern stressors per fixture:
 *   - Chinese (CJK BMP): all 3-byte sequences (0xE0–0xEF lead bytes)
 *   - Japanese (mixed scripts): hiragana, katakana, kanji intermixed
 *     with ASCII — exercises the byte-walker's transition between
 *     ≥0x80 pass-through and <0x80 ASCII bytes
 *   - Emoji (supplementary plane): 4-byte sequences (0xF0–0xF4 lead
 *     bytes) — the only fixture that exercises UTF-16 surrogate-pair
 *     production via Buffer.toString('utf-8')
 *   - Mixed-encoding: same character emitted twice in the same body —
 *     once as a genuine QP escape (`=C3=A9` → `é`), once as raw UTF-8
 *     bytes (`0xC3 0xA9` → `é`). Both must decode to the same string.
 */

const CHINESE_NAME = '彈彈英雄';
const JAPANESE_NAME = 'テスト『日本語アプリ』ゲーム';
const EMOJI_NAME = '🎮 Crystal Quest 🐉';

export const edgeAppleMislabelChinese: Message = buildMessage({
  id: 'apple-mislabel-zh-001',
  threadId: 'apple-mislabel-zh-t1',
  internalDate: '1777400000000',
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'store.admin@example.com'),
    header('Subject', `Review of your ${CHINESE_NAME} (iOS) submission is complete.`),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    transferEncoding: 'QUOTED-PRINTABLE',
    body: `App Name: ${CHINESE_NAME}\r\n`,
  }),
});

export const edgeAppleMislabelJapanese: Message = buildMessage({
  id: 'apple-mislabel-ja-001',
  threadId: 'apple-mislabel-ja-t1',
  internalDate: '1777401000000',
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'store.admin@example.com'),
    header('Subject', `Review of your ${JAPANESE_NAME} submission is complete.`),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    transferEncoding: 'QUOTED-PRINTABLE',
    body: `App Name: ${JAPANESE_NAME}\r\n`,
  }),
});

export const edgeAppleMislabelEmoji: Message = buildMessage({
  id: 'apple-mislabel-emoji-001',
  threadId: 'apple-mislabel-emoji-t1',
  internalDate: '1777402000000',
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'store.admin@example.com'),
    header('Subject', `Review of your ${EMOJI_NAME} submission is complete.`),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    transferEncoding: 'QUOTED-PRINTABLE',
    body: `App Name: ${EMOJI_NAME}\r\n`,
  }),
});

// Same body emits `é` twice: once as `=C3=A9` (real QP escape) and once
// as the literal UTF-8 bytes `0xC3 0xA9` (raw, mislabel-style). The
// byte walker must produce identical output for both — `=` triggers
// escape parsing, ≥0x80 bytes pass through.
export const edgeAppleMislabelMixedEncoding: Message = buildMessage({
  id: 'apple-mislabel-mixed-001',
  threadId: 'apple-mislabel-mixed-t1',
  internalDate: '1777403000000',
  envelopeHeaders: [
    header('From', 'App Store Connect <no_reply@email.apple.com>'),
    header('To', 'store.admin@example.com'),
    header('Subject', 'Mixed encoding repro'),
  ],
  payload: leaf({
    mimeType: 'text/plain',
    transferEncoding: 'QUOTED-PRINTABLE',
    body: '', // ignored — preEncodedData drives the bytes
    preEncodedData: b64u(
      Buffer.concat([
        Buffer.from('QP-form: caf', 'utf-8'),   // ASCII
        Buffer.from('=C3=A9', 'ascii'),          // QP escape for é
        Buffer.from('\r\nRaw-form: caf', 'utf-8'),
        Buffer.from([0xc3, 0xa9]),               // Raw UTF-8 for é
        Buffer.from('\r\n', 'utf-8'),
      ]),
    ),
  }),
});
