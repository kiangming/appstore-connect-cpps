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

/** Insert a new in-app product. The body must include sku, purchaseType,
 *  status, defaultLanguage, listings, defaultPrice (or prices). */
export async function insertInAppProduct(
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

/** Patch (partial update) an existing in-app product. */
export async function patchInAppProduct(
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

/** Delete an in-app product. */
export async function deleteInAppProduct(
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
