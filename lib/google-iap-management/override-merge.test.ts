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

  it("NEVER touches a row the Manager pinned", () => {
    const out = applyRederivedPrices(
      [row("US", "USD", "1.99"), row("VN", "VND", "12345", true)],
      derived,
    );
    expect(out.find((r) => r.region === "US")?.priceDecimal).toBe("2.990000");
    const vn = out.find((r) => r.region === "VN")!;
    expect(vn.priceDecimal).toBe("12345");
    expect(vn.dirty).toBe(true);
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

  it("PRECEDENCE RULE (item 6): re-derive wins over preserve-bytes on a non-dirty odd-precision row", () => {
    // TWD 6.30 is a real production value the tool's own validator rejects.
    // On an ACTIVE re-derive request it is recomputed like any other unpinned
    // row — the Manager asked for exactly that. Preserve-bytes governs the
    // PASSIVE case, which never calls this function.
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
