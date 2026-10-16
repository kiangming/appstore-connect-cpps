/**
 * D9 [arc-google-missing-purchase-options] — an IAP refresh NEVER writes the
 * app's currency/language. Before C2 it overwrote both from the first product
 * Google returned (Hotfix 4: currency of its US region, language of its first
 * listing), which turned 彈彈英雄's guessed TWD into an equally guessed USD.
 *
 * ⚠ The apps repository is NOT mocked (route.test.ts mocks it to drive the D0
 *   stamp cases). It runs over a fake DB that records every write, and the
 *   products DO carry a currency and a language — so a re-introduced
 *   "capture app defaults" write, whatever function or name it uses and even
 *   inside a non-fatal try/catch, shows up as a second write to `apps`.
 *   batchSyncIapsFromGoogle's own guarantee is in repository/iaps.test.ts.
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

const batchSyncIapsFromGoogle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/iaps", () => ({ batchSyncIapsFromGoogle }));

const appendAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({ appendAction }));

const listInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/publisher-client", () => ({ listInAppProducts }));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

import { POST } from "./route";

const ctx = { params: { packageName: "com.vnggames.ballisticherotwid" } };
const req = () => new Request("http://localhost/api/x", { method: "POST" });
const noFlags = { flagged: 0, unflagged: 0, flaggedSkus: [], unflaggedSkus: [], skippedReason: null };

beforeEach(() => {
  fakeDb.state.writes.length = 0;
  // The app as the incident left it: values guessed by the tool.
  fakeDb.state.rows = [
    {
      id: "app-1",
      google_console_account_id: "acc1",
      package_name: "com.vnggames.ballisticherotwid",
      display_name: "彈彈英雄",
      default_currency: "TWD",
      default_language: "zh-TW",
    },
  ];
  getServerSession.mockReset().mockResolvedValue({ user: { email: "m@vng.com.vn" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  appendAction.mockReset().mockResolvedValue(undefined);
  // Products carrying exactly what Hotfix 4 used to copy onto the app row.
  listInAppProducts.mockReset().mockResolvedValue([
    {
      sku: "com.vnggames.ballisticherotwid.0.99",
      defaultLanguage: "en-US",
      defaultPrice: { currency: "USD", priceMicros: "990000" },
      listings: { "en-US": { title: "Gem pack", description: "x" } },
    },
    {
      sku: "com.vnggames.ballisticherotwid.1.99",
      defaultLanguage: "zh-TW",
      defaultPrice: { currency: "TWD", priceMicros: "60000000" },
      listings: { "zh-TW": { title: "鑽石", description: "x" } },
    },
  ]);
  batchSyncIapsFromGoogle
    .mockReset()
    .mockResolvedValue({ synced: 2, failed: 0, flagReconcile: noFlags });
});

describe("IAP refresh — D9: the only write to the apps row is the D0 sync stamp", () => {
  it("complete refresh of products that carry currency + language ⇒ apps gets ONLY {iaps_last_synced_at}", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const appsWrites = fakeDb.state.writes.filter((w) => w.table === "apps");
    expect(appsWrites).toHaveLength(1);
    expect(appsWrites[0].op).toBe("update");
    expect(Object.keys(appsWrites[0].payload as object)).toEqual(["iaps_last_synced_at"]);
  });

  it("incomplete refresh (failed > 0) ⇒ NO write to the apps row at all", async () => {
    batchSyncIapsFromGoogle.mockResolvedValue({ synced: 1, failed: 1, flagReconcile: noFlags });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(fakeDb.state.writes.filter((w) => w.table === "apps")).toEqual([]);
  });

  it("no write anywhere names a default_* column", async () => {
    await POST(req(), ctx);
    expect(JSON.stringify(fakeDb.state.writes)).not.toMatch(/default_(currency|language)/);
  });
});
