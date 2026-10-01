/**
 * ⚠⚠ THE TICK/UNTICK VERDICT HAS ONE SOURCE, AND IT IS THE PLANNER.
 * Arc `[BULKIMPORT-loc-compare-apple]`, guard for C2.
 *
 * ⚠ WHY. The preview's default and the write's behaviour must be the same
 * decision, not two implementations that agree today. A second comparison on
 * the client would pass every test on the day it was written and drift
 * afterwards — and the drift is only observable by holding a screenshot next to
 * a live product, which is to say: never.
 *
 * ⚠ THE LINE THIS GUARD DRAWS — and it is deliberately not "no comparing in
 * the UI":
 *
 *   `localizationContentEquals`  — the PAIR-level verdict ("is this cell
 *                                  identical to Apple?"). ⛔ UI must not.
 *   `localizationTextEquals`     — one FIELD ("is the name the same?"). ✅ UI
 *                                  may, to highlight which field changed. It
 *                                  is presentation over a verdict already made.
 *
 * ⚠ THIS GUARD IS PARTLY FORWARD-LOOKING. At C2 the wizard does not yet import
 * any of this; it becomes load-bearing at C4, when the step starts rendering
 * defaults. The non-vacuous half — that `planLocalizationWrites` has exactly
 * two callers — holds today and is asserted below, so a rename cannot make the
 * whole file pass by matching nothing.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const ROOT = join(__dirname, "..", "..", "..");
const WIZARD_DIR = join(
  ROOT,
  "app",
  "(dashboard)",
  "iap-management",
  "apps",
  "[appId]",
  "bulk-import",
);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

function callersOf(symbol: string): string[] {
  const hits: string[] = [];
  const decl = new RegExp(`export function ${symbol}\\(`);
  const call = new RegExp(`\\b${symbol}\\s*\\(`);
  for (const dir of ["lib", "app", "components"]) {
    for (const file of walk(join(ROOT, dir))) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (decl.test(code)) continue;
      if (call.test(code)) hits.push(file.slice(ROOT.length + 1));
    }
  }
  return hits.sort();
}

describe("the localization verdict has a single source", () => {
  it("⚠⚠ planLocalizationWrites has exactly two callers: the write path and the cell mapper", () => {
    // Non-vacuous today. The preview does NOT get its own comparison — it goes
    // through `buildCellDefaults`, which calls the same planner the write does.
    expect(callersOf("planLocalizationWrites")).toEqual([
      "lib/iap-management/apple/localization-version-sync.ts",
      "lib/iap-management/bulk-import/localization-cell-default.ts",
    ]);
  });

  it("⛔ no Bulk Import wizard file forms a PAIR-level verdict of its own", () => {
    for (const file of walk(WIZARD_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = file.slice(ROOT.length + 1);
      expect(code, `${rel} must not compare cells itself`).not.toMatch(
        /\blocalizationContentEquals\b/,
      );
      expect(code, `${rel} must not re-run the planner`).not.toMatch(
        /\bplanLocalizationWrites\s*\(/,
      );
    }
  });

  it("✅ field-level comparison stays permitted — it is presentation, not a verdict", () => {
    // Stated as a rule so a later 'tighten the guard' pass does not ban the
    // thing that makes "which field changed" renderable, and quietly cost the
    // Manager the most useful part of the cell.
    const mapper = stripComments(
      readFileSync(join(__dirname, "localization-cell-default.ts"), "utf8"),
    );
    expect(mapper).toMatch(/\blocalizationTextEquals\b/);
    expect(mapper).not.toMatch(/\blocalizationContentEquals\b/);
  });

  it("⛔⛔ no wizard file RENDERS an `ACTIVE` pill — it would never fire", () => {
    // ⚠ WHY A GUARD FOR SOMETHING THAT WAS NEVER SHIPPED. The mockup drew this
    // pill and the design doc specified it, so it is the single most likely
    // thing for a later pass to "finish". Under the real model a localization
    // has NO state — the lifecycle belongs to the VERSION — and `ACTIVE`
    // appears only in Apple's WRITE-path error text, never on a read. A pill
    // driven by it renders for nobody, ever: no crash, no warning, no feature,
    // and no way to notice (KB §29.4). The honest fact is "this item is
    // selling", which is what `liveItems` carries.
    //
    // ⚠ Prose is exempt — comments are stripped first — because the history of
    // the 409 is worth keeping written down.
    for (const file of walk(WIZARD_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, `${file.slice(ROOT.length + 1)} must not render an ACTIVE pill`)
        .not.toMatch(/\bACTIVE\b/);
    }
  });

  it("⭐ the guard is no longer half-empty — the step DOES consume the verdict", () => {
    // At C2 the "no wizard file compares" half matched nothing, because the
    // wizard imported none of this. Asserting the consumption exists is what
    // stops that half from passing vacuously forever.
    const step = stripComments(
      readFileSync(join(WIZARD_DIR, "LocalizationStep.tsx"), "utf8"),
    );
    expect(step).toMatch(/cellDefaults/);
    expect(step).toMatch(/verdict\.label/);
  });

  it("⚠ the three SkipReason members stay three — 'unreadable' is a different axis", () => {
    const plan = stripComments(
      readFileSync(join(__dirname, "localization-version-plan.ts"), "utf8"),
    );
    const union = plan.slice(
      plan.indexOf("export type SkipReason"),
      plan.indexOf("export const SKIP_LABELS"),
    );
    const members = union.match(/"[A-Z_]+"/g) ?? [];
    expect(members.sort()).toEqual([
      '"ALREADY_IN_DRAFT"',
      '"IDENTICAL_TO_LIVE"',
      '"LIVE_MATCHES_BUT_DRAFT_DIFFERS"',
    ]);
    expect(union).not.toMatch(/UNREADABLE|UNKNOWN|NEW_ITEM/);
  });
});
