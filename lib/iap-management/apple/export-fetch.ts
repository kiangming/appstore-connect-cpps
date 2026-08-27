/**
 * Per-app export fetch orchestration — "Export list" on the Apple IAP list.
 *
 * Apple has no per-territory price cache (unlike Google's iap_prices),
 * so every exported row needs a live per-IAP fetch. Reuses View Detail's
 * own primitives as-is:
 *   - getIapDetailFromApple (queries/iap-detail.ts) — IAP attributes +
 *     localizations, via GET /v2/inAppPurchases/{id}?include=…
 *   - getPriceScheduleForIap (apple/price-schedules.ts) — the 2-stage
 *     price-schedule fetch that works around the §4.1 landmark V2
 *     `?include=manualPrices` truncation by reading the V1 sub-resource.
 *
 * Isolation model mirrors View Detail's own resilience (getIapViewData's
 * docstring): the IAP + localization fetch is the critical path — if it
 * throws, this row is unrecoverable and is skipped with a warning. The
 * price-schedule fetch is best-effort — any failure (404 "no schedule
 * yet" or a transient error) degrades to `priceSchedule: null` (blank
 * pricing) rather than dropping the whole row, since the row's other
 * data (product id, SKU name, status, localizations) already fetched
 * successfully.
 *
 * Bounded concurrency via the shared withConcurrency helper — a large
 * app can have hundreds of IAPs, each needing ~2-3 Apple calls, so an
 * unbounded fan-out would saturate Apple's rate limit.
 */
import { runStoppablePool } from "@/lib/iap-management/stoppable-pool";
import { getIapDetailFromApple, unpackPriceSchedule } from "@/lib/iap-management/queries/iap-detail";
import { unknownAppleTerritories } from "./apple-territories.snapshot";
import {
  getPriceScheduleForIap,
  NoPriceScheduleError,
} from "@/lib/iap-management/apple/price-schedules";
import {
  withRetry,
  AppleApiError,
  AppleRateLimitError,
} from "@/lib/iap-management/apple/fetch";
import type { AscCredentials } from "@/lib/asc-jwt";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type {
  ExportSource,
  ExportFailureKind,
  PriceReadFailure,
} from "@/lib/iap-management/xlsx-export";

/** Each IAP costs ~2-3 Apple calls (IAP+localizations, price-schedule
 *  stage 1, price-schedule stage 2). 8 concurrent workers keeps a
 *  large app (hundreds of IAPs) within a few minutes without
 *  saturating Apple's per-hour rate limit budget. */
const EXPORT_FETCH_CONCURRENCY = 8;

export interface ExportFetchFailure {
  productId: string;
  appleIapId: string;
  /**
   * ⚠ CLASSIFIED AT THE CATCH, WHERE `instanceof` STILL WORKS — never parsed
   * back out of `error`. The old shape carried only the string, so the only
   * way to tell a rate limit from an Apple rejection downstream was to look
   * for "429: " at the front of a message, which is not a type.
   */
  kind: ExportFailureKind;
  /** Human-readable. For display; never the source of `kind`. */
  error: string;
}

export interface ExportFetchResult {
  sources: ExportSource[];
  failures: ExportFetchFailure[];
  /** True when a 429 survived retry and the pool stopped dispatching. Read
   *  from the pool's own latch, not re-derived from the rows. */
  stopped: boolean;
}

/**
 * The single `instanceof` site for Apple errors on the export path.
 *
 * ⚠ RATE_LIMITED HERE MEANS "SURVIVED RETRY". Both Apple reads are composed
 * with exactly one `withRetry` (the detail read at the call site below, the
 * price-schedule read internally at both its stages), so an
 * `AppleRateLimitError` arriving here has already burned the full backoff
 * curve — 4 attempts. That is what makes it safe for the stop latch to treat
 * as "the budget is gone" rather than "one unlucky request".
 */
function classifyAppleError(err: unknown): {
  kind: Exclude<ExportFailureKind, "NOT_ATTEMPTED">;
  status?: number;
  message: string;
} {
  if (err instanceof AppleRateLimitError) {
    return { kind: "RATE_LIMITED", status: 429, message: errMsg(err) };
  }
  if (err instanceof AppleApiError) {
    return { kind: "APPLE_ERROR", status: err.status, message: errMsg(err) };
  }
  return { kind: "UNKNOWN", message: errMsg(err) };
}

/** Injectable primitives — real callers pass the actual View Detail
 *  functions; tests inject fakes to exercise the isolation/degrade
 *  paths without a live Apple call. */
export interface ExportFetchDeps {
  /**
   * ⚠ MUST be a retry-naive leaf. `fetchExportSources` composes EXACTLY ONE
   * `withRetry` around it; injecting a self-retrying function recreates the
   * export:68 double-wrap (4 attempts → 16, and the outer retry restarts the
   * inner work from the beginning).
   *
   * An `AppleRateLimitError` reaching the per-item catch below therefore means
   * the 429 SURVIVED retry — Chunk 3's stop latch depends on this. Without the
   * wrapper, a single transient 429 on one item would read as a real
   * rate-limit wall and stop the whole pool.
   *
   * Today's only real caller passes `getIapDetailFromApple`, which is
   * retry-naive: → `getInAppPurchase` (client.ts:119) → `iapFetch`, and
   * `iapFetch` throws `AppleRateLimitError` without retrying (fetch.ts:13-17).
   */
  getIapDetail: typeof getIapDetailFromApple;
  /**
   * ⚠ MUST NOT be wrapped here — it ALREADY retries internally, at BOTH
   * stages: stage 1 (price-schedules.ts:319) and stage 2's per-page loop
   * (price-schedules.ts:266). This is the same contract shape as
   * `listAllInAppPurchases` (client.ts:52-54): the helper owns its retry, the
   * caller must not add a second one.
   */
  getPriceScheduleForIap: typeof getPriceScheduleForIap;
  /**
   * F-A — read Apple's auto-equalized territories too (`/automaticPrices`),
   * not just the ones a human priced by hand.
   *
   * ⚠ THE CALLER DECIDES, AND THAT IS NOT STYLE. `getPriceScheduleForIap` is
   * shared with View Detail and the two write paths, which want the ~10
   * manual rows and would be handed ~175 by a default flip. So the option
   * lives here as an injected DECISION rather than a constant: the export
   * route says `true`, everyone else says nothing, and a test can drive both.
   * A hardcoded `true` inside `fetchExportSources` would also make the guard
   * asserting it unfalsifiable.
   *
   * ⚠ AND IT MUST ACTUALLY BE PASSED. E1 built the capability behind this
   * flag and no chunk was ever tasked with switching it on, so the export
   * shipped reading 10 of Apple's 175 territories while four later chunks
   * built column ordering, shading and `—`/blank on top of data that was
   * never fetched. An opt-in nobody opts into is dead code that looks alive.
   */
  includeAutomatic?: boolean;
  concurrency?: number;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) return `${err.status}: ${err.body.slice(0, 200)}`;
  return err instanceof Error ? err.message : String(err);
}

type ItemOutcome =
  | { ok: true; source: ExportSource }
  | { ok: false; failure: ExportFetchFailure };

export async function fetchExportSources(
  creds: AscCredentials,
  appleIaps: InAppPurchase[],
  deps: ExportFetchDeps,
): Promise<ExportFetchResult> {
  const concurrency = deps.concurrency ?? EXPORT_FETCH_CONCURRENCY;

  const { results: outcomes, stopped } = await runStoppablePool<
    InAppPurchase,
    ItemOutcome
  >({
    items: appleIaps,
    concurrency,

    // ⚠ THE LATCH LISTENS TO BOTH READS, and they arrive by different routes.
    //
    // The DETAIL read throws, so its rate limit reaches `shouldStop`.
    // The PRICE read does NOT throw — a missing price must not delete a row
    // whose product id, name, status and localizations are all real — so its
    // rate limit rides back on a SUCCESSFUL result and is picked up by
    // `shouldStopOnResult`.
    //
    // ⚠ Two independent decisions, deliberately not collapsed:
    //     "is this row still usable?"  → yes, it exports as PARTIAL
    //     "is Apple's budget gone?"    → yes, stop dispatching
    // Wiring the latch only to the throwing read would leave it deaf to TWO
    // OF THE THREE requests each item costs (detail + schedule stage 1 +
    // stage 2), which is most of the traffic that provokes the 429.
    shouldStop: (err) => err instanceof AppleRateLimitError,
    shouldStopOnResult: (o) =>
      o.ok && o.source.priceReadFailure?.kind === "RATE_LIMITED",

    skipped: (iap) => ({
      ok: false as const,
      failure: {
        productId: iap.attributes.productId,
        appleIapId: iap.id,
        kind: "NOT_ATTEMPTED" as const,
        error: "Export stopped before this item — nothing was sent.",
      },
    }),

    run: async (iap) => {
      // Critical path — a failure here means this row can't be built at
      // all (no product id / SKU name / localizations to fall back on).
      //
      // ⚠ EXACTLY ONE withRetry, over a retry-naive leaf — see
      // `ExportFetchDeps.getIapDetail` for the contract and why the count is
      // load-bearing. Do not add a second wrapper here, at the route, or
      // inside the leaf.
      const detail = await withRetry(() => deps.getIapDetail(creds, iap.id));

      // Best-effort for the ROW, but never silent about WHY.
      // ⚠ NO withRetry: this dep retries internally at both stages
      // (price-schedules.ts:319 + :266).
      //
      // ⚠ THE BARE `catch {}` THAT USED TO BE HERE IS THE DEFECT. It threw
      // the error away, so a throttled read and an IAP that genuinely has no
      // schedule both became `priceSchedule: null` and rendered identical
      // blank cells. Worse, the workbook's territory columns are the union of
      // territories WITH a price, so a territory priced only on throttled
      // rows vanished from the file entirely — no blank column, no trace.
      let priceSchedule = null as ExportSource["priceSchedule"];
      let priceReadFailure: PriceReadFailure | null = null;
      try {
        // ⚠ ALWAYS STATED, never left implicit. Passing the resolved boolean
        // rather than forwarding `deps.includeAutomatic` raw means the export
        // declares its choice on every call — and a reader of the Railway log
        // or the mock's arguments sees an answer instead of an absence.
        const scheduleRes = await deps.getPriceScheduleForIap(creds, iap.id, {
          includeAutomatic: deps.includeAutomatic === true,
        });
        priceSchedule = unpackPriceSchedule(scheduleRes);
        // ⚠ A SUCCESSFUL read that came back SHORT. Stage 2 stopped at its
        // page cap, or collected fewer rows than Apple's own count — either
        // way the prices in this row are a subset, and saying nothing would
        // put a truncated row in the file looking exactly like a complete
        // one. The row still exports; it is marked PARTIAL.
        //
        // ⚠ This does NOT stop the pool. Incompleteness is not a budget
        // signal — Apple answered, it just answered short — so the latch
        // (`shouldStopOnResult`, keyed on RATE_LIMITED only) stays up and the
        // remaining items keep going.
        const short = scheduleRes.incomplete;
        if (short) {
          priceReadFailure = {
            kind: "INCOMPLETE_PRICES",
            incompleteReason: short.reason,
            message:
              short.expected !== undefined
                ? `collected ${short.collected} of ${short.expected} prices`
                : `collected ${short.collected} prices; more remained`,
          };
        }
        // ⚠ AN UNREADABLE BASE TERRITORY MAKES THE ROW PARTIAL, NOT FAILED.
        // Every price, territory and date in this row read fine; one pointer
        // did not. Before F2 there was nothing to report here at all —
        // `unpackPriceSchedule` substituted `"USA"` and the row exported
        // looking complete and correct.
        //
        // ⚠ LAST, AND ONLY IF THE SLOT IS FREE. `priceReadFailure` holds one
        // reason, and truncated prices are the larger data loss, so
        // INCOMPLETE_PRICES above keeps the slot when both conditions fire.
        // Ordering is the precedence — there is no separate rule to keep in
        // sync.
        //
        // ⚠ Like INCOMPLETE_PRICES, this does NOT stop the pool: Apple
        // answered, and an unreadable field says nothing about the budget.
        // The latch stays keyed on RATE_LIMITED only.
        if (!priceReadFailure && priceSchedule?.baseTerritory === null) {
          priceReadFailure = {
            kind: "UNKNOWN_BASE_TERRITORY",
            message:
              "Schedule read OK; the `baseTerritory` relationship carried no id.",
          };
        }
      } catch (err) {
        const c = classifyAppleError(err);
        // ⚠ NO-SCHEDULE IS A TYPE, NOT A STATUS. This check used to be
        // `status === 404`, which is STAGE-BLIND and wrong: stage 2 only runs
        // when stage 1 already returned a schedule, so a 404 from there is a
        // broken read, not an IAP without prices. Classifying it as
        // no-schedule reproduced the exact G4b shape — a row exported clean
        // with blank prices and no recorded reason — through a different
        // door. `getPriceScheduleForIap` is the only place that knows which
        // stage threw, so it makes the call and hands us the type.
        const isNoSchedule = err instanceof NoPriceScheduleError;
        priceReadFailure = isNoSchedule
          ? null
          : { kind: c.kind, status: c.status, message: c.message };
      }

      const source: ExportSource = {
        appleIapId: iap.id,
        productId: detail.iap.attributes.productId,
        skuName: detail.iap.attributes.name,
        status: detail.iap.attributes.state,
        priceSchedule,
        priceReadFailure,
        localizations: detail.localizations.map((l) => ({
          locale: l.attributes.locale,
          displayName: l.attributes.name,
          description: l.attributes.description ?? "",
        })),
      };
      return { ok: true as const, source };
    },

    onError: async (iap, err) => {
      const c = classifyAppleError(err);
      return {
        ok: false as const,
        failure: {
          productId: iap.attributes.productId,
          appleIapId: iap.id,
          kind: c.kind,
          error: c.message,
        },
      };
    },
  });

  const sources: ExportSource[] = [];
  const failures: ExportFetchFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) sources.push(outcome.source);
    else failures.push(outcome.failure);
  }

  // ── F-B / S2(b) — DID APPLE'S TERRITORY LIST MOVE UNDER US? ───────────────
  //
  // `apple-territories.snapshot.ts` decides how many columns an "all
  // countries" export has, and it is a photograph nothing in this app
  // refreshes. This is the half of the drift detection that needs nobody to
  // remember anything: every territory Apple actually priced is checked
  // against the snapshot, once per export, and the unknown ones are named.
  //
  // ⚠ IT WARNS, IT DOES NOT BLOCK. An unrecognised territory still exports
  // with its price and its column — `buildExportPlan` unions observed codes
  // over the expansion. A market Apple added yesterday is a log line, not a
  // failed export.
  //
  // ⚠ ADDITIONS ONLY. A territory Apple REMOVED cannot appear in `observed`,
  // so it cannot be seen here; the probe's whole-list diff (step 2.7) is what
  // catches that direction.
  const observed = new Set<string>();
  for (const src of sources) {
    for (const entry of src.priceSchedule?.entries ?? []) {
      if (entry.territory) observed.add(entry.territory);
    }
  }
  const unknown = unknownAppleTerritories([...observed]);
  if (unknown.length > 0) {
    console.warn(
      `[export-fetch] ⚠ APPLE TERRITORY SNAPSHOT DRIFT — ${unknown.length} code(s) Apple priced ` +
        `are absent from apple-territories.snapshot.ts: ${unknown.join(" ")}. ` +
        `They still exported. Refresh the snapshot: node scripts/probe-export-price-sources.mjs (step 2.7).`,
    );
  }

  return { sources, failures, stopped };
}
