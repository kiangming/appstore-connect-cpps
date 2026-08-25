/**
 * C3 C-3 [Q-C3.conflict-read-B] — "why does this product already exist?"
 *
 * The Step 3 conflict screen has one job C3 adds to it: let the Manager tell
 * "it exists because the last import finished" from "it exists because the
 * last import stopped part-way". The rule has exactly one way to go wrong —
 * reading NO RECORD as "it went fine" — so absence and success are asserted
 * separately even though both render nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const from = vi.fn();
vi.mock("../db", () => ({ iapDb: () => ({ from }) }));

import {
  conflictRowNote,
  getLastImportByProductId,
  type LastImportRecord,
} from "./last-import";

describe("conflictRowNote — what the conflict row says about the last run", () => {
  it("⚠ a PARTIAL prior run shows its sentence", () => {
    const note = conflictRowNote({
      status: "PARTIAL",
      summary: "Created on Apple · 12/39 locales · missing screenshot",
    });
    expect(note).toBe("Created on Apple · 12/39 locales · missing screenshot");
  });

  it("⚠ a SUCCESS prior run says nothing — the ordinary row already covers it", () => {
    expect(conflictRowNote({ status: "SUCCESS", summary: "all stages OK" })).toBeNull();
  });

  it("⚠ NO RECORD says nothing — but for a DIFFERENT reason than SUCCESS", () => {
    // This is the failure the whole feature guards: a product created in the
    // single-IAP form, synced from Apple, or predating C3 has NO verdict.
    // Treating that as SUCCESS is how a half-built row slips past the screen
    // built to catch it. Both render nothing; only one is an assertion about
    // the product.
    expect(conflictRowNote(undefined)).toBeNull();
  });

  it("⚠ PARTIAL still speaks when the sentence is missing", () => {
    // An older row may predate the summary. The VERDICT is the fact worth
    // showing; falling silent would hide it to avoid an empty string.
    const note = conflictRowNote({ status: "PARTIAL", summary: null });
    expect(note).toBeTruthy();
    expect(note).toMatch(/incomplete/i);
  });

  it("an unknown status invents nothing", () => {
    // A server ahead of this client. Saying nothing beats guessing.
    expect(conflictRowNote({ status: "SOME_FUTURE_STATUS", summary: "x" })).toBeNull();
  });
});

describe("getLastImportByProductId", () => {
  beforeEach(() => {
    from.mockReset();
  });

  function mockRows(rows: unknown[] | null, error: unknown = null) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockResolvedValue({ data: rows, error }),
    };
    from.mockReturnValue(chain);
    return chain;
  }

  it("keys the verdicts by product_id", async () => {
    mockRows([
      { product_id: "a", last_import_status: "PARTIAL", last_import_summary: "s1" },
      { product_id: "b", last_import_status: "SUCCESS", last_import_summary: null },
    ]);
    const out = await getLastImportByProductId("app-1");
    expect(out.a).toEqual({ status: "PARTIAL", summary: "s1" });
    expect(out.b).toEqual({ status: "SUCCESS", summary: null });
  });

  it("⚠ scopes to the app — a product id is only unique within one", async () => {
    const chain = mockRows([]);
    await getLastImportByProductId("app-1");
    expect(chain.eq).toHaveBeenCalledWith("app_id", "app-1");
  });

  it("⚠ a read failure yields NO verdicts rather than wrong ones", async () => {
    // Degrades to the pre-C3 screen: every conflict row looks the same again.
    // That is the honest failure — a missing note, never a false "fine".
    mockRows(null, { message: "boom" });
    expect(await getLastImportByProductId("app-1")).toEqual({});
  });

  it("rows with a null verdict never enter the map", async () => {
    mockRows([
      { product_id: "a", last_import_status: null, last_import_summary: null },
    ]);
    expect(await getLastImportByProductId("app-1")).toEqual({});
  });
});

describe("⚠ the two null cases are distinguishable at the type level", () => {
  it("a record is required to make any claim about a product", () => {
    // Compile-time half of the same rule: you cannot ask the question
    // without either having a record or explicitly passing undefined.
    const present: LastImportRecord = { status: "PARTIAL", summary: null };
    expect(conflictRowNote(present)).not.toBeNull();
    expect(conflictRowNote(undefined)).toBeNull();
  });
});
