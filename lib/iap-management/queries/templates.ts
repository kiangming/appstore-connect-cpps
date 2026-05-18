/**
 * Server-side queries for the pricing template tables introduced in IAP.p1.a:
 *
 *   iap_mgmt.price_tier_templates         (header — one Default + one per app)
 *   iap_mgmt.price_tier_template_entries  (sparse entries per template)
 *
 * Manager Q-A replace-only semantic: uploading a new template DELETEs the
 * existing header row for the same scope and inserts a fresh one. ON DELETE
 * CASCADE wipes its entries automatically.
 *
 * The legacy iap_mgmt.price_tier_territories table is retained as defensive
 * backup (Q-B) but is no longer the source of truth for pricing decisions —
 * the orchestrator (p1.e) reads from these tables instead.
 */

import { iapDb } from "../db";
import type {
  FlatTemplateEntry,
  PriceTiersParseResult,
} from "../parsers/price-tiers";
import { flattenTemplateEntries } from "../parsers/price-tiers";

const ENTRY_BATCH_SIZE = 1000;

export type TemplateScope =
  | { kind: "GLOBAL" }
  | { kind: "APP"; app_id: string };

export interface TemplateHeader {
  id: string;
  scope_type: "GLOBAL" | "APP";
  scope_app_id: string | null;
  uploaded_at: string;
  uploaded_by: string;
  source_filename: string | null;
}

export interface TemplateWithEntries {
  template: TemplateHeader;
  entries: FlatTemplateEntry[];
}

export interface AppTemplateSummary {
  app_id: string;
  app_name: string;
  bundle_id: string;
  template: TemplateHeader;
  entry_count: number;
}

export interface AppOption {
  id: string;
  name: string;
  bundle_id: string;
}

/**
 * List every active app, used by the Settings "Per-App Templates" tab to
 * power the "Upload for app" dropdown.
 */
export async function listActiveAppsForTemplateUpload(): Promise<AppOption[]> {
  const db = iapDb();
  const res = await db
    .from("apps")
    .select("id, name, bundle_id")
    .eq("active", true)
    .order("name", { ascending: true });
  if (res.error) {
    throw new Error(`Active apps fetch failed: ${res.error.message}`);
  }
  return (res.data ?? []) as AppOption[];
}

export interface TemplateTierDetail {
  tier_id: string;
  tier_name: string;
  is_alternate: boolean;
  usd_price: number | null;
  entries: Array<{
    territory_code: string;
    currency_code: string;
    customer_price: number;
    proceeds: number | null;
  }>;
}

export interface TemplateOverview {
  template: TemplateHeader | null;
  tiers: TemplateTierDetail[];
  territory_count: number;
  populated_entry_count: number;
}

function applyScopeFilter<T extends { eq: (col: string, val: unknown) => T; is: (col: string, val: unknown) => T }>(
  query: T,
  scope: TemplateScope,
): T {
  if (scope.kind === "GLOBAL") {
    return query.eq("scope_type", "GLOBAL").is("scope_app_id", null);
  }
  return query.eq("scope_type", "APP").eq("scope_app_id", scope.app_id);
}

async function fetchTemplateHeader(
  scope: TemplateScope,
): Promise<TemplateHeader | null> {
  const db = iapDb();
  const base = db
    .from("price_tier_templates")
    .select("id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename");
  const res = await applyScopeFilter(base, scope).maybeSingle();
  if (res.error) {
    throw new Error(`Template header fetch failed: ${res.error.message}`);
  }
  return (res.data as TemplateHeader | null) ?? null;
}

async function fetchEntries(templateId: string): Promise<FlatTemplateEntry[]> {
  const db = iapDb();
  const res = await db
    .from("price_tier_template_entries")
    .select("tier_id, territory_code, currency_code, customer_price, proceeds")
    .eq("template_id", templateId)
    .order("tier_id", { ascending: true })
    .order("territory_code", { ascending: true });
  if (res.error) {
    throw new Error(`Template entries fetch failed: ${res.error.message}`);
  }
  return (res.data ?? []) as FlatTemplateEntry[];
}

/**
 * Load the Default (GLOBAL) Template + entries. Returns null when Manager
 * has never uploaded a default template (clean install, post-migration
 * empty state). Orchestrator interprets null as "default source unavailable
 * — gray it out in the UI."
 */
export async function getDefaultTemplate(): Promise<TemplateWithEntries | null> {
  const template = await fetchTemplateHeader({ kind: "GLOBAL" });
  if (!template) return null;
  const entries = await fetchEntries(template.id);
  return { template, entries };
}

/**
 * Load an app-specific Template + entries. Returns null when no per-app
 * template exists — orchestrator/UI then falls back to the Default Template
 * if available, else Apple base.
 */
export async function getAppTemplate(
  app_id: string,
): Promise<TemplateWithEntries | null> {
  const template = await fetchTemplateHeader({ kind: "APP", app_id });
  if (!template) return null;
  const entries = await fetchEntries(template.id);
  return { template, entries };
}

/**
 * List every app that has its own template + a summary count. Used by the
 * Settings "Per-App Templates" tab.
 */
export async function listAppsWithTemplates(): Promise<AppTemplateSummary[]> {
  const db = iapDb();
  const templatesRes = await db
    .from("price_tier_templates")
    .select("id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename")
    .eq("scope_type", "APP")
    .order("uploaded_at", { ascending: false });
  if (templatesRes.error) {
    throw new Error(`App templates fetch failed: ${templatesRes.error.message}`);
  }
  const templates = (templatesRes.data ?? []) as TemplateHeader[];
  if (templates.length === 0) return [];

  const appIds = templates
    .map((t) => t.scope_app_id)
    .filter((v): v is string => v !== null);
  const appsRes = await db
    .from("apps")
    .select("id, name, bundle_id")
    .in("id", appIds);
  if (appsRes.error) {
    throw new Error(`Apps lookup failed: ${appsRes.error.message}`);
  }
  const appById = new Map(
    ((appsRes.data ?? []) as Array<{ id: string; name: string; bundle_id: string }>)
      .map((a) => [a.id, a]),
  );

  const counts = new Map<string, number>();
  for (const t of templates) {
    const cnt = await db
      .from("price_tier_template_entries")
      .select("template_id", { count: "exact", head: true })
      .eq("template_id", t.id);
    if (cnt.error) {
      throw new Error(`Entry count failed for ${t.id}: ${cnt.error.message}`);
    }
    counts.set(t.id, cnt.count ?? 0);
  }

  const result: AppTemplateSummary[] = [];
  for (const t of templates) {
    if (!t.scope_app_id) continue;
    const app = appById.get(t.scope_app_id);
    if (!app) continue;
    result.push({
      app_id: t.scope_app_id,
      app_name: app.name,
      bundle_id: app.bundle_id,
      template: t,
      entry_count: counts.get(t.id) ?? 0,
    });
  }
  return result;
}

export interface ReplaceTemplateResult {
  template_id: string;
  scope_type: "GLOBAL" | "APP";
  scope_app_id: string | null;
  inserted_entry_count: number;
  audit_batch_id: string;
}

/**
 * Build a per-tier overview of a template's entries, joined with tier
 * metadata from price_tiers. Used by the Settings page table view + the
 * App detail page summary. Returns an empty overview when the template
 * doesn't exist.
 */
export async function getTemplateOverview(
  scope: TemplateScope,
): Promise<TemplateOverview> {
  const header = await fetchTemplateHeader(scope);
  if (!header) {
    return { template: null, tiers: [], territory_count: 0, populated_entry_count: 0 };
  }

  const db = iapDb();
  const [entriesRes, tiersRes] = await Promise.all([
    db
      .from("price_tier_template_entries")
      .select("tier_id, territory_code, currency_code, customer_price, proceeds")
      .eq("template_id", header.id),
    db.from("price_tiers").select("tier_id, tier_name"),
  ]);
  if (entriesRes.error)
    throw new Error(`Template entries fetch failed: ${entriesRes.error.message}`);
  if (tiersRes.error)
    throw new Error(`Tier metadata fetch failed: ${tiersRes.error.message}`);

  const entries = (entriesRes.data ?? []) as FlatTemplateEntry[];
  const tierMeta = new Map(
    ((tiersRes.data ?? []) as Array<{ tier_id: string; tier_name: string }>).map(
      (t) => [t.tier_id, t.tier_name],
    ),
  );

  const byTier = new Map<string, TemplateTierDetail>();
  const territories = new Set<string>();
  for (const e of entries) {
    territories.add(e.territory_code);
    if (!byTier.has(e.tier_id)) {
      byTier.set(e.tier_id, {
        tier_id: e.tier_id,
        tier_name: tierMeta.get(e.tier_id) ?? e.tier_id,
        is_alternate: e.tier_id.startsWith("ALT_"),
        usd_price: null,
        entries: [],
      });
    }
    const detail = byTier.get(e.tier_id)!;
    detail.entries.push({
      territory_code: e.territory_code,
      currency_code: e.currency_code,
      customer_price: e.customer_price,
      proceeds: e.proceeds,
    });
    if (e.territory_code === "USA" && e.currency_code === "USD") {
      detail.usd_price = e.customer_price;
    }
  }
  for (const tier of byTier.values()) {
    tier.entries.sort((a, b) => a.territory_code.localeCompare(b.territory_code));
  }
  const tiers = Array.from(byTier.values()).sort((a, b) =>
    sortTierId(a.tier_id, b.tier_id),
  );

  return {
    template: header,
    tiers,
    territory_count: territories.size,
    populated_entry_count: entries.length,
  };
}

/** Same ranking as queries/price-tiers.ts. Inlined here to keep templates.ts
 *  self-contained — once price-tiers.ts retires, can be lifted to a shared
 *  util. */
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

/**
 * Replace-only upload (Q-A): wipe any existing template for the scope and
 * insert a fresh one with the parsed entries. The write is best-effort
 * sequential (supabase-js has no transactions) — a partial failure leaves
 * a header row with fewer entries than expected, surfaced via the audit
 * batch's FAILED status so Manager can retry.
 */
export async function replaceTemplate(
  scope: TemplateScope,
  parsed: PriceTiersParseResult,
  uploadedBy: string,
  sourceFilename: string | null,
): Promise<ReplaceTemplateResult> {
  const db = iapDb();
  const flatEntries = flattenTemplateEntries(parsed);

  const scope_type = scope.kind;
  const scope_app_id = scope.kind === "APP" ? scope.app_id : null;

  // 1. Open an audit batch up front so failures get logged.
  const batchIns = await db
    .from("import_batches")
    .insert({
      app_id: scope_app_id,
      imported_by: uploadedBy,
      template_version: scope_type === "GLOBAL" ? "default-template-v1" : "app-template-v1",
      total_rows: flatEntries.length,
      status: "IN_PROGRESS",
      notes: `Pricing template upload (${scope_type}): ${flatEntries.length} entries across ${parsed.tiers.length} tiers × ${parsed.territory_count} territories`,
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
    // 2. Upsert tier metadata into price_tiers so tier_name/is_alternate stays
    //    fresh after the legacy replacePriceTiers code path is retired. Sparse
    //    templates may reference tiers Manager already has metadata for; this
    //    upsert is non-destructive (PK = tier_id).
    const tierMetaRows = parsed.tiers.map((t) => ({
      tier_id: t.tier_id,
      tier_name: t.tier_name,
      imported_at: new Date().toISOString(),
      imported_by: uploadedBy,
    }));
    if (tierMetaRows.length > 0) {
      const upsertRes = await db
        .from("price_tiers")
        .upsert(tierMetaRows, { onConflict: "tier_id" });
      if (upsertRes.error) {
        throw new Error(`Tier metadata upsert failed: ${upsertRes.error.message}`);
      }
    }

    // 3. Delete the existing template for this scope (CASCADE wipes entries).
    const existing = await fetchTemplateHeader(scope);
    if (existing) {
      const del = await db
        .from("price_tier_templates")
        .delete()
        .eq("id", existing.id);
      if (del.error) {
        throw new Error(`Failed to delete existing template: ${del.error.message}`);
      }
    }

    // 4. Insert the new header.
    const headerIns = await db
      .from("price_tier_templates")
      .insert({
        scope_type,
        scope_app_id,
        uploaded_by: uploadedBy,
        source_filename: sourceFilename,
      })
      .select("id")
      .single();
    if (headerIns.error || !headerIns.data) {
      throw new Error(
        `Failed to insert template header: ${headerIns.error?.message ?? "no data"}`,
      );
    }
    const templateId = (headerIns.data as { id: string }).id;

    // 4. Insert entries in chunks.
    const rows = flatEntries.map((e) => ({
      template_id: templateId,
      tier_id: e.tier_id,
      territory_code: e.territory_code,
      currency_code: e.currency_code,
      customer_price: e.customer_price,
      proceeds: e.proceeds,
    }));
    for (let i = 0; i < rows.length; i += ENTRY_BATCH_SIZE) {
      const chunk = rows.slice(i, i + ENTRY_BATCH_SIZE);
      const ins = await db.from("price_tier_template_entries").insert(chunk);
      if (ins.error) {
        throw new Error(
          `Failed to insert entries batch ${i / ENTRY_BATCH_SIZE}: ${ins.error.message}`,
        );
      }
    }

    // 5. Audit batch COMPLETE + log action.
    await db
      .from("import_batches")
      .update({ status: "COMPLETE", created_count: rows.length })
      .eq("id", batchId);
    await db.from("actions_log").insert({
      batch_id: batchId,
      actor: uploadedBy,
      action_type: "PRICE_TIER_IMPORT",
      payload: {
        scope: scope_type,
        scope_app_id,
        template_id: templateId,
        entry_count: rows.length,
        tier_count: parsed.tiers.length,
        territory_count: parsed.territory_count,
        warnings: parsed.warnings,
      },
    });

    return {
      template_id: templateId,
      scope_type,
      scope_app_id,
      inserted_entry_count: rows.length,
      audit_batch_id: batchId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("import_batches")
      .update({ status: "FAILED", notes: message })
      .eq("id", batchId);
    await db.from("actions_log").insert({
      batch_id: batchId,
      actor: uploadedBy,
      action_type: "PRICE_TIER_IMPORT",
      payload: { scope: scope_type, scope_app_id, error: message },
    });
    throw err;
  }
}

/**
 * Delete a template by id. CASCADE wipes the entries. Used by the Settings
 * "Remove" action — returns the deleted header for audit logging.
 */
export async function deleteTemplate(template_id: string): Promise<TemplateHeader> {
  const db = iapDb();
  const headerRes = await db
    .from("price_tier_templates")
    .select("id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename")
    .eq("id", template_id)
    .maybeSingle();
  if (headerRes.error) {
    throw new Error(`Template lookup failed: ${headerRes.error.message}`);
  }
  if (!headerRes.data) {
    throw new Error(`Template ${template_id} does not exist.`);
  }
  const header = headerRes.data as TemplateHeader;

  const del = await db
    .from("price_tier_templates")
    .delete()
    .eq("id", template_id);
  if (del.error) {
    throw new Error(`Template delete failed: ${del.error.message}`);
  }
  return header;
}
