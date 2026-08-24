/**
 * The one branch this route had no test for: what it does when Apple's price
 * schedule read fails.
 *
 * ⚠ WHY IT EXISTS NOW. The branch used to be `/404/.test(err.message)` — a
 * REGEX OVER A MESSAGE STRING. It matched any error whose text happened to
 * contain "404" (a URL with 404 in it would do), and it could not tell a
 * stage-1 404 ("this IAP has no schedule", not worth a warning) from a
 * stage-2 one ("the schedule exists and the read broke", very much worth
 * one). Replacing it with a type is only safe if something pins both sides,
 * and nothing did: this route had zero tests.
 *
 * Deliberately minimal — two cases, the two sides of that one branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getPriceScheduleForIap = vi.hoisted(() => vi.fn());
const NoPriceScheduleError = vi.hoisted(
  () =>
    class NoPriceScheduleError extends Error {
      status = 404;
      body = "";
    },
);

vi.mock("@/lib/iap-management/apple/price-schedules", () => ({
  getPriceScheduleForIap,
  NoPriceScheduleError,
}));
vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession: vi.fn(async () => ({ user: { email: "x@y.z" } })),
  IapUnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ id: "acct" })),
}));
vi.mock("@/lib/iap-management/queries/iaps", () => ({
  getIapWithRelations: vi.fn(async () => ({
    iap: {
      id: "iap-1",
      app_id: "app-1",
      apple_iap_id: "apple-1",
      base_territory: "USA",
      tier_id: null,
    },
    localizations: [],
  })),
}));
vi.mock("@/lib/iap-management/apple/availabilities", () => ({
  getAllTerritoryIds: vi.fn(async () => ["USA"]),
}));
vi.mock("@/lib/iap-management/queries/iap-detail", () => ({
  unpackPriceSchedule: vi.fn(() => ({ baseTerritory: "USA", basePrice: null, entries: [] })),
}));
vi.mock("@/lib/iap-management/queries/templates", () => ({
  getDefaultTemplate: vi.fn(async () => null),
  getAppTemplate: vi.fn(async () => null),
}));
vi.mock("@/lib/iap-management/queries/price-tiers", () => ({
  getTierUsdPrice: vi.fn(async () => null),
}));
vi.mock("@/lib/iap-management/custom-prices/repository", () => ({
  listCustomPrices: vi.fn(async () => []),
}));
vi.mock("@/lib/iap-management/custom-prices/baseline", () => ({
  effectiveNowManualPrices: vi.fn(() => []),
}));
vi.mock("@/lib/iap-management/queries/price-point-donor", () => ({
  resolvePricePointSource: vi.fn(async () => null),
}));

import { GET } from "./route";

const req = () =>
  new Request("http://localhost/api/iap-management/apps/app-1/iaps/iap-1/custom-prices/baseline");
const ctx = { params: { appId: "app-1", iapId: "iap-1" } };

async function warnings(): Promise<string[]> {
  const res = await GET(req(), ctx);
  const body = (await res.json()) as { warnings: string[] };
  return body.warnings;
}

describe("custom-prices baseline route — Apple price-schedule read failures", () => {
  beforeEach(() => {
    getPriceScheduleForIap.mockReset();
  });

  it("no schedule on Apple (stage-1 404) is NOT a warning — it is the normal case", async () => {
    // `mockRejectedValue`, not `...Once` — `warnings()` calls GET once and the
    // rejection must hold for that call.
    getPriceScheduleForIap.mockRejectedValue(new NoPriceScheduleError());
    expect((await warnings()).join(" ")).not.toContain("Live Apple prices unavailable");
  });

  it("⚠ a BARE 404 (stage 2 — the schedule exists, the read broke) DOES warn", async () => {
    // Under the old regex this was silently swallowed, because the message
    // contains "404". The Manager was told nothing while live prices were
    // missing from the dialog.
    const err = new Error("404: not found on /manualPrices?cursor=X");
    getPriceScheduleForIap.mockRejectedValue(err);
    expect((await warnings()).join(" ")).toContain("Live Apple prices unavailable");
  });

  it("a 500 warns, as it always did", async () => {
    getPriceScheduleForIap.mockRejectedValue(new Error("500: boom"));
    expect((await warnings()).join(" ")).toContain("Live Apple prices unavailable");
  });
});
