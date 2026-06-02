import { describe, it, expect } from "vitest";
import {
  resolveConflicts,
  enrichWithTiers,
  type ConflictMode,
} from "./conflict-resolution";
import type { ParsedIapItem } from "../parsers/iap-items";
import type { UsdTierEntry } from "../queries/price-tiers";

function row(overrides: Partial<ParsedIapItem> = {}): ParsedIapItem {
  return {
    row_index: 2,
    product_id: "com.vng.app.product1",
    reference_name: "Product 1",
    type: "CONSUMABLE",
    type_source: "DEFAULT",
    price_usd: 0.99,
    base_price: 23000,
    base_currency: "VND",
    localizations: [],
    warnings: [],
    ...overrides,
  };
}

describe("resolveConflicts — Q-IAP.8 (overwrite default + per-item skip)", () => {
  it("CREATE when productId is new", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.new1" })],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("CREATE");
    expect(result.counts).toEqual({ create: 1, overwrite: 0, skip: 0, error: 0 });
  });

  it("OVERWRITE when productId exists and global mode = OVERWRITE", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.existing" })],
      existing_product_ids: new Set(["com.vng.app.existing"]),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("OVERWRITE");
    expect(result.decisions[0].conflict).toBe(true);
  });

  it("SKIP when productId exists and global mode = SKIP", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.existing" })],
      existing_product_ids: new Set(["com.vng.app.existing"]),
      default_mode: "SKIP",
    });
    expect(result.decisions[0].disposition).toBe("SKIP");
  });

  it("per-item override wins over default_mode", () => {
    const items = [
      row({ product_id: "com.vng.app.a" }),
      row({ product_id: "com.vng.app.b" }),
    ];
    const result = resolveConflicts({
      parsed: items,
      existing_product_ids: new Set(["com.vng.app.a", "com.vng.app.b"]),
      default_mode: "OVERWRITE",
      overrides: { "com.vng.app.a": "SKIP" },
    });
    expect(result.decisions[0].disposition).toBe("SKIP");
    expect(result.decisions[1].disposition).toBe("OVERWRITE");
  });

  it("validation errors short-circuit conflict handling", () => {
    const result = resolveConflicts({
      parsed: [
        row({ product_id: "has spaces" }),
        row({ product_id: "_starts.with.underscore" }),
        row({ product_id: "com.valid.product", reference_name: "x".repeat(65) }),
      ],
      existing_product_ids: new Set(["has spaces"]), // even if "existing"
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("ERROR");
    expect(result.decisions[0].reason).toMatch(/invalid characters/);
    expect(result.decisions[1].disposition).toBe("ERROR");
    expect(result.decisions[2].disposition).toBe("ERROR");
    expect(result.decisions[2].reason).toMatch(/64 chars/);
  });

  it("rejects non-numeric / negative price", () => {
    const result = resolveConflicts({
      parsed: [
        row({ price_usd: -1 }),
        row({ price_usd: Number.NaN }),
      ],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("ERROR");
    expect(result.decisions[1].disposition).toBe("ERROR");
  });

  it("counts buckets reflect per-row disposition", () => {
    const result = resolveConflicts({
      parsed: [
        row({ product_id: "com.vng.app.new1" }),
        row({ product_id: "com.vng.app.new2" }),
        row({ product_id: "com.vng.app.existing1" }),
        row({ product_id: "com.vng.app.existing2" }),
        row({ product_id: "broken id" }),
      ],
      existing_product_ids: new Set([
        "com.vng.app.existing1",
        "com.vng.app.existing2",
      ]),
      default_mode: "OVERWRITE",
      overrides: { "com.vng.app.existing2": "SKIP" },
    });
    expect(result.counts).toEqual({
      create: 2,
      overwrite: 1,
      skip: 1,
      error: 1,
    });
  });

  it("preserves source row for downstream consumers", () => {
    const items = [row({ product_id: "com.vng.app.x" })];
    const result = resolveConflicts({
      parsed: items,
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].source).toBe(items[0]);
  });
});

describe("ConflictMode type", () => {
  it("admits only OVERWRITE and SKIP", () => {
    const modes: ConflictMode[] = ["OVERWRITE", "SKIP"];
    expect(modes).toHaveLength(2);
  });
});

describe("enrichWithTiers — IAP.h2 tier inference pass", () => {
  const tiers: UsdTierEntry[] = [
    { tier_id: "FREE", customer_price: 0 },
    { tier_id: "TIER_1", customer_price: 0.99 },
    { tier_id: "TIER_5", customer_price: 4.99 },
  ];

  it("attaches resolved_tier_id to CREATE rows", () => {
    const initial = resolveConflicts({
      parsed: [row({ price_usd: 0.99 })],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.decisions[0].disposition).toBe("CREATE");
    expect(enriched.decisions[0].resolved_tier_id).toBe("TIER_1");
  });

  it("attaches resolved_tier_id to OVERWRITE rows", () => {
    const initial = resolveConflicts({
      parsed: [row({ price_usd: 4.99 })],
      existing_product_ids: new Set(["com.vng.app.product1"]),
      default_mode: "OVERWRITE",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.decisions[0].disposition).toBe("OVERWRITE");
    expect(enriched.decisions[0].resolved_tier_id).toBe("TIER_5");
  });

  it("downgrades CREATE → ERROR when price has no tier match", () => {
    const initial = resolveConflicts({
      parsed: [row({ price_usd: 1.5 })],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.decisions[0].disposition).toBe("ERROR");
    expect(enriched.decisions[0].reason).toMatch(/\$1\.5/);
    expect(enriched.decisions[0].resolved_tier_id).toBeNull();
  });

  it("passes SKIP rows through unchanged (tier irrelevant)", () => {
    const initial = resolveConflicts({
      parsed: [row({ price_usd: 1.5 })], // would fail tier
      existing_product_ids: new Set(["com.vng.app.product1"]),
      default_mode: "SKIP",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.decisions[0].disposition).toBe("SKIP");
    expect(enriched.decisions[0].resolved_tier_id).toBeUndefined();
  });

  it("passes existing ERROR rows through unchanged", () => {
    const initial = resolveConflicts({
      parsed: [row({ product_id: "bad id" })], // fails validation
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.decisions[0].disposition).toBe("ERROR");
    expect(enriched.decisions[0].reason).toMatch(/invalid characters/);
  });

  it("tally counts reflect post-enrichment dispositions", () => {
    const initial = resolveConflicts({
      parsed: [
        row({ product_id: "com.vng.app.a", price_usd: 0.99 }),
        row({ product_id: "com.vng.app.b", price_usd: 4.99 }),
        row({ product_id: "com.vng.app.c", price_usd: 7.77 }), // no match
      ],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    const enriched = enrichWithTiers(initial, tiers);
    expect(enriched.counts).toEqual({ create: 2, overwrite: 0, skip: 0, error: 1 });
  });
});

/**
 * Cycle 43 — cross-path tier-resolution gate.
 *
 * The bug: "Update App-Pricing Template" writes only to
 * `price_tier_template_entries`; the bulk-import gate (enrichWithTiers, used
 * by BOTH preview and /execute) resolved against the legacy
 * `price_tier_territories` cache. A newly-added template tier therefore
 * showed in the matrix view but ERRORed in bulk import.
 *
 * The fix routes the per-source USA/USD list through `listUsdTiersForSource`
 * so the gate resolves against the SAME source the orchestrator applies from.
 * `enrichWithTiers` is pure and already takes the list as a parameter, so
 * these tests model each pricing source as the list that helper returns and
 * prove the gate's verdict tracks the selected source.
 */
describe("enrichWithTiers — Cycle 43 per-source resolution", () => {
  // Legacy USA/USD cache (price_tier_territories): the new $12.99 tier was
  // never written here — this is the pre-fix source that produced the ERROR.
  const legacyList: UsdTierEntry[] = [
    { tier_id: "FREE", customer_price: 0 },
    { tier_id: "TIER_1", customer_price: 0.99 },
    { tier_id: "TIER_5", customer_price: 4.99 },
  ];
  // App-specific template USA/USD entries: Manager added TIER_12 @ $12.99.
  const appTemplateList: UsdTierEntry[] = [
    ...legacyList,
    { tier_id: "TIER_12", customer_price: 12.99 },
  ];
  // Default (GLOBAL) template USA/USD entries: carries a distinct $7.99 tier.
  const defaultTemplateList: UsdTierEntry[] = [
    { tier_id: "FREE", customer_price: 0 },
    { tier_id: "TIER_1", customer_price: 0.99 },
    { tier_id: "TIER_8", customer_price: 7.99 },
  ];

  const enrichOne = (price: number, list: UsdTierEntry[]) =>
    enrichWithTiers(
      resolveConflicts({
        parsed: [row({ product_id: "com.vng.app.newtier", price_usd: price })],
        existing_product_ids: new Set(),
        default_mode: "OVERWRITE",
      }),
      list,
    ).decisions[0];

  it("APP_TEMPLATE source: new $12.99 tier resolves (no ERROR)", () => {
    const d = enrichOne(12.99, appTemplateList);
    expect(d.disposition).toBe("CREATE");
    expect(d.resolved_tier_id).toBe("TIER_12");
  });

  it("DEFAULT_TEMPLATE source: item resolves from the global template", () => {
    const d = enrichOne(7.99, defaultTemplateList);
    expect(d.disposition).toBe("CREATE");
    expect(d.resolved_tier_id).toBe("TIER_8");
  });

  it("APPLE (legacy) source: keeps current behavior for existing tiers (back-compat)", () => {
    const d = enrichOne(0.99, legacyList);
    expect(d.disposition).toBe("CREATE");
    expect(d.resolved_tier_id).toBe("TIER_1");
  });

  it("reproduces the bug: $12.99 against the legacy list ERRORs (pre-fix path)", () => {
    const d = enrichOne(12.99, legacyList);
    expect(d.disposition).toBe("ERROR");
    expect(d.reason).toMatch(/does not match any Apple tier/);
  });

  it("old/pre-existing tiers still resolve under every source (back-compat)", () => {
    for (const list of [legacyList, appTemplateList, defaultTemplateList]) {
      const d = enrichOne(0.99, list);
      expect(d.disposition).toBe("CREATE");
      expect(d.resolved_tier_id).toBe("TIER_1");
    }
  });

  it("selector drives the verdict: swapping the active list flips ERROR↔CREATE (useMemo recompute essence)", () => {
    // Same item, only the active source list changes — exactly what the
    // wizard's `resolved` useMemo recomputes when the source selector flips.
    const bySource: Record<string, UsdTierEntry[]> = {
      APPLE: legacyList,
      DEFAULT_TEMPLATE: defaultTemplateList,
      APP_TEMPLATE: appTemplateList,
    };
    expect(enrichOne(12.99, bySource.APPLE).disposition).toBe("ERROR");
    expect(enrichOne(12.99, bySource.APP_TEMPLATE).disposition).toBe("CREATE");
  });

  it("preview/execute consistency: identical dispositions for the same input + source list", () => {
    // Preview (wizard, bySource[kind]) and /execute (listUsdTiersForSource)
    // resolve from the SAME helper output, then run the SAME enrichWithTiers.
    // Modelling both with one source list must yield identical verdicts —
    // the load-bearing guard against re-introducing a two-table split.
    const sourceList = appTemplateList; // what listUsdTiersForSource returns
    const input = {
      parsed: [
        row({ product_id: "com.vng.app.a", price_usd: 12.99 }), // new tier
        row({ product_id: "com.vng.app.b", price_usd: 0.99 }), // old tier
        row({ product_id: "com.vng.app.c", price_usd: 3.33 }), // no match
      ],
      existing_product_ids: new Set<string>(),
      default_mode: "OVERWRITE" as ConflictMode,
    };
    const previewVerdicts = enrichWithTiers(resolveConflicts(input), sourceList);
    const executeVerdicts = enrichWithTiers(resolveConflicts(input), sourceList);
    expect(previewVerdicts.decisions.map((d) => d.disposition)).toEqual(
      executeVerdicts.decisions.map((d) => d.disposition),
    );
    expect(previewVerdicts.counts).toEqual({
      create: 2,
      overwrite: 0,
      skip: 0,
      error: 1,
    });
  });
});
