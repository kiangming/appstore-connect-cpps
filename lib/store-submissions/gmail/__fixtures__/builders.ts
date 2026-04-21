/**
 * Tiny factories for building `gmail_v1.Schema$Message` fixtures in
 * tests. Keeps the fixture files focused on the interesting shape of
 * each scenario (multipart nesting, charset, headers) instead of the
 * base64url boilerplate that's identical everywhere.
 *
 * Not exported from the production `index.ts` of this folder — these
 * are test-only helpers and should stay test-only.
 */

import type { gmail_v1 } from 'googleapis';

export type Header = gmail_v1.Schema$MessagePartHeader;
export type Part = gmail_v1.Schema$MessagePart;
export type Message = gmail_v1.Schema$Message;

/** Base64url encode a UTF-8 string (or pre-computed Buffer). */
export function b64u(input: string | Buffer, encoding: BufferEncoding = 'utf-8'): string {
  const buf = typeof input === 'string' ? Buffer.from(input, encoding) : input;
  return buf.toString('base64url');
}

export function header(name: string, value: string): Header {
  return { name, value };
}

/** Build a leaf MIME part with a base64url-encoded body. */
export function leaf(opts: {
  mimeType: string;
  body: string;
  /** Charset for encoding body bytes + announcing in Content-Type. Default UTF-8. */
  charset?: BufferEncoding;
  /** Extra headers to append. */
  headers?: Header[];
  /** Override Content-Transfer-Encoding header. */
  transferEncoding?: string;
  /** Pre-encoded body bytes — skips the encode step, used for QP/binary fixtures. */
  preEncodedData?: string;
}): Part {
  const charset = opts.charset ?? 'utf-8';
  const data =
    opts.preEncodedData ?? b64u(Buffer.from(opts.body, charset));
  const baseHeaders: Header[] = [
    header(
      'Content-Type',
      `${opts.mimeType}; charset=${charsetLabel(charset)}`,
    ),
  ];
  if (opts.transferEncoding) {
    baseHeaders.push(header('Content-Transfer-Encoding', opts.transferEncoding));
  }
  return {
    mimeType: opts.mimeType,
    headers: [...baseHeaders, ...(opts.headers ?? [])],
    body: { data, size: Buffer.byteLength(opts.body, charset) },
  };
}

/** Build a container MIME part wrapping children. */
export function container(
  mimeType: string,
  parts: Part[],
  extraHeaders: Header[] = [],
): Part {
  return {
    mimeType,
    headers: [header('Content-Type', mimeType), ...extraHeaders],
    parts,
  };
}

/** Build a complete Gmail Schema$Message with sensible defaults. */
export function buildMessage(opts: {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  /** ms-since-epoch string. Default 2026-04-20T10:30:00Z. */
  internalDate?: string;
  /** Envelope headers (From, To, Subject, Date). */
  envelopeHeaders: Header[];
  payload: Part;
}): Message {
  return {
    id: opts.id ?? 'msg-default-001',
    threadId: opts.threadId ?? 'thread-default-001',
    labelIds: opts.labelIds ?? ['INBOX', 'UNREAD'],
    internalDate: opts.internalDate ?? '1713609000000', // 2026-04-20T10:30:00Z
    snippet: '',
    historyId: '1',
    sizeEstimate: 1024,
    payload: {
      ...opts.payload,
      headers: [...opts.envelopeHeaders, ...(opts.payload.headers ?? [])],
    },
  };
}

function charsetLabel(c: BufferEncoding): string {
  if (c === 'latin1') return 'ISO-8859-1';
  if (c === 'utf-8') return 'UTF-8';
  if (c === 'ascii') return 'US-ASCII';
  if (c === 'utf16le') return 'UTF-16LE';
  return c;
}
