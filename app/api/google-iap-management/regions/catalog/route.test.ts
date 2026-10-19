/**
 * H4.3 — the catalogue route seeds the custom-prices dialog ("set price")
 * and the item form (re-derive from the base price). Both now apply the
 * thousands-separator rule to what they hold, so a whole amount in a
 * currency without decimals must arrive WITHOUT a dot ("26000", never
 * "26000.000000"), and a real fraction must arrive intact ("6.3").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { email: "a@b.com" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted: vi.fn(() => ({})) }));
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts: vi.fn(async () => [{ id: "acc1", status: "verified" }]),
  getEncryptedCredentials: vi.fn(async () => ({})),
}));
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage: vi.fn(async () => ({ id: "app1", default_currency: null })),
}));
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId: () => null,
  resolveActiveAccountId: () => "acc1",
}));
const buildRegionMapFromBasePrice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/regions-helper", () => ({ buildRegionMapFromBasePrice }));

import { GET } from "./route";
import { statedPriceError } from "@/lib/google-iap-management/orchestration/file-price";

beforeEach(() => {
  buildRegionMapFromBasePrice.mockResolvedValue({
    regions: [
      { region: "VN", currency: "VND", priceMicros: "26000000000" },
      { region: "JP", currency: "JPY", priceMicros: "160000000" },
      { region: "TW", currency: "TWD", priceMicros: "6300000" },
      { region: "US", currency: "USD", priceMicros: "990000" },
    ],
    regionsVersion: "2025/03",
  });
});

describe("H4.3 — convertedDecimal is lossless and carries no trailing zeros", () => {
  it("whole 0-decimal amounts have no dot; fractions are kept; every seed passes the shared rule's separator check", async () => {
    const res = await GET(
      new Request("http://x/api?packageName=com.example&basePriceMicros=990000&baseCurrency=USD"),
    );
    const body = (await res.json()) as { regions: Array<{ regionCode: string; currency: string; convertedDecimal: string }> };
    expect(body.regions.map((r) => [r.regionCode, r.convertedDecimal])).toEqual([
      ["VN", "26000"],
      ["JP", "160"],
      ["TW", "6.3"],
      ["US", "0.99"],
    ]);
    // Seeded into the dialog / form: none of them reads as a thousands separator.
    for (const r of body.regions) {
      expect(statedPriceError(r.convertedDecimal, r.currency) ?? "").not.toMatch(/thousands separator/);
    }
  });
});
