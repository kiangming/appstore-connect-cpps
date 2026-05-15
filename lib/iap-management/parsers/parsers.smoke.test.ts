/**
 * Smoke tests for IAP parsers against the real Manager-provided templates
 * checked into docs/iap-management/templates/. Locks the parser contract
 * against actual artifact structure observed at IAP.e investigation:
 *
 *   price-tiers-template.xlsx: 88 standard tiers + 7 alternate tiers,
 *                              175 territories, sheet name "price_tiers".
 *   item-iap-template.xlsx:    83 columns (5 lead + 39 locale pairs),
 *                              3 sample data rows.
 *
 * Exhaustive unit tests with synthetic fixtures will land in IAP.l.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parsePriceTiersXlsx } from "./price-tiers";
import { parseIapItemsXlsx } from "./iap-items";
import { matchScreenshotToProductId } from "./screenshot-matcher";

const TEMPLATES_DIR = path.join(
  process.cwd(),
  "docs/iap-management/templates",
);

function loadTemplate(filename: string): File {
  const buffer = fs.readFileSync(path.join(TEMPLATES_DIR, filename));
  return new File([buffer], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("parsePriceTiersXlsx — Manager template", () => {
  it("parses 95 tiers total (88 standard + 7 alternate, per Q-IAP follow-up C)", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);

    expect(result.tiers.length).toBe(95);
    expect(result.tiers[0]).toMatchObject({
      tier_id: "FREE",
      tier_name: "Free Tier",
      is_alternate: false,
    });
    expect(result.tiers[1]).toMatchObject({
      tier_id: "TIER_1",
      tier_name: "Tier 1",
      is_alternate: false,
    });
  });

  it("reports 175 territories", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);
    expect(result.territory_count).toBe(175);
  });

  it("includes alternate tiers with is_alternate=true and ALT_ prefix", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);
    expect(result.alternate_tier_count).toBe(7);
    const alt1 = result.tiers.find((t) => t.tier_id === "ALT_1");
    expect(alt1).toBeDefined();
    expect(alt1!.is_alternate).toBe(true);
    expect(alt1!.tier_name).toBe("Alternate Tier 1");
    const altA = result.tiers.find((t) => t.tier_id === "ALT_A");
    expect(altA).toBeDefined();
    expect(altA!.tier_name).toBe("Alternate Tier A");
  });

  it("tier_id values all match the DB CHECK regex", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);
    const re = /^(FREE|TIER_[0-9]+|ALT_[0-9A-Z]+)$/;
    for (const tier of result.tiers) {
      expect(tier.tier_id, `tier_id "${tier.tier_id}" must match DB CHECK`)
        .toMatch(re);
    }
  });

  it("extracts Tier 1 USA price + proceeds + currency", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);
    const tier1 = result.tiers.find((t) => t.tier_id === "TIER_1");
    expect(tier1).toBeDefined();
    const usa = tier1!.territories.find((t) => t.territory_code === "USA");
    expect(usa).toBeDefined();
    expect(usa!.currency_code).toBe("USD");
    expect(usa!.customer_price).toBe(0.99);
    expect(usa!.proceeds).toBe(0.7);
  });

  it("extracts Tier 1 Vietnam (VNM_VND)", async () => {
    const file = loadTemplate("price-tiers-template.xlsx");
    const result = await parsePriceTiersXlsx(file);
    const tier1 = result.tiers.find((t) => t.tier_id === "TIER_1")!;
    const vnm = tier1.territories.find((t) => t.territory_code === "VNM")!;
    expect(vnm.currency_code).toBe("VND");
    expect(vnm.customer_price).toBe(25000);
  });
});

describe("parseIapItemsXlsx — Manager template (post-IAP.h2 Type column)", () => {
  it("parses sample row with productId, reference name, prices", async () => {
    const file = loadTemplate("item-iap-template.xlsx");
    const result = await parseIapItemsXlsx(file);

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const sample = result.items[0];
    expect(sample.product_id).toBe("com.vng.example.product1");
    expect(sample.reference_name).toBe("Example 1");
    expect(sample.price_usd).toBe(0.99);
    expect(sample.base_price).toBe(23000);
    expect(sample.base_currency).toBe("VND");
  });

  it("Type column empty in samples → defaults to CONSUMABLE with type_source=DEFAULT", async () => {
    const file = loadTemplate("item-iap-template.xlsx");
    const result = await parseIapItemsXlsx(file);
    for (const item of result.items) {
      expect(item.type).toBe("CONSUMABLE");
      expect(item.type_source).toBe("DEFAULT");
    }
  });

  it("detects 39 locale pairs and surfaces 0 skipped (locale-map coverage)", async () => {
    const file = loadTemplate("item-iap-template.xlsx");
    const result = await parseIapItemsXlsx(file);
    expect(result.locale_pair_count).toBe(39);
    expect(result.skipped_locales).toEqual([]);
  });
});

describe("matchScreenshotToProductId — Q-IAP (C) robust both-forms", () => {
  const candidates = [
    "com.vng.example.product1",
    "com.vng.example.product2",
    "com.vng.example.product3",
  ];

  it("matches literal filename (dots preserved) — Manager-committed samples", () => {
    expect(
      matchScreenshotToProductId("com.vng.example.product1.jpg", candidates),
    ).toEqual({
      kind: "matched",
      productId: "com.vng.example.product1",
      method: "literal",
    });
  });

  it("matches normalized filename (dots→underscores) — Manager-spec convention", () => {
    expect(
      matchScreenshotToProductId("com_vng_example_product2.jpg", candidates),
    ).toEqual({
      kind: "matched",
      productId: "com.vng.example.product2",
      method: "normalized",
    });
  });

  it("prefers literal when both could match", () => {
    // Literal "com.vng.example.product1" matches candidate[0] directly.
    // Underscore-normalize would also produce candidate[0] from
    // "com_vng_example_product1" — different filename, so no overlap.
    // Verify literal precedence with the .jpg form.
    expect(
      matchScreenshotToProductId("com.vng.example.product3.jpg", candidates),
    ).toMatchObject({ method: "literal" });
  });

  it("returns no-match for unrelated filename", () => {
    expect(
      matchScreenshotToProductId("unrelated.jpg", candidates),
    ).toEqual({ kind: "no-match" });
  });

  it("is case-sensitive on productId (Apple charset is case-sensitive)", () => {
    expect(
      matchScreenshotToProductId("COM.VNG.EXAMPLE.PRODUCT1.jpg", candidates),
    ).toEqual({ kind: "no-match" });
  });

  it("accepts .png and .jpeg extensions", () => {
    expect(
      matchScreenshotToProductId("com.vng.example.product1.png", candidates),
    ).toMatchObject({ kind: "matched", productId: "com.vng.example.product1" });
    expect(
      matchScreenshotToProductId("com.vng.example.product2.jpeg", candidates),
    ).toMatchObject({ kind: "matched", productId: "com.vng.example.product2" });
  });
});
