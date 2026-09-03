/**
 * [Y1.4] THE PROPERTY SHIFT-CLICK RESTS ON: LIST ORDER IS STABLE.
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL. "The rows between these two" is only a
 * meaningful instruction if the list has an order and that order does not
 * change between the two clicks. The census established that it does not, hop
 * by hop — builder pushes in input order, partition preserves it, the facet
 * filter and the search are both `.filter()`, and the window/page is a
 * `.slice()`. Every one of those is an INCIDENTAL property of an
 * implementation choice, and every one of them is one `.sort()` away from
 * turning "the range" into "some rows, roughly".
 *
 * ⚠ AND THE FAILURE WOULD BE SILENT. A sort added for a perfectly good reason
 * ("show newest first") does not break a single existing test: every existing
 * assertion is about membership, not sequence. The Manager would shift-click a
 * visibly-adjacent group and get a different group, with the tool showing
 * nothing wrong. So the ordering is asserted here, deliberately, as a
 * contract — not as coverage of code that already works.
 *
 * If you are here because one of these went red after you added a sort: the
 * range feature needs a decision, not a test edit. Sorting is fine; sorting
 * without re-basing the anchor on the sorted array is not.
 */
import { describe, it, expect } from "vitest";

import {
  buildExportItemRows,
  partitionExportRows,
} from "./export-item-rows";
import { filterRowsByQuery } from "./bulk-item-search";
import { resolveRangeIds } from "./item-range-select";
import type { InAppPurchase } from "@/types/iap-management/apple";

/** Product ids deliberately NOT in alphabetical order, so any sort shows up. */
const ORDER = ["zeta", "alpha", "mid", "beta", "omega"];

const iap = (id: string): InAppPurchase =>
  ({
    type: "inAppPurchases",
    id: `apple-${id}`,
    attributes: {
      name: `Name ${id}`,
      productId: `com.x.${id}`,
      inAppPurchaseType: "CONSUMABLE",
      state: "APPROVED",
    },
  }) as unknown as InAppPurchase;

const IAPS = ORDER.map(iap);

describe("hop 1 — the builder pushes in INPUT order and never sorts", () => {
  it("preserves the order of `iaps` exactly", () => {
    const rows = buildExportItemRows({ iaps: IAPS });
    expect(rows.map((r) => r.appleIapId)).toEqual(
      ORDER.map((n) => `apple-${n}`),
    );
  });

  it("appends drafts AFTER the Apple rows, still in input order", () => {
    const rows = buildExportItemRows({
      iaps: IAPS,
      drafts: [
        { id: "d2", product_id: "com.d.2", reference_name: "Draft 2" },
        { id: "d1", product_id: "com.d.1", reference_name: "Draft 1" },
      ],
    });
    expect(rows.map((r) => r.key)).toEqual([
      ...ORDER.map((n) => `apple-${n}`),
      "draft:d2",
      "draft:d1",
    ]);
  });
});

describe("hop 2 — partition preserves order within each side", () => {
  it("selectable rows come out in the order they went in", () => {
    const { selectable } = partitionExportRows(
      buildExportItemRows({ iaps: IAPS }),
    );
    expect(selectable.map((r) => r.appleIapId)).toEqual(
      ORDER.map((n) => `apple-${n}`),
    );
  });
});

describe("hop 3 — the search is a `.filter()`, so it thins without reordering", () => {
  it("keeps the surviving rows in their original relative order", () => {
    const { selectable } = partitionExportRows(
      buildExportItemRows({ iaps: IAPS }),
    );
    // matches zeta, beta — in that order in the source, NOT alphabetical
    const hit = filterRowsByQuery(selectable, "eta");
    expect(hit.map((r) => r.appleIapId)).toEqual(["apple-zeta", "apple-beta"]);
  });
});

describe("hop 4 — the whole chain, end to end, is what a range is computed over", () => {
  /**
   * ⚠ THE ASSERTION THAT TIES IT TOGETHER. A range taken across the full
   * chain must equal the rows a Manager sees between the two they clicked.
   * If any hop reorders, this is the test that notices.
   */
  it("a range over the chained result is the visually-adjacent group", () => {
    const { selectable } = partitionExportRows(
      buildExportItemRows({ iaps: IAPS }),
    );
    const rendered = filterRowsByQuery(selectable, "com.x.").slice(0, 60);
    expect(rendered.map((r) => r.appleIapId)).toEqual(
      ORDER.map((n) => `apple-${n}`),
    );
    expect(
      resolveRangeIds(rendered, "apple-alpha", "apple-beta"),
    ).toEqual(["apple-alpha", "apple-mid", "apple-beta"]);
  });

  /**
   * ⚠ THE VACUITY GUARD FOR THIS WHOLE FILE. If the chain WERE sorted, the
   * range above would be alphabetical instead. This asserts the two are
   * genuinely different, so a green run above means something.
   */
  it("⚠ vacuity guard — a SORTED chain would give a different range", () => {
    const { selectable } = partitionExportRows(
      buildExportItemRows({ iaps: IAPS }),
    );
    const sorted = [...selectable].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    expect(resolveRangeIds(sorted, "apple-alpha", "apple-beta")).toEqual([
      "apple-alpha",
      "apple-beta",
    ]);
    expect(resolveRangeIds(sorted, "apple-alpha", "apple-beta")).not.toEqual(
      resolveRangeIds(selectable, "apple-alpha", "apple-beta"),
    );
  });
});
