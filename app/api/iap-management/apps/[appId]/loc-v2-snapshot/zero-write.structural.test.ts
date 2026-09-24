/**
 * Arc `[LOC-V2-model]` V0-snapshot — **the zero-write contract, enforced.**
 *
 * ⚠⚠ WHY THIS TEST IS THE POINT OF THE CHUNK, NOT A FORMALITY. The Manager
 * agreed to run this diagnostic against LIVE, SELLING products on the strength
 * of one promise: it reads and does not write. A promise in a docstring is a
 * sentence; this file is the part that can fail.
 *
 * ⚠ WHY STRUCTURAL. There is no harness that can observe "this route never
 * wrote to Apple" — proving it at runtime would mean running it against Apple,
 * which is the thing being made safe. Source is where the claim is visible.
 * Same reasoning as `batch-close-guard.structural.test.ts` and
 * `last-import-write.structural.test.ts`.
 *
 * ⚠⚠ AND WHY THE ALLOW-LIST IS ROOTED IN `client.ts`, NOT IN NAMES.
 * A test that says *"it may only import functions whose names start with
 * `list` or `get`"* is a guard built on a NAMING CONVENTION — it passes the day
 * someone adds a write to a function that is still called `listX`, which is
 * precisely the silent direction. So each imported client function is opened in
 * `client.ts` and its ACTUAL HTTP verb is read. The convention is not trusted;
 * the source is.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠⚠ COMMENTS ARE STRIPPED FIRST, AND THAT IS A CORRECTION, NOT A CONVENIENCE.
 * The first version of this file scanned raw source, so the moment the route
 * gained a comment explaining WHY it does not call `iapFetch` directly, the
 * test failed — reading an EXPLANATION as the thing it explains. The sibling
 * `retry-composition.structural.test.ts` documents this exact decoy class:
 * *"the file contains withRetry" is satisfied by a comment saying "no withRetry
 * here"*.
 *
 * ⚠ A NAIVE `//` STRIPPER WOULD BE WORSE THAN NONE. It eats the `//` inside
 * every `"https://…"` and silently shifts everything after it. This tokenizer
 * walks strings and template literals properly — it is copied verbatim from
 * `retry-composition.structural.test.ts`, which is where it was hardened.
 *
 * ⚠ WHY A COPY AND NOT AN IMPORT — this is deliberate, do not "fix" it.
 * Importing it from that test file made vitest execute that file's 33 tests as
 * a side effect of this one (6 → 39). And a local copy is the STANDING
 * CONVENTION here: eight structural tests in this repo each define their own
 * (`tier-order`, `rbac-posture`, `availabilities.write-path`,
 * `excel-library-split`, `bulk-import-availability`, `TerritoryPickerShell.chrome`,
 * `SettingsTabs`, `retry-composition`). ⚠ This does NOT contradict the
 * one-choke-point rule (CLAUDE.md P1): that rule is about PRODUCTION paths
 * where a missed copy fails SILENTLY by writing. A drifted copy here fails
 * LOUDLY — the test that owns it goes red — and hoisting test-only tooling into
 * `lib/` would put it on the production import graph.
 */
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

/** Identifiers the route imports from the Apple client module. */
function clientImports(): string[] {
  const m = routeSrc.match(
    /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/iap-management\/apple\/client"/,
  );
  if (!m) throw new Error("the route must import from the Apple client by that exact path");
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** The source of one exported client function, signature to next export. */
function clientFunctionBody(name: string): string {
  const at = clientSrc.indexOf(`export async function ${name}(`);
  expect(at, `client.ts must export ${name}`).toBeGreaterThan(-1);
  const next = clientSrc.indexOf("\nexport ", at + 1);
  return clientSrc.slice(at, next === -1 ? clientSrc.length : next);
}

describe("loc-v2-snapshot route is read-only", () => {
  it("⚠⚠ every Apple client function it imports issues GET and nothing else", () => {
    const imported = clientImports();
    expect(imported.length).toBeGreaterThan(0);
    for (const name of imported) {
      const body = clientFunctionBody(name);
      expect(body, `${name} must issue a GET`).toContain('"GET"');
      for (const verb of ['"POST"', '"PATCH"', '"DELETE"', '"PUT"']) {
        expect(body, `${name} must not issue ${verb}`).not.toContain(verb);
      }
    }
  });

  it("⚠ the route itself names no write verb", () => {
    // Catches a raw `iapFetch(creds, "POST", …)` added inline, bypassing the
    // client allow-list above.
    for (const verb of ['"POST"', '"PATCH"', '"DELETE"', '"PUT"']) {
      expect(routeSrc).not.toContain(verb);
    }
  });

  it("⚠ it exports a GET handler and no mutating handler", () => {
    expect(routeSrc).toContain("export async function GET(");
    for (const verb of ["POST", "PATCH", "DELETE", "PUT"]) {
      expect(routeSrc).not.toContain(`export async function ${verb}(`);
    }
  });

  it("⚠ it calls nothing whose name announces a mutation", () => {
    // A broad net over the OTHER way a write arrives: a helper from some module
    // that is not the Apple client at all (a Supabase upsert, an audit insert).
    const calls = [...routeSrc.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
      (m) => m[1],
    );
    const mutating = calls.filter((c) =>
      /^(create|update|delete|insert|upsert|patch|post|put|write|save|persist)[A-Z]/.test(c),
    );
    expect(mutating).toEqual([]);
  });

  it("⚠ it reaches Apple through the client module only — no bare fetch", () => {
    expect(routeSrc).not.toMatch(/\bfetch\s*\(/);
    expect(routeSrc).not.toContain("iapFetch");
  });

  it("⚠ the cap on products is announced, never a silent truncation", () => {
    // A diagnostic that quietly drops products would answer the Manager's
    // question about a set they did not actually measure.
    expect(routeSrc).toContain("MAX_PRODUCTS");
    expect(routeSrc).not.toMatch(/\.slice\(0,\s*MAX_PRODUCTS\)/);
    expect(routeSrc).toContain("status: 400");
  });
});
