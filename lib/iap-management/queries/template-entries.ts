/**
 * R6 (2026-10-19) — THE ONE reader of `iap_mgmt.price_tier_template_entries`
 * content (KB P1: one choke point). `templates.ts` (orchestrator, custom-
 * prices baseline, Settings overview) and `template-matrix.ts` (matrix view +
 * export) both read through here.
 *
 * Its own module, not a function inside `templates.ts`, on purpose: it needs
 * nothing but `iapDb`, so `template-matrix.ts` can import it without pulling
 * `templates.ts`'s account repository (which builds a Supabase client at
 * import time) into every test and module that composes a matrix.
 *
 * It takes a template ID the caller already resolved through a scope-checked
 * helper (`fetchTemplateHeader` / `fetchTemplateId`) — it never resolves a
 * scope itself, so it adds no way to read another account's template.
 */
import { iapDb } from "../db";
import type { FlatTemplateEntry } from "../parsers/price-tiers";

/** R6 — a read of a template's entries that could not be proven complete.
 *  Thrown instead of returning the rows: a partial template is not a
 *  smaller template, it is a wrong one (every missing cell silently falls
 *  back to Apple's price, or — through a matrix export — becomes "no
 *  override"). */
export class TemplateEntriesIncompleteError extends Error {
  constructor(
    readonly templateId: string,
    readonly expected: number,
    readonly rowsRead: number,
    readonly distinctRead: number,
  ) {
    super(
      `Pricing template ${templateId} could not be read completely: read ${rowsRead} rows ` +
        `(${distinctRead} distinct) of ${expected}. The partial read was discarded — try again.`,
    );
    this.name = "TemplateEntriesIncompleteError";
  }
}

const ENTRY_PAGE_SIZE = 1000;

/**
 * THE ONE way to read a template's entries (KB P1 — one choke point). The
 * pricing orchestrator, the custom-prices baseline, the Settings overview
 * and the matrix view / export all read through here.
 *
 * R6 (2026-10-19) — two rules, both required:
 *
 * 1. ORDER BY the unique key (tier_id, territory_code) on EVERY page. With
 *    `template_id` fixed this is the primary key, so the order is total and
 *    does not depend on the query plan. Without it, Postgres may pick an
 *    index scan for the first OFFSETs and a heap scan for the later ones:
 *    measured on Postgres 17.5 with the real 16 625-entry template, pages
 *    overlapped and skipped so exactly that duplicates and misses netted to
 *    `count` — 1 225 overrides gone, HTTP 200, no log.
 *
 * 2. The read must PROVE it is complete: rows read == count == distinct
 *    keys, or it throws. Pages advance by the rows actually received, so a
 *    PostgREST `max_rows` below the page size costs more requests instead of
 *    silently skipping rows (IAP.p1.j Issue 2 was the 1 000-row version of
 *    the same silent truncation). A template replaced while being read, or a
 *    count that cannot be had at all, ends in an error — never in fewer rows.
 *
 * ⚠ Not caught by rule 2: a read that starts AFTER a concurrent
 *   `replaceTemplate` inserted only part of the new template — the count
 *   agrees with the partial state. That is the non-atomic write (R7), not
 *   this read.
 */
export async function readTemplateEntries(templateId: string): Promise<FlatTemplateEntry[]> {
  const db = iapDb();
  const countRes = await db
    .from("price_tier_template_entries")
    .select("template_id", { count: "exact", head: true })
    .eq("template_id", templateId);
  if (countRes.error) {
    throw new Error(`Template entries count failed: ${countRes.error.message}`);
  }
  if (typeof countRes.count !== "number") {
    throw new Error(
      `Template entries count unavailable for ${templateId} — cannot prove the read is complete.`,
    );
  }
  const total = countRes.count;
  const entries: FlatTemplateEntry[] = [];
  let offset = 0;
  while (offset < total) {
    const pageRes = await db
      .from("price_tier_template_entries")
      .select("tier_id, territory_code, currency_code, customer_price, proceeds")
      .eq("template_id", templateId)
      .order("tier_id", { ascending: true })
      .order("territory_code", { ascending: true })
      .range(offset, offset + ENTRY_PAGE_SIZE - 1);
    if (pageRes.error) {
      throw new Error(`Template entries page fetch failed: ${pageRes.error.message}`);
    }
    const page = (pageRes.data ?? []) as FlatTemplateEntry[];
    if (page.length === 0) break;
    entries.push(...page);
    offset += page.length;
  }
  const distinctRead = new Set(entries.map((e) => `${e.tier_id}|${e.territory_code}`)).size;
  if (entries.length !== total || distinctRead !== total) {
    console.error(
      `[iap-templates] entries read incomplete template=${templateId} expected=${total} ` +
        `rows=${entries.length} distinct=${distinctRead}`,
    );
    throw new TemplateEntriesIncompleteError(templateId, total, entries.length, distinctRead);
  }
  return entries;
}
