/**
 * CROSS-MODULE STRUCTURAL GUARD for meta-rule P2 — audit-column CHECK drift.
 *
 * Supersedes lib/iap-management/action-types.test.ts (single-module). One
 * mechanism (`guard.ts`) driven by N declarations (`registry.ts`), because four
 * near-copies of a guard would drift apart — the same twin-path failure the
 * guard exists to prevent (KB P1/P8).
 *
 * Properties preserved from the single-module original, all load-bearing:
 *   · exact set-equality parity, BOTH directions, against the NEWEST migration
 *     that defines each module's constraint
 *   · a source scan across every emission shape that module actually uses
 *   · ⚠ SELF-CHECK SENTINELS — one per shape per module. Without them a pattern
 *     that silently stops matching finds zero violations and PASSES VACUOUSLY.
 *     This is the single most important property in this file.
 *   · failure messages that name the file to edit and the fix to make
 *
 * Plus one property the single-module version could not have:
 *   · DISCOVERY COMPLETENESS — every `<schema>.actions_log` present in the
 *     migrations must have a registry entry, so a future module is covered
 *     without anyone remembering to extend this file.
 */
import { describe, it, expect } from "vitest";
import {
  AUDIT_CONSTRAINT_MODULES,
  AUDIT_TABLE_NAMES,
  INTENTIONALLY_UNSENTINELLED,
} from "./registry";
import {
  discoverAuditTables,
  resolveLatestConstraint,
  scanEmissions,
} from "./guard";

// ─── Discovery completeness ──────────────────────────────────────────────────

describe("P2 guard · discovery — every audit table in the repo is registered", () => {
  const discovered = discoverAuditTables(AUDIT_TABLE_NAMES);

  it("finds the audit tables we know exist", () => {
    const keys = discovered.map((d) => `${d.schema}.${d.table}`);
    expect(keys).toContain("iap_mgmt.actions_log");
    expect(keys).toContain("google_iap_mgmt.actions_log");
    expect(keys).toContain("store_mgmt.ticket_entries");
  });

  it("every discovered audit table has a registry entry", () => {
    const registered = new Set(
      AUDIT_CONSTRAINT_MODULES.map((m) => `${m.schema}.${m.table}`),
    );
    const unregistered = discovered
      .map((d) => `${d.schema}.${d.table} (created in ${d.migration})`)
      .filter((s) => !registered.has(s.split(" ")[0]));
    expect(
      unregistered,
      "An audit table exists in the migrations with no entry in " +
        "lib/audit-constraints/registry.ts, so its enumerated column is " +
        "UNGUARDED against P2 drift. Add a module declaration (declared value " +
        "set, emission shapes, one sentinel per shape).",
    ).toEqual([]);
  });

  it("every registry entry points at a table that exists", () => {
    const keys = new Set(discovered.map((d) => `${d.schema}.${d.table}`));
    const phantom = AUDIT_CONSTRAINT_MODULES.map(
      (m) => `${m.schema}.${m.table}`,
    ).filter((k) => !keys.has(k));
    expect(
      phantom,
      "Registry declares a table no migration creates — stale entry or a typo " +
        "in schema/table, which would make its parity test silently vacuous.",
    ).toEqual([]);
  });
});

// ─── Per-module: parity + scan + sentinels ───────────────────────────────────

describe.each(AUDIT_CONSTRAINT_MODULES.map((m) => [m.label, m] as const))(
  "P2 guard · %s",
  (_label, mod) => {
    const resolved = resolveLatestConstraint(mod.schema, mod.table, mod.column);
    const hits = scanEmissions(mod.scan, mod.shapes, mod.declared);
    const scanned = new Set(hits.map((h) => h.value));

    // ── Layer 1 — parity ────────────────────────────────────────────────────

    it("resolves the newest migration defining the CHECK", () => {
      expect(
        resolved,
        `No migration defines CHECK (${mod.column} IN (…)) for ` +
          `${mod.schema}.${mod.table}. Without it every assertion below is ` +
          "vacuous — fix the schema/table/column in the registry.",
      ).not.toBeNull();
      expect(resolved!.values.length).toBeGreaterThan(0);
    });

    it("every declared value is allowed by the constraint", () => {
      const allowed = new Set(resolved!.values);
      const missingFromDb = mod.declared.filter((v) => !allowed.has(v));
      expect(
        missingFromDb,
        `Declared in ${mod.truthFile} but NOT in ${resolved!.migration}'s ` +
          `CHECK. Every INSERT using them ${
            mod.failureMode === "silent"
              ? "is SILENTLY rejected (the audit row just never exists)"
              : "RAISES and rolls back the surrounding transaction, failing the " +
                "user-visible action"
          }. Fix: new forward-only migration widening the CHECK.`,
      ).toEqual([]);
    });

    it("the constraint allows nothing the code side doesn't declare", () => {
      const declared = new Set<string>(mod.declared);
      const missingFromCode = resolved!.values.filter((v) => !declared.has(v));
      expect(
        missingFromCode,
        `${resolved!.migration}'s CHECK allows these but ${mod.truthFile} does ` +
          "not declare them. Keep both in lockstep — a value only in SQL means " +
          "the type union cannot describe a row that already exists.",
      ).toEqual([]);
    });

    it("declares no duplicates on either side", () => {
      expect(new Set(mod.declared).size).toBe(mod.declared.length);
      expect(new Set(resolved!.values).size).toBe(resolved!.values.length);
    });

    if (mod.regressionPins.length > 0) {
      it("pins the values a past P2 incident lost", () => {
        for (const pin of mod.regressionPins) {
          expect(
            resolved!.values,
            `${pin} was emitted in production with no constraint entry once ` +
              "already. It must never leave the CHECK again.",
          ).toContain(pin);
        }
      });
    }

    // ── Layer 2 — source scan ───────────────────────────────────────────────

    it("the scanner sees emissions at all", () => {
      expect(
        hits.length,
        `Zero emissions found under ${mod.scan.roots.join(", ")}. Either the ` +
          "roots are wrong or every shape stopped matching — in both cases the " +
          "scan is blind and would report a clean module no matter what.",
      ).toBeGreaterThan(0);
    });

    it("SELF-CHECK: every emission shape is still matched by its pattern", () => {
      const byShape = new Map<string, Set<string>>();
      for (const h of hits) {
        if (!byShape.has(h.shape)) byShape.set(h.shape, new Set());
        byShape.get(h.shape)!.add(h.value);
      }
      // `?? []` matters: an unmatched shape has NO map entry, and asserting
      // .toContain on undefined makes vitest complain about the argument type
      // instead of reporting the real problem. A guard whose failure message is
      // confusing is one people learn to ignore.
      for (const shape of mod.shapes) {
        const sentinel = mod.sentinels[shape.shape];
        if (!sentinel) {
          // Allowed ONLY when declared intentionally sentinel-free.
          expect(
            INTENTIONALLY_UNSENTINELLED,
            `Shape "${shape.shape}" on ${mod.label} has no sentinel. A shape ` +
              "with no sentinel can silently stop matching and the guard will " +
              "still pass. Add a sentinel, or list it in " +
              "INTENTIONALLY_UNSENTINELLED with a reason.",
          ).toContain(`${mod.label}::${shape.shape}`);
          continue;
        }
        expect(
          [...(byShape.get(shape.shape) ?? [])],
          `Shape "${shape.shape}" no longer finds its sentinel "${sentinel}". ` +
            "The pattern has gone blind — it will now find zero violations and " +
            "pass vacuously. Fix the pattern, do not delete the sentinel.",
        ).toContain(sentinel);
      }
    });

    it("no emitted value is undeclared", () => {
      const declared = new Set<string>(mod.declared);
      const undeclared = hits
        .filter((h) => h.contributes === "both" && !declared.has(h.value))
        .map((h) => `${h.value} (${h.file}, via ${h.shape})`);
      expect(
        [...new Set(undeclared)],
        `Emitted in code but not declared in ${mod.truthFile} — so almost ` +
          "certainly missing from the DB CHECK too. Declare it AND add a " +
          "forward-only migration.",
      ).toEqual([]);
    });

    it("every declared value is either emitted or explicitly unused", () => {
      const unused = new Set(mod.unused.map((u) => u.value));
      const orphans = mod.declared.filter(
        (v) => !scanned.has(v) && !unused.has(v),
      );
      expect(
        orphans,
        "Declared but neither found in code nor listed in this module's " +
          "`unused` set. Either the value is dead (add it to `unused` WITH A " +
          "REASON — never drop it from the CHECK, Postgres validates a " +
          "recreated CHECK against existing rows) or it is emitted through a " +
          "shape the patterns cannot see, i.e. the guard has a blind spot.",
      ).toEqual([]);
    });

    it("`unused` entries really are unused, and each carries a reason", () => {
      const wronglyUnused = mod.unused
        .filter((u) => scanned.has(u.value))
        .map((u) => u.value);
      expect(
        wronglyUnused,
        "Listed as unused but found in an emitting position — remove from `unused`.",
      ).toEqual([]);
      for (const u of mod.unused) {
        expect(u.reason.length, `\`unused\` entry ${u.value} needs a reason`).
          toBeGreaterThan(20);
      }
    });

    // ── Declared limitations, surfaced rather than implicit ──────────────────

    it(`records its scan limitations (${mod.scanLimitations.length}) and failure mode (${mod.failureMode})`, () => {
      // Not a behavioural assertion — this exists so `npm test -t "P2 guard"`
      // output states each module's blind spots and severity out loud. A blind
      // spot named is a blind spot managed; an unnamed one is the bug.
      expect(mod.failureModeEvidence.length).toBeGreaterThan(40);
      for (const lim of mod.scanLimitations) {
        expect(lim.length).toBeGreaterThan(20);
      }
    });
  },
);
