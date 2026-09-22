/**
 * [BULK-IMPORT-no-result-recovery] chunk 1 — what the wizard says when the
 * execute response never becomes a result screen.
 *
 * ⚠ THE DEFECT, MEASURED. On 2026-09-21 three Apple bulk-import batches ran
 * to completion server-side (all `status = COMPLETE`, `accounted =
 * total_rows`, hub-tracking `finally` observed in the logs) and the Manager
 * saw step 4 all three times. `handleExecute` had three exits that leave
 * `step` at 4, and the worst of them was silent:
 *
 *   • `!res.ok`                  → toast, return
 *   • `"succeeded" in data` false → **no else at all**: straight to `finally`
 *   • throw                       → toast
 *
 * and `await res.json()` sat in front of the status check, so a proxy page
 * (502/504 HTML) threw a `SyntaxError` before the status was ever read — the
 * Manager's signal was a self-dismissing `Unexpected token '<'` in the corner
 * of the screen, after a five-minute wait. They re-ran the import twice.
 *
 * ⚠ THE CLASSIFIER LIVES HERE, NOT IN THE COMPONENT, for the reason
 * `stage-map-view.ts` gives: the rules are what need pinning, and pinning
 * them through a rendered DOM is both slower and easier to weaken by
 * accident. The component renders what this returns.
 */

/**
 * ⚠ EVERY VARIANT MEANS "THE SERVER MAY HAVE DONE THE WORK ANYWAY".
 *
 * There is no `AbortSignal` on the execute route and no `maxDuration`
 * anywhere in the repo (both verified 2026-09-21), so the server does not
 * learn that the client stopped listening: it finishes the batch, closes
 * `import_batches`, writes `actions_log` and finalizes the Hub run. Every
 * message built here therefore has to say so — that sentence is the whole
 * point of the block, not decoration on an error.
 */
export type ExecuteFaultKind =
  /** Body was not JSON at all — almost always a proxy/gateway page. */
  | "unreadable-body"
  /** Valid JSON, non-2xx — the route's own typed error. */
  | "rejected"
  /** 2xx and valid JSON, but not the summary shape. THE SILENT ONE. */
  | "unexpected-shape"
  /** `fetch` itself rejected — connection dropped, DNS, abort. */
  | "transport";

export interface ExecuteFault {
  kind: ExecuteFaultKind;
  /** One line naming what actually happened, in the server's terms. */
  headline: string;
  /** HTTP status when there was a response at all. */
  status?: number;
  /** First 300 chars of whatever came back, when it was not usable JSON. */
  bodyExcerpt?: string;
  /**
   * Recovered from the payload when the shape was wrong but a batch id was
   * present — the one string that makes the run findable in
   * `iap_mgmt.import_batches` / `actions_log` afterwards.
   */
  batchId?: string;
}

/** Cap on the raw-body excerpt; enough for a `<title>504 Gateway Time-out`. */
const EXCERPT_LIMIT = 300;

export function excerptBody(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > EXCERPT_LIMIT
    ? `${trimmed.slice(0, EXCERPT_LIMIT)}…`
    : trimmed;
}

/**
 * Is this the summary the result screen needs?
 *
 * ⚠ THE GUARD THAT USED TO HAVE NO `else`. Kept as a named predicate so the
 * "everything else" branch is a thing a reader can see, rather than the
 * absence of one.
 */
export function isExecuteSummary(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "succeeded" in (data as Record<string, unknown>)
  );
}

/** Pull `batch_id` out of any object-shaped payload, if it is a string. */
export function recoverBatchId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const id = (data as Record<string, unknown>).batch_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function faultFromUnreadableBody(
  status: number,
  raw: string,
): ExecuteFault {
  return {
    kind: "unreadable-body",
    status,
    // ⚠ NOT `Unexpected token '<'`. That message describes the parser's
    // disappointment, not the event; the Manager needs the status code and
    // the fact that something other than the app answered.
    headline:
      `The server replied with HTTP ${status} and a body that is not JSON — ` +
      `this is a gateway or proxy page, not a response from the import route.`,
    bodyExcerpt: excerptBody(raw),
  };
}

export function faultFromRejected(status: number, data: unknown): ExecuteFault {
  const msg =
    typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).error === "string"
      ? ((data as Record<string, unknown>).error as string)
      : `Execute failed (HTTP ${status}).`;
  return {
    kind: "rejected",
    status,
    headline: msg,
    batchId: recoverBatchId(data),
  };
}

export function faultFromUnexpectedShape(
  status: number,
  data: unknown,
  raw: string,
): ExecuteFault {
  return {
    kind: "unexpected-shape",
    status,
    headline:
      `The server replied HTTP ${status} with valid JSON that is not an import ` +
      `summary — the results could not be displayed.`,
    bodyExcerpt: excerptBody(raw),
    batchId: recoverBatchId(data),
  };
}

export function faultFromTransport(err: unknown): ExecuteFault {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    kind: "transport",
    headline: `The connection to the server was lost before a result arrived (${msg}).`,
  };
}

/**
 * ⚠ THE SENTENCE THAT HAD TO EXIST, AND IT IS THE SAME ONE EVERY TIME.
 *
 * Shared across all four variants deliberately: the distinction between them
 * matters for diagnosis and not at all for what the Manager should DO next.
 * Re-running blind is the action that actually happened twice on 2026-09-21,
 * and only this sentence prevents it.
 */
export const EXECUTE_FAULT_ADVICE =
  "The import may have finished on the server. There is no cancellation " +
  "signal on this request, so the batch keeps running — and your items may " +
  "already be on App Store Connect. Check there before running this import " +
  "again; re-running will overwrite, not duplicate, but it costs another " +
  "full pass.";
