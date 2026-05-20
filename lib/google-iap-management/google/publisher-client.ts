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

/** List all in-app products for the given package. */
export async function listInAppProducts(
  jwt: JWT,
  packageName: string,
): Promise<InAppProduct[]> {
  return timed("inappproducts.list", packageName, undefined, async () => {
    const client = buildClient(jwt);
    const res = await client.inappproducts.list({ packageName });
    return (res.data.inappproduct ?? []) as InAppProduct[];
  });
}

/** Get a single in-app product by SKU. */
export async function getInAppProduct(
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
