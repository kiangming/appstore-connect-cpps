/**
 * C3 C-3 [Q-C3.conflict-read-B] — what the LAST bulk import did to each
 * product, for the Step 3 conflict screen.
 *
 * Step 3 asks "is this product_id already on Apple?" and, until C3, both
 * answers looked the same: a product that finished cleanly and a product left
 * half-built by a rate-limited batch presented as identical conflict rows, so
 * the Manager chose a ConflictMode blind to the difference.
 *
 * ⚠ THIS READS A CACHE, AND THE CACHE HAS A THIRD STATE. `iap_mgmt.iaps`
 * holds only the most recent verdict; `iap_mgmt.actions_log` remains the full
 * append-only record and wins on any disagreement. A product with NO row here
 * — or a row whose `last_import_status` is NULL — has never been through bulk
 * import (created in the single-IAP form, synced down from Apple, or predates
 * the migration). That is NOT the same as "it went fine", and callers must
 * not collapse it into one: silently upgrading unknown to fine is exactly how
 * a half-built row slips through the screen this exists to inform.
 */
import { iapDb } from "../db";

/** The cached verdict of the most recent bulk-import run for one product. */
export interface LastImportRecord {
  /** "SUCCESS" | "PARTIAL" as written by the execute route. */
  status: string;
  /** The sentence built from that run's stage map; may be absent. */
  summary: string | null;
}

/**
 * Map of product_id → last bulk-import verdict, for one app.
 *
 * ⚠ Products absent from the map have no verdict. Absence is the NULL case
 * above; do not default it.
 */
export type LastImportByProductId = Record<string, LastImportRecord>;

export async function getLastImportByProductId(
  internalAppId: string,
): Promise<LastImportByProductId> {
  const db = iapDb();
  const res = await db
    .from("iaps")
    .select("product_id, last_import_status, last_import_summary")
    .eq("app_id", internalAppId)
    // Rows that never came through bulk import carry no verdict and would
    // only add absent-vs-null ambiguity downstream.
    .not("last_import_status", "is", null);

  if (res.error || !res.data) return {};

  const out: LastImportByProductId = {};
  for (const row of res.data as Array<{
    product_id: string;
    last_import_status: string | null;
    last_import_summary: string | null;
  }>) {
    if (!row.last_import_status) continue;
    out[row.product_id] = {
      status: row.last_import_status,
      summary: row.last_import_summary ?? null,
    };
  }
  return out;
}

/**
 * What, if anything, the Step 3 conflict row should say about the last run.
 *
 * ⚠ PURE, AND SEPARATE FROM THE JSX, because this is the rule the screen
 * exists for and it has exactly one way to go wrong: treating "no record" as
 * "it went fine". Absence and SUCCESS both return null here — but they return
 * null for different reasons, and the reason is asserted in tests rather than
 * left to a reader of the ternary.
 *
 * Returns null when there is nothing to add:
 *   * no record at all      — never came through bulk import
 *   * status SUCCESS        — it exists because it finished; the ordinary
 *                             conflict row already says everything
 *   * a status we don't know — a server ahead of this client. Say nothing
 *                             rather than invent a reading of it.
 */
export function conflictRowNote(
  record: LastImportRecord | undefined,
): string | null {
  if (!record) return null;
  if (record.status !== "PARTIAL") return null;
  // ⚠ Fallback text, not silence. The verdict is the fact worth showing; the
  // sentence is a convenience that an older row may predate.
  return record.summary ?? "A previous import left this product incomplete.";
}
