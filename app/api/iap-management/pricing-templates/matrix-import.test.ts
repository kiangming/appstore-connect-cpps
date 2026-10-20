/**
 * PA2.2 — importing an "Export for editing" file (Manager 2026-10-19, §L2.9).
 *
 * ⭐ BÀI SỐ MỘT: export for editing → import the file untouched ⇒ the
 *   template's ENTRY SET does not change (Q-A: key, currency, price). Run end
 *   to end on REAL Postgres (PGlite) with the real 16 625-price template: the
 *   real export route writes the file, the real upload route reads it and the
 *   REAL replaceTemplate writes it. Proceeds become NULL (Q-G, accepted).
 *
 * And: preview is display-only; an edited file is written exactly; wrong
 * scope ⇒ 409, nothing written; each file only through its own door; the
 * gates are format A's; a write that breaks part-way says so and the same
 * file repairs it.
 *
 * Mocked seams: session, active account, account list, logger, Apple's app
 * lookup (asserted NEVER called).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import ExcelJS from "exceljs";

import {
  createPgIapDb,
  loadRealTemplateFile,
  type PgIapDb,
  type RealTemplateFile,
} from "@/lib/iap-management/queries/pglite-iap-db.test-helper";

const ACCT_A = { id: "acct-a", name: "Account A" };
const ACCT_B = { id: "acct-b", name: "Account B" };
const APP_X = { id: "app-x", bundle_id: "com.vng.x", name: "App X" };
const APP_Y = { id: "app-y", bundle_id: "com.vng.y", name: "App Y" };

const session = vi.hoisted(() => ({ role: "admin" as "admin" | "member" }));
const IapUnauthorizedError = vi.hoisted(
  () =>
    class extends Error {
      constructor() {
        super("Unauthorized");
      }
    },
);
vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession: vi.fn(async () => ({ user: { email: "manager@example.test", role: session.role } })),
  IapUnauthorizedError,
}));
const activeAccount = vi.hoisted(() => ({ id: "acct-a", name: "Account A" }));
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount: vi.fn(async () => ({ ...activeAccount })) }));
vi.mock("@/lib/asc-account-repository", () => ({
  findAllAccounts: vi.fn(),
  findAllAccountsPublic: vi.fn(async () => [
    { id: "acct-a", name: "Account A" },
    { id: "acct-b", name: "Account B" },
  ]),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
const getApp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-client", () => ({ getApp }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));

import { POST as exportPOST } from "./matrix-export/route";
import { POST as uploadPOST } from "./route";
import { fetchDefaultMatrix, fetchPerAppMatrix } from "@/lib/iap-management/queries/template-matrix";

let h: PgIapDb;
let file: RealTemplateFile;

type Entry = { tier_id: string; territory_code: string; currency_code: string; customer_price: string; proceeds: string | null };

async function entriesOf(scope: { account: string } | { app: string }): Promise<Entry[]> {
  const where = "account" in scope ? "scope_type = 'ACCOUNT' and scope_account_id = $1" : "scope_type = 'APP' and scope_app_id = $1";
  const r = await h.pg.query<Entry>(
    `select e.tier_id, e.territory_code, e.currency_code, e.customer_price::text as customer_price, e.proceeds::text as proceeds
       from iap_mgmt.price_tier_template_entries e join iap_mgmt.price_tier_templates t on t.id = e.template_id
      where ${where} order by 1, 2`,
    ["account" in scope ? scope.account : scope.app],
  );
  return r.rows;
}
async function templateIdOf(scope: { account: string } | { app: string }): Promise<string | null> {
  const r = await h.pg.query<{ id: string }>(
    "account" in scope
      ? "select id from iap_mgmt.price_tier_templates where scope_type = 'ACCOUNT' and scope_account_id = $1"
      : "select id from iap_mgmt.price_tier_templates where scope_type = 'APP' and scope_app_id = $1",
    ["account" in scope ? scope.account : scope.app],
  );
  return r.rows[0]?.id ?? null;
}
async function batchCount(): Promise<number> {
  return (await h.pg.query<{ n: number }>("select count(*)::int as n from iap_mgmt.import_batches")).rows[0].n;
}
/** The Q-A comparison: key, currency, price at NUMERIC(18,4). */
const entrySet = (es: Entry[]) =>
  es.map((e) => `${e.tier_id}|${e.territory_code}|${e.currency_code}|${Math.round(Number(e.customer_price) * 1e4)}`).sort();

async function exportForEditing(body: Record<string, unknown>, as: { id: string; name: string } = ACCT_A): Promise<Uint8Array<ArrayBuffer>> {
  Object.assign(activeAccount, as);
  const res = await exportPOST(
    new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A Default is exported from ITS page, which states the account (PA2.3).
      body: JSON.stringify({ ...body, ...(body.scope === "default" ? { accountId: as.id } : {}), mode: "edit" }),
    }),
  );
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function editBytes(bytes: Uint8Array<ArrayBuffer>, edit: (ws: ExcelJS.Worksheet) => void): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer);
  edit(wb.worksheets[0]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function upload(bytes: Uint8Array<ArrayBuffer>, fields: Record<string, string>): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([bytes], "template-for-editing.xlsx"));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return uploadPOST(new Request("http://localhost/api/iap-management/pricing-templates", { method: "POST", body: fd }));
}

/** Territory column (price half, 1-based) of `code` in the sheet's header row. */
function priceColumn(ws: ExcelJS.Worksheet, code: string): number {
  const row = ws.getRow(1);
  for (let c = 2; c <= row.cellCount; c += 2) if (String(row.getCell(c).value).includes(`(${code}_`)) return c;
  throw new Error(`no column for ${code}`);
}
function tierRow(ws: ExcelJS.Worksheet, name: string): number {
  for (let r = 3; r <= ws.rowCount; r += 1) if (ws.getCell(r, 1).value === name) return r;
  throw new Error(`no row for ${name}`);
}

const perAppSeed = () => {
  const codes = file.territoryOrder.slice(0, 4);
  return file.entries.filter(
    (e) => ["TIER_1", "TIER_2", "TIER_10"].includes(e.tier_id) && codes.includes(e.territory_code) &&
      !(e.tier_id === "TIER_2" && e.territory_code === codes[1]),
  );
};

beforeAll(async () => {
  file = await loadRealTemplateFile();
  h = await createPgIapDb();
  await h.insertTiers(file.parsed.tiers);
  await h.insertApp(APP_X);
  await h.insertApp(APP_Y);
  dbHolder.current = h.db;
}, 60_000);

beforeEach(async () => {
  h.resetKnobs();
  session.role = "admin";
  getApp.mockReset();
  Object.assign(activeAccount, ACCT_A);
  // Fresh templates every test: A = the real 16 625; B = a different small one; X/Y Per-App.
  await h.pg.exec("delete from iap_mgmt.price_tier_templates; delete from iap_mgmt.actions_log; delete from iap_mgmt.import_batches;");
  await h.insertTemplate(file.entries, { account: ACCT_A.id });
  await h.insertTemplate(perAppSeed().map((e) => ({ ...e, customer_price: Number(e.customer_price) + 1 })), { account: ACCT_B.id });
  await h.insertTemplate(perAppSeed(), { app: APP_X.id });
  await h.insertTemplate(perAppSeed(), { app: APP_Y.id });
}, 60_000);

describe("⭐ BÀI SỐ MỘT — export for editing, import untouched ⇒ the entry set does not change", () => {
  it("I1 Default, the real 16 625 prices: same entries; proceeds NULL (Q-G); written anyway (Q-F); audit tag matrix-edit-v1", async () => {
    const before = await entriesOf({ account: ACCT_A.id });
    const idBefore = await templateIdOf({ account: ACCT_A.id });
    expect(before).toHaveLength(16_625);
    expect(before.some((e) => e.proceeds !== null)).toBe(true);

    const bytes = await exportForEditing({ scope: "default" });
    const res = await upload(bytes, { intent: "commit", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; inserted_entry_count: number; totals: Record<string, number> };
    expect(body).toMatchObject({ kind: "commit", inserted_entry_count: 16_625 });
    expect(body.totals).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 16_625, proceedsCleared: 16_625 });

    const after = await entriesOf({ account: ACCT_A.id });
    expect(entrySet(after)).toEqual(entrySet(before));
    expect(after.every((e) => e.proceeds === null)).toBe(true);
    expect(await templateIdOf({ account: ACCT_A.id })).not.toBe(idBefore);
    const batch = await h.pg.query<{ template_version: string; status: string }>(
      "select template_version, status from iap_mgmt.import_batches",
    );
    expect(batch.rows).toEqual([{ template_version: "matrix-edit-v1", status: "COMPLETE" }]);
  });

  it("I2 Per-App (sparse, with a hole): same entries", async () => {
    const before = await entriesOf({ app: APP_X.id });
    const bytes = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const res = await upload(bytes, { intent: "commit", scope: "APP", app_id: APP_X.id });
    expect(res.status).toBe(200);
    expect(entrySet(await entriesOf({ app: APP_X.id }))).toEqual(entrySet(before));
  });
});

describe("PA2.2 — preview shows, commit writes exactly the file", () => {
  it("I3 preview of the untouched file: 0 added / changed / removed, everything unchanged — and NOTHING is written", async () => {
    const idBefore = await templateIdOf({ account: ACCT_A.id });
    const bytes = await exportForEditing({ scope: "default" });
    const res = await upload(bytes, { intent: "preview", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; totals: Record<string, number>; changes: unknown[]; target: unknown };
    expect(body.kind).toBe("preview");
    expect(body.totals).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 16_625 });
    expect(body.changes).toEqual([]);
    expect(body.target).toEqual({ kind: "ACCOUNT", accountId: ACCT_A.id, accountName: ACCT_A.name });
    expect(await templateIdOf({ account: ACCT_A.id })).toBe(idBefore);
    expect(await batchCount()).toBe(0);
  });

  it("I4 an edited file: preview names each change; commit makes the template EXACTLY the file", async () => {
    const original = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const codes = file.territoryOrder.slice(0, 4);
    const edited = await editBytes(original, (ws) => {
      ws.getCell(tierRow(ws, "Tier 2"), priceColumn(ws, codes[1])).value = 777; // "·" → new override
      ws.getCell(tierRow(ws, "Tier 1"), priceColumn(ws, codes[0])).value = 1.49; // change
      ws.getCell(tierRow(ws, "Tier 10"), priceColumn(ws, codes[2])).value = null; // clear (Currency left)
      ws.spliceColumns(priceColumn(ws, codes[3]), 2); // a whole territory removed
    });
    const preview = (await (await upload(edited, { intent: "preview", scope: "APP", app_id: APP_X.id })).json()) as {
      totals: Record<string, number>;
      changes: Array<{ kind: string; tier_id: string; territory_code: string; removedBecause?: string; after: { currency: string } | null }>;
    };
    expect(preview.totals).toMatchObject({ added: 1, changed: 1, removedCleared: 1, removedColumnAbsent: 3 });
    expect(preview.changes.find((c) => c.kind === "added")).toMatchObject({ tier_id: "TIER_2", territory_code: codes[1] });

    const res = await upload(edited, { intent: "commit", scope: "APP", app_id: APP_X.id });
    expect(res.status).toBe(200);
    const after = new Map((await entriesOf({ app: APP_X.id })).map((e) => [`${e.tier_id}|${e.territory_code}`, e]));
    expect(Number(after.get(`TIER_2|${codes[1]}`)?.customer_price)).toBe(777);
    expect(after.get(`TIER_2|${codes[1]}`)?.currency_code).toBe(file.entries.find((e) => e.territory_code === codes[1])!.currency_code);
    expect(Number(after.get(`TIER_1|${codes[0]}`)?.customer_price)).toBe(1.49);
    expect(after.has(`TIER_10|${codes[2]}`)).toBe(false);
    expect([...after.keys()].some((k) => k.endsWith(`|${codes[3]}`))).toBe(false);
  });

  it("I5 the USA column: a changed USA cell and a missing USA column are flagged in the preview", async () => {
    const original = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const changed = await editBytes(original, (ws) => { ws.getCell(tierRow(ws, "Tier 1"), priceColumn(ws, "USA")).value = 1.29; });
    const p1 = (await (await upload(changed, { intent: "preview", scope: "APP", app_id: APP_X.id })).json()) as { warnings: Record<string, unknown> };
    expect(p1.warnings).toMatchObject({ usaChanges: 1, usaColumnMissing: false, usaCurrencyNotUsd: false });
    const noUsa = await editBytes(original, (ws) => ws.spliceColumns(priceColumn(ws, "USA"), 2));
    const p2 = (await (await upload(noUsa, { intent: "preview", scope: "APP", app_id: APP_X.id })).json()) as { warnings: Record<string, unknown> };
    expect(p2.warnings).toMatchObject({ usaColumnMissing: true });
  });
});

describe("PA2.2 — Q-E: the file must belong to the template it is imported into", () => {
  it("I6 account A's file on account B's page ⇒ 409 naming BOTH, nothing written", async () => {
    const before = entrySet(await entriesOf({ account: ACCT_B.id }));
    const bytes = await exportForEditing({ scope: "default" }, ACCT_A);
    const res = await upload(bytes, { intent: "commit", scope: "ACCOUNT", account_id: ACCT_B.id });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("SCOPE_MISMATCH");
    expect(body.error).toMatch(/This file is the Default template of account Account A \(acct-a\); this page is the Default template of account Account B \(acct-b\)\. Nothing was written\./);
    expect(entrySet(await entriesOf({ account: ACCT_B.id }))).toEqual(before);
    expect(await batchCount()).toBe(0);
  });

  it("I7 a Per-App file into a Default, and app X's file into app Y ⇒ 409, nothing written", async () => {
    const x = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const intoDefault = await upload(x, { intent: "commit", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(intoDefault.status).toBe(409);
    expect(((await intoDefault.json()) as { error: string }).error).toMatch(/This file is the Per-App template of App X \(com\.vng\.x\)/);
    const intoY = await upload(x, { intent: "commit", scope: "APP", app_id: APP_Y.id });
    expect(intoY.status).toBe(409);
    expect(((await intoY.json()) as { error: string }).error).toMatch(/this page is the Per-App template of App Y \(com\.vng\.y\)/);
    expect(await batchCount()).toBe(0);
  });
});

describe("PA2.2 — each file through its own door; format A's gates", () => {
  it("I8 a format-A file sent as a matrix import ⇒ 422 'upload in Settings' (the door, before the reader)", async () => {
    const res = await upload(new Uint8Array(file.bytes), { intent: "preview", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("NOT_EDIT_FILE");
    // The DOOR's wording (the reader would also refuse, with its own words —
    // two layers; this pins the first).
    expect(body.error).toMatch(
      /an edited matrix is imported from a file made with "Export for editing"\. Nothing was written\./,
    );
  });

  it("I9 a VIEW export sent as a matrix import ⇒ 422 (never imported)", async () => {
    Object.assign(activeAccount, ACCT_A);
    const view = await exportPOST(
      new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "default", territories: file.territoryOrder, showDiff: false }),
      }),
    );
    const res = await upload(new Uint8Array(await view.arrayBuffer()), { intent: "commit", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(422);
    expect(await batchCount()).toBe(0);
  });

  it("I10 an edit file sent to a Settings upload button (no intent) ⇒ 409 'use Import on the matrix view', nothing written", async () => {
    const bytes = await exportForEditing({ scope: "default" });
    const res = await upload(bytes, { scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("EDIT_FILE_USE_MATRIX_VIEW");
    expect(await batchCount()).toBe(0);
  });

  it("I11 a member cannot import into a Default (403 — format A's gate); a Per-App import never takes the Apple path", async () => {
    const bytes = await exportForEditing({ scope: "default" });
    session.role = "member";
    const res = await upload(bytes, { intent: "preview", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(res.status).toBe(403);
    const x = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const appleOnly = await upload(x, { intent: "preview", scope: "APP", apple_app_id: "123456" });
    expect(appleOnly.status).toBe(400);
    expect(getApp).not.toHaveBeenCalled();
  });

  it("I11b a MEMBER imports into a Per-App: preview 200 and commit 200, the template written (open to members, like a Per-App upload)", async () => {
    const original = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const edited = await editBytes(original, (ws) => {
      ws.getCell(tierRow(ws, "Tier 1"), priceColumn(ws, "USA")).value = 0.89;
    });
    session.role = "member";
    const preview = await upload(edited, { intent: "preview", scope: "APP", app_id: APP_X.id });
    expect(preview.status).toBe(200);
    const commit = await upload(edited, { intent: "commit", scope: "APP", app_id: APP_X.id });
    expect(commit.status).toBe(200);
    const usaTier1 = (await entriesOf({ app: APP_X.id })).find((e) => e.tier_id === "TIER_1" && e.territory_code === "USA");
    expect(Number(usaTier1?.customer_price)).toBe(0.89);
  });

  it("I12 a reader refusal comes back as 422 with every problem's cell", async () => {
    const original = await exportForEditing({ scope: "per-app", appId: APP_X.id });
    const bad = await editBytes(original, (ws) => {
      ws.getCell(tierRow(ws, "Tier 1"), 1).value = "Tier 05";
      ws.getCell(tierRow(ws, "Tier 2"), priceColumn(ws, "USA")).value = -3;
    });
    const res = await upload(bad, { intent: "preview", scope: "APP", app_id: APP_X.id });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; problems: Array<{ cell: string }> };
    expect(body.code).toBe("INVALID_FILE");
    expect(body.problems.map((p) => p.cell)).toEqual(["A3", "B4"]);
  });
});

describe("PA2.2 — a write that breaks part-way", () => {
  it("I13 says the template may be partial — and importing the same file again repairs it exactly", async () => {
    const before = entrySet(await entriesOf({ account: ACCT_A.id }));
    const bytes = await exportForEditing({ scope: "default" });
    h.knobs.failEntriesInsertAt = 5; // after the old template is deleted
    const broken = await upload(bytes, { intent: "commit", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(broken.status).toBe(500);
    const body = (await broken.json()) as { error: string; code: string };
    expect(body.code).toBe("WRITE_FAILED");
    expect(body.error).toMatch(/The template may be partially written — import the same file again/);
    expect((await entriesOf({ account: ACCT_A.id })).length).toBe(5_000);

    h.knobs.failEntriesInsertAt = null;
    const again = await upload(bytes, { intent: "commit", scope: "ACCOUNT", account_id: ACCT_A.id });
    expect(again.status).toBe(200);
    expect(entrySet(await entriesOf({ account: ACCT_A.id }))).toEqual(before);
  });

  it("I13b broken at the FIRST batch (every Per-App, a Default too): the page goes empty, Settings refuses the file — the matrix import, which the empty page now has, repairs it", async () => {
    const cases: Array<{
      exportBody: Record<string, unknown>;
      fields: Record<string, string>;
      where: { account: string } | { app: string };
      page: () => Promise<unknown>;
    }> = [
      { exportBody: { scope: "per-app", appId: APP_X.id }, fields: { scope: "APP", app_id: APP_X.id }, where: { app: APP_X.id }, page: () => fetchPerAppMatrix(APP_X.id, ACCT_A.id) },
      { exportBody: { scope: "default" }, fields: { scope: "ACCOUNT", account_id: ACCT_A.id }, where: { account: ACCT_A.id }, page: () => fetchDefaultMatrix(ACCT_A.id) },
    ];
    for (const s of cases) {
      const before = entrySet(await entriesOf(s.where));
      const bytes = await exportForEditing(s.exportBody);
      h.resetKnobs(); // the insert counter restarts: 0 = this commit's first batch
      h.knobs.failEntriesInsertAt = 0;
      const broken = await upload(bytes, { intent: "commit", ...s.fields });
      expect(broken.status).toBe(500);
      h.knobs.failEntriesInsertAt = null;
      expect(await s.page()).toBeNull(); // the matrix page shows its empty state
      const settings = await upload(bytes, { ...s.fields }); // the Settings door (no intent)
      expect(settings.status).toBe(409);
      const again = await upload(bytes, { intent: "commit", ...s.fields }); // the empty page's import
      expect(again.status).toBe(200);
      expect(entrySet(await entriesOf(s.where))).toEqual(before);
    }
  });
});
