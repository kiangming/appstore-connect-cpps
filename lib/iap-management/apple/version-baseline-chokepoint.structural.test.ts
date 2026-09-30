/**
 * ⚠⚠ "WHICH VERSION IS THE BASELINE" IS DECIDED IN EXACTLY ONE FILE.
 * Arc `[BULKIMPORT-loc-compare-apple]`, guard for C1.
 *
 * ⚠ WHY THIS GUARD EXISTS AT ALL. Two surfaces now ask the same question — the
 * Bulk Import PREVIEW (which cells start ticked) and the WRITE
 * (`syncLocalizationsToVersion`). If they ever answer it differently, the
 * preview shows the Manager one thing and Apple receives another, and the
 * divergence is invisible until somebody compares a screenshot with a live
 * product. That is strictly worse than having no preview.
 *
 * ⚠ WHY STRUCTURAL. "How many places compute this" is a property of the repo.
 * A behavioural test cannot see a second reader — it would simply never be
 * exercised, which is exactly how it would survive. Same reasoning as
 * `version-create-chokepoint.structural.test.ts`.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST, so prose naming these symbols does not read
 * as a call to them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

function callersOf(symbol: string): string[] {
  const hits: string[] = [];
  const decl = new RegExp(`export async function ${symbol}\\(`);
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

describe("the IAP version listing has one baseline reader", () => {
  it("⚠⚠ listInAppPurchaseVersions is called from exactly two known places", () => {
    // `version-baseline.ts` — the shared reader both surfaces go through.
    // `submit-v2.ts`        — the submit flow, which asks a DIFFERENT question
    //                         of the same list (submittable ≠ writable, KB
    //                         §32.10) and predates this arc. Listing it is what
    //                         makes "exactly one baseline reader" checkable.
    expect(callersOf("listInAppPurchaseVersions")).toEqual([
      "lib/iap-management/apple/submit-v2.ts",
      "lib/iap-management/apple/version-baseline.ts",
    ]);
  });

  it("⚠⚠ the APPROVED/DRAFT state sets exist in exactly one file", () => {
    // A second copy is a second definition of "what customers see". They would
    // agree on the day they were written and drift silently afterwards.
    const owners: string[] = [];
    for (const dir of ["lib", "app", "components"]) {
      for (const file of walk(join(ROOT, dir))) {
        const code = stripComments(readFileSync(file, "utf8"));
        if (/APPROVED_STATES|PREPARE_FOR_SUBMISSION"\s*;?\s*$/m.test(code) &&
            /APPROVED_STATES/.test(code)) {
          owners.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(owners).toEqual(["lib/iap-management/apple/version-baseline.ts"]);
  });

  it("⭐ the write path reads its baseline THROUGH the shared reader", () => {
    // Not "does it produce the same answer" — does it ask the same function.
    const src = stripComments(
      readFileSync(join(__dirname, "localization-version-sync.ts"), "utf8"),
    );
    expect(src).toMatch(/\breadVersionBaseline\s*\(/);
    // ...and does not re-derive the baseline from a raw version list.
    expect(src).not.toMatch(/\blistInAppPurchaseVersions\s*\(/);
  });
});
