/**
 * Pure resolution of a product's real live purchase-option id (Hotfix 30).
 *
 * Root cause this closes: `DEFAULT_PURCHASE_OPTION_ID = "buy"` was used as
 * an unconditional value on the bulk activate/deactivate path
 * (orchestration/bulk-status.ts) and the single-item edit path
 * (publisher-client.ts patchInAppProduct), with no live lookup. Purchase-
 * option ids are developer-specified on Google's side — "buy" is only a
 * convention for products this tool creates fresh. Products migrated from
 * the legacy `inappproducts.*` API carry a real id of "legacy-base" (see
 * commit 4fbcdd5, which fixed the same class of bug on the bulk-import
 * overwrite path only). Any bulk-status or single-edit call against a
 * legacy-migrated product 404s: "Purchase option not found ... 'buy'".
 *
 * This module holds the pure decision logic (given an already-fetched
 * purchaseOptions array, pick the target + detect the multi-option edge
 * case). The live GET + bounded-concurrency fan-out lives in
 * publisher-client.ts's `resolveLivePurchaseOptions`, which is the single
 * shared entry point both bulk-status.ts and patchInAppProduct call.
 *
 * Scope decision (2026-07-21): resolve the single correct "target" id via
 * the same preference order as `pickTargetPurchaseOption` (legacyCompatible
 * buyOption → any buyOption → first option) — matching the bulk-import RMW
 * fix so all write paths pick the same option consistently. Deactivating
 * the FULL set of a product's active purchase options (true multi-option
 * support) is explicitly OUT of scope here — instead of silently under-
 * deactivating, `hasMultipleActiveOptions` surfaces the case so callers can
 * report it rather than hide it.
 */
import {
  pickTargetPurchaseOption,
  DEFAULT_PURCHASE_OPTION_ID,
  type OneTimeProductPurchaseOption,
} from "./onetime-product-adapter";

export interface ResolvedPurchaseOption {
  /** Real purchaseOptionId to target for this product's next write/state
   *  call. Falls back to DEFAULT_PURCHASE_OPTION_ID only when the live
   *  product genuinely has no purchase options (rare — e.g. never
   *  activated); never used as a guess when options DO exist. */
  purchaseOptionId: string;
  /** True when the live product currently has 2+ ACTIVE purchase
   *  options. Only `purchaseOptionId` is targeted — the other active
   *  option(s) are left unchanged. Surface this to the caller/Manager;
   *  do not silently treat the product as fully handled. */
  hasMultipleActiveOptions: boolean;
}

/** Resolve the target purchase option from an already-fetched live
 *  purchaseOptions array. Pure — no I/O. */
export function resolvePurchaseOptionFromLive(
  options: OneTimeProductPurchaseOption[] | null | undefined,
): ResolvedPurchaseOption {
  const opts = options ?? [];
  if (opts.length === 0) {
    return { purchaseOptionId: DEFAULT_PURCHASE_OPTION_ID, hasMultipleActiveOptions: false };
  }
  const target = pickTargetPurchaseOption(opts);
  const activeCount = opts.filter((o) => o.state === "ACTIVE").length;
  return {
    purchaseOptionId: target?.purchaseOptionId ?? DEFAULT_PURCHASE_OPTION_ID,
    hasMultipleActiveOptions: activeCount > 1,
  };
}
