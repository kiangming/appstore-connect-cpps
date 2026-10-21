// @vitest-environment node
/**
 * [GOOGLE-bulkimport-drop-gt] What GT Price / GT Currency do to what reaches
 * Google, end to end (Manager 2026-10-21; design
 * docs/google-iap-management/design-bulkimport-drop-gt-columns.md).
 *
 * G0 (2e3c3e0) pinned the behaviour BEFORE the change; G1 edited this file on
 * purpose — its diff is the record of what the change did:
 *   - R1/R2: a file's GT — any value, any header spelling — changes NOTHING
 *     that reaches Google (Manager Q1); the preview reports it, Push goes on;
 *   - R4: the route refuses client-sent regionOverrides; PRICING_RULE v2 (Q4);
 *   - R5: the audit no longer holds gt / gt_outcome, it counts GT rows (Q5);
 *   - R6: an old row pasted whole is refused (Q6).
 * One block is the exception: R3 (custom prices, Manager Q4) is
 * byte-identical — its pinned fingerprints were measured on G0's code and
 * G1 did not touch them.
 *
 * WHAT RUNS FOR REAL: the preview route, the execute route, the parser, the
 * file-price choke point, the orchestrator, the template queries, the
 * publisher client and the one-time-product adapter. The wizard side is the
 * wizard's own code (execute-payload.ts). The files are built under the real
 * header names.
 *
 * WHAT IS FAKED (the same fakes as file-currency-invariance.test.ts, kept to
 * what this file needs): googleapis — nothing is sent anywhere; the DB
 * (in-memory; an unsupported query method or a single() over >1 rows is
 * recorded and fails the run); the session, account, app row, IAP mirror,
 * audit log and Hub tracking. convertRegionPrices uses a MADE-UP exchange
 * table — a converted number shows which anchor reached Google, not what
 * Google would answer.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

const PKG = "com.vnggames.gtprobe";

const g = vi.hoisted(() => ({
  convert: vi.fn(),
  batch: vi.fn(),
  get: vi.fn(),
  states: vi.fn(),
  legacy: vi.fn(),
}));
const st = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Anything the fakes could not answer truthfully. Must stay empty. */
  fakeErrors: [] as string[],
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
    display_name: "GT probe",
    default_currency: null,
    default_currency_source: null,
    default_language: "en-US",
    default_language_source: "declared",
  }),
  getIapsMirrorSyncedAt: async () => "2026-10-21T03:00:00.000Z",
}));
vi.mock("@/lib/google-iap-management/repository/iaps", () => ({
  listIapsForApp: async () => st.mirror,
  syncIapFromGoogle: async () => undefined,
}));
const audit = vi.hoisted(() => ({ payloads: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({
  appendAction: async (a: { payload?: Record<string, unknown> }) => {
    audit.payloads.push(a.payload ?? {});
  },
}));
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId: () => null,
  resolveActiveAccountId: () => "acc1",
}));
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
  previewRowsFromResponse,
  seedTierSelections,
} from "@/components/google-iap-management/bulk-import/execute-payload";
import type { PreviewRow } from "@/components/google-iap-management/bulk-import/BulkImportWizard";
import type { CustomPriceSet } from "@/components/google-iap-management/bulk-import/CustomPricesDialog";
import { googleIapTemplateSpec, GOOGLE_DATA_SHEET_NAME } from "@/lib/google-iap-management/parsers/template-spec";
import { buildTemplateWorkbook } from "@/lib/xlsx-template";
import { PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";

/* ── Fixtures ─────────────────────────────────────────────────────────── */

/** MADE-UP units per 1 USD. */
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

/** ACCOUNT template (Tier 1 = USD 0.99, Tier 2 = USD 1.99) and APP template
 *  (App 1 = USD 0.99). USD 1.49 matches no tier in either. */
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
      e("tpl-acc", "Tier 2", "US", "USD", "1990000", 1),
      e("tpl-acc", "Tier 2", "VN", "VND", "49000000000", 2),
      e("tpl-app", "App 1", "US", "USD", "990000", 1),
      e("tpl-app", "App 1", "VN", "VND", "26000000000", 2),
    ],
    import_batches: [],
  };
}

type Source = "google_default" | "default_template" | "app_template";
type Decision = "create" | "overwrite" | "skip";
const SOURCES: Source[] = ["google_default", "default_template", "app_template"];

const SKU = "com.vnggames.gtprobe.gem";
const SKU2 = "com.vnggames.gtprobe.gem2";
const H = {
  id: "Product ID",
  price: "Price (USD)",
  gtPrice: "GT Price",
  gtCurrency: "GT Currency",
  title: "Title (Vietnamese)",
  desc: "Description (Vietnamese)",
};
const WITH_GT = [H.id, H.price, H.gtPrice, H.gtCurrency, H.title, H.desc];
const NO_GT = [H.id, H.price, H.title, H.desc];

/** A file with these headers; each row is written BY HEADER NAME. */
function file(headers: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): File {
  const aoa = [headers as string[], ...rows.map((r) => headers.map((h) => (h in r ? r[h] : null)))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), GOOGLE_DATA_SHEET_NAME);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([new Uint8Array(buf)], "gt.xlsx");
}
const row = (over: Record<string, unknown> = {}) => ({ [H.id]: SKU, [H.price]: 0.99, [H.title]: "Kim cương", [H.desc]: "Gói kim cương", ...over });

/** The live product an Overwrite GETs. */
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
    ],
  };
}

const sha = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const ctx = { params: { packageName: PKG } };

interface RunOpts {
  file: File;
  source: Source;
  decision?: Decision;
  /** Custom-prices sets the Manager saved in the preview dialog, by SKU. */
  custom?: Record<string, CustomPriceSet["entries"]>;
  /** A stale tab / direct POST: rewrite the body the wizard built. */
  tamper?: (body: Record<string, unknown>) => Record<string, unknown>;
}
interface Outcome {
  preview: {
    status: number;
    rows: Array<{ sku: string }>;
    refused: Array<{ rowNumber: number; sku: string; reason: string }>;
    warnings: string[];
    errors: string[];
    retiredGtColumns: unknown;
  };
  execute: { status: number; error?: string; code?: string; refusedKinds: string[]; rowsCreated?: number; rowsOverwritten?: number } | null;
  /** batchUpdate request bodies + purchase-option state calls — everything sent. */
  sent: { requests: unknown[]; states: unknown[] };
  /** Region → money, per SKU, of the priced purchase option. */
  prices: Record<string, Record<string, string>>;
  /** Listings sent, per SKU. */
  listings: Record<string, unknown>;
  anchors: string[];
  hub: string;
  audit: Record<string, unknown> | null;
}

async function run(o: RunOpts): Promise<Outcome> {
  st.tables = seedTables();
  const decision = o.decision ?? "create";
  st.mirror = decision === "create" ? [] : [{ sku: SKU }, { sku: SKU2 }];
  audit.payloads.length = 0;
  hub.statuses.length = 0;
  Object.values(g).forEach((m) => m.mockReset());
  g.convert.mockImplementation(async (r: { requestBody: { price: Money } }) => fakeConvertRegionPrices(r));
  g.batch.mockImplementation(async (r: { requestBody: { requests: Array<{ oneTimeProduct: unknown }> } }) => ({
    data: { oneTimeProducts: r.requestBody.requests.map((x) => x.oneTimeProduct) },
  }));
  g.states.mockResolvedValue({ data: {} });
  g.get.mockImplementation(async (r: { productId: string }) => ({ data: liveProduct(r.productId) }));
  g.legacy.mockRejectedValue(new Error("the legacy batch fallback must never be reached"));

  const form = new FormData();
  form.append("file", o.file);
  form.append("pricingSource", o.source);
  form.append("pricing_rule", PRICING_RULE);
  const pres = await PREVIEW(new Request("http://probe/preview", { method: "POST", body: form }), ctx);
  const pbody = (await pres.json()) as {
    rows?: Array<Omit<PreviewRow, "decision">>;
    refusedRows?: Array<{ rowNumber: number; sku: string; reason: string }>;
    priceHeader?: string | null;
    warnings?: string[];
    errors?: string[];
    retiredGtColumns?: { rowsWithData: number } | null;
  };
  const preview = {
    status: pres.status,
    rows: (pbody.rows ?? []).map((r) => ({ sku: r.sku })),
    refused: pbody.refusedRows ?? [],
    warnings: pbody.warnings ?? [],
    errors: pbody.errors ?? [],
    retiredGtColumns: pbody.retiredGtColumns,
  };
  const empty = { requests: [], states: [] };
  if (!pres.ok || !pbody.rows) {
    return { preview, execute: null, sent: empty, prices: {}, listings: {}, anchors: [], hub: "none", audit: null };
  }

  // The Manager's decision on every row (Overwrite / Skip on existing rows).
  const rows = previewRowsFromResponse(pbody.rows).map((r) => ({ ...r, decision: decision as PreviewRow["decision"] }));
  const customPrices: Record<string, CustomPriceSet> = Object.fromEntries(
    Object.entries(o.custom ?? {}).map(([sku, entries]) => [sku, { entries, baseline: { kind: "none" }, editedAt: "2026-10-21T00:00:00.000Z" }]),
  );
  let body: Record<string, unknown> = buildExecuteRequestBody({
    pricingSource: o.source,
    sourceFilename: "gt.xlsx",
    hubRunId: "run-gt",
    rows: buildExecuteRows(rows, {
      tierSelections: seedTierSelections(rows),
      customPrices,
      activeCustomSkus: activeCustomSkuSet(rows, customPrices),
    }),
    droppedRows: pbody.refusedRows ?? [],
    priceHeader: pbody.priceHeader ?? null,
    gtRowsWithData: pbody.retiredGtColumns?.rowsWithData ?? null,
  });
  if (o.tamper) body = o.tamper(structuredClone(body));

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
    code?: string;
    refusedRows?: Array<{ kind: string; reason: string }>;
    rowsCreated?: number;
    rowsOverwritten?: number;
  };

  type Cfg = { regionCode: string; price: Money };
  type Req = {
    oneTimeProduct?: {
      productId?: string;
      listings?: unknown;
      purchaseOptions?: Array<{ purchaseOptionId?: string; regionalPricingAndAvailabilityConfigs?: Cfg[] }>;
    };
  };
  const requests = g.batch.mock.calls.map((c) => (c[0] as { requestBody?: unknown }).requestBody ?? null);
  const states = g.states.mock.calls.map((c) => (c[0] as { requestBody?: unknown }).requestBody ?? null);
  const prices: Outcome["prices"] = {};
  const listings: Outcome["listings"] = {};
  for (const rb of requests as Array<{ requests?: Req[] } | null>) {
    for (const req of rb?.requests ?? []) {
      const p = req.oneTimeProduct;
      if (!p?.productId) continue;
      const cfgs = p.purchaseOptions?.[0]?.regionalPricingAndAvailabilityConfigs ?? [];
      prices[p.productId] = Object.fromEntries(cfgs.map((c) => [c.regionCode, moneyText(c.price)]));
      listings[p.productId] = p.listings;
    }
  }
  return {
    preview,
    execute: {
      status: eres.status,
      ...(ebody.error ? { error: ebody.error } : {}),
      ...(ebody.code ? { code: ebody.code } : {}),
      refusedKinds: (ebody.refusedRows ?? []).map((r) => r.kind),
      rowsCreated: ebody.rowsCreated,
      rowsOverwritten: ebody.rowsOverwritten,
    },
    sent: { requests, states },
    prices,
    listings,
    anchors: g.convert.mock.calls.map((c) => moneyText((c[0] as { requestBody: { price: Money } }).requestBody.price)),
    hub: hub.statuses.join("+") || "none",
    audit: audit.payloads.at(-1) ?? null,
  };
}

beforeAll(() => {
  for (const m of ["info", "warn", "log", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  st.fakeErrors = [];
});
afterAll(() => vi.restoreAllMocks());

/* ── Pins ──────────────────────────────────────────────────────────────── */

/** Regions whose price differs between two runs of the same SKU. */
function priceDiff(a: Outcome, b: Outcome, sku = SKU): Record<string, [string | undefined, string | undefined]> {
  const pa = a.prices[sku] ?? {};
  const pb = b.prices[sku] ?? {};
  const out: Record<string, [string | undefined, string | undefined]> = {};
  for (const r of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[r] !== pb[r]) out[r] = [pa[r], pb[r]];
  return out;
}

/** The six-region price map of a USD 0.99 row converted by the fake FX. */
const CONVERTED_099 = { DE: "EUR 0.91", JP: "JPY 149", KR: "KRW 1386", TW: "TWD 32", US: "USD 0.99", VN: "VND 25740" };
/** GT value distinct from every other VN price in the fixtures (conversion
 *  25740 / 38740, Tier 1 25000, App 1 26000) — the Manager's own legacy value. */
const GT = { [H.gtPrice]: 23000, [H.gtCurrency]: "VND" };
const DECISIONS = ["create", "overwrite"] as const;

describe("R1 — a file's GT changes NOTHING that reaches Google (Manager Q1: never read, never sent)", () => {
  const plain = file(NO_GT, [row()]);
  const gtEmpty = file(WITH_GT, [row()]);
  const gt = file(WITH_GT, [row(GT)]);
  const plainNoTier = file(NO_GT, [row({ [H.price]: 1.49 })]);
  const gtNoTier = file(WITH_GT, [row({ [H.price]: 1.49, ...GT })]);

  it("R1a GT columns present but EMPTY ⇒ the same Google request as a file without them — every source, CREATE and OVERWRITE; the LIGHT notice, Push goes through", async () => {
    for (const source of SOURCES) for (const decision of DECISIONS) {
      const a = await run({ file: plain, source, decision });
      const b = await run({ file: gtEmpty, source, decision });
      expect(b.sent.requests, `${source} ${decision}`).toHaveLength(1);
      expect(sha(b.sent), `${source} ${decision}`).toBe(sha(a.sent));
      expect([a.preview.retiredGtColumns, b.preview.retiredGtColumns]).toEqual([null, { rowsWithData: 0 }]);
      expect(b.preview.warnings).toEqual(a.preview.warnings);
      expect(b.hub).toBe("SUCCESS");
    }
  });

  it("R1b USD 0.99 + GT 23000 VND ⇒ byte-identical to the file without GT under ALL THREE sources (Google Conversion: VN stays the converted 25740 — G0 sent 23000; a matched tier: its own VN)", async () => {
    for (const decision of DECISIONS) {
      for (const [source, vn] of [["google_default", "VND 25740"], ["default_template", "VND 25000"], ["app_template", "VND 26000"]] as const) {
        const withGt = await run({ file: gt, source, decision });
        const without = await run({ file: plain, source, decision });
        expect(withGt.prices[SKU]?.VN, `${source} ${decision}`).toBe(vn);
        expect(sha(withGt.sent), `${source} ${decision}`).toBe(sha(without.sent));
        expect(priceDiff(without, withGt)).toEqual({});
        expect(withGt.anchors).toEqual(["USD 0.99"]);
        expect([withGt.preview.retiredGtColumns, withGt.preview.refused, withGt.hub]).toEqual([{ rowsWithData: 1 }, [], "SUCCESS"]);
      }
    }
    const conv = await run({ file: gt, source: "google_default" });
    expect(conv.prices[SKU]).toEqual(CONVERTED_099);
  });

  it("R1c USD 1.49 — no tier anywhere — + GT 23000 VND ⇒ VN = the converted VND 38740 under ALL THREE sources (G0 sent 23000)", async () => {
    for (const source of SOURCES) for (const decision of DECISIONS) {
      const withGt = await run({ file: gtNoTier, source, decision });
      const without = await run({ file: plainNoTier, source, decision });
      expect(withGt.prices[SKU]?.VN, `${source} ${decision}`).toBe("VND 38740");
      expect(sha(withGt.sent), `${source} ${decision}`).toBe(sha(without.sent));
      expect(withGt.hub).toBe("SUCCESS");
    }
  });

  it("R1d CREATE and OVERWRITE price the same: the priced option's regional configs are identical", async () => {
    for (const f of [gt, gtNoTier]) for (const source of SOURCES) {
      const c = await run({ file: f, source, decision: "create" });
      const o = await run({ file: f, source, decision: "overwrite" });
      expect(o.prices, source).toEqual(c.prices);
    }
  });

  it("R1e the NEW template (1 locale, real generator) imports right; an OLD file — the Manager's legacy template, VN 23000 on every row — sends exactly what the same rows without GT send", async () => {
    const spec = googleIapTemplateSpec(["Vietnamese"]);
    expect(spec.headers).toEqual([H.id, H.price, H.title, H.desc]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [[SKU, 0.99, "Kim cương", "Gói kim cương"]], { origin: -1 });
    const tf = new File([new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer)], spec.filename);
    const viaTemplate = await run({ file: tf, source: "google_default" });
    expect(viaTemplate.prices[SKU]).toEqual(CONVERTED_099);
    expect(sha(viaTemplate.sent)).toBe(sha((await run({ file: plain, source: "google_default" })).sent));
    expect([viaTemplate.preview.retiredGtColumns, viaTemplate.hub]).toEqual([null, "SUCCESS"]);
    expect(viaTemplate.preview.warnings).toEqual([
      "3 example row(s) skipped (sample Product IDs from the template) — delete the sample rows or replace them with your data.",
    ]);

    const legacy = readFileSync(join(process.cwd(), "docs/google-iap-management/templates/template-item-iap-google.xlsx"));
    const legacyRun = await run({ file: new File([new Uint8Array(legacy)], "template-item-iap-google.xlsx"), source: "google_default" });
    const skus = ["com.vng.example.product1", "com.vng.example.product2", "com.vng.example.product3"];
    const sameRowsNoGt = await run({
      file: file(
        ["Product ID", "Price (USD)", "Title (Afrikaans)", "Description (Afrikaans)"],
        skus.map((sku, i) => ({ "Product ID": sku, "Price (USD)": 0.99, "Title (Afrikaans)": `Example ${i + 1}`, "Description (Afrikaans)": `Example ${i + 1}` })),
      ),
      source: "google_default",
    });
    expect(Object.keys(legacyRun.prices)).toEqual(skus);
    expect(skus.map((s) => legacyRun.prices[s]?.VN)).toEqual(["VND 25740", "VND 25740", "VND 25740"]);
    expect(sha(legacyRun.sent)).toBe(sha(sameRowsNoGt.sent));
    expect([legacyRun.preview.retiredGtColumns, legacyRun.hub]).toEqual([{ rowsWithData: 3 }, "SUCCESS"]);
  });
});

describe("R2 — every kind of GT cell, and every GT header spelling: ignored — nothing refused, nothing sent from it (Google Conversion, CREATE)", () => {
  /** Row 2 = a clean row (SKU2), row 3 = the row carrying the GT. */
  const twoRows = (gtPrice: unknown, gtCurrency: unknown) =>
    file(WITH_GT, [row({ [H.id]: SKU2 }), row({ [H.gtPrice]: gtPrice, [H.gtCurrency]: gtCurrency })]);
  const noGtTwoRows = file(NO_GT, [row({ [H.id]: SKU2 }), row()]);

  it("R2a valid, junk, half-filled, 0, too precise, the NUMBER 26, a currency outside the old GT table or not billed ⇒ both rows sent, byte-identical to the file without GT; the notice counts the row; Hub SUCCESS (G0: VN 26 sent / 8 kinds refused)", async () => {
    const base = await run({ file: noGtTwoRows, source: "google_default" });
    expect(base.prices[SKU]?.VN).toBe("VND 25740");
    const kinds: Array<[unknown, unknown]> = [
      [26000, "vnd"], [26, "VND"], ["abc", "VND"], ["26.000", "VND"], [26000, null], [null, "VND"],
      [0, "VND"], ["26000.5", "VND"], [26000, "XYZ"], [100, "CNY"],
    ];
    for (const [p, c] of kinds) {
      const o = await run({ file: twoRows(p, c), source: "google_default" });
      const at = `GT ${String(p)} / ${String(c)}`;
      expect(o.preview.refused, at).toEqual([]);
      expect(o.preview.rows.map((r) => r.sku), at).toEqual([SKU2, SKU]);
      expect(o.preview.retiredGtColumns, at).toEqual({ rowsWithData: 1 });
      expect(o.execute?.refusedKinds, at).toEqual([]);
      expect(sha(o.sent), at).toBe(sha(base.sent));
      expect(o.hub, at).toBe("SUCCESS");
    }
  });

  it("R2b a GT header in another case, or only ONE of the two GT columns ⇒ preview 200, the file is imported as if the column were not there (gate G0; G0 answered 422)", async () => {
    const base = await run({ file: file(NO_GT, [row()]), source: "google_default" });
    const files = {
      "gt price + GT Currency": file([H.id, H.price, "gt price", H.gtCurrency, H.title, H.desc], [row({ "gt price": 26000, [H.gtCurrency]: "VND" })]),
      "GT Price only": file([H.id, H.price, H.gtPrice, H.title, H.desc], [row({ [H.gtPrice]: 26000 })]),
      "GT Currency only": file([H.id, H.price, H.gtCurrency, H.title, H.desc], [row({ [H.gtCurrency]: "VND" })]),
    };
    for (const [label, f] of Object.entries(files)) {
      const o = await run({ file: f, source: "google_default" });
      expect([o.preview.status, o.preview.errors, o.preview.retiredGtColumns], label).toEqual([200, [], { rowsWithData: 1 }]);
      expect(sha(o.sent), label).toBe(sha(base.sent));
      expect(o.hub, label).toBe("SUCCESS");
    }
  });
});

describe("R3 — custom prices: BYTE-IDENTICAL through G1 (Manager Q4 — regionOverrides still carries tier/custom prices server-side)", () => {
  const SETS: Record<string, CustomPriceSet["entries"]> = {
    "VN 27000 + JP 170": [
      { region: "VN", currency: "VND", priceDecimal: "27000" },
      { region: "JP", currency: "JPY", priceDecimal: "170" },
    ],
    "TW 35 (no VN)": [{ region: "TW", currency: "TWD", priceDecimal: "35" }],
  };
  /** sha16 of everything sent to Google (batchUpdate bodies + state calls).
   *  Measured 2026-10-21 on G0's code. ⚠ G1 must NOT change these. */
  const PINNED: Record<string, Record<(typeof DECISIONS)[number], string>> = {
    "VN 27000 + JP 170": { create: "0477007610482d16", overwrite: "0af70780997ede5f" },
    "TW 35 (no VN)": { create: "c4ef1d79aab5d536", overwrite: "80f7b27430df1d37" },
  };

  it("R3a the request is the pinned bytes — under all three sources, CREATE and OVERWRITE, with or without GT in the file", async () => {
    const files = { "no GT": file(NO_GT, [row()]), "GT 26000 VND": file(WITH_GT, [row({ [H.gtPrice]: 26000, [H.gtCurrency]: "VND" })]) };
    let runs = 0;
    for (const [setName, entries] of Object.entries(SETS)) for (const [fileName, f] of Object.entries(files))
      for (const source of SOURCES) for (const decision of DECISIONS) {
        const o = await run({ file: f, source, decision, custom: { [SKU]: entries } });
        const at = `${setName} · ${fileName} · ${source} · ${decision}`;
        expect(sha(o.sent), at).toBe(PINNED[setName][decision]);
        expect(o.hub, at).toBe("SUCCESS");
        runs += 1;
      }
    expect(runs).toBe(2 * 2 * 3 * 2);
  });

  it("R3b what those bytes say: the custom amounts verbatim; a country the set leaves out is converted from the FILE price (never the GT)", async () => {
    const withGt = file(WITH_GT, [row({ [H.gtPrice]: 26000, [H.gtCurrency]: "VND" })]);
    const a = await run({ file: withGt, source: "google_default", custom: { [SKU]: SETS["VN 27000 + JP 170"] } });
    expect(a.prices[SKU]).toEqual({ ...CONVERTED_099, VN: "VND 27000", JP: "JPY 170" });
    const b = await run({ file: withGt, source: "default_template", custom: { [SKU]: SETS["TW 35 (no VN)"] } });
    expect(b.prices[SKU]).toEqual({ ...CONVERTED_099, TW: "TWD 35" });
    expect(b.anchors).toEqual(["USD 0.99"]);
  });
});

describe("R4 — a stale tab / direct POST that carries regionOverrides from the CLIENT ⇒ refused (Manager Q4)", () => {
  const plain = file(NO_GT, [row()]);
  const withOverrides = (o: unknown) => (b: Record<string, unknown>) => ({
    ...b,
    rows: (b.rows as Array<Record<string, unknown>>).map((r) => ({ ...r, regionOverrides: o })),
  });
  const REFUSED =
    "Row 2: regionOverrides is not accepted — a country's own price comes only from a pricing-template tier or Custom prices (GT Price / GT Currency are no longer used). Nothing was sent.";

  it("R4a ANY non-empty regionOverrides ⇒ 400 REGION_OVERRIDES_REFUSED, under every source; nothing reaches Google; Hub FAILED (G0: VN 26000 / JP 170 were sent)", async () => {
    const cases: unknown[] = [
      [{ region: "VN", currency: "VND", priceDecimal: "26000" }],
      [{ region: "JP", currency: "JPY", priceDecimal: "170" }],
      [{ region: "VN", currency: "VND", priceDecimal: "26000.5" }],
      [{}],
      "VN 26000",
      { VN: "26000" },
    ];
    for (const source of SOURCES) for (const ro of cases) {
      const o = await run({ file: plain, source, tamper: withOverrides(ro) });
      const at = `${source} ${JSON.stringify(ro)}`;
      expect([o.execute?.status, o.execute?.code, o.execute?.error], at).toEqual([400, "REGION_OVERRIDES_REFUSED", REFUSED]);
      expect([o.sent.requests.length, o.anchors.length, o.hub, o.audit], at).toEqual([0, 0, "FAILED", null]);
    }
  });

  it("R4b an EMPTY list (or none) is accepted: byte-identical to the wizard's own body", async () => {
    const own = await run({ file: plain, source: "google_default" });
    for (const ro of [[], null, undefined]) {
      const o = await run({ file: plain, source: "google_default", tamper: withOverrides(ro) });
      expect([o.execute?.status, sha(o.sent), o.hub], String(ro)).toEqual([200, sha(own.sent), "SUCCESS"]);
    }
  });

  it("R4c the contract: PRICING_RULE is file-currency-only/v2; a v1 body (a tab opened before) or none ⇒ 409 PREVIEW_OUTDATED, nothing sent", async () => {
    expect(PRICING_RULE).toBe("file-currency-only/v2");
    const v1 = await run({ file: plain, source: "google_default", tamper: (b) => ({ ...b, pricing_rule: "file-currency-only/v1" }) });
    const none = await run({
      file: plain,
      source: "google_default",
      tamper: (b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "pricing_rule")),
    });
    for (const o of [v1, none]) {
      expect([o.execute?.status, o.execute?.code, o.sent.requests.length, o.hub]).toEqual([409, "PREVIEW_OUTDATED", 0, "FAILED"]);
      expect(o.execute?.error).toBe(
        "The tool was updated since this page was opened: this preview was made with an older version, which priced rows " +
          "differently (the app's currency, or the GT Price column). Nothing was sent. Reload this page, then upload the file " +
          "and run Preview again.",
      );
    }
  });
});

describe("R5 — the audit counts the rows with GT, never their values (Manager Q5: per_row_pricing.gt / gt_outcome are gone)", () => {
  it("R5 gt_rows_with_data = the preview's count (null: no GT column; 0: columns but empty); per_row_pricing has no gt key; pricing_rule v2", async () => {
    const gtFile = file(WITH_GT, [row({ [H.gtPrice]: 26000, [H.gtCurrency]: "VND" }), row({ [H.id]: SKU2, [H.gtCurrency]: "VND" })]);
    const cases: Array<[string, () => Promise<Outcome>, number | null]> = [
      ["no GT column", () => run({ file: file(NO_GT, [row()]), source: "google_default" }), null],
      ["GT columns, empty", () => run({ file: file(WITH_GT, [row()]), source: "google_default" }), 0],
      ["2 rows with GT", () => run({ file: gtFile, source: "google_default" }), 2],
      ["2 rows with GT, matched tier", () => run({ file: gtFile, source: "default_template" }), 2],
      [
        "2 rows with GT, custom",
        () => run({ file: gtFile, source: "google_default", custom: { [SKU]: [{ region: "TW", currency: "TWD", priceDecimal: "35" }] } }),
        2,
      ],
      ["2 rows with GT, Skip", () => run({ file: gtFile, source: "google_default", decision: "skip" }), 2],
    ];
    // One at a time: every run resets the shared fakes.
    for (const [label, start, expected] of cases) {
      const o = await start();
      expect(o.audit?.gt_rows_with_data, label).toBe(expected);
      expect(o.audit?.pricing_rule, label).toBe("file-currency-only/v2");
      const perRow = (o.audit?.per_row_pricing ?? []) as Array<Record<string, unknown>>;
      expect(perRow.length, label).toBeGreaterThan(0);
      for (const r of perRow) {
        expect(Object.keys(r), label).toEqual([
          "row_number", "sku", "decision", "file_currency", "file_price", "anchor", "regions_version", "regions_version_from", "outcome",
        ]);
      }
      expect(JSON.stringify(o.audit), label).not.toMatch(/"gt"|gt_outcome|26000"|"VND 26000/);
    }
  });
});

describe("R6 — an old row pasted WHOLE into a file without GT columns ⇒ refused (Manager Q6), CREATE and OVERWRITE", () => {
  const REASON =
    '"Title (Vietnamese)" = "26000" và "Description (Vietnamese)" = "VND": có vẻ dữ liệu bị lệch cột — đừng chép cả dòng từ template cũ; hãy chép theo từng cột.';

  it("R6a the shifted row is refused in the preview; pushing the rest sends only the other row — its listing never reaches Google; Hub PARTIAL (G0: '26000' / 'VND' sent as the vi + en-US listing)", async () => {
    const pasted = file(NO_GT, [row({ [H.id]: SKU2 }), row({ [H.title]: 26000, [H.desc]: "VND" })]);
    for (const decision of DECISIONS) {
      const o = await run({ file: pasted, source: "google_default", decision });
      expect(o.preview.refused, decision).toEqual([{ rowNumber: 3, sku: SKU, reason: REASON }]);
      expect(o.preview.rows.map((r) => r.sku), decision).toEqual([SKU2]);
      expect(o.execute?.refusedKinds, decision).toEqual(["refused_in_file"]);
      expect(Object.keys(o.listings), decision).toEqual([SKU2]);
      expect(o.listings[SKU2], decision).toEqual([
        { languageCode: "vi", title: "Kim cương", description: "Gói kim cương" },
        { languageCode: "en-US", title: "Kim cương", description: "Gói kim cương" },
      ]);
      expect(JSON.stringify(o.sent), decision).not.toMatch(/"title":"26000"/);
      expect(o.hub, decision).toBe("PARTIAL");
    }
  });

  it("R6b only BOTH conditions refuse: a numeric title with a real description, or a real title with \"VND\", is imported as written", async () => {
    for (const [title, desc] of [[26000, "Gói kim cương"], ["Kim cương", "VND"]] as const) {
      const o = await run({ file: file(NO_GT, [row({ [H.title]: title, [H.desc]: desc })]), source: "google_default", decision: "overwrite" });
      expect([o.preview.refused, o.hub], `${title} / ${desc}`).toEqual([[], "SUCCESS"]);
      expect((o.listings[SKU] as Array<{ title: string }>)[0], `${title} / ${desc}`).toEqual({ languageCode: "vi", title: String(title), description: desc });
    }
  });
});

describe("the fakes", () => {
  it("answered every query truthfully across the whole file (no unsupported DB method, no FX miss)", () => {
    expect(st.fakeErrors).toEqual([]);
  });
});
