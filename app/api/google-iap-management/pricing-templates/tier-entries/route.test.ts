/**
 * H4.3 — the tier-entries route seeds the custom-prices dialog on its first
 * open under a template. The dialog now applies the thousands-separator rule
 * (statedPriceError) to what it holds, so a whole amount in a currency without
 * decimals must arrive WITHOUT a dot ("249000", never "249000.000000") — or
 * every template-seeded VND/JPY/KRW custom edit would be blocked at Save —
 * and a real fraction must arrive intact.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { email: "a@b.com" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts: vi.fn(async () => [{ id: "acc1", status: "verified" }]),
}));
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId: () => null,
  resolveActiveAccountId: () => "acc1",
}));
vi.mock("@/lib/google-iap-management/queries/templates", () => ({
  lookupTemplateEntriesForIdentifier: vi.fn(async () => [
    { identifier: "tier_999", regionCode: "VN", currency: "VND", priceMicros: "249000000000" },
    { identifier: "tier_999", regionCode: "JP", currency: "JPY", priceMicros: "1500000000" },
    { identifier: "tier_999", regionCode: "US", currency: "USD", priceMicros: "9990000" },
    { identifier: "tier_999", regionCode: "KW", currency: "KWD", priceMicros: "3140000" },
  ]),
}));

import { GET } from "./route";
import { statedPriceError } from "@/lib/google-iap-management/orchestration/file-price";

describe("H4.3 — tier-entries priceDecimal: lossless, no trailing zeros", () => {
  it("VND '249000', JPY '1500', USD '9.99', KWD '3.14' — and none reads as a thousands separator", async () => {
    const res = await GET(new Request("http://x/api?scope=ACCOUNT&identifier=tier_999"));
    const body = (await res.json()) as { entries: Array<{ regionCode: string; currency: string; priceDecimal: string }> };
    expect(body.entries.map((e) => [e.regionCode, e.priceDecimal])).toEqual([
      ["VN", "249000"],
      ["JP", "1500"],
      ["US", "9.99"],
      ["KW", "3.14"],
    ]);
    for (const e of body.entries) expect(statedPriceError(e.priceDecimal, e.currency)).toBeNull();
  });
});
