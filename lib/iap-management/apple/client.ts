/**
 * Apple App Store Connect — IAP API endpoint wrappers.
 *
 * Each function: builds the JSON:API request, calls `iapFetch`, returns the
 * typed `AscApiResponse`. For rate-limit-aware calls, compose at the call
 * site: `await withRetry(() => createInAppPurchase(creds, payload))`.
 *
 * Endpoint paths are best-effort per Apple's public docs + community
 * references (dfabulich/node-app-store-connect-api). Apple's IAP API surface
 * mixes /v1 and /v2 paths — V2 is the modern entry for the resource itself,
 * but child resources (localizations, screenshots, submissions) still use /v1.
 *
 * Verify endpoint paths at IAP.n UAT against real Apple Connect; patch as
 * needed via a follow-up sub-chunk if Apple's actual behavior differs.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { iapFetch } from "./fetch";
import type {
  AscApiResponse,
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseReviewScreenshot,
  CreateInAppPurchasePayload,
  UpdateInAppPurchasePayload,
  CreateInAppPurchaseLocalizationPayload,
  UpdateInAppPurchaseLocalizationPayload,
  UploadOperation,
} from "@/types/iap-management/apple";

// ─── IAP CRUD ────────────────────────────────────────────────────────────────

export async function listInAppPurchases(
  creds: AscCredentials,
  appAppleId: string,
): Promise<AscApiResponse<InAppPurchase[]>> {
  return iapFetch<AscApiResponse<InAppPurchase[]>>(
    creds,
    "GET",
    `/v1/apps/${appAppleId}/inAppPurchasesV2?limit=200`,
  );
}

export async function getInAppPurchase(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<InAppPurchase>> {
  return iapFetch<AscApiResponse<InAppPurchase>>(
    creds,
    "GET",
    `/v2/inAppPurchases/${iapId}?include=inAppPurchaseLocalizations,reviewScreenshot`,
  );
}

export async function createInAppPurchase(
  creds: AscCredentials,
  payload: CreateInAppPurchasePayload,
): Promise<AscApiResponse<InAppPurchase>> {
  return iapFetch<AscApiResponse<InAppPurchase>>(
    creds,
    "POST",
    "/v2/inAppPurchases",
    {
      data: {
        type: "inAppPurchases",
        attributes: {
          name: payload.name,
          productId: payload.productId,
          inAppPurchaseType: payload.inAppPurchaseType,
          ...(payload.reviewNote ? { reviewNote: payload.reviewNote } : {}),
          ...(typeof payload.familySharable === "boolean"
            ? { familySharable: payload.familySharable }
            : {}),
        },
        relationships: {
          app: { data: { type: "apps", id: payload.appId } },
        },
      },
    },
  );
}

export async function updateInAppPurchase(
  creds: AscCredentials,
  iapId: string,
  patch: UpdateInAppPurchasePayload,
): Promise<AscApiResponse<InAppPurchase>> {
  const attrs: Record<string, unknown> = {};
  if (patch.name !== undefined) attrs.name = patch.name;
  if (patch.reviewNote !== undefined) attrs.reviewNote = patch.reviewNote;
  if (typeof patch.familySharable === "boolean") {
    attrs.familySharable = patch.familySharable;
  }
  return iapFetch<AscApiResponse<InAppPurchase>>(
    creds,
    "PATCH",
    `/v2/inAppPurchases/${iapId}`,
    {
      data: {
        type: "inAppPurchases",
        id: iapId,
        attributes: attrs,
      },
    },
  );
}

export async function deleteInAppPurchase(
  creds: AscCredentials,
  iapId: string,
): Promise<void> {
  return iapFetch<void>(creds, "DELETE", `/v2/inAppPurchases/${iapId}`);
}

// ─── Localizations ───────────────────────────────────────────────────────────

export async function listInAppPurchaseLocalizations(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<InAppPurchaseLocalization[]>> {
  return iapFetch<AscApiResponse<InAppPurchaseLocalization[]>>(
    creds,
    "GET",
    `/v2/inAppPurchases/${iapId}/inAppPurchaseLocalizations?limit=200`,
  );
}

export async function createInAppPurchaseLocalization(
  creds: AscCredentials,
  payload: CreateInAppPurchaseLocalizationPayload,
): Promise<AscApiResponse<InAppPurchaseLocalization>> {
  return iapFetch<AscApiResponse<InAppPurchaseLocalization>>(
    creds,
    "POST",
    "/v1/inAppPurchaseLocalizations",
    {
      data: {
        type: "inAppPurchaseLocalizations",
        attributes: {
          locale: payload.locale,
          name: payload.name,
          ...(payload.description ? { description: payload.description } : {}),
        },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: payload.iapId },
          },
        },
      },
    },
  );
}

export async function updateInAppPurchaseLocalization(
  creds: AscCredentials,
  localizationId: string,
  patch: UpdateInAppPurchaseLocalizationPayload,
): Promise<AscApiResponse<InAppPurchaseLocalization>> {
  const attrs: Record<string, unknown> = {};
  if (patch.name !== undefined) attrs.name = patch.name;
  if (patch.description !== undefined) attrs.description = patch.description;
  return iapFetch<AscApiResponse<InAppPurchaseLocalization>>(
    creds,
    "PATCH",
    `/v1/inAppPurchaseLocalizations/${localizationId}`,
    {
      data: {
        type: "inAppPurchaseLocalizations",
        id: localizationId,
        attributes: attrs,
      },
    },
  );
}

// ─── Review Screenshots (3-step upload, mirrors CPP pattern) ────────────────

export async function reserveInAppPurchaseScreenshot(
  creds: AscCredentials,
  iapId: string,
  fileName: string,
  fileSize: number,
): Promise<AscApiResponse<InAppPurchaseReviewScreenshot>> {
  return iapFetch<AscApiResponse<InAppPurchaseReviewScreenshot>>(
    creds,
    "POST",
    "/v1/inAppPurchaseReviewScreenshots",
    {
      data: {
        type: "inAppPurchaseReviewScreenshots",
        attributes: { fileName, fileSize },
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: iapId },
          },
        },
      },
    },
  );
}

export async function confirmInAppPurchaseScreenshot(
  creds: AscCredentials,
  screenshotId: string,
  sourceFileChecksum: string,
): Promise<AscApiResponse<InAppPurchaseReviewScreenshot>> {
  return iapFetch<AscApiResponse<InAppPurchaseReviewScreenshot>>(
    creds,
    "PATCH",
    `/v1/inAppPurchaseReviewScreenshots/${screenshotId}`,
    {
      data: {
        type: "inAppPurchaseReviewScreenshots",
        id: screenshotId,
        attributes: { uploaded: true, sourceFileChecksum },
      },
    },
  );
}

/**
 * Upload bytes directly to Apple's CDN via the presigned operations returned
 * by `reserveInAppPurchaseScreenshot`. No creds needed — operations are
 * pre-signed. Mirrors lib/asc-client.ts `uploadAssetToOperations`.
 */
export async function uploadScreenshotToOperations(
  uploadOperations: UploadOperation[],
  file: Blob,
): Promise<void> {
  for (const op of uploadOperations) {
    const chunk = file.slice(op.offset, op.offset + op.length);
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders ?? []) {
      headers[h.name] = h.value;
    }
    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: chunk,
    });
    if (!res.ok) {
      throw new Error(
        `IAP screenshot upload chunk failed: ${res.status} ${op.url}`,
      );
    }
  }
}

// ─── Submit for Apple Review ─────────────────────────────────────────────────

/**
 * Submit a draft IAP for Apple Review. Apple's endpoint is
 * /v1/inAppPurchaseSubmissions per current public schema. The submission
 * resource has no attributes — just the relationship to the IAP being
 * submitted. Apple flips the IAP's `state` to `WAITING_FOR_REVIEW` server-side.
 */
export async function submitInAppPurchase(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<{ id: string; type: string }>> {
  return iapFetch<AscApiResponse<{ id: string; type: string }>>(
    creds,
    "POST",
    "/v1/inAppPurchaseSubmissions",
    {
      data: {
        type: "inAppPurchaseSubmissions",
        relationships: {
          inAppPurchaseV2: {
            data: { type: "inAppPurchases", id: iapId },
          },
        },
      },
    },
  );
}
