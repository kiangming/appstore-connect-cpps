/**
 * Pure Gmail message → `ParsedEmail` parser.
 *
 * **No I/O.** Input is a `gmail_v1.Schema$Message` JSON object returned by
 * `gmail.users.messages.get({format: 'full'})`; output is the trimmed
 * shape the sync orchestrator + classifier consume. No network, no DB,
 * no logging, no env reads.
 *
 * The input shape is stable (Gmail API v1) so we do NOT depend on an
 * external MIME parser. `mailparser` + friends target RFC 822 raw
 * strings — Gmail gives us a pre-parsed tree of parts with base64url'd
 * bodies, so a ~200-line recursive walker is the right tool.
 *
 * Contract:
 *   - Deterministic. Same message → same `ParsedEmail` every run.
 *   - Total. Every input that passes the required-field checks returns
 *     a value; only malformed required fields (missing id/threadId/
 *     internalDate/From, or unparseable From) throw `EmailParseError`.
 *   - Body ≤ 100_000 characters. Past that cap we slice + append a
 *     truncation marker so downstream code (classifier, DB insert) has
 *     a hard upper bound.
 *   - `fromEmail` is lowercased; classifier matches sender regexes
 *     case-insensitively but we normalize at the boundary so the
 *     sender-matcher never needs to second-guess the caller.
 */

import type { gmail_v1 } from 'googleapis';

import { EmailParseError } from './errors';

export interface ParsedEmail {
  messageId: string;
  threadId: string;
  /** Lowercased, `<...>`-stripped email address. Never empty. */
  fromEmail: string;
  /** Display name if one was present in the `From` header. */
  fromName?: string;
  /** Lowercased recipient emails, deduped. Empty array when `To` is absent. */
  to: string[];
  /** Subject, RFC-2047-decoded. `""` when absent. */
  subject: string;
  /**
   * Decoded body text. Preference order:
   *   1. `text/plain` part (decoded verbatim).
   *   2. `text/html` part (HTML tags stripped, entities decoded).
   *   3. `""` when neither is present.
   * Always ≤ 100_000 characters. If the original exceeded the cap we
   * append `TRUNCATION_MARKER` so downstream callers can detect it.
   */
  body: string;
  /** Raw HTML body (untrimmed) when a `text/html` part was present. */
  bodyHtml?: string;
  /** `new Date(+msg.internalDate)` — the time Gmail received the email. */
  receivedAt: Date;
  /** `msg.labelIds` verbatim, or `[]` when absent. */
  labels: string[];
}

/** Hard cap on body length (characters, post-decode). See `ParsedEmail.body`. */
export const MAX_BODY_CHARS = 100_000;

/** Appended when we slice a body that exceeds `MAX_BODY_CHARS`. */
export const TRUNCATION_MARKER = '\n\n[... truncated at 100KB]';

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function parseGmailMessage(msg: gmail_v1.Schema$Message): ParsedEmail {
  // Required identifiers — without these the orchestrator can't dedupe or
  // correlate, so fail loudly rather than persisting a ghost row.
  const messageId = msg.id;
  if (!messageId) {
    throw new EmailParseError('<unknown>', 'Missing message id');
  }
  const threadId = msg.threadId;
  if (!threadId) {
    throw new EmailParseError(messageId, 'Missing thread id');
  }

  // internalDate is Gmail's ingestion timestamp (ms since epoch, as a
  // string). Required for `email_messages.received_at`, which is NOT NULL.
  const internalDateRaw = msg.internalDate;
  if (!internalDateRaw) {
    throw new EmailParseError(messageId, 'Missing internalDate');
  }
  const internalDateMs = Number(internalDateRaw);
  if (!Number.isFinite(internalDateMs) || internalDateMs <= 0) {
    throw new EmailParseError(
      messageId,
      `Invalid internalDate: ${internalDateRaw}`,
    );
  }
  const receivedAt = new Date(internalDateMs);

  // Headers live on the top-level payload only (child parts carry their
  // own MIME headers, not the envelope). Missing headers array → treat
  // as empty.
  const envelopeHeaders = buildHeaderMap(msg.payload?.headers);

  // From is required for sender→platform resolution. Malformed From is a
  // terminal parse error for this message; the orchestrator will mark it
  // classification_status='ERROR' and continue the batch.
  const rawFrom = envelopeHeaders.get('from');
  if (!rawFrom) {
    throw new EmailParseError(messageId, 'Missing From header');
  }
  let fromEmail: string;
  let fromName: string | undefined;
  try {
    const parsed = parseAddress(decodeRfc2047(rawFrom));
    fromEmail = parsed.email;
    fromName = parsed.name;
  } catch (err) {
    throw new EmailParseError(
      messageId,
      `Malformed From header: ${rawFrom}`,
      err,
    );
  }

  const subject = decodeRfc2047(envelopeHeaders.get('subject') ?? '');
  const to = parseToHeader(envelopeHeaders.get('to'));

  // Body walk — returns the text/plain (if any) + text/html (if any). The
  // orchestrator gets both; classifier receives only `body`.
  const { text, html } = extractBody(msg.payload ?? null);

  let body: string;
  if (text) {
    body = text;
  } else if (html) {
    body = stripHtmlToText(html);
  } else {
    body = '';
  }

  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARKER;
  }

  return {
    messageId,
    threadId,
    fromEmail,
    fromName,
    to,
    subject,
    body,
    bodyHtml: html ? html : undefined,
    receivedAt,
    labels: msg.labelIds ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Headers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a Map<lowercase-header-name, last-value> from Gmail's headers
 * array. We keep only the last occurrence when duplicates appear — Gmail
 * practice is single-valued headers for the ones we read (From, To,
 * Subject, Date, Content-Type, Content-Transfer-Encoding).
 */
function buildHeaderMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!headers) return m;
  for (const h of headers) {
    if (h.name && h.value !== undefined && h.value !== null) {
      m.set(h.name.toLowerCase(), h.value);
    }
  }
  return m;
}

/** Split a `To:` header into lowercased, deduped addresses. */
function parseToHeader(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  // Comma-split is good enough for the fanout cases we care about. Names
  // that legitimately contain commas (quoted) are rare in automated
  // submission notifications — punt on that until a fixture proves it.
  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    try {
      const { email } = parseAddress(decodeRfc2047(trimmed));
      if (email) out.add(email);
    } catch {
      // Skip unparseable recipients rather than failing the whole
      // message — `To:` is informational here (not used for routing).
    }
  }
  return [...out];
}

/* -------------------------------------------------------------------------- */
/* Address parsing                                                            */
/* -------------------------------------------------------------------------- */

interface Address {
  email: string;
  name?: string;
}

/**
 * Accept the three forms we actually see:
 *   - `"Name" <email@host>` / `Name <email@host>`
 *   - `<email@host>`
 *   - `email@host`
 *
 * An unterminated `<` or a missing `@` is a hard error — upstream catches
 * and emits `EmailParseError`.
 */
function parseAddress(raw: string): Address {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty address');

  // Bracketed form
  const m = trimmed.match(/^(.*?)<\s*([^>\s]+@[^>\s]+)\s*>(.*)$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, '').trim();
    return {
      email: m[2].trim().toLowerCase(),
      name: name || undefined,
    };
  }

  // Unterminated bracket — reject rather than guess.
  if (trimmed.includes('<') && !trimmed.includes('>')) {
    throw new Error(`unterminated angle bracket: ${trimmed}`);
  }

  // Bare email — no whitespace allowed in the middle of an email.
  if (/^[^\s]+@[^\s]+$/.test(trimmed)) {
    return { email: trimmed.toLowerCase() };
  }

  throw new Error(`not a recognizable email: ${trimmed}`);
}

/* -------------------------------------------------------------------------- */
/* RFC 2047 header decoding                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decode `=?charset?encoding?data?=` encoded-words in a header value.
 * Gmail usually delivers pre-decoded headers, but we apply defensively —
 * the decoder is a no-op on already-plain strings.
 *
 * Only supports the two transfer encodings RFC 2047 defines: B (base64)
 * and Q (quoted-printable-ish, with `_` = space).
 */
function decodeRfc2047(s: string): string {
  if (!s.includes('=?')) return s;
  return s
    .replace(
      /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g,
      (_m, charset: string, encoding: string, data: string) => {
        try {
          const enc = normalizeCharset(charset);
          if (encoding.toUpperCase() === 'B') {
            return Buffer.from(data, 'base64').toString(enc);
          }
          // Q encoding: `_` → space, `=XX` → byte
          const bytes: number[] = [];
          const replaced = data.replace(/_/g, ' ');
          for (let i = 0; i < replaced.length; i++) {
            if (replaced[i] === '=' && i + 2 < replaced.length) {
              const hex = replaced.slice(i + 1, i + 3);
              if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
                continue;
              }
            }
            bytes.push(replaced.charCodeAt(i));
          }
          return Buffer.from(bytes).toString(enc);
        } catch {
          // Malformed encoded-word: keep the original text, don't throw —
          // From-header malformation has its own path via `parseAddress`.
          return data;
        }
      },
    )
    // RFC 2047 §5: CRLF + whitespace between adjacent encoded-words should
    // be collapsed. Harmless on non-encoded input.
    .replace(/\?=\s+=\?/g, '?==?');
}

/* -------------------------------------------------------------------------- */
/* Body extraction                                                            */
/* -------------------------------------------------------------------------- */

interface BodyPair {
  text: string;
  html: string;
}

function extractBody(payload: gmail_v1.Schema$MessagePart | null): BodyPair {
  const out: BodyPair = { text: '', html: '' };
  if (!payload) return out;

  // Depth-first pre-order walk. First text/plain wins; first text/html
  // wins. Attachments (application/*, image/*) are skipped by the MIME
  // gate below.
  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    const mime = (part.mimeType ?? '').toLowerCase();

    if (part.parts && part.parts.length > 0) {
      for (const child of part.parts) {
        visit(child);
        if (out.text && out.html) return;
      }
      return;
    }

    // Leaf part.
    const data = part.body?.data;
    if (!data) return;

    if (mime === 'text/plain' && !out.text) {
      out.text = decodePartBody(part);
    } else if (mime === 'text/html' && !out.html) {
      out.html = decodePartBody(part);
    }
  };

  visit(payload);
  return out;
}

function decodePartBody(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (!data) return '';

  const partHeaders = buildHeaderMap(part.headers);
  const contentType = partHeaders.get('content-type') ?? '';
  const charset = extractCharset(contentType);
  const transfer = (partHeaders.get('content-transfer-encoding') ?? '')
    .toLowerCase()
    .trim();

  // Gmail wraps every leaf body in base64url regardless of the original
  // transfer encoding. After base64url decode we have the "raw" bytes
  // Gmail's MIME parser produced — which, in the common case, are the
  // already-decoded payload. If Gmail *didn't* decode (rare), the bytes
  // may still be quoted-printable; we defensively apply the QP decoder
  // when the transfer encoding header announces it.
  const raw = Buffer.from(data, 'base64url');

  if (transfer === 'quoted-printable') {
    const asAscii = raw.toString('ascii');
    if (/=[0-9A-Fa-f]{2}|=\r?\n/.test(asAscii)) {
      return decodeQuotedPrintable(asAscii, charset);
    }
  }

  return raw.toString(charset);
}

function decodeQuotedPrintable(input: string, charset: BufferEncoding): string {
  // Strip soft line breaks `=\r\n` / `=\n` first.
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
    // Single-byte plain ASCII (guaranteed by QP spec).
    bytes.push(cleaned.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString(charset);
}

/** Pull `charset=...` out of a Content-Type header. UTF-8 if absent. */
function extractCharset(contentType: string): BufferEncoding {
  const m = contentType.match(/charset\s*=\s*"?([^;"\s]+)"?/i);
  return m ? normalizeCharset(m[1]) : 'utf-8';
}

function normalizeCharset(c: string): BufferEncoding {
  const lower = c.toLowerCase().trim().replace(/^"|"$/g, '');
  if (lower === 'utf-8' || lower === 'utf8') return 'utf-8';
  if (
    lower === 'iso-8859-1' ||
    lower === 'latin1' ||
    lower === 'latin-1' ||
    lower === 'windows-1252' // close enough — Node doesn't ship cp1252
  ) {
    return 'latin1';
  }
  if (lower === 'us-ascii' || lower === 'ascii') return 'ascii';
  if (lower === 'utf-16le' || lower === 'utf-16') return 'utf16le';
  // Unknown charset: fall back to UTF-8. Buffer.toString will emit
  // replacement characters for non-decodable bytes, which is exactly the
  // "graceful degradation" behavior we want.
  return 'utf-8';
}

/* -------------------------------------------------------------------------- */
/* HTML → text stripping                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Small table of HTML named entities we actually see in transactional
 * emails (Apple / Google / Huawei / Meta templates). Extend on demand
 * rather than shipping a 2000-entry table for entities that never occur.
 */
const NAMED_ENTITIES: Record<string, number> = {
  // Core (must-have for HTML correctness)
  amp: 0x26,
  lt: 0x3c,
  gt: 0x3e,
  quot: 0x22,
  apos: 0x27,
  nbsp: 0x20,
  // Punctuation
  lsquo: 0x2018,
  rsquo: 0x2019,
  ldquo: 0x201c,
  rdquo: 0x201d,
  sbquo: 0x201a,
  bdquo: 0x201e,
  ndash: 0x2013,
  mdash: 0x2014,
  hellip: 0x2026,
  bull: 0x2022,
  middot: 0xb7,
  // Arrows
  larr: 0x2190,
  uarr: 0x2191,
  rarr: 0x2192,
  darr: 0x2193,
  // Symbols
  copy: 0xa9,
  reg: 0xae,
  trade: 0x2122,
  // Whitespace
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
};

/**
 * Convert HTML to a rough plain-text approximation. Good enough for the
 * classifier (which regexes keywords out of the body). Not a safe
 * sanitizer — we're not rendering this HTML anywhere.
 *
 * Steps, in order:
 *   1. Drop `<script>` and `<style>` blocks entirely.
 *   2. Drop HTML comments.
 *   3. Replace `<br>` / `</p>` / `</div>` / `</li>` with newlines so
 *      block structure survives the tag strip.
 *   4. Strip all remaining tags.
 *   5. Decode common entities (&nbsp; &amp; &lt; &gt; &quot; &#NN; &#xNN;).
 *   6. Collapse repeated whitespace (but preserve single newlines).
 */
function stripHtmlToText(html: string): string {
  let out = html;
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // Insert line breaks where block-level boundaries used to be so the
  // classifier's keyword matches span sensible units of text.
  out = out.replace(/<br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');

  out = out.replace(/<[^>]+>/g, '');

  // Entity decode: ordered so `&amp;` → `&` happens last (otherwise
  // literal `&amp;lt;` would become `<` instead of `&lt;`). We cover the
  // core 5 predefined entities plus the punctuation + arrows that show
  // up in every transactional email template. Unknown named entities
  // are left verbatim — the classifier works on substrings, so missing
  // a decode doesn't cause a wrong classification.
  out = out
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => {
      const code = NAMED_ENTITIES[name.toLowerCase()];
      return code !== undefined ? String.fromCodePoint(code) : match;
    });

  // Normalize whitespace: collapse runs of spaces/tabs within lines and
  // collapse 3+ newlines down to 2 (paragraph break).
  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}
