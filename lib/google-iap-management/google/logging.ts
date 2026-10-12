/**
 * Structured logging for Google IAP Management API calls.
 *
 * Single-line, grep-friendly format aligned with iap-management/apple/
 * conventions ("[google-iap:publisher] ..."). Outcome + duration tracked
 * uniformly so Railway logs can answer "what calls did this user trigger,
 * which failed, how slow" without parsing.
 *
 * No bodies, no headers, no tokens — Google's error responses occasionally
 * echo private-key tails on scope errors, so we only log the first 200
 * chars of err.message. The COMPLETE body is not dropped any more; it goes
 * to `actions_log.payload` instead, where it survives log rotation (see
 * google-error-descriptor.ts). This line stays short on purpose.
 *
 * ⛔ CALLER IDENTITY: email ONLY.
 * `acct=` and `sa=` exist because a permission failure that does not say
 * WHICH identity was refused cannot be diagnosed without a DB round-trip —
 * exactly the dead end the 2026-10-12 chienky 403 hit. A service account
 * email is a public identifier (it is already rendered in the account
 * switcher UI). The private key and the encrypted credential blob are NOT,
 * and must never reach a log line, a log field, or an error message. There
 * is no field on this interface that can carry them, and
 * logging-no-secrets.structural.test.ts fails the build if one appears.
 */

export type LogOutcome = "ok" | "err";

export interface PublisherLogEntry {
  method: string;
  packageName: string;
  sku?: string;
  outcome: LogOutcome;
  durationMs: number;
  status?: number;
  errTail?: string;
  /** `google_iap_mgmt.google_console_accounts.id` whose credential signed
   *  this call. Undefined when the JWT was not built through
   *  `jwtClientFromEncrypted` (e.g. a test double). */
  accountId?: string;
  /** The service account's `client_email`. ⛔ NEVER the key, never the blob. */
  serviceAccountEmail?: string;
  /** `error.status` — "PERMISSION_DENIED", "NOT_FOUND", … The field worth
   *  grepping for, because unlike `errTail` it is a stable enum. */
  errStatus?: string;
  /** `error.errors[].reason`, comma-joined. */
  errReason?: string;
}

export function logPublisherCall(entry: PublisherLogEntry): void {
  const parts = [
    `[google-iap:publisher]`,
    `method=${entry.method}`,
    `pkg=${entry.packageName}`,
  ];
  if (entry.sku) parts.push(`sku=${entry.sku}`);
  if (entry.accountId) parts.push(`acct=${entry.accountId}`);
  if (entry.serviceAccountEmail) parts.push(`sa=${entry.serviceAccountEmail}`);
  parts.push(`outcome=${entry.outcome}`);
  parts.push(`dur_ms=${entry.durationMs}`);
  if (entry.status !== undefined) parts.push(`status=${entry.status}`);
  if (entry.errStatus) parts.push(`err_status=${entry.errStatus}`);
  if (entry.errReason) parts.push(`err_reason=${entry.errReason}`);
  if (entry.errTail) parts.push(`err="${entry.errTail.replace(/"/g, "'")}"`);
  const line = parts.join(" ");
  if (entry.outcome === "err") console.error(line);
  else console.log(line);
}

export interface ReportingLogEntry {
  method: string;
  pageSize?: number;
  pageToken?: string;
  outcome: LogOutcome;
  durationMs: number;
  resultCount?: number;
  status?: number;
  errTail?: string;
}

export function logReportingCall(entry: ReportingLogEntry): void {
  const parts = [`[google-iap:reporting]`, `method=${entry.method}`];
  if (entry.pageSize !== undefined) parts.push(`page_size=${entry.pageSize}`);
  if (entry.pageToken) parts.push(`page_token=${entry.pageToken.slice(0, 20)}…`);
  parts.push(`outcome=${entry.outcome}`);
  parts.push(`dur_ms=${entry.durationMs}`);
  if (entry.resultCount !== undefined) parts.push(`count=${entry.resultCount}`);
  if (entry.status !== undefined) parts.push(`status=${entry.status}`);
  if (entry.errTail) parts.push(`err="${entry.errTail.replace(/"/g, "'")}"`);
  const line = parts.join(" ");
  if (entry.outcome === "err") console.error(line);
  else console.log(line);
}
