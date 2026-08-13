/**
 * Update-IAP orchestrator (g1.h).
 *
 * Manager submits the full target state (same shape as create); orchestrator
 * computes the diff vs the cache snapshot, builds the patch body, calls
 * Android Publisher v3 inappproducts.patch, syncs the cache from Google's
 * response, and emits an IAP_UPDATE audit entry that records the diff.
 *
 * Why we patch with the full body rather than a sparse one:
 *   Google's `prices` and `listings` are map fields — a sparse patch would
 *   require explicit deletion semantics per key, which Publisher v3 does not
 *   model cleanly. Sending the full desired state in patch matches Google
 *   Play Console's own UI behaviour (replace map content wholesale) and keeps
 *   "remove a locale / region" workable from the form.
 *
 * Errors thrown here surface to the API route handler, which maps Google
 * SDK status codes to HTTP responses.
 */
import type { JWT } from "google-auth-library";

import {
  patchInAppProduct,
  type InAppProduct,
} from "../google/publisher-client";
import { decimalToMicros } from "../google/price-conversion";
import { buildRegionMapFromBasePrice } from "../google/regions-helper";
import {
  syncIapFromGoogle,
  type IapDetail,
} from "../repository/iaps";
import { appendAction } from "../repository/actions-log";
import {
  computeIapDiff,
  diffSummary,
  type IapStateSnapshot,
} from "./iap-diff";
import {
  verifyPricingLanded,
  type PriceMap,
  type WriteVerification,
} from "./verify-write";
import type {
  LocaleListingInput,
  RegionPriceInput,
} from "./create-iap";

export interface UpdateIapInput {
  appId: string;
  packageName: string;
  sku: string;
  // Manager target state (decimal input, decimal → micros happens here)
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  listings: LocaleListingInput[];
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: RegionPriceInput[];
  actorEmail: string | null;
  // Cache snapshot for diff
  current: IapDetail;
}

export interface UpdateIapResult {
  sku: string;
  status: string | null;
  /**
   * SC1 — HONEST STATUS. This is now "did the Manager's change actually land
   * on Google", not "did the tool compute a non-empty diff". It is set to
   * false when the post-write re-read proves nothing moved. See
   * verify-write.ts for why the verdict is deliberately conservative.
   */
  hasChanges: boolean;
  /** Evidence behind `hasChanges`. Absent only when the write was skipped
   *  because the diff was empty before we called Google at all. */
  verification?: WriteVerification;
}

/**
 * Build a snapshot from the Manager's target form values (after decimal →
 * micros). Mirrors `snapshotFromDetail` so computeIapDiff can compare them
 * symmetrically.
 */
function snapshotFromInput(input: UpdateIapInput): IapStateSnapshot {
  const listings: Record<string, { title: string; description: string }> = {};
  for (const l of input.listings) {
    if (!l.title.trim() && !l.description.trim()) continue;
    listings[l.locale] = {
      title: l.title.trim(),
      description: l.description.trim(),
    };
  }
  // Hotfix 5: currency-aware precision validation. Per-region overrides
  // each carry their own currency, so each conversion validates against
  // its own.
  const prices: Record<string, { currency: string; priceMicros: string }> = {};
  for (const r of input.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    prices[r.region] = {
      currency: r.currency.trim().toUpperCase(),
      priceMicros: decimalToMicros(r.priceDecimal, r.currency),
    };
  }
  return {
    attributes: {
      purchaseType: input.purchaseType,
      status: input.status,
      defaultLanguage: input.defaultLanguage,
      baseCurrency: input.baseCurrency.trim().toUpperCase(),
      basePriceMicros: decimalToMicros(input.basePriceDecimal, input.baseCurrency),
    },
    listings,
    prices,
  };
}

function snapshotFromDetail(detail: IapDetail): IapStateSnapshot {
  const listings: Record<string, { title: string; description: string }> = {};
  for (const l of detail.listings) {
    listings[l.locale] = { title: l.title, description: l.description };
  }
  const prices: Record<string, { currency: string; priceMicros: string }> = {};
  for (const p of detail.prices) {
    prices[p.region_code] = {
      currency: p.currency,
      priceMicros: p.price_micros,
    };
  }
  return {
    attributes: {
      purchaseType: detail.iap.purchase_type === "subscription"
        ? "managed"
        : (detail.iap.purchase_type as "managed" | "consumable"),
      status: detail.iap.status,
      defaultLanguage: "en-US", // Cache schema doesn't carry it; form default
      baseCurrency: detail.iap.default_currency ?? "USD",
      basePriceMicros: detail.iap.default_price_micros ?? "0",
    },
    listings,
    prices,
  };
}

export async function updateIapOnGoogle(
  jwt: JWT,
  input: UpdateIapInput,
): Promise<UpdateIapResult> {
  const before = snapshotFromDetail(input.current);
  const after = snapshotFromInput(input);
  const diff = computeIapDiff(before, after);

  if (!diff.hasChanges) {
    return {
      sku: input.sku,
      status: input.current.iap.status,
      hasChanges: false,
    };
  }

  // Build full target body (see header comment on why we don't sparse-patch).
  const listings: NonNullable<InAppProduct["listings"]> = {};
  for (const [locale, l] of Object.entries(after.listings)) {
    listings[locale] = { title: l.title, description: l.description };
  }
  if (Object.keys(listings).length === 0) {
    throw new Error("At least one locale must have a title.");
  }
  if (!listings[input.defaultLanguage]) {
    throw new Error(
      `Default locale "${input.defaultLanguage}" must have a title.`,
    );
  }

  const prices: NonNullable<InAppProduct["prices"]> = {};
  for (const [region, p] of Object.entries(after.prices)) {
    prices[region] = { currency: p.currency, priceMicros: p.priceMicros };
  }

  // Hotfix 8 Phase 2: ensure comprehensive regions for the new API.
  // Manager-supplied overrides (`prices` above) win over Google's
  // auto-converted catalog values; missing regions get the conversion.
  // Skipped if convertRegionPrices fails — the publisher-client
  // fallback to legacy will then handle the call.
  //
  // Hotfix 9: capture and forward the catalog version Google used —
  // see create-iap.ts header comment for the cross-version trap.
  let regionsVersion: string | undefined;
  try {
    const result = await buildRegionMapFromBasePrice(
      jwt,
      input.packageName,
      after.attributes.basePriceMicros,
      after.attributes.baseCurrency,
    );
    for (const a of result.regions) {
      if (!prices[a.region]) {
        prices[a.region] = {
          currency: a.currency,
          priceMicros: a.priceMicros,
        };
      }
    }
    regionsVersion = result.regionsVersion ?? undefined;
  } catch (err) {
    console.warn(
      `[google-iap:update-iap] regions bootstrap failed pkg=${input.packageName} sku=${input.sku} err="${
        err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
      }"`,
    );
  }

  const body: InAppProduct = {
    packageName: input.packageName,
    sku: input.sku,
    status: input.status,
    purchaseType: "managedUser",
    defaultLanguage: input.defaultLanguage,
    defaultPrice: {
      currency: after.attributes.baseCurrency,
      priceMicros: after.attributes.basePriceMicros,
    },
    listings,
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };

  const updated = await patchInAppProduct(jwt, input.packageName, input.sku, body, {
    regionsVersion,
  });

  // ── SC1: HONEST STATUS ───────────────────────────────────────────────
  // `updated` is Google's own post-write re-read (publisher-client's
  // refetchWithStateOverlay), so ground truth is already in hand. Compare
  // what we asked for against what Google now holds, before claiming
  // anything to the Manager or the audit log.
  const verification = verifyPricingLanded({
    before: before.prices,
    intended: prices as PriceMap,
    applied: (updated.prices as PriceMap | undefined) ?? null,
    intendedBaseMicros: after.attributes.basePriceMicros,
    appliedBaseMicros: updated.defaultPrice?.priceMicros ?? null,
    baseChangeRequested: Boolean(
      diff.attributes.basePriceMicros || diff.attributes.baseCurrency,
    ),
  });

  if (verification.noOp) {
    console.error(
      `[google-iap:update-iap] NO-OP WRITE pkg=${input.packageName} sku=${input.sku} ` +
        `requested_base=${after.attributes.baseCurrency}/${after.attributes.basePriceMicros} ` +
        `applied_base=${updated.defaultPrice?.currency ?? "?"}/${updated.defaultPrice?.priceMicros ?? "?"} ` +
        `intended_region_changes=${verification.intendedChangeCount} unapplied=${verification.unappliedRegions.length} ` +
        `— Google returned success but its state is unchanged`,
    );
  } else if (verification.checked && verification.unappliedRegions.length > 0) {
    console.warn(
      `[google-iap:update-iap] PARTIAL WRITE pkg=${input.packageName} sku=${input.sku} ` +
        `unapplied=${verification.unappliedRegions.length}/${Object.keys(prices).length} ` +
        `regions=${verification.unappliedRegions.slice(0, 10).join(",")}`,
    );
  }

  await syncIapFromGoogle(input.appId, updated);

  const summary = diffSummary(diff);
  await appendAction({
    actionType: "IAP_UPDATE",
    actorEmail: input.actorEmail,
    targetId: input.appId,
    payload: {
      package_name: input.packageName,
      sku: input.sku,
      summary,
      attributes: diff.attributes,
      listings: diff.listings,
      prices: diff.prices,
      // The audit row records the OUTCOME, not just the intent. A row that
      // says "base price 1.99 → 2.99" while Google still holds 1.99 is a
      // false record; `verification` is what makes it honest.
      verification,
    },
  });

  return {
    sku: updated.sku ?? input.sku,
    status: updated.status ?? input.status,
    hasChanges: !verification.noOp,
    verification,
  };
}
