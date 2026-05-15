/**
 * Server-side queries for the iap_mgmt.price_tiers cache.
 *
 * Q-IAP.7 lock: replace-on-each-import semantics. `replacePriceTiers`
 * wipes the current cache and inserts fresh rows in one logical operation
 * (best-effort sequential — supabase-js doesn't expose transactions).
 *
 * On partial failure the audit batch is marked FAILED so Manager can
 * retry. The action_log entry captures the failure reason.
 */

import { iapDb } from "../db";
import type { PriceTiersParseResult } from "../parsers/price-tiers";

const TERRITORY_BATCH_SIZE = 1000;
const TEMPLATE_VERSION = "v1";

export interface PriceTierRow {
  tier_id: string;
  tier_name: string;
  is_alternate: boolean;
}

export interface ImportSummary {
  tier_count: number;
  alternate_count: number;
  territory_count_per_tier: number;
  imported_at: string | null;
  imported_by: string | null;
}

export async function getImportSummary(): Promise<ImportSummary> {
  const db = iapDb();

  const tiersRes = await db
    .from("price_tiers")
    .select("tier_id, imported_at, imported_by");
  if (tiersRes.error) {
    throw new Error(`Failed to load tiers: ${tiersRes.error.message}`);
  }
  const tiers = tiersRes.data ?? [];
  const alternates = tiers.filter((t) =>
    (t.tier_id as string).startsWith("ALT_"),
  ).length;

  const territoriesRes = await db
    .from("price_tier_territories")
    .select("tier_id", { count: "exact", head: true });
  if (territoriesRes.error) {
    throw new Error(`Failed to count territories: ${territoriesRes.error.message}`);
  }
  const territoryRows = territoriesRes.count ?? 0;
  const perTier = tiers.length > 0 ? Math.round(territoryRows / tiers.length) : 0;

  // Pick most recent imported_at as the cache's import timestamp. All rows
  // share the same value when populated by replacePriceTiers, so this is
  // effectively "the import time."
  const first = tiers[0] as
    | { imported_at?: string; imported_by?: string }
    | undefined;

  return {
    tier_count: tiers.length,
    alternate_count: alternates,
    territory_count_per_tier: perTier,
    imported_at: first?.imported_at ?? null,
    imported_by: first?.imported_by ?? null,
  };
}

export async function listTiers(): Promise<PriceTierRow[]> {
  const db = iapDb();
  const res = await db
    .from("price_tiers")
    .select("tier_id, tier_name");
  if (res.error) {
    throw new Error(`Failed to list tiers: ${res.error.message}`);
  }
  const rows = (res.data ?? []) as Array<{ tier_id: string; tier_name: string }>;
  return rows
    .map((r) => ({
      tier_id: r.tier_id,
      tier_name: r.tier_name,
      is_alternate: r.tier_id.startsWith("ALT_"),
    }))
    .sort((a, b) => sortTierId(a.tier_id, b.tier_id));
}

/** Sort: FREE → TIER_<n> (numeric) → ALT_<n or X> (numeric first, then letters). */
function sortTierId(a: string, b: string): number {
  const rank = (id: string): [number, number, string] => {
    if (id === "FREE") return [0, 0, ""];
    const tier = /^TIER_(\d+)$/.exec(id);
    if (tier) return [1, Number(tier[1]), ""];
    const alt = /^ALT_(.+)$/.exec(id);
    if (alt) {
      const n = Number(alt[1]);
      return Number.isFinite(n) ? [2, n, ""] : [3, 0, alt[1]];
    }
    return [9, 0, id];
  };
  const [aBucket, aNum, aStr] = rank(a);
  const [bBucket, bNum, bStr] = rank(b);
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (aNum !== bNum) return aNum - bNum;
  return aStr.localeCompare(bStr);
}

export interface ReplaceResult {
  batch_id: string;
  inserted_tier_count: number;
  inserted_territory_count: number;
}

export async function replacePriceTiers(
  parsed: PriceTiersParseResult,
  importedBy: string,
): Promise<ReplaceResult> {
  const db = iapDb();
  const now = new Date().toISOString();

  // 1. Create a PENDING audit batch up-front so failures get logged.
  const batchIns = await db
    .from("import_batches")
    .insert({
      imported_by: importedBy,
      template_version: TEMPLATE_VERSION,
      total_rows: parsed.tiers.length,
      status: "IN_PROGRESS",
      notes: `Price tier import: ${parsed.tiers.length} tiers (${parsed.alternate_tier_count} alt) × ${parsed.territory_count} territories`,
    })
    .select("id")
    .single();
  if (batchIns.error || !batchIns.data) {
    throw new Error(
      `Failed to open import batch: ${batchIns.error?.message ?? "no data"}`,
    );
  }
  const batchId = (batchIns.data as { id: string }).id;

  try {
    // 2. Wipe existing tiers (ON DELETE CASCADE handles territories).
    //    Use neq("tier_id", "__never__") to bypass supabase-js's "no filter"
    //    safety guard while still hitting every row.
    const del = await db
      .from("price_tiers")
      .delete()
      .neq("tier_id", "__sentinel_does_not_exist__");
    if (del.error) {
      throw new Error(`Failed to clear tiers: ${del.error.message}`);
    }

    // 3. Insert new tiers (single batch — only ~95 rows).
    const tierRows = parsed.tiers.map((t) => ({
      tier_id: t.tier_id,
      tier_name: t.tier_name,
      imported_at: now,
      imported_by: importedBy,
    }));
    const tierIns = await db.from("price_tiers").insert(tierRows);
    if (tierIns.error) {
      throw new Error(`Failed to insert tiers: ${tierIns.error.message}`);
    }

    // 4. Insert territories in 1000-row batches (≈ 16,800 rows total).
    const territoryRows: Array<{
      tier_id: string;
      territory_code: string;
      currency_code: string;
      customer_price: number;
      proceeds: number;
    }> = [];
    for (const tier of parsed.tiers) {
      for (const t of tier.territories) {
        territoryRows.push({
          tier_id: tier.tier_id,
          territory_code: t.territory_code,
          currency_code: t.currency_code,
          customer_price: t.customer_price,
          proceeds: t.proceeds,
        });
      }
    }
    for (let i = 0; i < territoryRows.length; i += TERRITORY_BATCH_SIZE) {
      const chunk = territoryRows.slice(i, i + TERRITORY_BATCH_SIZE);
      const ins = await db.from("price_tier_territories").insert(chunk);
      if (ins.error) {
        throw new Error(
          `Failed to insert territories batch ${i / TERRITORY_BATCH_SIZE}: ${ins.error.message}`,
        );
      }
    }

    // 5. Mark batch COMPLETE.
    await db
      .from("import_batches")
      .update({
        status: "COMPLETE",
        created_count: parsed.tiers.length,
      })
      .eq("id", batchId);

    // 6. Audit-log the action.
    await db.from("actions_log").insert({
      batch_id: batchId,
      actor: importedBy,
      action_type: "PRICE_TIER_IMPORT",
      payload: {
        tier_count: parsed.tiers.length,
        alternate_count: parsed.alternate_tier_count,
        territory_count: parsed.territory_count,
        warnings: parsed.warnings,
      },
    });

    return {
      batch_id: batchId,
      inserted_tier_count: parsed.tiers.length,
      inserted_territory_count: territoryRows.length,
    };
  } catch (err) {
    // Mark the batch FAILED + log so Manager sees the failure in history.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("import_batches")
      .update({ status: "FAILED", notes: message })
      .eq("id", batchId);
    await db.from("actions_log").insert({
      batch_id: batchId,
      actor: importedBy,
      action_type: "PRICE_TIER_IMPORT",
      payload: { error: message },
    });
    throw err;
  }
}
