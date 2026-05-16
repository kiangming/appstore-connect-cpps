/**
 * Pure classifier for the sync-states UPSERT (IAP.o.8b).
 *
 * Given Apple's authoritative IAP list + a snapshot of the local cache,
 * produce one decision per Apple IAP: INSERT a new stub, UPDATE state on
 * an existing row, or just touch synced_at when the state already matches.
 *
 * Kept route-free so the classification matrix can be unit-tested without
 * mocking the Supabase client.
 */

import type { InAppPurchase } from "@/types/iap-management/apple";

export type SyncDecisionKind = "INSERT" | "UPDATE_STATE" | "UNCHANGED";

export interface SyncDecision {
  kind: SyncDecisionKind;
  apple_iap_id: string;
  /** New state to write — for INSERT and UPDATE_STATE only. */
  state: string;
  /** Payload for INSERT — populated from Apple's attributes. */
  insert_payload?: {
    apple_iap_id: string;
    product_id: string;
    reference_name: string;
    type: string;
    state: string;
  };
}

export interface ClassifySummary {
  inserted: number;
  updated: number;
  unchanged: number;
}

export function classifySyncStates(
  appleIaps: InAppPurchase[],
  currentByAppleId: Map<string, string>,
): { decisions: SyncDecision[]; counts: ClassifySummary } {
  const decisions: SyncDecision[] = [];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const iap of appleIaps) {
    const appleState = iap.attributes.state;
    const localState = currentByAppleId.get(iap.id);

    if (localState === undefined) {
      decisions.push({
        kind: "INSERT",
        apple_iap_id: iap.id,
        state: appleState,
        insert_payload: {
          apple_iap_id: iap.id,
          product_id: iap.attributes.productId,
          reference_name: iap.attributes.name,
          type: iap.attributes.inAppPurchaseType,
          state: appleState,
        },
      });
      inserted++;
      continue;
    }

    if (localState === appleState) {
      decisions.push({
        kind: "UNCHANGED",
        apple_iap_id: iap.id,
        state: appleState,
      });
      unchanged++;
      continue;
    }

    decisions.push({
      kind: "UPDATE_STATE",
      apple_iap_id: iap.id,
      state: appleState,
    });
    updated++;
  }

  return {
    decisions,
    counts: { inserted, updated, unchanged },
  };
}
