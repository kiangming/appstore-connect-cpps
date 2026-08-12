/**
 * Generic mechanism for the cross-module audit-constraint guard (meta-rule P2).
 *
 * P2: a value emitted in code but absent from its table's CHECK constraint
 * makes every one of those audit INSERTs fail. Depending on the module the
 * failure is either SILENT (a bare `.insert()` whose error is logged but never
 * thrown — iap_mgmt, google_iap_mgmt) or LOUD (an INSERT inside a plpgsql
 * `*_tx` function, where the raise aborts the whole transaction including the
 * data write — store_mgmt). Silent is the dangerous one; loud is merely
 * expensive.
 *
 * This file holds the MECHANISM only — migration discovery, constraint
 * parsing, source scanning. Which modules exist and where their truth lives is
 * declared once in `registry.ts`. One mechanism, N declarations: four
 * near-copies of a guard would drift apart, which is the same twin-path
 * failure (KB P1/P8) this guard exists to prevent.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export const REPO_ROOT = join(__dirname, "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/**
 * Looks like an enum constant: all-caps, optional underscores, ≥4 chars.
 *
 * The length floor is what drops unrelated SCREAMING literals appearing inside
 * a harvested statement — specifically `target === "ALL"` in the iap_mgmt
 * availability ternary.
 *
 * ⚠ An earlier version REQUIRED an underscore. Every iap_mgmt action type has
 * one, so it looked correct — but it silently dropped `EMAIL` and `COMMENT`
 * (store_mgmt entry types, single words), i.e. the heuristic was hiding real
 * emissions. The guard's own "every declared value is either emitted or
 * explicitly unused" assertion is what caught it. Keep that assertion: it is
 * the check that finds a blind spot in the scanner itself, not just in the
 * codebase.
 */
export const ENUM_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ENUM_MIN_LENGTH = 4;

// ─── Migration discovery + constraint parsing ────────────────────────────────

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // YYYYMMDDHHMMSS_ prefix ⇒ lexicographic === chronological
}

/**
 * Every `<schema>.actions_log`-shaped audit table created anywhere in the
 * migrations, discovered rather than assumed. A table created without a schema
 * qualifier is reported as `public`.
 *
 * This is what makes the guard cover FUTURE modules: the completeness test
 * asserts every discovered table has a registry entry, so a new module's
 * audit table fails the build until it is registered.
 */
export function discoverAuditTables(tableNames: readonly string[]): Array<{
  schema: string;
  table: string;
  migration: string;
}> {
  const found: Array<{ schema: string; table: string; migration: string }> = [];
  const seen = new Set<string>();
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const table of tableNames) {
      const re = new RegExp(
        `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(\\w+)\\.)?${table}\\b`,
        "gi",
      );
      for (const m of sql.matchAll(re)) {
        const schema = m[1] ?? "public";
        const key = `${schema}.${table}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ schema, table, migration: file });
      }
    }
  }
  return found;
}

/**
 * Pull the value list out of a `CHECK (<column> IN ('A','B',…))` for a specific
 * `<schema>.<table>`, handling both forms present in this repo:
 *
 *   inline  — CREATE TABLE s.t ( col TEXT NOT NULL CHECK (col IN (…)) )
 *   altered — ALTER TABLE s.t ADD CONSTRAINT … CHECK (col IN (…))
 *
 * Anchors on the statement first, so a migration header comment that happens
 * to list the same values cannot pollute the parse.
 */
function extractCheckValues(
  sql: string,
  schema: string,
  table: string,
  column: string,
): string[] | null {
  const anchors: number[] = [];
  const alter = new RegExp(
    `ALTER\\s+TABLE\\s+${schema}\\.${table}\\b`,
    "gi",
  );
  for (const m of sql.matchAll(alter)) anchors.push(m.index!);
  const create = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${schema}\\.${table}\\b`,
    "gi",
  );
  for (const m of sql.matchAll(create)) anchors.push(m.index!);
  if (anchors.length === 0) return null;

  const inList = new RegExp(`${column}\\s+IN\\s*\\(`, "i");
  // Last anchor wins within a single file — a file that both creates and later
  // alters the table (none today) should be read as its final state.
  for (const anchor of anchors.sort((a, b) => b - a)) {
    const tail = sql.slice(anchor);
    const m = inList.exec(tail);
    if (!m) continue;
    const start = m.index + m[0].length;
    const end = tail.indexOf(")", start);
    if (end < 0) continue;
    const values = [...tail.slice(start, end).matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(
      (x) => x[1],
    );
    if (values.length > 0) return values;
  }
  return null;
}

export interface ResolvedConstraint {
  migration: string;
  values: string[];
}

/**
 * The NEWEST migration that defines the CHECK for `<schema>.<table>.<column>`,
 * plus its value list. Newest matters: an older migration's narrower list is
 * not the live constraint.
 */
export function resolveLatestConstraint(
  schema: string,
  table: string,
  column: string,
): ResolvedConstraint | null {
  let latest: ResolvedConstraint | null = null;
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const values = extractCheckValues(sql, schema, table, column);
    if (values) latest = { migration: file, values };
  }
  return latest;
}

// ─── Source scanning ─────────────────────────────────────────────────────────

/**
 * One emission SHAPE. Every shape carries a self-check sentinel in the
 * registry — a value only reachable through that shape — so a pattern that
 * silently stops matching fails the build instead of finding zero violations
 * and passing vacuously. That property is the whole point of the guard;
 * removing a sentinel removes the guard.
 */
export interface EmissionShape {
  /** Stable label, also the key the registry's sentinel map uses. */
  shape: string;
  /** Must be a global regex. Capture group 1 = the value; when absent, every
   *  enum-shaped literal inside match[0] is harvested (ternaries, multi-line
   *  bindings). */
  re: RegExp;
  /**
   * `"both"` — this shape can prove a violation (an undeclared value here is a
   *   real finding) AND prove coverage.
   * `"coverage-only"` — the surrounding statement contains unrelated
   *   SCREAMING_SNAKE literals that cannot be told apart from audit values, so
   *   only literals already known to the declared set are harvested. Such a
   *   shape proves the scanner is alive and that declared values are really
   *   emitted, but CANNOT surface an undeclared one. Declared explicitly
   *   rather than hidden — a blind spot named is a blind spot managed.
   */
  contributes: "both" | "coverage-only";
}

export interface ScanTarget {
  /** Repo-relative directories to walk. */
  roots: readonly string[];
  /** File extensions to read. */
  extensions: readonly string[];
  /** Only files whose basename matches are read (used to scope SQL scans to
   *  one module's migrations). */
  fileFilter?: RegExp;
}

export interface ScanHit {
  value: string;
  file: string;
  shape: string;
  contributes: EmissionShape["contributes"];
}

function walk(
  dir: string,
  target: ScanTarget,
  out: string[] = [],
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // absent tree ⇒ nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, target, out);
      continue;
    }
    if (!target.extensions.some((e) => full.endsWith(e))) continue;
    if (full.endsWith(".test.ts") || full.endsWith(".test.tsx")) continue;
    if (target.fileFilter && !target.fileFilter.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Harvest every emitted value from a module's sources.
 *
 * `declared` is only consulted for `coverage-only` shapes, where non-declared
 * literals are indistinguishable from unrelated constants in the same
 * statement and are therefore skipped.
 */
export function scanEmissions(
  target: ScanTarget,
  shapes: readonly EmissionShape[],
  declared: readonly string[],
): ScanHit[] {
  const declaredSet = new Set<string>(declared);
  const hits: ScanHit[] = [];
  for (const root of target.roots) {
    for (const file of walk(join(REPO_ROOT, root), target)) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(REPO_ROOT.length + 1);
      for (const { shape, re, contributes } of shapes) {
        // Fresh regex per file: shared /g lastIndex would skip matches.
        for (const m of src.matchAll(new RegExp(re.source, re.flags))) {
          const candidates =
            m[1] !== undefined
              ? [m[1]]
              : [...m[0].matchAll(/'([A-Z][A-Z0-9_]+)'|"([A-Z][A-Z0-9_]+)"/g)].map(
                  (x) => x[1] ?? x[2],
                );
          for (const value of candidates) {
            if (!value || value.length < ENUM_MIN_LENGTH) continue;
            if (!ENUM_SHAPED.test(value)) continue;
            if (contributes === "coverage-only" && !declaredSet.has(value)) continue;
            hits.push({ value, file: rel, shape, contributes });
          }
        }
      }
    }
  }
  return hits;
}
