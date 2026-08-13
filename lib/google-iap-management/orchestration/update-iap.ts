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
  //
  // SC2 / option B — WHO AUTHORED THE VALUE DECIDES WHETHER IT CAN THROW.
  // The currency check only runs on rows the Manager pinned. A NON-DIRTY row
  // is a value Google itself gave us, echoed back untouched; rejecting it here
  // makes the whole item un-editable over a row nobody touched (production:
  // com.vng.passsdk.2508111020 carries TW = TWD 6.30, which this table calls
  // invalid). The client already refuses to block on those rows — without this
  // the server would still hard-throw and option B would be half-built.
  //
  // Dropping the currency argument does NOT transform the value: it is the
  // same decimal→micros conversion minus the precision assertion, so 6.30
  // round-trips as exactly 6300000. That is the byte-for-byte guarantee.
  const prices: Record<string, { currency: string; priceMicros: string }> = {};
  for (const r of input.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    prices[r.region] = {
      currency: r.currency.trim().toUpperCase(),
      priceMicros: r.dirty
        ? decimalToMicros(r.priceDecimal, r.currency)
        : decimalToMicros(r.priceDecimal),
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
  // Missing regions get Google's conversion of the base price.
  //
  // ── SC2: THE BASE PRICE RE-DERIVES THE REGIONS IT OWNS ────────────────
  // Fill-missing alone is why a base-price change was a silent no-op. The
  // Edit form preloads EVERY cached region as an override, so nothing was
  // ever missing, every converted value was discarded, and the new base
  // price — which has no field of its own in the v3 schema — reached Google
  // through no carrier at all.
  //
  // A base-price change is the Manager ACTIVELY asking to recompute every
  // country, so when the base moved the conversion OVERWRITES the catalogue.
  //
  // ⚠ SC2b — THE RESET IS TOTAL, hand-typed rows included. The base price is
  // the single source for every country price, and picking a tier is just a
  // fast way to set the base; both are recalculate-everything commands that
  // overwrite each other, unbounded. So `dirty` is deliberately NOT consulted
  // here. The boundary (see override-merge.ts header):
  //     tier / base     = a command to recalculate  -> ignore dirty
  //     sync / validate = everything else           -> respect dirty
  // `dirty` still governs which rows may block a submit — see
  // snapshotFromInput above — and the form warns BEFORE recalculating when
  // hand-typed rows would be lost.
  //
  // Hotfix 9: capture and forward the catalog version Google used —
  // see create-iap.ts header comment for the cross-version trap.
  const baseChanged = Boolean(
    diff.attributes.basePriceMicros || diff.attributes.baseCurrency,
  );
  let regionsVersion: string | undefined;
  try {
    const result = await buildRegionMapFromBasePrice(
      jwt,
      input.packageName,
      after.attributes.basePriceMicros,
      after.attributes.baseCurrency,
    );
    let rederived = 0;
    for (const a of result.regions) {
      const isMissing = !prices[a.region];
      if (!isMissing && !baseChanged) continue;
      if (!isMissing) rederived += 1;
      prices[a.region] = {
        currency: a.currency,
        priceMicros: a.priceMicros,
      };
    }
    regionsVersion = result.regionsVersion ?? undefined;
    if (baseChanged) {
      console.info(
        `[google-iap:update-iap] base-price re-derive pkg=${input.packageName} sku=${input.sku} ` +
          `base=${after.attributes.baseCurrency}/${after.attributes.basePriceMicros} ` +
          `rederived=${rederived} catalog=${result.regions.length}`,
      );
    }
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
