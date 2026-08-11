/**
 * Single source of truth for `iap_mgmt.actions_log.action_type`.
 *
 * WHY THIS FILE EXISTS — meta-rule P2, recurring after being documented.
 *
 * `actions_log.action_type` carries a DB CHECK constraint. A value emitted by
 * code but absent from the constraint makes every one of those audit INSERTs
 * fail — and both audit writers deliberately swallow the error (an audit write
 * must never fail a real Apple mutation), so the failure is *completely*
 * silent: the Apple write succeeds, the operator sees success, the audit row
 * simply never exists.
 *
 * This has now happened twice:
 *   1. IAP.o.6 → IAP.o.11: 7 types emitted, none in the constraint
 *      (fixed by migration 20260517000000).
 *   2. Cycle 37/39/40 availability: AVAILABILITY_SET_ALL_TERRITORIES +
 *      AVAILABILITY_REMOVE_FROM_SALES emitted, never in the constraint
 *      (fixed by migration 20260811000000).
 *
 * Occurrence 2 happened AFTER P2 was written down. A rule that relies on a
 * contributor remembering it is not a guard. So the guard is now structural,
 * in two layers that fail at `npm test` rather than in production:
 *
 *   Layer 1 — PARITY (exact). `action-types.test.ts` parses the latest
 *     migration that redefines `actions_log_action_type_check` and asserts
 *     its value list equals `IAP_ACTION_TYPES`, set-for-set, both directions.
 *     Adding a value here without a migration fails. Adding one in a
 *     migration without updating this file fails too.
 *
 *   Layer 2 — SOURCE SCAN (broad net). The same test scans every Apple-IAP
 *     source file for action-type string literals in an emitting position and
 *     asserts each is a member of `IAP_ACTION_TYPES`. The scanner carries a
 *     self-check (it must find a set of known-hard sentinels, including one
 *     reachable only through a ternary) so a scanner that silently stops
 *     matching fails loudly instead of passing vacuously.
 *
 * Layer 2 is a net, not a proof. The compiler-enforced part is `IapActionType`
 * on the two positional audit helpers (`update-orchestration.writeAuditRow`,
 * `bulk-availability.writeAuditRow`), which is where the indirect
 * (non-literal) emissions live. Direct `.insert({ action_type: "…" })` calls
 * go through supabase-js's untyped builder, so those are covered by Layer 2.
 *
 * ⇒ WHEN ADDING A NEW ACTION TYPE: add it here, add it to a new forward-only
 *   migration, and let the parity test confirm the two agree.
 */

/**
 * Every value allowed in `iap_mgmt.actions_log.action_type`, matching the
 * CHECK constraint as of migration `20260811000000`.
 *
 * Two members are retained but no longer emitted by any code path
 * (`UPLOAD_SCREENSHOT`, `SYNC_FROM_APPLE` — from the original 20260515 init).
 * They stay because historical rows may carry them and the constraint is
 * validated against existing data on every re-create. `UNUSED_ACTION_TYPES`
 * below records them explicitly so the source-scan test can tell
 * "allowed-but-unused" apart from "the scanner missed it".
 */
export const IAP_ACTION_TYPES = [
  // ── Local CRUD (20260515 init) ────────────────────────────────────────
  "CREATE_IAP",
  "UPDATE_IAP",
  "DELETE_IAP",
  "UPLOAD_SCREENSHOT",
  "SUBMIT_TO_APPLE",
  "SYNC_FROM_APPLE",
  "PRICE_TIER_IMPORT",
  "BULK_IMPORT_BATCH",
  // ── IAP.o.11d (20260517000000) ────────────────────────────────────────
  "CREATE_ON_APPLE",
  "SET_PRICE_SCHEDULE",
  "BULK_IMPORT_CREATE",
  "BULK_IMPORT_OVERWRITE_SCREENSHOT",
  "BULK_IMPORT_SUBMIT",
  "SUBMIT_APPLE_REVIEW",
  "SYNC_STATE_FROM_APPLE",
  // ── IAP.o.12 update-on-Apple stages (20260518000000) ──────────────────
  "UPDATE_ATTRIBUTES_ON_APPLE",
  "UPDATE_LOCALIZATION_ON_APPLE",
  "ADD_LOCALIZATION_ON_APPLE",
  "DELETE_LOCALIZATION_ON_APPLE",
  "REPLACE_SCREENSHOT_ON_APPLE",
  // ── Availability (20260811000000 — the P2 fix) ─────────────────────────
  "AVAILABILITY_SET_ALL_TERRITORIES",
  "AVAILABILITY_REMOVE_FROM_SALES",
] as const;

export type IapActionType = (typeof IAP_ACTION_TYPES)[number];

/**
 * Allowed by the constraint but not emitted by any current code path.
 * Declared explicitly so the source-scan test can assert
 * `scanned ∪ UNUSED === IAP_ACTION_TYPES` — which turns "the scanner found
 * fewer types than exist" from an invisible pass into a failure.
 */
export const UNUSED_ACTION_TYPES: readonly IapActionType[] = [
  "UPLOAD_SCREENSHOT",
  "SYNC_FROM_APPLE",
];

const ACTION_TYPE_SET: ReadonlySet<string> = new Set(IAP_ACTION_TYPES);

/** Runtime membership check. Exported for the guard test and defensive callers. */
export function isIapActionType(value: string): value is IapActionType {
  return ACTION_TYPE_SET.has(value);
}
