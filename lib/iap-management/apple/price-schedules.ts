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
 * IAP.p2.a (rewritten at IAP.p2.j) — fetch the current price schedule for a
 * synced IAP for the read-only View Detail page.
 *
 * 2-stage fetch — the single-round-trip approach the original p2.a shipped
 * with does NOT work against Apple's actual API. Apple's V2
 * `/v2/inAppPurchases/{id}/iapPriceSchedule` endpoint enforces a strict
 * include whitelist (`baseTerritory`, `manualPrices`, `automaticPrices`
 * only — see openapi.oas.json operationId
 * `inAppPurchasesV2_iapPriceSchedule_getToOneRelated`). Nested includes
 * like `manualPrices.inAppPurchasePricePoint.territory` are rejected with
 * Apple 400 `PARAMETER_ERROR.INVALID`. The only endpoint that side-loads
 * `inAppPurchasePricePoint` + `territory` is
 * `/v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices`.
 *
 * IAP.p2.i fix: path segment is `iapPriceSchedule` (the V2 relationship
 * name), NOT `inAppPurchasePriceSchedule` (the resource type). Same naming
 * inconsistency as IAP.o.9b's `appStoreReviewScreenshot` rename.
 *
 * Returns an AscApiResponse-shaped merge of both stages so the existing
 * `unpackPriceSchedule` consumer doesn't need to change: Stage 1's `data`
 * + Stage 1's `included[]` (baseTerritory) + Stage 2's `data[]` cast into
 * `included[]` (inAppPurchasePrices with full relationships) + Stage 2's
 * `included[]` (price points + territories).
 *
 * Pagination: Stage 2 follows `links.next` if Apple returns >200 manual
 * prices. Bounded by Apple's `limit[manualPrices]: 50` page-size on the
 * traversal endpoint per OpenAPI; ≤10 territories is the Manager workflow
 * norm, so pagination is defensive.
 *
 * Apple returns 404 when no schedule exists yet (Manager-created IAP that
 * never had pricing pushed). Stage 1 surfaces that 404 unchanged so the
 * route's existing `priceSchedule = null` branch fires.
 */
export async function getPriceScheduleForIap(
  creds: AscCredentials,
  appleIapId: string,
): Promise<AscApiResponse<InAppPurchasePriceSchedule>> {
  // ── Stage 1 ────────────────────────────────────────────────────────────
  // Schedule resource + baseTerritory + manualPrices stubs (ID-only).
  // No nested includes — Apple enforces the strict enum.
  const stage1Path = `/v2/inAppPurchases/${appleIapId}/iapPriceSchedule?include=baseTerritory,manualPrices`;
  const stage1 = await withRetry(() =>
    iapFetch<AscApiResponse<InAppPurchasePriceSchedule>>(
      creds,
      "GET",
      stage1Path,
    ),
  );

  const scheduleId = stage1.data.id;
  const manualRefs = (stage1.data.relationships as
    | { manualPrices?: { data?: Array<{ id: string }> } }
    | undefined)?.manualPrices?.data ?? [];

  // Short-circuit when Apple equalised every territory and there are no
  // manual prices — Stage 2 would just return an empty page, save the
  // round-trip + token mint.
  if (manualRefs.length === 0) {
    return stage1;
  }

  // ── Stage 2 ────────────────────────────────────────────────────────────
  // Deep traversal endpoint — only path that side-loads
  // inAppPurchasePricePoint + territory. Paginated via `links.next`.
  const collectedPrices: InAppPurchasePrice[] = [];
  const collectedIncluded: Array<AscResource<string, Record<string, unknown>>> =
    [];

  let nextPath: string | null =
    `/v1/inAppPurchasePriceSchedules/${scheduleId}/manualPrices?include=inAppPurchasePricePoint,territory&limit=200`;

  while (nextPath) {
    const page: AscApiResponse<InAppPurchasePrice[]> & {
      links?: { next?: string };
    } = await withRetry(() =>
      iapFetch<
        AscApiResponse<InAppPurchasePrice[]> & {
          links?: { next?: string };
        }
      >(creds, "GET", nextPath as string),
    );
    // Apple's pagination ships `data` as an array on collection endpoints.
    if (Array.isArray(page.data)) {
      collectedPrices.push(...page.data);
    }
    if (page.included) {
      collectedIncluded.push(...page.included);
    }

    if (page.links?.next) {
      // Apple's `links.next` is absolute. Strip the ASC base prefix to keep
      // the relative endpoint shape iapFetch expects.
      nextPath = page.links.next.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, "");
    } else {
      nextPath = null;
    }
  }

  // ── Merge ──────────────────────────────────────────────────────────────
  // Stage 1's `included` may carry link-only InAppPurchasePrice stubs —
  // drop them so the merge below adds Stage 2's full-relationship variants
  // without leaving duplicate ID entries (which would let unpackPriceSchedule
  // pick the wrong one).
  const stage1WithoutPriceStubs = (stage1.included ?? []).filter(
    (r) => r.type !== "inAppPurchasePrices",
  );

  return {
    data: stage1.data,
    included: [
      ...stage1WithoutPriceStubs,
      // InAppPurchasePrice's typed attributes shape (`startDate` / `endDate`)
      // is narrower than the loose `Record<string, unknown>` AscApiResponse's
      // `included[]` requires — same structural row, different TS bookkeeping.
      // Cast through `unknown` so the unifier accepts the merge.
      ...(collectedPrices as unknown as AscResource<string, Record<string, unknown>>[]),
      ...collectedIncluded,
    ],
  };
}
