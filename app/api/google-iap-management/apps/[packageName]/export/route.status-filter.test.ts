/**
 * X2 — the export route's status filter, at the route boundary.
 *
 * Mirrors the mocking shape of the bulk-import execute route test: everything
 * around the route is faked so the assertions are about the ROUTE's own
 * decisions — what it filters, what it reports, and how many times it calls
 * Google.
 *
 * ⚠ THE REQUEST COUNT IS AN ASSERTION HERE, NOT AN ASSUMPTION. The value of a
 * filter on Google is not saved requests (the list is one paginated call for
 * the whole app either way) — it is a smaller file. If a later change made the
 * filter fetch per status, nothing about the file would look wrong, so the
 * count is pinned explicitly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

const listAccounts = vi.hoisted(() => vi.fn());
const getEncryptedCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
  getEncryptedCredentials,
}));

const getAppByPackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({ getAppByPackage }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const listInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/publisher-client", () => ({
  listInAppProducts,
}));

import { POST } from "./route";

const ctx = { params: { packageName: "com.example.app" } };

function product(sku: string, status: string | null) {
  return {
    sku,
    status,
    listings: { "en-US": { title: sku, description: "d" } },
    prices: { US: { currency: "USD", priceMicros: "1990000" } },
  };
}

/** 3 active (one of them via a null-ish unknown → inactive), 2 inactive. */
const LIVE = [
  product("a1", "active"),
  product("a2", "active"),
  product("i1", "inactive"),
  product("i2", "inactive"),
  product("u1", null), // unknown → classified inactive, like the file's column
];

function post(body: unknown) {
  return POST(
    new Request("http://x/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: { email: "a@b.c" } });
  listAccounts.mockResolvedValue([{ id: "acc-1", status: "verified" }]);
  readActiveAccountId.mockReturnValue("acc-1");
  resolveActiveAccountId.mockReturnValue("acc-1");
  getAppByPackage.mockResolvedValue({ id: "app-1", default_currency: "USD" });
  getEncryptedCredentials.mockResolvedValue("enc");
  jwtClientFromEncrypted.mockReturnValue({});
  listInAppProducts.mockResolvedValue(LIVE);
});

describe("statusFilter — what reaches the file", () => {
  it("absent = every item, byte-for-byte the pre-X2 behaviour", async () => {
    const res = await post({ territories: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Item-Count")).toBe("5");
    expect(res.headers.get("X-Export-Skipped-Count")).toBe("0");
    expect(res.headers.get("X-Export-Status-Filter")).toBe("all");
  });

  it("`active` exports only the active ones and counts the rest as skipped", async () => {
    const res = await post({ territories: null, statusFilter: "active" });
    expect(res.headers.get("X-Export-Item-Count")).toBe("2");
    expect(res.headers.get("X-Export-Skipped-Count")).toBe("3");
  });

  it("`inactive` includes the unknown-status item, matching the Status column", async () => {
    // `u1` has no status. The file prints its Status cell as "inactive"
    // (xlsx-export.ts), so the filter must agree — otherwise a row could be
    // excluded by a filter whose own value the file contradicts.
    const res = await post({ territories: null, statusFilter: "inactive" });
    expect(res.headers.get("X-Export-Item-Count")).toBe("3");
    expect(res.headers.get("X-Export-Skipped-Count")).toBe("2");
  });

  it("exported + skipped always equals the live total", async () => {
    for (const f of [undefined, "all", "active", "inactive"]) {
      const res = await post({ territories: null, statusFilter: f });
      const n = Number(res.headers.get("X-Export-Item-Count"));
      const s = Number(res.headers.get("X-Export-Skipped-Count"));
      expect(n + s, String(f)).toBe(LIVE.length);
    }
  });
});

describe("⚠ the skipped header is always present, even when nothing was skipped", () => {
  it("`all` still reports 0 rather than omitting the header", async () => {
    // A header that appears only when non-zero makes its absence ambiguous:
    // the client cannot tell "nothing skipped" from "this build does not
    // report skips", and would have to guess.
    const res = await post({ territories: null, statusFilter: "all" });
    expect(res.headers.has("X-Export-Skipped-Count")).toBe(true);
    expect(res.headers.get("X-Export-Skipped-Count")).toBe("0");
  });
});

describe("⚠ an unrecognised filter degrades to `all` — it does not 400", () => {
  it.each([["ACTIVE"], ["nonsense"], [""], [null], [42], [["active"]]])(
    "%o exports everything and reports the filter it actually used",
    async (bad) => {
      // ⚠ DELIBERATELY UNLIKE the `[]`→400 rule for a SELECTION. A mode's
      // neutral value is a real, correct mode — exporting every item is what
      // this route did before X2. Refusing a typo'd mode would turn a
      // cosmetic client bug into a failed export of the right default.
      const res = await post({ territories: null, statusFilter: bad });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Export-Item-Count")).toBe("5");
      expect(res.headers.get("X-Export-Status-Filter")).toBe("all");
    },
  );
});

describe("⚠ LOCK — the filter never changes how many times Google is called", () => {
  it("exactly one listInAppProducts call, whatever the filter", async () => {
    for (const f of [undefined, "all", "active", "inactive", "garbage"]) {
      listInAppProducts.mockClear();
      await post({ territories: null, statusFilter: f });
      expect(listInAppProducts, String(f)).toHaveBeenCalledTimes(1);
    }
  });

  it("a filter that matches nothing still costs exactly one call", async () => {
    listInAppProducts.mockResolvedValue([product("i1", "inactive")]);
    listInAppProducts.mockClear();
    listInAppProducts.mockResolvedValue([product("i1", "inactive")]);
    const res = await post({ territories: null, statusFilter: "active" });
    expect(listInAppProducts).toHaveBeenCalledTimes(1);
    expect(res.headers.get("X-Export-Item-Count")).toBe("0");
    expect(res.headers.get("X-Export-Skipped-Count")).toBe("1");
  });
});

describe("the territory selection still works alongside the status filter", () => {
  it("both are applied, and neither disables the other", async () => {
    const res = await post({ territories: ["US"], statusFilter: "active" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Item-Count")).toBe("2");
  });
});
