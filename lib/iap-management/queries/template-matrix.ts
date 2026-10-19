/**
 * Cycle 38 — Apple IAP pricing-template matrix data composer.
 *
 * Apple's sibling to the Cycle 36 Google composer. Same `{ tiers,
 * markets, cells }` shape so the Apple matrix view can share the
 * existing matrix-rendering primitives by structure (separate
 * components per Manager Q4.B discipline). Diff cells carry the
 * Default Template's value when a Per-App view is composed alongside
 * the Default, identical to the Google flow.
 *
 * Apple-specific differences from the Google composer:
 *   - Territory codes are ISO 3166-1 alpha-3 (USA / VNM / JPN), not
 *     alpha-2. The Cycle 31 `view-detail/territory-name` resolver
 *     handles them; the Cycle 38 `apple/territory-continent` helper
 *     buckets them.
 *   - Customer price is NUMERIC (decimal) not micros — no conversion
 *     needed at the composer or CSV layer.
 *   - Tier identifier convention: "ALT_*" prefix marks alternate
 *     tiers. The sort sends Alternate tiers after primary, mirroring
 *     the Hotfix 19 / Cycle 36 convention; numeric-aware collation
 *     within each group so "Tier 2" precedes "Tier 10".
 *
 * Reads from `iap_mgmt.price_tier_template_entries` joined with
 * `iap_mgmt.price_tiers` for the human-readable `tier_name`. Returns
 * null when the requested template doesn't exist so the page can
 * render its empty-state UI.
 */

import { iapDb } from "../db";
import { readTemplateEntries } from "./template-entries";
import {
  APPLE_CONTINENTS,
  getContinentForTerritory,
  type Continent,
} from "../apple/territory-continent";
import { territoryName } from "../../../components/iap-management/view-detail/territory-name";

export interface TemplateEntryRow {
  tier_id: string;
  territory_code: string;
  currency_code: string;
  customer_price: number;
  proceeds: number | null;
}

export interface MatrixTier {
  tier_id: string;
  tier_name: string;
  is_alternate: boolean;
}

export interface MatrixMarket {
  code: string;
  name: string;
  currency: string;
  continent: Continent | null;
}

export interface MatrixCell {
  customerPrice: number;
  currency: string;
  /** Present only when the composer was passed Default entries
   *  alongside the primary set — the Per-App view uses these to
   *  render the diff tooltip + ★ marker. */
  defaultCustomerPrice?: number;
  defaultCurrency?: string;
  isDiff?: boolean;
}

export interface MatrixData {
  tiers: MatrixTier[];
  markets: MatrixMarket[];
  /** Sparse map keyed by `${tier_id}|${territory_code}`. */
  cells: Record<string, MatrixCell>;
  currenciesUsed: string[];
  continentCounts: Record<Continent, number>;
}

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Apple tier sort: primary (non-`ALT_`) tiers first, alternate last;
 *  numeric-aware within each group. Mirrors Cycle 36's spirit but
 *  keys off the `ALT_` prefix that's specific to Apple's tier_id
 *  convention. */
function compareTiers(a: MatrixTier, b: MatrixTier): number {
  if (a.is_alternate !== b.is_alternate) return a.is_alternate ? 1 : -1;
  return COLLATOR.compare(a.tier_name, b.tier_name);
}

/** Pure composer: takes flat entry rows + tier metadata, builds the
 *  matrix shape. Exported so the page can call it after its own DB
 *  reads, and so tests can exercise it without mocking Supabase. */
export function composeMatrix(args: {
  entries: ReadonlyArray<TemplateEntryRow>;
  tierNames: ReadonlyMap<string, string>;
  defaultEntries?: ReadonlyArray<TemplateEntryRow>;
  /** Column order (Hotfix 24). Codes not listed — or every code, when this
   *  is absent — follow in the order they first appear in `entries`. Codes
   *  listed but absent from `entries` are ignored: the ORDER never adds or
   *  removes a column, only `entries` does. */
  marketOrder?: ReadonlyArray<string>;
}): MatrixData {
  const { entries, tierNames, defaultEntries, marketOrder } = args;

  const tierById = new Map<string, MatrixTier>();
  const marketCurrencyByCode = new Map<string, string>();
  const cells: Record<string, MatrixCell> = {};
  const currenciesUsed = new Set<string>();

  for (const e of entries) {
    if (!tierById.has(e.tier_id)) {
      tierById.set(e.tier_id, {
        tier_id: e.tier_id,
        tier_name: tierNames.get(e.tier_id) ?? e.tier_id,
        is_alternate: e.tier_id.startsWith("ALT_"),
      });
    }
    if (!marketCurrencyByCode.has(e.territory_code)) {
      marketCurrencyByCode.set(e.territory_code, e.currency_code);
    }
    currenciesUsed.add(e.currency_code);
    cells[`${e.tier_id}|${e.territory_code}`] = {
      customerPrice: e.customer_price,
      currency: e.currency_code,
    };
  }

  if (defaultEntries) {
    const defaultByKey = new Map<string, { price: number; currency: string }>();
    for (const d of defaultEntries) {
      defaultByKey.set(`${d.tier_id}|${d.territory_code}`, {
        price: d.customer_price,
        currency: d.currency_code,
      });
    }
    for (const [key, cell] of Object.entries(cells)) {
      const def = defaultByKey.get(key);
      if (!def) continue;
      cell.defaultCustomerPrice = def.price;
      cell.defaultCurrency = def.currency;
      cell.isDiff =
        def.price !== cell.customerPrice || def.currency !== cell.currency;
    }
  }

  const tiers = Array.from(tierById.values()).sort(compareTiers);

  // Hotfix 24 — preserve Excel upload order. Manager's `.xlsx` lists
  // markets left-to-right in business-priority order (VN first, then
  // SEA neighbours, then larger markets). Pre-Hotfix-24 the matrix
  // sorted alphabetically by country name, which buried Manager's
  // intent. The order comes from `marketOrder` (the fetchers below read it
  // with today's unordered query — R6 split ORDER from CONTENT); without
  // it, first appearance in `entries`.
  const orderedCodes = new Set<string>();
  for (const code of marketOrder ?? []) {
    if (marketCurrencyByCode.has(code)) orderedCodes.add(code);
  }
  for (const code of marketCurrencyByCode.keys()) orderedCodes.add(code);
  const markets: MatrixMarket[] = Array.from(orderedCodes, (code) => ({
    code,
    name: territoryName(code),
    currency: marketCurrencyByCode.get(code)!,
    continent: getContinentForTerritory(code),
  }));

  const continentCounts: Record<Continent, number> = {
    Asia: 0,
    Europe: 0,
    Americas: 0,
    Africa: 0,
    Oceania: 0,
  };
  for (const m of markets) {
    if (m.continent) continentCounts[m.continent] += 1;
  }

  return {
    tiers,
    markets,
    cells,
    currenciesUsed: Array.from(currenciesUsed).sort(),
    continentCounts,
  };
}

// ── DB-bound fetchers ────────────────────────────────────────────────────────

/**
 * C-A [ACCOUNT-default-template]: `{ scope: "GLOBAL" }` (không tham số) đổi
 * thành `{ scope: "ACCOUNT"; accountId }` — bắt buộc. Cùng mục đích với
 * TemplateScope ở queries/templates.ts: `tsc` phải bắt được mọi chỗ đọc
 * template mặc định mà không nói của account nào.
 */
type ScopeQuery =
  | { scope: "ACCOUNT"; accountId: string }
  | { scope: "APP"; appId: string };

async function fetchTemplateId(scope: ScopeQuery): Promise<string | null> {
  const db = iapDb();
  let q = db
    .from("price_tier_templates")
    .select("id")
    .eq("scope_type", scope.scope);
  q =
    scope.scope === "APP"
      ? q.eq("scope_app_id", scope.appId)
      : q.eq("scope_account_id", scope.accountId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`fetchTemplateId failed: ${error.message}`);
  return data ? (data as { id: string }).id : null;
}

const ORDER_PAGE_SIZE = 1000;

/**
 * R6 — the Hotfix 24 column ORDER, read apart from the CONTENT.
 *
 * The content now comes from `readTemplateEntries` (ordered by the primary
 * key, proven complete). That order would turn the columns alphabetical, so
 * the column order is still taken the way it always was — first appearance
 * in a read WITHOUT ORDER BY (heap order ≈ upload order) — but from a read
 * that returns only `territory_code` and never decides what is IN the
 * matrix: a row it misses or repeats can move a column, never drop or add a
 * cell. It stops as soon as every territory of the content has appeared
 * (one page for a full grid). Codes it never saw are appended by
 * `composeMatrix`.
 *
 * ⚠ This order is exactly as stable as before R6, no more: measured, heap
 *   order is not always upload order and the plan can change it. Only a
 *   persisted order (a migration) would guarantee it.
 */
async function fetchMarketOrder(
  templateId: string,
  codes: ReadonlySet<string>,
): Promise<string[]> {
  const db = iapDb();
  const order: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (seen.size < codes.size) {
    const pageRes = await db
      .from("price_tier_template_entries")
      .select("territory_code")
      .eq("template_id", templateId)
      .range(offset, offset + ORDER_PAGE_SIZE - 1);
    if (pageRes.error) {
      throw new Error(`Matrix column order fetch failed: ${pageRes.error.message}`);
    }
    const page = (pageRes.data ?? []) as Array<{ territory_code: string }>;
    if (page.length === 0) break;
    for (const { territory_code } of page) {
      if (codes.has(territory_code) && !seen.has(territory_code)) {
        seen.add(territory_code);
        order.push(territory_code);
      }
    }
    offset += page.length;
  }
  return order;
}

/** Content (complete, via the shared reader) + Hotfix 24 column order. */
async function fetchMatrixEntries(
  templateId: string,
): Promise<{ entries: TemplateEntryRow[]; marketOrder: string[] }> {
  const entries = await readTemplateEntries(templateId);
  if (entries.length === 0) return { entries, marketOrder: [] };
  const marketOrder = await fetchMarketOrder(
    templateId,
    new Set(entries.map((e) => e.territory_code)),
  );
  return { entries, marketOrder };
}

async function fetchTierNames(): Promise<Map<string, string>> {
  const db = iapDb();
  const { data, error } = await db
    .from("price_tiers")
    .select("tier_id, tier_name");
  if (error) throw new Error(`Tier metadata fetch failed: ${error.message}`);
  return new Map(
    ((data ?? []) as Array<{ tier_id: string; tier_name: string }>).map(
      (t) => [t.tier_id, t.tier_name],
    ),
  );
}

export interface TemplateHeaderInfo {
  id: string;
  uploaded_at: string;
  uploaded_by: string;
  source_filename: string | null;
}

async function fetchTemplateHeader(
  templateId: string,
): Promise<TemplateHeaderInfo | null> {
  const db = iapDb();
  const { data, error } = await db
    .from("price_tier_templates")
    .select("id, uploaded_at, uploaded_by, source_filename")
    .eq("id", templateId)
    .maybeSingle();
  if (error) throw new Error(`Template header fetch failed: ${error.message}`);
  return (data as TemplateHeaderInfo | null) ?? null;
}

export interface AppleMatrixResult {
  matrix: MatrixData;
  header: TemplateHeaderInfo;
}

/** Default matrix của MỘT account. Returns null when no Default Template
 *  exists — the page renders its empty state. */
export async function fetchDefaultMatrix(
  accountId: string,
): Promise<AppleMatrixResult | null> {
  const templateId = await fetchTemplateId({ scope: "ACCOUNT", accountId });
  if (!templateId) return null;
  const [{ entries, marketOrder }, tierNames, header] = await Promise.all([
    fetchMatrixEntries(templateId),
    fetchTierNames(),
    fetchTemplateHeader(templateId),
  ]);
  if (entries.length === 0 || !header) return null;
  return { matrix: composeMatrix({ entries, tierNames, marketOrder }), header };
}

/** Per-App matrix; loads Default entries in parallel so cells can be
 *  diff-annotated against the Default. Returns null when the Per-App
 *  template hasn't been uploaded — the page renders its empty state. */
export async function fetchPerAppMatrix(
  appId: string,
  /** ⚠ C-A: BẮT BUỘC. Hàm này đọc CẢ template mặc định (để diff-annotate ô),
   *  nên nó cũng là một "đường đọc GLOBAL" — census §0.4 ban đầu bỏ sót nó
   *  vì chỉ grep theo tên hàm ở tầng page, không lần vào trong. */
  accountId: string,
): Promise<AppleMatrixResult | null> {
  const [perAppTemplateId, defaultTemplateId] = await Promise.all([
    fetchTemplateId({ scope: "APP", appId }),
    fetchTemplateId({ scope: "ACCOUNT", accountId }),
  ]);
  if (!perAppTemplateId) return null;
  const [perApp, defaultEntries, tierNames, header] = await Promise.all([
    fetchMatrixEntries(perAppTemplateId),
    // The Default is only diffed against, never laid out: content only.
    defaultTemplateId ? readTemplateEntries(defaultTemplateId) : Promise.resolve([]),
    fetchTierNames(),
    fetchTemplateHeader(perAppTemplateId),
  ]);
  if (perApp.entries.length === 0 || !header) return null;
  return {
    matrix: composeMatrix({
      entries: perApp.entries,
      tierNames,
      defaultEntries,
      marketOrder: perApp.marketOrder,
    }),
    header,
  };
}

export { APPLE_CONTINENTS };
export type { Continent };
