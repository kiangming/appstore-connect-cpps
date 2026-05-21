/**
 * Pricing-template queries + mutations (g1.j).
 *
 * Mirrors the Apple IAP.p1 pattern: GLOBAL scope holds the Default
 * Template (at most one row, enforced by partial unique index); APP scope
 * holds at most one row per app. Replace-on-upload is wired via
 * delete-then-insert, transactional via two-step (delete header → insert
 * new header + entries) since supabase-js doesn't expose transactions
 * directly. A failed insert leaves the slot empty, which the upload UI
 * surfaces as an error.
 */
import { googleIapDb } from "../db";
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";

export type TemplateScope = "GLOBAL" | "APP";

export interface PricingTemplateRow {
  id: string;
  scope_type: TemplateScope;
  scope_app_id: string | null;
  uploaded_at: string;
  uploaded_by: string;
  source_filename: string | null;
}

export interface TemplateOverview {
  template: PricingTemplateRow | null;
  tierCount: number;
  territoryCount: number;
  entryCount: number;
  sampleEntries: ParsedPricingEntry[];
}

export interface AppTemplateSummary {
  app_id: string;
  package_name: string;
  display_name: string | null;
  template: PricingTemplateRow;
  tier_count: number;
  entry_count: number;
}

const SAMPLE_SIZE = 50;

async function fetchOverviewForTemplate(
  template: PricingTemplateRow | null,
): Promise<TemplateOverview> {
  if (!template) {
    return {
      template: null,
      tierCount: 0,
      territoryCount: 0,
      entryCount: 0,
      sampleEntries: [],
    };
  }
  const db = googleIapDb();
  const { data: entries, error } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", template.id)
    .order("identifier", { ascending: true })
    .order("region_code", { ascending: true });

  if (error) {
    throw new Error(`Failed to load template entries: ${error.message}`);
  }
  const rows = (entries ?? []) as Array<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>;
  const tiers = new Set<string>();
  const territories = new Set<string>();
  for (const row of rows) {
    tiers.add(row.identifier);
    territories.add(row.region_code);
  }
  return {
    template,
    tierCount: tiers.size,
    territoryCount: territories.size,
    entryCount: rows.length,
    sampleEntries: rows.slice(0, SAMPLE_SIZE).map((r) => ({
      identifier: r.identifier,
      regionCode: r.region_code,
      currency: r.currency,
      priceMicros: r.price_micros,
    })),
  };
}

export async function getGlobalTemplateOverview(): Promise<TemplateOverview> {
  const db = googleIapDb();
  const { data, error } = await db
    .from("pricing_templates")
    .select("id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename")
    .eq("scope_type", "GLOBAL")
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load default template: ${error.message}`);
  }
  return fetchOverviewForTemplate((data as PricingTemplateRow | null) ?? null);
}

export async function getAppTemplateOverview(
  appId: string,
): Promise<TemplateOverview> {
  const db = googleIapDb();
  const { data, error } = await db
    .from("pricing_templates")
    .select("id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename")
    .eq("scope_type", "APP")
    .eq("scope_app_id", appId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load app template: ${error.message}`);
  }
  return fetchOverviewForTemplate((data as PricingTemplateRow | null) ?? null);
}

export async function listAppTemplates(): Promise<AppTemplateSummary[]> {
  const db = googleIapDb();
  const { data: templates, error } = await db
    .from("pricing_templates")
    .select(
      "id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename",
    )
    .eq("scope_type", "APP")
    .order("uploaded_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list app templates: ${error.message}`);
  }
  const rows = (templates ?? []) as PricingTemplateRow[];
  if (rows.length === 0) return [];

  const appIds = rows.map((r) => r.scope_app_id).filter((x): x is string => !!x);
  const { data: apps, error: appsErr } = await db
    .from("apps")
    .select("id, package_name, display_name")
    .in("id", appIds);
  if (appsErr) {
    throw new Error(`Failed to load app metadata: ${appsErr.message}`);
  }
  const appsById = new Map(
    ((apps ?? []) as Array<{
      id: string;
      package_name: string;
      display_name: string | null;
    }>).map((a) => [a.id, a]),
  );

  const { data: entries, error: entriesErr } = await db
    .from("pricing_template_entries")
    .select("template_id, identifier")
    .in(
      "template_id",
      rows.map((r) => r.id),
    );
  if (entriesErr) {
    throw new Error(`Failed to load entry counts: ${entriesErr.message}`);
  }
  const tierByTemplate = new Map<string, Set<string>>();
  const countByTemplate = new Map<string, number>();
  for (const e of (entries ?? []) as Array<{ template_id: string; identifier: string }>) {
    const set = tierByTemplate.get(e.template_id) ?? new Set<string>();
    set.add(e.identifier);
    tierByTemplate.set(e.template_id, set);
    countByTemplate.set(e.template_id, (countByTemplate.get(e.template_id) ?? 0) + 1);
  }

  return rows
    .map((t) => {
      const app = t.scope_app_id ? appsById.get(t.scope_app_id) : undefined;
      if (!app) return null; // app row deleted but template lingered — skip
      return {
        app_id: app.id,
        package_name: app.package_name,
        display_name: app.display_name,
        template: t,
        tier_count: tierByTemplate.get(t.id)?.size ?? 0,
        entry_count: countByTemplate.get(t.id) ?? 0,
      };
    })
    .filter((x): x is AppTemplateSummary => x !== null);
}

export interface ReplaceTemplateInput {
  scope: TemplateScope;
  appId: string | null;
  uploadedBy: string;
  sourceFilename: string | null;
  entries: ParsedPricingEntry[];
}

export interface ReplaceTemplateResult {
  templateId: string;
  insertedEntryCount: number;
}

export async function replaceTemplate(
  input: ReplaceTemplateInput,
): Promise<ReplaceTemplateResult> {
  if (input.scope === "GLOBAL" && input.appId !== null) {
    throw new Error("GLOBAL scope must not carry an appId.");
  }
  if (input.scope === "APP" && !input.appId) {
    throw new Error("APP scope requires an appId.");
  }
  const db = googleIapDb();

  // Delete existing template in this slot (partial unique index ensures
  // at most one row).
  let deleteQuery = db.from("pricing_templates").delete().eq("scope_type", input.scope);
  deleteQuery =
    input.scope === "APP" && input.appId
      ? deleteQuery.eq("scope_app_id", input.appId)
      : deleteQuery.is("scope_app_id", null);
  const { error: delErr } = await deleteQuery;
  if (delErr) {
    throw new Error(`Failed to clear existing template: ${delErr.message}`);
  }

  // Insert new header.
  const { data: inserted, error: insErr } = await db
    .from("pricing_templates")
    .insert({
      scope_type: input.scope,
      scope_app_id: input.appId,
      uploaded_by: input.uploadedBy,
      source_filename: input.sourceFilename,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    throw new Error(`Failed to insert template header: ${insErr?.message ?? "unknown"}`);
  }
  const templateId = (inserted as { id: string }).id;

  // Insert entries in chunks so we don't exceed Supabase's per-request cap.
  let insertedCount = 0;
  const CHUNK = 500;
  for (let i = 0; i < input.entries.length; i += CHUNK) {
    const chunk = input.entries.slice(i, i + CHUNK).map((e) => ({
      template_id: templateId,
      identifier: e.identifier,
      region_code: e.regionCode,
      currency: e.currency,
      price_micros: e.priceMicros,
    }));
    if (chunk.length === 0) continue;
    const { error: chunkErr } = await db
      .from("pricing_template_entries")
      .insert(chunk);
    if (chunkErr) {
      throw new Error(
        `Failed to insert template entries (chunk starting at ${i}): ${chunkErr.message}`,
      );
    }
    insertedCount += chunk.length;
  }

  return { templateId, insertedEntryCount: insertedCount };
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const db = googleIapDb();
  const { error } = await db.from("pricing_templates").delete().eq("id", templateId);
  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}
