/**
 * Android Publisher API v3 wrapper — in-app products surface only.
 *
 * Q-GIAP.A: v1 covers managed products (one-time purchases). Subscriptions
 * (monetization.subscriptions resource) are deferred to v2.
 * Q-GIAP.E: batchUpdate runs as a single round-trip per Manager preview;
 *   callers assemble the requests array.
 *
 * Instrumentation strategy: every call logs method + packageName + sku +
 * duration on success, and method + packageName + sku + status code +
 * tail-of-message on failure (no body, no headers — Google's error bodies
 * sometimes echo private key fragments back during scope errors).
 *
 * The googleapis SDK manages the OAuth2 token cache internally per JWT
 * instance, so we don't re-mint per call.
 */
import { google, type androidpublisher_v3 } from "googleapis";
import type { JWT } from "google-auth-library";

import { logPublisherCall, type LogOutcome } from "./logging";
import {
  oneTimeProductToInAppProduct,
  inAppProductToOneTimeProduct,
  DEFAULT_PURCHASE_OPTION_ID,
  type OneTimeProduct,
  type ToolInAppProduct,
} from "./onetime-product-adapter";

export type Publisher = androidpublisher_v3.Androidpublisher;
export type InAppProduct = androidpublisher_v3.Schema$InAppProduct;
export type InAppProductsListResponse =
  androidpublisher_v3.Schema$InappproductsListResponse;
export type InappproductsBatchUpdateRequest =
  androidpublisher_v3.Schema$InappproductsBatchUpdateRequest;
export type InappproductsBatchUpdateResponse =
  androidpublisher_v3.Schema$InappproductsBatchUpdateResponse;
export type ConvertRegionPricesRequest =
  androidpublisher_v3.Schema$ConvertRegionPricesRequest;
export type ConvertRegionPricesResponse =
  androidpublisher_v3.Schema$ConvertRegionPricesResponse;
export type AppDetails = androidpublisher_v3.Schema$AppDetails;
export type { OneTimeProduct } from "./onetime-product-adapter";

function buildClient(jwt: JWT): Publisher {
  return google.androidpublisher({ version: "v3", auth: jwt });
}

async function timed<T>(
  method: string,
  packageName: string,
  sku: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  let outcome: LogOutcome = "ok";
  let status: number | undefined;
  let errTail: string | undefined;
  try {
    const out = await fn();
    return out;
  } catch (err) {
    outcome = "err";
    const e = err as { code?: number; status?: number; message?: string };
    status = e?.code ?? e?.status;
    errTail = (e?.message ?? String(err)).slice(0, 200);
    throw err;
  } finally {
    logPublisherCall({
      method,
      packageName,
      sku,
      outcome,
      durationMs: Date.now() - t0,
      status,
      errTail,
    });
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  READ path — Hotfix 8: Monetization API v3 onetimeproducts.* primary,
 *  legacy androidpublisher.inappproducts.* fallback.
 *
 *  Google is rolling deprecation of the legacy resource by package.
 *  Symptoms observed in production:
 *    - 403 "Please migrate to the new publishing API." (legacy fails on
 *      apps Google has already migrated server-side)
 *    - Partial results — legacy returns subset of items the new API
 *      surfaces fully
 *
 *  Strategy: try the new API first. Only fall back to legacy when the
 *  new API explicitly errors. Empty results from the new API are NOT a
 *  fallback trigger — they mean "this app has no products" and a
 *  duplicate legacy call would be noise. The adapter normalises the new
 *  shape into the legacy InAppProduct shape so the rest of the codebase
 *  (repository, orchestrators) keeps working unchanged.
 * ──────────────────────────────────────────────────────────────────── */

const NEW_API_LIST_PAGE_SIZE = 1000;
const NEW_API_LIST_PAGE_CAP = 100; // defensive: 1000 × 100 = 100k items max

async function newListOneTimeProducts(
  jwt: JWT,
  packageName: string,
): Promise<OneTimeProduct[]> {
  return timed("monetization.onetimeproducts.list", packageName, undefined, async () => {
    const client = buildClient(jwt);
    const all: OneTimeProduct[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await client.monetization.onetimeproducts.list({
        packageName,
        pageSize: NEW_API_LIST_PAGE_SIZE,
        pageToken,
      });
      const items = (res.data.oneTimeProducts ?? []) as OneTimeProduct[];
      all.push(...items);
      pageToken = res.data.nextPageToken ?? undefined;
      pages += 1;
      if (pages >= NEW_API_LIST_PAGE_CAP) break;
    } while (pageToken);
    return all;
  });
}

async function legacyListInAppProducts(
  jwt: JWT,
  packageName: string,
): Promise<InAppProduct[]> {
  return timed("inappproducts.list", packageName, undefined, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.list({ packageName });
    return (res.data.inappproduct ?? []) as InAppProduct[];
  });
}

/** List all in-app products for the given package.
 *  Public surface unchanged — internally uses Monetization API v3 with
 *  legacy fallback. Adapter normalises the new shape into the legacy
 *  InAppProduct shape for downstream consumers. */
export async function listInAppProducts(
  jwt: JWT,
  packageName: string,
): Promise<InAppProduct[]> {
  try {
    const products = await newListOneTimeProducts(jwt, packageName);
    // Adapter output is structurally compatible with Schema$InAppProduct
    // (sku/status/defaultLanguage/defaultPrice/prices/listings/...).
    return products.map(
      (p) => oneTimeProductToInAppProduct(p) as unknown as InAppProduct,
    );
  } catch (err) {
    const e = err as { code?: number; status?: number; message?: string };
    const status = e?.code ?? e?.status;
    try {
      const legacy = await legacyListInAppProducts(jwt, packageName);
      // Note the fallback in the logs so operators can see which path served.
      console.warn(
        `[google-iap:publisher] list fallback pkg=${packageName} new_api_status=${status ?? "?"} legacy_count=${legacy.length}`,
      );
      return legacy;
    } catch {
      // Both failed — bubble the new API error (more actionable for
      // operators: it names the strategic endpoint).
      throw err;
    }
  }
}

async function newGetOneTimeProduct(
  jwt: JWT,
  packageName: string,
  productId: string,
): Promise<OneTimeProduct> {
  return timed("monetization.onetimeproducts.get", packageName, productId, async () => {
    const client = buildClient(jwt);
    const res = await client.monetization.onetimeproducts.get({
      packageName,
      productId,
    });
    return res.data as OneTimeProduct;
  });
}

async function legacyGetInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
): Promise<InAppProduct> {
  return timed("inappproducts.get", packageName, sku, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.get({ packageName, sku });
    return res.data as InAppProduct;
  });
}

/** Get a single in-app product by SKU.
 *  Tries Monetization API v3 first; falls back to legacy on error. */
export async function getInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
): Promise<InAppProduct> {
  try {
    const product = await newGetOneTimeProduct(jwt, packageName, sku);
    return oneTimeProductToInAppProduct(product) as unknown as InAppProduct;
  } catch (err) {
    try {
      const legacy = await legacyGetInAppProduct(jwt, packageName, sku);
      console.warn(
        `[google-iap:publisher] get fallback pkg=${packageName} sku=${sku}`,
      );
      return legacy;
    } catch {
      throw err;
    }
  }
}

// Internal: keep ToolInAppProduct re-export so callers + Phase 2 work
// against the same shape we normalise to.
export type { ToolInAppProduct };

/* ──────────────────────────────────────────────────────────────────────
 *  WRITE path — Hotfix 8 Phase 2: Monetization API v3 onetimeproducts.*
 *
 *  Same fallback strategy as the READ path: try the new API first, fall
 *  back to legacy on error. The new API patch endpoint requires:
 *    - regionsVersion.version  (mandatory query param)
 *    - updateMask              (mandatory query param)
 *    - allowMissing=true       (for the create-via-patch idiom; the new
 *                               API has no separate insert endpoint)
 *
 *  State (active / inactive) is OUTPUT-ONLY on the OneTimeProduct
 *  resource body. After the patch returns, we make a second call to
 *  `purchaseOptions:batchUpdateStates` to apply the desired state.
 *  This is the documented "two-step write" pattern for the new API.
 *
 *  Regions expansion: the orchestrator is responsible for providing a
 *  comprehensive regions map (e.g. via the regions-helper that wraps
 *  `convertRegionPrices`). Manager's "Google default pricing source"
 *  uses that helper to bootstrap from a single base price. The
 *  publisher-client itself just forwards what the orchestrator built.
 * ──────────────────────────────────────────────────────────────────── */

/** Regions schema version Google publishes for the resource. Bump if
 *  Google announces a new version that materially changes pricing
 *  behaviour. "2022/02" is the documented baseline at Hotfix 8 ship. */
export const REGIONS_VERSION = "2022/02";

/** updateMask the patch endpoint accepts for full-replace semantics.
 *  The Monetization API documents `*` as the wildcard for "every
 *  writable field"; we use a comprehensive explicit list instead
 *  because the wildcard has been inconsistently honoured in practice. */
const FULL_UPDATE_MASK =
  "listings,purchaseOptions,taxAndComplianceSettings,offerTags,restrictedPaymentCountries";

async function newPatchOneTimeProduct(
  jwt: JWT,
  packageName: string,
  productId: string,
  body: OneTimeProduct,
  options: {
    allowMissing?: boolean;
    updateMask?: string;
    /** Hotfix 9 — caller-supplied regionsVersion. When the body's regional
     *  prices were bootstrapped via `monetization.convertRegionPrices`,
     *  callers MUST pass the version echoed in that response to keep
     *  currencies consistent across the two calls. Defaults to
     *  REGIONS_VERSION when omitted (the convertRegionPrices-failed
     *  fallback path). */
    regionsVersion?: string;
  } = {},
): Promise<OneTimeProduct> {
  return timed("monetization.onetimeproducts.patch", packageName, productId, async () => {
    const client = buildClient(jwt);
    const res = await client.monetization.onetimeproducts.patch({
      packageName,
      productId,
      allowMissing: options.allowMissing,
      updateMask: options.updateMask ?? FULL_UPDATE_MASK,
      "regionsVersion.version": options.regionsVersion ?? REGIONS_VERSION,
      requestBody: body,
    });
    return res.data as OneTimeProduct;
  });
}

async function newBatchUpdateOneTimeProductStates(
  jwt: JWT,
  packageName: string,
  productId: string,
  purchaseOptionId: string,
  state: "ACTIVATE" | "DEACTIVATE",
): Promise<void> {
  await timed(
    "monetization.onetimeproducts.purchaseOptions.batchUpdateStates",
    packageName,
    productId,
    async () => {
      const client = buildClient(jwt);
      await client.monetization.onetimeproducts.purchaseOptions.batchUpdateStates({
        packageName,
        productId,
        requestBody: {
          requests: [
            state === "ACTIVATE"
              ? {
                  activatePurchaseOptionRequest: {
                    packageName,
                    productId,
                    purchaseOptionId,
                  },
                }
              : {
                  deactivatePurchaseOptionRequest: {
                    packageName,
                    productId,
                    purchaseOptionId,
                  },
                },
          ],
        },
      });
      return undefined;
    },
  );
}

async function newDeleteOneTimeProduct(
  jwt: JWT,
  packageName: string,
  productId: string,
): Promise<void> {
  await timed("monetization.onetimeproducts.delete", packageName, productId, async () => {
    const client = buildClient(jwt);
    await client.monetization.onetimeproducts.delete({ packageName, productId });
    return undefined;
  });
}

async function legacyInsertInAppProduct(
  jwt: JWT,
  packageName: string,
  body: InAppProduct,
): Promise<InAppProduct> {
  return timed("inappproducts.insert", packageName, body.sku ?? undefined, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.insert({
      packageName,
      requestBody: body,
    });
    return res.data as InAppProduct;
  });
}

async function legacyPatchInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
  body: InAppProduct,
): Promise<InAppProduct> {
  return timed("inappproducts.patch", packageName, sku, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.patch({
      packageName,
      sku,
      requestBody: body,
    });
    return res.data as InAppProduct;
  });
}

async function legacyDeleteInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
): Promise<void> {
  await timed("inappproducts.delete", packageName, sku, async () => {
    const client = buildClient(jwt);
    await client.inappproducts.delete({ packageName, sku });
    return undefined;
  });
}

/** Apply the desired state via the dedicated batchUpdateStates endpoint.
 *  Idempotent — ACTIVATE on an already-active option is harmless;
 *  DEACTIVATE on inactive same. Errors here are non-fatal for the
 *  parent write: we log and continue so the Manager at least gets the
 *  product written. State drift is recoverable via a subsequent edit.
 *  Returns whether the state call succeeded so callers can decide
 *  whether to re-fetch (Hotfix 12: post-apply re-read keeps UI in
 *  sync with Google's post-state-update view of the product). */
async function applyDesiredState(
  jwt: JWT,
  packageName: string,
  productId: string,
  purchaseOptionId: string,
  desiredState: "ACTIVE" | "INACTIVE",
): Promise<boolean> {
  try {
    await newBatchUpdateOneTimeProductStates(
      jwt,
      packageName,
      productId,
      purchaseOptionId,
      desiredState === "ACTIVE" ? "ACTIVATE" : "DEACTIVATE",
    );
    return true;
  } catch (err) {
    console.warn(
      `[google-iap:publisher] state apply failed pkg=${packageName} productId=${productId} desired=${desiredState} err="${
        err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
      }"`,
    );
    return false;
  }
}

/**
 * Hotfix 12: re-fetch a OneTimeProduct after `applyDesiredState` so the
 * caller sees the post-state-update view. `newPatchOneTimeProduct`
 * returns the product as it existed at create-time — purchaseOptions[].
 * state defaults to "DRAFT" on a brand-new option, which the adapter
 * maps to "inactive". Without the re-fetch, the UI shows Inactive even
 * though the subsequent ACTIVATE call succeeded on Google's side.
 *
 * Best-effort: if the get itself fails, fall back to the pre-update
 * snapshot. If the get returns a state that contradicts `applyDesiredState`
 * having succeeded (e.g. cache lag — get still shows DRAFT after a
 * successful ACTIVATE), overlay the desired state on the first matching
 * purchaseOption so the UI reflects Manager intent. Subsequent refreshes
 * pull ground truth once Google's list/get propagation catches up.
 */
async function refetchWithStateOverlay(
  jwt: JWT,
  packageName: string,
  productId: string,
  purchaseOptionId: string,
  fallback: OneTimeProduct,
  stateApplied: boolean,
  desiredState: "ACTIVE" | "INACTIVE",
): Promise<OneTimeProduct> {
  let fresh: OneTimeProduct;
  try {
    fresh = await newGetOneTimeProduct(jwt, packageName, productId);
  } catch (err) {
    console.warn(
      `[google-iap:publisher] post-state refetch failed pkg=${packageName} productId=${productId} err="${
        err instanceof Error ? err.message.replace(/"/g, "'") : String(err)
      }"`,
    );
    return fallback;
  }
  if (!stateApplied) return fresh;
  const opts = fresh.purchaseOptions ?? [];
  if (opts.length === 0) return fresh;
  const target = opts.find((o) => o.purchaseOptionId === purchaseOptionId);
  if (!target) return fresh;
  if (target.state === desiredState) return fresh;
  // Overlay: applyDesiredState reported success but the fresh read still
  // shows a pre-update state. Trust the write — propagation will catch
  // up on the next refresh.
  target.state = desiredState;
  return fresh;
}

/** Insert a new in-app product.
 *  Public surface unchanged; internally uses Monetization API v3
 *  patch+allowMissing (the new API's create idiom) with legacy
 *  fallback. State applied via the separate batchUpdateStates endpoint.
 *
 *  `options.regionsVersion` (Hotfix 9): pin the regions catalog version
 *  to match whichever Google used for `convertRegionPrices` when the
 *  caller bootstrapped regional prices — see newPatchOneTimeProduct
 *  options docs. */
export async function insertInAppProduct(
  jwt: JWT,
  packageName: string,
  body: InAppProduct,
  options: { regionsVersion?: string } = {},
): Promise<InAppProduct> {
  try {
    const writeShape = inAppProductToOneTimeProduct({
      ...body,
      packageName,
    } as ToolInAppProduct);
    const created = await newPatchOneTimeProduct(
      jwt,
      packageName,
      writeShape.product.productId ?? body.sku ?? "",
      writeShape.product,
      { allowMissing: true, regionsVersion: options.regionsVersion },
    );
    const productId = created.productId ?? body.sku ?? "";
    const stateApplied = await applyDesiredState(
      jwt,
      packageName,
      productId,
      writeShape.purchaseOptionId,
      writeShape.desiredState,
    );
    // Hotfix 12: re-fetch so the returned snapshot reflects state =
    // ACTIVE (not the stale DRAFT default from the create response).
    const fresh = await refetchWithStateOverlay(
      jwt,
      packageName,
      productId,
      writeShape.purchaseOptionId,
      created,
      stateApplied,
      writeShape.desiredState,
    );
    return oneTimeProductToInAppProduct(fresh) as unknown as InAppProduct;
  } catch (err) {
    try {
      const legacy = await legacyInsertInAppProduct(jwt, packageName, body);
      console.warn(
        `[google-iap:publisher] insert fallback pkg=${packageName} sku=${body.sku ?? "?"}`,
      );
      return legacy;
    } catch {
      throw err;
    }
  }
}

/** Patch (update) an existing in-app product.
 *  Same try-new-then-legacy pattern; state applied separately.
 *
 *  `options.regionsVersion` (Hotfix 9): see insertInAppProduct docs. */
export async function patchInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
  body: InAppProduct,
  options: { regionsVersion?: string } = {},
): Promise<InAppProduct> {
  try {
    const writeShape = inAppProductToOneTimeProduct({
      ...body,
      packageName,
      sku,
    } as ToolInAppProduct);
    const updated = await newPatchOneTimeProduct(
      jwt,
      packageName,
      sku,
      writeShape.product,
      { allowMissing: false, regionsVersion: options.regionsVersion },
    );
    const stateApplied = await applyDesiredState(
      jwt,
      packageName,
      sku,
      writeShape.purchaseOptionId,
      writeShape.desiredState,
    );
    // Hotfix 12: re-fetch so the returned snapshot reflects the
    // post-state-update view (active/inactive flips don't show in the
    // patch response since state is output-only on the product body).
    const fresh = await refetchWithStateOverlay(
      jwt,
      packageName,
      sku,
      writeShape.purchaseOptionId,
      updated,
      stateApplied,
      writeShape.desiredState,
    );
    return oneTimeProductToInAppProduct(fresh) as unknown as InAppProduct;
  } catch (err) {
    try {
      const legacy = await legacyPatchInAppProduct(jwt, packageName, sku, body);
      console.warn(
        `[google-iap:publisher] patch fallback pkg=${packageName} sku=${sku}`,
      );
      return legacy;
    } catch {
      throw err;
    }
  }
}

/** Delete an in-app product.
 *  Try new API first, fall back to legacy. */
export async function deleteInAppProduct(
  jwt: JWT,
  packageName: string,
  sku: string,
): Promise<void> {
  try {
    await newDeleteOneTimeProduct(jwt, packageName, sku);
  } catch (err) {
    try {
      await legacyDeleteInAppProduct(jwt, packageName, sku);
      console.warn(
        `[google-iap:publisher] delete fallback pkg=${packageName} sku=${sku}`,
      );
    } catch {
      throw err;
    }
  }
}

// Re-export the canonical purchase option id so orchestrators can pass
// it explicitly when they need to drive the state endpoint directly.
export { DEFAULT_PURCHASE_OPTION_ID };

/**
 * Q-GIAP.E: batchUpdate runs the Manager's preview decisions in a single
 * round-trip. Each request is an insert / update / delete operation.
 */
export async function batchUpdateInAppProducts(
  jwt: JWT,
  packageName: string,
  requestBody: InappproductsBatchUpdateRequest,
): Promise<InappproductsBatchUpdateResponse> {
  return timed("inappproducts.batchUpdate", packageName, undefined, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.batchUpdate({
      packageName,
      requestBody,
    });
    return res.data as InappproductsBatchUpdateResponse;
  });
}

/**
 * Fetch app-level details (defaultLanguage, contact info) via the edits
 * resource — the only way Android Publisher v3 exposes app metadata.
 *
 * Hotfix 4: requires the 3-step edits dance because there's no
 * applications.get endpoint:
 *   1. POST /edits         → create a transient edit, returns editId
 *   2. GET  /edits/{id}/details → AppDetails
 *   3. DELETE /edits/{id}  → discard (no app state changes)
 *
 * The edit is never committed, so step 3 leaves the app exactly as it
 * was. Step 3 failures are logged but not thrown (Google auto-expires
 * untouched edits after ~7 days; an orphan won't block future syncs).
 *
 * Errors from steps 1 / 2 throw to the caller so the apps refresh loop
 * can tolerate per-app failures without aborting the whole run.
 */
export async function getAppDetails(
  jwt: JWT,
  packageName: string,
): Promise<AppDetails> {
  const client = buildClient(jwt);

  // Step 1: create edit.
  const editId = await timed("edits.insert", packageName, undefined, async () => {
    const res = await client.edits.insert({
      packageName,
      requestBody: {},
    });
    const id = res.data.id;
    if (!id) throw new Error("edits.insert returned no id");
    return id;
  });

  // Step 2: read details. Wrap so we can guarantee cleanup attempt.
  let details: AppDetails;
  try {
    details = await timed("edits.details.get", packageName, undefined, async () => {
      const res = await client.edits.details.get({ packageName, editId });
      return res.data as AppDetails;
    });
  } finally {
    // Step 3: best-effort cleanup. Swallow errors — orphan edits expire
    // server-side automatically.
    try {
      await timed("edits.delete", packageName, undefined, async () => {
        await client.edits.delete({ packageName, editId });
        return undefined;
      });
    } catch {
      /* logged by `timed`; nothing else to do */
    }
  }

  return details;
}

/**
 * Preview-only price conversion. Useful for the Manager's "what would
 * Google auto-equalize this base price to in EUR/JPY/etc?" UX before
 * commit. Not required for create/update flows.
 */
export async function convertRegionPrices(
  jwt: JWT,
  packageName: string,
  requestBody: ConvertRegionPricesRequest,
): Promise<ConvertRegionPricesResponse> {
  return timed(
    "monetization.convertRegionPrices",
    packageName,
    undefined,
    async () => {
      const client = buildClient(jwt);
      const res = await client.monetization.convertRegionPrices({
        packageName,
        requestBody,
      });
      return res.data as ConvertRegionPricesResponse;
    },
  );
}
