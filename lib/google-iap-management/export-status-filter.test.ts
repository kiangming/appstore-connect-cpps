import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  countByStatus,
  exportSummaryLine,
  isExportStatusFilter,
  matchesStatusFilter,
  partitionByStatusFilter,
  STATUS_FILTER_NOTE,
} from "./export-status-filter";

const item = (status: string | null) => ({ status });

describe("matchesStatusFilter", () => {
  it("`all` keeps everything, including a null status", () => {
    expect(matchesStatusFilter("active", "all")).toBe(true);
    expect(matchesStatusFilter("inactive", "all")).toBe(true);
    expect(matchesStatusFilter(null, "all")).toBe(true);
  });

  it("collapses anything that is not exactly `active` to inactive", () => {
    // ⚠ THE SAME COLLAPSE THE ADAPTER AND THE FILE ALREADY PERFORM.
    // `xlsx-export.ts` prints `product.status === "active" ? "active" :
    // "inactive"` into the Status column. If this filter classified null or an
    // unknown string differently, the file would carry rows whose Status cell
    // contradicts the filter that let them in.
    expect(matchesStatusFilter(null, "inactive")).toBe(true);
    expect(matchesStatusFilter(undefined, "inactive")).toBe(true);
    expect(matchesStatusFilter("something-new", "inactive")).toBe(true);
    expect(matchesStatusFilter(null, "active")).toBe(false);
  });
});

describe("countByStatus", () => {
  it("all = active + inactive, with unknowns counted as inactive", () => {
    const counts = countByStatus([
      item("active"),
      item("active"),
      item("inactive"),
      item(null),
    ]);
    expect(counts).toEqual({ all: 4, active: 2, inactive: 2 });
    expect(counts.active + counts.inactive).toBe(counts.all);
  });

  it("an empty list is all zeros, not a crash", () => {
    expect(countByStatus([])).toEqual({ all: 0, active: 0, inactive: 0 });
  });
});

describe("partitionByStatusFilter — nothing is dropped without being counted", () => {
  it("included + skipped always equals the input length", () => {
    const items = [item("active"), item("inactive"), item("inactive")];
    for (const f of ["all", "active", "inactive"] as const) {
      const { included, skipped } = partitionByStatusFilter(items, f);
      expect(included.length + skipped, f).toBe(items.length);
    }
  });

  it("`all` skips nothing — the pre-X2 behaviour, exactly", () => {
    const items = [item("active"), item("inactive")];
    const { included, skipped } = partitionByStatusFilter(items, "all");
    expect(included).toEqual(items);
    expect(skipped).toBe(0);
  });

  it("counts what it removed, rather than removing it silently", () => {
    const items = [item("active"), item("inactive"), item("inactive")];
    expect(partitionByStatusFilter(items, "active")).toEqual({
      included: [items[0]],
      skipped: 2,
    });
  });
});

describe("⚠ the label owes the operator the INACTIVE_PUBLISHED disclosure", () => {
  it("STATUS_FILTER_NOTE names both Google states the tool folds into `Active`", () => {
    // ⚠ THE MUTATION THIS EXISTS FOR: someone tidies the note down to
    // "Active items only". The control keeps working and starts lying —
    // `mapStateToStatus` (onetime-product-adapter.ts:117-122) folds Google's
    // INACTIVE_PUBLISHED into the tool's "active", and an operator reading a
    // bare "Active" has no way to know that.
    expect(STATUS_FILTER_NOTE).toContain("INACTIVE_PUBLISHED");
    expect(STATUS_FILTER_NOTE).toContain("ACTIVE");
    expect(STATUS_FILTER_NOTE).toContain("Active");
  });

  it("⚠ the note matches what the adapter actually does — read, not remembered", () => {
    // Guards the note against the code drifting away from it. If the adapter
    // ever stops folding INACTIVE_PUBLISHED, this note becomes a false claim,
    // and a false disclosure is worse than none.
    const adapter = readFileSync(
      join(__dirname, "google", "onetime-product-adapter.ts"),
      "utf8",
    );
    expect(adapter).toContain(
      'if (state === "ACTIVE" || state === "INACTIVE_PUBLISHED") return "active";',
    );
  });
});

describe("isExportStatusFilter", () => {
  it("accepts the three modes and nothing else", () => {
    expect(isExportStatusFilter("all")).toBe(true);
    expect(isExportStatusFilter("active")).toBe(true);
    expect(isExportStatusFilter("inactive")).toBe(true);
    expect(isExportStatusFilter("ACTIVE")).toBe(false);
    expect(isExportStatusFilter("")).toBe(false);
    expect(isExportStatusFilter(null)).toBe(false);
    expect(isExportStatusFilter(undefined)).toBe(false);
    expect(isExportStatusFilter(["active"])).toBe(false);
  });
});

describe("⚠ exportSummaryLine — the mirror/live divergence is stated, not left to be noticed", () => {
  it("no filter, counts agree: just the row count", () => {
    expect(
      exportSummaryLine({ exported: 12, skipped: 0, filter: "all", expectedFromMirror: null }),
    ).toBe("Exported 12 items.");
  });

  it("a filter that skipped rows says how many", () => {
    expect(
      exportSummaryLine({ exported: 8, skipped: 3, filter: "active", expectedFromMirror: 8 }),
    ).toBe('Exported 8 items. 3 items skipped by the "active" filter.');
  });

  it('⚠ when live disagrees with the screen, it SAYS SO and names both numbers', () => {
    // THE X2.4 CASE. An item flipped on Play Console since the last Refresh:
    // the dialog counted 9 from the mirror, Google actually had 8. Publishing
    // only "Exported 8" would leave the operator holding a file one row short
    // of the number they had just read, with nothing explaining it.
    const line = exportSummaryLine({
      exported: 8,
      skipped: 4,
      filter: "active",
      expectedFromMirror: 9,
    });
    expect(line).toContain("Exported 8 items");
    expect(line).toContain("4 items skipped");
    expect(line).toContain("showed 9");
    expect(line).toContain("the file follows Google");
    expect(line).toContain("Refresh");
  });

  it("no divergence sentence when the two agree", () => {
    const line = exportSummaryLine({
      exported: 8,
      skipped: 1,
      filter: "inactive",
      expectedFromMirror: 8,
    });
    expect(line).not.toContain("showed");
    expect(line).not.toContain("follows Google");
  });

  it("singular/plural is not left ragged at 1", () => {
    expect(
      exportSummaryLine({ exported: 1, skipped: 1, filter: "active", expectedFromMirror: 1 }),
    ).toBe('Exported 1 item. 1 item skipped by the "active" filter.');
  });
});

describe("⚠ LOCK — changing the filter costs 0 Google requests", () => {
  it("this module makes no network call of any kind", () => {
    // The lock, enforced structurally rather than by intention. Every count
    // and every partition in the flow runs through this file; if it cannot
    // reach the network, no filter interaction can either.
    const src = readFileSync(join(__dirname, "export-status-filter.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/fetchWithTimeout/);
    expect(src).not.toMatch(/^import .*(client|publisher|google\/auth)/m);
    expect(src).not.toMatch(/\bawait\b/);
  });

  it("the shared selection list fetches nothing either", () => {
    // X3 — the picker renders through `IapSelectionList`, so the lock has to
    // cover it too. A component that looked up live counts per keystroke
    // would turn a free control into a request per character typed.
    const src = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "components",
        "google-iap-management",
        "iap-list",
        "IapSelectionList.tsx",
      ),
      "utf8",
    );
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/fetchWithTimeout/);
    expect(src).not.toMatch(/useEffect/);
  });

  it("the scope dialog fetches nothing either — counts come from its props", () => {
    // ⚠ THE DIALOG IS WHERE A FETCH WOULD ACTUALLY GET ADDED: "just look up
    // the live count when they pick a filter" is a one-line change that turns
    // a free control into a per-click request. Asserted here so that line
    // cannot be written without a test going red.
    const dlg = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "components",
        "google-iap-management",
        "iap-list",
        "ExportScopeDialog.tsx",
      ),
      "utf8",
    );
    expect(dlg).not.toMatch(/\bfetch\s*\(/);
    expect(dlg).not.toMatch(/fetchWithTimeout/);
    expect(dlg).not.toMatch(/useEffect/);
  });
});

describe("⚠ structural — ONE item-selection surface in the export flow", () => {
  const listDir = join(
    __dirname,
    "..",
    "..",
    "components",
    "google-iap-management",
    "iap-list",
  );

  it("the export flow's picker is `IapSelectionList`, used from the scope dialog", () => {
    // ⚠ THE MUTATION THIS EXISTS FOR: building a second picker — a new dialog,
    // or a checkbox column on the main table — instead of using the step the
    // scope dialog already owns. Two selection surfaces means two "select all"
    // scopes for one behaviour, which is the P1 twin-path this arc keeps
    // refusing. `BulkStatusModal` and `ExportScopeDialog` are the only two
    // callers, and both go through the shared component.
    const dlg = readFileSync(join(listDir, "ExportScopeDialog.tsx"), "utf8");
    expect(dlg).toMatch(/import \{ IapSelectionList \} from "\.\/IapSelectionList";/);
    expect(dlg).toMatch(/<IapSelectionList/);
  });

  it("nothing in the module hand-rolls a second checkbox list", () => {
    // A row-level `type="checkbox"` outside the shared component is the
    // fingerprint of a second surface being grown.
    const offenders: string[] = [];
    for (const f of readdirSync(listDir)) {
      if (!/\.tsx$/.test(f) || /\.test\.tsx$/.test(f)) continue;
      if (f === "IapSelectionList.tsx") continue;
      if (/type="checkbox"/.test(readFileSync(join(listDir, f), "utf8"))) {
        offenders.push(f);
      }
    }
    expect(offenders, `hand-rolled checkbox lists: ${offenders.join(", ")}`).toEqual([]);
  });

  it("`BulkStatusModal` renders through it too — the T1 extraction, pinned", () => {
    // If someone re-inlines the list into the modal, the export picker and the
    // modal start drifting again and the parity gate that justified this
    // refactor stops meaning anything.
    const modal = readFileSync(join(listDir, "BulkStatusModal.tsx"), "utf8");
    expect(modal).toMatch(/<IapSelectionList/);
  });
});
