/**
 * SC2 — the merge rules that decide whose value wins.
 *
 * Every case here is a rule someone could plausibly "simplify" later. The
 * comments say why each one is the way it is.
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  applyManagerEdit,
  applyRederivedPrices,
  partitionOverrideValidation,
  pickBaseFromDerived,
  reseedOverrides,
} from "./override-merge";
import type { RegionOverrideRow } from "./form-state";
import { validateDecimalForCurrency } from "./google/currency-precision";

const row = (
  region: string,
  currency: string,
  priceDecimal: string,
  dirty = false,
): RegionOverrideRow => ({ region, currency, priceDecimal, dirty });

const currencyFor = (r: string) => (r === "VN" ? "VND" : "USD");

describe("applyManagerEdit — dirty is a record of an ACTION", () => {
  it("stamps the edited row dirty and leaves its siblings alone", () => {
    const rows = [row("US", "USD", "1.99"), row("VN", "VND", "49000")];
    const out = applyManagerEdit(rows, 0, { priceDecimal: "2.49" }, currencyFor);
    expect(out[0]).toEqual({
      region: "US",
      currency: "USD",
      priceDecimal: "2.49",
      dirty: true,
    });
    expect(out[1].dirty).toBe(false);
  });

  it("typing the SAME value still marks dirty — intent is not a value comparison", () => {
    // A Manager who retypes 1.99 has deliberately pinned 1.99. Inferring dirty
    // from "differs from cache" would silently un-pin it on the next
    // re-derive.
    const out = applyManagerEdit(
      [row("US", "USD", "1.99")],
      0,
      { priceDecimal: "1.99" },
      currencyFor,
    );
    expect(out[0].dirty).toBe(true);
  });

  it("re-targeting the region resets the currency but does not pin a price", () => {
    const out = applyManagerEdit(
      [row("US", "USD", "1.99")],
      0,
      { region: "VN" },
      currencyFor,
    );
    expect(out[0].currency).toBe("VND");
    expect(out[0].dirty).toBe(false);
  });
});

describe("applyRederivedPrices — the base price owns every row nobody pinned", () => {
  const derived = [
    { regionCode: "US", currency: "USD", priceDecimal: "2.990000" },
    { regionCode: "VN", currency: "VND", priceDecimal: "74000.000000" },
    { regionCode: "JP", currency: "JPY", priceDecimal: "450.000000" },
  ];

  it("replaces non-dirty rows and adds regions the form did not have", () => {
    const out = applyRederivedPrices(
      [row("US", "USD", "1.99"), row("VN", "VND", "49000.00")],
      derived,
    );
    expect(out.find((r) => r.region === "US")?.priceDecimal).toBe("2.990000");
    expect(out.find((r) => r.region === "VN")?.priceDecimal).toBe("74000.000000");
    expect(out.find((r) => r.region === "JP")?.priceDecimal).toBe("450.000000");
  });

  it("SC2b: overwrites a hand-typed row too, and clears its dirty flag", () => {
    // Inverted from SC2 on Manager decision — see the file header. After a
    // recalculation nothing is hand-pinned any more, so dirty resets.
    const out = applyRederivedPrices(
      [row("US", "USD", "1.99"), row("VN", "VND", "12345", true)],
      derived,
    );
    expect(out.find((r) => r.region === "US")?.priceDecimal).toBe("2.990000");
    const vn = out.find((r) => r.region === "VN")!;
    expect(vn.priceDecimal).toBe("74000.000000");
    expect(vn.dirty).toBe(false);
  });

  it("applies the source value VERBATIM — no rounding, no reformatting", () => {
    const out = applyRederivedPrices(
      [row("TW", "TWD", "6.30")],
      [{ regionCode: "TW", currency: "TWD", priceDecimal: "6.297531" }],
    );
    expect(out[0].priceDecimal).toBe("6.297531");
  });

  it("leaves a row alone when the source says nothing about that region", () => {
    const out = applyRederivedPrices([row("XX", "USD", "9.99")], derived);
    expect(out.find((r) => r.region === "XX")?.priceDecimal).toBe("9.99");
  });

  it("PRECEDENCE RULE: re-derive wins over preserve-bytes on an odd-precision row", () => {
    // TWD 6.30 is a real production value the tool's own validator rejects.
    // On an ACTIVE recalculation it is recomputed like every other row — the
    // Manager asked for exactly that. Preserve-bytes governs the PASSIVE case
    // (an ordinary submit), which never calls this function.
    const out = applyRederivedPrices(
      [row("TW", "TWD", "6.30")],
      [{ regionCode: "TW", currency: "TWD", priceDecimal: "9.000000" }],
    );
    expect(out[0].priceDecimal).toBe("9.000000");
    expect(out[0].dirty).toBe(false);
  });
});

describe("reseedOverrides — a fresh server snapshot arrives mid-edit", () => {
  it("THE WRITE-BACKWARDS BUG: a pure sync re-seeds everything, leaving nothing to submit", () => {
    // Before SC2 the form kept its stale state while `initial` refreshed, so
    // the diff inverted and the modal proposed reverting Google to pre-sync
    // prices. After re-seeding, the rows equal the new server state exactly.
    const stale = [row("US", "USD", "1.99"), row("VN", "VND", "49000.00")];
    const serverAfter = [row("US", "USD", "2.99"), row("VN", "VND", "74000.00")];
    const { rows, conflicts } = reseedOverrides({
      current: stale,
      serverBefore: stale,
      serverAfter,
    });
    expect(rows.map((r) => r.priceDecimal)).toEqual(["2.99", "74000.00"]);
    expect(conflicts).toEqual([]);
  });

  it("keeps a dirty row and re-seeds its non-dirty neighbours", () => {
    const { rows } = reseedOverrides({
      current: [row("US", "USD", "5.00", true), row("VN", "VND", "49000.00")],
      serverBefore: [row("US", "USD", "1.99"), row("VN", "VND", "49000.00")],
      serverAfter: [row("US", "USD", "1.99"), row("VN", "VND", "74000.00")],
    });
    expect(rows.find((r) => r.region === "US")?.priceDecimal).toBe("5.00");
    expect(rows.find((r) => r.region === "VN")?.priceDecimal).toBe("74000.00");
  });

  it("CONFLICT: dirty row whose server value ALSO moved is reported, never auto-resolved", () => {
    const { rows, conflicts } = reseedOverrides({
      current: [row("US", "USD", "5.00", true)],
      serverBefore: [row("US", "USD", "1.99")],
      serverAfter: [row("US", "USD", "3.49")],
    });
    // The Manager's value survives until they choose.
    expect(rows[0].priceDecimal).toBe("5.00");
    expect(conflicts).toEqual([
      {
        region: "US",
        mine: { currency: "USD", priceDecimal: "5.00" },
        theirs: { currency: "USD", priceDecimal: "3.49" },
      },
    ]);
  });

  it("no conflict when the server value did NOT move — only the Manager's did", () => {
    const { conflicts } = reseedOverrides({
      current: [row("US", "USD", "5.00", true)],
      serverBefore: [row("US", "USD", "1.99")],
      serverAfter: [row("US", "USD", "1.99")],
    });
    expect(conflicts).toEqual([]);
  });

  it("an unsaved Manager edit is never discarded, even if the region vanished server-side", () => {
    const { rows } = reseedOverrides({
      current: [row("US", "USD", "5.00", true), row("VN", "VND", "49000")],
      serverBefore: [row("US", "USD", "1.99"), row("VN", "VND", "49000")],
      serverAfter: [row("VN", "VND", "49000")],
    });
    expect(rows.find((r) => r.region === "US")?.priceDecimal).toBe("5.00");
  });

  it("adopts regions the new snapshot introduced", () => {
    const { rows } = reseedOverrides({
      current: [row("US", "USD", "1.99")],
      serverBefore: [row("US", "USD", "1.99")],
      serverAfter: [row("US", "USD", "1.99"), row("JP", "JPY", "300")],
    });
    expect(rows.map((r) => r.region).sort()).toEqual(["JP", "US"]);
  });
});

describe("partitionOverrideValidation — who authored the bad value decides", () => {
  const validate = (p: string, c: string) => validateDecimalForCurrency(p, c);

  it("a Google-authored bad row only warns — it must not strand the item", () => {
    // com.vng.passsdk.2508111020: TW = TWD 6.30, straight from Google. Before
    // SC2 this one untouched row blocked every edit to the item, title included.
    const { blocking, warnings } = partitionOverrideValidation(
      [row("TW", "TWD", "6.30"), row("US", "USD", "1.99")],
      validate,
    );
    expect(blocking).toEqual({});
    expect(Object.keys(warnings)).toEqual(["0"]);
  });

  it("the same bad value BLOCKS once the Manager types it — they can fix it", () => {
    const { blocking, warnings } = partitionOverrideValidation(
      [row("TW", "TWD", "6.30", true)],
      validate,
    );
    expect(Object.keys(blocking)).toEqual(["0"]);
    expect(warnings).toEqual({});
  });

  it("empty rows are neither blocked nor warned", () => {
    const { blocking, warnings } = partitionOverrideValidation(
      [row("US", "USD", "  ", true)],
      validate,
    );
    expect(blocking).toEqual({});
    expect(warnings).toEqual({});
  });
});

/* ── SC2b: base is the single source; tier/base reset everything ────────── */

describe("SC2b — the Manager's 4-step loop, each step overwriting the last", () => {
  const tierA = [
    { regionCode: "US", currency: "USD", priceDecimal: "4.990000" },
    { regionCode: "VN", currency: "VND", priceDecimal: "119000.000000" },
  ];
  const fromBase = [
    { regionCode: "US", currency: "USD", priceDecimal: "2.990000" },
    { regionCode: "VN", currency: "VND", priceDecimal: "74000.000000" },
  ];
  const tierB = [
    { regionCode: "US", currency: "USD", priceDecimal: "9.990000" },
    { regionCode: "VN", currency: "VND", priceDecimal: "239000.000000" },
  ];

  it("tier → base → another tier: every step recomputes all, last write wins", () => {
    // Start: live prices, plus one row the Manager typed by hand.
    let rows = [
      row("US", "USD", "1.99"),
      row("VN", "VND", "49000.00", true), // hand-typed
    ];

    // 1. Pick a tier → everything recomputed, hand-typed row included.
    rows = applyRederivedPrices(rows, tierA);
    expect(rows.map((r) => r.priceDecimal)).toEqual([
      "4.990000",
      "119000.000000",
    ]);
    expect(rows.every((r) => r.dirty === false)).toBe(true);
    // The tier also sets the base price.
    expect(pickBaseFromDerived(tierA, "USD")).toEqual({
      currency: "USD",
      priceDecimal: "4.990000",
    });

    // 2. Edit the base to something else → recomputed again from the base.
    rows = applyRederivedPrices(rows, fromBase);
    expect(rows.map((r) => r.priceDecimal)).toEqual([
      "2.990000",
      "74000.000000",
    ]);

    // 3. Pick a different tier → recomputed again, overwriting step 2.
    rows = applyRederivedPrices(rows, tierB);
    expect(rows.map((r) => r.priceDecimal)).toEqual([
      "9.990000",
      "239000.000000",
    ]);
    expect(pickBaseFromDerived(tierB, "USD")).toEqual({
      currency: "USD",
      priceDecimal: "9.990000",
    });

    // 4. And again, unbounded — back to a base edit.
    rows = applyRederivedPrices(rows, fromBase);
    expect(rows.map((r) => r.priceDecimal)).toEqual([
      "2.990000",
      "74000.000000",
    ]);
  });

  it("THE BOUNDARY: the same hand-typed row that a recalculation overwrites still survives a Sync", () => {
    // Recalculation ignores dirty…
    const afterRecalc = applyRederivedPrices([row("VN", "VND", "12345", true)], [
      { regionCode: "VN", currency: "VND", priceDecimal: "74000.000000" },
    ]);
    expect(afterRecalc[0].priceDecimal).toBe("74000.000000");

    // …but a sync (data arriving from outside, not a Manager command) does not.
    const { rows } = reseedOverrides({
      current: [row("VN", "VND", "12345", true)],
      serverBefore: [row("VN", "VND", "49000.00")],
      serverAfter: [row("VN", "VND", "74000.00")],
    });
    expect(rows[0].priceDecimal).toBe("12345");
  });
});

describe("pickBaseFromDerived — a tier sets the base price", () => {
  const entries = [
    { regionCode: "US", currency: "USD", priceDecimal: "4.990000" },
    { regionCode: "VN", currency: "VND", priceDecimal: "119000.000000" },
  ];

  it("prefers the entry in the app's configured currency", () => {
    expect(pickBaseFromDerived(entries, "VND")).toEqual({
      currency: "VND",
      priceDecimal: "119000.000000",
    });
  });

  it("falls back to the US entry, matching how a base price is read back", () => {
    expect(pickBaseFromDerived(entries, "EUR")).toEqual({
      currency: "USD",
      priceDecimal: "4.990000",
    });
  });

  it("returns null for an empty tier rather than inventing a base", () => {
    expect(pickBaseFromDerived([], "USD")).toBeNull();
  });

  it("carries the decimal through verbatim", () => {
    expect(
      pickBaseFromDerived(
        [{ regionCode: "TW", currency: "TWD", priceDecimal: "6.297531" }],
        "TWD",
      ),
    ).toEqual({ currency: "TWD", priceDecimal: "6.297531" });
  });
});
