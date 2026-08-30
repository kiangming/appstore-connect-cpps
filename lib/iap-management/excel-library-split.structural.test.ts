/**
 * E0.2 — TWO Excel libraries live in this repo on purpose. This test is the
 * fence that keeps them from becoming a mess.
 *
 * ─── WHY THERE ARE TWO ─────────────────────────────────────────────────────
 *
 * The Manager's export design requires AUTO-priced cells to be shaded yellow
 * (`[Q-EXPORT.source-marking]`) — colour, per cell, because that is the only
 * marking that stays true when one territory is manual on item A and automatic
 * on item B.
 *
 * `xlsx@0.18.5` (SheetJS Community Edition) CANNOT DO THAT, and this was proven
 * rather than read off a doc: writing `cell.s = { fill: { patternType:
 * "solid", fgColor: { rgb: "FFFF00" } } }` with `cellStyles: true` and
 * unzipping the result gives
 *
 *     xl/styles.xml  →  <patternFill patternType="none"/>
 *                       <patternFill patternType="gray125"/>
 *     "FFFF00"       →  nowhere in the archive
 *
 * i.e. the fill is discarded AT WRITE TIME. Cell styling is a paid (Pro)
 * feature; 0.18.5 is also the last npm release, so upgrading is not a route to
 * it. `exceljs` writes the same fill and it survives a round trip, at 352
 * columns, together with the freeze panes the design also needs.
 *
 * ─── THE ROLE SPLIT ────────────────────────────────────────────────────────
 *
 *   exceljs  →  WRITING the Apple IAP export, and nothing else.
 *   xlsx     →  everything already using it: the Google export writer, both
 *               upload PARSERS (reading Manager-supplied workbooks), and the
 *               Google export route.
 *
 * ⚠ WHY NOT MIGRATE EVERYTHING TO exceljs. The two parsers READ files a human
 * uploaded — arbitrary workbooks from Excel, Numbers, Google Sheets exports.
 * `xlsx` is the more forgiving reader and those paths have been through UAT
 * against real Manager files. Rewriting a working, unrelated read path to
 * satisfy a write-side colour requirement would risk the import flow to
 * decorate the export flow.
 *
 * ⚠ WHY NOT LEAVE THE APPLE EXPORT ON xlsx AND SKIP THE COLOUR. Considered and
 * rejected by the Manager: the alternative markings each fail somewhere. A
 * `Source` column costs +175 columns; a header suffix ("… — manual") LIES on a
 * mixed column, since a header describes the column and the truth is per cell.
 *
 * ─── WHAT THIS TEST ENFORCES ───────────────────────────────────────────────
 *
 * The failure mode a second Excel library invites is drift: someone needs a
 * feature, reaches for whichever import is nearest, and six months later both
 * libraries are half-used everywhere and nobody can say which writes what. The
 * assertions below are the fence:
 *
 *   1. No single file imports BOTH. That is the drift, in its smallest form.
 *   2. `exceljs` appears ONLY in the Apple export write path (allowlist).
 *   3. The Google module NEVER imports `exceljs` — its export keeps xlsx, so
 *      the two modules' files stay independent of each other's decisions.
 *   4. The upload parsers ALWAYS use `xlsx` — reading is not what exceljs was
 *      brought in for.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/**
 * The ONLY files permitted to import `exceljs`.
 *
 * ⚠ ADDING A LINE HERE IS A DESIGN DECISION, NOT A FIX. If a new file needs
 * exceljs, the question to answer first is why it is writing an Apple export
 * workbook from somewhere that is not the Apple export writer.
 */
const EXCELJS_ALLOWED = new Set<string>([
  "lib/iap-management/xlsx-export.ts",
  "app/api/iap-management/apps/[appId]/export/route.ts",
  // ── [TEMPLATE-xlsx] ────────────────────────────────────────────────────────
  // The question this list demands an answer to — "why is this writing an
  // Apple export workbook from somewhere that is not the Apple export
  // writer?" — has one here: it is a SECOND Apple export writer, for a
  // different surface.
  //
  // `xlsx-export.ts` exports ITEMS of one app, live from Apple. This one
  // exports the pricing-template MATRIX (Default + Per-App) that the "View
  // matrix" screens render from `iap_mgmt.price_tier_template_entries`.
  // Different data, different reader, different sheet shape; they share only
  // the fact that both must write things `xlsx@0.18.5` CE drops at write
  // time — here a font colour on cells that differ from the Default, freeze
  // panes across 351 columns, and cell notes.
  //
  // ⚠ NOT a shortcut past the fence: this is the ONLY module that writes that
  // surface's workbook, and it drives exceljs in exactly one function, the
  // same discipline `xlsx-export.ts` keeps.
  "lib/iap-management/xlsx-template-matrix-export.ts",
  // The route that serves the writer above. Present for the same reason the
  // item-list export route is: `writeBuffer()` has to run server-side because
  // exceljs is a server-only dependency (KB §4.17) — pulling it into the
  // browser bundle is the thing that decision was made to avoid.
  "app/api/iap-management/pricing-templates/matrix-export/route.ts",
]);

/** Files that legitimately use `xlsx` — the Google writer, both parsers, the
 *  Google route, and (until E3 moves it) the Apple writer + route. */
const XLSX_ALLOWED = new Set<string>([
  "lib/iap-management/xlsx-export.ts",
  "app/api/iap-management/apps/[appId]/export/route.ts",
  "lib/google-iap-management/xlsx-export.ts",
  "lib/google-iap-management/parsers/pricing-template-parser.ts",
  "lib/google-iap-management/parsers/excel-parser.ts",
  "app/api/google-iap-management/apps/[packageName]/export/route.ts",
]);

/** Parsers read Manager-uploaded workbooks. These must stay on xlsx. */
const PARSERS = [
  "lib/google-iap-management/parsers/pricing-template-parser.ts",
  "lib/google-iap-management/parsers/excel-parser.ts",
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "dist", "coverage", "docs"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (skip.has(entry)) continue;
      const rel = dir ? `${dir}/${entry}` : entry;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(rel);
    }
  };
  for (const top of ["app", "lib", "components", "scripts"]) {
    try {
      walk(top);
    } catch {
      /* optional dir */
    }
  }
  return out;
}

/** ⚠ Comments stripped first (P15/P28): every header in this area DISCUSSES
 *  both libraries by name, and a prose mention is not an import. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const importsPkg = (code: string, pkg: string): boolean =>
  new RegExp(`(?:from|require\\()\\s*["']${pkg}["']`).test(stripComments(code));

const FILES = sourceFiles().map((f) => ({
  path: f,
  code: readFileSync(join(ROOT, f), "utf8"),
}));

describe("⚠ MUTATION (g) — no file may import BOTH Excel libraries", () => {
  it("the two never meet in one file", () => {
    const both = FILES.filter(
      (f) => importsPkg(f.code, "xlsx") && importsPkg(f.code, "exceljs"),
    ).map((f) => f.path);
    // A file importing both is the drift in its smallest, most deniable form:
    // whichever import is nearest wins, and the split stops meaning anything.
    expect(both).toEqual([]);
  });
});

describe("exceljs is confined to the Apple export write path", () => {
  it("only allowlisted files import it", () => {
    const importers = FILES.filter((f) => importsPkg(f.code, "exceljs")).map(
      (f) => f.path,
    );
    const strays = importers.filter((p) => !EXCELJS_ALLOWED.has(p));
    expect(strays).toEqual([]);
  });

  it("⚠ the Google module never imports it", () => {
    // Google's export keeps xlsx. Stated separately from the allowlist so the
    // failure NAMES the module rather than reporting a generic stray path.
    const googleImporters = FILES.filter(
      (f) => f.path.includes("google-iap-management") && importsPkg(f.code, "exceljs"),
    ).map((f) => f.path);
    expect(googleImporters).toEqual([]);
  });
});

describe("xlsx keeps the paths it already owns", () => {
  it("only allowlisted files import it", () => {
    const importers = FILES.filter((f) => importsPkg(f.code, "xlsx")).map(
      (f) => f.path,
    );
    const strays = importers.filter((p) => !XLSX_ALLOWED.has(p));
    expect(strays).toEqual([]);
  });

  it("⚠ the upload parsers still read with xlsx", () => {
    // These read arbitrary Manager-supplied workbooks and have been through
    // UAT against real files. exceljs was added for WRITING colour, and must
    // not drift into a working read path.
    for (const parser of PARSERS) {
      const f = FILES.find((x) => x.path === parser);
      expect(f, `${parser} not found`).toBeDefined();
      expect(importsPkg(f!.code, "xlsx"), `${parser} must use xlsx`).toBe(true);
      expect(importsPkg(f!.code, "exceljs"), `${parser} must NOT use exceljs`).toBe(
        false,
      );
    }
  });
});

describe("the split is declared in package.json, not implied", () => {
  it("both libraries are direct dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // A transitive Excel library would mean nobody chose it.
    expect(pkg.dependencies.xlsx).toBeDefined();
    expect(pkg.dependencies.exceljs).toBeDefined();
  });
});
