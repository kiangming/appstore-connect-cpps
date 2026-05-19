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
import { iapFetch, withRetry, AppleApiError } from "./fetch";
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

export interface SetPriceScheduleFailure {
  ok: false;
  error: string;
  attempts: number;
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
      const isRetriable = err instanceof AppleApiError && err.status >= 500;
      if (!isRetriable || attempt === delays.length) {
        console.error(
          `[set-price-schedule] giving up apple_iap_id=${args.appleIapId} attempts=${attempts} retriable=${isRetriable}: ${lastError}`,
        );
        return { ok: false, error: lastError, attempts };
      }
      const delay = jittered(delays[attempt], jitterRatio, rng);
      console.warn(
        `[set-price-schedule] retry apple_iap_id=${args.appleIapId} attempt=${attempts} backoff=${delay}ms: ${lastError}`,
      );
      await sleep(delay);
    }
  }

  return { ok: false, error: lastError, attempts };
}

/**
 * IAP.p2.k — fetch the full Apple price schedule for the View Detail page.
 *
 * Three-stage fetch (Manager UAT post-p2.j):
 *
 *   Stage 1: GET /v2/inAppPurchases/{id}/iapPriceSchedule
 *            ?include=baseTerritory,manualPrices
 *     → schedule id + baseTerritory + manualPrice ID stubs.
 *
 *   Stage 2: GET /v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices
 *            ?include=inAppPurchasePricePoint,territory&limit=200
 *     → the actual manualPrice entries with their price-points + territories.
 *     Paginated via `links.next` — Apple's default page size can be smaller
 *     than our requested `limit` (10-row default observed post-p2.j MV30
 *     test where 11-row schedule lost the alphabetically-last row).
 *
 *   Stage 3: GET /v1/inAppPurchasePriceSchedules/{scheduleId}/automaticPrices
 *            ?filter[territory]=<base>&include=inAppPurchasePricePoint,territory&limit=1
 *     → the base territory's actual price. Apple stores the base price in
 *     `automaticPrices` (NOT in `manualPrices` despite our POST shape
 *     sending base as part of manualPrices — Apple unfolds it on storage).
 *     Without Stage 3 the View Detail had to fall back to `current[0]`
 *     which surfaced HK's price as the "United States" base.
 *
 * Path-name trap reminders:
 *   - IAP.p2.i: V2 path segment is `iapPriceSchedule` (relationship name),
 *     NOT `inAppPurchasePriceSchedule` (resource type).
 *   - IAP.p2.j: V2 include enum is strict — only `baseTerritory`,
 *     `manualPrices`, `automaticPrices`. Nested chains are rejected.
 *
 * Failure modes:
 *   - Stage 1 404 → no schedule exists; throws and the route maps to the
 *     empty-state placeholder.
 *   - Stage 2 pagination break → MAX_PAGES safety cap with a console.warn;
 *     better to render N pages than spin forever on a malformed cursor.
 *   - Stage 3 anything → swallowed; `basePrice` returns `null` and the
 *     section renders the base territory name without a price (still better
 *     than the wrong price the pre-p2.k fallback surfaced).
 *
 * Instrumentation: every stage logs `[get-schedule] stage<N> …` so Manager
 * UAT failures can be traced through Railway logs without re-running.
 */

export interface PriceScheduleFetchResult {
  /** Stage 1 + Stage 2 merged into a single AscApiResponse the unpacker
   *  walks for manualPrice entries. */
  schedule: AscApiResponse<InAppPurchasePriceSchedule>;
  /** Stage 3's single-row response (or `null` when Apple returned no base
   *  price or the Stage 3 fetch failed). The unpacker resolves this into
   *  the `basePrice` field of PriceScheduleView. */
  basePrice: AscApiResponse<InAppPurchasePrice[]> | null;
}

type ManualPricesPage = AscApiResponse<InAppPurchasePrice[]> & {
  links?: { next?: string };
};

/** Convert Apple's `links.next` (absolute URL) to the relative endpoint
 *  shape iapFetch expects. Tolerant of both absolute and relative inputs —
 *  the previous regex-strip approach only handled the absolute case. */
function nextPathFromLink(nextLink: string): string {
  try {
    const url = new URL(nextLink);
    return url.pathname + url.search;
  } catch {
    return nextLink.startsWith("/") ? nextLink : `/${nextLink}`;
  }
}

/** Hard cap on Stage 2 pagination iterations. Bounds the loop in case
 *  Apple returns a malformed cursor that links back to itself — rather
 *  spin out with a render than hang the page-load forever. */
const MAX_STAGE2_PAGES = 20;

async function fetchManualPricesPaginated(
  creds: AscCredentials,
  scheduleId: string,
): Promise<{
  data: InAppPurchasePrice[];
  included: Array<AscResource<string, Record<string, unknown>>>;
}> {
  const collectedPrices: InAppPurchasePrice[] = [];
  const collectedIncluded: Array<
    AscResource<string, Record<string, unknown>>
  > = [];
  let nextPath: string | null =
    `/v1/inAppPurchasePriceSchedules/${scheduleId}/manualPrices?include=inAppPurchasePricePoint,territory&limit=200`;
  let pageNum = 0;

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
    const hasNext = !!page.links?.next;
    console.log(
      `[get-schedule] stage2 page=${pageNum} got=${page.data?.length ?? 0} has_next=${hasNext} schedule_id=${scheduleId}`,
    );
    nextPath = hasNext && page.links?.next ? nextPathFromLink(page.links.next) : null;
  }

  if (pageNum >= MAX_STAGE2_PAGES && nextPath) {
    console.warn(
      `[get-schedule] stage2 hit MAX_STAGE2_PAGES=${MAX_STAGE2_PAGES} schedule_id=${scheduleId}; surfacing ${collectedPrices.length} prices`,
    );
  }

  console.log(
    `[get-schedule] stage2 done total_prices=${collectedPrices.length} total_included=${collectedIncluded.length} schedule_id=${scheduleId}`,
  );
  return { data: collectedPrices, included: collectedIncluded };
}

async function fetchBasePrice(
  creds: AscCredentials,
  scheduleId: string,
  baseTerritoryId: string,
): Promise<AscApiResponse<InAppPurchasePrice[]> | null> {
  try {
    const path = `/v1/inAppPurchasePriceSchedules/${scheduleId}/automaticPrices?filter[territory]=${baseTerritoryId}&include=inAppPurchasePricePoint,territory&limit=1`;
    const res = await withRetry(() =>
      iapFetch<AscApiResponse<InAppPurchasePrice[]>>(creds, "GET", path),
    );
    console.log(
      `[get-schedule] stage3 base_territory=${baseTerritoryId} got=${res.data?.length ?? 0} schedule_id=${scheduleId}`,
    );
    return res;
  } catch (err) {
    console.warn(
      `[get-schedule] stage3 failed base_territory=${baseTerritoryId} schedule_id=${scheduleId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function getPriceScheduleForIap(
  creds: AscCredentials,
  appleIapId: string,
): Promise<PriceScheduleFetchResult> {
  // ── Stage 1 ────────────────────────────────────────────────────────────
  console.log(`[get-schedule] stage1 fetching apple_iap_id=${appleIapId}`);
  const stage1Path = `/v2/inAppPurchases/${appleIapId}/iapPriceSchedule?include=baseTerritory,manualPrices`;
  const stage1 = await withRetry(() =>
    iapFetch<AscApiResponse<InAppPurchasePriceSchedule>>(
      creds,
      "GET",
      stage1Path,
    ),
  );

  const scheduleId = stage1.data.id;
  const baseTerritoryId = (stage1.data.relationships as
    | { baseTerritory?: { data?: { id?: string } } }
    | undefined)?.baseTerritory?.data?.id;
  const manualRefs = (stage1.data.relationships as
    | { manualPrices?: { data?: Array<{ id: string }> } }
    | undefined)?.manualPrices?.data ?? [];

  console.log(
    `[get-schedule] stage1 schedule_id=${scheduleId} base_territory=${baseTerritoryId ?? "?"} manualRel_count=${manualRefs.length}`,
  );

  // Stages 2 + 3 run in parallel — both depend on scheduleId from Stage 1
  // but are independent of each other. Stage 2 is skipped when there are
  // no manualPrices; Stage 3 is skipped when there is no base territory.
  const stage2Promise = manualRefs.length > 0
    ? fetchManualPricesPaginated(creds, scheduleId)
    : Promise.resolve({
        data: [] as InAppPurchasePrice[],
        included: [] as Array<AscResource<string, Record<string, unknown>>>,
      });
  const stage3Promise = baseTerritoryId
    ? fetchBasePrice(creds, scheduleId, baseTerritoryId)
    : Promise.resolve(null);

  const [stage2Result, basePrice] = await Promise.all([
    stage2Promise,
    stage3Promise,
  ]);

  // ── Merge Stage 1 + Stage 2 ───────────────────────────────────────────
  // Stage 1's `included` may carry link-only InAppPurchasePrice stubs (Apple
  // side-loads bare resource shells for relationship pointers). Drop them
  // so the merge adds Stage 2's full-relationship variants without
  // duplicating IDs (which would let unpackPriceSchedule pick the stub).
  const stage1WithoutPriceStubs = (stage1.included ?? []).filter(
    (r) => r.type !== "inAppPurchasePrices",
  );

  const mergedSchedule: AscApiResponse<InAppPurchasePriceSchedule> = {
    data: stage1.data,
    included: [
      ...stage1WithoutPriceStubs,
      // InAppPurchasePrice's typed attributes shape (`startDate` / `endDate`)
      // is narrower than the loose `Record<string, unknown>` AscApiResponse's
      // `included[]` requires — same structural row, different TS bookkeeping.
      // Cast through `unknown` so the unifier accepts the merge.
      ...(stage2Result.data as unknown as AscResource<
        string,
        Record<string, unknown>
      >[]),
      ...stage2Result.included,
    ],
  };

  return { schedule: mergedSchedule, basePrice };
}
