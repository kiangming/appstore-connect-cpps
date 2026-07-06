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
import { withConcurrency } from "@/lib/iap-management/concurrency";
import { getIapDetailFromApple, unpackPriceSchedule } from "@/lib/iap-management/queries/iap-detail";
import { getPriceScheduleForIap } from "@/lib/iap-management/apple/price-schedules";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import type { AscCredentials } from "@/lib/asc-jwt";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type { ExportSource } from "@/lib/iap-management/xlsx-export";

/** Each IAP costs ~2-3 Apple calls (IAP+localizations, price-schedule
 *  stage 1, price-schedule stage 2). 8 concurrent workers keeps a
 *  large app (hundreds of IAPs) within a few minutes without
 *  saturating Apple's per-hour rate limit budget. */
const EXPORT_FETCH_CONCURRENCY = 8;

export interface ExportFetchFailure {
  productId: string;
  appleIapId: string;
  error: string;
}

export interface ExportFetchResult {
  sources: ExportSource[];
  failures: ExportFetchFailure[];
}

/** Injectable primitives — real callers pass the actual View Detail
 *  functions; tests inject fakes to exercise the isolation/degrade
 *  paths without a live Apple call. */
export interface ExportFetchDeps {
  getIapDetail: typeof getIapDetailFromApple;
  getPriceScheduleForIap: typeof getPriceScheduleForIap;
  concurrency?: number;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) return `${err.status}: ${err.body.slice(0, 200)}`;
  return err instanceof Error ? err.message : String(err);
}

export async function fetchExportSources(
  creds: AscCredentials,
  appleIaps: InAppPurchase[],
  deps: ExportFetchDeps,
): Promise<ExportFetchResult> {
  const concurrency = deps.concurrency ?? EXPORT_FETCH_CONCURRENCY;

  const outcomes = await withConcurrency(appleIaps, concurrency, async (iap) => {
    try {
      // Critical path — a failure here means this row can't be built at
      // all (no product id / SKU name / localizations to fall back on).
      const detail = await deps.getIapDetail(creds, iap.id);

      // Best-effort — any failure degrades to blank pricing, matching
      // View Detail's own priceSchedule-is-optional resilience.
      let priceSchedule = null as ExportSource["priceSchedule"];
      try {
        const scheduleRes = await deps.getPriceScheduleForIap(creds, iap.id);
        priceSchedule = unpackPriceSchedule(scheduleRes);
      } catch {
        priceSchedule = null;
      }

      const source: ExportSource = {
        productId: detail.iap.attributes.productId,
        skuName: detail.iap.attributes.name,
        status: detail.iap.attributes.state,
        priceSchedule,
        localizations: detail.localizations.map((l) => ({
          locale: l.attributes.locale,
          displayName: l.attributes.name,
          description: l.attributes.description ?? "",
        })),
      };
      return { ok: true as const, source };
    } catch (err) {
      return {
        ok: false as const,
        failure: {
          productId: iap.attributes.productId,
          appleIapId: iap.id,
          error: errMsg(err),
        },
      };
    }
  });

  const sources: ExportSource[] = [];
  const failures: ExportFetchFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) sources.push(outcome.source);
    else failures.push(outcome.failure);
  }
  return { sources, failures };
}
