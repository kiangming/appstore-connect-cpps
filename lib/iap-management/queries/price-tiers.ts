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
  /** USA/USD customer price for the tier — null if not in the USD cache. */
  usd_price: number | null;
}

export interface TierTerritoryDetail {
  tier_id: string;
  tier_name: string;
  is_alternate: boolean;
  territories: Array<{
    territory_code: string;
    currency_code: string;
    customer_price: number;
    proceeds: number;
  }>;
}

/**
 * Format a tier_id + optional USD price into a human-friendly label.
 * Shape: "Free Tier" / "Tier 1 ($0.99)" / "Alt Tier A ($0.69)".
 * Used in form selectors, list rows, and bulk-wizard preview rows.
 */
export function formatTierWithPrice(
  tier_id: string,
  usd_price: number | null | undefined,
): string {
  let label: string;
  if (tier_id === "FREE") label = "Free Tier";
  else if (tier_id.startsWith("TIER_")) label = `Tier ${tier_id.slice(5)}`;
  else if (tier_id.startsWith("ALT_")) label = `Alt Tier ${tier_id.slice(4)}`;
  else label = tier_id;

  if (typeof usd_price !== "number" || !Number.isFinite(usd_price)) return label;
  if (usd_price === 0) return label;
  return `${label} ($${usd_price.toFixed(2)})`;
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

// ─── Tier inference by USD price (Manager IAP.h2 lock) ──────────────────────

export interface UsdTierEntry {
  tier_id: string;
  customer_price: number;
}

/**
 * Resolve a local `tier_id` to its USA/USD `customer_price` (IAP.o.10a).
 *
 * Manager's pricing schedule wire matches Apple price points by the USD
 * customerPrice string — robust against Apple's tier-numbering churn
 * (Apple changed integer priceTier from "1,2,3..." to "10000,10001..." in
 * 2024 per developer forum thread 728081, breaking the IAP.o.9a tier-id
 * match strategy).
 *
 * Returns `null` when the tier isn't in the cache (Manager hasn't imported
 * tiers yet, or tier_id is malformed). Callers must surface this loudly —
 * silent fallthrough means the IAP ships to Apple with no price.
 */
export async function getTierUsdPrice(
  tier_id: string,
): Promise<number | null> {
  const db = iapDb();
  const res = await db
    .from("price_tier_territories")
    .select("customer_price")
    .eq("territory_code", "USA")
    .eq("currency_code", "USD")
    .eq("tier_id", tier_id)
    .maybeSingle();
  if (res.error) {
    throw new Error(`USD tier lookup failed for ${tier_id}: ${res.error.message}`);
  }
  if (!res.data) return null;
  return (res.data as { customer_price: number }).customer_price;
}

/**
 * Server-side: returns the USA/USD subset of the price tier cache (~95 rows).
 * Used by the bulk-import wizard server page to pass to the client for
 * preview-time tier resolution + by the execute orchestration to re-validate.
 */
export async function listUsdTiers(): Promise<UsdTierEntry[]> {
  const db = iapDb();
  const res = await db
    .from("price_tier_territories")
    .select("tier_id, customer_price")
    .eq("territory_code", "USA")
    .eq("currency_code", "USD")
    .order("customer_price", { ascending: true });
  if (res.error) {
    throw new Error(`USD tiers fetch failed: ${res.error.message}`);
  }
  return (res.data ?? []) as UsdTierEntry[];
}

/**
 * Pure tier resolver (no DB) — usable from client wizard for preview.
 *
 * Rule (Manager IAP.h2 lock):
 *   - Price 0 → "FREE" (whether or not the cache has the row).
 *   - Else: exact-match against customer_price. Multiple matches resolved
 *     by tier_id ASC (Manager's SQL: ORDER BY tier_id ASC LIMIT 1).
 *   - No match → null (caller surfaces "Price doesn't match any tier" error).
 */
export function resolveTierByUsdPrice(
  priceUsd: number,
  tiers: readonly UsdTierEntry[],
): string | null {
  if (priceUsd === 0) return "FREE";
  const matches = tiers.filter((t) => t.customer_price === priceUsd);
  if (matches.length === 0) return null;
  // Manager spec: ORDER BY tier_id ASC LIMIT 1
  const sorted = [...matches].sort((a, b) =>
    a.tier_id.localeCompare(b.tier_id),
  );
  return sorted[0].tier_id;
}

export async function listTiers(): Promise<PriceTierRow[]> {
  const db = iapDb();
  const [tiersRes, usdRes] = await Promise.all([
    db.from("price_tiers").select("tier_id, tier_name"),
    db
      .from("price_tier_territories")
      .select("tier_id, customer_price")
      .eq("territory_code", "USA")
      .eq("currency_code", "USD"),
  ]);
  if (tiersRes.error) throw new Error(`Failed to list tiers: ${tiersRes.error.message}`);
  if (usdRes.error) throw new Error(`Failed to fetch USD prices: ${usdRes.error.message}`);

  const usdMap = new Map<string, number>();
  for (const row of (usdRes.data ?? []) as Array<{
    tier_id: string;
    customer_price: number;
  }>) {
    usdMap.set(row.tier_id, row.customer_price);
  }

  const rows = (tiersRes.data ?? []) as Array<{ tier_id: string; tier_name: string }>;
  return rows
    .map((r) => ({
      tier_id: r.tier_id,
      tier_name: r.tier_name,
      is_alternate: r.tier_id.startsWith("ALT_"),
      usd_price: usdMap.get(r.tier_id) ?? null,
    }))
    .sort((a, b) => sortTierId(a.tier_id, b.tier_id));
}

/**
 * Fetch every tier with its full territory list. Used by the Settings page
 * expandable-row UI (Manager IAP.o.5 Issue A — per-country audit).
 * Returns one row per tier, each with a sorted `territories` array.
 */
export async function listTiersWithTerritories(): Promise<TierTerritoryDetail[]> {
  const db = iapDb();
  const [tiersRes, terrRes] = await Promise.all([
    db.from("price_tiers").select("tier_id, tier_name"),
    db
      .from("price_tier_territories")
      .select("tier_id, territory_code, currency_code, customer_price, proceeds"),
  ]);
  if (tiersRes.error)
    throw new Error(`Failed to list tiers: ${tiersRes.error.message}`);
  if (terrRes.error)
    throw new Error(`Failed to list territories: ${terrRes.error.message}`);

  const byTier = new Map<string, TierTerritoryDetail["territories"]>();
  for (const row of (terrRes.data ?? []) as Array<{
    tier_id: string;
    territory_code: string;
    currency_code: string;
    customer_price: number;
    proceeds: number;
  }>) {
    if (!byTier.has(row.tier_id)) byTier.set(row.tier_id, []);
    byTier.get(row.tier_id)!.push({
      territory_code: row.territory_code,
      currency_code: row.currency_code,
      customer_price: row.customer_price,
      proceeds: row.proceeds,
    });
  }
  for (const arr of byTier.values()) {
    arr.sort((a, b) => a.territory_code.localeCompare(b.territory_code));
  }

  const tierRows = (tiersRes.data ?? []) as Array<{
    tier_id: string;
    tier_name: string;
  }>;
  return tierRows
    .map((r) => ({
      tier_id: r.tier_id,
      tier_name: r.tier_name,
      is_alternate: r.tier_id.startsWith("ALT_"),
      territories: byTier.get(r.tier_id) ?? [],
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
