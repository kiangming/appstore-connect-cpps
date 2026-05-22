import { describe, it, expect } from "vitest";

import {
  pickTierByUsdMicros,
  pickTierByCurrencyMicros,
  lookupTemplateEntriesForIdentifier,
  findTemplateTierByCurrencyMicros,
  templateExists,
} from "./templates";

/**
 * Hotfix 15 → Hotfix 16: pure picker used by the tier inference
 * fallback in bulk-import. The DB-integrated
 * `findTemplateTierByCurrencyMicros` narrows the SELECT with
 * `.eq("currency", ...)` + `.eq("price_micros", ...)`, but we still
 * run the picker locally because the integration tests would need to
 * mock the Supabase client. Pure logic here is the regression-
 * prevention path.
 */
describe("pickTierByUsdMicros (Hotfix 15 — preserved as alias)", () => {
  it("returns the identifier whose US-region USD entry matches", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
      { identifier: "Tier 3", region_code: "US", currency: "USD", price_micros: "4990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("returns null when no entry matches the requested USD micros", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "999999")).toBeNull();
  });

  it("skips non-US region entries that happen to match the micros value", () => {
    // A template tier whose US entry is $1.99 (1_990_000 micros) and
    // whose VN entry is 25,000 VND (25_000_000_000 micros). A naive
    // implementation that matched only on price_micros would pick the
    // VN row and return its tier; the picker must also enforce
    // region_code === "US".
    const entries = [
      { identifier: "Tier 2", region_code: "VN", currency: "VND", price_micros: "25000000000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
      { identifier: "Tier 3", region_code: "VN", currency: "VND", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("skips entries whose currency is not USD even if region is US", () => {
    // Defensive — shouldn't happen in practice (region US ⇔ currency USD
    // in Google's catalog), but if the template was hand-edited the
    // picker shouldn't accept a non-USD currency for the US region.
    const entries = [
      { identifier: "Tier ?", region_code: "US", currency: "EUR", price_micros: "1990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("returns the first match when multiple tiers share the same US price (deterministic)", () => {
    // Two tiers shouldn't normally share a USD price, but if they do
    // the picker returns the first one (query order). This is
    // deterministic — caller can resolve conflicts by reordering.
    const entries = [
      { identifier: "Tier A", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier B", region_code: "US", currency: "USD", price_micros: "990000" },
    ];
    expect(pickTierByUsdMicros(entries, "990000")).toBe("Tier A");
  });

  it("returns null for empty entries (template has no US/USD rows)", () => {
    expect(pickTierByUsdMicros([], "990000")).toBeNull();
  });
});

/**
 * Hotfix 16: currency-aware picker — region-agnostic, accepts any
 * currency. Replaces the USD-only path for bulk-import's generalised
 * tier inference.
 */
describe("pickTierByCurrencyMicros (Hotfix 16 — currency-aware)", () => {
  it("matches a VND row by (currency, priceMicros) — region-agnostic", () => {
    const entries = [
      { identifier: "Tier 1", currency: "VND", price_micros: "10000000000" }, // 10,000 VND
      { identifier: "Tier 2", currency: "VND", price_micros: "25000000000" }, // 25,000 VND
      { identifier: "Tier 3", currency: "VND", price_micros: "50000000000" }, // 50,000 VND
    ];
    expect(pickTierByCurrencyMicros(entries, "VND", "25000000000")).toBe(
      "Tier 2",
    );
  });

  it("matches a EUR row even when the template has multiple Eurozone regions sharing the same micros (region-agnostic by design)", () => {
    // Template tier 2's EUR price (€0.99 = 990_000 micros) might
    // appear under several Eurozone region codes (AT, BE, DE, FR, …).
    // The picker should still return Tier 2 — the (currency, price)
    // pair is the tier-identifying key.
    const entries = [
      { identifier: "Tier 2", currency: "EUR", price_micros: "990000" },
      { identifier: "Tier 2", currency: "EUR", price_micros: "990000" }, // dup under different region
      { identifier: "Tier 3", currency: "EUR", price_micros: "1990000" },
    ];
    expect(pickTierByCurrencyMicros(entries, "EUR", "990000")).toBe("Tier 2");
  });

  it("normalises lowercase currency input to uppercase (Manager input forgiveness)", () => {
    const entries = [
      { identifier: "Tier 1", currency: "VND", price_micros: "10000000000" },
    ];
    expect(pickTierByCurrencyMicros(entries, "vnd", "10000000000")).toBe(
      "Tier 1",
    );
  });

  it("skips entries whose currency doesn't match (defensive — wrong tier shouldn't bleed across currencies)", () => {
    // USD entry at 990_000 must NOT win when we ask for VND/990_000.
    const entries = [
      { identifier: "Tier USD", currency: "USD", price_micros: "990000" },
      { identifier: "Tier VND", currency: "VND", price_micros: "990000" },
    ];
    expect(pickTierByCurrencyMicros(entries, "VND", "990000")).toBe(
      "Tier VND",
    );
  });

  it("returns null when no matching (currency, priceMicros) pair exists", () => {
    const entries = [
      { identifier: "Tier 1", currency: "VND", price_micros: "10000000000" },
    ];
    expect(pickTierByCurrencyMicros(entries, "VND", "99999")).toBeNull();
    expect(pickTierByCurrencyMicros(entries, "USD", "10000000000")).toBeNull();
  });

  it("returns null for empty entries", () => {
    expect(pickTierByCurrencyMicros([], "VND", "10000000000")).toBeNull();
  });

  it("returns the first match deterministically when duplicates exist", () => {
    const entries = [
      { identifier: "Tier A", currency: "VND", price_micros: "10000000000" },
      { identifier: "Tier B", currency: "VND", price_micros: "10000000000" },
    ];
    expect(pickTierByCurrencyMicros(entries, "VND", "10000000000")).toBe(
      "Tier A",
    );
  });
});

/**
 * Hotfix 17: the three query helpers each refuse to silently treat
 * scope=APP + missing appId as a GLOBAL query. Pre-Hotfix-17 the
 * `&& args.appId` short-circuit on the Supabase chain dropped the
 * scope_app_id filter, so a buggy caller would have queried Default
 * Template entries while believing it was hitting a Per-App template
 * — a debugging trap. These helpers now throw before any DB I/O so
 * the bad call is impossible to miss.
 */
describe("Hotfix 17: scope=APP requires appId guards (no silent GLOBAL fallback)", () => {
  it("lookupTemplateEntriesForIdentifier throws when scope=APP + appId is null", async () => {
    await expect(
      lookupTemplateEntriesForIdentifier({
        scope: "APP",
        appId: null,
        identifier: "Tier 1",
      }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("lookupTemplateEntriesForIdentifier throws when scope=APP + appId is empty string", async () => {
    await expect(
      lookupTemplateEntriesForIdentifier({
        scope: "APP",
        appId: "",
        identifier: "Tier 1",
      }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findTemplateTierByCurrencyMicros throws when scope=APP + appId is null", async () => {
    await expect(
      findTemplateTierByCurrencyMicros({
        scope: "APP",
        appId: null,
        currencyCode: "VND",
        priceMicros: "25000000000",
      }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findTemplateTierByCurrencyMicros throws when scope=APP + appId is empty string", async () => {
    await expect(
      findTemplateTierByCurrencyMicros({
        scope: "APP",
        appId: "",
        currencyCode: "VND",
        priceMicros: "25000000000",
      }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("templateExists throws when scope=APP + appId is null", async () => {
    await expect(
      templateExists({ scope: "APP", appId: null }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("templateExists throws when scope=APP + appId is empty string", async () => {
    await expect(
      templateExists({ scope: "APP", appId: "" }),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });
});
