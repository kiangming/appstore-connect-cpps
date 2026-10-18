// @vitest-environment node
/**
 * T1 — H4: "the currency written in the import FILE is the ONLY price source"
 * (Manager 2026-10-16). apps.default_currency must not change what the Manager
 * can push or what is sent to Google.
 *
 * WHAT RUNS FOR REAL: the preview route, the execute route, the parser, the
 * orchestrator, the cross-currency module, the template queries, the
 * publisher client and the one-time-product adapter. The wizard side is the
 * wizard's OWN code, not a copy: preview-row mapping, tier seeding, the Push
 * precision gate and the whole execute request body come from
 * execute-payload.ts; the custom-prices Save gate from custom-prices.ts.
 *
 * WHAT IS FAKED: googleapis (nothing is sent anywhere), the DB (in-memory;
 * any query method it does not implement, a single() over >1 rows and an
 * exchange-table miss are recorded and fail the run), the session, the
 * account list + credentials, the active account, the app row, the IAP
 * mirror, the live product a GET returns, the audit log and Hub tracking. convertRegionPrices uses a MADE-UP exchange
 * table: it shows WHICH anchor (currency + amount) the code hands Google.
 * It echoes the anchor's own region exactly — an artifact of the fake, so T1
 * is NOT evidence of what Google does with the base region.
 *
 * THE MATRIX: 11 files × 3 pricing sources × 4 app currencies (USD, TWD,
 * VND, none), each run TWICE: as a CREATE (empty mirror) and as an OVERWRITE
 * (the SKU is in the mirror, the Manager picks Overwrite, a live GET returns
 * a product with two purchase options). Overwrite prices through the SAME
 * code as CREATE (design §5.7): the test asserts it cell by cell, so the
 * invariant H4.2 establishes for CREATE holds for Overwrite too. Only the
 * PRICE of Overwrite is in scope — the "blind replace" (forced AVAILABLE,
 * auto-ACTIVATE, tax mask) is D10. Per file and source, the outcome — client gates (Push
 * precision gate, custom Save gate), preview refusal, rows refused at
 * execute, convertRegionPrices anchors, the FULL batchUpdate request and the
 * purchase-option state calls — must not depend on the app currency.
 *
 * ⚠ H4.0 PINS TODAY'S BEHAVIOUR, which violates the rule. Two pins:
 *   EXPECTED_GROUPS_TODAY (which app currencies give the same outcome) and
 *   EXPECTED_TODAY (the outcome of every cell — a characterisation pin).
 * ⚠ WHAT H4.2 MUST DO WHEN IT FLIPS T1 — "every group becomes
 *   NULL+TWD+USD+VND" ALONE IS NOT ENOUGH: refusing every row, rejecting every
 *   file, or ignoring the file currency would all pass it. H4.2 must also:
 *   (1) replace EXPECTED_TODAY with EXPECTED_H4 (one entry per file·source),
 *       derived BY HAND from Q1–Q7 BEFORE running the code;
 *   (2) add rule assertions computed from each FileCase: every pushed cell
 *       anchors on the header currency + value; no refusal except the cases
 *       Q1/Q7/Q9/Q10 name; the GT region carries the GT value when no tier
 *       matched; custom entries appear verbatim; and degeneracy guards (e.g.
 *       F3 and F4 differ under google_default).
 * ⚠ NOT Q8 COVERAGE. v3 batchUpdate always succeeds here, so the legacy
 *   inappproducts fallback can never be reached in T1; the per-run counters
 *   only prove no cell touches it or GETs a live product. Q8 (remove the
 *   batch fallback) needs its own test in H4.2: v3 rejects ⇒ the structured
 *   error comes back verbatim and inappproducts.batchUpdate is never called.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const PKG = "com.vnggames.h4probe";
const SKU = "com.vnggames.h4probe.gem1";
/** A SKU that is ALSO a tier identifier in the account template (F8). */
const SKU_TIERED = "com.vnggames.h4probe.tiered";

const g = vi.hoisted(() => ({
  convert: vi.fn(),
  batch: vi.fn(),
  get: vi.fn(),
  states: vi.fn(),
  legacy: vi.fn(),
}));
const st = vi.hoisted(() => ({
  appCurrency: null as string | null,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Anything the fakes could not answer truthfully. Must stay empty. */
  fakeErrors: [] as string[],
  /** The cached IAP mirror (listIapsForApp). */
  mirror: [] as Array<{ sku: string }>,
}));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      monetization: {
        convertRegionPrices: g.convert,
        onetimeproducts: {
          batchUpdate: g.batch,
          get: g.get,
          purchaseOptions: { batchUpdateStates: g.states },
        },
      },
      inappproducts: { batchUpdate: g.legacy },
    }),
  },
}));
vi.mock("google-auth-library", () => ({ JWT: class {} }));
vi.mock("@/lib/google-iap-management/google/auth", () => ({
  jwtClientFromEncrypted: () => ({}),
  accountTagForJwt: () => ({ accountId: "acc1", serviceAccountEmail: "sa@probe" }),
}));
vi.mock("next-auth", () => ({ getServerSession: async () => ({ user: { email: "m@vng.com.vn" } }) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts: async () => [{ id: "acc1", status: "verified" }],
  getEncryptedCredentials: async () => "enc",
}));
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage: async () => ({
    id: "app-1",
    google_console_account_id: "acc1",
    package_name: PKG,
    display_name: "H4 probe",
    default_currency: st.appCurrency,
    default_currency_source: st.appCurrency ? "declared" : null,
    default_language: "en-US",
    default_language_source: "declared",
  }),
  getIapsMirrorSyncedAt: async () => "2026-10-16T03:25:10.000Z",
}));
vi.mock("@/lib/google-iap-management/repository/iaps", () => ({
  listIapsForApp: async () => st.mirror,
  syncIapFromGoogle: async () => undefined,
}));
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({ appendAction: async () => undefined }));
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId: () => null,
  resolveActiveAccountId: () => "acc1",
}));
vi.mock("@/lib/google-iap-management/hub-tracking/tracking", () => ({ finalizeHubTracking: async () => undefined }));

/** In-memory googleIapDb() for the exact queries the bulk-import path makes. */
const fakeDb = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  function from(table: string) {
    const q = {
      op: "select" as "select" | "insert" | "update",
      filters: [] as Array<(r: Row) => boolean>,
      head: false,
      payload: null as Row | null,
      order: null as { col: string; asc: boolean } | null,
    };
    const rows = () => (st.tables[table] ??= []);
    const run = (single: boolean) => {
      if (q.op === "insert") {
        const id = `${table}-${rows().length + 1}`;
        rows().push({ id, ...(q.payload as Row) });
        return { data: single ? { id } : [{ id }], error: null };
      }
      let hit = rows().filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "update") {
        hit.forEach((r) => Object.assign(r, q.payload));
        return { data: null, error: null };
      }
      if (q.order) {
        const { col, asc } = q.order;
        hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (q.head) return { data: null, count: hit.length, error: null };
      if (!single) return { data: hit, error: null };
      if (hit.length > 1) {
        const message = `fake db: ${hit.length} rows for a single() on ${table}`;
        st.fakeErrors.push(message);
        return { data: null, error: { message } };
      }
      return { data: hit[0] ?? null, error: null };
    };
    const api: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => ((q.head = !!opts?.head), proxy),
      insert: (r: Row) => ((q.op = "insert"), (q.payload = r), proxy),
      update: (r: Row) => ((q.op = "update"), (q.payload = r), proxy),
      eq: (c: string, v: unknown) => (q.filters.push((r) => r[c] === v), proxy),
      in: (c: string, vs: unknown[]) => (q.filters.push((r) => vs.includes(r[c])), proxy),
      order: (col: string, o?: { ascending?: boolean }) => ((q.order = { col, asc: o?.ascending !== false }), proxy),
      maybeSingle: async () => run(true),
      single: async () => run(true),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, ko),
    };
    const proxy: unknown = new Proxy(api, {
      get(target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop in target) return target[prop];
        const message = `fake db: unsupported query method "${prop}" on ${table}`;
        st.fakeErrors.push(message);
        throw new Error(message);
      },
    });
    return proxy;
  }
  return { from };
});
vi.mock("@/lib/google-iap-management/db", () => ({ googleIapDb: () => ({ from: fakeDb.from }) }));

import { POST as PREVIEW } from "./preview/route";
import { POST as EXECUTE } from "./execute/route";
import {
  activeCustomSkuSet,
  buildExecuteRequestBody,
  buildExecuteRows,
  computePrecisionViolations,
  previewRowsFromResponse,
  seedTierSelections,
} from "@/components/google-iap-management/bulk-import/execute-payload";
import { customAppCurrencyGate, type CustomPriceRow } from "@/lib/google-iap-management/custom-prices";
import type { PreviewRow } from "@/components/google-iap-management/bulk-import/BulkImportWizard";
import type { CustomPriceSet } from "@/components/google-iap-management/bulk-import/CustomPricesDialog";

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/** MADE-UP units per 1 USD. Shows which anchor reaches Google, nothing more. */
const FX: Record<string, number> = { USD: 1, TWD: 32, VND: 26000, JPY: 150, EUR: 0.92, KRW: 1400 };
const ZERO_DECIMALS = new Set(["TWD", "VND", "JPY", "KRW"]);
const CATALOG: Array<[string, string]> = [
  ["US", "USD"], ["TW", "TWD"], ["VN", "VND"], ["JP", "JPY"], ["DE", "EUR"], ["KR", "KRW"],
];

type Money = { currencyCode: string; units?: string; nanos?: number };
const moneyText = (m: Money) => {
  const nanos = m.nanos ? "." + String(m.nanos).padStart(9, "0").replace(/0+$/, "") : "";
  return `${m.currencyCode} ${m.units ?? "0"}${nanos}`;
};

function fakeConvertRegionPrices(req: { requestBody: { price: Money } }) {
  const p = req.requestBody.price;
  if (!(p.currencyCode in FX)) {
    const message = `fake FX has no ${p.currencyCode}`;
    st.fakeErrors.push(message);
    throw new Error(message);
  }
  const usd = (Number(p.units ?? 0) + (p.nanos ?? 0) / 1e9) / FX[p.currencyCode];
  const out: Record<string, unknown> = {};
  for (const [region, cur] of CATALOG) {
    const raw = usd * FX[cur];
    const v = ZERO_DECIMALS.has(cur) ? Math.round(raw) : Math.round(raw * 100) / 100;
    const units = Math.floor(v);
    out[region] = {
      regionCode: region,
      price: { currencyCode: cur, units: String(units), nanos: Math.round((v - units) * 100) * 10_000_000 },
    };
  }
  return { data: { convertedRegionPrices: out, regionVersion: { version: "2025/03" } } };
}

/** An ACCOUNT template for acc1 (incl. one tier keyed by a SKU) and an APP
 *  template for app-1. */
function seedTables(): Record<string, Array<Record<string, unknown>>> {
  const e = (template_id: string, identifier: string, region_code: string, currency: string, price_micros: string, sort_order: number) =>
    ({ template_id, identifier, region_code, currency, price_micros, sort_order });
  return {
    pricing_templates: [
      { id: "tpl-acc", scope_type: "ACCOUNT", scope_account_id: "acc1", scope_app_id: null },
      { id: "tpl-app", scope_type: "APP", scope_account_id: null, scope_app_id: "app-1" },
    ],
    pricing_template_entries: [
      e("tpl-acc", "Tier 1", "US", "USD", "990000", 1),
      e("tpl-acc", "Tier 1", "TW", "TWD", "30000000", 2),
      e("tpl-acc", "Tier 1", "VN", "VND", "25000000000", 3),
      e("tpl-acc", "Tier 1", "JP", "JPY", "160000000", 4),
      e("tpl-acc", "Tier 2", "US", "USD", "1990000", 1),
      e("tpl-acc", "Tier 2", "TW", "TWD", "65000000", 2),
      e("tpl-acc", "Tier 2", "VN", "VND", "49000000000", 3),
      e("tpl-acc", SKU_TIERED, "US", "USD", "2990000", 1),
      e("tpl-acc", SKU_TIERED, "TW", "TWD", "90000000", 2),
      e("tpl-acc", SKU_TIERED, "VN", "VND", "75000000000", 3),
      e("tpl-app", "App 1", "US", "USD", "990000", 1),
      e("tpl-app", "App 1", "TW", "TWD", "32000000", 2),
      e("tpl-app", "App 1", "VN", "VND", "26000000000", 3),
    ],
    import_batches: [],
  };
}

type Source = "google_default" | "default_template" | "app_template";
type AppCurrency = "USD" | "TWD" | "VND" | null;
interface FileCase {
  id: string;
  sku?: string;
  header: string;
  value: number | string;
  gt?: [number | string, string];
  custom?: CustomPriceSet["entries"];
  convertFails?: boolean;
}

const FILES: FileCase[] = [
  { id: "F1 'Price' 0.99", header: "Price", value: 0.99 },
  { id: "F2 'Price (USD)' 0.99", header: "Price (USD)", value: 0.99 },
  { id: "F3 'Price (TWD)' 30", header: "Price (TWD)", value: 30 },
  { id: "F4 'Price (VND)' 26000", header: "Price (VND)", value: 26000 },
  { id: "F5 'Price (USD)' 0.99 + GT 26000 VND", header: "Price (USD)", value: 0.99, gt: [26000, "VND"] },
  {
    id: "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170",
    header: "Price (USD)",
    value: 0.99,
    custom: [
      { region: "TW", currency: "TWD", priceDecimal: "35" },
      { region: "JP", currency: "JPY", priceDecimal: "170" },
    ],
  },
  { id: "F7 'Price (TWD)' 30 + convertRegionPrices fails", header: "Price (TWD)", value: 30, convertFails: true },
  { id: "F8 'Price (USD)' 0.99, SKU is a tier identifier", sku: SKU_TIERED, header: "Price (USD)", value: 0.99 },
  { id: "F9 'Price (TWD)' 30.5 (too precise for TWD)", header: "Price (TWD)", value: "30.5" },
  { id: "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise)", header: "Price (USD)", value: 0.99, gt: ["26000.5", "VND"] },
  { id: "F11 'Price (TWD)' 30 + GT 26000 VND", header: "Price (TWD)", value: 30, gt: [26000, "VND"] },
];
const SOURCES: Source[] = ["google_default", "default_template", "app_template"];
const APP_CURRENCIES: AppCurrency[] = ["USD", "TWD", "VND", null];
const label = (c: AppCurrency) => c ?? "NULL";

function workbook(f: FileCase): File {
  const head = ["Product ID", f.header, ...(f.gt ? ["GT Price", "GT Currency"] : [])];
  const row = [f.sku ?? SKU, f.value, ...(f.gt ?? [])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, row]), "IAP Items");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([new Uint8Array(buf)], "h4.xlsx");
}

/** The custom set as the dialog's rows see it: only typed countries matter to
 *  the Save gate (customAppCurrencyGate reads customDecimal + currency). */
function dialogRows(entries: CustomPriceSet["entries"]): CustomPriceRow[] {
  return entries.map((e) => ({
    regionCode: e.region,
    countryName: e.region,
    currency: e.currency,
    templateDecimal: null,
    customDecimal: e.priceDecimal,
    state: "custom",
  }));
}

type Decision = "create" | "overwrite";

/** The live product an Overwrite GETs: the legacy-compatible option the tool
 *  targets, plus a second option that must come back untouched. */
const NON_TARGET_OPTION = {
  purchaseOptionId: "promo",
  buyOption: { legacyCompatible: false },
  state: "ACTIVE",
  regionalPricingAndAvailabilityConfigs: [
    { regionCode: "US", price: { currencyCode: "USD", units: "1", nanos: 0 }, availability: "AVAILABLE" },
  ],
};
function liveProduct(productId: string) {
  return {
    packageName: PKG,
    productId,
    listings: [{ languageCode: "en-US", title: "Live title", description: "" }],
    purchaseOptions: [
      {
        purchaseOptionId: "legacy-base",
        buyOption: { legacyCompatible: true },
        state: "ACTIVE",
        regionalPricingAndAvailabilityConfigs: [
          { regionCode: "US", price: { currencyCode: "USD", units: "4", nanos: 990_000_000 }, availability: "AVAILABLE" },
        ],
      },
      structuredClone(NON_TARGET_OPTION),
    ],
  };
}

interface Outcome {
  /** Compared for invariance: everything that decides what Google gets. */
  full: string;
  /** The PRICE part only (client gates, refusals, anchors, the priced
   *  option's regional configs) — must be identical for CREATE and OVERWRITE. */
  pricing: string;
  /** Overwrite only: which option was priced, and whether the other one came
   *  back exactly as Google had it. Null when nothing was sent. */
  overwrite: { targetId: string | null; nonTargetUntouched: boolean } | null;
  /** Human-readable, pinned in EXPECTED_TODAY. */
  short: string;
  calls: { batch: number; legacy: number; get: number };
}

const ctx = { params: { packageName: PKG } };

async function runOnce(f: FileCase, source: Source, appCurrency: AppCurrency, decision: Decision): Promise<Outcome> {
  st.appCurrency = appCurrency;
  st.tables = seedTables();
  st.mirror = decision === "overwrite" ? [{ sku: f.sku ?? SKU }] : [];
  Object.values(g).forEach((m) => m.mockReset());
  if (f.convertFails) {
    g.convert.mockRejectedValue(Object.assign(new Error("convert down"), { code: 503 }));
  } else {
    g.convert.mockImplementation(async (r: { requestBody: { price: Money } }) => fakeConvertRegionPrices(r));
  }
  g.batch.mockImplementation(async (r: { requestBody: { requests: Array<{ oneTimeProduct: unknown }> } }) => ({
    data: { oneTimeProducts: r.requestBody.requests.map((x) => x.oneTimeProduct) },
  }));
  g.states.mockResolvedValue({ data: {} });
  if (decision === "overwrite") {
    g.get.mockImplementation(async (r: { productId: string }) => ({ data: liveProduct(r.productId) }));
  } else {
    g.get.mockRejectedValue(new Error("T1: create rows must never GET the live product"));
  }
  g.legacy.mockRejectedValue(new Error("T1: the legacy batch fallback must never be reached"));
  const calls = () => ({ batch: g.batch.mock.calls.length, legacy: g.legacy.mock.calls.length, get: g.get.mock.calls.length });

  const form = new FormData();
  form.append("file", workbook(f));
  form.append("pricingSource", source);
  const pres = await PREVIEW(new Request("http://probe/preview", { method: "POST", body: form }), ctx);
  const pbody = (await pres.json()) as {
    rows?: Array<Omit<PreviewRow, "decision">>;
    error?: string;
    code?: string;
    errors?: string[];
  };
  if (!pres.ok || !pbody.rows) {
    const preview = `PREVIEW ${pres.status} ${pbody.code ?? ""} ${pbody.error ?? (pbody.errors ?? []).join(" · ")}`.trim();
    return { full: JSON.stringify({ preview }), pricing: JSON.stringify({ preview }), overwrite: null, short: preview, calls: calls() };
  }

  // ── Client side, with the wizard's / dialog's own functions ──────────
  // Overwrite: the Manager picks it in the preview table for the existing row.
  const rows = previewRowsFromResponse(pbody.rows).map((r) => (decision === "overwrite" ? { ...r, decision } : r));
  const pushBlocked = computePrecisionViolations(rows).map((v) => `${v.sku}: ${v.error}`);
  const saveGate = f.custom
    ? customAppCurrencyGate(dialogRows(f.custom), {
        isGoogleConversion: source === "google_default",
        appDefaultCurrency: appCurrency,
      })
    : null;
  const customSaveBlocked = saveGate && !saveGate.ok ? saveGate.reason : null;
  // A set the dialog refuses to save never reaches the wizard's state.
  const customPrices: Record<string, CustomPriceSet> =
    f.custom && !customSaveBlocked
      ? { [f.sku ?? SKU]: { entries: f.custom, baseline: { kind: "none" }, editedAt: "2026-10-17T00:00:00.000Z" } }
      : {};
  const body = buildExecuteRequestBody({
    pricingSource: source,
    sourceFilename: "h4.xlsx",
    hubRunId: null,
    rows: buildExecuteRows(rows, {
      tierSelections: seedTierSelections(rows),
      customPrices,
      activeCustomSkus: activeCustomSkuSet(rows, customPrices),
    }),
  });

  // ── Server side. Sent even when the Push gate would block: a stale tab
  //    or a direct POST reaches the route, and its answer is pinned too.
  const eres = await EXECUTE(
    new Request("http://probe/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
  const ebody = (await eres.json()) as {
    error?: string;
    refusedRows?: Array<{ kind: string; reason: string }>;
  };

  const anchors = g.convert.mock.calls.map((c) => moneyText((c[0] as { requestBody: { price: Money } }).requestBody.price));
  const requests = g.batch.mock.calls.map((c) => (c[0] as { requestBody?: unknown }).requestBody ?? null);
  // The purchase-option state calls (ACTIVATE…) are sent to Google too.
  const states = g.states.mock.calls.map((c) => (c[0] as { requestBody?: unknown }).requestBody ?? null);
  const refused = (ebody.refusedRows ?? []).map((r) => `${r.kind}: ${r.reason}`);
  const execute = `${eres.status}${ebody.error ? ` ${ebody.error}` : ""}`;

  type Cfg = { regionCode: string; price: Money };
  type Option = { purchaseOptionId?: string; regionalPricingAndAvailabilityConfigs?: Cfg[] };
  const options =
    (requests[0] as { requests?: Array<{ oneTimeProduct?: { purchaseOptions?: Option[] } }> } | null)
      ?.requests?.[0]?.oneTimeProduct?.purchaseOptions ?? null;
  const priced = options?.find((o) => o.purchaseOptionId !== NON_TARGET_OPTION.purchaseOptionId) ?? null;
  const cfgs = priced?.regionalPricingAndAvailabilityConfigs ?? null;
  const overwrite =
    decision === "overwrite" && options
      ? {
          targetId: priced?.purchaseOptionId ?? null,
          nonTargetUntouched:
            JSON.stringify(options.find((o) => o.purchaseOptionId === NON_TARGET_OPTION.purchaseOptionId)) ===
            JSON.stringify(NON_TARGET_OPTION),
        }
      : null;
  const prices = cfgs ? cfgs.map((c) => `${c.regionCode}=${moneyText(c.price)}`).sort().join(", ") : "no batchUpdate";
  const refusedKinds = (ebody.refusedRows ?? []).map((r) => r.kind);
  const short = [
    pushBlocked.length ? "CLIENT: Push blocked (precision)" : null,
    customSaveBlocked ? "CLIENT: custom Save blocked" : null,
    eres.status === 200 ? null : `EXECUTE ${eres.status}`,
    refusedKinds.length ? `REFUSED ${refusedKinds.join("+")}` : null,
    anchors.length ? `anchor ${anchors.join(" | ")}` : null,
    prices,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    full: JSON.stringify({ pushBlocked, customSaveBlocked, execute, refused, anchors, requests, states }),
    pricing: JSON.stringify({ pushBlocked, customSaveBlocked, execute, refused, anchors, cfgs }),
    overwrite,
    short,
    calls: calls(),
  };
}

/* ── Run the matrix once ──────────────────────────────────────────────── */

const outcomes = new Map<string, Map<AppCurrency, Outcome>>(); // CREATE
const overwriteOutcomes = new Map<string, Map<AppCurrency, Outcome>>(); // OVERWRITE
const key = (f: FileCase, s: Source) => `${f.id} · ${s}`;

beforeAll(async () => {
  for (const m of ["info", "warn", "log", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  st.fakeErrors = [];
  for (const f of FILES) {
    for (const s of SOURCES) {
      const byCurrency = new Map<AppCurrency, Outcome>();
      const byCurrencyOverwrite = new Map<AppCurrency, Outcome>();
      for (const c of APP_CURRENCIES) {
        byCurrency.set(c, await runOnce(f, s, c, "create"));
        byCurrencyOverwrite.set(c, await runOnce(f, s, c, "overwrite"));
      }
      outcomes.set(key(f, s), byCurrency);
      overwriteOutcomes.set(key(f, s), byCurrencyOverwrite);
    }
  }
}, 240_000);
afterAll(() => vi.restoreAllMocks());

/** App currencies grouped by identical FULL outcome, e.g. "NULL+USD / TWD / VND". */
function grouping(byCurrency: Map<AppCurrency, Outcome>): string {
  const groups = new Map<string, string[]>();
  for (const [c, o] of byCurrency) groups.set(o.full, [...(groups.get(o.full) ?? []), label(c)]);
  return [...groups.values()]
    .map((g) => g.sort().join("+"))
    .sort()
    .join(" / ");
}

/* ── Expectations ─────────────────────────────────────────────────────── */

// H4.0 — TODAY (violates the rule). See the header for what H4.2 must add.
// Why they split (design-bulk-import-existence-overwrite-safety.md §5.3/§5.7):
//  - generic "Price" takes the app currency (excel-parser.ts:196, preview/route.ts:139);
//  - file currency ≠ app currency triggers cross-currency (cross-currency.ts:95-111):
//    REFUSED under Google Conversion (bulk-import.ts:532), and under a template
//    the tier is found by price only and its APP-currency entry becomes the
//    anchor (cross-currency.ts:225) — F8: the SKU's own tier is skipped;
//  - custom prices: the app-currency entry becomes the anchor, and under a
//    template the dialog refuses to save a set without one (custom-prices.ts);
//  - a value too precise for its own currency: same-currency rows are blocked
//    by the Push gate and crash the whole execute (500), cross-currency rows
//    are refused instead (F9, F10);
//  - convertRegionPrices down ⇒ defaultPrice stamped on US in ANY currency
//    (onetime-product-adapter.ts:283) — F7 "US=TWD 30".
const EXPECTED_GROUPS_TODAY: Record<string, string> = {
  "F1 'Price' 0.99 · google_default": "NULL+USD / TWD / VND",
  "F1 'Price' 0.99 · default_template": "NULL+USD / TWD / VND",
  "F1 'Price' 0.99 · app_template": "NULL+USD / TWD / VND",
  "F2 'Price (USD)' 0.99 · google_default": "NULL+USD / TWD / VND",
  "F2 'Price (USD)' 0.99 · default_template": "NULL+USD / TWD / VND",
  "F2 'Price (USD)' 0.99 · app_template": "NULL+USD / TWD / VND",
  "F3 'Price (TWD)' 30 · google_default": "NULL+TWD / USD / VND",
  "F3 'Price (TWD)' 30 · default_template": "NULL+TWD / USD / VND",
  "F3 'Price (TWD)' 30 · app_template": "NULL+TWD / USD / VND",
  "F4 'Price (VND)' 26000 · google_default": "NULL+VND / TWD / USD",
  "F4 'Price (VND)' 26000 · default_template": "NULL+VND / TWD / USD",
  "F4 'Price (VND)' 26000 · app_template": "NULL+VND / TWD / USD",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default": "NULL+USD / TWD / VND",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template": "NULL+USD / TWD / VND",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template": "NULL+USD / TWD / VND",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default": "NULL+USD+VND / TWD",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template": "NULL / TWD / USD / VND",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template": "NULL / TWD / USD / VND",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default": "NULL+TWD / USD / VND",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template": "NULL+TWD / USD / VND",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template": "NULL+TWD / USD / VND",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default": "NULL+USD / TWD / VND",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template": "NULL+USD / TWD / VND",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template": "NULL+USD / TWD / VND",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default": "NULL+TWD / USD / VND",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template": "NULL+TWD / USD / VND",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template": "NULL+TWD / USD / VND",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default": "NULL+USD / TWD / VND",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template": "NULL+USD / TWD / VND",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template": "NULL+USD / TWD / VND",
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default": "NULL+TWD / USD / VND",
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template": "NULL+TWD / USD / VND",
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template": "NULL+TWD / USD / VND",
};

// H4.0 — characterisation of TODAY's outcomes, per file · source · app currency.
const EXPECTED_TODAY: Record<string, string> = {
  "F1 'Price' 0.99 · google_default · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F1 'Price' 0.99 · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F1 'Price' 0.99 · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F1 'Price' 0.99 · google_default · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F1 'Price' 0.99 · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F1 'Price' 0.99 · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F1 'Price' 0.99 · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F1 'Price' 0.99 · default_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F1 'Price' 0.99 · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F1 'Price' 0.99 · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F1 'Price' 0.99 · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F1 'Price' 0.99 · app_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F2 'Price (USD)' 0.99 · google_default · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F2 'Price (USD)' 0.99 · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F2 'Price (USD)' 0.99 · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F2 'Price (USD)' 0.99 · google_default · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F2 'Price (USD)' 0.99 · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F2 'Price (USD)' 0.99 · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F2 'Price (USD)' 0.99 · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F2 'Price (USD)' 0.99 · default_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F2 'Price (USD)' 0.99 · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F2 'Price (USD)' 0.99 · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F2 'Price (USD)' 0.99 · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F2 'Price (USD)' 0.99 · app_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F3 'Price (TWD)' 30 · google_default · app USD":
    "REFUSED google_default · no batchUpdate",
  "F3 'Price (TWD)' 30 · google_default · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 24375",
  "F3 'Price (TWD)' 30 · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F3 'Price (TWD)' 30 · google_default · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 24375",
  "F3 'Price (TWD)' 30 · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F3 'Price (TWD)' 30 · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F3 'Price (TWD)' 30 · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F3 'Price (TWD)' 30 · default_template · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F3 'Price (TWD)' 30 · app_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F3 'Price (TWD)' 30 · app_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 24375",
  "F3 'Price (TWD)' 30 · app_template · app VND":
    "REFUSED template_miss · no batchUpdate",
  "F3 'Price (TWD)' 30 · app_template · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 24375",
  "F4 'Price (VND)' 26000 · google_default · app USD":
    "REFUSED google_default · no batchUpdate",
  "F4 'Price (VND)' 26000 · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F4 'Price (VND)' 26000 · google_default · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 1, VN=VND 26000",
  "F4 'Price (VND)' 26000 · google_default · app NULL":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 1, VN=VND 26000",
  "F4 'Price (VND)' 26000 · default_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F4 'Price (VND)' 26000 · default_template · app TWD":
    "REFUSED template_miss · no batchUpdate",
  "F4 'Price (VND)' 26000 · default_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 1, VN=VND 26000",
  "F4 'Price (VND)' 26000 · default_template · app NULL":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 1, VN=VND 26000",
  "F4 'Price (VND)' 26000 · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F4 'Price (VND)' 26000 · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F4 'Price (VND)' 26000 · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F4 'Price (VND)' 26000 · app_template · app NULL":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 170, KR=KRW 1386, TW=TWD 35, US=USD 0.99, VN=VND 25740",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default · app TWD":
    "anchor TWD 35 · DE=EUR 1.01, JP=JPY 170, KR=KRW 1531, TW=TWD 35, US=USD 1.09, VN=VND 28438",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default · app VND":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 170, KR=KRW 1386, TW=TWD 35, US=USD 0.99, VN=VND 25740",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 170, KR=KRW 1386, TW=TWD 35, US=USD 0.99, VN=VND 25740",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template · app USD":
    "CLIENT: custom Save blocked · anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template · app TWD":
    "anchor TWD 35 · DE=EUR 1.01, JP=JPY 170, KR=KRW 1531, TW=TWD 35, US=USD 1.09, VN=VND 28438",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template · app VND":
    "CLIENT: custom Save blocked · anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template · app NULL":
    "CLIENT: custom Save blocked · anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template · app USD":
    "CLIENT: custom Save blocked · anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template · app TWD":
    "anchor TWD 35 · DE=EUR 1.01, JP=JPY 170, KR=KRW 1531, TW=TWD 35, US=USD 1.09, VN=VND 28438",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template · app VND":
    "CLIENT: custom Save blocked · anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template · app NULL":
    "CLIENT: custom Save blocked · anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default · app USD":
    "REFUSED google_default · no batchUpdate",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default · app TWD":
    "anchor TWD 30 · US=TWD 30",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default · app NULL":
    "anchor TWD 30 · US=TWD 30",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template · app USD":
    "anchor USD 0.99 · JP=JPY 160, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template · app TWD":
    "anchor TWD 30 · JP=JPY 160, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template · app VND":
    "anchor VND 25000 · JP=JPY 160, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template · app NULL":
    "anchor TWD 30 · JP=JPY 160, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template · app TWD":
    "anchor TWD 30 · US=TWD 30",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template · app VND":
    "REFUSED template_miss · no batchUpdate",
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template · app NULL":
    "anchor TWD 30 · US=TWD 30",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 90, US=USD 2.99, VN=VND 75000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 90, US=USD 2.99, VN=VND 75000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default · app USD":
    "REFUSED google_default · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default · app TWD":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default · app NULL":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template · app TWD":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template · app VND":
    "REFUSED template_miss · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template · app NULL":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template · app TWD":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template · app VND":
    "REFUSED template_miss · no batchUpdate",
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template · app NULL":
    "CLIENT: Push blocked (precision) · EXECUTE 500 · no batchUpdate",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default · app USD":
    "EXECUTE 500 · anchor USD 0.99 · no batchUpdate",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default · app TWD":
    "REFUSED google_default · no batchUpdate",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default · app NULL":
    "EXECUTE 500 · anchor USD 0.99 · no batchUpdate",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template · app TWD":
    "anchor TWD 32 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template · app VND":
    "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template · app NULL":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default · app USD":
    "REFUSED google_default · no batchUpdate",
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 26000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default · app VND":
    "REFUSED google_default · no batchUpdate",
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 26000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template · app USD":
    "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template · app VND":
    "anchor VND 25000 · DE=EUR 0.88, JP=JPY 160, KR=KRW 1346, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template · app USD":
    "REFUSED template_miss · no batchUpdate",
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template · app TWD":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 26000",
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template · app VND":
    "REFUSED template_miss · no batchUpdate",
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template · app NULL":
    "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 26000",
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("T1 (H4.0 pin) — today the Google request DEPENDS on the app currency; H4.2 flips it to identical", () => {
  it("the matrix ran: 11 files × 3 sources × 4 app currencies × CREATE/OVERWRITE; per run ≤1 batchUpdate, no legacy fallback, a live GET only for a sent Overwrite; the fakes answered every query", () => {
    expect(outcomes.size).toBe(FILES.length * SOURCES.length);
    expect(overwriteOutcomes.size).toBe(FILES.length * SOURCES.length);
    const offenders: string[] = [];
    for (const [decision, map] of [["create", outcomes], ["overwrite", overwriteOutcomes]] as const) {
      for (const [k, m] of map) {
        expect(m.size).toBe(APP_CURRENCIES.length);
        for (const [c, o] of m) {
          const { batch, legacy, get } = o.calls;
          const getOk = decision === "create" ? get === 0 : get === batch;
          if (batch > 1 || legacy > 0 || !getOk) offenders.push(`${k} · app ${label(c)} · ${decision} ${JSON.stringify(o.calls)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(st.fakeErrors).toEqual([]);
  });

  it("OVERWRITE prices exactly like CREATE, cell by cell — and leaves the other purchase option untouched", () => {
    const mismatches: string[] = [];
    const overwriteFaults: string[] = [];
    let sentOverwrites = 0;
    for (const [k, m] of outcomes) {
      const om = overwriteOutcomes.get(k)!;
      if (grouping(om) !== grouping(m)) mismatches.push(`${k}: grouping ${grouping(om)} ≠ ${grouping(m)}`);
      for (const c of APP_CURRENCIES) {
        const create = m.get(c)!;
        const ow = om.get(c)!;
        if (ow.pricing !== create.pricing) mismatches.push(`${k} · app ${label(c)}`);
        if (ow.overwrite) {
          sentOverwrites += 1;
          if (ow.overwrite.targetId !== "legacy-base" || !ow.overwrite.nonTargetUntouched) {
            overwriteFaults.push(`${k} · app ${label(c)} ${JSON.stringify(ow.overwrite)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(overwriteFaults).toEqual([]);
    // Not vacuous: every cell that sends a CREATE also sends an OVERWRITE.
    const sentCreates = [...outcomes.values()].flatMap((m) => [...m.values()]).filter((o) => o.calls.batch === 1).length;
    expect(sentOverwrites).toBe(sentCreates);
    expect(sentOverwrites).toBeGreaterThan(80);
  });

  it("H4.0 pin — which app currencies give the SAME outcome today, file by file", () => {
    const actual = Object.fromEntries([...outcomes].map(([k, m]) => [k, grouping(m)]));
    expect(actual).toEqual(EXPECTED_GROUPS_TODAY);
  });

  it("H4.0 pin — today's outcome for every file · source · app currency", () => {
    const actual: Record<string, string> = {};
    for (const [k, m] of outcomes) for (const [c, o] of m) actual[`${k} · app ${label(c)}`] = o.short;
    expect(actual).toEqual(EXPECTED_TODAY);
  });

  it("the wizard side above IS the wizard's code (no hand-copied twin)", () => {
    const wizard = stripComments(
      readFileSync(
        fileURLToPath(new URL("../../../../../../components/google-iap-management/bulk-import/BulkImportWizard.tsx", import.meta.url)),
        "utf8",
      ),
    );
    // The execute body is the builder's output, passed straight to JSON.stringify.
    expect(wizard).toMatch(/body: JSON\.stringify\(\s*buildExecuteRequestBody\(\{/);
    expect(wizard.match(/buildExecuteRequestBody\(/g)).toHaveLength(1);
    expect(wizard.match(/buildExecuteRows\(/g)).toHaveLength(1);
    expect(wizard).toMatch(/const rows = previewRowsFromResponse\(body\.rows \?\? \[\]\);/);
    expect(wizard).toMatch(/const seedSelections = seedTierSelections\(rows\);/);
    expect(wizard).toMatch(/activeCustomSkuSet\(previewRows, customPrices\)/);
    expect(wizard).toMatch(/computePrecisionViolations\(previewRows\)/);
    // No second, inline construction of the row or envelope shape.
    expect(wizard).not.toMatch(/\b(chosenTierIdentifier|tierCandidateCount|hub_run_id)\b/);
    const dialog = stripComments(
      readFileSync(
        fileURLToPath(new URL("../../../../../../components/google-iap-management/bulk-import/CustomPricesDialog.tsx", import.meta.url)),
        "utf8",
      ),
    );
    expect(dialog).toMatch(/customAppCurrencyGate\(rows, \{ isGoogleConversion, appDefaultCurrency \}\)/);
    expect(dialog).not.toMatch(/findAppCurrencyEntry/);
  });
});
