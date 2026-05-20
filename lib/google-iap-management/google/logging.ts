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
 * chars of err.message.
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
}

export function logPublisherCall(entry: PublisherLogEntry): void {
  const parts = [
    `[google-iap:publisher]`,
    `method=${entry.method}`,
    `pkg=${entry.packageName}`,
  ];
  if (entry.sku) parts.push(`sku=${entry.sku}`);
  parts.push(`outcome=${entry.outcome}`);
  parts.push(`dur_ms=${entry.durationMs}`);
  if (entry.status !== undefined) parts.push(`status=${entry.status}`);
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
