/**
 * Apple screenshot 3-step upload, shared by:
 *   • Single-IAP /create-on-apple endpoint (IAP.o.6a)
 *   • Bulk-import /execute endpoint (IAP.i, refactored in IAP.o.6c)
 *
 * Steps (per Apple ASC API contract):
 *   1. POST /v1/inAppPurchaseAppStoreReviewScreenshots — reserve, get uploadOperations.
 *   2. PUT each presigned chunk — uploadScreenshotToOperations.
 *   3. PATCH /v1/inAppPurchaseAppStoreReviewScreenshots/{id} — confirm with md5.
 *
 * Each Apple call is wrapped in withRetry (429-aware). Errors are caught and
 * returned as a typed result so callers can decide whether to fail the whole
 * orchestration or surface a non-fatal warning.
 */

import { createHash } from "crypto";
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  reserveInAppPurchaseScreenshot,
  uploadScreenshotToOperations,
  confirmInAppPurchaseScreenshot,
  deleteInAppPurchaseScreenshot,
  getInAppPurchase,
} from "./client";
import { withRetry, AppleApiError } from "./fetch";

export interface ScreenshotUploadSuccess {
  ok: true;
  apple_screenshot_id: string;
  file_name: string;
  file_size: number;
}

export interface ScreenshotUploadFailure {
  ok: false;
  /** Which step failed — surfaces in audit logs + UI error messages. */
  stage: "reserve" | "upload" | "confirm";
  error: string;
  /** When the failure is mid-flow, the screenshot record may exist on Apple's
   *  side. Callers may want to surface this id for manual cleanup. */
  apple_screenshot_id?: string;
}

export type ScreenshotUploadResult =
  | ScreenshotUploadSuccess
  | ScreenshotUploadFailure;

/**
 * Run the 3-step upload for a single screenshot file against an existing
 * Apple IAP. Caller supplies the file (server-side `File` or `Blob`, already
 * validated for size + type at the route layer).
 */
export async function uploadScreenshotToApple(
  creds: AscCredentials,
  appleIapId: string,
  file: File,
): Promise<ScreenshotUploadResult> {
  let appleScreenshotId: string | undefined;

  // Step 1 — reserve
  let reserved;
  try {
    reserved = await withRetry(() =>
      reserveInAppPurchaseScreenshot(creds, appleIapId, file.name, file.size),
    );
    appleScreenshotId = reserved.data.id;
  } catch (err) {
    return {
      ok: false,
      stage: "reserve",
      error: errMsg(err),
    };
  }

  const ops = reserved.data.attributes.uploadOperations;
  if (!ops || ops.length === 0) {
    return {
      ok: false,
      stage: "reserve",
      error: "Apple returned no uploadOperations",
      apple_screenshot_id: appleScreenshotId,
    };
  }

  // Step 2 — upload bytes
  try {
    await uploadScreenshotToOperations(ops, file);
  } catch (err) {
    return {
      ok: false,
      stage: "upload",
      error: errMsg(err),
      apple_screenshot_id: appleScreenshotId,
    };
  }

  // Step 3 — confirm with MD5 checksum
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const checksum = createHash("md5").update(buf).digest("hex");
    await withRetry(() =>
      confirmInAppPurchaseScreenshot(creds, appleScreenshotId!, checksum),
    );
  } catch (err) {
    return {
      ok: false,
      stage: "confirm",
      error: errMsg(err),
      apple_screenshot_id: appleScreenshotId,
    };
  }

  return {
    ok: true,
    apple_screenshot_id: appleScreenshotId!,
    file_name: file.name,
    file_size: file.size,
  };
}

/**
 * IAP.o.8a — replace-or-upload orchestration for the bulk-import OVERWRITE
 * path. Mirrors the CPP "swap screenshot of existing approved asset" pattern.
 *
 * Steps:
 *   1. GET the IAP with `?include=appStoreReviewScreenshot` to discover
 *      whether a screenshot is currently attached.
 *   2. If one exists, DELETE it. If Apple returns 409 (IAP in review /
 *      waiting-for-review / approved-but-locked), surface a non-fatal
 *      `delete-locked` failure so the caller can mark the row with a hint
 *      instead of aborting the import.
 *   3. Run the standard 3-step upload via `uploadScreenshotToApple`.
 *
 * Returns the same `ScreenshotUploadResult` shape as the upload-only path,
 * with one extra stage tag `delete-locked` for the 409 case.
 */
export async function replaceScreenshotOnApple(
  creds: AscCredentials,
  appleIapId: string,
  file: File,
): Promise<ScreenshotReplaceResult> {
  let existingScreenshotId: string | undefined;
  try {
    const res = await withRetry(() => getInAppPurchase(creds, appleIapId));
    existingScreenshotId = extractAppStoreReviewScreenshotId(res);
  } catch (err) {
    return {
      ok: false,
      stage: "lookup",
      error: errMsg(err),
    };
  }

  if (existingScreenshotId) {
    try {
      await withRetry(() =>
        deleteInAppPurchaseScreenshot(creds, existingScreenshotId!),
      );
    } catch (err) {
      // Apple returns 409 when the IAP is locked (in review / approved). Surface
      // as a typed non-fatal so the bulk-import caller can mark the row with a
      // human-readable hint instead of failing the whole orchestration.
      if (err instanceof AppleApiError && err.status === 409) {
        return {
          ok: false,
          stage: "delete-locked",
          error: errMsg(err),
          apple_screenshot_id: existingScreenshotId,
        };
      }
      return {
        ok: false,
        stage: "delete",
        error: errMsg(err),
        apple_screenshot_id: existingScreenshotId,
      };
    }
  }

  return await uploadScreenshotToApple(creds, appleIapId, file);
}

/**
 * Extract the id of the `appStoreReviewScreenshot` to-one relationship from a
 * `getInAppPurchase` response. Returns undefined when no screenshot is
 * currently attached — that is the common case for OVERWRITE imports where
 * the original IAP was created without one.
 *
 * The shape lives in `data.relationships.appStoreReviewScreenshot.data.id`
 * per Apple JSON:API; defensive optional chaining keeps the helper resilient
 * to Apple returning the relationship object without `data` (links-only).
 */
function extractAppStoreReviewScreenshotId(
  res: { data?: { relationships?: Record<string, unknown> } },
): string | undefined {
  const rel = res.data?.relationships?.appStoreReviewScreenshot as
    | { data?: { id?: string } | null }
    | undefined;
  return rel?.data?.id;
}

export type ScreenshotReplaceResult =
  | ScreenshotUploadSuccess
  | ScreenshotUploadFailure
  | {
      ok: false;
      stage: "lookup" | "delete" | "delete-locked";
      error: string;
      apple_screenshot_id?: string;
    };

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
