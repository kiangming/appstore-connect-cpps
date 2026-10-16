/**
 * THE bulk-import gate [arc-google-missing-purchase-options — D0, D2, D9].
 * ONE gate for every route that runs a bulk import (preview decides
 * NEW/EXISTING from the IAP mirror and resolves prices against the app's
 * currency; execute writes that plan). A second, private gate in a route is
 * forbidden — app-defaults.structural.test.ts (block G) pins it.
 *
 * Incident (com.vnggames.ballisticherotwid, 2026-10-16):
 *   • the IAP mirror had never been filled ⇒ 28/28 "NEW" ⇒ 28 CREATEs onto
 *     products that already existed on Google (D0);
 *   • the app's currency was a TOOL GUESS (TWD from the Play Console language;
 *     USD after an IAP refresh, from the first product's US region) (D9).
 *
 * States, never collapsed:
 *   error    — readiness could not be READ                       → 503 (D2),
 *              code IMPORT_READINESS_READ_FAILED (not MIRROR_READ_FAILED:
 *              that one is the IAP list itself, read later by preview)
 *   blocked  — mirror never refreshed completely (D0), and/or currency or
 *              language not DECLARED by the Manager (D9)           → 409
 *   ok       — both satisfied                                     → proceed
 *
 * ⚠ "Could not read" must NEVER become "never synced", "not declared", or ok.
 */
import { getAppImportReadiness } from "./repository/apps";
import {
  undeclaredFields,
  type AppDefaultField,
  type AppDefaultsState,
} from "./app-defaults";

export const IAPS_NEVER_SYNCED = "IAPS_NEVER_SYNCED" as const;
export const APP_DEFAULTS_NOT_DECLARED = "APP_DEFAULTS_NOT_DECLARED" as const;
export const MIRROR_READ_FAILED = "MIRROR_READ_FAILED" as const;
export const IMPORT_READINESS_READ_FAILED = "IMPORT_READINESS_READ_FAILED" as const;

export type BulkImportBlocker = typeof IAPS_NEVER_SYNCED | typeof APP_DEFAULTS_NOT_DECLARED;

export type BulkImportGate =
  | { kind: "error"; message: string }
  | {
      kind: "blocked";
      blockers: BulkImportBlocker[];
      undeclared: AppDefaultField[];
      iapsLastSyncedAt: string | null;
      defaults: AppDefaultsState;
    }
  | {
      kind: "ok";
      iapsLastSyncedAt: string;
      defaults: AppDefaultsState;
      /** The DECLARED currency, from the same read as the verdict. Routes price
       *  against THIS — never against app.default_currency from an earlier
       *  read (a declare landing in between would price a value nobody gated). */
      declaredCurrency: string;
    };

export async function readBulkImportGate(appId: string): Promise<BulkImportGate> {
  let readiness;
  try {
    readiness = await getAppImportReadiness(appId);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const blockers: BulkImportBlocker[] = [];
  if (!readiness.iapsLastSyncedAt) blockers.push(IAPS_NEVER_SYNCED);
  const undeclared = undeclaredFields(readiness.defaults);
  if (undeclared.length > 0) blockers.push(APP_DEFAULTS_NOT_DECLARED);
  const declaredCurrency = readiness.defaults.currency.value;
  if (blockers.length > 0 || !readiness.iapsLastSyncedAt || !declaredCurrency) {
    return {
      kind: "blocked",
      blockers,
      undeclared,
      iapsLastSyncedAt: readiness.iapsLastSyncedAt,
      defaults: readiness.defaults,
    };
  }
  return {
    kind: "ok",
    iapsLastSyncedAt: readiness.iapsLastSyncedAt,
    defaults: readiness.defaults,
    declaredCurrency,
  };
}

/**
 * The ONE refusal both routes return for a gate that is not open. Routes only
 * test `gate.kind !== "ok"` and hand the rest over — they must not branch on
 * gate internals themselves.
 */
export function bulkImportGateRefusal(
  gate: Exclude<BulkImportGate, { kind: "ok" }>,
  packageName: string,
): { status: number; message: string; body: Record<string, unknown> } {
  if (gate.kind === "error") {
    const message = readinessReadFailedMessage(gate.message);
    return { status: 503, message, body: { error: message, code: IMPORT_READINESS_READ_FAILED } };
  }
  const parts: string[] = [];
  if (gate.blockers.includes(IAPS_NEVER_SYNCED)) parts.push(neverSyncedMessage(packageName));
  if (gate.blockers.includes(APP_DEFAULTS_NOT_DECLARED)) {
    parts.push(notDeclaredMessage(packageName, gate.undeclared, gate.defaults));
  }
  const message = parts.join(" ");
  return {
    status: 409,
    message,
    body: {
      error: message,
      // First blocker for clients that read one code; the full list alongside.
      code: gate.blockers[0],
      blockers: gate.blockers,
      undeclared: gate.undeclared,
    },
  };
}

export function neverSyncedMessage(packageName: string): string {
  return (
    `The IAP list of ${packageName} has never been refreshed from Google, so the tool ` +
    `cannot tell which SKUs already exist. Bulk import is blocked: click "Refresh IAP list", ` +
    `then preview again.`
  );
}

export function notDeclaredMessage(
  packageName: string,
  undeclared: AppDefaultField[],
  defaults: AppDefaultsState,
): string {
  const describe = (f: AppDefaultField) => {
    const v = defaults[f];
    if (!v.value) return `${f} (not set)`;
    return `${f} (${v.value} — guessed by the tool, not confirmed)`;
  };
  return (
    `The app's ${undeclared.map(describe).join(" and ")} must be declared by the Manager ` +
    `before importing — ${packageName}'s pricing is resolved against them. Open the app page ` +
    `and confirm or set them.`
  );
}

/** The readiness row (sync stamp + currency/language provenance) was unreadable. */
export function readinessReadFailedMessage(detail: string): string {
  return (
    `Could not read this app's import readiness — IAP-list sync state, currency and ` +
    `language (${detail}). This is NOT "never synced" or "not declared" — nothing was ` +
    `imported. Try again; if it persists, check that the database migrations are applied.`
  );
}

/** The IAP mirror itself (the SKU list preview classifies against) was unreadable. */
export function mirrorReadFailedMessage(detail: string): string {
  return (
    `Could not read the cached IAP list (${detail}). This is NOT the same as "no item ` +
    `exists" — nothing was imported. Try again; if it persists, refresh the IAP list.`
  );
}
