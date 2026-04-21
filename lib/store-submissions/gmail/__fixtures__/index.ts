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
