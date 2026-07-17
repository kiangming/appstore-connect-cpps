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
import { iapFetch, withRetry } from "./fetch";
import { log } from "@/lib/logger";
import type {
  AscApiResponse,
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
  InAppPurchaseVersion,
  CreateInAppPurchasePayload,
  UpdateInAppPurchasePayload,
  CreateInAppPurchaseLocalizationPayload,
  UpdateInAppPurchaseLocalizationPayload,
  UploadOperation,
} from "@/types/iap-management/apple";

// ─── IAP CRUD ────────────────────────────────────────────────────────────────

/**
 * Single-page fetch (cap 200). Preserved as-is for callers that explicitly
 * want one page — most callers should use `listAllInAppPurchases` instead,
 * which follows Apple's `links.next` until exhausted. Hard-coded 200 was the
 * source of IAP.o.7 Issues 2+3 when apps exceeded that count.
 */
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

/**
 * Fetch the FULL list of IAPs for an app, following Apple's `links.next`
 * pagination until exhausted (Manager IAP.o.7 lock — apps with >200 IAPs
 * silently truncated under the legacy single-page wrapper, breaking the
 * bulk-import conflict resolution and IAP list UI).
 *
 * Per-page retry is composed via `withRetry` inside this function: a 429 on
 * page N retries that page only, not the whole iteration. Callers MUST NOT
 * wrap this in their own `withRetry`.
 *
 * Returns an `AscApiResponse<InAppPurchase[]>` with `data` accumulated across
 * pages; `links` and `meta` are intentionally dropped because they describe a
 * specific page, not the aggregate.
 */
export async function listAllInAppPurchases(
  creds: AscCredentials,
  appAppleId: string,
): Promise<AscApiResponse<InAppPurchase[]>> {
  const accumulated: InAppPurchase[] = [];
  let next: string | undefined = `/v1/apps/${appAppleId}/inAppPurchasesV2?limit=200`;
  let pageCount = 0;

  while (next) {
    const path = next;
    const page = await withRetry(() =>
      iapFetch<AscApiResponse<InAppPurchase[]>>(creds, "GET", path),
    );
    pageCount++;
    if (page.data && page.data.length > 0) {
      accumulated.push(...page.data);
    }
    next = extractNextPagePath(page.links?.next);
  }

  await log(
    "iap-apple",
    `listAllInAppPurchases app=${appAppleId} pages=${pageCount} total=${accumulated.length}`,
  );

  return { data: accumulated };
}

/**
 * Extract the path-and-query portion of an Apple `links.next` URL so it can
 * be fed back to `iapFetch` (which prepends ASC_BASE_URL). Apple returns a
 * fully-qualified URL; we strip the origin defensively in case Apple ever
 * changes the host. Returns `undefined` for missing or malformed inputs so
 * the pagination loop terminates cleanly.
 */
function extractNextPagePath(nextUrl: string | undefined): string | undefined {
  if (!nextUrl) return undefined;
  try {
    const url = new URL(nextUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

export async function getInAppPurchase(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<InAppPurchase>> {
  return iapFetch<AscApiResponse<InAppPurchase>>(
    creds,
    "GET",
    `/v2/inAppPurchases/${iapId}?include=inAppPurchaseLocalizations,appStoreReviewScreenshot`,
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

/** IAP.o.12a — DELETE a localization. Used by update-orchestration when the
 *  Manager removes a locale from the edit form. */
export async function deleteInAppPurchaseLocalization(
  creds: AscCredentials,
  localizationId: string,
): Promise<void> {
  return iapFetch<void>(
    creds,
    "DELETE",
    `/v1/inAppPurchaseLocalizations/${localizationId}`,
  );
}

// ─── Review Screenshots (3-step upload, mirrors CPP pattern) ────────────────

export async function reserveInAppPurchaseScreenshot(
  creds: AscCredentials,
  iapId: string,
  fileName: string,
  fileSize: number,
): Promise<AscApiResponse<InAppPurchaseAppStoreReviewScreenshot>> {
  return iapFetch<AscApiResponse<InAppPurchaseAppStoreReviewScreenshot>>(
    creds,
    "POST",
    "/v1/inAppPurchaseAppStoreReviewScreenshots",
    {
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
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
): Promise<AscApiResponse<InAppPurchaseAppStoreReviewScreenshot>> {
  return iapFetch<AscApiResponse<InAppPurchaseAppStoreReviewScreenshot>>(
    creds,
    "PATCH",
    `/v1/inAppPurchaseAppStoreReviewScreenshots/${screenshotId}`,
    {
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        id: screenshotId,
        attributes: { uploaded: true, sourceFileChecksum },
      },
    },
  );
}

/**
 * Delete an existing review screenshot. Used by the bulk-import OVERWRITE
 * path (IAP.o.8a) to replace a previously-uploaded screenshot — Apple's
 * `appStoreReviewScreenshot` relationship is to-one, so a fresh upload must
 * be preceded by a DELETE when one already exists.
 *
 * Apple returns 409 when the IAP is in WAITING_FOR_REVIEW / IN_REVIEW —
 * callers should catch `AppleApiError` with `status === 409` and surface a
 * non-fatal warning rather than failing the whole import.
 */
export async function deleteInAppPurchaseScreenshot(
  creds: AscCredentials,
  screenshotId: string,
): Promise<void> {
  return iapFetch<void>(
    creds,
    "DELETE",
    `/v1/inAppPurchaseAppStoreReviewScreenshots/${screenshotId}`,
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

// ─── IAP Versions (reviewSubmissions v2 migration) ──────────────────────────

/**
 * List the versions Apple already has for this IAP. Confirmed empirically
 * (design doc §0 Q1) that a READY_TO_SUBMIT IAP already has one in
 * PREPARE_FOR_SUBMISSION — the v2 submit flow READS this, it does not
 * create a version in the common path.
 */
export async function listInAppPurchaseVersions(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<InAppPurchaseVersion[]>> {
  return iapFetch<AscApiResponse<InAppPurchaseVersion[]>>(
    creds,
    "GET",
    `/v2/inAppPurchases/${iapId}/versions`,
  );
}

/**
 * Rare defensive fallback for the v2 submit flow — only called when
 * `listInAppPurchaseVersions` returns no submittable version (should be
 * rare-to-never given the empirical finding above). The created version
 * cannot be deleted (no DELETE endpoint exists) — callers MUST log this
 * explicitly and surface an orphan warning if the subsequent
 * reviewSubmissionItem add then fails, since the version now permanently
 * exists on Apple regardless of whether submission completes.
 */
export async function createInAppPurchaseVersion(
  creds: AscCredentials,
  iapId: string,
): Promise<AscApiResponse<InAppPurchaseVersion>> {
  return iapFetch<AscApiResponse<InAppPurchaseVersion>>(
    creds,
    "POST",
    "/v1/inAppPurchaseVersions",
    {
      data: {
        type: "inAppPurchaseVersions",
        relationships: {
          inAppPurchase: { data: { type: "inAppPurchases", id: iapId } },
        },
      },
    },
  );
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
