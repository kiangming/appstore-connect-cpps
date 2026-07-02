/**
 * Client-side fetch helper for the per-app IAPs "Refresh" action.
 *
 * The plain fetch() previously had no timeout, so a slow refresh (large
 * app, transient network) surfaced the browser's ambiguous "Failed to
 * fetch" TypeError with no indication it was a timeout. This wraps fetch
 * in an AbortController with an explicit ceiling and maps failures to a
 * clear, actionable message.
 *
 * Pure + injectable (fetchImpl) so it unit-tests without a DOM.
 */

/** Distinguishes an explicit client-side timeout from other fetch errors. */
export class RefreshTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Refresh timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "RefreshTimeoutError";
  }
}

/** Default client ceiling — comfortably above a bulk 1000-item refresh
 *  (now seconds) while still bounding a hung request. */
export const REFRESH_TIMEOUT_MS = 120_000;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (err) {
    // An abort raises a DOMException named "AbortError" — translate it to
    // the typed timeout so callers can render the clear message.
    if (err instanceof Error && err.name === "AbortError") {
      throw new RefreshTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Map a refresh failure to a clear, user-facing message. */
export function describeRefreshError(err: unknown): string {
  if (err instanceof RefreshTimeoutError) {
    return `${err.message} — the app may have many items; try again.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Network error";
}
