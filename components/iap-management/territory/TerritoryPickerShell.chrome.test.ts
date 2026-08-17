/**
 * STRUCTURAL — the territory picker chrome exists in exactly one place.
 *
 * Two dialogs pick over Apple's ~175 territories, and on the Edit form their
 * buttons sit side by side. That adjacency is the P1 twin-path shape: build
 * the second toolbar by hand and the two drift, silently, in whichever
 * direction the next fix goes. So the search box + continent chip row + scroll
 * frame live in `TerritoryPickerShell.tsx` and this scan asserts nothing else
 * grows a copy.
 *
 * A behavioural test cannot catch this. A hand-rolled second toolbar would
 * pass every behavioural test it was given — it just would not be the same
 * toolbar. Only a source scan sees a duplicate appear.
 *
 * ⚠ SELF-CHECKS ARE NOT OPTIONAL. A scan that silently walks zero files, or
 * whose regex has stopped matching, passes forever and proves nothing. The
 * first `describe` fails if the walk is broken, if the choke point itself
 * stops matching, or if an allow-list entry has gone stale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

const SCAN_ROOTS = ["components/iap-management", "app/(dashboard)/iap-management"];

/** The one file allowed to render territory-picker chrome. */
const CHOKE_POINT = "components/iap-management/territory/TerritoryPickerShell.tsx";

/**
 * A DIFFERENT control, deliberately exempt — not an oversight.
 *
 * `MatrixFilterBar` renders continent chips over the pricing-template matrix:
 * a MULTI-select `Set<Continent>` used to show/hide matrix columns. It has no
 * territory search, no scroll frame, no select-all-shown, and no row renderer
 * — none of the chrome this shell owns, and nothing a territory picker would
 * reuse. Folding it into the shell would mean generalising the shell to a
 * second, unrelated shape.
 *
 * The self-check below asserts this file still exists AND still matches, so
 * the exemption cannot outlive the thing it exempts.
 */
const KNOWN_DIFFERENT_CONTROL = "components/iap-management/pricing-templates/MatrixFilterBar.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * P15 — strip comments before matching. This file's own prose names the
 * markers, and the shell's header quotes them; without stripping, a doc
 * comment anywhere could satisfy or trip the scan and the result would be
 * about English, not code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * ⚠ Built fresh per call, never module-level constants. A `/g` regex reused
 * across `.test()` calls carries `lastIndex` between files and starts
 * returning false — which makes the guard pass vacuously. That exact failure
 * was hit in SC1.
 */
const hasContinentChipRow = (src: string) =>
  /APPLE_CONTINENTS[\s\S]{0,80}?\.map\(/.test(src);
const hasTerritorySearchBox = (src: string) =>
  /aria-label="Search territories"/.test(src);

function sourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => {
    const abs = join(REPO_ROOT, root);
    try {
      return walk(abs);
    } catch {
      return [];
    }
  });
}

const read = (abs: string) => stripComments(readFileSync(abs, "utf8"));
const rel = (abs: string) => relative(REPO_ROOT, abs);

describe("SELF-CHECK — the scan is actually looking at something", () => {
  const files = sourceFiles();

  it("walks a real tree", () => {
    // A broken walk() would report zero violations forever.
    expect(files.length).toBeGreaterThan(40);
  });

  it("the choke point is in the scanned set and matches BOTH markers", () => {
    const abs = join(REPO_ROOT, CHOKE_POINT);
    expect(files.map(rel)).toContain(CHOKE_POINT);
    const src = read(abs);
    // If the shell stops matching, the markers have drifted from the code and
    // every "no violations" result below is meaningless.
    expect(hasContinentChipRow(src)).toBe(true);
    expect(hasTerritorySearchBox(src)).toBe(true);
  });

  it("the exempted control still exists and still matches — no stale exemption", () => {
    const abs = join(REPO_ROOT, KNOWN_DIFFERENT_CONTROL);
    expect(files.map(rel)).toContain(KNOWN_DIFFERENT_CONTROL);
    expect(hasContinentChipRow(read(abs))).toBe(true);
  });

  it("comment stripping works, so prose cannot satisfy the scan", () => {
    expect(hasTerritorySearchBox('// aria-label="Search territories"')).toBe(true);
    expect(stripComments('// aria-label="Search territories"').trim()).toBe("");
    expect(hasTerritorySearchBox(stripComments('/* aria-label="Search territories" */'))).toBe(
      false,
    );
  });
});

describe("one shared chrome — no second territory picker toolbar", () => {
  const files = sourceFiles();

  it("only the shell renders a territory search box", () => {
    const offenders = files
      .filter((abs) => hasTerritorySearchBox(read(abs)))
      .map(rel)
      .filter((p) => p !== CHOKE_POINT);

    expect(offenders).toEqual([]);
  });

  it("only the shell renders a continent chip row", () => {
    const offenders = files
      .filter((abs) => hasContinentChipRow(read(abs)))
      .map(rel)
      .filter((p) => p !== CHOKE_POINT && p !== KNOWN_DIFFERENT_CONTROL);

    expect(offenders).toEqual([]);
  });

  it("both pickers mount the shell rather than re-implementing it", () => {
    const consumers = [
      "components/iap-management/iap-form/CustomPricesDialog.tsx",
      "components/iap-management/territory/TerritoryAvailabilityPicker.tsx",
    ];
    for (const consumer of consumers) {
      const src = read(join(REPO_ROOT, consumer));
      expect(src).toContain("TerritoryPickerShell");
      // …and does not keep its own filter pipeline alongside it.
      expect(hasContinentChipRow(src)).toBe(false);
      expect(hasTerritorySearchBox(src)).toBe(false);
    }
  });

  it("the shell stays chrome-only — it must not learn prices or availability", () => {
    const src = read(join(REPO_ROOT, CHOKE_POINT));
    // Coupling the shell to either domain is how a shared component becomes
    // two components wearing one name.
    for (const forbidden of [
      "territory-selection",
      "TerritorySelection",
      "custom-prices",
      "BaselineRow",
      "TERRITORY_CATALOG",
      "iapFetch",
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
