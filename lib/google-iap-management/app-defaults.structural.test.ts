/**
 * D9 + the ONE bulk-import gate [arc-google-missing-purchase-options] —
 * structural guards. Behavioural tests prove today's paths; these make the
 * SHAPES that re-open the incident fail loudly:
 *
 *  W  writers  — an app's currency/language are written ONLY by
 *               declareAppDefault, and only as 'declared'. Nothing produces
 *               'guessed' any more (the refresh routes used to).
 *  G  gate     — the bulk-import decision lives in ONE gate, whose ONLY input
 *               is the IAP sync stamp. Since C2.1 nothing in the import path
 *               reads the app's currency/language provenance (they are not
 *               conditions); no route branches on gate internals.
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

describe("G — one bulk-import gate, and the app's currency/language are not in it", () => {
  const PROVENANCE_COLUMNS = /default_currency_source|default_language_source|iaps_last_synced_at/;
  const WIZARD = "components/google-iap-management/bulk-import/BulkImportWizard.tsx";
  const PREVIEW = "app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts";
  const EXECUTE = "app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.ts";
  const BULK_PAGE = "app/(dashboard)/google-iap-management/apps/[packageName]/bulk-import/page.tsx";

  it("the provenance / sync columns are named only in the apps repository", () => {
    const offenders = [...code]
      .filter(([file]) => file !== APPS_REPO)
      .filter(([, src]) => PROVENANCE_COLUMNS.test(src))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("C2.1: no bulk-import surface reads the app's provenance or decides 'declared?' (not an import condition)", () => {
    // Manager 2026-10-16: the file currency is meant to be the only price
    // source, so the app's currency/language must not decide whether an import
    // runs. A carve-out that re-reads them anywhere in the import path is a
    // second gate.
    const surfaces = [...code].filter(
      ([file]) =>
        file === GATE ||
        file === PREVIEW ||
        file === EXECUTE ||
        file === BULK_PAGE ||
        file === WIZARD ||
        file.startsWith("lib/google-iap-management/orchestration/") ||
        file.startsWith("components/google-iap-management/bulk-import/"),
    );
    expect(surfaces.length).toBeGreaterThan(5);
    const offenders = surfaces
      .filter(([, src]) =>
        /\b(undeclaredFields|isDeclared|getAppDefaults|APP_DEFAULT_DECLARED|APP_DEFAULT_GUESSED)\b|google-iap-management\/app-defaults["']|\.\/app-defaults["']/.test(src),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("the gate's only read is the sync stamp; the defaults read serves only the app page and the declare route", () => {
    const gateReaders = [...code]
      .filter(([file]) => file !== APPS_REPO)
      .filter(([, src]) => /\bgetIapsMirrorSyncedAt\b/.test(src))
      .map(([file]) => file);
    expect(gateReaders).toEqual([GATE]);
    const defaultsReaders = [...code]
      .filter(([file]) => file !== APPS_REPO)
      .filter(([, src]) => /\bgetAppDefaults\b/.test(src))
      .map(([file]) => file)
      .sort();
    expect(defaultsReaders).toEqual(
      [
        "app/(dashboard)/google-iap-management/apps/[packageName]/page.tsx",
        "app/api/google-iap-management/apps/[packageName]/defaults/route.ts",
      ].sort(),
    );
  });

  it("bulk-import surfaces import from the apps repository ONLY what they need (a provenance reader under any name is caught)", () => {
    // Review M5e: a new apps.ts export wrapping getAppDefaults, called from the
    // bulk-import page, re-blocked Preview on a guessed currency — GREEN under
    // a name-based ban. Pin the import list instead.
    const imported = (src: string) => {
      const m = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/google-iap-management\/repository\/apps["']/.exec(src);
      return m ? m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean).sort() : [];
    };
    expect(imported(code.get(PREVIEW) as string)).toEqual(["getAppByPackage"]);
    expect(imported(code.get(EXECUTE) as string)).toEqual(["getAppByPackage"]);
    expect(imported(code.get(BULK_PAGE) as string)).toEqual(["getAppByPackage"]);
    expect(code.get(GATE)).toMatch(/import \{ getIapsMirrorSyncedAt \} from "\.\/repository\/apps";/);
    expect((code.get(GATE) as string).match(/from "/g)).toHaveLength(1);
    // the wizard is a client component: no repository import at all
    expect(code.get(WIZARD)).not.toMatch(/repository\/apps/);
  });

  it("only getAppDefaults / declareAppDefault (and their helper) touch the provenance columns in the apps repository", () => {
    const src = code.get(APPS_REPO) as string;
    const decls = [
      ...src.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=|(?:^|\n)(?:export\s+)?class\s+(\w+)/g),
    ].map((d) => ({ name: d[1] ?? d[2] ?? d[3], at: d.index ?? 0 }));
    const touching = decls
      .filter((d, i) => /_source\b|DEFAULTS_COLUMNS/.test(src.slice(d.at, decls[i + 1]?.at ?? src.length)))
      .map((d) => d.name)
      .sort();
    expect(touching).toEqual(["DEFAULTS_COLUMNS", "declareAppDefault", "getAppDefaults"].sort());
  });

  it("the bulk-import page shows the note the SAME currency both routes price with (app.default_currency)", () => {
    expect(code.get(BULK_PAGE)).toMatch(/appDefaultCurrency=\{app\.default_currency\}/);
    expect(code.get(PREVIEW)).toMatch(/appCurrency: app\.default_currency \?\? null/);
  });

  it.each([PREVIEW, EXECUTE])("%s goes through the shared gate", (file) => {
    const src = code.get(file) as string;
    expect(src).toMatch(/readBulkImportGate\(/);
    expect(src).toMatch(/bulkImportGateRefusal\(/);
  });

  it.each([PREVIEW, EXECUTE])("%s never branches on gate internals (a carve-out there is a second gate)", (file) => {
    // Review E13/E14 (C2): `gate.kind === "blocked" && …` let a state through
    // and the whole suite stayed green.
    const src = code.get(file) as string;
    expect(src).not.toMatch(/\bgate\.(blockers|undeclared|defaults|declaredCurrency)\b/);
    expect(src).not.toMatch(/\bgate\.kind\s*[!=]==?\s*["'`](blocked|error)["'`]/);
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

describe("B — the C2.1 backfill of iaps_last_synced_at reads the audit log ONCE, with the agreed rule", () => {
  const MIG = "supabase/migrations/20261016020000_google_iap_mgmt_apps_iaps_last_synced_backfill.sql";
  const VERIFY = "docs/google-iap-management/queries/verify-c1-c2-migrations.sql";
  const raw = readFileSync(join(ROOT, MIG), "utf8");
  const sql = stripSqlComments(raw);
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  const norm = (s: string) => stripSqlComments(s).replace(/\s+/g, " ").trim();
  const block = (s: string, from: string, to: string) => {
    const i = s.indexOf(from);
    const j = s.indexOf(to, i);
    return i >= 0 && j > i ? norm(s.slice(i, j)) : "";
  };

  it("the backfill statement is pinned VERBATIM — a migration that may already have run must never change", () => {
    // Fragment pins let six wrong conditions through in review (an extra OR on
    // the qualifying filter, an earlier 'ok' branch, a misspelt flag key, an
    // inverted EXISTS, an OR'd package_name join, a second params row). The
    // rule was agreed line by line with the Manager; changing ANY of it is a
    // new decision and a NEW migration (forward-only), never an edit here.
    const data = statements.filter((s) => /^WITH params/.test(s));
    expect(data).toHaveLength(1);
    const expected = [
      "WITH params AS ( SELECT TIMESTAMPTZ '2026-05-21 14:52:44+00' AS min_created_at",
      " ), log AS ( SELECT l.id, l.target_id, l.created_at, l.payload, (jsonb_typeof(l.payload) = 'object') AS is_obj, CASE",
      " WHEN jsonb_typeof(l.payload) = 'object' THEN (l.payload ? 'scope' OR l.payload ? 'sku') ELSE false END AS is_single,",
      " CASE",
      " WHEN jsonb_typeof(l.payload->'synced') = 'number' THEN (l.payload->>'synced')::numeric END AS synced_n,",
      " CASE",
      " WHEN jsonb_typeof(l.payload->'failed') = 'number' THEN (l.payload->>'failed')::numeric END AS failed_n,",
      " CASE",
      " WHEN jsonb_typeof(l.payload->'total') = 'number' THEN (l.payload->>'total')::numeric END AS total_n",
      " FROM google_iap_mgmt.actions_log l",
      " WHERE l.action_type = 'IAPS_LIST_SYNC'",
      " ), classified AS ( SELECT g.*, a.id AS app_id, CASE",
      " WHEN NOT g.is_obj THEN 'bad_payload'",
      " WHEN g.is_single THEN 'single_item'",
      " WHEN g.synced_n IS NULL OR g.failed_n IS NULL OR g.total_n IS NULL THEN 'bad_payload'",
      " WHEN g.failed_n > 0 THEN 'failed'",
      " WHEN g.failed_n < 0 OR g.synced_n < 0 OR g.total_n <> g.synced_n + g.failed_n THEN 'inconsistent'",
      " WHEN g.synced_n = 0 THEN 'zero_products'",
      " WHEN COALESCE(g.payload->>'flag_reconcile_skipped', '') LIKE 'incoming_below%' THEN 'degraded'",
      " WHEN g.payload->>'package_name' IS DISTINCT",
      " FROM a.package_name THEN 'package_mismatch'",
      " WHEN g.created_at < p.min_created_at THEN 'pre_cutoff' ELSE 'ok' END AS cls",
      " FROM log g",
      " JOIN google_iap_mgmt.apps a ON a.id = g.target_id",
      " CROSS",
      " JOIN params p",
      " ), qualifying AS ( SELECT c.app_id, MAX(c.created_at) AS synced_at",
      " FROM classified c",
      " WHERE c.cls = 'ok'",
      " GROUP BY c.app_id )",
      " UPDATE google_iap_mgmt.apps a",
      " SET iaps_last_synced_at = q.synced_at",
      " FROM qualifying q",
      " WHERE a.id = q.app_id AND a.iaps_last_synced_at IS NULL",
      " AND EXISTS (SELECT 1",
      " FROM google_iap_mgmt.iaps i",
      " WHERE i.app_id = a.id AND i.deleted_on_google_at IS NULL)",
    ].join("");
    expect(norm(data[0])).toBe(expected);
  });

  it("exactly one data statement: an UPDATE of apps.iaps_last_synced_at, only where it is still NULL", () => {
    const data = statements.filter((s) => /\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i.test(s) && !/^COMMENT\b/i.test(s));
    expect(data).toHaveLength(1);
    const u = data[0];
    expect(u).toMatch(/UPDATE google_iap_mgmt\.apps a\s+SET iaps_last_synced_at = q\.synced_at/);
    expect(u).toMatch(/a\.iaps_last_synced_at IS NULL/);
    // never a mirror table, never provenance
    expect(u).not.toMatch(/\b(iap_listings|iap_prices)\b|_source/);
    expect(u).not.toMatch(/UPDATE google_iap_mgmt\.iaps\b/);
  });

  it("re-comments C2's provenance columns: no longer 'Bulk import accepts declared only'", () => {
    for (const col of ["default_currency_source", "default_language_source"]) {
      const st = statements.find((x) => x.startsWith(`COMMENT ON COLUMN google_iap_mgmt.apps.${col} IS`)) ?? "";
      expect(st, col).toMatch(/NOT a bulk-import condition/);
      expect(st, col).not.toMatch(/accepts declared only/);
    }
  });

  it("source rows: IAPS_LIST_SYNC joined by target_id = apps.id (never by package_name)", () => {
    expect(sql).toMatch(/WHERE l\.action_type = 'IAPS_LIST_SYNC'/);
    expect(sql).toMatch(/JOIN google_iap_mgmt\.apps a ON a\.id = g\.target_id/);
    expect(sql).not.toMatch(/ON a\.package_name\s*=/);
  });

  it("only a FULL, complete, non-degraded, post-cutoff refresh of a non-empty mirror qualifies", () => {
    // Each line is one exclusion the Manager agreed (or that the review proved
    // necessary). Removing any of them must turn this red.
    expect(sql).toMatch(/WHEN g\.is_single THEN 'single_item'/); // single-SKU "Sync from Google"
    expect(sql).toMatch(/l\.payload \? 'scope' OR l\.payload \? 'sku'/);
    expect(sql).toMatch(/WHEN g\.failed_n > 0 THEN 'failed'/); // failed refreshes
    expect(sql).toMatch(/WHEN g\.synced_n = 0 THEN 'zero_products'/); // "synced > 0"
    expect(sql).toMatch(/g\.total_n <> g\.synced_n \+ g\.failed_n THEN 'inconsistent'/);
    expect(sql).toMatch(/LIKE 'incoming_below%' THEN 'degraded'/);
    expect(sql).toMatch(/g\.payload->>'package_name' IS DISTINCT FROM a\.package_name THEN 'package_mismatch'/);
    expect(sql).toMatch(/TIMESTAMPTZ '2026-05-21 14:52:44\+00' AS min_created_at/);
    expect(sql).toMatch(/WHEN g\.created_at < p\.min_created_at THEN 'pre_cutoff'/);
    expect(sql).toMatch(/WHERE c\.cls = 'ok'/);
    expect(sql).toMatch(/MAX\(c\.created_at\) AS synced_at/);
    expect(sql).toMatch(/i\.app_id = a\.id AND i\.deleted_on_google_at IS NULL/);
    // numbers are cast only when they ARE numbers — a bad payload never throws
    for (const k of ["synced", "failed", "total"]) {
      expect(sql).toMatch(
        new RegExp(`jsonb_typeof\\(l\\.payload->'${k}'\\)\\s*=\\s*'number' THEN \\(l\\.payload->>'${k}'\\)::numeric`),
      );
    }
  });

  it("the dry-run (D1) and the post-checks (V3.2, V3.3) use the migration's EXACT classification CTE", () => {
    const verify = readFileSync(join(ROOT, VERIFY), "utf8");
    const migCte = block(raw, "WITH params AS (", "qualifying AS (");
    expect(migCte.length).toBeGreaterThan(500);
    for (const id of ["D1", "V3.2", "V3.3"]) {
      const start = verify.indexOf(`-- @@ ${id} `);
      expect(start, id).toBeGreaterThan(0);
      const section = verify.slice(start, verify.indexOf("\n-- @@ ", start + 5) === -1 ? undefined : verify.indexOf("\n-- @@ ", start + 5));
      const cte = norm(section.slice(section.indexOf("WITH params AS (")));
      // the verify copy ends the CTE with ")" (+ more CTEs); the migration's
      // slice ends with "),"
      expect(cte.startsWith(migCte.replace(/,$/, "").trim()), id).toBe(true);
    }
  });

  it("D1 predicts exactly the migration's write, and V3.3 checks exactly its predicate (no drift outside the CTE)", () => {
    const verify = readFileSync(join(ROOT, VERIFY), "utf8");
    const section = (id: string) => {
      const start = verify.indexOf(`-- @@ ${id} `);
      const next = verify.indexOf("\n-- @@ ", start + 5);
      return norm(verify.slice(start, next === -1 ? undefined : next));
    };
    const d1 = section("D1");
    expect(d1).toContain("COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NULL) AS n_live");
    expect(d1).toContain("MAX(f.created_at) FILTER (WHERE f.cls = 'ok') AS latest_ok_at");
    expect(d1).toContain(
      "CASE WHEN a.iaps_last_synced_at IS NULL AND pa.latest_ok_at IS NOT NULL AND COALESCE(m.n_live, 0) > 0 THEN 'yes' ELSE 'no' END AS will_backfill",
    );
    expect(d1).toContain(
      "CASE WHEN a.iaps_last_synced_at IS NULL AND COALESCE(m.n_live, 0) > 0 THEN pa.latest_ok_at END AS will_set_to",
    );
    const v33 = section("V3.3");
    expect(v33).toContain(
      "JOIN classified c ON c.app_id = a.id AND c.cls = 'ok' WHERE a.iaps_last_synced_at IS NULL AND EXISTS (SELECT 1 FROM google_iap_mgmt.iaps i WHERE i.app_id = a.id AND i.deleted_on_google_at IS NULL)",
    );
  });

  it("the C1 column stays written by the refresh route; no code path re-derives it from actions_log", () => {
    const offenders = [...code]
      .filter(([, src]) => /IAPS_LIST_SYNC/.test(src))
      .map(([file]) => file)
      .filter(
        (f) =>
          ![
            "lib/google-iap-management/repository/actions-log.ts",
            "app/api/google-iap-management/apps/[packageName]/iaps/refresh/route.ts",
            "app/api/google-iap-management/apps/[packageName]/iaps/[sku]/sync-prices/route.ts",
          ].includes(f),
      );
    expect(offenders).toEqual([]);
  });
});
