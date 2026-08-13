/**
 * Post-write verification — THE STATUS PRINCIPLE, applied to IAP updates (SC1).
 *
 * WHY THIS EXISTS. `updateIapOnGoogle` used to return `hasChanges: true`
 * unconditionally the moment its own diff was non-empty. That reports the
 * diff the tool COMPUTED, never what Google DID. Pair that with a publisher
 * log line that records no body and no size (logging.ts:26-39) and a write
 * that changed nothing on Google is indistinguishable from a real one at
 * EVERY layer — UI toast, API response, audit row, Railway log. That is why
 * the silent base-price no-op survived from 44900f8 (2026-05-21) until a
 * Manager happened to re-check Play Console.
 *
 * A terminal status must reflect the real outcome, never the button clicked.
 *
 * WHAT IT COMPARES. The caller already re-reads the product from Google
 * after the write (publisher-client's `refetchWithStateOverlay`), so ground
 * truth is in hand for free. This module compares three things, all in
 * micros, all exact-string — no rounding, no normalisation, no tolerance
 * window. A value that came back from Google is compared exactly as Google
 * sent it.
 *
 * DELIBERATELY CONSERVATIVE. `noOp` is only ever true when we can PROVE
 * nothing moved: the write asked to change at least one thing, and every
 * single one of those things came back still equal to the pre-write value.
 * Anything ambiguous (missing response pricing, partial application) leaves
 * `noOp` false and surfaces via `unappliedRegions` instead. A false "your
 * write worked" is the failure mode that cost three months; a false "it
 * didn't" would only cost a re-check. Prefer a missed signal over a wrong one
 * — but bias the miss toward the cheap direction.
 *
 * Pure: no I/O, no network, no DB.
 */

export interface PriceEntry {
  currency: string;
  priceMicros: string;
}

export type PriceMap = Record<string, PriceEntry>;

export interface VerifyPricingInput {
  /** Pre-write state, from the cache snapshot the diff was computed against. */
  before: PriceMap;
  /** Exactly what the tool put on the wire. */
  intended: PriceMap;
  /** Google's post-write state, from the re-read. Null when unavailable. */
  applied: PriceMap | null;
  /** Base price the Manager asked for, in micros. */
  intendedBaseMicros: string;
  /** Base price Google reports after the write (derived US-or-first config).
   *  Null when the response carried no pricing. */
  appliedBaseMicros: string | null;
  /** True when the Manager's diff actually included a base-price change. */
  baseChangeRequested: boolean;
}

export interface WriteVerification {
  /** False when Google's response carried nothing to compare against, so
   *  no verdict can honestly be given. */
  checked: boolean;
  /** Regions the tool asked Google to set that came back different.
   *  Sorted, so audit payloads and log lines are deterministic. */
  unappliedRegions: string[];
  /** Regions the write was SUPPOSED to move (intended differs from before). */
  intendedChangeCount: number;
  /** null when the Manager did not change the base price. */
  basePriceApplied: boolean | null;
  /** True only when the write demonstrably moved nothing at all. */
  noOp: boolean;
}

function sameEntry(a: PriceEntry | undefined, b: PriceEntry | undefined): boolean {
  if (!a || !b) return a === b;
  // Exact string compare on micros — never parse, never round. Currency is
  // compared case-insensitively only because Google occasionally lowercases
  // inbound codes (same normalisation iap-diff.ts already applies).
  return (
    a.priceMicros === b.priceMicros &&
    a.currency.trim().toUpperCase() === b.currency.trim().toUpperCase()
  );
}

export function verifyPricingLanded(input: VerifyPricingInput): WriteVerification {
  const {
    before,
    intended,
    applied,
    intendedBaseMicros,
    appliedBaseMicros,
    baseChangeRequested,
  } = input;

  // Regions this write was supposed to move.
  const intendedChanges = Object.keys(intended).filter(
    (region) => !sameEntry(intended[region], before[region]),
  );

  if (applied === null || Object.keys(applied).length === 0) {
    return {
      checked: false,
      unappliedRegions: [],
      intendedChangeCount: intendedChanges.length,
      basePriceApplied: baseChangeRequested ? null : null,
      noOp: false,
    };
  }

  const unappliedRegions = Object.keys(intended)
    .filter((region) => !sameEntry(intended[region], applied[region]))
    .sort();

  const basePriceApplied = baseChangeRequested
    ? appliedBaseMicros === intendedBaseMicros
    : null;

  // Every region we meant to move is still sitting at its pre-write value…
  const noRegionMoved =
    intendedChanges.length > 0 &&
    intendedChanges.every((region) => sameEntry(applied[region], before[region]));
  // …and the base price (if it was part of the ask) did not land either.
  const baseDidNotLand = baseChangeRequested ? basePriceApplied === false : true;

  const askedForSomething = intendedChanges.length > 0 || baseChangeRequested;

  return {
    checked: true,
    unappliedRegions,
    intendedChangeCount: intendedChanges.length,
    basePriceApplied,
    noOp:
      askedForSomething &&
      baseDidNotLand &&
      (intendedChanges.length === 0 || noRegionMoved),
  };
}
