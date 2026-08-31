import { describe, it, expect } from "vitest";

import {
  pickTierByCurrencyMicros,
  lookupTemplateEntriesForIdentifier,
  templateExists,
  findTemplateId,
  buildCandidatesFromEntries,
  getPrimaryTierFromCandidates,
  findCandidateTiersForCurrencyPrice,
} from "./templates";

/**
 * ⚠ ÉP KIỂU CỐ Ý, lý do bắt buộc phải ghi (CLAUDE.md #9).
 *
 * Từ G1b, `TemplateScopeRef` là union phân biệt: nhánh "APP" BẮT BUỘC có
 * `appId: string`. Nghĩa là `{scope:"APP", appId:null}` KHÔNG còn viết
 * được trong TypeScript — đó chính là mục đích của kiểu mới.
 *
 * Nhưng guard runtime vẫn PHẢI sống, vì nó canh BIÊN GIỚI TIN CẬY: route
 * `tier-entries` dựng `scope` từ query param của URL
 * (tier-entries/route.ts), tức giá trị đến từ ngoài hệ kiểu và trình biên
 * dịch không nói gì được về nó. Không ép kiểu thì không gọi tới được
 * guard để kiểm nó còn sống hay không — và một guard không ai kiểm là
 * guard sẽ chết lặng lẽ trong lần refactor sau.
 */
function fromOutsideTheTypeSystem<T>(v: Record<string, unknown>): T {
  return v as unknown as T;
}


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
      lookupTemplateEntriesForIdentifier(
        fromOutsideTheTypeSystem({ scope: "APP", appId: null, identifier: "Tier 1" }),
      ),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("lookupTemplateEntriesForIdentifier throws when scope=APP + appId is empty string", async () => {
    await expect(
      lookupTemplateEntriesForIdentifier(
        fromOutsideTheTypeSystem({ scope: "APP", appId: "", identifier: "Tier 1" }),
      ),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("templateExists throws when scope=APP + appId is null", async () => {
    await expect(
      templateExists(fromOutsideTheTypeSystem({ scope: "APP", appId: null })),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("templateExists throws when scope=APP + appId is empty string", async () => {
    await expect(
      templateExists(fromOutsideTheTypeSystem({ scope: "APP", appId: "" })),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findTemplateId throws when scope=APP + appId is null (Hotfix 18 companion guard)", async () => {
    await expect(
      findTemplateId(fromOutsideTheTypeSystem({ scope: "APP", appId: null })),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findTemplateId throws when scope=APP + appId is empty string", async () => {
    await expect(
      findTemplateId(fromOutsideTheTypeSystem({ scope: "APP", appId: "" })),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findCandidateTiersForCurrencyPrice throws when scope=APP + appId is null (Hotfix 19 guard)", async () => {
    await expect(
      findCandidateTiersForCurrencyPrice(
        fromOutsideTheTypeSystem({
          scope: "APP",
          appId: null,
          currencyCode: "VND",
          priceMicros: "25000000000",
        }),
      ),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });

  it("findCandidateTiersForCurrencyPrice throws when scope=APP + appId is empty string", async () => {
    await expect(
      findCandidateTiersForCurrencyPrice(
        fromOutsideTheTypeSystem({
          scope: "APP",
          appId: "",
          currencyCode: "VND",
          priceMicros: "25000000000",
        }),
      ),
    ).rejects.toThrow(/scope="APP" requires a non-empty appId/);
  });
});

/**
 * Hotfix 19: pure helpers backing the wizard's Preview-step tier
 * picker. `buildCandidatesFromEntries` shapes per-tier metadata
 * (region count + VN entry); `getPrimaryTierFromCandidates` selects
 * the Q5.B-default primary tier.
 */
describe("buildCandidatesFromEntries (Hotfix 19 — candidate descriptor)", () => {
  const TEMPLATE_ID = "tmpl-uuid-1";

  it("captures the VN entry as the primary lens for VND apps", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "27000000000" },
      { identifier: "Tier 1", region_code: "JP", currency: "JPY", price_micros: "160000000" },
    ];
    const [c] = buildCandidatesFromEntries(TEMPLATE_ID, ["Tier 1"], entries);
    expect(c.identifier).toBe("Tier 1");
    expect(c.templateId).toBe(TEMPLATE_ID);
    expect(c.regionCount).toBe(3);
    expect(c.vnCurrency).toBe("VND");
    expect(c.vnPriceMicros).toBe("27000000000");
    expect(c.vnPriceDecimal).toBe("27000");
  });

  it("returns null VN fields when the tier has no VN entry", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 1", region_code: "JP", currency: "JPY", price_micros: "160000000" },
    ];
    const [c] = buildCandidatesFromEntries(TEMPLATE_ID, ["Tier 1"], entries);
    expect(c.vnCurrency).toBeNull();
    expect(c.vnPriceMicros).toBeNull();
    expect(c.vnPriceDecimal).toBeNull();
    expect(c.regionCount).toBe(2);
  });

  it("builds one descriptor per identifier requested even when entries are interleaved", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Alt Tier", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "27000000000" },
      { identifier: "Alt Tier", region_code: "VN", currency: "VND", price_micros: "25000000000" },
    ];
    const cs = buildCandidatesFromEntries(
      TEMPLATE_ID,
      ["Tier 1", "Alt Tier"],
      entries,
    );
    expect(cs).toHaveLength(2);
    const tier1 = cs.find((c) => c.identifier === "Tier 1");
    const alt = cs.find((c) => c.identifier === "Alt Tier");
    expect(tier1?.vnPriceDecimal).toBe("27000");
    expect(alt?.vnPriceDecimal).toBe("25000");
  });
});

describe("getPrimaryTierFromCandidates (Hotfix 19 — Q5.B primary-tier algorithm)", () => {
  it("returns null for empty input", () => {
    expect(getPrimaryTierFromCandidates([])).toBeNull();
  });

  it("returns the single identifier when only one candidate exists", () => {
    expect(
      getPrimaryTierFromCandidates([{ identifier: "Tier 1" }]),
    ).toBe("Tier 1");
  });

  it("prefers a non-Alternate tier over Alternate tiers (Manager's edited tier wins)", () => {
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "Alternate Tier 1" },
        { identifier: "Tier 1" },
        { identifier: "Alternate Tier A" },
      ]),
    ).toBe("Tier 1");
  });

  it("sorts non-Alternate candidates numerically — Tier 1 beats Tier 10", () => {
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "Tier 10" },
        { identifier: "Tier 1" },
        { identifier: "Tier 2" },
      ]),
    ).toBe("Tier 1");
  });

  it("falls back to Alternate-only set when no non-Alternate candidate exists", () => {
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "Alternate Tier A" },
        { identifier: "Alternate Tier 1" },
      ]),
    ).toBe("Alternate Tier 1");
  });

  it("within all-Alternate set, prefers numeric tier names over alphabetic", () => {
    // "Alternate Tier 1" beats "Alternate Tier A" via Intl.Collator
    // numeric sort — digits sort before letters in numeric-aware mode.
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "Alternate Tier B" },
        { identifier: "Alternate Tier A" },
        { identifier: "Alternate Tier 2" },
        { identifier: "Alternate Tier 1" },
      ]),
    ).toBe("Alternate Tier 1");
  });

  it("matches case-insensitively on the 'Alternate' prefix", () => {
    // Defensive — Manager's template may capitalise inconsistently.
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "alternate tier 1" },
        { identifier: "Tier 1" },
      ]),
    ).toBe("Tier 1");
  });

  it("does NOT mark 'AlternateTier 1' (no space) as Alternate — word-boundary precision", () => {
    // The regex `/^alternate\b/i` matches "alternate" only when followed
    // by a non-word character (or end of string). "AlternateTier" has no
    // boundary between 'e' and 'T' (both word chars), so it is treated
    // as a regular non-Alternate tier. Manager's templates conventionally
    // use "Alternate Tier" with a space, so this conservative match is
    // the right default — Manager can use either spacing.
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "AlternateTier 1" },
        { identifier: "Tier 5" },
      ]),
    ).toBe("AlternateTier 1"); // sorts before "Tier 5" alphabetically
  });

  it("does NOT mark 'Alternative Plan' as Alternate — different prefix entirely", () => {
    // "Alternative" doesn't actually start with "Alternate" (the prefix
    // "Alternat" + "e" vs "Alternat" + "i" diverges at the 9th char).
    // Defensive coverage in case Manager invents new tier-name patterns.
    expect(
      getPrimaryTierFromCandidates([
        { identifier: "Alternative Plan" },
        { identifier: "Tier 5" },
      ]),
    ).toBe("Alternative Plan");
  });
});
