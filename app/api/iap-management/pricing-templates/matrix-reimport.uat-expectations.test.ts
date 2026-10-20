/**
 * PA2.3 — the Excel UAT expectations hold for the CODE today (Manager Q-S:
 * the team uses Excel). The edits of docs/iap-management/uat/pa2-excel/
 * README.md are applied with exceljs to the committed base files, which are
 * imported through the REAL route on REAL Postgres (PGlite) seeded exactly
 * as when the base files were made (`seedPa2UatFixtures`). The golden test
 * that follows runs the same expectations on the files saved by real Excel.
 *
 * U0 pins the committed base files to what "Export for editing" makes from
 * that seed TODAY — a writer change that would make them stale goes red here,
 * instead of the Manager running UAT on a file the button no longer makes.
 * To regenerate them (after a deliberate writer change):
 *   UAT_REGEN_BASE_FILES=1 npx vitest run app/api/iap-management/pricing-templates/matrix-reimport.uat-expectations.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

import {
  createPgIapDb,
  loadRealTemplateFile,
  seedPa2UatFixtures,
  UAT_ACCOUNT,
  UAT_APP,
  type PgIapDb,
} from "@/lib/iap-management/queries/pglite-iap-db.test-helper";
import {
  F0_EXPECTED,
  F1_EDITS,
  F1_EXPECTED,
  F2_EDITS,
  F2_EXPECTED_PROBLEMS,
  type UatEdit,
} from "@/lib/iap-management/template-reimport/uat-fixtures.test-helper";
import type { MatrixImportPreviewResponse } from "@/lib/iap-management/template-reimport/types";

vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession: vi.fn(async () => ({ user: { email: "uat@example.test", role: "admin" } })),
  IapUnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount: vi.fn(async () => ({ id: "uat-account", name: "UAT Test Account" })) }));
vi.mock("@/lib/asc-account-repository", () => ({
  findAllAccounts: vi.fn(),
  findAllAccountsPublic: vi.fn(async () => [{ id: "uat-account", name: "UAT Test Account" }]),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/asc-client", () => ({ getApp: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));

import { POST as uploadPOST } from "./route";
import { POST as exportPOST } from "./matrix-export/route";
import { EDIT_INFO_SHEET } from "@/lib/iap-management/template-matrix-edit-spec";

const DIR = join(process.cwd(), "docs/iap-management/uat/pa2-excel");
let h: PgIapDb;

beforeAll(async () => {
  const file = await loadRealTemplateFile();
  h = await createPgIapDb();
  await seedPa2UatFixtures(h, file);
  dbHolder.current = h.db;
}, 60_000);
beforeEach(() => h.resetKnobs());

async function edited(name: string, edits: UatEdit[]): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(readFileSync(join(DIR, name))).buffer);
  const ws = wb.worksheets[0];
  for (const e of edits) {
    ws.getCell(e.cell).value = "formula" in e ? ({ formula: e.formula, result: e.result } as ExcelJS.CellFormulaValue) : e.value;
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function upload(bytes: Uint8Array<ArrayBuffer>, intent: "preview" | "commit", fields: Record<string, string>) {
  const fd = new FormData();
  fd.append("file", new File([bytes], "uat.xlsx"));
  fd.append("intent", intent);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return uploadPOST(new Request("http://localhost/api/iap-management/pricing-templates", { method: "POST", body: fd }));
}

const describeChange = (c: MatrixImportPreviewResponse["changes"][number]) =>
  c.kind === "added"
    ? `added ${c.tier_id} ${c.territory_code} → ${c.after!.price} ${c.after!.currency}`
    : c.kind === "changed"
      ? `changed ${c.tier_id} ${c.territory_code} ${c.before!.price} ${c.before!.currency} → ${c.after!.price} ${c.after!.currency}`
      : `removed ${c.tier_id} ${c.territory_code} ${c.before!.price} ${c.before!.currency} (${c.removedBecause})`;

const REGEN = process.env.UAT_REGEN_BASE_FILES === "1";

async function freshExport(body: Record<string, unknown>): Promise<Uint8Array> {
  const res = await exportPOST(
    new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, mode: "edit" }),
    }),
  );
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** Everything a person or the reader sees in the workbook: sheet names and
 *  visibility, merges, and every cell's type, value and number format —
 *  minus the export timestamp, which differs by definition. */
function workbookContent(bytes: Uint8Array) {
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  return {
    sheets: (wb.Workbook?.Sheets ?? []).map((s) => ({ name: s.name, hidden: s.Hidden ?? 0 })),
    cells: wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const cells = Object.keys(ws)
        .filter((k) => !k.startsWith("!"))
        .map((k) => [k, ws[k].t, ws[k].v, ws[k].z ?? null] as const)
        .filter(([, , v], i, all) => !(name === EDIT_INFO_SHEET && i > 0 && all[i - 1][2] === "exported_at" && typeof v === "string"));
      return { name, ref: ws["!ref"], merges: (ws["!merges"] ?? []).map((m) => XLSX.utils.encode_range(m)).sort(), cells };
    }),
  };
}

const entrySet = async (accountId: string) =>
  (
    await h.pg.query<{ k: string; proceeds: string | null }>(
      `select e.tier_id || '|' || e.territory_code || '|' || e.currency_code || '|' || round(e.customer_price * 10000)::bigint as k, e.proceeds::text as proceeds
         from iap_mgmt.price_tier_template_entries e join iap_mgmt.price_tier_templates t on t.id = e.template_id
        where t.scope_type = 'ACCOUNT' and t.scope_account_id = $1 order by 1`,
      [accountId],
    )
  ).rows;

describe("PA2.3 UAT — the base files ARE what Export for editing makes today", () => {
  it.skipIf(REGEN)("U0 F0 / F1 equal a fresh export of the seed (all sheets, cells, formats, merges; only exported_at differs); F2 is F1 byte for byte", async () => {
    const f0 = await freshExport({ scope: "default", accountId: UAT_ACCOUNT.id });
    const f1 = await freshExport({ scope: "per-app", appId: UAT_APP.id });
    expect(workbookContent(new Uint8Array(readFileSync(join(DIR, "F0-default-for-editing.xlsx"))))).toEqual(workbookContent(f0));
    expect(workbookContent(new Uint8Array(readFileSync(join(DIR, "F1-per-app-for-editing.xlsx"))))).toEqual(workbookContent(f1));
    expect(readFileSync(join(DIR, "F2-per-app-for-editing.xlsx")).equals(readFileSync(join(DIR, "F1-per-app-for-editing.xlsx")))).toBe(true);
  });

  it.runIf(REGEN)("REGEN writes the base files from the seed (UAT_REGEN_BASE_FILES=1)", async () => {
    const f1 = await freshExport({ scope: "per-app", appId: UAT_APP.id });
    writeFileSync(join(DIR, "F0-default-for-editing.xlsx"), await freshExport({ scope: "default", accountId: UAT_ACCOUNT.id }));
    writeFileSync(join(DIR, "F1-per-app-for-editing.xlsx"), f1);
    writeFileSync(join(DIR, "F2-per-app-for-editing.xlsx"), f1);
  });
});

describe("PA2.3 UAT expectations — the code produces the table the Manager will check in Excel", () => {
  it("F0 the whole Default, unedited: 0 changes, 16 625 unchanged, the proceeds warning — and the WRITE keeps the entry set", async () => {
    const bytes = new Uint8Array(readFileSync(join(DIR, "F0-default-for-editing.xlsx")));
    const target = { scope: "ACCOUNT", account_id: UAT_ACCOUNT.id };
    const res = await upload(bytes, "preview", target);
    expect(res.status).toBe(200);
    expect(((await res.json()) as MatrixImportPreviewResponse).totals).toMatchObject(F0_EXPECTED.totals);

    const before = await entrySet(UAT_ACCOUNT.id);
    expect(before).toHaveLength(16_625);
    const commit = await upload(bytes, "commit", target);
    expect(commit.status).toBe(200);
    const after = await entrySet(UAT_ACCOUNT.id);
    expect(F0_EXPECTED.afterWrite).toEqual({ entrySet: "unchanged", proceeds: "all empty" });
    expect(after.map((r) => r.k)).toEqual(before.map((r) => r.k));
    expect(after.every((r) => r.proceeds === null)).toBe(true);
  });

  it("F1 valid edits: the preview is exactly the table", async () => {
    const res = await upload(await edited("F1-per-app-for-editing.xlsx", F1_EDITS), "preview", { scope: "APP", app_id: UAT_APP.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MatrixImportPreviewResponse;
    expect(body.totals).toEqual(F1_EXPECTED.totals);
    expect(body.warnings).toEqual(F1_EXPECTED.warnings);
    expect(body.changes.map(describeChange).sort()).toEqual([...F1_EXPECTED.changes].sort());
  });

  it("F2 refused edits: 422, exactly these six problems, in this order", async () => {
    const res = await upload(await edited("F2-per-app-for-editing.xlsx", F2_EDITS), "preview", { scope: "APP", app_id: UAT_APP.id });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; problems: Array<{ cell: string; message: string }> };
    expect(body.error).toMatch(/6 problems\. Nothing was written\./);
    expect(body.problems.map((p) => p.cell)).toEqual(F2_EXPECTED_PROBLEMS.map((p) => p.cell));
    body.problems.forEach((p, i) => expect(p.message).toMatch(F2_EXPECTED_PROBLEMS[i].message));
  });
});
