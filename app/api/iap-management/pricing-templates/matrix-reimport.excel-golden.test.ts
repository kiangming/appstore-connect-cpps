/**
 * PA2 — GOLDEN: the three files the Manager edited and saved with REAL Excel
 * (Microsoft Excel for Mac 16, 2026-10-20), following
 * docs/iap-management/uat/pa2-excel/README.md. Read as saved — never
 * re-saved by exceljs — and imported through the REAL route on REAL Postgres
 * (PGlite), seeded exactly as when the base files were made
 * (`seedPa2UatFixtures`).
 *
 * The expectations are the ones written BEFORE the Manager touched Excel
 * (uat-fixtures.test-helper.ts — the same constants the exceljs simulation in
 * matrix-reimport.uat-expectations.test.ts checks). This file adds nothing to
 * them except the writes the README also promises: F0 written leaves the
 * entry set as it was; F1 written makes the template exactly the file.
 *
 * Own file, own database: the exceljs simulation writes F0 too, which would
 * empty the proceeds this file's F0 preview counts.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  F1_EXPECTED,
  F2_EXPECTED_PROBLEMS,
} from "@/lib/iap-management/template-reimport/uat-fixtures.test-helper";
import { EDIT_INFO_SHEET } from "@/lib/iap-management/template-matrix-edit-spec";
import type { MatrixImportPreviewResponse } from "@/lib/iap-management/template-reimport/types";

vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession: vi.fn(async () => ({ user: { email: "uat@example.test", role: "admin" } })),
  IapUnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/asc-account-repository", () => ({
  findAllAccounts: vi.fn(),
  findAllAccountsPublic: vi.fn(async () => [{ id: "uat-account", name: "UAT Test Account" }]),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/asc-client", () => ({ getApp: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));

import { POST as uploadPOST } from "./route";

const DIR = join(process.cwd(), "docs/iap-management/uat/pa2-excel");
const FILES = {
  F0: "F0-default-for-editing-excel.xlsx",
  F1: "F1-per-app-for-editing-excel.xlsx",
  F2: "F2-per-app-for-editing-excel.xlsx",
} as const;
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
let h: PgIapDb;

beforeAll(async () => {
  const file = await loadRealTemplateFile();
  h = await createPgIapDb();
  await seedPa2UatFixtures(h, file);
  dbHolder.current = h.db;
}, 60_000);

function upload(bytes: Uint8Array<ArrayBuffer>, intent: "preview" | "commit", fields: Record<string, string>) {
  const fd = new FormData();
  fd.append("file", new File([bytes], "golden.xlsx"));
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
const entriesOf = async (where: "ACCOUNT" | "APP") =>
  (
    await h.pg.query<{ k: string; proceeds: string | null }>(
      `select e.tier_id || '|' || e.territory_code || '|' || e.currency_code || '|' || round(e.customer_price * 10000)::bigint as k, e.proceeds::text as proceeds
         from iap_mgmt.price_tier_template_entries e join iap_mgmt.price_tier_templates t on t.id = e.template_id
        where ${where === "ACCOUNT" ? "t.scope_type = 'ACCOUNT' and t.scope_account_id = $1" : "t.scope_type = 'APP' and t.scope_app_id = $1"}
        order by 1`,
      [where === "ACCOUNT" ? UAT_ACCOUNT.id : UAT_APP.id],
    )
  ).rows;

describe("PA2 golden — the files saved by real Excel", () => {
  it("G0 they ARE Excel saves (not the base files, not an exceljs re-save): Excel's app stamp; the hidden info sheet kept hidden", () => {
    for (const name of Object.values(FILES)) {
      const wb = XLSX.read(bytesOf(name), { type: "array" });
      expect(wb.Props?.Application, name).toMatch(/^Microsoft (Macintosh )?Excel$/);
      expect((wb.Workbook?.Sheets ?? []).map((s) => [s.name, s.Hidden ?? 0]), name).toEqual([
        [wb.SheetNames[0], 0],
        [EDIT_INFO_SHEET, 1],
      ]);
    }
  });

  it("G-F0 untouched in Excel: 0 changes, 16 625 unchanged, the proceeds warning — and the WRITE keeps the entry set (bài số một through Excel)", async () => {
    const target = { scope: "ACCOUNT", account_id: UAT_ACCOUNT.id };
    const preview = await upload(bytesOf(FILES.F0), "preview", target);
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as MatrixImportPreviewResponse).totals).toMatchObject(F0_EXPECTED.totals);

    const before = await entriesOf("ACCOUNT");
    expect(before).toHaveLength(16_625);
    const commit = await upload(bytesOf(FILES.F0), "commit", target);
    expect(commit.status).toBe(200);
    const after = await entriesOf("ACCOUNT");
    expect(F0_EXPECTED.afterWrite).toEqual({ entrySet: "unchanged", proceeds: "all empty" });
    expect(after.map((r) => r.k)).toEqual(before.map((r) => r.k));
    expect(after.every((r) => r.proceeds === null)).toBe(true);
  });

  it("G-F1 the valid edits: the preview is exactly the table; written, the template is exactly the file (23 overrides)", async () => {
    const target = { scope: "APP", app_id: UAT_APP.id };
    const res = await upload(bytesOf(FILES.F1), "preview", target);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MatrixImportPreviewResponse;
    expect(body.totals).toEqual(F1_EXPECTED.totals);
    expect(body.warnings).toEqual(F1_EXPECTED.warnings);
    expect(body.changes.map(describeChange).sort()).toEqual([...F1_EXPECTED.changes].sort());

    const before = new Set((await entriesOf("APP")).map((r) => r.k));
    const commit = await upload(bytesOf(FILES.F1), "commit", target);
    expect(commit.status).toBe(200);
    expect(((await commit.json()) as { inserted_entry_count: number }).inserted_entry_count).toBe(F1_EXPECTED.totals.after);
    const after = new Set((await entriesOf("APP")).map((r) => r.k));
    const added = [...after].filter((k) => !before.has(k)).sort();
    const gone = [...before].filter((k) => !after.has(k)).sort();
    // The five edits, at NUMERIC(18,4): new 39 THB and 1500 JPY, 22000 VND and 8.99 USD replacing 25000 / 9.99, 480 JPY gone.
    expect(added).toEqual(["TIER_10|JPN|JPY|15000000", "TIER_10|USA|USD|89900", "TIER_1|VNM|VND|220000000", "TIER_2|THA|THB|390000"]);
    expect(gone).toEqual(["TIER_10|USA|USD|99900", "TIER_1|VNM|VND|250000000", "TIER_3|JPN|JPY|4800000"]);
  });

  it("G-F2 the refused edits: 422, nothing written, exactly the six problems in order", async () => {
    const before = await entriesOf("APP");
    const res = await upload(bytesOf(FILES.F2), "preview", { scope: "APP", app_id: UAT_APP.id });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; problems: Array<{ cell: string; message: string }> };
    expect(body.error).toMatch(/6 problems\. Nothing was written\./);
    expect(body.problems.map((p) => p.cell)).toEqual(F2_EXPECTED_PROBLEMS.map((p) => p.cell));
    body.problems.forEach((p, i) => expect(p.message).toMatch(F2_EXPECTED_PROBLEMS[i].message));
    const commit = await upload(bytesOf(FILES.F2), "commit", { scope: "APP", app_id: UAT_APP.id });
    expect(commit.status).toBe(422);
    expect(await entriesOf("APP")).toEqual(before);
  });
});
