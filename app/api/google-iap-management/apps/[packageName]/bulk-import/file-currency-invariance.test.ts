// @vitest-environment node
/**
 * T1 — H4: "the currency written in the import FILE is the ONLY price source"
 * (Manager 2026-10-16). apps.default_currency must not change what the Manager
 * can push or what is sent to Google.
 *
 * WHAT RUNS FOR REAL: the preview route, the execute route, the parser, the
 * file-price choke point, the orchestrator, the template queries, the
 * publisher client and the one-time-product adapter. The wizard side is the
 * wizard's OWN code, not a copy: preview-row mapping, tier seeding, the Push
 * precision gate and the whole execute request body come from
 * execute-payload.ts. (The cross-currency module and the custom-prices Save
 * gate on the app's currency were deleted in H4.2.)
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
 * precision gate, rows refused in the file), preview refusal, rows refused at
 * execute, convertRegionPrices anchors, the FULL batchUpdate request and the
 * purchase-option state calls — must not depend on the app currency.
 *
 * HISTORY OF THE PINS (one commit each):
 *   H4.0 — 33/33 combinations depended on the app currency (92 cells sent).
 *   H4.1 — the parser took no app currency: 3/33 invariant (82 sent).
 *   H4.2 — the app currency takes NO part in pricing: 33/33 invariant, for
 *          CREATE and OVERWRITE alike (84 sent). Checked three ways, so a
 *          degenerate build cannot pass: (1) every group is NULL+TWD+USD+VND;
 *          (2) the single outcome equals EXPECTED_H4, derived BY HAND from
 *          Q1–Q7 before the code ran; (3) rule assertions computed from each
 *          FileCase (anchor = the header currency + value; refusals only where
 *          Q7 / the file says so; the US price is always USD; GT and custom
 *          prices verbatim where they apply) + degeneracy guards.
 * ⚠ Q8 is covered by its own route-level test below: v3 rejects ⇒ the error
 *   comes back verbatim and structured, inappproducts.batchUpdate is called
 *   0 times. In the matrix itself v3 always succeeds.
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
/** The Hub terminal status the execute route closes with (P5 — refusals count as failed). */
const hub = vi.hoisted(() => ({ statuses: [] as string[] }));
vi.mock("@/lib/google-iap-management/hub-tracking/tracking", () => ({
  finalizeHubTracking: async (_runId: string | null, status: string) => {
    hub.statuses.push(status);
  },
}));

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
import { regionForCurrency } from "@/lib/google-iap-management/parsers/excel-parser";
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

type Decision = "create" | "overwrite";

/** What a tab previewed before H4.1 — or a direct POST — sends for a row the
 *  parser now refuses: the row exactly as the file states it. */
function rowAsTheFileStatesIt(f: FileCase, decision: Decision): PreviewRow {
  const currency = f.header.match(/\(([A-Z]{3})\)/)?.[1] ?? "";
  return {
    rowNumber: 2,
    sku: f.sku ?? SKU,
    baseCurrency: currency,
    basePriceDecimal: String(f.value),
    regionOverrides: f.gt
      ? [{ region: regionForCurrency(f.gt[1]) ?? "", currency: f.gt[1], priceDecimal: String(f.gt[0]) }]
      : [],
    listings: [],
    exists: decision === "overwrite",
    decision,
    tierCandidates: [],
    defaultTierSelection: null,
    tierMatchedBy: "none",
  };
}

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
  /** Human-readable, pinned in EXPECTED_H4. */
  short: string;
  calls: { batch: number; legacy: number; get: number };
  /** Structured facts for the RULE assertions (computed from the file, not pinned). */
  facts: { anchors: string[]; prices: Record<string, string>; refusedKinds: string[]; previewStatus: number; hubStatus: string };
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
    refusedRows?: Array<{ rowNumber: number; sku: string; reason: string }>;
    warnings?: string[];
    error?: string;
    code?: string;
    errors?: string[];
  };
  if (!pres.ok || !pbody.rows) {
    const preview = `PREVIEW ${pres.status} ${pbody.code ?? ""} ${pbody.error ?? (pbody.errors ?? []).join(" · ")}`.trim();
    return {
      full: JSON.stringify({ preview }),
      pricing: JSON.stringify({ preview }),
      overwrite: null,
      short: preview,
      calls: calls(),
      facts: { anchors: [], prices: {}, refusedKinds: [], previewStatus: pres.status, hubStatus: "none" },
    };
  }

  const previewWarnings = pbody.warnings ?? [];
  // H4.1 — rows the file states but the tool refused; the wizard blocks Push.
  const fileRefused = (pbody.refusedRows ?? []).map((r) => `Row ${r.rowNumber} (${r.sku}): ${r.reason}`);
  // Overwrite: the Manager picks it in the preview table for the existing row.
  const previewRows = previewRowsFromResponse(pbody.rows).map((r) => (decision === "overwrite" ? { ...r, decision } : r));
  let rows = previewRows;
  let directPost = false;
  if (rows.length === 0) {
    if (fileRefused.length === 0) {
      const empty = JSON.stringify({ preview: "0 rows", previewWarnings });
      return {
        full: empty,
        pricing: empty,
        overwrite: null,
        short: ["PREVIEW 0 rows", ...previewWarnings].join(" · "),
        calls: calls(),
        facts: { anchors: [], prices: {}, refusedKinds: [], previewStatus: pres.status, hubStatus: "none" },
      };
    }
    // The wizard cannot push (0 rows + Push blocked). But a tab previewed
    // BEFORE this change, or a direct POST, still sends the row exactly as
    // the file states it — the server's answer must not depend on the app
    // currency either (Q9, H4.3), so it is part of the outcome.
    rows = [rowAsTheFileStatesIt(f, decision)];
    directPost = true;
  }

  // What the Manager SEES and picks in the preview's tier column. Part of the
  // outcome on its own: the orchestrator's legacy SKU→price lookup can find
  // the same tier when the preview found none, so the Google request alone
  // would not reveal a preview that looked tiers up in the app's currency.
  const previewTiers = previewRows.map(
    (r) => `${r.sku}:${r.defaultTierSelection ?? "-"}/${r.tierCandidates.map((c) => c.identifier).join("|")}`,
  );

  // ── Client side, with the wizard's / dialog's own functions ──────────
  const pushBlocked = computePrecisionViolations(previewRows).map((v) => `${v.sku}: ${v.error}`);
  // The custom-prices dialog has no currency gate since H4.2 (Q6): a set
  // the Manager typed always reaches the wizard's state.
  const customPrices: Record<string, CustomPriceSet> = f.custom
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
    // H4.3 — what the wizard sends: the rows the preview refused, left out.
    droppedRows: pbody.refusedRows ?? [],
  });

  // ── Server side. Sent even when the Push gate would block: a stale tab
  //    or a direct POST reaches the route, and its answer is pinned too.
  hub.statuses.length = 0;
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
  const hubStatus = hub.statuses.join("+") || "none";
  // The catalog version each request is pinned to (Hotfix 9) — part of the
  // price: an Overwrite pinned to another catalog is not "the same price".
  const regionsVersions =
    (requests[0] as { requests?: Array<{ regionsVersion?: unknown }> } | null)?.requests?.map((r) => r.regionsVersion) ?? null;

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
    fileRefused.length ? `CLIENT: Push blocked (${fileRefused.length} row(s) refused in the file)` : null,
    pushBlocked.length ? "CLIENT: Push blocked (precision)" : null,
    directPost ? "DIRECT POST:" : null,
    eres.status === 200 ? null : `EXECUTE ${eres.status}`,
    refusedKinds.length ? `REFUSED ${refusedKinds.join("+")}` : null,
    anchors.length ? `anchor ${anchors.join(" | ")}` : null,
    prices,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    full: JSON.stringify({ previewWarnings, previewTiers, fileRefused, pushBlocked, directPost, execute, hubStatus, refused, anchors, requests, states }),
    pricing: JSON.stringify({ previewWarnings, fileRefused, pushBlocked, directPost, execute, hubStatus, refused, anchors, regionsVersions, cfgs }),
    overwrite,
    short,
    calls: calls(),
    facts: {
      anchors,
      prices: Object.fromEntries((cfgs ?? []).map((c) => [c.regionCode, moneyText(c.price)])),
      refusedKinds,
      previewStatus: pres.status,
      hubStatus,
    },
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

// H4.2 — DERIVED BY HAND from Manager Q1–Q7 BEFORE the H4.2 code ran (copy
// timestamped 2026-10-18T23:17:05+0700 in the session scratchpad; md5
// 9e6009595e8abaea7b59149d511e8fbb). ONE outcome per file · source, for every
// app currency and for CREATE and OVERWRITE alike. Fixtures: the fake FX
// table (per USD: TWD 32, VND 26000, JPY 150, EUR 0.92, KRW 1400) and the two
// templates in seedTables().
//   Q2 tier = the SKU's own tier, else the tier whose price in the FILE's
//      currency equals the FILE's price; anchor = defaultPrice = file price.
//   Q3 no tier ⇒ Google conversion of the file price (GT kept).
//   Q4 Google Conversion never refuses on currency.
//   Q5 GT kept unless a tier matched or custom prices (they replace it).
//   Q6 custom: anchor = file price, no app-currency entry, no Save gate.
//   Q7 conversion failed + file price not USD ⇒ refused (conversion_failed).
//   Choke point: a file price the server cannot send as written ⇒ refused
//   per row (file_price_invalid) — F9/F10's direct POST.
const P422 = "PREVIEW 422  Header \"Price\" does not say which currency the prices are in. Rename it to \"Price (XXX)\" with the currency of the prices, e.g. \"Price (USD)\". The app's currency is not used for prices in the file.";
const C_USD = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 25740";
const TIER1_BY_USD = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 160, KR=KRW 1386, TW=TWD 30, US=USD 0.99, VN=VND 25000";
const APP1_BY_USD = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000";
const C_TWD = "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 24375";
const TIER1_BY_TWD = "anchor TWD 30 · DE=EUR 0.86, JP=JPY 160, KR=KRW 1313, TW=TWD 30, US=USD 0.99, VN=VND 25000";
const C_VND = "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 1, VN=VND 26000";
const APP1_BY_VND = "anchor VND 26000 · DE=EUR 0.92, JP=JPY 150, KR=KRW 1400, TW=TWD 32, US=USD 0.99, VN=VND 26000";
const GT_KEPT_ON_C_USD = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 32, US=USD 0.99, VN=VND 26000";
const CUSTOM_ON_C_USD = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 170, KR=KRW 1386, TW=TWD 35, US=USD 0.99, VN=VND 25740";
const CONVERSION_FAILED = "REFUSED conversion_failed · anchor TWD 30 · no batchUpdate";
const SKU_TIER = "anchor USD 0.99 · DE=EUR 0.91, JP=JPY 149, KR=KRW 1386, TW=TWD 90, US=USD 2.99, VN=VND 75000";
const REFUSED_IN_FILE =
  "CLIENT: Push blocked (1 row(s) refused in the file) · DIRECT POST: · REFUSED file_price_invalid · no batchUpdate";
const GT_KEPT_ON_C_TWD = "anchor TWD 30 · DE=EUR 0.86, JP=JPY 141, KR=KRW 1313, TW=TWD 30, US=USD 0.94, VN=VND 26000";

const EXPECTED_H4: Record<string, string> = {
  "F1 'Price' 0.99 · google_default": P422,
  "F1 'Price' 0.99 · default_template": P422,
  "F1 'Price' 0.99 · app_template": P422,
  "F2 'Price (USD)' 0.99 · google_default": C_USD,
  "F2 'Price (USD)' 0.99 · default_template": TIER1_BY_USD,
  "F2 'Price (USD)' 0.99 · app_template": APP1_BY_USD,
  "F3 'Price (TWD)' 30 · google_default": C_TWD,
  "F3 'Price (TWD)' 30 · default_template": TIER1_BY_TWD,
  "F3 'Price (TWD)' 30 · app_template": C_TWD,
  "F4 'Price (VND)' 26000 · google_default": C_VND,
  "F4 'Price (VND)' 26000 · default_template": C_VND,
  "F4 'Price (VND)' 26000 · app_template": APP1_BY_VND,
  "F5 'Price (USD)' 0.99 + GT 26000 VND · google_default": GT_KEPT_ON_C_USD,
  "F5 'Price (USD)' 0.99 + GT 26000 VND · default_template": TIER1_BY_USD,
  "F5 'Price (USD)' 0.99 + GT 26000 VND · app_template": APP1_BY_USD,
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · google_default": CUSTOM_ON_C_USD,
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · default_template": CUSTOM_ON_C_USD,
  "F6 'Price (USD)' 0.99 + custom TW 35 / JP 170 · app_template": CUSTOM_ON_C_USD,
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · google_default": CONVERSION_FAILED,
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · default_template": CONVERSION_FAILED,
  "F7 'Price (TWD)' 30 + convertRegionPrices fails · app_template": CONVERSION_FAILED,
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · google_default": C_USD,
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · default_template": SKU_TIER,
  "F8 'Price (USD)' 0.99, SKU is a tier identifier · app_template": APP1_BY_USD,
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · google_default": REFUSED_IN_FILE,
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · default_template": REFUSED_IN_FILE,
  "F9 'Price (TWD)' 30.5 (too precise for TWD) · app_template": REFUSED_IN_FILE,
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · google_default": REFUSED_IN_FILE,
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · default_template": REFUSED_IN_FILE,
  "F10 'Price (USD)' 0.99 + GT 26000.5 VND (GT too precise) · app_template": REFUSED_IN_FILE,
  "F11 'Price (TWD)' 30 + GT 26000 VND · google_default": GT_KEPT_ON_C_TWD,
  "F11 'Price (TWD)' 30 + GT 26000 VND · default_template": TIER1_BY_TWD,
  "F11 'Price (TWD)' 30 + GT 26000 VND · app_template": GT_KEPT_ON_C_TWD,
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("T1 — same file ⇒ same Google request whatever the app currency (H4.2: 33/33, CREATE and OVERWRITE)", () => {
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
      const om = overwriteOutcomes.get(k);
      if (!om) {
        mismatches.push(`${k}: no OVERWRITE run`);
        continue;
      }
      if (grouping(om) !== grouping(m)) mismatches.push(`${k}: grouping ${grouping(om)} ≠ ${grouping(m)}`);
      for (const c of APP_CURRENCIES) {
        const create = m.get(c);
        const ow = om.get(c);
        if (!create || !ow) {
          mismatches.push(`${k} · app ${label(c)}: missing run`);
          continue;
        }
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
    // Exact, updated per H4 step (H4.0: 92, H4.1: 82) — a build that refuses
    // far more rows than it should cannot slip past a loose bound.
    expect(sentCreates).toBe(84);
  });

  it("H4.2 (1) — the app's currency changes NOTHING: one outcome per file · source for USD/TWD/VND/none, CREATE and OVERWRITE", () => {
    const split: string[] = [];
    for (const [decision, map] of [["CREATE", outcomes], ["OVERWRITE", overwriteOutcomes]] as const) {
      for (const [k, m] of map) {
        const g = grouping(m);
        if (g !== "NULL+TWD+USD+VND") split.push(`${decision} ${k}: ${g}`);
      }
    }
    expect(split).toEqual([]);
  });

  it("H4.2 (2) — that one outcome is the one derived BY HAND from Q1–Q7 (EXPECTED_H4)", () => {
    const actual: Record<string, string> = {};
    for (const [k, m] of outcomes) for (const [c, o] of m) {
      if (o.short !== EXPECTED_H4[k]) actual[`${k} · app ${label(c)}`] = o.short;
    }
    expect(actual).toEqual({});
    expect(Object.keys(EXPECTED_H4).sort()).toEqual([...outcomes.keys()].sort());
  });

  it("H4.2 (3) — rules computed from each FILE, not pinned", () => {
    const broken: string[] = [];
    const say = (k: string, c: AppCurrency, what: string) => broken.push(`${k} · app ${label(c)}: ${what}`);
    for (const f of FILES) {
      const headerCurrency = f.header.match(/\(([A-Z]{3})\)/)?.[1] ?? null;
      const id = f.id.split(" ")[0];
      const expectedRefusals = id === "F7" ? ["conversion_failed"] : id === "F9" || id === "F10" ? ["file_price_invalid"] : [];
      for (const s of SOURCES) {
        for (const c of APP_CURRENCIES) {
          const o = outcomes.get(key(f, s))?.get(c);
          if (!o) {
            say(key(f, s), c, "missing run");
            continue;
          }
          const k = key(f, s);
          if (headerCurrency === null) {
            // Q1 — a header without its currency is refused at preview, every time.
            if (o.facts.previewStatus !== 422 || o.calls.batch !== 0) say(k, c, "generic header was not refused at preview");
            continue;
          }
          if (JSON.stringify(o.facts.refusedKinds) !== JSON.stringify(expectedRefusals)) {
            say(k, c, `refusals ${JSON.stringify(o.facts.refusedKinds)} ≠ ${JSON.stringify(expectedRefusals)}`);
          }
          if (o.calls.batch !== 1) continue;
          // The anchor IS the file's price, in the file's currency.
          if (o.facts.anchors[0] !== `${headerCurrency} ${f.value}`) say(k, c, `anchor ${o.facts.anchors[0]}`);
          // The US store never gets a non-USD price (Q7).
          if (!o.facts.prices.US?.startsWith("USD ")) say(k, c, `US=${o.facts.prices.US}`);
          // Custom prices reach Google verbatim, under every source (Q6).
          for (const e of f.custom ?? []) {
            if (o.facts.prices[e.region] !== `${e.currency} ${e.priceDecimal}`) say(k, c, `custom ${e.region}`);
          }
          // With no template involved, the GT region carries the GT value (Q5).
          if (f.gt && s === "google_default" && o.facts.prices[regionForCurrency(f.gt[1]) ?? ""] !== `${f.gt[1]} ${f.gt[0]}`) {
            say(k, c, "GT not kept under Google Conversion");
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("P5 — the Hub run closes FAILED for every cell whose row was refused, SUCCESS for every cell that sent (the orchestrator's priceRefusedRows, end to end)", () => {
    const wrong: string[] = [];
    let refusedCells = 0;
    let sentCells = 0;
    for (const [decision, map] of [["CREATE", outcomes], ["OVERWRITE", overwriteOutcomes]] as const) {
      for (const [k, m] of map) for (const [c, o] of m) {
        if (o.facts.refusedKinds.length > 0) {
          refusedCells += 1;
          if (o.facts.hubStatus !== "FAILED") wrong.push(`${decision} ${k} · app ${label(c)}: refused, Hub ${o.facts.hubStatus}`);
        } else if (o.calls.batch === 1) {
          sentCells += 1;
          if (o.facts.hubStatus !== "SUCCESS") wrong.push(`${decision} ${k} · app ${label(c)}: sent, Hub ${o.facts.hubStatus}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // F7 (conversion_failed), F9 + F10 (file_price_invalid): 3 files × 3 sources × 4 currencies × 2 decisions.
    expect(refusedCells).toBe(72);
    expect(sentCells).toBe(84 * 2);
  });

  it("H4.2 — degeneracy guards: refusing everything, or ignoring the file's currency, is RED", () => {
    const one = (id: string, s: Source) => [...outcomes].find(([k]) => k.startsWith(id + " ") && k.endsWith(` · ${s}`))?.[1].get("USD")?.short;
    // TWD 30 and VND 26000 are different prices: same output ⇒ the file currency was ignored.
    expect(one("F3", "google_default")).not.toBe(one("F4", "google_default"));
    expect(one("F3", "google_default")).toMatch(/^anchor TWD 30 · /);
    expect(one("F4", "google_default")).toMatch(/^anchor VND 26000 · /);
    // Most cells must actually send (the exact count is pinned in the Overwrite test).
    const sent = [...outcomes.values()].flatMap((m) => [...m.values()]).filter((o) => o.calls.batch === 1).length;
    expect(sent).toBeGreaterThan(FILES.length * SOURCES.length * APP_CURRENCIES.length / 2);
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
    // H4.2 (Q6): no currency gate on Save at all.
    expect(dialog).not.toMatch(/\b(appDefaultCurrency|customAppCurrencyGate|findAppCurrencyEntry)\b/);
  });

  it("T2 — no file on the bulk-import pricing path reads the app's currency (H4.2)", () => {
    const read = (rel: string) =>
      stripComments(readFileSync(fileURLToPath(new URL(`../../../../../../${rel}`, import.meta.url)), "utf8"));
    const PRICING_PATH = [
      "app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts",
      "app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.ts",
      "app/(dashboard)/google-iap-management/apps/[packageName]/bulk-import/page.tsx",
      "lib/google-iap-management/orchestration/bulk-import.ts",
      "lib/google-iap-management/orchestration/file-price.ts",
      "lib/google-iap-management/parsers/excel-parser.ts",
      "lib/google-iap-management/custom-prices.ts",
      "components/google-iap-management/bulk-import/execute-payload.ts",
      "components/google-iap-management/bulk-import/BulkImportWizard.tsx",
      "components/google-iap-management/bulk-import/CustomPricesDialog.tsx",
      "components/google-iap-management/bulk-import/PreviewTable.tsx",
    ];
    const APP_CURRENCY = /\b(appDefaultCurrency|default_currency|appCurrency|AppCurrency)\b/;
    const offenders = PRICING_PATH.filter((f) => APP_CURRENCY.test(read(f)));
    expect(offenders).toEqual([]);
    // The shared publisher client keeps the single-item legacy fallback (D4),
    // which still takes an app currency — the BATCH function must not.
    const pc = read("lib/google-iap-management/google/publisher-client.ts");
    const start = pc.indexOf("export async function batchUpsertInAppProducts(");
    const batchFn = pc.slice(start, pc.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(batchFn).not.toMatch(APP_CURRENCY);
    expect(batchFn).not.toMatch(/batchUpdateInAppProducts|inappproducts|legacyFallbackBody/);
    // File-wide (Q8): no code anywhere in the client calls the legacy BATCH
    // resource — a fallback routed through a helper outside the function
    // is caught too. The five remaining fallbacks use list/get/insert/patch/
    // delete, never batchUpdate.
    const pcCode = pc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(pcCode).not.toMatch(/inappproducts\s*\.\s*batchUpdate/);
  });
});

describe("Q8 — the batch upsert has NO legacy fallback (Manager 2026-10-17)", () => {
  it("v3 batchUpdate rejects ⇒ execute answers with THAT error, verbatim and structured; inappproducts.batchUpdate is called 0 times", async () => {
    st.appCurrency = "VND";
    st.tables = seedTables();
    st.mirror = [];
    Object.values(g).forEach((m) => m.mockReset());
    g.convert.mockImplementation(async (r: { requestBody: { price: Money } }) => fakeConvertRegionPrices(r));
    g.states.mockResolvedValue({ data: {} });
    g.get.mockRejectedValue(new Error("no live GET for a create row"));
    const message = "The caller does not have permission";
    g.batch.mockRejectedValue(
      Object.assign(new Error(message), {
        code: 403,
        response: {
          status: 403,
          data: {
            error: {
              code: 403,
              message,
              status: "PERMISSION_DENIED",
              errors: [{ message, domain: "global", reason: "forbidden" }],
            },
          },
        },
      }),
    );
    // Even a legacy API that WOULD succeed must not be called.
    g.legacy.mockResolvedValue({ data: { inappproducts: [{ sku: SKU, status: "active" }] } });

    const f = FILES[1]; // F2 'Price (USD)' 0.99
    const form = new FormData();
    form.append("file", workbook(f));
    form.append("pricingSource", "google_default");
    const pres = await PREVIEW(new Request("http://probe/preview", { method: "POST", body: form }), ctx);
    const pbody = (await pres.json()) as { rows: Array<Omit<PreviewRow, "decision">> };
    const rows = previewRowsFromResponse(pbody.rows);
    const eres = await EXECUTE(
      new Request("http://probe/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildExecuteRequestBody({
            pricingSource: "google_default",
            sourceFilename: "h4.xlsx",
            hubRunId: null,
            rows: buildExecuteRows(rows, { tierSelections: seedTierSelections(rows), customPrices: {}, activeCustomSkus: new Set() }),
            droppedRows: [],
          }),
        ),
      }),
      ctx,
    );
    const ebody = (await eres.json()) as Record<string, unknown>;
    expect(eres.status).toBe(403);
    expect(ebody.error).toBe(message);
    expect(ebody.errorStatus).toBe("PERMISSION_DENIED");
    expect(ebody.errorReasons).toEqual(["forbidden"]);
    expect(ebody).not.toHaveProperty("errorBothPathsFailed");
    expect(g.batch).toHaveBeenCalledTimes(1);
    expect(g.legacy).toHaveBeenCalledTimes(0);
  });
});

/**
 * H4.3 (Manager 2026-10-18) — "push the rest", end to end through the REAL
 * preview and execute routes, the parser and the orchestrator: rows of the
 * file the tool will not import are left out after the Manager confirms, and
 * every layer still counts them — the response the Done screen renders, the
 * import_batches row, and the Hub terminal status (P5: PARTIAL, not SUCCESS).
 * Separate from the T1 matrix (its hand table stays as written).
 */
describe("H4.3 — push the rest: rows refused in the file are left out, and counted everywhere", () => {
  it("1 good row + 1 empty price + 1 row with no Product ID ⇒ 1 created, 2 'refused_in_file' in the response, import_batches 3 / FAILED / 2 failed, Hub PARTIAL", async () => {
    st.appCurrency = null;
    st.tables = seedTables();
    st.mirror = [];
    st.fakeErrors = [];
    Object.values(g).forEach((m) => m.mockReset());
    g.convert.mockImplementation(async (r: { requestBody: { price: Money } }) => fakeConvertRegionPrices(r));
    g.states.mockResolvedValue({ data: {} });
    g.get.mockRejectedValue(new Error("no live GET for a create row"));
    g.legacy.mockRejectedValue(new Error("the legacy batch fallback must never be reached"));
    g.batch.mockImplementation(async (r: { requestBody: { requests: Array<{ oneTimeProduct: unknown }> } }) => ({
      data: { oneTimeProducts: r.requestBody.requests.map((x) => x.oneTimeProduct) },
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Product ID", "Price (USD)", "Title (English)"],
        [SKU, 0.99, "Gem"],
        ["com.vnggames.h4probe.empty", null, "Empty price"],
        [null, 1.99, "No id"],
      ]),
      "IAP Items",
    );
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const form = new FormData();
    form.append("file", new File([new Uint8Array(buf)], "rest.xlsx"));
    form.append("pricingSource", "google_default");
    const pres = await PREVIEW(new Request("http://probe/preview", { method: "POST", body: form }), ctx);
    const pbody = (await pres.json()) as {
      rows: Array<Omit<PreviewRow, "decision">>;
      refusedRows: Array<{ rowNumber: number; sku: string; reason: string }>;
    };
    expect(pres.status).toBe(200);
    expect(pbody.rows.map((r) => r.sku)).toEqual([SKU]);
    expect(pbody.refusedRows.map((r) => [r.rowNumber, r.sku])).toEqual([
      [3, "com.vnggames.h4probe.empty"],
      [4, ""],
    ]);

    const rows = previewRowsFromResponse(pbody.rows);
    hub.statuses.length = 0;
    const eres = await EXECUTE(
      new Request("http://probe/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildExecuteRequestBody({
            pricingSource: "google_default",
            sourceFilename: "rest.xlsx",
            hubRunId: "run-rest",
            rows: buildExecuteRows(rows, { tierSelections: seedTierSelections(rows), customPrices: {}, activeCustomSkus: new Set() }),
            droppedRows: pbody.refusedRows,
          }),
        ),
      }),
      ctx,
    );
    const ebody = (await eres.json()) as {
      rowsTotal: number;
      rowsCreated: number;
      rowsRefused: number;
      refusedRows: Array<{ rowNumber: number; kind: string; reason: string }>;
    };
    expect(eres.status).toBe(200);
    expect(ebody.rowsTotal).toBe(3);
    expect(ebody.rowsCreated).toBe(1);
    expect(ebody.rowsRefused).toBe(2);
    expect(ebody.refusedRows.map((r) => [r.rowNumber, r.kind])).toEqual([
      [3, "refused_in_file"],
      [4, "refused_in_file"],
    ]);
    expect(ebody.refusedRows[1].reason).toMatch(/^Row 4 \(no Product ID\): no "Product ID"/);
    const batch = st.tables.import_batches.at(-1) as Record<string, unknown>;
    expect(batch).toMatchObject({ rows_total: 3, status: "FAILED", rows_success: 1, rows_failed: 2 });
    expect(hub.statuses).toEqual(["PARTIAL"]);
    expect(g.batch).toHaveBeenCalledTimes(1);
    expect(st.fakeErrors).toEqual([]);
  });
});
