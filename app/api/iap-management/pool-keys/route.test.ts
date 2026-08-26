/**
 * [POOL-key-management-UI] U1 — behaviour of the pool-key routes.
 *
 * The structural file next door guards what the source must not DO (log a
 * key, echo a key, skip encryption, pass a pool to Test). This one drives the
 * handlers and checks what they return — including that a non-admin gets 403
 * from every one of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapAdmin = vi.hoisted(() => vi.fn());
// ⚠ The error classes live inside `vi.hoisted` too. `vi.mock` factories are
// hoisted above the file body, and a top-level `class` is NOT hoisted — it
// sits in the temporal dead zone, so the factory throws
// "Cannot access 'Forbidden' before initialization" and the WHOLE FILE fails
// to collect. It reports as "1 failed suite, 0 tests", which is easy to read
// past when a sibling file happens to report the same test count.
const { Forbidden, Unauthorized } = vi.hoisted(() => ({
  Forbidden: class Forbidden extends Error {},
  Unauthorized: class Unauthorized extends Error {},
}));
vi.mock("@/lib/iap-management/auth", () => ({
  requireIapAdmin,
  IapForbiddenError: Forbidden,
  IapUnauthorizedError: Unauthorized,
}));
vi.mock("@/lib/logger", () => ({ log: vi.fn().mockResolvedValue(undefined) }));

// ⚠ THE FAKE CIPHER MUST NOT CONTAIN ITS INPUT. A first draft used
// `ENC(${plaintext})`, which round-trips fine but leaves the PEM as a literal
// substring — so "the stored value is not the plaintext" passed while "no
// call site leaks key material" failed on the fixture rather than on the
// code. Real AES output shares no substring with its input; base64 is the
// cheapest stand-in with that property, and it still round-trips.
const encryptPrivateKey = vi.hoisted(() =>
  vi.fn((s: string) => Buffer.from(s, "utf8").toString("base64")),
);
const decryptPrivateKey = vi.hoisted(() =>
  vi.fn((s: string) => Buffer.from(s, "base64").toString("utf8")),
);
vi.mock("@/lib/asc-crypto", () => ({ encryptPrivateKey, decryptPrivateKey }));

const findAccountById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-account-repository", () => ({ findAccountById, findAllAccounts: vi.fn() }));

const listAllPoolKeys = vi.hoisted(() => vi.fn());
const listAccountOptions = vi.hoisted(() => vi.fn());
const insertPoolKey = vi.hoisted(() => vi.fn());
const setPoolKeyEnabled = vi.hoisted(() => vi.fn());
const findPoolKeyById = vi.hoisted(() => vi.fn());
const { DuplicatePoolKeyError } = vi.hoisted(() => ({
  DuplicatePoolKeyError: class DuplicatePoolKeyError extends Error {},
}));
vi.mock("@/lib/iap-management/key-pool/admin", () => ({
  listAllPoolKeys,
  listAccountOptions,
  insertPoolKey,
  setPoolKeyEnabled,
  findPoolKeyById,
  DuplicatePoolKeyError,
}));

const appleFetch = vi.hoisted(() => vi.fn());
const { AppleApiError } = vi.hoisted(() => ({
  AppleApiError: class AppleApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`Apple ${status}`);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/shared/apple-fetch", () => ({ appleFetch, AppleApiError }));

import { GET, POST } from "./route";
import { PATCH } from "./[keyId]/route";
import { POST as TEST } from "./[keyId]/test/route";

const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
const ACCOUNT = {
  id: "acct-a",
  name: "Account A",
  keyId: "OWN",
  issuerId: "issuer-A",
  privateKey: "own-pk",
};

function req(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireIapAdmin.mockResolvedValue({ user: { email: "admin@x.com", role: "admin" } });
  listAllPoolKeys.mockResolvedValue([]);
  listAccountOptions.mockResolvedValue([]);
  insertPoolKey.mockResolvedValue(undefined);
  setPoolKeyEnabled.mockResolvedValue("acct-a");
  findAccountById.mockResolvedValue(ACCOUNT);
  appleFetch.mockResolvedValue({});
});

// ─── (d) admin gate, per route ──────────────────────────────────────────────

describe("⚠ (d) a non-admin gets 403 from EVERY route", () => {
  beforeEach(() => {
    requireIapAdmin.mockRejectedValue(new Forbidden("admin only"));
  });

  it("GET /pool-keys", async () => {
    expect((await GET()).status).toBe(403);
  });

  it("POST /pool-keys", async () => {
    const res = await POST(req({ accountId: "acct-a", keyId: "K", privateKey: PEM }));
    expect(res.status).toBe(403);
    expect(insertPoolKey).not.toHaveBeenCalled();
  });

  it("PATCH /pool-keys/[keyId]", async () => {
    const res = await PATCH(req({ enabled: false }), { params: { keyId: "r1" } });
    expect(res.status).toBe(403);
    expect(setPoolKeyEnabled).not.toHaveBeenCalled();
  });

  it("POST /pool-keys/[keyId]/test", async () => {
    const res = await TEST(req({}), { params: { keyId: "r1" } });
    expect(res.status).toBe(403);
    expect(appleFetch).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller gets 401, not 403", async () => {
    requireIapAdmin.mockRejectedValue(new Unauthorized("no session"));
    expect((await GET()).status).toBe(401);
  });
});

// ─── add ────────────────────────────────────────────────────────────────────

describe("POST /pool-keys — add", () => {
  it("⚠ encrypts before storing, and stores the CIPHERTEXT", async () => {
    await POST(req({ accountId: "acct-a", keyId: "KEY1", privateKey: PEM, note: "n" }));
    expect(encryptPrivateKey).toHaveBeenCalledOnce();
    const arg = insertPoolKey.mock.calls[0][0];
    expect(arg.privateKeyEnc).toBe(Buffer.from(PEM, "utf8").toString("base64"));
    expect(arg.privateKeyEnc).not.toBe(PEM);
    expect(JSON.stringify(arg)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("⚠ the response never contains key material", async () => {
    const res = await POST(req({ accountId: "acct-a", keyId: "KEY1", privateKey: PEM }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain(Buffer.from(PEM, "utf8").toString("base64"));
  });

  it("⚠ rejects an account the database does not have", async () => {
    // account_id has no FK; a bad id would insert fine and the key would be
    // invisible to every account forever.
    findAccountById.mockResolvedValue(null);
    const res = await POST(req({ accountId: "ghost", keyId: "K", privateKey: PEM }));
    expect(res.status).toBe(400);
    expect(insertPoolKey).not.toHaveBeenCalled();
  });

  it("⚠ rejects a non-PEM paste BEFORE encrypting", async () => {
    // Encrypting garbage succeeds; the failure would surface later as a
    // decrypt error looking like a rotated ENCRYPTION_KEY.
    const res = await POST(req({ accountId: "acct-a", keyId: "K", privateKey: "oops" }));
    expect(res.status).toBe(400);
    expect(encryptPrivateKey).not.toHaveBeenCalled();
    expect(insertPoolKey).not.toHaveBeenCalled();
  });

  it("reports a duplicate as 409 rather than swallowing it", async () => {
    insertPoolKey.mockRejectedValue(new DuplicatePoolKeyError("already there"));
    const res = await POST(req({ accountId: "acct-a", keyId: "K", privateKey: PEM }));
    expect(res.status).toBe(409);
  });

  it("requires account and key id", async () => {
    expect((await POST(req({ keyId: "K", privateKey: PEM }))).status).toBe(400);
    expect((await POST(req({ accountId: "acct-a", privateKey: PEM }))).status).toBe(400);
  });
});

// ─── toggle ─────────────────────────────────────────────────────────────────

describe("PATCH /pool-keys/[keyId] — enable/disable", () => {
  it("disables", async () => {
    const res = await PATCH(req({ enabled: false }), { params: { keyId: "r1" } });
    expect(res.status).toBe(200);
    expect(setPoolKeyEnabled).toHaveBeenCalledWith("r1", false);
  });

  it("enables", async () => {
    await PATCH(req({ enabled: true }), { params: { keyId: "r1" } });
    expect(setPoolKeyEnabled).toHaveBeenCalledWith("r1", true);
  });

  it("rejects a missing/non-boolean enabled", async () => {
    expect((await PATCH(req({}), { params: { keyId: "r1" } })).status).toBe(400);
    expect((await PATCH(req({ enabled: "yes" }), { params: { keyId: "r1" } })).status).toBe(400);
  });
});

// ─── test key ───────────────────────────────────────────────────────────────

describe("POST /pool-keys/[keyId]/test — Test key", () => {
  beforeEach(() => {
    findPoolKeyById.mockResolvedValue({
      accountId: "acct-a",
      keyId: "KEY1",
      privateKeyEnc: Buffer.from(PEM, "utf8").toString("base64"),
    });
  });

  it("⚠ signs with THIS row's key, and passes NO pool", async () => {
    await TEST(req({}), { params: { keyId: "r1" } });
    const [creds, method, endpoint, , , opts] = appleFetch.mock.calls[0];
    expect(creds.keyId).toBe("KEY1");
    expect(creds.privateKey).toBe(PEM);
    // issuer + identity stay the ACCOUNT's — this is what makes a
    // cross-team key fail closed with a 401.
    expect(creds.issuerId).toBe("issuer-A");
    expect(creds.id).toBe("acct-a");
    expect(method).toBe("GET");
    expect(endpoint).toBe("/v1/territories?limit=1");
    expect(opts?.keyPool).toBeUndefined();
  });

  it("reports 200 with the budget read off the response", async () => {
    appleFetch.mockImplementation(async (_c, _m, _e, _b, _t, opts) => {
      opts?.onRateLimitInfo?.({ limit: 3600, remaining: 3599 });
      return {};
    });
    const body = await (await TEST(req({}), { params: { keyId: "r1" } })).json();
    expect(body).toMatchObject({ ok: true, kind: "OK", keyId: "KEY1", remaining: 3599, limit: 3600 });
  });

  it("⚠ 401 becomes a WRONG_TEAM message naming the account", async () => {
    appleFetch.mockRejectedValue(new AppleApiError(401));
    const body = await (await TEST(req({}), { params: { keyId: "r1" } })).json();
    expect(body.kind).toBe("WRONG_TEAM");
    expect(body.error).toContain("Account A");
    expect(body.error).toContain("KEY1");
  });

  it("403 is treated the same way", async () => {
    appleFetch.mockRejectedValue(new AppleApiError(403));
    expect((await (await TEST(req({}), { params: { keyId: "r1" } })).json()).kind).toBe("WRONG_TEAM");
  });

  it("⚠ any other failure is reported as-is, NOT as a wrong key", async () => {
    // Telling a Manager to re-register a good key because Apple had a bad
    // minute is the expensive mistake.
    appleFetch.mockRejectedValue(new AppleApiError(503));
    const body = await (await TEST(req({}), { params: { keyId: "r1" } })).json();
    expect(body.kind).toBe("UNKNOWN");
    expect(body.kind).not.toBe("WRONG_TEAM");
  });

  it("a missing row is 404", async () => {
    findPoolKeyById.mockResolvedValue(null);
    expect((await TEST(req({}), { params: { keyId: "nope" } })).status).toBe(404);
  });

  it("⚠ never returns the decrypted key", async () => {
    appleFetch.mockImplementation(async (_c, _m, _e, _b, _t, opts) => {
      opts?.onRateLimitInfo?.({ limit: 3600, remaining: 10 });
      return {};
    });
    const text = JSON.stringify(await (await TEST(req({}), { params: { keyId: "r1" } })).json());
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });
});
