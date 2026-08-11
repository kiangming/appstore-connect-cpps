/**
 * STRUCTURAL GUARD for meta-rule P2 — `actions_log.action_type` drift.
 *
 * P2 was documented in the knowledge base and then recurred anyway: the
 * Cycle 37/39/40 availability paths emitted AVAILABILITY_SET_ALL_TERRITORIES
 * and AVAILABILITY_REMOVE_FROM_SALES for months while the DB CHECK constraint
 * had neither, so every one of those audit INSERTs was silently rejected.
 *
 * A rule that relies on a contributor remembering it is not a guard. These
 * tests make the drift fail at `npm test` instead of failing silently in
 * production, in two layers:
 *
 *   Layer 1 — PARITY: the latest migration that redefines
 *     `actions_log_action_type_check` must list exactly the values in
 *     `IAP_ACTION_TYPES`, both directions.
 *
 *   Layer 2 — SOURCE SCAN: every action-type string literal in an emitting
 *     position across the Apple-IAP tree must be a member of
 *     `IAP_ACTION_TYPES`; and every member must be either found by the scan
 *     or explicitly listed in `UNUSED_ACTION_TYPES`. The scanner also
 *     self-checks against sentinels covering each emission SHAPE, so a
 *     scanner that stops matching fails loudly rather than passing vacuously.
 *
 * Deliberately a static fitness test (same shape as rbac-posture.test.ts) —
 * no DB connection, so it runs in CI and locally with no setup.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  IAP_ACTION_TYPES,
  UNUSED_ACTION_TYPES,
  isIapActionType,
} from "./action-types";

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Source trees that may emit an Apple-IAP `action_type`. Deliberately
 *  excludes the Google module — `google_iap_mgmt.actions_log` is a separate
 *  table with its own, different CHECK constraint. */
const SCAN_ROOTS = [
  "lib/iap-management",
  "app/api/iap-management",
  "app/(dashboard)/iap-management",
  "components/iap-management",
];

// ─── Layer 1 — parity with the latest migration ──────────────────────────────

/**
 * Find the newest migration filename that redefines the constraint on
 * `iap_mgmt.actions_log` (NOT `google_iap_mgmt.actions_log`). Migrations sort
 * lexicographically by their `YYYYMMDDHHMMSS_` prefix, so "newest" is just the
 * last match.
 */
function latestIapConstraintMigration(): string {
  const matches = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      return (
        /ALTER\s+TABLE\s+iap_mgmt\.actions_log/i.test(sql) &&
        /ADD\s+CONSTRAINT\s+actions_log_action_type_check/i.test(sql)
      );
    });
  if (matches.length === 0) {
    throw new Error(
      "No migration found that adds actions_log_action_type_check on iap_mgmt.actions_log",
    );
  }
  return matches[matches.length - 1];
}

/** Extract the quoted values from the migration's `CHECK (action_type IN (…))`. */
function constraintValuesFrom(sqlFile: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, sqlFile), "utf8");
  // Take the text after the ADD CONSTRAINT … IN ( up to the closing )); so a
  // header comment listing the same values can't pollute the parse.
  const start = sql.search(
    /ADD\s+CONSTRAINT\s+actions_log_action_type_check\s+CHECK\s*\(\s*action_type\s+IN\s*\(/i,
  );
  expect(start, `IN(...) list not found in ${sqlFile}`).toBeGreaterThanOrEqual(0);
  const tail = sql.slice(start);
  const end = tail.indexOf("));");
  expect(end, `unterminated IN(...) list in ${sqlFile}`).toBeGreaterThan(0);
  const body = tail.slice(0, end);
  return [...body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
}

describe("P2 guard · Layer 1 — IAP_ACTION_TYPES ⟷ latest CHECK constraint", () => {
  const migration = latestIapConstraintMigration();
  const constraintValues = constraintValuesFrom(migration);

  it("resolves the newest iap_mgmt constraint migration (not the Google one)", () => {
    expect(migration).toMatch(/^\d{14}_iap_mgmt_/);
    expect(constraintValues.length).toBeGreaterThan(0);
  });

  it("every code-side action type is allowed by the constraint", () => {
    const allowed = new Set(constraintValues);
    const missingFromDb = IAP_ACTION_TYPES.filter((t) => !allowed.has(t));
    expect(
      missingFromDb,
      `These action types exist in code but NOT in ${migration}'s CHECK. ` +
        "Every INSERT using them would be silently rejected (P2). " +
        "Add a new forward-only migration widening the CHECK.",
    ).toEqual([]);
  });

  it("the constraint allows nothing the code side doesn't declare", () => {
    const declared = new Set<string>(IAP_ACTION_TYPES);
    const missingFromCode = constraintValues.filter((t) => !declared.has(t));
    expect(
      missingFromCode,
      `${migration}'s CHECK allows these values but lib/iap-management/action-types.ts ` +
        "does not declare them. Keep the two in lockstep — a value only in SQL " +
        "means the type union can't describe a row that already exists.",
    ).toEqual([]);
  });

  it("declares no duplicates on either side", () => {
    expect(new Set(IAP_ACTION_TYPES).size).toBe(IAP_ACTION_TYPES.length);
    expect(new Set(constraintValues).size).toBe(constraintValues.length);
  });

  it("pins the two values the P2 recurrence was about", () => {
    // Regression pin: these are the values that were emitted in production
    // with no constraint entry. If a future edit drops them, this fails.
    expect(constraintValues).toContain("AVAILABILITY_SET_ALL_TERRITORIES");
    expect(constraintValues).toContain("AVAILABILITY_REMOVE_FROM_SALES");
  });
});

// ─── Layer 2 — source scan ───────────────────────────────────────────────────

function walkTs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // tree absent → nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTs(full, out);
    } else if (
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Looks like an action-type constant: SCREAMING_SNAKE with ≥1 underscore.
 *  The underscore requirement filters out unrelated SCREAMING literals in the
 *  same expressions (e.g. `target === "ALL"` in the availability ternary). */
const ACTION_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * The four emission SHAPES present in the codebase. Each is a separate
 * pattern, and each is covered by a sentinel in the self-check below, so a
 * pattern that silently stops matching is a test failure, not a quiet pass.
 */
const EMISSION_PATTERNS: ReadonlyArray<{ shape: string; re: RegExp }> = [
  {
    // 1. object-literal insert:  action_type: "CREATE_ON_APPLE",
    shape: "object-literal",
    re: /action_type:\s*"([A-Z][A-Z0-9_]+)"/g,
  },
  {
    // 2. positional helper arg:  writeAuditRow(audit, "UPDATE_ATTRIBUTES_ON_APPLE", {
    shape: "positional-helper-arg",
    re: /writeAuditRow\(\s*[^)]*?"([A-Z][A-Z0-9_]+)"/g,
  },
  {
    // 3. assignment to an action_type / actionType binding, including the
    //    multi-line ternary form. Captured as a whole statement, then every
    //    action-shaped literal inside it is collected. No `s` flag needed
    //    (and it would break the ES2017 target): `[^;]` already spans
    //    newlines, which is what makes the multi-line ternary match.
    shape: "action-type-binding",
    re: /(?:const|let|var)\s+(?:action_type|actionType)\b[^;]*;/g,
  },
  {
    // 4. explicitly typed helper signature default / cast:
    //    actionType: IapActionType = "SYNC_STATE_FROM_APPLE"
    shape: "typed-binding",
    re: /(?:action_type|actionType)\s*:\s*IapActionType\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  },
];

interface ScanHit {
  value: string;
  file: string;
  shape: string;
}

function scanEmittedActionTypes(): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTs(join(ROOT, root))) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(ROOT.length + 1);
      for (const { shape, re } of EMISSION_PATTERNS) {
        for (const m of src.matchAll(new RegExp(re.source, re.flags))) {
          // Shape 3 captures a whole statement; harvest every literal in it.
          const candidates =
            m[1] !== undefined
              ? [m[1]]
              : [...m[0].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((x) => x[1]);
          for (const value of candidates) {
            if (ACTION_SHAPED.test(value)) hits.push({ value, file: rel, shape });
          }
        }
      }
    }
  }
  return hits;
}

describe("P2 guard · Layer 2 — every emitted action type is a declared one", () => {
  const hits = scanEmittedActionTypes();
  const scanned = new Set(hits.map((h) => h.value));

  it("the scanner sees a plausible number of emissions", () => {
    // Sanity floor: if a refactor moves the audit writes somewhere the
    // scanner can't see, the count collapses and this fails.
    expect(hits.length).toBeGreaterThanOrEqual(25);
    expect(scanned.size).toBeGreaterThanOrEqual(18);
  });

  it("SELF-CHECK: every emission shape is still matched by its pattern", () => {
    // One sentinel per shape, each only reachable through that shape:
    //   object-literal        → SET_PRICE_SCHEDULE (pricing-orchestration)
    //   positional-helper-arg → UPDATE_ATTRIBUTES_ON_APPLE (update-orchestration)
    //   action-type-binding   → AVAILABILITY_REMOVE_FROM_SALES (ternary only —
    //                           this is the exact value the P2 recurrence lost)
    const shapesSeen = new Map<string, Set<string>>();
    for (const h of hits) {
      if (!shapesSeen.has(h.shape)) shapesSeen.set(h.shape, new Set());
      shapesSeen.get(h.shape)!.add(h.value);
    }
    // `?? []` matters: when a pattern matches NOTHING its map entry is absent,
    // and asserting `.toContain` on `undefined` makes vitest complain about the
    // argument type instead of reporting the real problem. A guard whose
    // failure message is confusing is a guard people learn to ignore.
    const seen = (shape: string) => [...(shapesSeen.get(shape) ?? [])];
    expect(
      seen("object-literal"),
      "object-literal pattern matched nothing — the scanner is blind",
    ).toContain("SET_PRICE_SCHEDULE");
    expect(
      seen("positional-helper-arg"),
      "positional-helper pattern matched nothing — indirect audit writes are unscanned",
    ).toContain("UPDATE_ATTRIBUTES_ON_APPLE");
    expect(
      seen("action-type-binding"),
      "ternary/binding pattern matched nothing — this is the exact shape the " +
        "P2 recurrence hid in (bulk-availability.ts / update-orchestration.ts)",
    ).toContain("AVAILABILITY_REMOVE_FROM_SALES");
  });

  it("no emitted action type is undeclared", () => {
    const undeclared = hits.filter((h) => !isIapActionType(h.value));
    expect(
      undeclared.map((h) => `${h.value} (${h.file}, via ${h.shape})`),
      "These action types are emitted in code but not declared in " +
        "lib/iap-management/action-types.ts — so they are almost certainly " +
        "missing from the DB CHECK too, and their audit rows are being " +
        "silently rejected (P2). Declare them AND add a migration.",
    ).toEqual([]);
  });

  it("every declared action type is either emitted or explicitly unused", () => {
    const unused = new Set<string>(UNUSED_ACTION_TYPES);
    const orphans = IAP_ACTION_TYPES.filter(
      (t) => !scanned.has(t) && !unused.has(t),
    );
    expect(
      orphans,
      "Declared but neither found in code nor listed in UNUSED_ACTION_TYPES. " +
        "Either the value is dead (add it to UNUSED_ACTION_TYPES with a reason) " +
        "or it is emitted through a shape EMISSION_PATTERNS cannot see — in " +
        "which case add the shape, or the guard has a blind spot.",
    ).toEqual([]);
  });

  it("UNUSED_ACTION_TYPES really are unused", () => {
    const wronglyUnused = UNUSED_ACTION_TYPES.filter((t) => scanned.has(t));
    expect(
      wronglyUnused,
      "Listed as unused but found in an emitting position — remove from UNUSED_ACTION_TYPES.",
    ).toEqual([]);
  });
});
