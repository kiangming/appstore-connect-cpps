/**
 * Chunk 1 — the STRUCTURAL fences. Three separate promises live here, and
 * none of them can be kept by a behavioural test alone.
 *
 * ⚠ WHY STRUCTURAL AND NOT BEHAVIOURAL, stated per fence rather than assumed:
 *
 *   §2.1 (the range is computed over the RENDERED array) — the mutation is
 *     swapping `visibleSkus` for `matchingSkus` at the call site. No click can
 *     catch it: a real gesture always targets a row that IS rendered, so both
 *     arrays return the same slice for every reachable input. The pure helper's
 *     unit test covers the refusal (`target not rendered ⇒ null`); only a
 *     source-level assertion covers which array the component hands it.
 *
 *   §2.4 (list order is stable) — a `.sort()` added anywhere upstream would
 *     silently redefine what "a range" means, and would still pass every
 *     range test, because the tests build their own fixtures in order.
 *
 *   §2.5 (zero Google requests) — a fetch added to the range path is invisible
 *     to a jsdom test that never asserts on the network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

const PICKER = ["components", "google-iap-management", "iap-list", "IapSelectionList.tsx"];
const DIALOG = ["components", "google-iap-management", "iap-list", "ExportScopeDialog.tsx"];
const LIST = ["components", "google-iap-management", "iap-list", "IapListClient.tsx"];
const HELPER = ["lib", "google-iap-management", "item-range-select.ts"];
const REPO_IAPS = ["lib", "google-iap-management", "repository", "iaps.ts"];

describe("⚠ §2.1 — the range is resolved over the RENDERED rows, structurally", () => {
  const src = read(...PICKER);

  it("⭐ `resolveRangeSkus` is called with `visibleSkus`", () => {
    // Swapping this for `matchingSkus` or a map over `items` is the one edit
    // that would let a range tick rows nobody looked at.
    expect(src).toMatch(/resolveRangeSkus\(\s*visibleSkus\s*,/);
  });

  it("⭐ it is NEVER called with the matching set or the raw items", () => {
    expect(src).not.toMatch(/resolveRangeSkus\(\s*matchingSkus/);
    expect(src).not.toMatch(/resolveRangeSkus\(\s*items/);
    expect(src).not.toMatch(/resolveRangeSkus\(\s*matching\b/);
  });

  it("`visibleSkus` is derived from `visible`, which is the sliced array", () => {
    // If `visibleSkus` were re-pointed at `matching`, assertion 1 would still
    // pass while the guarantee was gone.
    expect(src).toMatch(/const visibleSkus = visible\.map\(/);
    expect(src).toMatch(/const visible =[\s\S]{0,120}?matching\.slice\(0, windowSize\)/);
  });

  it("there is exactly ONE call site — a second one is a second scope to audit", () => {
    expect(src.match(/resolveRangeSkus\(/g) ?? []).toHaveLength(1);
  });
});

describe("⚠ §2.4 — list order is stable end to end; a future `.sort()` goes red", () => {
  it("⭐ the repository imposes a total order on a UNIQUE column", () => {
    // `sku` is UNIQUE per app, so this order has no ties to break —
    // which is what makes "the range between two rows" well defined.
    expect(read(...REPO_IAPS)).toMatch(/\.order\("sku", \{ ascending: true \}\)/);
  });

  it("⭐ no hop in the picker chain sorts", () => {
    for (const f of [PICKER, DIALOG, LIST, REPO_IAPS]) {
      const src = read(...f);
      expect(src, `${f.join("/")} must not sort`).not.toMatch(/\.sort\(/);
    }
  });

  it("the narrowing hops are order-preserving `.filter()` / `.slice()`", () => {
    expect(read(...PICKER)).toMatch(/items\.filter\(\(i\) => matches\(i, query!\)\)/);
    expect(read(...DIALOG)).toMatch(/items\.filter\(\(i\) => matchesStatusFilter\(/);
    expect(read(...LIST)).toMatch(/iaps\.filter\(\(i\) => !i\.deleted_on_google_at\)/);
  });
});

describe("⚠ §2.5 — opening the picker and changing the selection cost 0 requests", () => {
  it("⭐ the range helper is pure — no network, no React, no clock", () => {
    const src = read(...HELPER);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/fetchWithTimeout/);
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/useEffect|useState/);
    expect(src).not.toMatch(/^import /m);
  });

  it("⭐ the picker still cannot reach the network, and still has no effects", () => {
    // The existing lock in `export-status-filter.test.ts` says the same for
    // the pre-chunk-1 file; repeated here because chunk 1 is what added state
    // to this component, and `useState` is the doorway `useEffect` follows.
    const src = read(...PICKER);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/fetchWithTimeout/);
    expect(src).not.toMatch(/useEffect/);
  });
});

describe("⚠ C2 — the write path's props are absent at ITS call site", () => {
  it("⭐ `BulkStatusModal` passes neither `rangeSelect` nor `onSelectionChange`", () => {
    // The behavioural default-off test lives in the picker's own suite; this
    // is the other half — proof the shipped write path never opts in, which a
    // default flip alone would not reveal.
    const src = read(
      "components",
      "google-iap-management",
      "iap-list",
      "BulkStatusModal.tsx",
    );
    expect(src).not.toMatch(/rangeSelect/);
    expect(src).not.toMatch(/onSelectionChange/);
  });

  it("the export dialog DOES opt in — so the flag is not dead code", () => {
    expect(read(...DIALOG)).toMatch(/rangeSelect/);
    expect(read(...DIALOG)).toMatch(/onSelectionChange=\{onSelectionChange\}/);
  });
});
