/**
 * PA2.0 — [TEMPLATE-xlsx-reimport] pins of TODAY, before "Export for editing"
 * and its import exist (design-template-matrix-reimport.md §L2, Manager
 * 2026-10-19/20).
 *
 * What PA2 must KEEP, pinned here so a later chunk cannot drift it silently:
 *   B0.3  format A upload: what reaches replaceTemplate for the real Manager
 *         file — byte-pinned (parity: A does not change).
 *   B0.4  the VIEW export ("Export XLSX"): byte-pinned XML parts. PA2.1 adds
 *         an edit mode beside it; the view file must stay identical.
 *   B0.5  the view export is a snapshot of the SCREEN — it follows the
 *         client's territory list (R1), and its 409 guard is one-directional
 *         (R1b). Correct for a file to READ; the reason the Manager decided a
 *         SEPARATE edit export (Q-B), which PA2.1 pins the opposite way.
 * What PA2 must CHANGE, pinned as today so the change is visible:
 *   B0.1/2  a matrix export uploaded back is refused (parser A wants sheet
 *         `price_tiers`) and nothing is written. The VIEW export stays refused
 *         forever; the edit export (PA2.2) is what becomes importable.
 *
 * Real Postgres (PGlite) holds the real 16 625-entry template; the export
 * route, the composer, the writer, the upload route and parser A all run for
 * real. Mocked seams: session, active account, account list, logger, the
 * Apple app lookup — and replaceTemplate as a spy (it is the write; these
 * pins are about what reaches it, or that nothing does).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPgIapDb,
  loadRealTemplateFile,
  type PgIapDb,
  type RealTemplateFile,
} from "@/lib/iap-management/queries/pglite-iap-db.test-helper";

const ACCOUNT = { id: "acct-pa2", name: "PA2 Test Account" };
const APP = { id: "app-pa2", bundle_id: "com.vng.pa2", name: "PA2 App" };

const requireIapSession = vi.hoisted(() => vi.fn());
const IapUnauthorizedError = vi.hoisted(
  () =>
    class extends Error {
      constructor() {
        super("Unauthorized");
      }
    },
);
vi.mock("@/lib/iap-management/auth", () => ({ requireIapSession, IapUnauthorizedError }));
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ id: "acct-pa2", name: "PA2 Test Account" })),
}));
vi.mock("@/lib/asc-account-repository", () => ({
  findAllAccounts: vi.fn(),
  findAllAccountsPublic: vi.fn(async () => [{ id: "acct-pa2", name: "PA2 Test Account" }]),
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/iap-management/queries/iaps", async () => ({
  // getAppIdentity runs for real (on PGlite): both routes look the app up through it.
  ...(await vi.importActual<typeof import("@/lib/iap-management/queries/iaps")>("@/lib/iap-management/queries/iaps")),
  ensureAppRegistered: vi.fn(),
}));
vi.mock("@/lib/asc-client", () => ({ getApp: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));
const replaceTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/templates", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/queries/templates")>(
    "@/lib/iap-management/queries/templates",
  );
  return { ...actual, replaceTemplate };
});

import { POST as exportPOST } from "./matrix-export/route";
import { POST as uploadPOST } from "./route";

let h: PgIapDb;
let file: RealTemplateFile;
let defaultTemplateId: string;

function exportRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function uploadRequest(bytes: Uint8Array<ArrayBuffer>, name: string, fields: Record<string, string>): Request {
  const fd = new FormData();
  fd.append("file", new File([bytes], name));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/api/iap-management/pricing-templates", { method: "POST", body: fd });
}

/** Unzip one part of an .xlsx — bytes on disk, not the exceljs model. */
function part(bytes: Uint8Array, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pa2-"));
  const p = join(dir, "f.xlsx");
  writeFileSync(p, bytes);
  try {
    return execFileSync("unzip", ["-p", p, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

async function exportBytes(body: Record<string, unknown>): Promise<Uint8Array<ArrayBuffer>> {
  const res = await exportPOST(exportRequest(body));
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** A small Per-App template: 3 tiers × 4 territories of the real file, two
 *  prices changed so the Default diff (showDiff) has something to mark. */
function perAppEntries() {
  const codes = file.territoryOrder.slice(0, 4);
  const tiers = ["TIER_1", "TIER_2", "TIER_10"];
  return file.entries
    .filter((e) => tiers.includes(e.tier_id) && codes.includes(e.territory_code))
    .map((e, i) => (i === 1 || i === 5 ? { ...e, customer_price: Number(e.customer_price) * 2 } : e));
}

beforeAll(async () => {
  file = await loadRealTemplateFile();
  h = await createPgIapDb();
  await h.insertTiers(file.parsed.tiers);
  defaultTemplateId = await h.insertTemplate(file.entries, { account: ACCOUNT.id });
  await h.insertApp(APP);
  await h.insertTemplate(perAppEntries(), { app: APP.id });
  dbHolder.current = h.db;
}, 60_000);

beforeEach(() => {
  h.resetKnobs();
  replaceTemplate.mockReset();
  requireIapSession.mockResolvedValue({ user: { email: "manager@example.test", role: "admin" } });
});

async function templateState(id: string) {
  const header = await h.pg.query("select id from iap_mgmt.price_tier_templates where id = $1", [id]);
  const n = await h.pg.query<{ n: number }>(
    "select count(*)::int as n from iap_mgmt.price_tier_template_entries where template_id = $1",
    [id],
  );
  return { exists: header.rows.length === 1, entries: n.rows[0].n };
}

describe("PA2.0 — today: a matrix export cannot be imported back (and nothing is written)", () => {
  it("B0.1 Default: export → upload ⇒ 422 'Expected sheet \"price_tiers\"', replaceTemplate never called, template untouched", async () => {
    const bytes = await exportBytes({ scope: "default", territories: file.territoryOrder, showDiff: false });
    const res = await uploadPOST(
      uploadRequest(bytes, "apple-pricing-template-default.xlsx", { scope: "ACCOUNT", account_id: ACCOUNT.id }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Expected sheet "price_tiers" but found "Default Template"/,
    );
    expect(replaceTemplate).not.toHaveBeenCalled();
    expect(await templateState(defaultTemplateId)).toEqual({ exists: true, entries: 16_625 });
  });

  it("B0.2 Per-App: export → upload ⇒ 422 'found \"Per-App Template\"', replaceTemplate never called", async () => {
    const bytes = await exportBytes({
      scope: "per-app",
      appId: APP.id,
      territories: file.territoryOrder.slice(0, 4),
      showDiff: true,
    });
    const res = await uploadPOST(
      uploadRequest(bytes, "apple-pricing-template-per-app.xlsx", { scope: "APP", app_id: APP.id }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/found "Per-App Template"/);
    expect(replaceTemplate).not.toHaveBeenCalled();
  });
});

describe("PA2.0 — what PA2 must keep", () => {
  it("B0.3 format A parity: the real Manager file reaches replaceTemplate exactly as today (byte-pinned)", async () => {
    replaceTemplate.mockResolvedValue({
      template_id: "new-id",
      scope_type: "ACCOUNT",
      scope_app_id: null,
      scope_account_id: ACCOUNT.id,
      inserted_entry_count: 16_625,
      audit_batch_id: "batch-1",
    });
    const res = await uploadPOST(
      uploadRequest(new Uint8Array(file.bytes), "price-tiers-template.xlsx", { scope: "ACCOUNT", account_id: ACCOUNT.id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier_count: 95, territory_count: 175, warnings: [] });
    expect(replaceTemplate).toHaveBeenCalledTimes(1);
    const [scope, parsed, uploadedBy, filename, ...rest] = replaceTemplate.mock.calls[0];
    expect(scope).toEqual({ kind: "ACCOUNT", account_id: ACCOUNT.id });
    expect(uploadedBy).toBe("manager@example.test");
    expect(filename).toBe("price-tiers-template.xlsx");
    expect(rest).toEqual([]);
    expect(md5(JSON.stringify(parsed))).toBe("e768a4cb6f2c4c73984745a4a2d8fe0e");
  });

  it("B0.4 the VIEW export is byte-pinned (Default, every territory; Per-App with showDiff)", async () => {
    const d = await exportBytes({ scope: "default", territories: file.territoryOrder, showDiff: false });
    const p = await exportBytes({
      scope: "per-app",
      appId: APP.id,
      territories: file.territoryOrder.slice(0, 4),
      showDiff: true,
    });
    const pins = {
      default: {
        sheet: md5(part(d, "xl/worksheets/sheet1.xml")),
        strings: md5(part(d, "xl/sharedStrings.xml")),
        styles: md5(part(d, "xl/styles.xml")),
        workbook: md5(part(d, "xl/workbook.xml")),
      },
      perApp: {
        sheet: md5(part(p, "xl/worksheets/sheet1.xml")),
        strings: md5(part(p, "xl/sharedStrings.xml")),
        styles: md5(part(p, "xl/styles.xml")),
        workbook: md5(part(p, "xl/workbook.xml")),
        comments: md5(part(p, "xl/comments1.xml")),
      },
    };
    expect(pins).toEqual(PINS_VIEW_EXPORT);
    // One sheet only, today.
    expect(part(d, "xl/workbook.xml").match(/<sheet /g)).toHaveLength(1);
  });

  it("B0.5 the VIEW export follows the screen: a filtered client list ⇒ only those territories; a territory the page never saw ⇒ absent, 200 (R1b — view only)", async () => {
    const two = file.territoryOrder.slice(0, 2);
    const filtered = await exportBytes({ scope: "default", territories: two, showDiff: false });
    expect(part(filtered, "xl/sharedStrings.xml").match(/<si>/g)?.length).toBeLessThan(
      part(await exportBytes({ scope: "default", territories: file.territoryOrder, showDiff: false }), "xl/sharedStrings.xml").match(/<si>/g)!.length,
    );
    const res = await exportPOST(
      exportRequest({ scope: "default", territories: file.territoryOrder.filter((c) => c !== "KOR"), showDiff: false }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Territory-Count")).toBe("174");
    expect((await exportPOST(exportRequest({ scope: "default", territories: two, showDiff: false }))).headers.get(
      "X-Export-Territory-Count",
    )).toBe("2");
  });
});

/** md5 of each XML part of the VIEW export at commit PA2.0 (docProps/core.xml
 *  carries the export time and the ZIP carries mtimes — both excluded). A
 *  change here is a change to the file the Manager reads: deliberate, and
 *  re-pinned with a reason, or a regression. */
const PINS_VIEW_EXPORT = {
  default: {
    sheet: "c2349684086bc4c496d6af987bc4b51d",
    strings: "90daa315c8a39c6ddb314fcd62915f93",
    styles: "3a907b358e480217e8a2cbf4e1f150da",
    workbook: "6c2ae392246b9af9850240d521523579",
  },
  perApp: {
    sheet: "2a6f7a60eead53df40346c631d0468bd",
    strings: "174771363397411cfb948fce49aa55ce",
    styles: "ddf757dd68caad8946cdba7d3423b5d9",
    workbook: "1bef395e675cc3c5d16569d6009e605c",
    comments: "28d7b8c5b3f1018d1389d328bdebe50f",
  },
};
