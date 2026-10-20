/**
 * PA2.1 — "Export for editing" (Manager 2026-10-19: Q-B, Q-C, Q-E;
 * design-template-matrix-reimport.md §L2.9).
 *
 * The file the Manager edits and imports back. Under "the file is the only
 * truth", what is absent from it is REMOVED on import — so it must hold the
 * WHOLE template, whatever the screen filters or the client sends (R1, R1b);
 * every column must say which territory and currency it is (Q-C: `Name
 * (CODE_CUR)`, the same header as format A, read by the same regex); and the
 * file must say which template it belongs to (Q-E: a hidden info sheet).
 *
 * Real Postgres (PGlite) with the real 16 625-entry template; the real route,
 * composer and writer; the file read back with SheetJS (xlsx — the library
 * the PA2.2 reader will use) and by unzipping its XML parts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  createPgIapDb,
  loadRealTemplateFile,
  type PgIapDb,
  type RealTemplateFile,
} from "@/lib/iap-management/queries/pglite-iap-db.test-helper";
import {
  EDIT_FORMAT,
  EDIT_FORMAT_VERSION,
  EDIT_INFO_SHEET,
  TERRITORY_HEADER_RE,
  formatTerritoryHeader,
} from "@/lib/iap-management/template-matrix-edit-spec";
import { APPLE_TERRITORIES_ALPHA3, appleCurrencyFor } from "@/lib/iap-management/apple/apple-territories.snapshot";
import { territoryName } from "@/components/iap-management/view-detail/territory-name";

const ACCOUNT = { id: "acct-edit", name: "Edit Test Account" };
const APP = { id: "app-edit", bundle_id: "com.vng.edit", name: "Edit App" };
const MIXED_APP = { id: "app-mixed", bundle_id: "com.vng.mixed", name: "Mixed App" };
const NOT_APPLE_APP = { id: "app-not-apple", bundle_id: "com.vng.notapple", name: "Not Apple App" };
const BOTH_APP = { id: "app-both", bundle_id: "com.vng.both", name: "Both Problems App" };
const UNSOLD_APP = { id: "app-unsold", bundle_id: "com.vng.unsold", name: "Unsold Territory App" };

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
const activeAccount = vi.hoisted(() => ({ id: "acct-edit", name: "Edit Test Account" }));
vi.mock("@/lib/get-active-account", () => ({
  getActiveAccount: vi.fn(async () => ({ ...activeAccount })),
}));
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn(), findAllAccountsPublic: vi.fn() }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => dbHolder.current }));

import { POST } from "./route";

let h: PgIapDb;
let file: RealTemplateFile;
/** territory → currency, as stored. */
let currencyOf: Map<string, string>;

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function exportOk(body: Record<string, unknown>) {
  const res = await POST(req(body));
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, wb: XLSX.read(bytes, { type: "array" }) };
}

function part(bytes: Uint8Array, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pa21-"));
  const p = join(dir, "f.xlsx");
  writeFileSync(p, bytes);
  return execFileSync("unzip", ["-p", p, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Territory headers of the main sheet, row 1, every second column from B. */
function territoryHeaders(wb: XLSX.WorkBook): string[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws["!ref"]!);
  const out: string[] = [];
  for (let c = 1; c <= range.e.c; c += 2) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    out.push(String(cell?.v ?? ""));
  }
  return out;
}

function infoSheet(wb: XLSX.WorkBook): Record<string, string> {
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[EDIT_INFO_SHEET], { header: 1 });
  expect(rows[0]).toEqual(["key", "value"]);
  return Object.fromEntries(rows.slice(1).map(([k, v]) => [k, v]));
}

beforeAll(async () => {
  file = await loadRealTemplateFile();
  currencyOf = new Map(file.entries.map((e) => [e.territory_code, e.currency_code]));
  h = await createPgIapDb();
  await h.insertTiers(file.parsed.tiers);
  await h.insertTemplate(file.entries, { account: ACCOUNT.id });
  await h.insertApp(APP);
  // Sparse Per-App: 3 tiers × 4 territories, one hole.
  const codes = file.territoryOrder.slice(0, 4);
  await h.insertTemplate(
    file.entries.filter(
      (e) =>
        ["TIER_1", "TIER_2", "TIER_10"].includes(e.tier_id) &&
        codes.includes(e.territory_code) &&
        !(e.tier_id === "TIER_2" && e.territory_code === codes[1]),
    ),
    { app: APP.id },
  );
  // A Per-App whose second territory holds TWO currencies (not producible by
  // format A; reachable by hand-written SQL).
  await h.insertApp(MIXED_APP);
  await h.insertTemplate(
    [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "XKS", currency_code: "EUR", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_2", territory_code: "XKS", currency_code: "USD", customer_price: 1.99, proceeds: null },
    ],
    { app: MIXED_APP.id },
  );
  // A Per-App whose VNM is stored in USD — one currency, but not Apple's.
  await h.insertApp(NOT_APPLE_APP);
  await h.insertTemplate(
    [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "VNM", currency_code: "USD", customer_price: 0.99, proceeds: null },
    ],
    { app: NOT_APPLE_APP.id },
  );
  // Both problems at once: XKS mixed (EUR + USD) AND VNM in USD.
  await h.insertApp(BOTH_APP);
  await h.insertTemplate(
    [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "VNM", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "XKS", currency_code: "EUR", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_2", territory_code: "XKS", currency_code: "USD", customer_price: 1.99, proceeds: null },
    ],
    { app: BOTH_APP.id },
  );
  // A code Apple does not sell in (outside the 175): appleCurrencyFor = null.
  await h.insertApp(UNSOLD_APP);
  await h.insertTemplate(
    [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "XXX", currency_code: "USD", customer_price: 0.99, proceeds: null },
    ],
    { app: UNSOLD_APP.id },
  );
  dbHolder.current = h.db;
}, 60_000);

beforeEach(() => {
  h.resetKnobs();
  Object.assign(activeAccount, ACCOUNT);
  requireIapSession.mockResolvedValue({ user: { email: "manager@example.test", role: "admin" } });
});

describe("PA2.1 — Export for editing: the WHOLE template, whatever the client sends (Q-B, R1, R1b)", () => {
  it("E1 a filtered client list (2 territories) and showDiff are ignored: every territory of the template, server order", async () => {
    const { res, wb } = await exportOk({
      scope: "default",
      accountId: ACCOUNT.id,
      mode: "edit",
      territories: file.territoryOrder.slice(0, 2),
      showDiff: true,
    });
    expect(res.headers.get("X-Export-Mode")).toBe("edit");
    expect(res.headers.get("X-Export-Territory-Count")).toBe("175");
    const codes = territoryHeaders(wb).map((t) => TERRITORY_HEADER_RE.exec(t)?.[2]);
    expect(codes).toEqual(file.territoryOrder);
    expect(res.headers.get("Content-Disposition")).toMatch(/apple-pricing-template-default-for-editing-\d{8}-\d{4}\.xlsx/);
  });

  it("E1b a client list that never saw a territory (R1b) changes nothing: KOR is in the file", async () => {
    const { wb } = await exportOk({
      scope: "default",
      accountId: ACCOUNT.id,
      mode: "edit",
      territories: file.territoryOrder.filter((c) => c !== "KOR"),
      showDiff: false,
    });
    expect(territoryHeaders(wb).some((t) => TERRITORY_HEADER_RE.exec(t)?.[2] === "KOR")).toBe(true);
  });

  it("E1c no territories field at all is fine in edit mode; a bad mode is a 400", async () => {
    await exportOk({ scope: "default", accountId: ACCOUNT.id, mode: "edit" });
    const bad = await POST(req({ scope: "default", mode: "import", territories: ["USA"], showDiff: false }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/"mode" must be "view" or "edit"/);
  });
});

describe("PA2.1 — every column says which territory and currency it is (Q-C)", () => {
  it("E2 headers are `Name (CODE_CUR)`, parse back with format A's regex to the stored code + currency", async () => {
    const { wb } = await exportOk({ scope: "default", accountId: ACCOUNT.id, mode: "edit" });
    const decoded = territoryHeaders(wb).map((t) => {
      const m = TERRITORY_HEADER_RE.exec(t);
      return m ? { code: m[2], currency: m[3] } : null;
    });
    expect(decoded.every((d) => d !== null)).toBe(true);
    expect(decoded.map((d) => `${d!.code}_${d!.currency}`)).toEqual(
      file.territoryOrder.map((c) => `${c}_${currencyOf.get(c)}`),
    );
    expect(territoryHeaders(wb)[0]).toBe(formatTerritoryHeader(territoryName("USA"), "USA", "USD"));
  });

  it("E2b cells: every stored price is in the file as the same number; a Per-App hole is `·` in both halves", async () => {
    const { wb } = await exportOk({ scope: "default", accountId: ACCOUNT.id, mode: "edit" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const tierRow = new Map<string, number>();
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    for (let r = 2; r <= range.e.r; r += 1) tierRow.set(String(ws[XLSX.utils.encode_cell({ r, c: 0 })].v), r);
    const col = new Map(file.territoryOrder.map((c, i) => [c, 1 + i * 2]));
    const nameOf = new Map(file.parsed.tiers.map((t) => [t.tier_id, t.tier_name]));
    const wrong = file.entries.filter((e) => {
      const r = tierRow.get(nameOf.get(e.tier_id)!)!;
      const price = ws[XLSX.utils.encode_cell({ r, c: col.get(e.territory_code)! })]?.v;
      const cur = ws[XLSX.utils.encode_cell({ r, c: col.get(e.territory_code)! + 1 })]?.v;
      return !Object.is(price, Number(e.customer_price)) || cur !== e.currency_code;
    });
    expect(wrong).toEqual([]);

    const p = await exportOk({ scope: "per-app", appId: APP.id, mode: "edit" });
    const pws = p.wb.Sheets[p.wb.SheetNames[0]];
    // TIER_2 row (row index 3), second territory (columns D/E) is the hole.
    expect(pws["A4"].v).toBe("Tier 2");
    expect([pws["D4"].v, pws["E4"].v]).toEqual(["·", "·"]);
  });

  it("E2c the header format round-trips for every one of Apple's 175 territories (names with commas, parentheses, fallback codes)", () => {
    const broken = APPLE_TERRITORIES_ALPHA3.filter((code) => {
      const cur = appleCurrencyFor(code) ?? "USD";
      const m = TERRITORY_HEADER_RE.exec(formatTerritoryHeader(territoryName(code), code, cur));
      return !m || m[2] !== code || m[3] !== cur;
    });
    expect(APPLE_TERRITORIES_ALPHA3).toHaveLength(175);
    expect(broken).toEqual([]);
  });

  it("E2d format A reads its header through the SAME regex (no second copy)", () => {
    const src = readFileSync(join(process.cwd(), "lib/iap-management/parsers/price-tiers.ts"), "utf8");
    expect(src).toMatch(/import \{ TERRITORY_HEADER_RE \} from "\.\.\/template-matrix-edit-spec";/);
    expect(src).not.toMatch(/const TERRITORY_HEADER_RE\s*=/);
  });
});

describe("PA2.1 — the file says which template it belongs to (Q-E)", () => {
  it("E3 Default: a hidden `_import_info` sheet AFTER the main sheet — format, version, account id + name, who, when", async () => {
    const { bytes, wb } = await exportOk({ scope: "default", accountId: ACCOUNT.id, mode: "edit" });
    expect(wb.SheetNames).toEqual(["Default Template", EDIT_INFO_SHEET]);
    expect(part(bytes, "xl/workbook.xml")).toMatch(new RegExp(`<sheet [^>]*name="${EDIT_INFO_SHEET}"[^>]*state="hidden"`));
    const info = infoSheet(wb);
    expect(info).toMatchObject({
      format: EDIT_FORMAT,
      version: EDIT_FORMAT_VERSION,
      scope: "ACCOUNT",
      account_id: ACCOUNT.id,
      account_name: ACCOUNT.name,
      exported_by: "manager@example.test",
    });
    expect(Number.isNaN(Date.parse(info.exported_at))).toBe(false);
    expect(Object.keys(info).sort()).toEqual(
      ["account_id", "account_name", "exported_at", "exported_by", "format", "scope", "version"],
    );
  });

  it("E3b Per-App: scope APP, app id + bundle id + name; no account keys; filename names the app", async () => {
    const { res, wb } = await exportOk({ scope: "per-app", appId: APP.id, mode: "edit" });
    expect(wb.SheetNames).toEqual(["Per-App Template", EDIT_INFO_SHEET]);
    expect(infoSheet(wb)).toMatchObject({ scope: "APP", app_id: APP.id, bundle_id: APP.bundle_id, app_name: APP.name });
    expect(infoSheet(wb)).not.toHaveProperty("account_id");
    expect(res.headers.get("Content-Disposition")).toMatch(/per-app-com\.vng\.edit-for-editing-/);
  });

  it("E3c no credential, no key material in the file — only ids and display names", async () => {
    const { bytes } = await exportOk({ scope: "default", accountId: ACCOUNT.id, mode: "edit" });
    const strings = part(bytes, "xl/sharedStrings.xml");
    expect(strings).not.toMatch(/BEGIN PRIVATE KEY|issuer|keyId/i);
  });
});

describe("PA2.1 — a template the header cannot describe is refused, not guessed", () => {
  it("E5 a territory holding two currencies ⇒ 409 naming it and both currencies; no file", async () => {
    const res = await POST(req({ scope: "per-app", appId: MIXED_APP.id, mode: "edit" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; mixedCurrencyTerritories: string[] };
    expect(body.mixedCurrencyTerritories).toEqual(["XKS"]);
    // …and it says which ONE currency the file would need: Apple's.
    expect(body.error).toMatch(/XKS \(EUR, USD — Apple bills EUR\) hold more than one currency/);
  });

  it("E5e BOTH problems in one template ⇒ ONE 409 listing both (one Settings upload fixes it, not two rounds)", async () => {
    const res = await POST(req({ scope: "per-app", appId: BOTH_APP.id, mode: "edit" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; mixedCurrencyTerritories: string[]; notAppleCurrencyTerritories: string[] };
    expect(body.mixedCurrencyTerritories).toEqual(["XKS"]);
    expect(body.notAppleCurrencyTerritories).toEqual(["VNM"]);
    expect(body.error).toMatch(/XKS \(EUR, USD — Apple bills EUR\) hold more than one currency/);
    expect(body.error).toMatch(/VNM \(USD, Apple bills VND\)/);
  });

  it("E5d a territory Apple does not sell in ⇒ 409 (the import would refuse its header, Q-I) — view export unaffected", async () => {
    const res = await POST(req({ scope: "per-app", appId: UNSOLD_APP.id, mode: "edit" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; notAppleCurrencyTerritories: string[] };
    expect(body.notAppleCurrencyTerritories).toEqual(["XXX"]);
    expect(body.error).toMatch(/XXX \(USD, Apple bills — not a territory Apple sells in\)/);
    const view = await POST(req({ scope: "per-app", appId: UNSOLD_APP.id, territories: ["USA", "XXX"], showDiff: false }));
    expect(view.status).toBe(200);
  });

  it("E5c a territory stored in a currency Apple does not bill it in ⇒ 409 (the import would refuse that header) — view export unaffected", async () => {
    const res = await POST(req({ scope: "per-app", appId: NOT_APPLE_APP.id, mode: "edit" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; notAppleCurrencyTerritories: string[] };
    expect(body.notAppleCurrencyTerritories).toEqual(["VNM"]);
    expect(body.error).toMatch(/VNM \(USD, Apple bills VND\)/);
    const view = await POST(req({ scope: "per-app", appId: NOT_APPLE_APP.id, territories: ["USA", "VNM"], showDiff: false }));
    expect(view.status).toBe(200);
  });

  it("E5b the same template still exports for VIEWING (the screen shows it) — the refusal is edit-only", async () => {
    const res = await POST(req({ scope: "per-app", appId: MIXED_APP.id, territories: ["USA", "XKS"], showDiff: false }));
    expect(res.status).toBe(200);
  });
});

describe("PA2.3 — a Default file for editing is of the account the PAGE shows (review: two tabs)", () => {
  it("E7 the page's account must be stated: missing ⇒ 400; another account than the session's ⇒ 409, no file", async () => {
    const missing = await POST(req({ scope: "default", mode: "edit" }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/"accountId" \(the account this page shows\) is required/);

    // The page was opened on ACCOUNT; another tab has switched the session to B.
    Object.assign(activeAccount, { id: "acct-b", name: "Account B" });
    const res = await POST(req({ scope: "default", accountId: ACCOUNT.id, mode: "edit" }));
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("ACCOUNT_CHANGED");
    expect(body.error).toMatch(/shows the Default template of account acct-edit, but the account selected in the top bar is now Account B \(acct-b\) — reload the page/);
  });

  it("E7b the view export and the Per-App edit export do not need it (Per-App names its app)", async () => {
    Object.assign(activeAccount, { id: "acct-b", name: "Account B" });
    // Passes validation without it and reaches the lookup (B has no Default ⇒ 404).
    const view = await POST(req({ scope: "default", territories: ["USA"], showDiff: false }));
    expect(view.status).toBe(404);
    const perApp = await POST(req({ scope: "per-app", appId: APP.id, mode: "edit" }));
    expect(perApp.status).toBe(200);
  });
});

describe("PA2.3 — ONE app lookup by UUID (Manager 2026-10-20)", () => {
  it("E6 neither the export route nor the upload route queries `apps` itself — both go through getAppIdentity", () => {
    const code = (rel: string) =>
      readFileSync(join(process.cwd(), rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const rel of [
      "app/api/iap-management/pricing-templates/matrix-export/route.ts",
      "app/api/iap-management/pricing-templates/route.ts",
    ]) {
      expect(code(rel), rel).not.toMatch(/\.from\(\s*["']apps["']\s*\)/);
      expect(code(rel), rel).toMatch(/getAppIdentity\(/);
    }
  });
});
