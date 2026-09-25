/**
 * Arc `[LOC-V2-model]` — **the bounded-write contract for the one route in
 * this arc that writes.**
 *
 * ⚠⚠ WHY THIS FILE EXISTS. Its sibling `loc-v2-snapshot` is held to ZERO
 * writes by `zero-write.structural.test.ts`. That test cannot apply here — this
 * route's whole purpose is to write. The wrong conclusion would be "so it has
 * no structural guard"; the right one is that the guard gets NARROWER, not
 * absent:
 *
 *   exactly one write function · called exactly once · one localization id ·
 *   no loop, no batch · and unreachable when step 2 found no target.
 *
 * The Manager agreed to ONE write against a LIVE, SELLING product. One is the
 * contract, and this file is the part that can fail.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST — a prose explanation naming a write function
 * must not read as a call. The tokenizer is the hardened one from
 * `retype-composition`-style structural tests; see `zero-write.structural.test.ts`
 * for why a local copy is the standing convention here rather than an import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

const routeSrc = stripComments(readFileSync(join(__dirname, "route.ts"), "utf8"));
const clientSrc = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "..", "lib", "iap-management", "apple", "client.ts"),
  "utf8",
);

function clientImports(): string[] {
  const m = routeSrc.match(
    /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/iap-management\/apple\/client"/,
  );
  if (!m) throw new Error("the route must import from the Apple client by that exact path");
  return m[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function clientFunctionBody(name: string): string {
  const at = clientSrc.indexOf(`export async function ${name}(`);
  expect(at, `client.ts must export ${name}`).toBeGreaterThan(-1);
  const next = clientSrc.indexOf("\nexport ", at + 1);
  return clientSrc.slice(at, next === -1 ? clientSrc.length : next);
}

/** Occurrences of `name(` in the route, declarations excluded. */
function callCount(name: string): number {
  return [...routeSrc.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))].length;
}

describe("loc-v2-write-probe makes exactly ONE write", () => {
  it("⚠⚠ exactly one imported client function issues a write verb", () => {
    // Rooted in client.ts's ACTUAL verbs, not in naming convention — a guard
    // built on "functions called update* are writes" passes the day a write
    // hides inside something called listX.
    const writers = clientImports().filter((name) => {
      const body = clientFunctionBody(name);
      return ['"POST"', '"PATCH"', '"DELETE"', '"PUT"'].some((v) => body.includes(v));
    });
    expect(writers).toEqual(["updateInAppPurchaseLocalizationV2"]);
  });

  it("⚠⚠ that write function is called EXACTLY ONCE in the route", () => {
    expect(callCount("updateInAppPurchaseLocalizationV2")).toBe(1);
  });

  it("⚠ the write targets ONE localization id — no list, no loop around it", () => {
    // The call must take the single derived target, never an array or an
    // index. `target.localizationId` is that single value.
    expect(routeSrc).toContain("target.localizationId");
    // No `products=` style multi-input exists on this route at all.
    expect(routeSrc).not.toContain('searchParams.get("products")');
    expect(routeSrc).toContain('searchParams.get("product")');
  });

  it("⚠⚠ the write is unreachable when step 2 refuses — the refusal RETURNS", () => {
    // The ordering claim, checked positionally: the abort path must return
    // before the write statement appears in the source.
    const abortAt = routeSrc.indexOf("aborted: choice.reason");
    const writeAt = routeSrc.indexOf("updateInAppPurchaseLocalizationV2(");
    expect(abortAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(abortAt).toBeLessThan(writeAt);
    expect(routeSrc).toMatch(/if\s*\(!choice\.ok\)/);
  });

  it("⚠ the target is DERIVED, never hard-coded", () => {
    // KB §31.14: the parameter of a measurement comes from the data. A literal
    // locale or localization id in this file is the failure being prevented.
    expect(routeSrc).toContain("chooseWriteTarget(before, expect)");
    expect(routeSrc).not.toMatch(/["']en-US["']/);
    expect(routeSrc).not.toMatch(/fc859670/);
    expect(routeSrc).not.toMatch(/["']vi["']/);
  });

  it("⚠ an explicit confirmation is required before anything is sent", () => {
    expect(routeSrc).toContain('confirm !== "WRITE"');
    const confirmAt = routeSrc.indexOf('confirm !== "WRITE"');
    expect(confirmAt).toBeLessThan(routeSrc.indexOf("updateInAppPurchaseLocalizationV2("));
  });

  it("⚠⚠ step 4 diffs CONTENT, not just version count", () => {
    // The hole that was already found once (KB §31.14): comparing version
    // count and locale list alone makes branch 4 invisible, and branch 4 is
    // the reason this item was chosen.
    expect(routeSrc).toContain("readWriteProbeResult(before, after, target, httpOk)");
    expect(routeSrc).toContain("content_changes: reading.contentChanges");
  });

  it("⚠ both snapshots come from the SAME reader — before and after are comparable", () => {
    expect(callCount("takeSnapshot")).toBe(3); // 1 declaration + 2 calls
  });

  it("⚠ Apple's verbatim body is preserved, never summarised away", () => {
    expect(routeSrc).toContain("body = err.body");
    expect(routeSrc).toContain("body }");
  });
});
