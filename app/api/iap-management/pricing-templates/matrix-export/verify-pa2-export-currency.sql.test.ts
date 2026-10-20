/**
 * PA2 push gate — docs/iap-management/queries/verify-pa2-export-currency.sql
 * (Manager 2026-10-20: "V2 = 0 dòng ⇒ đi tiếp; ≠ 0 ⇒ DỪNG").
 *
 * The Manager reads "V2 shows only the TOTAL row" as "nobody will hit the 409
 * of Export for editing". That reading is only true if V2 lists EXACTLY the
 * (template, territory) pairs the export refuses — a territory V2 misses is a
 * false "safe to push" (the failure that matters). So this file pins:
 *   S1 the 175-row table in BOTH blocks is the code's snapshot (same pairs,
 *      same order) — the export and the import check against that snapshot;
 *   S2 on REAL Postgres (PGlite) with the real 16 625-entry Default: V2-a sees
 *      the data, V2 shows the TOTAL row only, the export says 200;
 *   S3 for every kind of refusal (and combinations): V2's rows name the same
 *      territories, with the same label, as the route's 409 body.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPgIapDb,
  loadRealTemplateFile,
  type PgIapDb,
} from "@/lib/iap-management/queries/pglite-iap-db.test-helper";
import { APPLE_TERRITORIES } from "@/lib/iap-management/apple/apple-territories.snapshot";

const ACCOUNT = { id: "acct-v2", name: "V2 Account" };

vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession: vi.fn(async () => ({ user: { email: "manager@example.test", role: "admin" } })),
  IapUnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount: vi.fn(async () => ({ id: "acct-v2", name: "V2 Account" })) }));
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn(), findAllAccountsPublic: vi.fn() }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));

import { POST } from "./route";

const SQL = readFileSync(join(process.cwd(), "docs/iap-management/queries/verify-pa2-export-currency.sql"), "utf8");
function block(name: string): string {
  const m = new RegExp(`-- @@ BEGIN ${name} —[^\\n]*\\n([\\s\\S]*?)-- @@ END`).exec(SQL);
  if (!m) throw new Error(`no block ${name}`);
  return m[1];
}
const V2A = block("V2-a");
const V2 = block("V2");

type Row = {
  problem: string;
  scope_type: string | null;
  app_bundle_id: string | null;
  territory_code: string | null;
  stored_currencies: string[] | null;
  apple_currency: string | null;
  entries: number | null;
  template_id: string | null;
};
let h: PgIapDb;

/** Per-App cases: one kind of refusal each, and the combinations. */
const usa = { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null };
const e = (tier_id: string, territory_code: string, currency_code: string) => ({ tier_id, territory_code, currency_code, customer_price: 1, proceeds: null });
const CASES = [
  { key: "mixed", entries: [usa, e("TIER_1", "XKS", "EUR"), e("TIER_2", "XKS", "USD")], expect: { MIXED: ["XKS"] } },
  { key: "not-apple", entries: [usa, e("TIER_1", "VNM", "USD")], expect: { NOT_APPLE: ["VNM"] } },
  { key: "not-sold", entries: [usa, e("TIER_1", "ZZZ", "USD")], expect: { NOT_SOLD: ["ZZZ"] } },
  { key: "both", entries: [usa, e("TIER_1", "VNM", "USD"), e("TIER_1", "XKS", "EUR"), e("TIER_2", "XKS", "USD")], expect: { MIXED: ["XKS"], NOT_APPLE: ["VNM"] } },
  { key: "mixed-neither-apple", entries: [usa, e("TIER_1", "VNM", "USD"), e("TIER_2", "VNM", "EUR")], expect: { MIXED: ["VNM"] } },
  { key: "mixed-and-not-sold", entries: [usa, e("TIER_1", "ZZZ", "USD"), e("TIER_2", "ZZZ", "EUR")], expect: { MIXED: ["ZZZ"] } },
  { key: "near-misses", entries: [usa, e("TIER_1", "vnm", "VND"), e("TIER_1", "THA", "thb"), e("TIER_1", "JPN", "JPY ")], expect: { NOT_SOLD: ["vnm"], NOT_APPLE: ["JPN", "THA"] } },
  { key: "clean", entries: [usa, e("TIER_1", "VNM", "VND"), e("TIER_1", "XKS", "EUR")], expect: {} },
] as const;

beforeAll(async () => {
  const file = await loadRealTemplateFile();
  h = await createPgIapDb();
  await h.insertTiers(file.parsed.tiers);
  await h.insertTemplate(file.entries, { account: ACCOUNT.id });
  for (const c of CASES) {
    await h.insertApp({ id: `app-${c.key}`, bundle_id: `com.v2.${c.key}`, name: c.key });
    await h.insertTemplate([...c.entries], { app: `app-${c.key}` });
  }
  dbHolder.current = h.db;
}, 60_000);

const v2Rows = async () => (await h.pg.query<Row>(V2)).rows;
async function exportEdit(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, mode: "edit" }),
    }),
  );
  const json = res.status === 200 ? {} : ((await res.json()) as { mixedCurrencyTerritories?: string[]; notAppleCurrencyTerritories?: string[] });
  return { status: res.status, mixed: json.mixedCurrencyTerritories ?? [], notApple: json.notAppleCurrencyTerritories ?? [] };
}

describe("verify-pa2-export-currency.sql — the push gate says what the export does", () => {
  it("S1 both blocks carry the code's 175-territory table, pair for pair, in order", () => {
    const want = APPLE_TERRITORIES.map((t) => `${t.code}:${t.currency}`);
    expect(want).toHaveLength(175);
    for (const sql of [V2A, V2]) {
      const got = [...sql.matchAll(/\('([A-Z]{3})','([A-Z]{3})'\)/g)].map((m) => `${m[1]}:${m[2]}`);
      expect(got).toEqual(want);
    }
  });

  it("S2 the real Default: V2-a sees the data; V2 is the TOTAL row and nothing for it; the export answers 200", async () => {
    const [a] = (await h.pg.query<{ snap_rows: number; templates: number; entries: number }>(V2A)).rows;
    expect(a).toEqual({ snap_rows: 175, templates: 1 + CASES.length, entries: 16_625 + CASES.reduce((n, c) => n + c.entries.length, 0) });
    const rows = await v2Rows();
    expect(rows.filter((r) => r.scope_type === "ACCOUNT")).toEqual([]);
    expect((await exportEdit({ scope: "default", accountId: ACCOUNT.id })).status).toBe(200);
    // The TOTAL row is always there and always last — "no rows" can never be read as "safe".
    const total = rows[rows.length - 1];
    expect(total.problem).toBe(
      `TOTAL: ${rows.length - 1} problem rows · ${1 + CASES.length} templates · ${a.entries} entries scanned`,
    );
    expect([total.scope_type, total.territory_code, total.template_id]).toEqual([null, null, null]);
  });

  it.each(CASES.map((c) => [c.key, c] as const))("S3 %s: V2 lists exactly the territories the 409 names, with the same label", async (_k, c) => {
    const route = await exportEdit({ scope: "per-app", appId: `app-${c.key}` });
    const rows = (await v2Rows()).filter((r) => r.app_bundle_id === `com.v2.${c.key}`);
    const byLabel = (label: string) => rows.filter((r) => r.problem === label).map((r) => r.territory_code).sort();
    expect({ MIXED: byLabel("MIXED"), NOT_APPLE: byLabel("NOT_APPLE"), NOT_SOLD: byLabel("NOT_SOLD") }).toEqual({
      MIXED: [...("MIXED" in c.expect ? c.expect.MIXED : [])],
      NOT_APPLE: [...("NOT_APPLE" in c.expect ? c.expect.NOT_APPLE : [])],
      NOT_SOLD: [...("NOT_SOLD" in c.expect ? c.expect.NOT_SOLD : [])],
    });
    // …and the route agrees: MIXED ⇔ mixedCurrencyTerritories; NOT_APPLE / NOT_SOLD ⇔ notAppleCurrencyTerritories.
    expect(route.status).toBe(rows.length > 0 ? 409 : 200);
    expect([...route.mixed].sort()).toEqual(byLabel("MIXED"));
    expect([...route.notApple].sort()).toEqual([...byLabel("NOT_APPLE"), ...byLabel("NOT_SOLD")].sort());
  });
});
