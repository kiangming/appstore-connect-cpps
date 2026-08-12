/**
 * Per-territory Custom Prices — STRUCTURAL fitness tests.
 *
 * Three properties that no behavioural test can protect, because each one is
 * about code that does NOT exist yet (a second writer, a second staleness
 * implementation, a stored price-point id). Same shape as
 * rbac-posture.test.ts and lib/audit-constraints/guard.test.ts: read the source
 * and assert the invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");
const CUSTOM_PRICES_DIR = join(ROOT, "lib", "iap-management", "custom-prices");
const REPOSITORY = "lib/iap-management/custom-prices/repository.ts";
const MODEL = "lib/iap-management/custom-prices/model.ts";

/** Every non-test source file under the app (excludes node_modules/.next). */
function allSourceFiles(): string[] {
  const roots = ["lib", "app", "components", "types"];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (
        (full.endsWith(".ts") || full.endsWith(".tsx")) &&
        !full.endsWith(".test.ts") &&
        !full.endsWith(".test.tsx")
      ) {
        out.push(full.slice(ROOT.length + 1));
      }
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Source with block and line comments removed.
 *
 * Needed for the price-point-id assertion: the rule "never store an Apple
 * price-point id" is worth EXPLAINING in a comment, and a test that forbade the
 * mere mention of the phrase would push a future author to delete the
 * explanation to make the build pass. The assertion is about a field named that,
 * not about prose.
 */
function readCodeOnly(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. ONE writer ───────────────────────────────────────────────────────────

describe("single writer — iap_custom_prices is touched from exactly one module", () => {
  it("no file except the repository references the table", () => {
    const offenders = allSourceFiles().filter(
      (f) => f !== REPOSITORY && /iap_custom_prices/.test(read(f)),
    );
    expect(
      offenders,
      "The August 2026 cross-module audit established WHY iap_mgmt drifted and " +
        "google_iap_mgmt did not: Google funnels every audit write through one " +
        "typed choke point, Apple scattered them across five files — and that is " +
        "exactly where the two lost AVAILABILITY_* values hid. Custom-price " +
        `persistence goes through ${REPOSITORY} only. Import from there instead.`,
    ).toEqual([]);
  });

  it("no file except the repository writes the baseline fingerprint columns", () => {
    // A second writer of these three columns could stamp a fresh fingerprint
    // over stale prices, which reads as clean and would ship to a live store.
    const offenders = allSourceFiles().filter(
      (f) =>
        f !== REPOSITORY && /custom_prices_baseline_(tier_id|pricing_source|base_territory)/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("the repository's audit writes go through one typed helper", () => {
    const src = read(REPOSITORY);
    // Exactly one actions_log insert site in the module.
    expect(src.match(/from\("actions_log"\)/g) ?? []).toHaveLength(1);
    // Typed, not `string` — the compiler then refuses an undeclared action type,
    // and the audit-constraint guard holds that same list against the live CHECK.
    expect(src).toMatch(/action:\s*IapActionType/);
    expect(src).not.toMatch(/action(Type)?:\s*string/);
  });

  it("uses the module's conventional helper name so the audit guard's scan sees it", () => {
    // lib/audit-constraints/registry.ts's `positional-helper-arg` shape keys off
    // `writeAuditRow(`. Renaming it here would silently remove these action
    // types from the scan's coverage.
    expect(read(REPOSITORY)).toMatch(/async function writeAuditRow\(/);
  });
});

// ─── 2. ONE staleness implementation, importable from both sides ─────────────

describe("the staleness rule is one function, usable by client AND server", () => {
  const SERVER_ONLY = [
    /from\s+"@?\/?lib\/iap-management\/db"/,
    /from\s+"fs"/,
    /from\s+"node:/,
    /iapDb\(/,
    /supabase/i,
    /next\/server/,
    /"server-only"/,
  ];

  it("model.ts has no server-only import — so a Client Component can import it", () => {
    const src = read(MODEL);
    const violations = SERVER_ONLY.filter((re) => re.test(src)).map(String);
    expect(
      violations,
      "isCustomBaselineStale must be importable from a Client Component. A " +
        "client-only block is bypassable from a stale tab; a server-only block " +
        "is a dead end with no way forward from the UI. Both layers must call " +
        "THIS function — a server-only import here forces a second " +
        "implementation, and the two would drift invisibly until a wrong price " +
        "reached a live store.",
    ).toEqual([]);
  });

  it("the repository imports the comparison rather than reimplementing it", () => {
    const src = read(REPOSITORY);
    expect(src).toMatch(/from "\.\/model"/);
    // A second comparison would be the drift this test exists to prevent.
    expect(src).not.toMatch(/baseline\.tier_id\s*!==/);
    expect(src).not.toMatch(/pricing_source\s*!==/);
  });

  it("only model.ts defines the comparison", () => {
    const definers = allSourceFiles().filter((f) =>
      /export function isCustomBaselineStale/.test(read(f)),
    );
    expect(definers).toEqual([MODEL]);
  });

  it("the model is pure: no I/O, no Date.now, no randomness in the fingerprint path", () => {
    const src = read(MODEL);
    expect(src).not.toMatch(/Date\.now|Math\.random|new Date\(/);
  });
});

// ─── 3. No Apple price-point id ever reaches storage ─────────────────────────

describe("storage never holds an Apple price-point id (gate G2)", () => {
  it("neither the model nor the repository declares a price-point id field", () => {
    for (const rel of [MODEL, REPOSITORY]) {
      const src = readCodeOnly(rel);
      expect(
        /price_point_id|pricePointId/.test(src),
        `${rel} must not carry a price-point id. Apple's id is per-IAP and ` +
          "cannot exist before the IAP does, which is exactly why customs are " +
          "stored as (territory, price) and resolved server-side at submit — " +
          "the property that makes Create and Edit structurally identical. A " +
          "stored id would also go stale when Apple withdraws a price point.",
      ).toBe(false);
    }
  });

  it("the migration creates only the four intended columns, no id column", () => {
    const files = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) =>
      /_iap_mgmt_custom_prices\.sql$/.test(f),
    );
    expect(files).toHaveLength(1);
    const sql = read(join("supabase", "migrations", files[0]));
    const table = sql.slice(
      sql.indexOf("CREATE TABLE iap_mgmt.iap_custom_prices"),
    );
    const body = table.slice(0, table.indexOf(");"));
    expect(body).toMatch(/PRIMARY KEY \(iap_id, territory_code\)/);
    expect(body).toMatch(/customer_price\s+NUMERIC\(18, ?4\)/);
    expect(/price_point/i.test(body)).toBe(false);
  });
});

// ─── Sanity: the fitness scan can actually see the module ────────────────────

describe("self-check — the structural scan is not blind", () => {
  it("finds the custom-prices module files it is asserting about", () => {
    const files = readdirSync(CUSTOM_PRICES_DIR);
    expect(files).toContain("model.ts");
    expect(files).toContain("repository.ts");
    // If allSourceFiles() ever stops walking lib/, every assertion above would
    // pass vacuously against an empty list.
    const scanned = allSourceFiles();
    expect(scanned).toContain(MODEL);
    expect(scanned).toContain(REPOSITORY);
    expect(scanned.length).toBeGreaterThan(200);
  });
});
