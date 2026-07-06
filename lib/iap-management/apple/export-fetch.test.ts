/**
 * fetchExportSources — bounded-concurrency per-IAP export fetch with
 * failure isolation. Deps are injected fakes so this exercises the
 * isolation/degrade logic without a live Apple call.
 */
import { describe, it, expect, vi } from "vitest";

import { fetchExportSources } from "./export-fetch";
import { AppleApiError } from "./fetch";
import type { InAppPurchase, InAppPurchaseLocalization, AscApiResponse, InAppPurchasePriceSchedule } from "@/types/iap-management/apple";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds = {} as AscCredentials;

function iap(id: string, productId: string, state = "APPROVED"): InAppPurchase {
  return {
    type: "inAppPurchases",
    id,
    attributes: { name: `Ref ${productId}`, productId, inAppPurchaseType: "CONSUMABLE", state },
  } as InAppPurchase;
}

function localization(locale: string, name: string, description = ""): InAppPurchaseLocalization {
  return {
    type: "inAppPurchaseLocalizations",
    id: `loc-${locale}`,
    attributes: { locale, name, description },
  } as InAppPurchaseLocalization;
}

function scheduleResponse(baseTerritory: string): AscApiResponse<InAppPurchasePriceSchedule> {
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      id: "sched-1",
      relationships: { baseTerritory: { data: { id: baseTerritory } } },
    } as unknown as InAppPurchasePriceSchedule,
    included: [],
  };
}

describe("fetchExportSources", () => {
  it("builds an ExportSource per IAP from the injected detail + schedule fetches", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [localization("en-US", "A", "Desc A")],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].productId).toBe("com.x.a");
    expect(result.sources[0].skuName).toBe("Ref com.x.a");
    expect(result.sources[0].status).toBe("APPROVED");
    expect(result.sources[0].priceSchedule?.baseTerritory).toBe("USA");
    expect(result.sources[0].localizations).toEqual([
      { locale: "en-US", displayName: "A", description: "Desc A" },
    ]);
  });

  it("skips an IAP whose critical detail fetch fails, with a warning — doesn't fail the export", async () => {
    const getIapDetail = vi
      .fn()
      .mockResolvedValueOnce({
        iap: iap("ok-1", "com.x.ok"),
        localizations: [],
        screenshot: null,
      })
      .mockRejectedValueOnce(new AppleApiError(500, "GET", "/v2/inAppPurchases/bad-1", "boom"));
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(
      creds,
      [iap("ok-1", "com.x.ok"), iap("bad-1", "com.x.bad")],
      { getIapDetail, getPriceScheduleForIap },
    );

    expect(result.sources.map((s) => s.productId)).toEqual(["com.x.ok"]);
    expect(result.failures).toEqual([
      { productId: "com.x.bad", appleIapId: "bad-1", error: "500: boom" },
    ]);
  });

  it("degrades to blank pricing (priceSchedule: null) on a price-schedule 404 — row still included", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(404, "GET", "/v2/inAppPurchases/a1/iapPriceSchedule", "not found"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].priceSchedule).toBeNull();
  });

  it("degrades to blank pricing on a non-404 price-schedule error too — row still included", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(500, "GET", "/v2/inAppPurchases/a1/iapPriceSchedule", "boom"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources[0].priceSchedule).toBeNull();
  });

  it("respects bounded concurrency — never more than `concurrency` in flight at once", async () => {
    const CONCURRENCY = 2;
    let inFlight = 0;
    let maxInFlight = 0;
    const getIapDetail = vi.fn().mockImplementation(async (_c, id: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { iap: iap(id, `com.x.${id}`), localizations: [], screenshot: null };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const items = Array.from({ length: 6 }, (_, i) => iap(`id-${i}`, `com.x.${i}`));
    const result = await fetchExportSources(creds, items, {
      getIapDetail,
      getPriceScheduleForIap,
      concurrency: CONCURRENCY,
    });

    expect(result.sources).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("isolates multiple failures — every other IAP still exports", async () => {
    const getIapDetail = vi.fn().mockImplementation(async (_c, id: string) => {
      if (id === "bad-1" || id === "bad-2") {
        throw new AppleApiError(500, "GET", `/v2/inAppPurchases/${id}`, "boom");
      }
      return { iap: iap(id, `com.x.${id}`), localizations: [], screenshot: null };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(
      creds,
      [iap("ok-1", "com.x.ok-1"), iap("bad-1", "com.x.bad-1"), iap("ok-2", "com.x.ok-2"), iap("bad-2", "com.x.bad-2")],
      { getIapDetail, getPriceScheduleForIap },
    );

    expect(result.sources.map((s) => s.productId).sort()).toEqual(["com.x.ok-1", "com.x.ok-2"]);
    expect(result.failures).toHaveLength(2);
  });
});
