/**
 * H4.3 — the contract between the bulk-import wizard and the execute route.
 * Client-safe (no imports). The wizard builds every execute body through
 * buildExecuteRequestBody (components/google-iap-management/bulk-import/
 * execute-payload.ts); the route checks it. One place for both sides, so they
 * cannot disagree.
 */

/** The pricing rule an execute request was built under. The route refuses a
 *  request without it (409 PREVIEW_OUTDATED): a tab that previewed before H4
 *  still carries a plan priced with the APP's currency (a bare "Price" header
 *  read as the app currency, tiers matched cross-currency), and nothing in its
 *  rows says so. */
export const PRICING_RULE = "file-currency-only/v1";

/** Rows of the file the Manager may leave out in one push ("push the rest").
 *  A guard against a crafted body, far above any real file — the wizard
 *  disables Push above it with the same number, so it never meets a 400 the
 *  Manager cannot act on. */
export const MAX_DROPPED_ROWS = 20000;
