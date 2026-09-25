/**
 * ⚠⚠ `POST /v1/inAppPurchaseVersions` MAY BE CALLED FROM EXACTLY ONE PLACE.
 * Arc `[LOC-V2-model]`, guard ⑥.
 *
 * ⚠ WHY THIS IS THE HARSHEST GUARD IN THE ARC. `inAppPurchaseVersions` has
 * **no DELETE** — verified three ways (8 paths in OAS 4.4.1, no
 * `_deleteInstance` operation, against a control group of 13 DELETEs on sibling
 * `*Version*` resources). Every call to this function is therefore a permanent,
 * irreversible artifact on a product that may be selling right now. A second
 * call site is a second place that can create one without the
 * reuse-a-draft-first check, and nothing downstream could tell the difference.
 *
 * ⚠ WHY STRUCTURAL. "How many places in the repo can do X" is a property of the
 * repo, not of any single run. No behavioural test can observe it — the second
 * call site would simply never be exercised by the suite, which is exactly how
 * it would survive. Same reasoning as `retry-composition.structural.test.ts`,
 * which is itself the guard that caught two brand-new call sites in this arc.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST. A docstring explaining why creation is
 * dangerous must not read as a call to create.
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

/** Non-test source files that CALL `createInAppPurchaseVersion(`. */
function callers(): string[] {
  const hits: string[] = [];
  for (const dir of ["lib", "app", "components"]) {
    for (const file of walk(join(ROOT, dir))) {
      const code = stripComments(readFileSync(file, "utf8"));
      // The declaration itself is not a call site.
      if (/export async function createInAppPurchaseVersion\(/.test(code)) continue;
      if (/\bcreateInAppPurchaseVersion\s*\(/.test(code)) {
        hits.push(file.slice(ROOT.length + 1));
      }
    }
  }
  return hits.sort();
}

describe("creating an IAP version is a single choke point", () => {
  it("⚠⚠ exactly two call sites, and both are known", () => {
    // `localization-version-sync.ts` — this arc's path, which reuses a draft
    //   first and only creates when there is none (O1).
    // `submit-v2.ts` — the pre-existing submit flow's defensive fallback,
    //   which does the same reuse-first check for its own purpose. It predates
    //   this arc and is deliberately left alone; listing it here is what makes
    //   "exactly one NEW place" checkable.
    expect(callers()).toEqual([
      "lib/iap-management/apple/localization-version-sync.ts",
      "lib/iap-management/apple/submit-v2.ts",
    ]);
  });

  it("⚠⚠ the localization path creates ONLY through resolveWriteTargetVersion", () => {
    // Which is where the reuse-a-draft-first check lives. A direct call that
    // bypassed it would POST on an item that already had somewhere to write.
    const src = stripComments(
      readFileSync(join(__dirname, "localization-version-sync.ts"), "utf8"),
    );
    const createCalls = src.match(/\bcreateInAppPurchaseVersion\s*\(/g) ?? [];
    expect(createCalls).toHaveLength(1);
    // And that one call sits inside the deps handed to the resolver.
    const at = src.indexOf("resolveWriteTargetVersion(");
    const createAt = src.indexOf("createInAppPurchaseVersion(");
    expect(at).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(at);
  });

  it("⚠ neither bulk import nor the form creates a version directly", () => {
    for (const rel of [
      "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
      "lib/iap-management/apple/update-orchestration.ts",
    ]) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(src, `${rel} must not create versions directly`).not.toMatch(
        /\bcreateInAppPurchaseVersion\s*\(/,
      );
    }
  });

  it("⚠⚠ both surfaces write localizations through the ONE shared sync", () => {
    // The twin-path property, checked rather than promised. If either call site
    // grows its own client calls back, they have drifted.
    for (const rel of [
      "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
      "lib/iap-management/apple/update-orchestration.ts",
    ]) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(src, `${rel} must call the shared sync`).toContain(
        "syncLocalizationsToVersion(",
      );
      for (const v1 of [
        "updateInAppPurchaseLocalization(",
        "deleteInAppPurchaseLocalization(",
        "listInAppPurchaseLocalizations(",
      ]) {
        expect(src, `${rel} must not use the V1 localization client (${v1})`).not.toContain(v1);
      }
    }
  });

  it("⚠ the V1 model's planner and state module are GONE, not merely unused", () => {
    // Two models alive over one resource is what let the original bug survive.
    // Deleting is the only way the old one cannot come back by import.
    const all = ["lib", "app", "components"].flatMap((d) => walk(join(ROOT, d)));
    const stale = all.filter((f) =>
      /localization-sync\.ts$|apple\/localization-state\.ts$/.test(f),
    );
    expect(stale).toEqual([]);
  });
});
