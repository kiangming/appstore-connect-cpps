/**
 * Apple price-schedule POST wrapper (IAP.o.9a → IAP.o.11d).
 *
 * Apple's price-schedule endpoint is "replace-all" — every POST replaces the
 * entire current schedule, there is no PATCH. We only ever set a single
 * manual price entry at startDate=null (effective immediately), which covers
 * the Manager's bulk-import + create-on-apple flows. Scheduled pricing
 * (future startDate) is out of scope for IAP.o.9.
 *
 * The payload requires a "local id" reference that links the
 * `manualPrices.data[].id` array entry to the matching `included[].id`.
 * IAP.o.11d (Apple instrumentation log): Apple rejects plain UUIDs with
 * `ENTITY_ERROR.INCLUDED.INVALID_ID` — "the id must be a local id with the
 * format '${local-id}'". The literal `${...}` syntax is required (JSON:API
 * compound-document "lid" convention). We use `${price-1}` since we only
 * ever send one price entry per request.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  iapFetch,
  withRetry,
  AppleApiError,
  AppleRateLimitError,
} from "./fetch";
import type {
  AscApiResponse,
  AscResource,
  InAppPurchasePrice,
  InAppPurchasePriceSchedule,
} from "@/types/iap-management/apple";

export interface SetPriceScheduleArgs {
  appleIapId: string;
  /** Base territory price-point (USA in practice). Apple equalizes the
   *  remaining territories from this one unless overridden by
   *  `additionalPricePointIds`. */
  applePricePointId: string;
  baseTerritory?: string;
  /**
   * IAP.p1.e — additional per-territory price-point overrides included in
   * the same POST. Each id is an opaque Apple identifier resolved by the
   * orchestrator from a per-territory pricePoints fetch. Empty array (the
   * default) preserves the single-price behavior of IAP.o.11d.
   */
  additionalPricePointIds?: readonly string[];
  /** Test seam: deterministic sleep + override delays + jitter. Defaults to
   *  IAP.o.11a budget (500 → 1500 → 4000 → 10000 → 30000 ms + ±20% jitter). */
  retryConfig?: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    /** 0 disables jitter (deterministic tests). Default 0.2 → ±20% per attempt. */
    jitterRatio?: number;
    /** Deterministic random source for tests. Returns [0, 1). */
    rng?: () => number;
  };
}

export interface SetPriceScheduleSuccess {
  ok: true;
  schedule_id: string;
  attempts: number;
}

/**
 * WHY the failure carries a classification and not just a message.
 *
 * ⚠ CLASSIFIED AT THE CATCH, WHERE `instanceof` STILL WORKS — never parsed
 * back out of `error`. This is the third time this repo has needed the rule:
 * `export-fetch.ts` states it for the export path, and the custom-prices
 * baseline route had to drop a `/404/.test(err.message)` that matched any
 * error whose text happened to contain "404" (including one whose URL did).
 * A message is for a human; a type is for the code.
 *
 *   RATE_LIMITED — a 429. The one classification that means something about
 *                  the NEXT call, not just this one, which is why the whole
 *                  chain exists: it is what lets the shipped stop latch see
 *                  that the batch should stop.
 *   APPLE_5XX    — Apple's intermittent 500 (forum thread 728081). Already
 *                  retried by the loop below; arriving here means the budget
 *                  is spent.
 *   APPLE_ERROR  — a 4xx that is not 429 (409, 422 — payload problems).
 *                  Retrying changes nothing.
 *   UNKNOWN      — transport/parse. Neither of the above may be claimed.
 */
export type SetPriceScheduleFailureKind =
  | "RATE_LIMITED"
  | "APPLE_5XX"
  | "APPLE_ERROR"
  | "UNKNOWN";

export interface SetPriceScheduleFailure {
  ok: false;
  kind: SetPriceScheduleFailureKind;
  error: string;
  attempts: number;
}

/**
 * The one `instanceof` site for Apple failures on the pricing path.
 *
 * ⚠ EXPORTED so `pricing-orchestration.ts` classifies with the SAME function
 * rather than a second copy. Two copies of a classifier drift, and the one
 * that drifts is the one nobody is looking at — here that would mean a 429
 * from the price-point READ being labelled differently from a 429 on the
 * schedule WRITE, in a chain whose entire purpose is that a 429 anywhere on
 * this path reaches the stop latch.
 */
export function classifyPricingFailure(
  err: unknown,
): SetPriceScheduleFailureKind {
  if (err instanceof AppleRateLimitError) return "RATE_LIMITED";
  if (err instanceof AppleApiError) {
    return err.status >= 500 ? "APPLE_5XX" : "APPLE_ERROR";
  }
  return "UNKNOWN";
}

export type SetPriceScheduleResult =
  | SetPriceScheduleSuccess
  | SetPriceScheduleFailure;

/** IAP.o.11a Q-H extended budget for Apple's intermittent 500 UNEXPECTED_ERROR
 *  (developer forum thread 728081). Heavy-load days may exhaust the previous
 *  3-attempt budget; 5 attempts with the new tail (10s + 30s) covers Apple's
 *  observed peak recovery window. ±20% jitter de-thunders concurrent retries
 *  in the bulk-import path (5 parallel rows could land identical backoff). */
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 4000, 10000, 30000] as const;
const DEFAULT_JITTER_RATIO = 0.2;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Apply ±jitterRatio jitter around `base`. Returns a non-negative integer ms. */
function jittered(base: number, jitterRatio: number, rng: () => number): number {
  if (jitterRatio <= 0) return base;
  const offset = (rng() * 2 - 1) * jitterRatio * base;
  return Math.max(0, Math.round(base + offset));
}

/**
 * Set a single manual price effective immediately. Returns a typed result so
 * callers can surface "price not set" without aborting the orchestration —
 * Apple's defaults will leave the IAP at the same MISSING_METADATA state
 * until the price is set later via Apple Connect.
 *
 * Retry semantics (IAP.o.11a, was IAP.o.10a): Apple's
 * `/v1/inAppPurchasePriceSchedules` is known to return 500 UNEXPECTED_ERROR
 * intermittently (developer forum thread 728081). We retry up to 5 times
 * (was 3) with exponential backoff (500 → 1500 → 4000 → 10000 → 30000 ms)
 * plus ±20% jitter to de-thunder concurrent bulk-import retries. 5xx errors
 * retry; 4xx (409, 422 — wrong payload) propagate on first throw since retry
 * can't fix a payload mismatch.
 */
export async function setPriceSchedule(
  creds: AscCredentials,
  args: SetPriceScheduleArgs,
): Promise<SetPriceScheduleResult> {
  const baseTerritory = args.baseTerritory ?? "USA";
  // IAP.o.11d: literal "${...}" lid syntax required by Apple per
  // ENTITY_ERROR.INCLUDED.INVALID_ID surfaced by IAP.o.11a instrumentation.
  // IAP.p1.e: when additionalPricePointIds is non-empty, each price-point
  // gets its own lid (`${price-1}`, `${price-2}`, …) referenced from
  // manualPrices.data so Apple knows the manual schedule for those
  // territories. Apple auto-equalizes the territories not in the array.
  const allPricePointIds: string[] = [
    args.applePricePointId,
    ...(args.additionalPricePointIds ?? []),
  ];
  const refIds = allPricePointIds.map((_, i) => `\${price-${i + 1}}`);
  const body = {
    data: {
      type: "inAppPurchasePriceSchedules",
      relationships: {
        inAppPurchase: {
          data: { type: "inAppPurchases", id: args.appleIapId },
        },
        baseTerritory: {
          data: { type: "territories", id: baseTerritory },
        },
        manualPrices: {
          data: refIds.map((id) => ({ type: "inAppPurchasePrices", id })),
        },
      },
    },
    included: allPricePointIds.map((pricePointId, idx) => ({
      type: "inAppPurchasePrices",
      id: refIds[idx],
      attributes: { startDate: null },
      relationships: {
        inAppPurchasePricePoint: {
          data: {
            type: "inAppPurchasePricePoints",
            id: pricePointId,
          },
        },
        inAppPurchaseV2: {
          data: { type: "inAppPurchases", id: args.appleIapId },
        },
      },
    })),
  };

  const delays = args.retryConfig?.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = args.retryConfig?.sleep ?? defaultSleep;
  const jitterRatio = args.retryConfig?.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const rng = args.retryConfig?.rng ?? Math.random;
  let attempts = 0;
  let lastError = "Apple price schedule POST failed";
  let lastKind: SetPriceScheduleFailureKind = "UNKNOWN";

  console.log(
    `[set-price-schedule] start apple_iap_id=${args.appleIapId} price_point_id=${args.applePricePointId} max_attempts=${delays.length + 1}`,
  );
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    attempts = attempt + 1;
    try {
      console.log(
        `[set-price-schedule] attempt=${attempts} apple_iap_id=${args.appleIapId}`,
      );
      const res = await iapFetch<{
        data: { id: string; type: string };
      }>(creds, "POST", "/v1/inAppPurchasePriceSchedules", body);
      console.log(
        `[set-price-schedule] success apple_iap_id=${args.appleIapId} schedule_id=${res.data.id} attempts=${attempts}`,
      );
      return { ok: true, schedule_id: res.data.id, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastKind = classifyPricingFailure(err);
      // ⚠ 429 IS DELIBERATELY NOT RETRIED HERE, AND THAT IS NOT AN OVERSIGHT.
      //
      // The obvious "fix" is to widen this to `status >= 429`. Do not. Since
      // C1/C2 every bulk flow has a stop latch: a 429 that survives retry is
      // the signal that the whole BATCH should stop, because Apple's budget
      // is gone. Retrying one row so it can slip through while the budget is
      // exhausted works against that — it spends the little that is left on
      // the row that already lost, and delays the stop.
      //
      // ⚠ It would also cost more than it looks. This loop's curve is tuned
      // for Apple's intermittent 500 (500ms → 30s, six attempts ≈ 46s). A
      // rate limit routed through it would park one row for three quarters
      // of a minute and ignore `Retry-After` entirely.
      //
      // Whether a 429 retry is worth having AT ALL is a separate question,
      // and it needs data this repo does not yet have: `x-rate-limit` is
      // absent from these very endpoints (KB §4.9), so "how much budget is
      // left" is not readable here. Make it VISIBLE first — which is what
      // `kind` above does — then measure, then decide.
      const isRetriable = lastKind === "APPLE_5XX";
      if (!isRetriable || attempt === delays.length) {
        console.error(
          `[set-price-schedule] giving up apple_iap_id=${args.appleIapId} attempts=${attempts} kind=${lastKind} retriable=${isRetriable}: ${lastError}`,
        );
        return { ok: false, kind: lastKind, error: lastError, attempts };
      }
      const delay = jittered(delays[attempt], jitterRatio, rng);
      console.warn(
        `[set-price-schedule] retry apple_iap_id=${args.appleIapId} attempt=${attempts} backoff=${delay}ms: ${lastError}`,
      );
      await sleep(delay);
    }
  }

  return { ok: false, kind: lastKind, error: lastError, attempts };
}

/**
 * IAP.p2.m — fetch the full Apple price schedule for the View Detail page.
 *
 * Two-stage fetch:
 *
 *   Stage 1: GET /v2/inAppPurchases/{id}/iapPriceSchedule
 *            ?include=baseTerritory,manualPrices&limit[manualPrices]=50
 *     → schedule id + baseTerritory + manualPrice ID stubs.
 *     **WARNING**: Manager UAT MV30 logs proved Apple's V2 relationship
 *     enumeration truncates `manualPrices.data` even when explicit
 *     `limit[manualPrices]=50` is requested (observed 10 IDs returned
 *     against a 12-row schedule). Treat this list as advisory only —
 *     the unpacker iterates Stage 2's prices directly.
 *
 *   Stage 2: GET /v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices
 *            ?include=inAppPurchasePricePoint,territory&limit=200
 *     → the actual manualPrice entries (full count) with their
 *     price-points + territories. Paginated via `links.next`;
 *     `meta.paging.total` is the canonical count. If pagination collects
 *     fewer entries than `apple_total`, a warn surfaces in Railway logs.
 *
 * Stage 3 was removed at p2.l (base IS in manualPrices, not automatic).
 * Per-ID recovery was removed at p2.m (Stage 1's manualRel is unreliable
 * — it truncates — so we can't use it as a canonical expected-ID list.
 * `apple_total` from Stage 2 is the trustworthy count).
 *
 * Path-name trap reminders:
 *   - IAP.p2.i: V2 path segment is `iapPriceSchedule` (relationship name).
 *   - IAP.p2.j: V2 include enum is strict — no nested chains.
 *
 * Instrumentation: every stage logs `[get-schedule] stage<N> …` so Manager
 * UAT failures can be traced through Railway logs without re-running.
 */

type ManualPricesPage = AscApiResponse<InAppPurchasePrice[]> & {
  links?: { next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
};

/**
 * Convert Apple's `links.next` to the relative endpoint shape iapFetch
 * expects.
 *
 * ⚠ ABSOLUTE IS THE PRODUCTION PATH, and it is measured, not assumed. Live
 * GET 2026-08-24 against this exact endpoint returned
 * `links.next` = "https://api.appstoreconnect.apple.com/v1/
 * inAppPurchasePriceSchedules/{id}/manualPrices?include=…&cursor=AQ&limit=1"
 * (with `meta.paging = {total:175, nextCursor, limit}`), so `new URL()`
 * parses and the catch below never runs.
 *
 * ⚠ THE RELATIVE FALLBACK IS NOT DEAD CODE — it is pinned as a feature by
 * `api-schemas.integration.test.ts` ("…paginates — relative URL"), added
 * after Manager UAT MV30 where an 11-row schedule lost its alphabetically
 * last entry to a brittle links.next follow. It has never been observed to
 * fire against production. Do NOT "clean it up" into a throw: that would
 * delete a tested recovery path to satisfy a symmetry argument.
 *
 * ⚠ AND GUESSING IS NO LONGER SILENT (a4d52e2). If the fallback ever guesses
 * wrong, the guessed path 404s, and a Stage-2 404 is deliberately left as a
 * plain `AppleApiError` — never `NoPriceScheduleError` — so it surfaces as a
 * real failure in the export's failure sheet instead of being reported as
 * "this IAP has no prices".
 *
 * ⚠ ITS TWIN DISAGREES, ON PURPOSE. `extractNextPagePath`
 * (apple/client.ts) handles the same Apple field and THROWS rather than
 * guessing, because its caller's contract is all-or-nothing enumeration: a
 * partial IAP list there produces false "Apple removed this IAP" verdicts.
 * Same field, different cost of being wrong — read both before changing
 * either.
 */
function nextPathFromLink(nextLink: string): string {
  try {
    const url = new URL(nextLink);
    return url.pathname + url.search;
  } catch {
    return nextLink.startsWith("/") ? nextLink : `/${nextLink}`;
  }
}

/** Hard cap on Stage 2 pagination iterations. Bounds the loop in case
 *  Apple returns a malformed cursor that links back to itself. */
const MAX_STAGE2_PAGES = 20;

/**
 * Stage 2 returned FEWER prices than exist, and knows it.
 *
 * ⚠ WHY THIS IS DATA AND NOT JUST A LOG LINE. Both paths below already
 * `console.warn`ed and then returned the short set anyway. The caller could
 * not tell a complete schedule from a truncated one, so a row with missing
 * prices exported looking exactly like a row with all of them — the same
 * silent-partial shape as the bare `catch {}` on the price read, one layer
 * down. A warning nobody can read from code is not a signal.
 *
 *   PAGE_CAP        — hit MAX_STAGE2_PAGES with a cursor still pointing on.
 *                     Needs nothing from Apple to detect; always reliable.
 *   COUNT_MISMATCH  — collected fewer rows than `meta.paging.total` said
 *                     exist. Depends on Apple sending that field.
 */
export interface PriceScheduleIncomplete {
  reason: "PAGE_CAP" | "COUNT_MISMATCH";
  collected: number;
  /** Apple's own count, when it sent one. */
  expected?: number;
}

/**
 * E1 — which of the schedule's two price sub-resources to walk.
 *
 * Both return `inAppPurchasePrices` with the same shape and the same
 * `?include=inAppPurchasePricePoint,territory` support, so ONE paginator
 * serves both. Measured live 2026-08-27 on com.vnggames.aoiaf.0.99:
 * manualPrices = 10, automaticPrices = 165, total 175 = Apple's whole
 * territory list. `limit=200` puts either set in a single page.
 */
export type PriceSubResource = "manualPrices" | "automaticPrices";

async function fetchPricesPaginated(
  creds: AscCredentials,
  scheduleId: string,
  sub: PriceSubResource = "manualPrices",
): Promise<{
  data: InAppPurchasePrice[];
  included: Array<AscResource<string, Record<string, unknown>>>;
  incomplete?: PriceScheduleIncomplete;
}> {
  const collectedPrices: InAppPurchasePrice[] = [];
  const collectedIncluded: Array<
    AscResource<string, Record<string, unknown>>
  > = [];
  let nextPath: string | null =
    `/v1/inAppPurchasePriceSchedules/${scheduleId}/${sub}?include=inAppPurchasePricePoint,territory&limit=200`;
  let pageNum = 0;
  let lastPagingTotal: number | undefined;

  while (nextPath && pageNum < MAX_STAGE2_PAGES) {
    pageNum++;
    const path: string = nextPath;
    const page: ManualPricesPage = await withRetry<ManualPricesPage>(() =>
      iapFetch<ManualPricesPage>(creds, "GET", path),
    );
    if (Array.isArray(page.data)) {
      collectedPrices.push(...page.data);
    }
    if (page.included) {
      collectedIncluded.push(...page.included);
    }
    lastPagingTotal = page.meta?.paging?.total;
    const hasNext = !!page.links?.next;
    console.log(
      `[get-schedule] stage2(${sub}) page=${pageNum} got=${page.data?.length ?? 0} has_next=${hasNext} apple_total=${lastPagingTotal ?? "?"} schedule_id=${scheduleId}`,
    );
    nextPath = hasNext && page.links?.next ? nextPathFromLink(page.links.next) : null;
  }

  let incomplete: PriceScheduleIncomplete | undefined;

  if (pageNum >= MAX_STAGE2_PAGES && nextPath) {
    console.warn(
      `[get-schedule] stage2(${sub}) hit MAX_STAGE2_PAGES=${MAX_STAGE2_PAGES} schedule_id=${scheduleId}; surfacing ${collectedPrices.length} prices`,
    );
    incomplete = { reason: "PAGE_CAP", collected: collectedPrices.length };
  }

  // Trust `apple_total` (meta.paging.total) as the canonical count from
  // Apple. If pagination + collection still falls short, log loudly —
  // there's no individual-ID recovery to lean on (Stage 1's manualRel is
  // truncated, so we have no canonical ID list to compare against).
  //
  // ⚠ KNOWN BLIND SPOT, and it is deliberate. The guard requires
  // `meta.paging.total` to be a number; Apple does not always send it (hence
  // the `?? "?"` in the log format). When it is absent NO flag fires, so a
  // short page set reports as complete. That is a missed signal, and a missed
  // signal beats a wrong one (P7): inventing an "incomplete" from a field
  // that is not there would mark healthy schedules as broken. Live probe
  // 2026-08-24 observed `meta.paging = {total:175, nextCursor, limit}` on a
  // real manualPrices page, so the field IS normally present — this guard is
  // for the case where it is not. PAGE_CAP above needs nothing from Apple and
  // covers the runaway-cursor case regardless.
  if (
    typeof lastPagingTotal === "number" &&
    collectedPrices.length < lastPagingTotal
  ) {
    console.warn(
      `[get-schedule] stage2 INCOMPLETE collected=${collectedPrices.length} apple_total=${lastPagingTotal} schedule_id=${scheduleId} — pagination may have dropped rows; investigate Railway logs for missing has_next links`,
    );
    incomplete ??= {
      reason: "COUNT_MISMATCH",
      collected: collectedPrices.length,
      expected: lastPagingTotal,
    };
  }

  console.log(
    `[get-schedule] stage2 done total_prices=${collectedPrices.length} apple_total=${lastPagingTotal ?? "?"} schedule_id=${scheduleId}`,
  );
  return {
    data: collectedPrices,
    included: collectedIncluded,
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * "Apple has no price schedule for this IAP" — a STAGE-1 404, and nothing else.
 *
 * ⚠ WHY THIS IS A TYPE AND NOT A STATUS CHECK. Every caller used to decide
 * "no schedule" from `status === 404`, which is stage-blind, and the two
 * stages mean opposite things:
 *
 *   stage 1 404 → the schedule resource does not exist. Legitimate: a
 *                 MISSING_METADATA product, or one pushed without pricing.
 *   stage 2 404 → the schedule DOES exist (stage 1 returned it and reported
 *                 manual-price refs) and its sub-resource read failed —
 *                 a broken continuation path, or the schedule disappearing
 *                 mid-read. A REAL failure that must never be reported as
 *                 "this IAP has no prices".
 *
 * Extending `AppleApiError` keeps every existing `instanceof AppleApiError`
 * call site working untouched; callers opt into the finer distinction by
 * testing for this subclass. `apple-fetch.ts` is not modified — the subclass
 * lives here, next to the only function that knows which stage threw.
 */
export class NoPriceScheduleError extends AppleApiError {
  readonly appleIapId: string;
  constructor(appleIapId: string, cause: AppleApiError) {
    super(404, cause.method, cause.endpoint, cause.body);
    this.name = "NoPriceScheduleError";
    this.appleIapId = appleIapId;
    this.message = `No price schedule for IAP ${appleIapId} (stage-1 404) — Apple has no schedule resource for it.`;
  }
}

/**
 * E1 — opt-in: also walk `/automaticPrices`.
 *
 * ⚠ DEFAULT OFF, AND THAT IS THE WHOLE POINT. Four surfaces call this
 * function — View Detail, the custom-prices baseline, update-on-apple, and the
 * export. Only the export wants Apple's auto-equalized territories; turning
 * them on for everyone would make View Detail jump from 10 rows to 175 and
 * hand the two write paths a pile of prices no human set, which is a
 * behaviour change to three surfaces nobody asked to change.
 *
 * Costs exactly one extra Apple request per item (measured: 165 auto entries
 * land in a single `limit=200` page, with customerPrice and currency inline
 * via the same `?include` the manual walk already uses — no N+1).
 */
export interface PriceScheduleOptions {
  includeAutomatic?: boolean;
}

export async function getPriceScheduleForIap(
  creds: AscCredentials,
  appleIapId: string,
  options?: PriceScheduleOptions,
): Promise<
  AscApiResponse<InAppPurchasePriceSchedule> & {
    incomplete?: PriceScheduleIncomplete;
  }
> {
  // ── Stage 1 ────────────────────────────────────────────────────────────
  // IAP.p2.m: explicit `limit[manualPrices]=50` (the documented max) to
  // make the relationship enumeration as complete as possible. Apple has
  // been observed to truncate this list even with the explicit limit;
  // the unpacker treats Stage 2's data as authoritative regardless.
  console.log(`[get-schedule] stage1 fetching apple_iap_id=${appleIapId}`);
  const stage1Path = `/v2/inAppPurchases/${appleIapId}/iapPriceSchedule?include=baseTerritory,manualPrices&limit[manualPrices]=50`;
  let stage1: AscApiResponse<InAppPurchasePriceSchedule>;
  try {
    stage1 = await withRetry(() =>
      iapFetch<AscApiResponse<InAppPurchasePriceSchedule>>(
        creds,
        "GET",
        stage1Path,
      ),
    );
  } catch (err) {
    // ⚠ ONLY here. A 404 from Stage 2 below is deliberately left as a plain
    // AppleApiError: Stage 2 runs only when Stage 1 already returned a
    // schedule with manual-price refs, so a 404 there cannot mean "no
    // schedule" — it means the read broke.
    // `AppleRateLimitError` also extends `AppleApiError` but carries 429, so
    // a rate limit can never be mistaken for this.
    if (err instanceof AppleApiError && err.status === 404) {
      throw new NoPriceScheduleError(appleIapId, err);
    }
    throw err;
  }

  const scheduleId = stage1.data.id;
  const baseTerritoryId = (stage1.data.relationships as
    | { baseTerritory?: { data?: { id?: string } } }
    | undefined)?.baseTerritory?.data?.id;
  const manualRefs = (stage1.data.relationships as
    | { manualPrices?: { data?: Array<{ id: string }> } }
    | undefined)?.manualPrices?.data ?? [];

  console.log(
    `[get-schedule] stage1 schedule_id=${scheduleId} base_territory=${baseTerritoryId ?? "?"} manualRel_count=${manualRefs.length} (advisory — may be truncated by Apple)`,
  );

  // Stage 2 — manualPrices traversal with pagination. Skipped only when
  // Stage 1 reports zero manualPrice refs (Apple says there are none).
  // The unpacker iterates Stage 2's results, not Stage 1's manualRel,
  // because Stage 1 can truncate.
  const stage2Result =
    manualRefs.length > 0
      ? await fetchPricesPaginated(creds, scheduleId, "manualPrices")
      : {
          data: [] as InAppPurchasePrice[],
          included: [] as Array<AscResource<string, Record<string, unknown>>>,
        };

  // ── Stage 2b — automatic prices, only when the caller asked. ────────────
  //
  // ⚠ NOT gated on `manualRefs.length`. A schedule can be entirely
  // auto-equalized (base price set, every other territory derived), and that
  // item has automatic prices worth exporting even though Stage 1 reported
  // manual refs. Gating this the way Stage 2 is gated would hide exactly the
  // items the feature exists to fix.
  const autoResult = options?.includeAutomatic
    ? await fetchPricesPaginated(creds, scheduleId, "automaticPrices")
    : {
        data: [] as InAppPurchasePrice[],
        included: [] as Array<AscResource<string, Record<string, unknown>>>,
      };

  if (options?.includeAutomatic) {
    // ── F1 — the endpoint is a CROSS-CHECK, never the verdict. ───────────
    //
    // `manual` is an attribute Apple puts on the row; the sub-resource it
    // arrived from is our own inference. They are separately observable and
    // could disagree. When they do, the attribute wins — it is Apple's
    // statement about the row — and the disagreement is LOGGED rather than
    // resolved silently, because a mismatch means one of our two beliefs
    // about Apple is wrong and we should find out which.
    const wrongInManual = stage2Result.data.filter(
      (p) => p.attributes?.manual === false,
    ).length;
    const wrongInAuto = autoResult.data.filter(
      (p) => p.attributes?.manual === true,
    ).length;
    if (wrongInManual > 0 || wrongInAuto > 0) {
      console.warn(
        `[get-schedule] ⚠ manual-attribute/endpoint MISMATCH schedule_id=${scheduleId} manual_endpoint_saying_auto=${wrongInManual} auto_endpoint_saying_manual=${wrongInAuto} — trusting the attribute`,
      );
    }
    console.log(
      `[get-schedule] stage2 totals schedule_id=${scheduleId} manual=${stage2Result.data.length} automatic=${autoResult.data.length}`,
    );
  }

  // ── Merge Stage 1 + Stage 2 ───────────────────────────────────────────
  // Stage 1's `included` may carry link-only InAppPurchasePrice stubs (Apple
  // side-loads bare resource shells for relationship pointers). Drop them
  // so the merge adds Stage 2's full-relationship variants without
  // duplicating IDs (which would let unpackPriceSchedule pick the stub).
  const stage1WithoutPriceStubs = (stage1.included ?? []).filter(
    (r) => r.type !== "inAppPurchasePrices",
  );

  return {
    // ⚠ Forwarded, not swallowed. Structural addition only — every existing
    // caller reads `.data` / `.included` and is unaffected by the extra key.
    ...(stage2Result.incomplete ? { incomplete: stage2Result.incomplete } : {}),
    data: stage1.data,
    included: [
      ...stage1WithoutPriceStubs,
      // InAppPurchasePrice's typed attributes shape (`startDate` / `endDate`)
      // is narrower than the loose `Record<string, unknown>` AscApiResponse's
      // `included[]` requires — same structural row, different TS bookkeeping.
      // Cast through `unknown` so the unifier accepts the merge.
      ...(autoResult.data as unknown as AscResource<
        string,
        Record<string, unknown>
      >[]),
      ...(autoResult.included as Array<
        AscResource<string, Record<string, unknown>>
      >),
      ...(stage2Result.data as unknown as AscResource<
        string,
        Record<string, unknown>
      >[]),
      ...stage2Result.included,
    ],
  };
}
