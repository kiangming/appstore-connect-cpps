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
