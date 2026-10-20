/**
 * [APPLE-bulkimport-drop-gt] The REAL execute route with GT Price / GT
 * Currency still in the file (Manager 2026-10-20; design
 * docs/iap-management/design-apple-bulkimport-drop-gt-columns.md §1.3).
 *
 * The real route, the real parser (from a file made by the real template
 * generator), the real conflict resolution / tier enrichment / localization
 * selection. Every Apple, DB and Hub boundary is replaced by a recorder, so
 * the test sees EVERYTHING the route would send or write.
 *
 * Pinned:
 *   R1 GT does not reach Apple, the DB or the audit: every kind of GT gives
 *      the SAME recorded calls as an empty GT, and as no GT columns at all.
 *   R2 a GT Price that is not a number no longer rejects the file — the
 *      batch runs exactly like a file without GT. (G0, c7fc479, pinned the
 *      old behaviour here: 422, Hub FAILED, nothing sent; G1 flipped it —
 *      Manager: "không cần kiểm tra hai cột này".)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

const CAP = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
const rec = (name: string, payload: unknown) => CAP.calls.push([name, payload]);

vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/iap-management/auth");
  return { ...actual, requireIapSession: vi.fn(async () => ({ user: { email: "gt@example.test", role: "member" } })) };
});
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ id: "acc-1", keyId: "k", issuerId: "i", privateKey: "p" })),
}));
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));
vi.mock("@/lib/asc-client", () => ({
  getApp: vi.fn(async () => ({ data: { attributes: { bundleId: "com.vng.gt", name: "GT App" } } })),
}));
vi.mock("@/lib/iap-management/apple/client", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/iap-management/apple/client");
  return {
    ...actual,
    createInAppPurchase: vi.fn(async (_c: unknown, body: unknown) => {
      rec("apple.createInAppPurchase", body);
      return { data: { id: "APPLE-NEW-1" } };
    }),
    createInAppPurchaseLocalization: vi.fn(async (_c: unknown, body: unknown) => {
      rec("apple.createInAppPurchaseLocalization", body);
      return { data: { id: "LOC-1" } };
    }),
    listAllInAppPurchases: vi.fn(async () => ({
      data: [{ id: "APPLE-EXIST-2", attributes: { productId: "com.vng.gt.exist" } }],
    })),
    updateInAppPurchase: vi.fn(async (_c: unknown, id: unknown, patch: unknown) => {
      rec("apple.updateInAppPurchase", { id, patch });
      return { data: { id } };
    }),
    reserveInAppPurchaseScreenshot: vi.fn(async () => {
      throw new Error("not expected: no screenshots in this batch");
    }),
    uploadScreenshotToOperations: vi.fn(),
    confirmInAppPurchaseScreenshot: vi.fn(),
    submitInAppPurchase: vi.fn(async (_c: unknown, id: unknown) => rec("apple.submit", id)),
  };
});
vi.mock("@/lib/iap-management/apple/screenshot-upload", () => ({
  replaceScreenshotOnApple: vi.fn(async (...a: unknown[]) => {
    rec("apple.replaceScreenshot", a.slice(1));
    return { ok: true };
  }),
}));
vi.mock("@/lib/iap-management/apple/availabilities", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/iap-management/apple/availabilities");
  return {
    ...actual,
    getAllTerritoryIds: vi.fn(async () => ["USA", "VNM"]),
    setAvailabilityTerritories: vi.fn(async (_c: unknown, id: unknown, sel: unknown) => rec("apple.setAvailabilityTerritories", { id, sel })),
  };
});
vi.mock("@/lib/iap-management/apple/localization-version-sync", () => ({
  syncLocalizationsToVersion: vi.fn(async (args: { appleIapId: string; desired: unknown }) => {
    rec("apple.syncLocalizationsToVersion", { appleIapId: args.appleIapId, desired: args.desired });
    return { skipped: [], patched: [], created: [], deleted: [], failures: [], versionCreated: false, targetVersionId: "V1" };
  }),
}));
vi.mock("@/lib/iap-management/apple/pricing-orchestration", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/iap-management/apple/pricing-orchestration");
  return {
    ...actual,
    applyPricingSchedule: vi.fn(async (args: Record<string, unknown>) => {
      // Everything the pricing stage is GIVEN (creds / catalog are opaque handles).
      const { creds: _creds, catalog: _catalog, ...given } = args;
      rec("pricing.applyPricingSchedule", given);
      return { kind: "set", price_point_id: "PP", schedule_id: "S", usd_price: args.usdPrice, attempts: 1, source_kind: "APPLE", overridden_territory_count: 0 };
    }),
  };
});
vi.mock("@/lib/iap-management/apple/poll-iap-ready", () => ({
  pollIapReadyForPricing: vi.fn(async () => ({ ready: true, attempts: 1, total_ms: 0 })),
}));
vi.mock("@/lib/iap-management/apple/submit-eligibility", () => ({
  checkSubmitEligibility: vi.fn(async () => {
    throw new Error("not expected: submit is off");
  }),
}));
vi.mock("@/lib/iap-management/apple/batch-price-point-catalog", () => ({
  createBatchPricePointCatalog: vi.fn(() => ({ stats: () => ({ fake: true }) })),
}));
vi.mock("@/lib/iap-management/queries/iaps", () => ({ ensureAppRegistered: vi.fn(async () => "INTERNAL-APP-UUID") }));
vi.mock("@/lib/iap-management/queries/templates", () => ({
  listUsdTiersForSource: vi.fn(async () => [
    { tier_id: "T099", customer_price: 0.99 },
    { tier_id: "T499", customer_price: 4.99 },
  ]),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn(async (...a: unknown[]) => rec("log", a)) }));
vi.mock("@/lib/iap-management/hub-tracking/tracking", () => ({
  finalizeHubTracking: vi.fn(async (...a: unknown[]) => rec("hub.finalize", a)),
}));
vi.mock("@/lib/iap-management/db", () => {
  /** A PostgREST-shaped builder that records the operation and answers
   *  the two reads the route makes. */
  interface Builder {
    select: (...a: unknown[]) => Builder;
    eq: (...a: unknown[]) => Builder;
    single: () => Builder;
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise<unknown>;
  }
  function builder(table: string, op: string, payload: unknown): Builder {
    const r = { table, op, payload, chain: [] as unknown[] };
    rec(`db.${table}.${op}`, r);
    const result = () => {
      if (op === "insert" && table === "import_batches") return { data: { id: "BATCH-1" }, error: null };
      if (op === "select" && table === "iaps") return { data: [{ product_id: "com.vng.gt.exist", tier_id: "T099" }], error: null };
      return { data: null, error: null };
    };
    const b: Builder = {
      select: (...a) => (r.chain.push(["select", ...a]), b),
      eq: (...a) => (r.chain.push(["eq", ...a]), b),
      single: () => (r.chain.push(["single"]), b),
      then: (res, rej) => Promise.resolve(result()).then(res, rej),
    };
    return b;
  }
  return {
    iapDb: () => ({
      from: (table: string) => ({
        select: (...a: unknown[]) => builder(table, "select", a),
        insert: (p: unknown) => builder(table, "insert", p),
        upsert: (p: unknown, o: unknown) => builder(table, "upsert", [p, o]),
        update: (p: unknown) => builder(table, "update", p),
      }),
    }),
  };
});

import { POST } from "./route";
import { appleIapTemplateSpec } from "@/lib/iap-management/parsers/template-spec";
import { buildTemplateWorkbook } from "@/lib/xlsx-template";

type Gt = { price: unknown; currency: unknown } | "ABSENT";

/** The real generated template (2 locales) plus two products: one NEW
 *  (CREATE) and one that already exists on "Apple" (OVERWRITE). */
function excel(gt: Gt): File {
  const spec = appleIapTemplateSpec(["Vietnamese", "English (U.S.)"]);
  let headers = [...spec.headers];
  const product = (pid: string, ref: string, usd: number, vi: [string, string]) => {
    const row: (string | number)[] = headers.map(() => "");
    row[headers.indexOf("Product ID")] = pid;
    row[headers.indexOf("Reference Name")] = ref;
    row[headers.indexOf("Type")] = "CONSUMABLE";
    row[headers.indexOf("Price (USD)")] = usd;
    if (gt !== "ABSENT") {
      row[headers.indexOf("GT Price")] = gt.price as string | number;
      row[headers.indexOf("GT Currency")] = gt.currency as string | number;
    }
    row[headers.indexOf("Display Name (Vietnamese)")] = vi[0];
    row[headers.indexOf("Description (Vietnamese)")] = vi[1];
    return row;
  };
  let dataRows: (string | number)[][] = [
    ...spec.dataRows.map((r) => [...r]),
    product("com.vng.gt.new", "GT new", 0.99, ["Moi", "Mo ta moi"]),
    product("com.vng.gt.exist", "GT exist", 4.99, ["Cu", "Mo ta cu"]),
  ];
  if (gt === "ABSENT") {
    const keep = headers.map((h, i) => (h === "GT Price" || h === "GT Currency" ? -1 : i)).filter((i) => i >= 0);
    headers = keep.map((i) => headers[i]);
    dataRows = dataRows.map((r) => (r.length === 0 ? [] : keep.map((i) => r[i] ?? "")));
  }
  const wb = buildTemplateWorkbook(XLSX, { ...spec, headers, dataRows });
  return new File([XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer], "gt.xlsx");
}

async function run(gt: Gt) {
  CAP.calls.length = 0;
  const fd = new FormData();
  fd.append("excel", excel(gt));
  fd.append(
    "config",
    JSON.stringify({
      default_mode: "OVERWRITE",
      pricing_source: "APPLE",
      availability_selection: { territoryIds: ["USA", "VNM"], availableInNewTerritories: false },
    }),
  );
  fd.append("hub_run_id", "RUN-GT");
  const res = await POST(
    new Request("http://localhost/api/iap-management/apps/999/bulk-import/execute", { method: "POST", body: fd }),
    { params: { appId: "999" } },
  );
  const body = await res.json();
  // The only time-dependent values.
  const text = JSON.stringify({ status: res.status, body, calls: CAP.calls }).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
    "<ISO>",
  );
  return { text, out: JSON.parse(text) as { status: number; body: unknown; calls: Array<[string, unknown]> } };
}
const names = (calls: Array<[string, unknown]>) => calls.map(([n]) => n);
const writes = (calls: Array<[string, unknown]>) =>
  names(calls).filter((n) => n.startsWith("apple.") || /^db\..*\.(insert|upsert|update)$/.test(n) || n.startsWith("pricing."));

describe("the execute route with GT still in the file", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));

  it("R1 GT never reaches Apple, the DB or the audit: every kind of GT ⇒ the SAME recorded calls as an empty GT", async () => {
    const empty = await run({ price: "", currency: "" });
    expect(empty.out.status).toBe(200);
    // Not vacuous: the batch really creates, overwrites, prices and writes.
    expect(writes(empty.out.calls)).toEqual(
      expect.arrayContaining([
        "apple.createInAppPurchase",
        "apple.updateInAppPurchase",
        "pricing.applyPricingSchedule",
        "db.iaps.upsert",
        "db.actions_log.insert",
        "db.import_batches.insert",
      ]),
    );
    for (const gt of [
      { price: 23000, currency: "VND" },
      { price: -5, currency: "zzz" },
      { price: "1,99", currency: "VND" },
      "ABSENT",
    ] as const) {
      const other = await run(gt);
      expect(other.text, JSON.stringify(gt)).toBe(empty.text);
    }
    const filled = await run({ price: 987654.321, currency: "ZQXCUR" });
    expect(filled.text).toBe(empty.text);
    expect(filled.text).not.toMatch(/987654|ZQXCUR|base_price|base_currency/);
  }, 60_000);

  it("R2 a GT Price that is not a number is ACCEPTED: the batch runs exactly like a file without GT (sends to Apple, writes the DB)", async () => {
    const noGt = await run("ABSENT");
    expect(noGt.out.status).toBe(200);
    for (const price of ["abc", "23 000", true]) {
      const junk = await run({ price, currency: "VND" });
      expect(junk.text, String(price)).toBe(noGt.text);
    }
    // …and it really is a full batch, not an early exit.
    expect(writes(noGt.out.calls)).toEqual(expect.arrayContaining(["apple.createInAppPurchase", "db.iaps.upsert", "db.actions_log.insert"]));
    expect(noGt.out.calls.filter(([n]) => n === "hub.finalize").map(([, a]) => (a as unknown[])[1])).not.toContain("FAILED");
  }, 30_000);
});
