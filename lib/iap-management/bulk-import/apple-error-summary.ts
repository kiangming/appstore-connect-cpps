/**
 * Pure parser — turns a captured Apple/orchestration error into a short,
 * human-readable summary for the Bulk Import result table's Notes cell.
 *
 * Parse chain: `errors[0].detail` → `.title` → `.code` → raw-truncated
 * fallback (when `raw` isn't valid Apple JSON:API error text — network
 * error, timeout, or a non-Apple `Error`). No React / fetch dependency so
 * this is testable in isolation and reusable by any result table (Apple
 * Bulk Import today, Google's later).
 */

export interface AppleErrorSummary {
  /** Collapsed-cell text, e.g. `apple-create 409 — This name is already being used…` */
  summary: string;
  /** True when `raw` parsed as Apple's `{errors:[...]}` JSON:API shape. */
  isAppleJson: boolean;
}

interface ApiErrorEntry {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
}

export interface SummarizeAppleErrorParams {
  /** Uncapped `error_full` / `submit_error_full`, when available. */
  raw: string | undefined;
  /** Always-present capped `error` / `submit_error` — used when `raw` is
   *  absent, or doesn't parse as an Apple error. */
  fallback: string;
  /** Orchestration stage, e.g. "apple-create" (optional context prefix). */
  stage?: string;
  /** Apple's HTTP status, when the error came from an `AppleApiError`. */
  httpStatus?: number;
}

const FALLBACK_SLICE_LEN = 120;

export function summarizeAppleError(
  params: SummarizeAppleErrorParams,
): AppleErrorSummary {
  const { raw, fallback, stage, httpStatus } = params;
  const text = raw ?? fallback;

  const errors = parseAppleErrors(text);
  if (!errors || errors.length === 0) {
    const prefix = stage ? `${stage}: ` : "";
    return {
      summary: `${prefix}${fallback.slice(0, FALLBACK_SLICE_LEN)}`,
      isAppleJson: false,
    };
  }

  const first = errors[0];
  const detail = first.detail ?? first.title ?? first.code ?? "Unknown Apple error";
  const body = errors.length > 1 ? `${errors.length} errors: ${detail}` : detail;

  const prefixParts = [stage, httpStatus !== undefined ? String(httpStatus) : undefined].filter(
    (part): part is string => Boolean(part),
  );
  const prefix = prefixParts.length > 0 ? `${prefixParts.join(" ")} — ` : "";

  return { summary: `${prefix}${body}`, isAppleJson: true };
}

function parseAppleErrors(text: string): ApiErrorEntry[] | undefined {
  try {
    const parsed = JSON.parse(text) as { errors?: unknown };
    return Array.isArray(parsed?.errors) ? (parsed.errors as ApiErrorEntry[]) : undefined;
  } catch {
    return undefined;
  }
}
