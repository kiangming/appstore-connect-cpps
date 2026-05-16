/**
 * Apple screenshot 3-step upload, shared by:
 *   • Single-IAP /create-on-apple endpoint (IAP.o.6a)
 *   • Bulk-import /execute endpoint (IAP.i, refactored in IAP.o.6c)
 *
 * Steps (per Apple ASC API contract):
 *   1. POST /v1/inAppPurchaseReviewScreenshots — reserve, get uploadOperations.
 *   2. PUT each presigned chunk — uploadScreenshotToOperations.
 *   3. PATCH /v1/inAppPurchaseReviewScreenshots/{id} — confirm with md5.
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

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
