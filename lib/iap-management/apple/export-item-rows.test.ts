/**
 * ⚠ THE LOAD-BEARING TEST IN THIS FILE is "an Apple item with NO internalId is
 * SELECTABLE". Everything else is ordinary coverage.
 *
 * That one assertion is the anti-reinfection pin for the defect the chunk-2
 * census went looking for: A′'s `not_linked` exclusion is correct on the
 * availability surface and WRONG here, and copying it would hide an exportable
 * item behind a plausible-sounding reason — a failure mode that looks exactly
 * like a bug report and produces no error anywhere.
 *
 * The mutation that proves the pin bites: replace `partitionExportRows`'
 * body with `partitionRows` from `bulk-item-rows.ts`. The unlinked item then
 * comes back excluded with reason "Not linked locally…", and these tests go
 * red.
 */
import { describe, it, expect } from "vitest";

import {
  buildExportItemRows,
  partitionExportRows,
  exportEmptyCause,
  type ExportItemRow,
} from "./export-item-rows";
import {
  filterRowsByQuery,
  selectionCounts,
  toggleAllForQuery,
} from "./bulk-item-search";
import type { InAppPurchase } from "@/types/iap-management/apple";

function iap(id: string, productId = `com.example.${id}`, name = `Item ${id}`) {
  return {
    type: "inAppPurchases",
    id,
    attributes: {
      productId,
      name,
      inAppPurchaseType: "CONSUMABLE",
      state: "APPROVED",
    },
  } as unknown as InAppPurchase;
}

function draft(id: string) {
  return { id, product_id: `com.example.${id}`, reference_name: `Draft ${id}` };
}

// ─── 🎯 the pin ────────────────────────────────────────────────────────────

describe("an Apple item with no local UUID", () => {
  it("is SELECTABLE — export calls Apple by appleIapId and never touches the local DB", () => {
    const rows = buildExportItemRows({
      iaps: [iap("A1")],
      appleToInternal: {}, // ← nothing seeded locally: A′ would exclude this
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].internalId).toBeNull();
    expect(rows[0].exclusion).toBeNull();
  });

  it("survives the PARTITION too — the requirement lives downstream of the builder", () => {
    // ⚠ THE MUTATION TARGET. bulk-item-rows' partitionRows re-applies the
    // internal-id check in TWO more places (its isSelectable, then its
    // fallback's not_linked reason), so a builder-only fix would not hold.
    const rows = buildExportItemRows({
      iaps: [iap("A1")],
      appleToInternal: {},
    });
    const { selectable, excluded } = partitionExportRows(rows);

    expect(selectable.map((r) => r.appleIapId)).toEqual(["A1"]);
    expect(excluded).toHaveLength(0);
    // Named explicitly so a regression reads as the defect it is, not as an
    // off-by-one in a count.
    expect(excluded.map((r) => r.exclusion.reason)).not.toContain(
      "Not linked locally — this item has no local record yet.",
    );
  });

  it("is indistinguishable from a linked item — export has no opinion either way", () => {
    const rows = buildExportItemRows({
      iaps: [iap("A1"), iap("A2")],
      appleToInternal: { A2: "uuid-2" },
    });
    const { selectable } = partitionExportRows(rows);

    expect(selectable.map((r) => r.appleIapId)).toEqual(["A1", "A2"]);
    expect(rows[0].internalId).toBeNull();
    expect(rows[1].internalId).toBe("uuid-2");
  });

  it("selects every Apple item even when appleToInternal is omitted entirely", () => {
    const rows = buildExportItemRows({ iaps: [iap("A1"), iap("A2"), iap("A3")] });

    expect(partitionExportRows(rows).selectable).toHaveLength(3);
  });
});

// ─── drafts: the one real exclusion ────────────────────────────────────────

describe("local drafts", () => {
  it("are excluded — there is nothing on Apple to read", () => {
    const rows = buildExportItemRows({ iaps: [], drafts: [draft("d1")] });

    expect(rows[0].exclusion?.kind).toBe("local_draft");
    expect(rows[0].appleIapId).toBeNull();
  });

  it("carry EXPORT's wording, not A′'s availability-specific hint", () => {
    const rows = buildExportItemRows({ iaps: [], drafts: [draft("d1")] });

    expect(rows[0].exclusion?.hint).toBe(
      "Export reads live from Apple. Create this item on Apple first.",
    );
    // A′'s hint would be a lie here: availability is not why a draft can't be
    // exported.
    expect(rows[0].exclusion?.hint).not.toContain("availability only exists");
  });

  it("are still RENDERED — hidden drafts read as vanished items (Manager lock)", () => {
    const rows = buildExportItemRows({
      iaps: [iap("A1")],
      drafts: [draft("d1")],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(["A1", "draft:d1"]);
  });

  it("never reach the selectable side", () => {
    const rows = buildExportItemRows({
      iaps: [iap("A1")],
      drafts: [draft("d1"), draft("d2")],
    });
    const { selectable, excluded } = partitionExportRows(rows);

    expect(selectable.map((r) => r.key)).toEqual(["A1"]);
    expect(excluded.map((r) => r.key)).toEqual(["draft:d1", "draft:d2"]);
  });
});

// ─── totality ──────────────────────────────────────────────────────────────

describe("partitionExportRows is total", () => {
  it("puts every row on exactly one side", () => {
    const rows = buildExportItemRows({
      iaps: [iap("A1"), iap("A2")],
      drafts: [draft("d1")],
      appleToInternal: { A1: "uuid-1" },
    });
    const { selectable, excluded } = partitionExportRows(rows);

    expect(selectable.length + excluded.length).toBe(rows.length);
    const keys = [...selectable, ...excluded].map((r) => r.key).sort();
    expect(keys).toEqual(["A1", "A2", "draft:d1"]);
  });

  it("does not drop an unconstructible row (no exclusion, no Apple id)", () => {
    // Unreachable via the builder; asserted because "never drop a row" is the
    // property, not "the builder happens not to make one".
    const rogue: ExportItemRow = {
      key: "rogue",
      appleIapId: null,
      internalId: null,
      productId: "com.example.rogue",
      name: "Rogue",
      exclusion: null,
    };
    const { selectable, excluded } = partitionExportRows([rogue]);

    expect(selectable).toHaveLength(0);
    expect(excluded).toHaveLength(1);
    // "No Apple id" means "not on Apple" here — the draft reason, never
    // A′'s not_linked.
    expect(excluded[0].exclusion.kind).toBe("local_draft");
  });
});

// ─── interop with bulk-item-search, reused verbatim ────────────────────────

describe("bulk-item-search works on these rows unchanged", () => {
  const rows = buildExportItemRows({
    iaps: [
      iap("A1", "com.example.gems", "Gem Pack"),
      iap("A2", "com.example.coins", "Coin Pack"),
      iap("A3", "com.example.gems.large", "Large Gems"),
    ],
    drafts: [draft("d1")],
    // ⚠ deliberately empty: the search helpers must not care either.
    appleToInternal: {},
  });

  it("filters by product id and name", () => {
    expect(filterRowsByQuery(rows, "gem").map((r) => r.key)).toEqual(["A1", "A3"]);
  });

  it("counts unlinked rows as matching and selectable", () => {
    const { selectable } = partitionExportRows(rows);
    const counts = selectionCounts({
      selectableRows: selectable,
      totalRows: rows.length,
      selected: new Set(["A1"]),
      query: "gem",
    });

    expect(counts).toEqual({
      matching: 2,
      selectedMatching: 1,
      selectedHidden: 0,
      total: 4,
    });
  });

  it("Select all takes every MATCHING row, not the rendered set", () => {
    const { selectable } = partitionExportRows(rows);
    const next = toggleAllForQuery({
      selectableRows: selectable,
      selected: new Set(),
      query: "gem",
    });

    expect([...next].sort()).toEqual(["A1", "A3"]);
  });

  it("Select all never picks up a draft — it is not in the selectable set", () => {
    const { selectable } = partitionExportRows(rows);
    const next = toggleAllForQuery({
      selectableRows: selectable,
      selected: new Set(),
      query: "",
    });

    expect([...next].sort()).toEqual(["A1", "A2", "A3"]);
  });
});

// ─── empty cause ───────────────────────────────────────────────────────────

describe("exportEmptyCause", () => {
  it("distinguishes an empty app from an app of drafts only", () => {
    expect(exportEmptyCause([])).toBe("no_items");
    expect(
      exportEmptyCause(buildExportItemRows({ iaps: [], drafts: [draft("d1")] })),
    ).toBe("all_drafts");
  });
});
