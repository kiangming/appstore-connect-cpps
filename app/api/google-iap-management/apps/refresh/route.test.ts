/**
 * D9 [arc-google-missing-purchase-options] — the apps-list refresh NO LONGER
 * reads AppDetails nor writes an app's currency/language. It used to guess the
 * currency from the Play Console language (zh-TW → TWD) — the value 彈彈英雄
 * carried into a failed import. A newly cached app now starts with both empty.
 *
 * ⚠ The apps repository is NOT mocked: it runs over a fake DB that records
 *   every write. A mocked repository only sees the functions it lists — a
 *   re-introduced writer under a new name (or a try/catch swallowing the
 *   "no such export on the mock" error) stays green. Here ANY write to
 *   google_iap_mgmt.apps is observed, whatever function issues it.
 * ⚠ The fake returns REAL cached rows (one with guessed values, one empty): a
 *   `[]` fixture makes a per-app enrichment loop dead code and the test would
 *   pass for the wrong reason (measured in review: GREEN with Hotfix 4 back).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const listAccounts = vi.hoisted(() => vi.fn());
const getEncryptedCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
  getEncryptedCredentials,
}));

/** Recording fake of googleIapDb(): every write is kept; reads return `rows`. */
const fakeDb = vi.hoisted(() => {
  const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);
  const state = {
    writes: [] as Array<{ table: string; op: string; payload: unknown }>,
    rows: [] as Array<Record<string, unknown>>,
  };
  function from(table: string): unknown {
    let wrote = false;
    let single = false;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const data = wrote
              ? state.rows.slice(0, 1).map((r) => ({ id: r.id }))
              : single
                ? (state.rows[0] ?? null)
                : state.rows;
            return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
              Promise.resolve({ data, error: null }).then(ok, ko);
          }
          return (...args: unknown[]) => {
            const name = String(prop);
            if (WRITE_OPS.has(name)) {
              wrote = true;
              state.writes.push({ table, op: name, payload: args[0] });
            }
            if (name === "maybeSingle" || name === "single") single = true;
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return { state, from };
});
vi.mock("@/lib/google-iap-management/db", () => ({ googleIapDb: () => ({ from: fakeDb.from }) }));

const appendAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({ appendAction }));

const searchAppsAll = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/reporting-client", () => ({ searchAppsAll }));

const getAppDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/publisher-client", () => ({ getAppDetails }));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

import { POST } from "./route";

beforeEach(() => {
  fakeDb.state.writes.length = 0;
  fakeDb.state.rows = [
    {
      id: "app-1",
      google_console_account_id: "acc1",
      package_name: "com.vnggames.ballisticherotwid",
      display_name: "彈彈英雄",
      default_currency: "USD",
      default_language: "en-US",
    },
    {
      id: "app-2",
      google_console_account_id: "acc1",
      package_name: "com.vng.new.app",
      display_name: "New",
      default_currency: null,
      default_language: null,
    },
  ];
  getServerSession.mockReset().mockResolvedValue({ user: { email: "m@vng.com.vn" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  searchAppsAll.mockReset().mockResolvedValue([
    { packageName: "com.vnggames.ballisticherotwid", displayName: "彈彈英雄" },
    { packageName: "com.vng.new.app", displayName: "New" },
  ]);
  appendAction.mockReset().mockResolvedValue(undefined);
  getAppDetails.mockReset().mockResolvedValue({ defaultLanguage: "zh-TW" });
});

describe("apps-list refresh — D9: never reads AppDetails, never writes app defaults", () => {
  it("the ONLY write to the apps table is the cache upsert — nothing about currency/language", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const appsWrites = fakeDb.state.writes.filter((w) => w.table === "apps");
    expect(appsWrites.map((w) => w.op)).toEqual(["upsert"]);
    const rows = appsWrites[0].payload as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.package_name)).toEqual([
      "com.vnggames.ballisticherotwid",
      "com.vng.new.app",
    ]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        "display_name",
        "google_console_account_id",
        "last_synced_at",
        "package_name",
      ]);
    }
    expect(getAppDetails).not.toHaveBeenCalled();
  });

  it("no write anywhere names a default_* column", async () => {
    await POST();
    expect(fakeDb.state.writes.length).toBeGreaterThan(0); // the refresh did write
    expect(JSON.stringify(fakeDb.state.writes)).not.toMatch(/default_(currency|language)/);
  });

  it("the response no longer reports AppDetails enrichment", async () => {
    const res = await POST();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("details_ok");
    expect(body.apps_count).toBe(2);
  });
});
