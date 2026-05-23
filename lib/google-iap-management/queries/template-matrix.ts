/**
 * Cycle 36 — pricing-template matrix data composer.
 *
 * Builds the `{ tiers, markets, cells }` shape the Default and Per-App
 * matrix views consume. Pure functions over a flat
 * `pricing_template_entries` array — the DB-bound wrappers live below
 * and call `composeMatrix` after fetching.
 *
 * Cell key is `${tier_identifier}|${region_code}` — the natural unique
 * key for a template entry. The composer never mutates input.
 *
 * Per-App matrix views need diff info against the Default Template; the
 * composer accepts an optional `defaultEntries` parameter and, when
 * present, annotates each cell with `defaultPriceMicros` / `isDiff` so
 * the client can render the ★ marker + tooltip without re-fetching.
 */
import { googleIapDb } from "../db";
import {
  getContinentForRegion,
  type Continent,
} from "../region-continent";
import { regionNameFromCode } from "../region-name";

/** Raw row shape from `pricing_template_entries`. */
export interface TemplateEntryRow {
  identifier: string;
  region_code: string;
  currency: string;
  price_micros: string;
}

export interface MatrixMarket {
  code: string;
  name: string;
  currency: string;
  continent: Continent | null;
}

export interface MatrixCell {
  priceMicros: string;
  currency: string;
  /** Present only when a Default Template was passed alongside the
   *  primary entries — the Per-App view uses it to render the diff
   *  tooltip. Identical-cell semantics: same currency + same micros. */
  defaultPriceMicros?: string;
  defaultCurrency?: string;
  isDiff?: boolean;
}

export interface MatrixData {
  tiers: string[];
  markets: MatrixMarket[];
  /** Sparse map keyed by `${tier}|${region}`. */
  cells: Record<string, MatrixCell>;
  /** Currencies actually used by the template, sorted alphabetically.
   *  Powers the "template-used currencies only" dropdown (Manager Q2). */
  currenciesUsed: string[];
  /** Per-continent market counts. UI uses these in the toggle pills. */
  continentCounts: Record<Continent, number>;
}

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Tier sort: numeric-aware so "Tier 2" < "Tier 10"; non-Alternate
 *  identifiers precede Alternate ones. Mirrors the spirit of
 *  `getPrimaryTierFromCandidates` in `queries/templates.ts` (Hotfix 19). */
function compareTiers(a: string, b: string): number {
  const isAltA = /^alternate\b/i.test(a.trim());
  const isAltB = /^alternate\b/i.test(b.trim());
  if (isAltA !== isAltB) return isAltA ? 1 : -1;
  return COLLATOR.compare(a, b);
}

/** Pure composer: take a flat entry list (optionally + a Default
 *  Template entry list for diff) and yield the matrix shape. */
export function composeMatrix(
  entries: ReadonlyArray<TemplateEntryRow>,
  defaultEntries?: ReadonlyArray<TemplateEntryRow>,
): MatrixData {
  const tierSet = new Set<string>();
  const marketCurrencyByCode = new Map<string, string>();
  const cells: Record<string, MatrixCell> = {};
  const currenciesUsed = new Set<string>();

  for (const e of entries) {
    tierSet.add(e.identifier);
    if (!marketCurrencyByCode.has(e.region_code)) {
      marketCurrencyByCode.set(e.region_code, e.currency);
    }
    currenciesUsed.add(e.currency);
    const key = `${e.identifier}|${e.region_code}`;
    cells[key] = { priceMicros: e.price_micros, currency: e.currency };
  }

  if (defaultEntries) {
    const defaultByKey = new Map<string, { priceMicros: string; currency: string }>();
    for (const d of defaultEntries) {
      defaultByKey.set(`${d.identifier}|${d.region_code}`, {
        priceMicros: d.price_micros,
        currency: d.currency,
      });
    }
    for (const [key, cell] of Object.entries(cells)) {
      const def = defaultByKey.get(key);
      if (!def) continue;
      cell.defaultPriceMicros = def.priceMicros;
      cell.defaultCurrency = def.currency;
      cell.isDiff =
        def.priceMicros !== cell.priceMicros || def.currency !== cell.currency;
    }
  }

  const tiers = Array.from(tierSet).sort(compareTiers);

  const markets: MatrixMarket[] = Array.from(marketCurrencyByCode.entries())
    .map(([code, currency]) => ({
      code,
      name: regionNameFromCode(code),
      currency,
      continent: getContinentForRegion(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

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

/** Fetch every entry for a template id. Returns [] when templateId is
 *  null (caller's responsibility to short-circuit the empty-state UI). */
async function fetchEntriesForTemplate(
  templateId: string | null,
): Promise<TemplateEntryRow[]> {
  if (!templateId) return [];
  const db = googleIapDb();
  const { data, error } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", templateId);
  if (error) {
    throw new Error(`Failed to load template entries: ${error.message}`);
  }
  return (data ?? []) as TemplateEntryRow[];
}

async function findTemplateIdForScope(args: {
  scope: "GLOBAL" | "APP";
  appId: string | null;
}): Promise<string | null> {
  const db = googleIapDb();
  let q = db
    .from("pricing_templates")
    .select("id")
    .eq("scope_type", args.scope);
  q =
    args.scope === "APP" && args.appId
      ? q.eq("scope_app_id", args.appId)
      : q.is("scope_app_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) {
    throw new Error(`findTemplateIdForScope failed: ${error.message}`);
  }
  return data ? (data as { id: string }).id : null;
}

/** Server-side fetcher for the Default matrix view. Returns null when
 *  no Default Template exists — the page renders the empty state. */
export async function fetchDefaultMatrix(): Promise<MatrixData | null> {
  const templateId = await findTemplateIdForScope({
    scope: "GLOBAL",
    appId: null,
  });
  if (!templateId) return null;
  const entries = await fetchEntriesForTemplate(templateId);
  if (entries.length === 0) return null;
  return composeMatrix(entries);
}

/** Server-side fetcher for the Per-App matrix view. Loads the app's
 *  entries + the Default Template entries (when present) so the
 *  composer can annotate diff cells. Returns null when the Per-App
 *  template has not been uploaded — the page renders the empty state. */
export async function fetchPerAppMatrix(appId: string): Promise<MatrixData | null> {
  const [perAppTemplateId, defaultTemplateId] = await Promise.all([
    findTemplateIdForScope({ scope: "APP", appId }),
    findTemplateIdForScope({ scope: "GLOBAL", appId: null }),
  ]);
  if (!perAppTemplateId) return null;
  const [perAppEntries, defaultEntries] = await Promise.all([
    fetchEntriesForTemplate(perAppTemplateId),
    fetchEntriesForTemplate(defaultTemplateId),
  ]);
  if (perAppEntries.length === 0) return null;
  return composeMatrix(perAppEntries, defaultEntries);
}
