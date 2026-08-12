/**
 * Per-territory Custom Prices — THE SINGLE WRITER. Server-side only.
 *
 * ⚠ EVERY read, upsert and delete of `iap_mgmt.iap_custom_prices` and of the
 * three `iap_mgmt.iaps.custom_prices_baseline_*` columns goes through this
 * module. There must be no `.from("iap_custom_prices")` anywhere else, and no
 * other writer of the baseline columns. `single-writer.test.ts` fails the build
 * if one appears.
 *
 * This is structural, not stylistic. The August 2026 cross-module audit
 * established exactly why `iap_mgmt` drifted while `google_iap_mgmt` did not:
 * Google funnels every audit write through one typed `appendAction`, so there
 * is nowhere to diverge, and its CHECK constraint stayed in sync. Apple has
 * `writeAuditRow` in update-orchestration, a second one in bulk-availability,
 * and nine bare `.insert()` calls across five files — and that is precisely
 * where the two lost `AVAILABILITY_*` values hid for months. A new feature that
 * scatters its writes the same way earns the same bug.
 *
 * So: one module, one typed audit helper, `IapActionType` on every action.
 *
 * No cache of any kind (P6). This is a cold path — a handful of reads per form
 * render — and a stale in-memory cache across Railway's rolling-deploy
 * instances is strictly worse than no cache.
 */
import { iapDb } from "@/lib/iap-management/db";
import type { IapActionType } from "@/lib/iap-management/action-types";
import {
  normalizeEntries,
  type CustomPriceBaseline,
  type CustomPriceEntry,
} from "./model";

/** Where a saved set came from. Recorded in the audit payload rather than
 *  splitting `CUSTOM_PRICES_SAVED` into two action types — same event, and the
 *  distinction is a payload fact, not a different kind of write. */
export type CustomPriceSaveSource = "manual" | "imported-from-apple";

export interface CustomPriceState {
  entries: CustomPriceEntry[];
  /** `null` when the IAP has never had a custom set (all three columns NULL —
   *  the DB coherence CHECK makes a partial fingerprint impossible). */
  baseline: CustomPriceBaseline | null;
}

interface BaselineRow {
  custom_prices_baseline_tier_id: string | null;
  custom_prices_baseline_pricing_source: CustomPriceBaseline["pricing_source"] | null;
  custom_prices_baseline_base_territory: string | null;
}

const BASELINE_COLUMNS =
  "custom_prices_baseline_tier_id, custom_prices_baseline_pricing_source, custom_prices_baseline_base_territory";

function baselineFromRow(row: BaselineRow | null): CustomPriceBaseline | null {
  if (!row) return null;
  const { custom_prices_baseline_tier_id: tier } = row;
  const source = row.custom_prices_baseline_pricing_source;
  const territory = row.custom_prices_baseline_base_territory;
  // All-or-nothing by DB constraint; the guard here keeps a hand-edited row
  // from producing a half-fingerprint that would compare as permanently stale.
  if (!tier || !source || !territory) return null;
  return { tier_id: tier, pricing_source: source, base_territory: territory };
}

function baselineToRow(baseline: CustomPriceBaseline | null): BaselineRow {
  return {
    custom_prices_baseline_tier_id: baseline?.tier_id ?? null,
    custom_prices_baseline_pricing_source: baseline?.pricing_source ?? null,
    custom_prices_baseline_base_territory: baseline?.base_territory ?? null,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The custom set for one IAP, in canonical sorted order. */
export async function listCustomPrices(
  iapId: string,
): Promise<CustomPriceEntry[]> {
  const res = await iapDb()
    .from("iap_custom_prices")
    .select("territory_code, currency_code, customer_price")
    .eq("iap_id", iapId)
    .order("territory_code", { ascending: true });
  if (res.error) {
    throw new Error(`Custom prices fetch failed for ${iapId}: ${res.error.message}`);
  }
  // NUMERIC(18,4) can arrive as a string from PostgREST depending on driver
  // settings; coerce once, here, so nothing downstream has to think about it.
  return normalizeEntries(
    ((res.data ?? []) as Array<{
      territory_code: string;
      currency_code: string;
      customer_price: number | string;
    }>).map((r) => ({
      territory_code: r.territory_code,
      currency_code: r.currency_code,
      customer_price: Number(r.customer_price),
    })),
  );
}

export async function readCustomPriceBaseline(
  iapId: string,
): Promise<CustomPriceBaseline | null> {
  const res = await iapDb()
    .from("iaps")
    .select(BASELINE_COLUMNS)
    .eq("id", iapId)
    .maybeSingle();
  if (res.error) {
    throw new Error(
      `Custom-price baseline fetch failed for ${iapId}: ${res.error.message}`,
    );
  }
  return baselineFromRow(res.data as BaselineRow | null);
}

/** Set + fingerprint in one call — what the Edit page and both write routes
 *  need together. Two round-trips, no cache (P6). */
export async function getCustomPriceState(
  iapId: string,
): Promise<CustomPriceState> {
  const [entries, baseline] = await Promise.all([
    listCustomPrices(iapId),
    readCustomPriceBaseline(iapId),
  ]);
  return { entries, baseline };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface ReplaceCustomPricesArgs {
  iapId: string;
  /** The complete new set. `[]` is a legitimate explicit clear — callers must
   *  have already resolved `untouched` vs `replace` via `persistIntentFrom`, so
   *  reaching here always means "write exactly this". */
  entries: readonly CustomPriceEntry[];
  /** Stamped alongside the set. `null` only when clearing. */
  baseline: CustomPriceBaseline | null;
  actor: string;
  source: CustomPriceSaveSource;
}

/**
 * Replace the whole set for one IAP, and stamp the fingerprint that set was
 * built against.
 *
 * Replace-all rather than per-row upsert, for two reasons: it matches Apple's
 * own price-schedule semantics (the POST replaces the entire schedule), and it
 * matches the module's existing replace-only convention for template uploads.
 * A per-row upsert would leave a territory the Manager deleted in the dialog
 * still sitting in the table.
 *
 * Not transactional — supabase-js exposes no transactions (the same constraint
 * `replaceTemplate` and `replacePriceTiers` live with). Order is chosen so a
 * mid-flight failure is recoverable and never silently wrong: delete → insert →
 * stamp. A crash after the delete leaves zero customs with the OLD fingerprint,
 * which reads as "no customs" — visibly empty in the UI, and the Manager
 * re-enters. A crash after insert but before the stamp leaves the new set with
 * the old fingerprint, which reads as STALE — submit blocked, Manager reviews.
 * Both failure states are safe-by-inspection; the reverse order (stamp first)
 * would leave a fresh fingerprint over stale prices, which reads as clean and
 * would ship.
 */
export async function replaceCustomPrices(
  args: ReplaceCustomPricesArgs,
): Promise<CustomPriceEntry[]> {
  const db = iapDb();
  const entries = normalizeEntries(args.entries);

  const del = await db
    .from("iap_custom_prices")
    .delete()
    .eq("iap_id", args.iapId);
  if (del.error) {
    throw new Error(
      `Custom prices clear-before-write failed for ${args.iapId}: ${del.error.message}`,
    );
  }

  if (entries.length > 0) {
    const ins = await db.from("iap_custom_prices").insert(
      entries.map((e) => ({
        iap_id: args.iapId,
        territory_code: e.territory_code,
        currency_code: e.currency_code,
        customer_price: e.customer_price,
      })),
    );
    if (ins.error) {
      throw new Error(
        `Custom prices insert failed for ${args.iapId}: ${ins.error.message}`,
      );
    }
  }

  const stamp = await db
    .from("iaps")
    .update(baselineToRow(entries.length > 0 ? args.baseline : null))
    .eq("id", args.iapId);
  if (stamp.error) {
    throw new Error(
      `Custom-price baseline stamp failed for ${args.iapId}: ${stamp.error.message}`,
    );
  }

  await writeAuditRow(
    entries.length > 0 ? "CUSTOM_PRICES_SAVED" : "CUSTOM_PRICES_CLEARED",
    args.iapId,
    args.actor,
    {
      result: "SUCCESS",
      source: args.source,
      territory_count: entries.length,
      baseline: entries.length > 0 ? args.baseline : null,
      territories: entries,
    },
  );

  return entries;
}

/**
 * Delete the whole set and null the fingerprint — the Manager's "Clear all
 * custom prices" exit (design §C, and one of the two stale resolutions).
 *
 * The removed values go into the audit payload BEFORE the delete, because that
 * row is the only recovery path for the one destructive action in the feature.
 */
export async function clearCustomPrices(args: {
  iapId: string;
  actor: string;
}): Promise<number> {
  const existing = await listCustomPrices(args.iapId);
  const previousBaseline = await readCustomPriceBaseline(args.iapId);
  const db = iapDb();

  const del = await db
    .from("iap_custom_prices")
    .delete()
    .eq("iap_id", args.iapId);
  if (del.error) {
    throw new Error(
      `Custom prices delete failed for ${args.iapId}: ${del.error.message}`,
    );
  }

  const stamp = await db
    .from("iaps")
    .update(baselineToRow(null))
    .eq("id", args.iapId);
  if (stamp.error) {
    throw new Error(
      `Custom-price baseline clear failed for ${args.iapId}: ${stamp.error.message}`,
    );
  }

  await writeAuditRow("CUSTOM_PRICES_CLEARED", args.iapId, args.actor, {
    result: "SUCCESS",
    cleared_territory_count: existing.length,
    previous_baseline: previousBaseline,
    territories: existing,
  });

  return existing.length;
}

/**
 * "Keep them (reviewed)" — re-stamp the fingerprint to the current baseline
 * WITHOUT touching a single price (design §D.3-3b).
 *
 * This is the one write in the feature that changes what will ship to a live
 * store while changing nothing visible, so it is audited on its own action
 * type. There is deliberately no `reviewed: true` column: the re-stamp IS the
 * acknowledgement, which means a LATER baseline change re-triggers staleness
 * automatically. A boolean would swallow it.
 */
export async function restampCustomPriceBaseline(args: {
  iapId: string;
  baseline: CustomPriceBaseline;
  actor: string;
}): Promise<void> {
  const previous = await readCustomPriceBaseline(args.iapId);
  const existing = await listCustomPrices(args.iapId);

  const stamp = await iapDb()
    .from("iaps")
    .update(baselineToRow(args.baseline))
    .eq("id", args.iapId);
  if (stamp.error) {
    throw new Error(
      `Custom-price re-baseline failed for ${args.iapId}: ${stamp.error.message}`,
    );
  }

  await writeAuditRow("CUSTOM_PRICES_REBASELINE", args.iapId, args.actor, {
    result: "SUCCESS",
    old_baseline: previous,
    new_baseline: args.baseline,
    kept_territory_count: existing.length,
    territories: existing,
  });
}

// ─── Audit ───────────────────────────────────────────────────────────────────

/**
 * The module's only audit writer. `IapActionType`, not `string` — the compiler
 * refuses a value that isn't declared in action-types.ts, which is the same
 * list the audit-constraint guard holds against the live CHECK constraint.
 *
 * Named `writeAuditRow` to match update-orchestration.ts and
 * bulk-availability.ts: the guard's `positional-helper-arg` emission shape
 * keys off that name, so a consistent name means these action types are
 * scanned with no new pattern. Diverging on the name would create a blind spot.
 *
 * Never throws. An audit-write failure must not fail a real persistence
 * operation — but it is logged loudly, because a swallowed constraint violation
 * with no console trace is exactly how the P2 bug stayed invisible.
 */
async function writeAuditRow(
  action: IapActionType,
  iapId: string,
  actor: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await iapDb().from("actions_log").insert({
      iap_id: iapId,
      actor,
      action_type: action,
      payload,
    });
    if (error) {
      console.error(
        `[custom-prices] audit insert error iap=${iapId} action=${action}: ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[custom-prices] audit insert threw iap=${iapId} action=${action}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
