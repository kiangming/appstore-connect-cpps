/**
 * D9 + the ONE bulk-import gate [arc-google-missing-purchase-options] —
 * structural guards. Behavioural tests prove today's paths; these make the
 * SHAPES that re-open the incident fail loudly:
 *
 *  W  writers  — an app's currency/language are written ONLY by
 *               declareAppDefault, and only as 'declared'. Nothing produces
 *               'guessed' any more (the refresh routes used to).
 *  G  gate     — the bulk-import decision lives in ONE gate. No route reads the
 *               provenance / sync columns or the "is declared" predicates
 *               itself (a second, private gate drifts from the first).
 *  M  migration — 20261016010000 marks existing values 'guessed' and NEVER
 *               'declared' (otherwise "not declared ⇒ block" could never fire:
 *               a guard over a state that cannot exist, KB §29.4).
 *
 * Comments are stripped before matching (KB P15/P28): a comment that MENTIONS
 * a forbidden shape is not the shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(__dirname, "..", "..");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function stripSqlComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = ["app", "lib", "components"].flatMap((d) => walk(join(ROOT, d)));
const rel = (p: string) => relative(ROOT, p);
const code = new Map(SOURCES.map((p) => [rel(p), stripComments(readFileSync(p, "utf8"))]));

const APPS_REPO = "lib/google-iap-management/repository/apps.ts";
const GATE = "lib/google-iap-management/bulk-import-mirror-gate.ts";
const DEFAULTS_MODULE = "lib/google-iap-management/app-defaults.ts";

describe("W — the app's currency/language have exactly one writer", () => {
  it("sanity: the scan sees the files it guards (an empty scan must not pass)", () => {
    expect(code.has(APPS_REPO)).toBe(true);
    expect(code.has(GATE)).toBe(true);
    expect(code.size).toBeGreaterThan(200);
  });

  // The choke point is googleIapDb(): every file that holds it is scanned,
  // whatever its path (a writer in lib/shared-*.ts is caught too). Pinning
  // spellings (`.from("apps").update(`) let `.from(APPS_TABLE)`, a template
  // literal, or a stored query builder through — measured in review (E5-E8).
  const STATIC_FROM = new Set(["Array", "Buffer", "Object", "Uint8Array", "Set", "Map"]);
  const DB_HOLDERS = [...code].filter(
    ([file, src]) =>
      file !== APPS_REPO && file !== "lib/google-iap-management/db.ts" && /\bgoogleIapDb\b/.test(src),
  );

  it("sanity: the googleIapDb holders are found (an empty scan must not pass)", () => {
    expect(DB_HOLDERS.length).toBeGreaterThan(5);
  });

  // A non-literal table is allowed only where its TYPE pins it to a literal
  // union without "apps" — widening that type to `string` turns this red.
  const TYPED_TABLE_PARAMS: Record<string, { name: string; decl: RegExp }> = {
    "lib/google-iap-management/repository/iaps.ts": {
      name: "table",
      decl: /\btable:\s*"iap_listings"\s*\|\s*"iap_prices";/,
    },
  };

  it("outside the apps repository, every googleIapDb table is a string literal, and `apps` is only ever .select()-ed", () => {
    const offenders: string[] = [];
    for (const [file, src] of DB_HOLDERS) {
      const typed = TYPED_TABLE_PARAMS[file];
      const re = /([\w$]*)\s*\.\s*from\(\s*([^)]*?)\s*\)(\s*\.\s*(\w+))?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const [, receiver, arg, , next] = m;
        if (STATIC_FROM.has(receiver)) continue;
        if (typed && arg === typed.name && typed.decl.test(src)) continue;
        const lit = /^(["'`])([a-z_]+)\1$/.exec(arg);
        if (!lit) {
          offenders.push(`${file}: .from(${arg}) — table must be a string literal`);
        } else if (lit[2] === "apps" && next !== "select") {
          offenders.push(
            `${file}: .from("apps") followed by ${next ?? "nothing"} — only the apps repository writes apps`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no client other than db.ts targets the google_iap_mgmt schema (a second client would bypass the choke point)", () => {
    const offenders = [...code]
      .filter(([file]) => file !== "lib/google-iap-management/db.ts")
      .filter(([, src]) =>
        /\.schema\(\s*["'`]google_iap_mgmt["'`]|\bdb\s*:\s*\{\s*schema\s*:\s*["'`]google_iap_mgmt["'`]/.test(src),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  // Every write site in the apps repository, by enclosing declaration. A NEW
  // write site — exported or not, function or arrow, static or computed key
  // (review E2-E4) — fails here until it is reviewed and listed.
  const APPS_WRITERS: Record<string, "may-write-defaults" | "must-not-touch-defaults"> = {
    upsertAppFromSync: "must-not-touch-defaults",
    batchUpsertAppsFromSync: "must-not-touch-defaults",
    markIapsMirrorSynced: "must-not-touch-defaults",
    declareAppDefault: "may-write-defaults",
  };

  function appsWriteSites(src: string): Array<{ fn: string; body: string }> {
    const decls = [
      ...src.matchAll(
        // TOP-LEVEL declarations only (column 0): a `const patch =` inside a
        // function body is part of that function, not a new writer.
        /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=|(?:^|\n)(?:export\s+)?class\s+(\w+)/g,
      ),
    ].map((d) => ({ name: d[1] ?? d[2] ?? d[3], at: d.index ?? 0 }));
    const bodyOf = (i: number) => src.slice(decls[i].at, decls[i + 1]?.at ?? src.length);
    const sites: Array<{ fn: string; body: string }> = [];
    for (const w of src.matchAll(/\.\s*(update|upsert|insert|delete)\s*\(/g)) {
      const at = w.index ?? 0;
      let i = -1;
      for (let k = 0; k < decls.length && decls[k].at < at; k++) i = k;
      sites.push({ fn: i >= 0 ? decls[i].name : "<top level>", body: i >= 0 ? bodyOf(i) : "" });
    }
    return sites;
  }

  it("the apps repository's write sites are exactly the reviewed four", () => {
    const sites = appsWriteSites(code.get(APPS_REPO) as string);
    expect(sites.map((x) => x.fn).sort()).toEqual(Object.keys(APPS_WRITERS).sort());
  });

  it("only declareAppDefault's write touches default_currency / default_language", () => {
    const offenders = appsWriteSites(code.get(APPS_REPO) as string)
      .filter((x) => APPS_WRITERS[x.fn] !== "may-write-defaults")
      .filter((x) => /default_(currency|language)|default_\$\{/.test(x.body))
      .map((x) => x.fn);
    expect(offenders).toEqual([]);
  });

  it("no computed `default_${...}` key anywhere in the apps repository", () => {
    expect(code.get(APPS_REPO) as string).not.toMatch(/default_\$\{/);
  });

  it("nothing in the Google module outside the pure defaults module spells 'guessed' — no code path can PRODUCE it", () => {
    const offenders = [...code]
      .filter(([file]) => file.includes("google-iap-management"))
      .filter(([file]) => file !== DEFAULTS_MODULE)
      .filter(([, src]) => /["'`]guessed["'`]/.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("APP_DEFAULT_GUESSED is only READ in the repository (provenance parsing), never written", () => {
    const src = code.get(APPS_REPO) as string;
    const uses = src.split("APP_DEFAULT_GUESSED").length - 1;
    // one import + one comparison inside toSource()
    expect(uses).toBe(2);
    expect(src).toMatch(/raw === APP_DEFAULT_DECLARED \|\| raw === APP_DEFAULT_GUESSED/);
  });

  it("declareAppDefault is referenced only by the declare route (a refresh cannot 'declare' on the Manager's behalf)", () => {
    // The NAME, not a call shape: `import { declareAppDefault as x }` and
    // `apps.declareAppDefault` both spell it (review E1 slipped past `\(`).
    const offenders = [...code]
      .filter(([file]) => file !== APPS_REPO)
      .filter(([, src]) => /\bdeclareAppDefault\b/.test(src))
      .map(([file]) => file)
      .filter((file) => file !== "app/api/google-iap-management/apps/[packageName]/defaults/route.ts");
    expect(offenders).toEqual([]);
  });

  it("the language→currency guesser is gone (deleted, not merely unused)", () => {
    expect(code.has("lib/google-iap-management/google/region-currency-map.ts")).toBe(false);
    const offenders = [...code]
      .filter(([, src]) => /inferCurrencyFromLanguage|updateAppDefaults/.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

describe("G — one bulk-import gate", () => {
  const PROVENANCE_COLUMNS = /default_currency_source|default_language_source|iaps_last_synced_at/;

  it("the provenance / sync columns are named only in the apps repository", () => {
    const offenders = [...code]
      .filter(([file]) => file !== APPS_REPO)
      .filter(([, src]) => PROVENANCE_COLUMNS.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("server code decides 'declared?' only inside the gate (no second gate in a route or lib module)", () => {
    const offenders = [...code]
      .filter(([file]) => file.startsWith("app/api/") || file.startsWith("lib/"))
      .filter(([file]) => file !== GATE && file !== DEFAULTS_MODULE)
      .filter(([, src]) => /\b(undeclaredFields|isDeclared)\b/.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("getAppImportReadiness is consumed only by the gate and the declare/display surfaces", () => {
    const allowed = new Set([
      APPS_REPO,
      GATE,
      "app/api/google-iap-management/apps/[packageName]/defaults/route.ts",
      "app/(dashboard)/google-iap-management/apps/[packageName]/page.tsx",
    ]);
    const offenders = [...code]
      .filter(([, src]) => /\bgetAppImportReadiness\b/.test(src))
      .map(([file]) => file)
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
  });

  it.each([
    "app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts",
    "app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.ts",
  ])("%s goes through the shared gate", (file) => {
    const src = code.get(file) as string;
    expect(src).toMatch(/readBulkImportGate\(/);
    expect(src).toMatch(/bulkImportGateRefusal\(/);
  });

  it.each([
    "app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts",
    "app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.ts",
  ])("%s never branches on gate internals (a carve-out there is a second gate)", (file) => {
    // Review E13/E14: `gate.kind === "blocked" && gate.undeclared[0] === "language"`
    // let a guessed language through and the whole suite stayed green.
    const src = code.get(file) as string;
    expect(src).not.toMatch(/\bgate\.(blockers|undeclared|defaults)\b/);
    expect(src).not.toMatch(/\bgate\.kind\s*[!=]==?\s*["'`](blocked|error)["'`]/);
    // …and prices against the gate's own declared value, not an earlier read.
    expect(src).toMatch(/gate\.declaredCurrency/);
    expect(src).not.toMatch(/\bapp\.default_currency\b/);
  });
});

describe("M — the provenance migration never pre-declares", () => {
  const MIG = "supabase/migrations/20261016010000_google_iap_mgmt_apps_defaults_source.sql";
  const sql = stripSqlComments(readFileSync(join(ROOT, MIG), "utf8"));
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

  it("backfills existing values as 'guessed' — one UPDATE per field, SET column = WHERE column, no extra predicate", () => {
    const updates = statements.filter((s) => /^UPDATE\b/i.test(s));
    expect(updates).toHaveLength(2);
    const fields = updates.map((u) => {
      const m =
        /^UPDATE google_iap_mgmt\.apps\s+SET default_(\w+)_source = 'guessed'\s+WHERE default_(\w+) IS NOT NULL\s+AND default_(\w+)_source IS NULL$/.exec(
          u,
        );
      expect(m, u).not.toBeNull();
      expect(new Set([m?.[1], m?.[2], m?.[3]]).size).toBe(1);
      return m?.[1];
    });
    expect(fields.sort()).toEqual(["currency", "language"]);
  });

  it("no LATER migration writes 'declared' either (the Manager is the only source of it)", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const later = readdirSync(dir).filter((f) => f.endsWith(".sql") && f > "20261016010000");
    const offenders = later.filter((f) => {
      const stmts = stripSqlComments(readFileSync(join(dir, f), "utf8")).split(";");
      return stmts.some(
        (st) =>
          /_source/i.test(st) &&
          /'declared'/.test(st) &&
          (/^\s*(UPDATE|INSERT)\b/i.test(st) || /\bDEFAULT\s+'declared'/i.test(st)),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("'declared' appears only inside a CHECK's allowed-value list, never as a written value", () => {
    for (const s of statements) {
      if (!/'declared'/.test(s)) continue;
      expect(s).toMatch(/^ALTER TABLE[\s\S]*ADD CONSTRAINT[\s\S]*CHECK/i);
      expect(s).not.toMatch(/=\s*'declared'/);
      expect(s).not.toMatch(/\bDEFAULT\s+'declared'/i);
    }
    expect(statements.some((s) => /^(UPDATE|INSERT)\b/i.test(s) && /'declared'/.test(s))).toBe(false);
  });

  it("each coherence CHECK guards `_source IS NOT NULL` explicitly (NULL IN (...) is NULL, and a NULL CHECK PASSES)", () => {
    // Measured on PGlite (out-of-repo scratch harness; the Manager's verify
    // query V2.3 re-checks it in production): without it,
    // `SET default_language = 'vi'` with no provenance was ACCEPTED.
    const check = statements.find((s) => /apps_default_currency_source_check CHECK/.test(s)) ?? "";
    expect(check).toMatch(/default_currency_source IS NOT NULL\s+AND default_currency_source IN/);
    expect(check).toMatch(/default_language_source IS NOT NULL\s+AND default_language_source IN/);
  });

  it("each CHECK refuses a BLANK value as 'declared' (validation alone is code, not the DB)", () => {
    const check = statements.find((s) => /apps_default_currency_source_check CHECK/.test(s)) ?? "";
    expect(check).toMatch(/default_currency_source <> 'declared' OR btrim\(default_currency\) <> ''/);
    expect(check).toMatch(/default_language_source <> 'declared' OR btrim\(default_language\) <> ''/);
  });
});
