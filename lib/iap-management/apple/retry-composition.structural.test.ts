/**
 * STRUCTURAL invariant — how many `withRetry` wrappers enclose each Apple call.
 *
 * ⚠ WHY THIS IS NOT A BEHAVIOURAL TEST. `client.test.ts` already proves that
 * `listAllInAppPurchases` retries a page internally and does not re-fetch page
 * 1. That test passes whether or not a CALLER wraps the helper a second time —
 * it never sees the call sites. The double-wrap at export:68 and
 * sync-states:91 lived for months underneath a green suite for exactly that
 * reason. The defect is a property of the call sites, so the assertion has to
 * be too.
 *
 * ⚠ THE ASSERTION IS A COUNT, NOT A SUBSTRING. "the file contains withRetry"
 * is satisfied by a comment saying "no withRetry here"; `analyze` therefore
 * strips comments first and computes the enclosing call stack by paren
 * balance, so what is asserted is "N retry wrappers lexically enclose this
 * call", which is the actual invariant.
 *
 * ⚠ AND THE ANALYZER IS ITSELF UNDER TEST. An analyzer that always returned 0
 * would make every `expected: 0` row pass — the classic fake green. The
 * fixture suite below pins 0 / 1 / 2 / aliased-wrapper / comment-decoy /
 * string-decoy cases so a broken analyzer fails before the real assertions
 * are reached.
 *
 * Contract source of truth: `listAllInAppPurchases`' own docstring
 * (client.ts:52-54) — "Callers MUST NOT wrap this in their own `withRetry`" —
 * and `ExportFetchDeps` (export-fetch.ts), which states the same rule for the
 * two injected export primitives.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

/** Names that constitute a retry wrapper. `trackedWithRetry` is the
 *  counters-bag wrapper in bulk-availability / bulk-import — it delegates to
 *  `withRetry`, so it counts. */
const RETRY_WRAPPERS = new Set(["withRetry", "trackedWithRetry"]);

/**
 * Strip comments without touching string/template contents.
 *
 * ⚠ A naive `//` stripper corrupts every `"https://…"` in the file and would
 * silently change the paren balance downstream, so this walks the source as a
 * tiny tokenizer instead.
 */
export function stripComments(src: string): string {
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

const IDENT_TAIL = /[A-Za-z0-9_$]/;

/**
 * For every `callee(` in `src`, how many retry wrappers lexically enclose it.
 * Returns one entry per occurrence — so a callee used twice in a file yields
 * two entries and neither can hide behind the other.
 *
 * `callee` may be a dotted path (`deps.getIapDetail`), which is how the export
 * fetch reaches its injected primitives.
 *
 * ⚠ A DECLARATION IS NOT A CALL SITE. `export async function foo(` is also an
 * identifier followed by `(`; counting it made the repo scan report
 * `client.ts` — the file that DEFINES `listAllInAppPurchases` — as a caller
 * that must not wrap it. Nonsense, and it would have forced a bogus row into
 * the truth table.
 */
export function analyze(src: string, callee: string): number[] {
  const code = stripComments(src);
  const dot = callee.lastIndexOf(".");
  const tail = dot === -1 ? callee : callee.slice(dot + 1);
  const qualifier = dot === -1 ? null : callee.slice(0, dot + 1);
  const stack: string[] = [];
  const found: number[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (IDENT_TAIL.test(ch)) {
      let j = i;
      while (j < code.length && IDENT_TAIL.test(code[j])) j++;
      const word = code.slice(i, j);
      let k = j;
      while (k < code.length && /\s/.test(code[k])) k++;
      // A generic call — withRetry<T>( — still counts as an invocation.
      if (code[k] === "<") {
        let depth = 0;
        while (k < code.length) {
          if (code[k] === "<") depth++;
          else if (code[k] === ">") {
            depth--;
            if (depth === 0) {
              k++;
              break;
            }
          } else if (code[k] === ";" || code[k] === "{") break;
          k++;
        }
        while (k < code.length && /\s/.test(code[k])) k++;
      }
      if (code[k] === "(") {
        const before = code.slice(Math.max(0, i - 24), i);
        const isDeclaration = /\bfunction\s+$/.test(before);
        const qualifierOk =
          qualifier === null ? true : before.endsWith(qualifier);
        if (word === tail && qualifierOk && !isDeclaration) {
          found.push(stack.filter((n) => RETRY_WRAPPERS.has(n)).length);
        }
        stack.push(word);
        i = k + 1;
        continue;
      }
      i = j;
      continue;
    }
    if (ch === "(") {
      stack.push("");
      i++;
      continue;
    }
    if (ch === ")") {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return found;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ─── The analyzer must be proven able to SEE a wrapper ──────────────────────

describe("analyze — self-test (a broken analyzer must fail here, not silently pass below)", () => {
  const cases: Array<[string, string, number[]]> = [
    ["bare call", "const r = await listAll(creds, id);", [0]],
    ["one wrapper", "const r = await withRetry(() => listAll(creds, id));", [1]],
    [
      "two wrappers — the defect shape",
      "const r = await withRetry(() => withRetry(() => listAll(creds, id)));",
      [2],
    ],
    [
      "aliased wrapper counts",
      "const r = await trackedWithRetry(c, () => listAll(creds, id));",
      [1],
    ],
    [
      "generic call form withRetry<T>()",
      "const r = await withRetry<Page>(() => listAll(creds, id));",
      [1],
    ],
    [
      "wrapper that already CLOSED does not count",
      "await withRetry(() => other(x)); const r = await listAll(creds, id);",
      [0],
    ],
    [
      "two occurrences reported separately",
      "await withRetry(() => listAll(a)); await listAll(b);",
      [1, 0],
    ],
    [
      "P15 — a comment naming withRetry must NOT register",
      "// wrapped in withRetry below\n/* withRetry(() => */ const r = await listAll(creds, id);",
      [0],
    ],
    [
      "a string containing withRetry must NOT register",
      'log("withRetry(() =>"); const r = await listAll(creds, id);',
      [0],
    ],
    [
      "a URL in a string must not corrupt paren balance",
      'const u = "https://api.appstoreconnect.apple.com/v1/apps"; const r = await withRetry(() => listAll(u));',
      [1],
    ],
    ["callee absent → no entries", "const r = await somethingElse();", []],
    [
      "a DECLARATION is not a call site",
      "export async function listAll(creds: C) { return 1; }",
      [],
    ],
    [
      "declaration + real call → only the call is counted",
      "async function listAll(c: C) { return 1; }\nconst r = await withRetry(() => listAll(c));",
      [1],
    ],
  ];
  for (const [name, src, expected] of cases) {
    it(name, () => {
      expect(analyze(src, "listAll")).toEqual(expected);
    });
  }

  // Dotted callees — the shape the export fetch's injected deps use.
  const dotted: Array<[string, string, number[]]> = [
    ["dotted callee, bare", "const d = await deps.getIapDetail(c, id);", [0]],
    [
      "dotted callee, one wrapper",
      "const d = await withRetry(() => deps.getIapDetail(c, id));",
      [1],
    ],
    [
      "a DIFFERENT object's same-named method must NOT match",
      "const d = await withRetry(() => other.getIapDetail(c, id));",
      [],
    ],
  ];
  for (const [name, src, expected] of dotted) {
    it(name, () => {
      expect(analyze(src, "deps.getIapDetail")).toEqual(expected);
    });
  }
});

// ─── Truth table — every listAllInAppPurchases call site in the repo ────────

/**
 * ⚠ EXHAUSTIVE, and enforced to be. The row list below is compared against a
 * repo-wide scan; a new call site that nobody adds a row for FAILS, rather
 * than being silently outside the table. That is the property the Phase-0
 * census got wrong by hand — it counted 5 sites when there were 7.
 */
const LIST_ALL_SITES: Array<{ file: string; wrappers: number[]; why: string }> = [
  {
    file: "app/api/iap-management/apps/[appId]/export/route.ts",
    wrappers: [0],
    why: "FIXED — was [1], the double-wrap this commit removed",
  },
  {
    file: "app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts",
    wrappers: [0],
    why: "FIXED — was [1], the twin",
  },
  {
    file: "app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts",
    wrappers: [0, 0],
    why: "already correct — preflight + execute enumeration",
  },
  {
    file: "app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
    wrappers: [0],
    why: "already correct",
  },
  {
    file: "app/(dashboard)/iap-management/apps/[appId]/page.tsx",
    wrappers: [0],
    why: "already correct — the reference shape",
  },
  {
    file: "app/(dashboard)/iap-management/apps/[appId]/bulk-import/page.tsx",
    wrappers: [0],
    why: "already correct",
  },
];

describe("listAllInAppPurchases — the helper owns its retry; NO caller may wrap it", () => {
  it.each(LIST_ALL_SITES)("$file → $why", ({ file, wrappers }) => {
    expect(analyze(read(file), "listAllInAppPurchases")).toEqual(wrappers);
  });

  it("the table above covers EVERY call site in the repo (a new one fails here)", () => {
    const scanned = scanRepoFor("listAllInAppPurchases");
    expect(scanned.sort()).toEqual(LIST_ALL_SITES.map((s) => s.file).sort());
  });

  it("the helper itself retries exactly once, per page, inside its loop", () => {
    // The other half of the contract: removing the callers' wrappers is only
    // safe because this one exists. If it ever disappears, the fix above
    // becomes a real loss of retry and this test says so.
    expect(analyze(read("lib/iap-management/apple/client.ts"), "iapFetch")).toContain(1);
  });
});

// ─── Truth table — the export fetch's two injected primitives ───────────────

describe("fetchExportSources — exactly one wrapper on the naive dep, none on the self-retrying one", () => {
  const file = "lib/iap-management/apple/export-fetch.ts";

  it("deps.getIapDetail is wrapped EXACTLY ONCE (retry-naive leaf)", () => {
    expect(analyze(read(file), "deps.getIapDetail")).toEqual([1]);
  });

  it("deps.getPriceScheduleForIap is wrapped ZERO times (retries internally at both stages)", () => {
    expect(analyze(read(file), "deps.getPriceScheduleForIap")).toEqual([0]);
  });

  it("getPriceScheduleForIap really does retry internally — the reason for the 0 above", () => {
    // Pins the premise, not just the conclusion. Stage 1 + stage 2's per-page
    // loop each wrap iapFetch once.
    const counts = analyze(read("lib/iap-management/apple/price-schedules.ts"), "iapFetch");
    expect(counts.filter((n) => n === 1).length).toBeGreaterThanOrEqual(2);
  });

  it("getIapDetailFromApple really is retry-naive — the reason for the 1 above", () => {
    // Two bare call sites in this file (getIapDetailFromApple + getIapViewData);
    // neither is wrapped, which is what makes it a retry-naive dep.
    expect(analyze(read("lib/iap-management/queries/iap-detail.ts"), "getInAppPurchase")).toEqual([0, 0]);
  });
});

// ─── P16 shape 2 — bare-identifier pin at the two fixed sites ───────────────

describe("bare-identifier pin — the two fixed sites read as bare calls in source", () => {
  it.each([
    ["app/api/iap-management/apps/[appId]/export/route.ts", "listAllInAppPurchases(creds, appleAppId)"],
    ["app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts", "listAllInAppPurchases(creds, appleAppId)"],
  ])("%s calls it bare", (file, call) => {
    const code = stripComments(read(file));
    expect(code).toContain(call);
    // and nowhere in the file does a retry wrapper open immediately before it
    expect(code.replace(/\s+/g, " ")).not.toContain(`withRetry(() => ${call}`);
  });

  /**
   * ⚠ ONE TEST PER FILE, NOT A LOOP OVER BOTH.
   * As a single looped test this failed identically for either route's
   * regression — the message read "expected 'import { NextResponse } …' not to
   * contain 'withRetry'" and named no file, so a reader could not tell which
   * twin had come back. Split so the failing TEST NAME carries the answer.
   */
  it.each([
    "app/api/iap-management/apps/[appId]/export/route.ts",
    "app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts",
  ])("%s no longer imports withRetry (a dead import is the wrapper's ghost)", (f) => {
    const imports = stripComments(read(f))
      .split("\n")
      .filter((l) => l.includes("import"))
      .join("\n");
    expect(imports).not.toContain("withRetry");
  });
});

// ─── repo scan helper ───────────────────────────────────────────────────────

import { readdirSync, statSync } from "node:fs";

function scanRepoFor(callee: string): string[] {
  const hits: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (skip.has(entry)) continue;
      const rel = dir ? `${dir}/${entry}` : entry;
      const abs = join(ROOT, rel);
      if (statSync(abs).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const code = stripComments(readFileSync(abs, "utf8"));
      // an import line is not a call site
      const withoutImports = code
        .split("\n")
        .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s/.test(l))
        .join("\n");
      if (analyze(withoutImports, callee).length > 0) hits.push(rel);
    }
  };
  for (const top of ["app", "lib", "components"]) walk(top);
  return hits;
}
