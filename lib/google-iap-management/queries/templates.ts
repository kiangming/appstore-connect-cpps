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
import { microsToDecimal } from "../google/price-conversion";
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

/** Availability flags for the 3-source pricing selector (Q-GIAP.D). */
export interface PricingTemplateAvailability {
  defaultExists: boolean;
  appExists: boolean;
}

export async function getTemplateAvailability(
  appId: string | null,
): Promise<PricingTemplateAvailability> {
  const db = googleIapDb();
  const globalCount = await db
    .from("pricing_templates")
    .select("id", { count: "exact", head: true })
    .eq("scope_type", "GLOBAL");
  const defaultExists = (globalCount.count ?? 0) > 0;

  let appExists = false;
  if (appId) {
    const appCount = await db
      .from("pricing_templates")
      .select("id", { count: "exact", head: true })
      .eq("scope_type", "APP")
      .eq("scope_app_id", appId);
    appExists = (appCount.count ?? 0) > 0;
  }
  return { defaultExists, appExists };
}

/** Lookup all entries for a given (scope, appId, identifier) tuple.
 *  Returns the most-specific template's entries when present
 *  (Q-GIAP.D: App template > Default template > base price). */
export async function lookupTemplateEntriesForIdentifier(
  args: {
    scope: TemplateScope;
    appId: string | null;
    identifier: string;
  },
): Promise<ParsedPricingEntry[]> {
  // Hotfix 17: hard-fail on scope=APP + missing appId. The pre-Hotfix-17
  // code silently treated this as a GLOBAL query (the `&& args.appId`
  // short-circuit fell through to the `is("scope_app_id", null)`
  // clause), which would have surfaced Per-App misuse as a Default-
  // template result — a debugging nightmare. Force the caller to be
  // explicit.
  if (args.scope === "APP" && !args.appId) {
    throw new Error(
      'lookupTemplateEntriesForIdentifier: scope="APP" requires a non-empty appId.',
    );
  }
  const db = googleIapDb();
  let templateQuery = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  templateQuery =
    args.scope === "APP"
      ? templateQuery.eq("scope_app_id", args.appId!)
      : templateQuery.is("scope_app_id", null);
  const { data: template, error } = await templateQuery.maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;
  const { data: entries, error: entriesErr } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", templateId)
    .eq("identifier", args.identifier);
  if (entriesErr) {
    throw new Error(`Failed to load template entries: ${entriesErr.message}`);
  }
  return ((entries ?? []) as Array<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>).map((r) => ({
    identifier: r.identifier,
    regionCode: r.region_code,
    currency: r.currency,
    priceMicros: r.price_micros,
  }));
}

/** Pure helper: from a flat array of pricing-template entries, find the
 *  tier identifier whose (currency, price_micros) pair matches the
 *  request. Region-agnostic — within a single tier the (currency,
 *  price) pair uniquely identifies the tier even when multiple regions
 *  share the same currency (e.g. multiple Eurozone regions under EUR
 *  all carry the same tier-EUR price).
 *
 *  Hotfix 16 generalisation: replaces the USD-only `pickTierByUsdMicros`
 *  helper Hotfix 15 shipped. Backward-compat alias preserved below.
 *
 *  Returns the first matching tier identifier (deterministic = query
 *  order). Returns null when no entry matches.
 *
 *  Exported so it can be unit-tested without mocking the DB client.
 *  Used by `findTemplateTierByCurrencyMicros` (the I/O wrapper). */
export function pickTierByCurrencyMicros(
  entries: ReadonlyArray<{
    identifier: string;
    currency: string;
    price_micros: string;
  }>,
  currencyCode: string,
  priceMicros: string,
): string | null {
  const normalisedCurrency = currencyCode.trim().toUpperCase();
  for (const e of entries) {
    if (e.currency !== normalisedCurrency) continue;
    if (e.price_micros === priceMicros) return e.identifier;
  }
  return null;
}

/** Hotfix 15 USD-only pure picker, kept as a thin alias over the
 *  Hotfix 16 currency-aware picker. Pre-existing tests still exercise
 *  this signature; new code should call `pickTierByCurrencyMicros`. */
export function pickTierByUsdMicros(
  entries: ReadonlyArray<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>,
  usdMicros: string,
): string | null {
  // Preserve the pre-Hotfix-16 enforcement: only US-region rows count
  // for the USD-only path. Hotfix 16's currency-aware path doesn't need
  // the region constraint because EUR can legitimately appear under
  // multiple Eurozone region codes.
  const usOnly = entries.filter(
    (e) => e.region_code === "US" && e.currency === "USD",
  );
  return pickTierByCurrencyMicros(usOnly, "USD", usdMicros);
}

/** Hotfix 15 → Hotfix 16: currency-aware tier inference for bulk-import.
 *
 *  Bulk-import looks up template entries WHERE identifier = row.sku
 *  first (documented design). When that returns zero entries —
 *  typically because Manager's template indexes entries by tier name
 *  ("Tier 1") rather than SKU — the orchestrator falls back here:
 *  find the tier whose entry for the row's base currency matches the
 *  row's base price in micros.
 *
 *  Hotfix 16: generalised from the Hotfix 15 USD-only variant so
 *  non-USD app workflows (Manager's VND apps, Eurozone apps, etc.)
 *  also benefit from template inference. Region-agnostic — see
 *  pickTierByCurrencyMicros docs.
 *
 *  Returns the tier identifier or null when no match. Caller decides
 *  whether to fail the row or fall through to auto-convert.
 */
export async function findTemplateTierByCurrencyMicros(args: {
  scope: TemplateScope;
  appId: string | null;
  currencyCode: string;
  priceMicros: string;
}): Promise<string | null> {
  // Hotfix 17: same silent-fallback landmine as the SKU lookup —
  // refuse to query when scope=APP is requested without appId.
  if (args.scope === "APP" && !args.appId) {
    throw new Error(
      'findTemplateTierByCurrencyMicros: scope="APP" requires a non-empty appId.',
    );
  }
  const db = googleIapDb();
  let templateQuery = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  templateQuery =
    args.scope === "APP"
      ? templateQuery.eq("scope_app_id", args.appId!)
      : templateQuery.is("scope_app_id", null);
  const { data: template, error } = await templateQuery.maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return null;
  const templateId = (template as { id: string }).id;
  const normalisedCurrency = args.currencyCode.trim().toUpperCase();
  const { data: entries, error: entriesErr } = await db
    .from("pricing_template_entries")
    .select("identifier, currency, price_micros")
    .eq("template_id", templateId)
    .eq("currency", normalisedCurrency)
    .eq("price_micros", args.priceMicros);
  if (entriesErr) {
    throw new Error(
      `Failed to load template ${normalisedCurrency} entries: ${entriesErr.message}`,
    );
  }
  const rows = (entries ?? []) as Array<{
    identifier: string;
    currency: string;
    price_micros: string;
  }>;
  return pickTierByCurrencyMicros(rows, normalisedCurrency, args.priceMicros);
}

/** @deprecated Hotfix 15 wrapper; use `findTemplateTierByCurrencyMicros`
 *  with currencyCode="USD" instead. Kept for any external caller still
 *  on the Hotfix 15 signature. */
export async function findTemplateTierByUsdMicros(args: {
  scope: TemplateScope;
  appId: string | null;
  usdPriceMicros: string;
}): Promise<string | null> {
  return findTemplateTierByCurrencyMicros({
    scope: args.scope,
    appId: args.appId,
    currencyCode: "USD",
    priceMicros: args.usdPriceMicros,
  });
}

/** Hotfix 18: companion to `templateExists` — returns the template id
 *  (UUID) for the given scope, or null if no template row exists.
 *  Used by orchestrators that need to surface which template was
 *  actually queried in audit logs + diagnostic traces (Manager debugging
 *  "audit says matched but Google received wrong price").
 *
 *  Same defensive guard as the sibling helpers: scope=APP without an
 *  appId throws before any DB I/O. */
export async function findTemplateId(args: {
  scope: TemplateScope;
  appId: string | null;
}): Promise<string | null> {
  if (args.scope === "APP" && !args.appId) {
    throw new Error('findTemplateId: scope="APP" requires a non-empty appId.');
  }
  const db = googleIapDb();
  let query = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  query =
    args.scope === "APP"
      ? query.eq("scope_app_id", args.appId!)
      : query.is("scope_app_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`findTemplateId failed: ${error.message}`);
  }
  return data ? (data as { id: string }).id : null;
}

/** Hotfix 17: lightweight existence probe — returns true when a
 *  template row exists for the given scope. For scope=APP an appId is
 *  required; throws when missing (same defensive stance as
 *  `lookupTemplateEntriesForIdentifier` / `findTemplateTierByCurrencyMicros`).
 *
 *  Used by `executeBulkImport`'s pre-flight: when Manager selects
 *  `app_template` but no Per-App template has been uploaded for this
 *  app, the orchestrator fails fast with an actionable message rather
 *  than silently auto-bootstrapping every row and leaving Manager to
 *  wonder why "Per-App" produced auto-converted prices. */
export async function templateExists(args: {
  scope: TemplateScope;
  appId: string | null;
}): Promise<boolean> {
  if (args.scope === "APP" && !args.appId) {
    throw new Error('templateExists: scope="APP" requires a non-empty appId.');
  }
  const db = googleIapDb();
  let query = db
    .from("pricing_templates")
    .select("id", { head: true, count: "exact" })
    .eq("scope_type", args.scope);
  query =
    args.scope === "APP"
      ? query.eq("scope_app_id", args.appId!)
      : query.is("scope_app_id", null);
  const { count, error } = await query;
  if (error) {
    throw new Error(`Template existence probe failed: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

/** List distinct tier identifiers under the active scope (used by the
 *  single-IAP form's tier picker when Manager picks a template source). */
export async function listTemplateTiers(args: {
  scope: TemplateScope;
  appId: string | null;
}): Promise<string[]> {
  const db = googleIapDb();
  let q = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  q =
    args.scope === "APP" && args.appId
      ? q.eq("scope_app_id", args.appId)
      : q.is("scope_app_id", null);
  const { data: template, error } = await q.maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;
  const { data: rows, error: rowsErr } = await db
    .from("pricing_template_entries")
    .select("identifier")
    .eq("template_id", templateId)
    .order("identifier", { ascending: true });
  if (rowsErr) {
    throw new Error(`Failed to load tier identifiers: ${rowsErr.message}`);
  }
  const seen = new Set<string>();
  for (const r of (rows ?? []) as Array<{ identifier: string }>) {
    seen.add(r.identifier);
  }
  return [...seen];
}

/** Hotfix 19: tier candidate descriptor surfaced to the Bulk Import wizard
 *  Preview step so Manager can disambiguate when multiple template tiers
 *  share the same `(currency, priceMicros)` pair. Production trap (batch
 *  4895756e, PASS SDK): a Per-App template had 4 tiers all priced 0.99
 *  USD — `pickTierByCurrencyMicros` returned the first one silently and
 *  Google received the wrong VN value (25,000 VND instead of 27,000 VND).
 *
 *  `vnCurrency` / `vnPriceMicros` / `vnPriceDecimal` are the VN-region
 *  row inside this tier (null when the tier has no VN entry). VN is
 *  surfaced because the Manager primarily reads VND prices when
 *  distinguishing tiers — the dropdown format is
 *  "{identifier} — {vnPriceDecimal} VND · {regionCount} regions". */
export interface TierCandidate {
  identifier: string;
  templateId: string;
  regionCount: number;
  vnCurrency: string | null;
  vnPriceMicros: string | null;
  vnPriceDecimal: string | null;
}

/** Pure helper: given a flat list of pricing-template entries and the
 *  set of candidate tier identifiers, build per-tier `TierCandidate`
 *  descriptors. Exported so the wizard's pre-selection / formatting
 *  paths can be unit-tested without mocking Supabase.
 *
 *  - `regionCount` counts distinct `region_code` values per tier.
 *  - VN entry: first row in `entries` where `region_code === "VN"` (the
 *    template parser writes one row per tier+region pair, so a single
 *    `find` is sufficient — a defensive `null` is returned when no VN
 *    row exists). */
export function buildCandidatesFromEntries(
  templateId: string,
  identifiers: ReadonlyArray<string>,
  entries: ReadonlyArray<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>,
): TierCandidate[] {
  return identifiers.map((id) => {
    const tierEntries = entries.filter((e) => e.identifier === id);
    const vnEntry = tierEntries.find((e) => e.region_code === "VN") ?? null;
    const regionCount = new Set(tierEntries.map((e) => e.region_code)).size;
    return {
      identifier: id,
      templateId,
      regionCount,
      vnCurrency: vnEntry?.currency ?? null,
      vnPriceMicros: vnEntry?.price_micros ?? null,
      // Strip trailing fractional zeros so VND/JPY (zero-fraction
      // currencies) render as "27000" not "27000.000000" without losing
      // precision for fractional currencies (e.g. "0.99" stays "0.99").
      vnPriceDecimal: vnEntry
        ? stripTrailingZeros(microsToDecimal(vnEntry.price_micros, 6))
        : null,
    };
  });
}

function stripTrailingZeros(decimal: string): string {
  if (!decimal.includes(".")) return decimal;
  return decimal.replace(/\.?0+$/, "");
}

/** Hotfix 19: returns *all* tier identifiers whose `(currency,
 *  priceMicros)` row matches the request — not just the first match
 *  (which was Hotfix 15/16's behaviour and the root cause of batch
 *  4895756e). The Bulk Import Preview step uses the array length to
 *  decide between read-only (==1) and dropdown (>1) rendering.
 *
 *  Same defensive guards as the sibling helpers (Hotfix 17): scope=APP
 *  without `appId` throws before any DB I/O. */
export async function findCandidateTiersForCurrencyPrice(args: {
  scope: TemplateScope;
  appId: string | null;
  currencyCode: string;
  priceMicros: string;
}): Promise<TierCandidate[]> {
  if (args.scope === "APP" && !args.appId) {
    throw new Error(
      'findCandidateTiersForCurrencyPrice: scope="APP" requires a non-empty appId.',
    );
  }
  const db = googleIapDb();
  let templateQuery = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  templateQuery =
    args.scope === "APP"
      ? templateQuery.eq("scope_app_id", args.appId!)
      : templateQuery.is("scope_app_id", null);
  const { data: template, error } = await templateQuery.maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;

  const normalisedCurrency = args.currencyCode.trim().toUpperCase();
  const { data: matchingRows, error: matchErr } = await db
    .from("pricing_template_entries")
    .select("identifier")
    .eq("template_id", templateId)
    .eq("currency", normalisedCurrency)
    .eq("price_micros", args.priceMicros);
  if (matchErr) {
    throw new Error(
      `Failed to load candidate tiers (${normalisedCurrency}/${args.priceMicros}): ${matchErr.message}`,
    );
  }
  const candidateIdentifiers = Array.from(
    new Set(
      ((matchingRows ?? []) as Array<{ identifier: string }>).map(
        (r) => r.identifier,
      ),
    ),
  );
  if (candidateIdentifiers.length === 0) return [];

  // Fetch all rows for the candidate tiers so we can build per-tier
  // metadata (region count + VN entry). Single query keeps fan-out
  // bounded — `IN` clause on identifier handles all candidates at once.
  const { data: allRows, error: allErr } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", templateId)
    .in("identifier", candidateIdentifiers);
  if (allErr) {
    throw new Error(
      `Failed to load candidate tier metadata: ${allErr.message}`,
    );
  }
  return buildCandidatesFromEntries(
    templateId,
    candidateIdentifiers,
    (allRows ?? []) as Array<{
      identifier: string;
      region_code: string;
      currency: string;
      price_micros: string;
    }>,
  );
}

/** Hotfix 19: unified per-row candidate lookup. Mirrors the
 *  orchestrator's two-strategy logic so the Preview API and the
 *  orchestrator agree on what the candidate set is for each row.
 *
 *  Strategy 1 (documented): SKU == template identifier — exact match.
 *  Strategy 2 (Hotfix 16): `(currency, priceMicros)` fallback. May
 *  return >1 candidates when Manager's template has alternate tiers
 *  sharing the same price (the trap Hotfix 19 fixes).
 *
 *  Caller decides ambiguity rendering:
 *    candidates.length === 0 → no template match → auto-bootstrap
 *    candidates.length === 1 → unambiguous → render read-only
 *    candidates.length  >  1 → ambiguous   → Manager picks via dropdown */
export async function findRowCandidates(args: {
  scope: TemplateScope;
  appId: string | null;
  sku: string;
  currencyCode: string;
  priceMicros: string;
}): Promise<{
  candidates: TierCandidate[];
  matchedBy: "sku" | "currency_price" | "none";
}> {
  const skuEntries = await lookupTemplateEntriesForIdentifier({
    scope: args.scope,
    appId: args.appId,
    identifier: args.sku,
  });
  if (skuEntries.length > 0) {
    const templateId = await findTemplateId({
      scope: args.scope,
      appId: args.appId,
    });
    const candidates = buildCandidatesFromEntries(
      templateId ?? "",
      [args.sku],
      skuEntries.map((e) => ({
        identifier: args.sku,
        region_code: e.regionCode,
        currency: e.currency,
        price_micros: e.priceMicros,
      })),
    );
    return { candidates, matchedBy: "sku" };
  }
  const candidates = await findCandidateTiersForCurrencyPrice({
    scope: args.scope,
    appId: args.appId,
    currencyCode: args.currencyCode,
    priceMicros: args.priceMicros,
  });
  return {
    candidates,
    matchedBy: candidates.length > 0 ? "currency_price" : "none",
  };
}

/** Pure helper: Q5.B primary-tier preference algorithm.
 *
 *  Selects a sensible default tier when multiple candidates share the
 *  same `(currency, priceMicros)`. Pure function so the UI's "primary
 *  tier pre-selected" behaviour is unit-testable.
 *
 *  Algorithm (Manager-locked, 2026-05-23):
 *    1. Filter out identifiers starting with "Alternate" (case-insensitive,
 *       word-boundary so "AlternateX" without space still matches).
 *    2. If anything remains, return the first in numeric-ascending order
 *       (Intl.Collator { numeric: true }). "Tier 1" beats "Tier 10".
 *    3. If everything was Alternate, return the first in numeric-ascending
 *       order across the full set — "Alternate Tier 1" beats "Alternate
 *       Tier A" (numeric beats alpha).
 *
 *  Returns null only when the input is empty (caller's responsibility
 *  to handle no-candidates separately — different UI state). */
export function getPrimaryTierFromCandidates(
  candidates: ReadonlyArray<{ identifier: string }>,
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].identifier;
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const isAlternate = (id: string) => /^alternate\b/i.test(id.trim());
  const nonAlternate = candidates.filter((c) => !isAlternate(c.identifier));
  const pool = nonAlternate.length > 0 ? nonAlternate : candidates;
  const sorted = [...pool].sort((a, b) =>
    collator.compare(a.identifier, b.identifier),
  );
  return sorted[0].identifier;
}

export async function deleteTemplate(templateId: string): Promise<void> {
  const db = googleIapDb();
  const { error } = await db.from("pricing_templates").delete().eq("id", templateId);
  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}
