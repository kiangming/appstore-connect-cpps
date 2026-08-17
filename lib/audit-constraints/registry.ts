/**
 * Registry of every audit table whose enumerated column is guarded against
 * CHECK-constraint drift (meta-rule P2). One declaration per module; the
 * mechanism lives in `guard.ts`.
 *
 * ⚠ ADDING A MODULE: you do not have to remember to. `guard.test.ts` discovers
 * every `<schema>.actions_log` in the migrations directory and fails if one has
 * no entry here. That completeness check is what makes this cross-module rather
 * than "the four modules someone thought of in August 2026".
 *
 * ⚠ EMISSION SHAPES ARE NOT PORTABLE BETWEEN MODULES (KB P8, twin-structure
 * asymmetry). iap_mgmt writes `action_type: "X"` inline plus two positional
 * helpers; google_iap_mgmt funnels everything through `appendAction({
 * actionType })`; store_mgmt emits mostly from plpgsql INSERTs inside `*_tx`
 * functions. Each module therefore declares its own shapes AND its own
 * sentinels — one sentinel per shape, each a value reachable ONLY through that
 * shape, so a pattern that stops matching fails loudly instead of finding zero
 * violations and passing.
 */
import type { EmissionShape, ScanTarget } from "./guard";
import { IAP_ACTION_TYPES } from "@/lib/iap-management/action-types";
import { GOOGLE_ACTION_TYPES } from "@/lib/google-iap-management/repository/actions-log";
import { ticketEntryTypeSchema } from "@/lib/store-submissions/schemas/ticket";

/** Audit-table names the discovery sweep looks for across all migrations. */
export const AUDIT_TABLE_NAMES = ["actions_log", "ticket_entries"] as const;

export interface AuditConstraintModule {
  /** Human label used in test names. */
  label: string;
  schema: string;
  table: string;
  column: string;
  /** Where the code-side truth lives, for failure messages. */
  truthFile: string;
  /** The runtime-enumerable declared value set. */
  declared: readonly string[];
  /**
   * Declared + allowed by the CHECK but emitted by no current code path.
   * RETAINED deliberately: Postgres validates a recreated CHECK against
   * existing rows, so dropping a value historical rows carry makes the ALTER
   * fail. Each entry needs a reason.
   */
  unused: ReadonlyArray<{ value: string; reason: string }>;
  /** Values pinned as regression anchors (a past incident's fingerprint). */
  regressionPins: readonly string[];
  scan: ScanTarget;
  shapes: readonly EmissionShape[];
  /** shape → a value only that shape can find. */
  sentinels: Readonly<Record<string, string>>;
  /**
   * How a constraint violation manifests at runtime. Drives nothing in the
   * test; recorded because it is the severity fact the audit had to establish,
   * and a future reader will want it without re-deriving it.
   */
  failureMode: "silent" | "loud-transactional";
  failureModeEvidence: string;
  /** Stated limitations of this module's scan. Surfaced in a test name so a
   *  blind spot is never implicit. */
  scanLimitations: readonly string[];
}

const TS_EXT = [".ts", ".tsx"] as const;

// ─── iap_mgmt ────────────────────────────────────────────────────────────────

const IAP_MGMT: AuditConstraintModule = {
  label: "iap_mgmt.actions_log.action_type (Apple IAP)",
  schema: "iap_mgmt",
  table: "actions_log",
  column: "action_type",
  truthFile: "lib/iap-management/action-types.ts",
  declared: IAP_ACTION_TYPES,
  unused: [
    {
      value: "UPLOAD_SCREENSHOT",
      reason:
        "From the 20260515 init. Superseded by REPLACE_SCREENSHOT_ON_APPLE; historical rows may carry it.",
    },
    {
      value: "SYNC_FROM_APPLE",
      reason:
        "From the 20260515 init. Superseded by SYNC_STATE_FROM_APPLE; historical rows may carry it.",
    },
  ],
  regressionPins: [
    // The two values emitted in production with no constraint entry —
    // migration 20260811000000. If an edit ever drops them, parity fails.
    "AVAILABILITY_SET_ALL_TERRITORIES",
    "AVAILABILITY_REMOVE_FROM_SALES",
    // Per-territory availability (20260817000000). Pinned on arrival rather
    // than after an incident: it is emitted from a ternary binding — the
    // exact shape whose scanner gap caused the P2 recurrence — and its
    // sibling SET_ALL_TERRITORIES survives, so a regression that collapses
    // the two would silently relabel subsets as "all" and lose nothing the
    // parity check would otherwise notice.
    "AVAILABILITY_SET_TERRITORIES",
  ],
  scan: {
    roots: [
      "lib/iap-management",
      "app/api/iap-management",
      "app/(dashboard)/iap-management",
      "components/iap-management",
    ],
    extensions: TS_EXT,
  },
  shapes: [
    {
      // action_type: "CREATE_ON_APPLE",
      shape: "object-literal",
      re: /action_type:\s*"([A-Z][A-Z0-9_]+)"/g,
      contributes: "both",
    },
    {
      // writeAuditRow(audit, "UPDATE_ATTRIBUTES_ON_APPLE", { … })
      //
      // `[^{)]` — not `[^)]` — deliberately: it stops the scan at the payload
      // object's `{`. When the action type is a VARIABLE
      // (`writeAuditRow(actor, iapId, action_type, { result: "ERROR" … })`) a
      // `[^)]` window walks into the payload and mis-reports `"ERROR"` /
      // `"SUCCESS"` as an action type — a false violation, which erodes trust
      // in the guard just as effectively as a missed one.
      shape: "positional-helper-arg",
      re: /writeAuditRow\(\s*[^{)]*?"([A-Z][A-Z0-9_]+)"/g,
      contributes: "both",
    },
    {
      // const actionType = target === "ALL" ? "A" : "B";   (multi-line)
      // No `s` flag — `[^;]` already spans newlines, and `s` breaks the
      // ES2017 target.
      shape: "action-type-binding",
      re: /(?:const|let|var)\s+(?:action_type|actionType)\b[^;]*;/g,
      contributes: "both",
    },
  ],
  sentinels: {
    "object-literal": "SET_PRICE_SCHEDULE",
    "positional-helper-arg": "UPDATE_ATTRIBUTES_ON_APPLE",
    // Reachable ONLY through the ternary binding — and it is the exact value
    // the P2 recurrence lost.
    "action-type-binding": "AVAILABILITY_REMOVE_FROM_SALES",
  },
  failureMode: "silent",
  failureModeEvidence:
    "Separate `.insert()` after the Apple call already succeeded; " +
    "pricing-orchestration.ts:417-487, update-orchestration.ts:714-730 and " +
    "bulk-availability.ts:298-311 log the `{error}` and never throw, and the " +
    "bare inserts (create-on-apple/route.ts:377, execute/route.ts:846) discard " +
    "it. supabase-js returns `{error}` rather than throwing, so nothing " +
    "propagates. No RPC, no transaction — the codebase notes supabase-js has " +
    "none (queries/templates.ts:460, queries/price-tiers.ts:6).",
  scanLimitations: [],
};

// ─── google_iap_mgmt ─────────────────────────────────────────────────────────

const GOOGLE_IAP_MGMT: AuditConstraintModule = {
  label: "google_iap_mgmt.actions_log.action_type (Google IAP)",
  schema: "google_iap_mgmt",
  table: "actions_log",
  column: "action_type",
  truthFile: "lib/google-iap-management/repository/actions-log.ts",
  declared: GOOGLE_ACTION_TYPES,
  unused: [
    {
      value: "IAP_DELETE",
      reason:
        "Declared since the 20260520010000 init; the module soft-deletes via " +
        "deleted_on_google_at + IAP_ACKNOWLEDGE_REMOVE instead, so no path " +
        "emits it. Historical rows may carry it.",
    },
  ],
  regressionPins: [
    // Added by 20260702120000 after they had been emitted since Cycle 41 with
    // no constraint entry — the Google instance of P2, already fixed. Pinned so
    // it cannot regress.
    "BULK_ACTIVATE",
    "BULK_DEACTIVATE",
  ],
  scan: {
    roots: [
      "lib/google-iap-management",
      "app/api/google-iap-management",
      "app/(dashboard)/google-iap-management",
      "components/google-iap-management",
    ],
    extensions: TS_EXT,
  },
  shapes: [
    {
      // appendAction({ actionType: "APPS_SYNC", … })  — camelCase, and the
      // value may be an inline ternary, so the whole property value up to the
      // line end is captured and every enum-shaped literal harvested.
      shape: "appendAction-arg",
      re: /actionType:\s*[^\n]*/g,
      contributes: "both",
    },
    {
      // Defensive: any direct insert that bypasses appendAction. There are
      // none today (actions-log.ts:34 is the sole writer) — this shape exists
      // so one added later is caught rather than unscanned.
      shape: "object-literal",
      re: /action_type:\s*"([A-Z][A-Z0-9_]+)"/g,
      contributes: "both",
    },
  ],
  sentinels: {
    // Only reachable through the inline ternary in the bulk-status path.
    "appendAction-arg": "BULK_DEACTIVATE",
    // NOTE: no sentinel for "object-literal" — it deliberately matches nothing
    // today (appendAction is the only writer). `guard.test.ts` allows a shape
    // with no sentinel ONLY when it is listed here as intentionally-empty, so
    // the absence is a declaration rather than an oversight.
  },
  failureMode: "silent",
  failureModeEvidence:
    "Single choke point `appendAction` (repository/actions-log.ts:32-49) does " +
    "a bare `.insert()`, checks `{error}`, console.errors it, and returns void " +
    "— comment at :43 states the intent explicitly (\"Audit log failures " +
    "should not block primary actions\"). No RPC, no transaction.",
  scanLimitations: [],
};

/** Shapes a module declares as intentionally sentinel-free (defensive patterns
 *  that match nothing today). Keyed `label::shape`. */
export const INTENTIONALLY_UNSENTINELLED: readonly string[] = [
  `${GOOGLE_IAP_MGMT.label}::object-literal`,
];

// ─── store_mgmt ──────────────────────────────────────────────────────────────

const STORE_MGMT: AuditConstraintModule = {
  label: "store_mgmt.ticket_entries.entry_type (Store Management)",
  schema: "store_mgmt",
  table: "ticket_entries",
  column: "entry_type",
  truthFile: "lib/store-submissions/schemas/ticket.ts",
  declared: ticketEntryTypeSchema.options,
  unused: [
    {
      value: "ASSIGNMENT",
      reason:
        "Deferred post-MVP action, documented at schemas/ticket.ts:78-80: " +
        "rendered if present in a historical row, never created by the UI.",
    },
    {
      value: "PRIORITY_CHANGE",
      reason: "Same deferral as ASSIGNMENT (schemas/ticket.ts:78-80).",
    },
  ],
  regressionPins: [],
  scan: {
    // Two very different sources: the TS read/write layer, and the plpgsql
    // `*_tx` functions that are the PRIMARY emitters.
    roots: [
      "lib/store-submissions",
      "app/api/store-submissions",
      "app/(dashboard)/store-submissions",
      "components/store-submissions",
      "supabase/migrations",
    ],
    extensions: [".ts", ".tsx", ".sql"],
    fileFilter: /(?:^(?!\d{14}_).*|store_mgmt)/,
  },
  shapes: [
    {
      // Every form the value appears next to the column name, in TS and SQL:
      //   entry_type: 'COMMENT'          entry_type = 'EMAIL'
      //   entry_type === 'EMAIL'         entry_type <> 'COMMENT'
      //   .eq('entry_type', 'EMAIL')     entry_type !== 'EMAIL'
      // NB store_mgmt's TS layer only READS entry_type (writes go through
      // plpgsql), so most TS hits are filter predicates. Scanning them is
      // deliberate: a predicate on a value the CHECK doesn't allow is also a
      // bug, and it keeps the shape alive if a TS-side write is ever added.
      shape: "entry-type-adjacent",
      re: /(?:entry_type|['"]entry_type['"])\s*(?:[:=<>!]{1,3}|,)\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
      contributes: "both",
    },
    {
      // INSERT INTO store_mgmt.ticket_entries (…) VALUES (…, 'STATE_CHANGE', …)
      //
      // COVERAGE-ONLY, deliberately: entry_type sits at a POSITIONAL slot in
      // the VALUES tuple, and the same statement carries unrelated
      // SCREAMING_SNAKE literals (ticket states — 'APPROVED', 'IN_REVIEW',
      // 'DONE'). A literal harvest cannot tell an entry_type from a state, so
      // flagging unknown literals here would produce false violations. It
      // therefore proves the scanner is alive and that declared values really
      // are emitted, but cannot surface an undeclared one.
      //
      // Mitigation for that gap is structural, not textual: this module's
      // inserts run INSIDE the `*_tx` plpgsql functions, so a CHECK violation
      // RAISES and aborts the transaction — a new undeclared entry_type fails
      // LOUDLY on its first use rather than silently forever. See
      // `failureMode` below.
      // Window is generous (statements run ~440 chars today, jsonb_build_object
      // blocks can be long). Over-matching is harmless HERE and only here:
      // coverage-only already discards anything outside the declared set, so a
      // wide window cannot manufacture a false violation.
      shape: "sql-insert-tuple",
      re: /INSERT\s+INTO\s+store_mgmt\.ticket_entries[\s\S]{0,1500}?;/g,
      contributes: "coverage-only",
    },
  ],
  sentinels: {
    "entry-type-adjacent": "COMMENT",
    // SQL-only: no TS path emits STATE_CHANGE — it exists solely inside the
    // plpgsql state-transition functions, so it proves the SQL scan is alive.
    "sql-insert-tuple": "STATE_CHANGE",
  },
  failureMode: "loud-transactional",
  failureModeEvidence:
    "ticket_entries INSERTs live inside the `*_tx` plpgsql functions that also " +
    "perform the tickets UPDATE (20260423000000_store_mgmt_ticket_engine_rpc.sql, " +
    "20260424000000_store_mgmt_user_actions_rpcs.sql and 6 more), invoked via " +
    "storeDb().rpc('…_tx') — tickets/user-actions.ts:190-231, " +
    "tickets/engine.ts:125. A plpgsql function runs in one implicit " +
    "transaction, so a CHECK violation raises and rolls back the DATA write " +
    "too. user-actions.ts:9 states the intent: \"tickets UPDATE, " +
    "ticket_entries INSERT. Atomic.\" Higher severity than the silent modules, " +
    "but self-announcing: a drift here breaks the user-visible action " +
    "immediately, so it cannot hide in production the way iap_mgmt's did.",
  scanLimitations: [
    "SQL INSERT tuples are coverage-only (positional entry_type is textually " +
      "indistinguishable from ticket-state literals in the same statement). " +
      "An undeclared entry_type added in plpgsql is caught by the transaction " +
      "raising at first use, not by this scan.",
  ],
};

// ─── public / CPP ────────────────────────────────────────────────────────────
//
// CPP Management has NO audit table — `public` holds only `asc_accounts`
// (credentials) and `cpp_hub_tracking_config` (a singleton config row). There
// is no enumerated audit column, so there is nothing to drift. This is a
// different posture from "audited and clean", and it is not a pass: the
// discovery sweep in guard.test.ts will fail the moment a `public.actions_log`
// appears without a registry entry.

export const AUDIT_CONSTRAINT_MODULES: readonly AuditConstraintModule[] = [
  IAP_MGMT,
  GOOGLE_IAP_MGMT,
  STORE_MGMT,
];
