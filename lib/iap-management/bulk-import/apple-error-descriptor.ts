import { AppleApiError } from "@/lib/iap-management/apple/fetch";

export interface AppleErrorDescriptor {
  /** Same 500-char-capped shape the bulk-import route's old `errMsg()`
   *  always returned — backward compatible with every existing consumer
   *  of `result.error`/`submit_error`. */
  message: string;
  /** The COMPLETE, uncapped Apple response body (or full error message for
   *  a non-Apple error) — never sliced. Feeds `error_full`/`submit_error_full`
   *  for the result table's expandable Notes detail view. */
  full: string;
  /** Apple's HTTP status, when `err` is an `AppleApiError`. */
  httpStatus?: number;
}

/**
 * Extracted out of the bulk-import execute route (rather than defined
 * inline) because Next.js App Router route files only permit a fixed set
 * of exports (GET/POST/config/...) — any other named export fails the
 * route's own type-check. Living here also gives the un-truncation
 * guarantee (`full` carries the COMPLETE body, `message` stays capped) a
 * direct unit-test seam, since this route's per-IAP orchestration has no
 * dedicated mock harness (see execute/route.test.ts header comment).
 */
export function describeAppleError(err: unknown): AppleErrorDescriptor {
  if (err instanceof AppleApiError) {
    return {
      message: `${err.status}: ${err.body.slice(0, 500)}`,
      full: err.body,
      httpStatus: err.status,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { message: msg, full: msg };
}
