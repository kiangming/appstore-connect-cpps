/**
 * Pure bucketing helpers for the /submit-batch preflight phase.
 *
 * Given the Manager-selected local rows and the fresh Apple state map, sort
 * each selection into one of four buckets the modal renders:
 *   • ready             — READY_TO_SUBMIT, eligible for the next phase
 *   • missing_metadata  — needs Manager fix before resubmit
 *   • other             — Apple state precludes submission (already in review,
 *                         approved, rejected, removed, etc.)
 *   • not_on_apple      — local draft mistakenly included in the selection
 */

export interface LocalSelectionRow {
  id: string;
  apple_iap_id: string | null;
  product_id: string;
  reference_name: string;
}

export interface AppleStateRow {
  apple_iap_id: string;
  state: string;
}

export interface PreflightRow {
  iap_id: string;
  apple_iap_id: string;
  product_id: string;
  reference_name: string;
  state: string;
  hint?: string;
}

export interface NotOnAppleRow {
  iap_id: string;
  product_id: string;
  reference_name: string;
}

export interface PreflightBuckets {
  ready: PreflightRow[];
  missing_metadata: PreflightRow[];
  other: PreflightRow[];
  not_on_apple: NotOnAppleRow[];
}

export function bucketSelection(
  selected: LocalSelectionRow[],
  appleByAppleId: Map<string, AppleStateRow>,
): PreflightBuckets {
  const buckets: PreflightBuckets = {
    ready: [],
    missing_metadata: [],
    other: [],
    not_on_apple: [],
  };

  for (const row of selected) {
    if (!row.apple_iap_id) {
      buckets.not_on_apple.push({
        iap_id: row.id,
        product_id: row.product_id,
        reference_name: row.reference_name,
      });
      continue;
    }
    const apple = appleByAppleId.get(row.apple_iap_id);
    if (!apple) {
      buckets.other.push({
        iap_id: row.id,
        apple_iap_id: row.apple_iap_id,
        product_id: row.product_id,
        reference_name: row.reference_name,
        state: "NOT_FOUND",
        hint:
          "Apple no longer returns this IAP for the app — may have been removed or restricted.",
      });
      continue;
    }
    const r: PreflightRow = {
      iap_id: row.id,
      apple_iap_id: row.apple_iap_id,
      product_id: row.product_id,
      reference_name: row.reference_name,
      state: apple.state,
    };
    if (apple.state === "READY_TO_SUBMIT") {
      buckets.ready.push(r);
    } else if (apple.state === "MISSING_METADATA") {
      buckets.missing_metadata.push({
        ...r,
        hint:
          "Apple reports MISSING_METADATA — open IAP detail to verify localizations + screenshot.",
      });
    } else {
      buckets.other.push({ ...r, hint: terminalStateHint(apple.state) });
    }
  }

  return buckets;
}

/**
 * IAP.q.1.IV — server-side state-guard partition for the `execute` phase.
 *
 * Mirrors `bucketSelection` but tuned for a narrower decision: at execute
 * time we only care whether the row's fresh Apple state is
 * `READY_TO_SUBMIT`. Anything else gets the "skipped by state guard"
 * treatment (defence-in-depth — the modal preflight should have already
 * filtered, but a race or direct API call could land non-ready rows).
 *
 * Pure function — easily testable, no Apple HTTP side effects. The route
 * resolves `stateByAppleId` via a single `listInAppPurchases` call (parity
 * with preflight) and passes it in.
 */

export interface EligibleRow {
  id: string;
  apple_iap_id: string;
}

export interface SkippedRow {
  id: string;
  apple_iap_id: string;
  apple_state: string;
}

export interface GuardPartition {
  /** Rows whose fresh Apple state is `READY_TO_SUBMIT`. */
  eligible: EligibleRow[];
  /** Rows blocked — Apple state ≠ `READY_TO_SUBMIT` (or missing/UNKNOWN). */
  skipped: SkippedRow[];
}

/**
 * Partition the "on-Apple" rows by fresh state. Caller resolves
 * `stateByAppleId` from a single `listInAppPurchases` call.
 */
export function partitionByStateGuard(
  rows: ReadonlyArray<{ id: string; apple_iap_id: string }>,
  stateByAppleId: ReadonlyMap<string, string>,
): GuardPartition {
  const out: GuardPartition = { eligible: [], skipped: [] };
  for (const row of rows) {
    const appleState = stateByAppleId.get(row.apple_iap_id) ?? "UNKNOWN";
    if (appleState === "READY_TO_SUBMIT") {
      out.eligible.push({ id: row.id, apple_iap_id: row.apple_iap_id });
    } else {
      out.skipped.push({
        id: row.id,
        apple_iap_id: row.apple_iap_id,
        apple_state: appleState,
      });
    }
  }
  return out;
}

export function terminalStateHint(state: string): string {
  switch (state) {
    case "WAITING_FOR_REVIEW":
    case "IN_REVIEW":
      return "Already submitted — wait for Apple Review verdict.";
    case "APPROVED":
    case "READY_FOR_SALE":
      return "Already approved — no submission needed.";
    case "REJECTED":
    case "DEVELOPER_ACTION_NEEDED":
      return "Apple rejected — fix the noted issue and resubmit.";
    case "PENDING_APPLE_RELEASE":
    case "PENDING_DEVELOPER_RELEASE":
      return "Awaiting release — submission already complete.";
    case "REMOVED_FROM_SALE":
    case "DEVELOPER_REMOVED_FROM_SALE":
      return "Removed from sale — restore via Apple Connect before resubmitting.";
    default:
      return `State "${state}" cannot be submitted directly.`;
  }
}
