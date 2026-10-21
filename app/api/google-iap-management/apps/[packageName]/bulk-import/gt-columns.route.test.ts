// @vitest-environment node
/**
 * [GOOGLE-bulkimport-drop-gt] What GT Price / GT Currency do to what reaches
 * Google, end to end (Manager 2026-10-21; design
 * docs/google-iap-management/design-bulkimport-drop-gt-columns.md).
 *
 * G0 pins the behaviour BEFORE the change. G1 edits this file on purpose —
 * its diff is the record of what the change did. One block is the exception:
 * R3 (custom prices, Manager Q4) must stay byte-identical through G1.
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
    rows: Array<{ sku: string; regionOverrides: unknown }>;
    refused: Array<{ rowNumber: number; sku: string; reason: string }>;
    warnings: string[];
    errors: string[];
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
  const pres = await PREVIEW(new Request("http://probe/preview", { method: "POST", body: form }), ctx);
  const pbody = (await pres.json()) as {
    rows?: Array<Omit<PreviewRow, "decision">>;
    refusedRows?: Array<{ rowNumber: number; sku: string; reason: string }>;
    priceHeader?: string | null;
    warnings?: string[];
    errors?: string[];
  };
  const preview = {
    status: pres.status,
    rows: (pbody.rows ?? []).map((r) => ({ sku: r.sku, regionOverrides: r.regionOverrides })),
    refused: pbody.refusedRows ?? [],
    warnings: pbody.warnings ?? [],
    errors: pbody.errors ?? [],
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

/** per_row_pricing[].gt / gt_outcome of the last batch, by SKU. */
const gtAudit = (o: Outcome) =>
  Object.fromEntries(
    ((o.audit?.per_row_pricing ?? []) as Array<{ sku: string; gt: unknown; gt_outcome: string }>).map((r) => [
      r.sku,
      { gt: r.gt, gt_outcome: r.gt_outcome },
    ]),
  );

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

describe("R1 — GT overrides the price only where the row is priced by CONVERSION (G0: today's behaviour)", () => {
  const plain = file(NO_GT, [row()]);
  const gtEmpty = file(WITH_GT, [row()]);
  const gt = file(WITH_GT, [row(GT)]);
  const plainNoTier = file(NO_GT, [row({ [H.price]: 1.49 })]);
  const gtNoTier = file(WITH_GT, [row({ [H.price]: 1.49, ...GT })]);

  it("R1a GT columns present but EMPTY ⇒ the same Google request as a file without them — every source, CREATE and OVERWRITE; no warning", async () => {
    for (const source of SOURCES) for (const decision of DECISIONS) {
      const a = await run({ file: plain, source, decision });
      const b = await run({ file: gtEmpty, source, decision });
      expect(b.sent.requests, `${source} ${decision}`).toHaveLength(1);
      expect(sha(b.sent), `${source} ${decision}`).toBe(sha(a.sent));
      expect(b.preview.warnings).toEqual([]);
      expect(b.hub).toBe("SUCCESS");
    }
  });

  it("R1b USD 0.99 + GT 23000 VND: Google Conversion ⇒ VN = VND 23000 instead of the converted 25740, nothing else moves; a MATCHED tier (Tier 1 / App 1) ⇒ the GT is dropped — request identical to the file without GT", async () => {
    for (const decision of DECISIONS) {
      const conv = await run({ file: gt, source: "google_default", decision });
      const convPlain = await run({ file: plain, source: "google_default", decision });
      expect(convPlain.prices[SKU]).toEqual(CONVERTED_099);
      expect(priceDiff(convPlain, conv), decision).toEqual({ VN: ["VND 25740", "VND 23000"] });
      expect(conv.anchors).toEqual(["USD 0.99"]); // the anchor is the file price, never the GT
      expect(conv.preview.rows).toEqual([{ sku: SKU, regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "23000" }] }]);
      expect([conv.preview.warnings, conv.hub]).toEqual([[], "SUCCESS"]);
      for (const [source, vn] of [["default_template", "VND 25000"], ["app_template", "VND 26000"]] as const) {
        const tier = await run({ file: gt, source, decision });
        const tierPlain = await run({ file: plain, source, decision });
        expect(tier.prices[SKU]?.VN, `${source} ${decision}`).toBe(vn);
        expect(sha(tier.sent), `${source} ${decision}`).toBe(sha(tierPlain.sent));
      }
    }
  });

  it("R1c USD 1.49 — NO tier in either template — + GT 23000 VND ⇒ VN = VND 23000 under ALL THREE sources (the file without GT gets the converted 38740)", async () => {
    for (const source of SOURCES) for (const decision of DECISIONS) {
      const withGt = await run({ file: gtNoTier, source, decision });
      const without = await run({ file: plainNoTier, source, decision });
      expect(without.prices[SKU]?.VN, `${source} ${decision}`).toBe("VND 38740");
      expect(priceDiff(without, withGt), `${source} ${decision}`).toEqual({ VN: ["VND 38740", "VND 23000"] });
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

  it("R1e the REAL generated template (1 locale), GT filled under its own header ⇒ read and sent the same way", async () => {
    const spec = googleIapTemplateSpec(["Vietnamese"]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const r = spec.headers.map(() => null as unknown);
    const set = (h: string, v: unknown) => (r[spec.headers.indexOf(h)] = v);
    set(H.id, SKU);
    set(H.price, 0.99);
    set(H.gtPrice, 23000);
    set(H.gtCurrency, "VND");
    set(H.title, "Kim cương");
    set(H.desc, "Gói kim cương");
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [r], { origin: -1 });
    const tf = new File([new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer)], spec.filename);
    const viaTemplate = await run({ file: tf, source: "google_default" });
    const viaHandFile = await run({ file: gt, source: "google_default" });
    expect(viaTemplate.prices[SKU]?.VN).toBe("VND 23000");
    expect(sha(viaTemplate.sent)).toBe(sha(viaHandFile.sent));
    // The template's own sample rows are skipped, and say so.
    expect(viaTemplate.preview.warnings).toEqual([
      "3 example row(s) skipped (sample Product IDs from the template) — delete the sample rows or replace them with your data.",
    ]);
  });
});

describe("R2 — every kind of GT cell, through preview + execute (Google Conversion, CREATE)", () => {
  /** Row 2 = a clean row (SKU2), row 3 = the row carrying the GT. */
  const twoRows = (gtPrice: unknown, gtCurrency: unknown) =>
    file(WITH_GT, [row({ [H.id]: SKU2 }), row({ [H.gtPrice]: gtPrice, [H.gtCurrency]: gtCurrency })]);

  it("R2a accepted and SENT: VND 26000 with currency \"vnd\" ⇒ VN 26000; the NUMBER 26 (what Excel stores for a typed 26.000) ⇒ VN = VND 26 — 1000× too low, Hub SUCCESS", async () => {
    const lower = await run({ file: twoRows(26000, "vnd"), source: "google_default" });
    expect(lower.prices[SKU]?.VN).toBe("VND 26000");
    const num26 = await run({ file: twoRows(26, "VND"), source: "google_default" });
    expect(num26.preview.refused).toEqual([]);
    expect(num26.prices[SKU]?.VN).toBe("VND 26");
    expect(num26.prices[SKU2]?.VN).toBe("VND 25740");
    expect([num26.hub, num26.preview.warnings]).toEqual(["SUCCESS", []]);
  });

  it("R2b refused ROW (the rest is pushed, Hub PARTIAL): junk, separator text, half-filled pair, 0, too precise, a currency outside the GT table, a pair Google does not bill", async () => {
    const cases: Array<[string, unknown, unknown, string]> = [
      ["junk", "abc", "VND", 'GT Price "abc" VND — Decimal price must be a non-negative number (got "abc").'],
      ["separator", "26.000", "VND", 'GT Price "26.000" VND — "26.000" has a "." but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.'],
      ["price only", 26000, null, 'GT Price "26000" has no GT Currency — fill both or neither.'],
      ["currency only", null, "VND", 'GT Currency "VND" has no GT Price — fill both or neither.'],
      ["zero", 0, "VND", 'GT Price "0" VND — the price is 0 — a 0 price is not accepted; enter the real price.'],
      ["too precise", "26000.5", "VND", 'GT Price "26000.5" VND — VND only accepts whole numbers (got "26000.5"). Google rejects fractional values for this currency.'],
      ["not in the GT table", 26000, "XYZ", 'GT Currency "XYZ" is not a currency the GT column supports (one region per currency: USD, EUR, GBP, JPY, KRW, CNY, TWD, HKD, INR, IDR, THB, VND, PHP, SGD, MYR, AUD, NZD, CAD, MXN, BRL, ARS, RUB, TRY, SAR, AED).'],
      ["not billed", 100, "CNY", 'GT Price "100" CNY — CN is not a region Google Play sells in.'],
    ];
    for (const [label, p, c, reason] of cases) {
      const o = await run({ file: twoRows(p, c), source: "google_default" });
      expect(o.preview.refused, label).toEqual([{ rowNumber: 3, sku: SKU, reason }]);
      expect(o.preview.rows.map((r) => r.sku), label).toEqual([SKU2]);
      expect(o.execute?.refusedKinds, label).toEqual(["refused_in_file"]);
      expect(Object.keys(o.prices), label).toEqual([SKU2]);
      expect(o.hub, label).toBe("PARTIAL");
    }
  });

  it("R2c refused FILE (preview 422, nothing sent): a GT header in the wrong case, or only one of the two GT columns", async () => {
    const miscased = await run({
      file: file([H.id, H.price, "gt price", H.gtCurrency], [row({ "gt price": 26000, [H.gtCurrency]: "VND" })]),
      source: "google_default",
    });
    expect([miscased.preview.status, miscased.preview.errors]).toEqual([422, ['Header "gt price": write it exactly "GT Price".']]);
    const onlyPrice = await run({ file: file([H.id, H.price, H.gtPrice], [row({ [H.gtPrice]: 26000 })]), source: "google_default" });
    expect([onlyPrice.preview.status, onlyPrice.preview.errors]).toEqual([
      422,
      ['The file has a "GT Price" column but no "GT Currency" column — add "GT Currency" (written exactly), or remove "GT Price". A GT needs both.'],
    ]);
    expect([miscased.execute, onlyPrice.execute, g.batch.mock.calls.length]).toEqual([null, null, 0]);
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

describe("R4 — a stale tab / direct POST that carries regionOverrides from the CLIENT (G0: accepted)", () => {
  const plain = file(NO_GT, [row()]);
  const withOverrides = (o: unknown) => (b: Record<string, unknown>) => ({
    ...b,
    rows: (b.rows as Array<Record<string, unknown>>).map((r) => ({ ...r, regionOverrides: o })),
  });

  it("R4a the route takes them: VN 26000 ⇒ sent as VN = VND 26000 (byte-identical to a file GT); JP 170 ⇒ JP = JPY 170; under a matched tier the tier replaces them", async () => {
    const vn = await run({ file: plain, source: "google_default", tamper: withOverrides([{ region: "VN", currency: "VND", priceDecimal: "26000" }]) });
    const fileGt = await run({ file: file(WITH_GT, [row({ [H.gtPrice]: 26000, [H.gtCurrency]: "VND" })]), source: "google_default" });
    expect(vn.prices[SKU]?.VN).toBe("VND 26000");
    expect(sha(vn.sent)).toBe(sha(fileGt.sent));
    const jp = await run({ file: plain, source: "google_default", tamper: withOverrides([{ region: "JP", currency: "JPY", priceDecimal: "170" }]) });
    expect(jp.prices[SKU]).toEqual({ ...CONVERTED_099, JP: "JPY 170" });
    const tier = await run({ file: plain, source: "default_template", tamper: withOverrides([{ region: "VN", currency: "VND", priceDecimal: "26000" }]) });
    expect(tier.prices[SKU]?.VN).toBe("VND 25000");
  });

  it("R4b an override the choke point refuses ⇒ the row is refused (file_price_invalid), nothing sent, Hub FAILED", async () => {
    const o = await run({ file: plain, source: "google_default", tamper: withOverrides([{ region: "VN", currency: "VND", priceDecimal: "26000.5" }]) });
    expect([o.execute?.status, o.execute?.refusedKinds, o.sent.requests.length, o.hub]).toEqual([200, ["file_price_invalid"], 0, "FAILED"]);
  });

  it("R4c the contract: PRICING_RULE is file-currency-only/v1; a body without it ⇒ 409 PREVIEW_OUTDATED, nothing sent", async () => {
    expect(PRICING_RULE).toBe("file-currency-only/v1");
    const o = await run({
      file: plain,
      source: "google_default",
      tamper: (b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "pricing_rule")),
    });
    expect([o.execute?.status, o.execute?.code, o.sent.requests.length, o.hub]).toEqual([409, "PREVIEW_OUTDATED", 0, "FAILED"]);
  });
});

describe("R5 — the audit records each row's GT (per_row_pricing.gt / gt_outcome — Manager Q5 removes them)", () => {
  it("R5 none · kept · replaced_by_tier · replaced_by_custom · not_sent (Skip, refused)", async () => {
    const gtFile = file(WITH_GT, [row({ [H.gtPrice]: 26000, [H.gtCurrency]: "VND" })]);
    const GT_VN = { region: "VN", currency: "VND", price: "26000" };
    const cases: Array<[string, () => Promise<Outcome>, unknown]> = [
      ["no GT", () => run({ file: file(NO_GT, [row()]), source: "google_default" }), { gt: null, gt_outcome: "none" }],
      ["Google Conversion", () => run({ file: gtFile, source: "google_default" }), { gt: GT_VN, gt_outcome: "kept" }],
      ["matched tier", () => run({ file: gtFile, source: "default_template" }), { gt: GT_VN, gt_outcome: "replaced_by_tier" }],
      [
        "custom",
        () => run({ file: gtFile, source: "google_default", custom: { [SKU]: [{ region: "TW", currency: "TWD", priceDecimal: "35" }] } }),
        { gt: GT_VN, gt_outcome: "replaced_by_custom" },
      ],
      ["Skip", () => run({ file: gtFile, source: "google_default", decision: "skip" }), { gt: GT_VN, gt_outcome: "not_sent" }],
      [
        "refused at execute",
        () =>
          run({
            file: file(NO_GT, [row()]),
            source: "google_default",
            tamper: (b) => ({
              ...b,
              rows: (b.rows as Array<Record<string, unknown>>).map((r) => ({
                ...r,
                regionOverrides: [{ region: "VN", currency: "VND", priceDecimal: "26000.5" }],
              })),
            }),
          }),
        { gt: { region: "VN", currency: "VND", price: "26000.5" }, gt_outcome: "not_sent" },
      ],
    ];
    // One at a time: every run resets the shared fakes.
    for (const [label, start, expected] of cases) {
      const o = await start();
      expect(gtAudit(o)[SKU], label).toEqual(expected);
      expect(o.audit?.pricing_rule, label).toBe("file-currency-only/v1");
    }
  });
});

describe("R6 — an old row pasted WHOLE into a file without GT columns (Manager Q6) — G0: accepted", () => {
  it("R6 Title (Vietnamese) = 26000, Description (Vietnamese) = VND ⇒ imported with that listing (and en-US copied from it), CREATE and OVERWRITE, Hub SUCCESS", async () => {
    const pasted = file(NO_GT, [row({ [H.title]: 26000, [H.desc]: "VND" })]);
    for (const decision of DECISIONS) {
      const o = await run({ file: pasted, source: "google_default", decision });
      expect(o.preview.refused, decision).toEqual([]);
      expect(o.listings[SKU], decision).toEqual([
        { languageCode: "vi", title: "26000", description: "VND" },
        { languageCode: "en-US", title: "26000", description: "VND" },
      ]);
      expect(o.hub, decision).toBe("SUCCESS");
    }
  });
});

describe("the fakes", () => {
  it("answered every query truthfully across the whole file (no unsupported DB method, no FX miss)", () => {
    expect(st.fakeErrors).toEqual([]);
  });
});
