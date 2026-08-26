/**
 * [POOL-key-management-UI] U3 — end-to-end through the REAL routes.
 *
 * ⚠ APPLE IS FAKED AT THE `fetch` BOUNDARY AND NOWHERE ELSE. The route, the
 * admin query layer, the encryption, the repository, its 30s cache and the
 * selector all run for real against an in-memory table. U1 and U2 each tested
 * one side of a seam; nothing until now crossed it, and the two defects this
 * file is built to catch both live exactly there:
 *
 *   · the `[key-pool-test]` log line is the D1 measurement (there is no D1
 *     button — `[Q-POOLUI.no-d1-button]`), so a missing field is not a
 *     cosmetic logging bug, it is a verdict that cannot be read;
 *   · a write that does not invalidate the cache leaves ROTATION blind to the
 *     new key for up to 30 seconds, which on a settings screen reads as
 *     "adding a key did nothing".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ENCRYPTION_KEY = "a".repeat(64);

const requireIapAdmin = vi.hoisted(() => vi.fn());
const { Forbidden, Unauthorized } = vi.hoisted(() => ({
  Forbidden: class Forbidden extends Error {},
  Unauthorized: class Unauthorized extends Error {},
}));
vi.mock("@/lib/iap-management/auth", () => ({
  requireIapAdmin,
  IapForbiddenError: Forbidden,
  IapUnauthorizedError: Unauthorized,
}));

const logLines = vi.hoisted(() => [] as Array<{ tag: string; msg: string }>);
vi.mock("@/lib/logger", () => ({
  log: vi.fn(async (tag: string, msg: string) => {
    logLines.push({ tag, msg });
  }),
}));

const findAccountById = vi.hoisted(() => vi.fn());
const findAllAccounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-account-repository", () => ({ findAccountById, findAllAccounts }));

vi.mock("@/lib/asc-jwt", () => ({
  generateAscToken: vi.fn().mockResolvedValue("fake-jwt"),
}));

/** In-memory `iap_mgmt.asc_account_keys`. */
const TABLE = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const iapDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb }));

import { GET, POST } from "@/app/api/iap-management/pool-keys/route";
import { PATCH } from "@/app/api/iap-management/pool-keys/[keyId]/route";
import { POST as TEST } from "@/app/api/iap-management/pool-keys/[keyId]/test/route";
import { listPoolKeys, __resetPoolKeyCacheForTests } from "./repository";
import { selectKey, __resetSelectorForTests } from "./selector";
import { decryptPrivateKey } from "@/lib/asc-crypto";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----";
const ACCOUNT = {
  id: "acct-a",
  name: "Account A",
  keyId: "ACCOUNT_OWN",
  issuerId: "issuer-A",
  privateKey: "own-pk",
};

/** Query builder over TABLE, honouring eq() the way Postgres would. */
function makeDb() {
  return {
    from: () => {
      let rows = [...TABLE];
      const eqs: Array<[string, unknown]> = [];
      let mode: "select" | "insert" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.order = self;
      b.eq = (col: string, val: unknown) => {
        eqs.push([col, val]);
        rows = rows.filter((r) => r[col] === val);
        return b;
      };
      b.insert = (payload: Record<string, unknown>) => {
        mode = "insert";
        const dup = TABLE.some(
          (r) => r.account_id === payload.account_id && r.key_id === payload.key_id,
        );
        if (dup) {
          b.then = (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }).then(res);
          return b;
        }
        TABLE.push({
          id: `row-${TABLE.length + 1}`,
          enabled: true,
          cooldown_until: null,
          created_at: new Date(2026, 7, 26).toISOString(),
          note: null,
          ...payload,
        });
        return b;
      };
      b.update = (p: Record<string, unknown>) => {
        mode = "update";
        patch = p;
        return b;
      };
      b.maybeSingle = () => {
        if (mode === "update") {
          for (const r of rows) Object.assign(r, patch);
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (mode === "update") for (const r of rows) Object.assign(r, patch);
        const data = mode === "insert" ? null : rows;
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return b;
    },
  };
}

function req(body?: unknown) {
  return { json: async () => body ?? {} } as unknown as Request;
}

function appleResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => "{}",
    json: async () => ({ data: [] }),
  } as unknown as Response;
}

const BUDGET = { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3589;" };

beforeEach(() => {
  TABLE.length = 0;
  logLines.length = 0;
  __resetPoolKeyCacheForTests();
  __resetSelectorForTests();
  requireIapAdmin.mockResolvedValue({ user: { email: "admin@x.com", role: "admin" } });
  findAccountById.mockImplementation(async (id: string) => (id === "acct-a" ? ACCOUNT : null));
  findAllAccounts.mockResolvedValue([ACCOUNT]);
  iapDb.mockImplementation(() => makeDb());
});

async function addKey(keyId: string) {
  return POST(req({ accountId: "acct-a", keyId, privateKey: PEM, note: `note ${keyId}` }));
}

// ─── the full operator flow ─────────────────────────────────────────────────

describe("add → list → toggle, through the real routes", () => {
  it("⚠ the stored value is CIPHERTEXT that round-trips to the original", async () => {
    // Real `encryptPrivateKey` ran; real `decryptPrivateKey` reads it back.
    // A route that stored plaintext would still pass a shape check — this
    // asserts both halves: not the plaintext, AND recoverable.
    expect((await addKey("AAAA1111")).status).toBe(200);
    const stored = String(TABLE[0].private_key_enc);
    expect(stored).not.toContain("BEGIN PRIVATE KEY");
    expect(decryptPrivateKey(stored)).toBe(PEM);
  });

  it("the list route returns it without any key material", async () => {
    await addKey("AAAA1111");
    const body = await (await GET()).json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ keyId: "AAAA1111", enabled: true, accountId: "acct-a" });
    expect(JSON.stringify(body)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain(String(TABLE[0].private_key_enc));
  });

  it("a duplicate is refused by the real unique check", async () => {
    await addKey("AAAA1111");
    expect((await addKey("AAAA1111")).status).toBe(409);
    expect(TABLE).toHaveLength(1);
  });

  it("toggle disables and the list reflects it", async () => {
    await addKey("AAAA1111");
    const id = String(TABLE[0].id);
    expect((await PATCH(req({ enabled: false }), { params: { keyId: id } })).status).toBe(200);
    const body = await (await GET()).json();
    expect(body.keys[0].enabled).toBe(false);
  });
});

// ─── (3) the smoke test that crosses the seam ───────────────────────────────

describe("⚠ (3) a key added through the UI is visible to ROTATION immediately", () => {
  it("⚠ listPoolKeys sees it at once — not after the 30s cache lapses", async () => {
    // Warm the cache FIRST, so the invalidation is doing real work. Without
    // it the read would miss and refill anyway, and the test would pass with
    // the invalidate deleted.
    expect(await listPoolKeys("acct-a")).toHaveLength(0);
    await addKey("AAAA1111");
    const keys = await listPoolKeys("acct-a");
    expect(keys.map((k) => k.keyId)).toEqual(["AAAA1111"]);
  });

  it("⚠ and the SELECTOR hands it out — UI write reaches the signing path", async () => {
    await listPoolKeys("acct-a");
    await addKey("AAAA1111");
    const sel = await selectKey(ACCOUNT);
    expect(sel.fromPool).toBe(true);
    expect(sel.creds.keyId).toBe("AAAA1111");
    // Team-scoped fields still come from the account.
    expect(sel.creds.issuerId).toBe("issuer-A");
  });

  it("⚠ disabling through the UI removes it from rotation immediately", async () => {
    await addKey("AAAA1111");
    await listPoolKeys("acct-a");
    await PATCH(req({ enabled: false }), { params: { keyId: String(TABLE[0].id) } });
    const sel = await selectKey(ACCOUNT);
    expect(sel.fromPool).toBe(false);
    expect(sel.missReason).toBe("empty");
    expect(sel.creds.keyId).toBe("ACCOUNT_OWN");
  });

  it("two keys added through the UI both enter the rotation", async () => {
    await addKey("AAAA1111");
    await addKey("BBBB2222");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((await selectKey(ACCOUNT)).creds.keyId);
    expect([...seen].sort()).toEqual(["AAAA1111", "BBBB2222"]);
  });
});

// ─── (2) Test key + the D1 log line ─────────────────────────────────────────

describe("Test key, end to end", () => {
  const testLine = () =>
    logLines.map((l) => l.msg).find((m) => m.includes("[key-pool-test]"));

  it("✅ 200 reports the budget AND logs every D1 field", async () => {
    await addKey("AAAA1111");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(appleResponse(200, BUDGET)));
    const body = await (await TEST(req(), { params: { keyId: String(TABLE[0].id) } })).json();
    expect(body).toMatchObject({ ok: true, kind: "OK", remaining: 3589, limit: 3600 });

    // ⚠ THE LOG LINE IS THE MEASUREMENT. Field by field, because a verdict
    // read off a line missing `rem` is not a wrong number — it is no number.
    const line = testLine();
    expect(line).toBeDefined();
    expect(line).toContain("account=acct-a");
    expect(line).toContain("key=AAAA1111");
    expect(line).toContain("status=200");
    expect(line).toContain("rem=3589");
    expect(line).toContain("lim=3600");
  });

  it("⚠ signs with THIS key — the JWT is minted from the row, not from rotation", async () => {
    await addKey("AAAA1111");
    await addKey("BBBB2222");
    const { generateAscToken } = await import("@/lib/asc-jwt");
    vi.mocked(generateAscToken).mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(appleResponse(200, BUDGET)));
    // Test the SECOND key specifically.
    const second = TABLE.find((r) => r.key_id === "BBBB2222")!;
    await TEST(req(), { params: { keyId: String(second.id) } });
    const creds = vi.mocked(generateAscToken).mock.calls[0][0];
    expect(creds.keyId).toBe("BBBB2222");
    expect(creds.issuerId).toBe("issuer-A");
  });

  it("❌ 401 becomes WRONG_TEAM and still logs the attempt", async () => {
    await addKey("AAAA1111");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(appleResponse(401)));
    const body = await (await TEST(req(), { params: { keyId: String(TABLE[0].id) } })).json();
    expect(body.kind).toBe("WRONG_TEAM");
    expect(body.error).toContain("Account A");
    expect(testLine()).toContain("status=401");
  });

  it("⚠ 503 is UNKNOWN, never WRONG_TEAM", async () => {
    await addKey("AAAA1111");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(appleResponse(503)));
    const body = await (await TEST(req(), { params: { keyId: String(TABLE[0].id) } })).json();
    expect(body.kind).toBe("UNKNOWN");
  });

  it("⚠ two adjacent lines are enough to read the D1 verdict", async () => {
    // This is the whole reason there is no D1 button. Per-key looks like:
    // key A charged, key B still at lim-1.
    await addKey("AAAA1111");
    await addKey("BBBB2222");
    const rows = [...TABLE];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          appleResponse(200, { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3589;" }),
        )
        .mockResolvedValueOnce(
          appleResponse(200, { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3599;" }),
        ),
    );
    await TEST(req(), { params: { keyId: String(rows[0].id) } });
    await TEST(req(), { params: { keyId: String(rows[1].id) } });

    const lines = logLines.map((l) => l.msg).filter((m) => m.includes("[key-pool-test]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("key=AAAA1111");
    expect(lines[0]).toContain("rem=3589");
    expect(lines[1]).toContain("key=BBBB2222");
    expect(lines[1]).toContain("rem=3599");
    // lim − 1 on the second key while the first was charged ⇒ PER-KEY.
    const rem = lines.map((l) => Number(/rem=(\d+)/.exec(l)?.[1]));
    const lim = Number(/lim=(\d+)/.exec(lines[1])![1]);
    expect(rem[1]).toBe(lim - 1);
    expect(rem[1]).toBeGreaterThan(rem[0]);
  });
});
