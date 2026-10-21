/**
 * H4.3 — the contract between the bulk-import wizard and the execute route.
 * Client-safe (no imports). The wizard builds every execute body through
 * buildExecuteRequestBody (components/google-iap-management/bulk-import/
 * execute-payload.ts); the route checks it. One place for both sides, so they
 * cannot disagree.
 */

/** The pricing rule a preview / execute request was built under. Both routes
 *  refuse a request under any other (409 PREVIEW_OUTDATED), before anything is
 *  read or sent (the preview check since v2 — a pre-v2 tab crashed on the v2
 *  preview response):
 *   - v1 (H4.3): a tab that previewed before H4 still carries a plan priced
 *     with the APP's currency (a bare "Price" header read as the app
 *     currency, tiers matched cross-currency), and nothing in its rows says so.
 *   - v2 ([GOOGLE-bulkimport-drop-gt], Manager Q4 2026-10-21): a tab that
 *     previewed before carries each row's GT as `regionOverrides`, which the
 *     server used to post as that country's price. Audit rows written under
 *     v1 hold `per_row_pricing[].gt` / `gt_outcome`; v2 rows hold
 *     `gt_rows_with_data` instead — the rule tells the two periods apart. */
export const PRICING_RULE = "file-currency-only/v2";

/** Rows of the file the Manager may leave out in one push ("push the rest").
 *  A guard against a crafted body, far above any real file — the wizard
 *  disables Push above it with the same number, so it never meets a 400 the
 *  Manager cannot act on. */
export const MAX_DROPPED_ROWS = 20000;
