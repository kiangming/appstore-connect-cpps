/**
 * K1 — the key pool's storage layer.
 *
 * Two of these tests guard properties that are easy to "fix" into bugs:
 *   · an account with no pool keys must return [], never throw — the pool is
 *     opt-in per account, so "not pooled yet" has to stay a normal state or
 *     enabling it for one account becomes a risk to every other one;
 *   · a decrypt failure must throw something NAMED, because it means either
 *     a corrupt row or a rotated ENCRYPTION_KEY and the operator needs to
 *     know which key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const decryptPrivateKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-crypto", () => ({ decryptPrivateKey }));

const iapDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb }));

import {
  listPoolKeys,
  poolKeyToCredentials,
  PoolKeyDecryptError,
  invalidatePoolKeyCache,
  __resetPoolKeyCacheForTests,
} from "./repository";
import type { AscCredentials } from "@/lib/asc-jwt";

/** Chainable Supabase stub — every builder method returns itself. */
function chain(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  b.select = self;
  b.eq = self;
  b.order = self;
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

let queryResult: { data: unknown; error: unknown } = { data: [], error: null };
const fromSpy = vi.fn();

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row-1",
    account_id: "acct-a",
    key_id: "KEY1",
    private_key_enc: "enc:KEY1",
    cooldown_until: null,
    ...over,
  };
}

const account: AscCredentials = {
  id: "acct-a",
  name: "Acct A",
  keyId: "ACCOUNT_DEFAULT_KEY",
  issuerId: "issuer-uuid",
  privateKey: "-----BEGIN PRIVATE KEY-----\naccount\n-----END PRIVATE KEY-----",
};

beforeEach(() => {
  __resetPoolKeyCacheForTests();
  queryResult = { data: [], error: null };
  fromSpy.mockReset().mockImplementation(() => chain(queryResult));
  iapDb.mockReset().mockImplementation(() => ({ from: fromSpy }));
  decryptPrivateKey.mockReset().mockImplementation((v: string) => `dec(${v})`);
});

describe("listPoolKeys", () => {
  it("decrypts each row through the shared asc-crypto path", async () => {
    queryResult = { data: [row(), row({ id: "row-2", key_id: "KEY2", private_key_enc: "enc:KEY2" })], error: null };
    const keys = await listPoolKeys("acct-a");

    expect(keys.map((k) => k.keyId)).toEqual(["KEY1", "KEY2"]);
    expect(keys[0].privateKey).toBe("dec(enc:KEY1)");
    // The same helper `asc_accounts` uses — one format, one key, one decoder.
    expect(decryptPrivateKey).toHaveBeenCalledWith("enc:KEY1");
  });

  it("queries the pool table for enabled keys of that account only", async () => {
    await listPoolKeys("acct-a");
    expect(fromSpy).toHaveBeenCalledWith("asc_account_keys");
  });

  it("⚠ an account with NO pool keys returns [] — it is not an error", async () => {
    // The caller falls back to the account's own key. Throwing here would
    // turn "this account isn't pooled yet" into an outage.
    queryResult = { data: [], error: null };
    await expect(listPoolKeys("acct-unpooled")).resolves.toEqual([]);
  });

  it("a null data payload is also empty, not a crash", async () => {
    queryResult = { data: null, error: null };
    await expect(listPoolKeys("acct-a")).resolves.toEqual([]);
  });

  it("⚠ cooled-down keys are RETURNED, not filtered — the selector decides", async () => {
    // The selector must be able to tell "pool is empty" from "pool is
    // entirely on cooldown"; filtering here would erase that difference.
    const until = "2030-01-01T00:00:00.000Z";
    queryResult = { data: [row({ cooldown_until: until })], error: null };
    const keys = await listPoolKeys("acct-a");
    expect(keys).toHaveLength(1);
    expect(keys[0].cooldownUntil).toEqual(new Date(until));
  });

  it("a DB error surfaces with the account named", async () => {
    queryResult = { data: null, error: { message: "boom" } };
    await expect(listPoolKeys("acct-a")).rejects.toThrow(/acct-a.*boom/);
  });
});

describe("decrypt failure", () => {
  it("⚠ throws a NAMED error carrying the key id, not a raw cipher error", async () => {
    decryptPrivateKey.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    queryResult = { data: [row({ key_id: "BADKEY" })], error: null };

    await expect(listPoolKeys("acct-a")).rejects.toBeInstanceOf(
      PoolKeyDecryptError,
    );
  });

  it("the message names the key AND the two things that cause it", async () => {
    decryptPrivateKey.mockImplementation(() => {
      throw new Error("unable to authenticate data");
    });
    queryResult = { data: [row({ key_id: "BADKEY" })], error: null };

    const err = await listPoolKeys("acct-a").catch((e) => e);
    expect(err).toBeInstanceOf(PoolKeyDecryptError);
    expect(err.keyId).toBe("BADKEY");
    expect(err.accountId).toBe("acct-a");
    expect(err.message).toMatch(/BADKEY/);
    expect(err.message).toMatch(/ENCRYPTION_KEY/);
    // The wrapped error is kept for debugging but stays out of the message.
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("a failed read is NOT cached — the next call retries", async () => {
    decryptPrivateKey.mockImplementation(() => {
      throw new Error("nope");
    });
    queryResult = { data: [row()], error: null };
    await listPoolKeys("acct-a").catch(() => {});

    decryptPrivateKey.mockImplementation((v: string) => `dec(${v})`);
    await expect(listPoolKeys("acct-a")).resolves.toHaveLength(1);
    expect(fromSpy).toHaveBeenCalledTimes(2);
  });
});

describe("cache", () => {
  it("a second read inside the TTL does not hit the DB", async () => {
    queryResult = { data: [row()], error: null };
    await listPoolKeys("acct-a");
    await listPoolKeys("acct-a");
    expect(fromSpy).toHaveBeenCalledTimes(1);
  });

  it("is keyed per account — one account's read does not answer another's", async () => {
    queryResult = { data: [row()], error: null };
    await listPoolKeys("acct-a");
    await listPoolKeys("acct-b");
    expect(fromSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidation forces a re-read (K3 will call this after a cooldown write)", async () => {
    queryResult = { data: [row()], error: null };
    await listPoolKeys("acct-a");
    invalidatePoolKeyCache("acct-a");
    await listPoolKeys("acct-a");
    expect(fromSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidating one account leaves the other cached", async () => {
    queryResult = { data: [row()], error: null };
    await listPoolKeys("acct-a");
    await listPoolKeys("acct-b");
    invalidatePoolKeyCache("acct-a");
    await listPoolKeys("acct-b");
    expect(fromSpy).toHaveBeenCalledTimes(2);
  });
});

describe("poolKeyToCredentials", () => {
  it("swaps ONLY keyId + privateKey; the team-scoped fields come from the account", async () => {
    queryResult = { data: [row()], error: null };
    const [key] = await listPoolKeys("acct-a");
    const creds = poolKeyToCredentials(account, key);

    expect(creds.keyId).toBe("KEY1");
    expect(creds.privateKey).toBe("dec(enc:KEY1)");
    // ⚠ Same team. A JWT whose `kid` and `iss` disagree fails as a 401, which
    // reads like a bad key rather than bad data — so the issuer is never
    // re-derived per key.
    expect(creds.issuerId).toBe(account.issuerId);
    // ⚠ Still names the ACCOUNT, so logs and errors stay readable.
    expect(creds.id).toBe(account.id);
    expect(creds.name).toBe(account.name);
  });

  it("does not mutate the account it was given", async () => {
    queryResult = { data: [row()], error: null };
    const [key] = await listPoolKeys("acct-a");
    poolKeyToCredentials(account, key);
    expect(account.keyId).toBe("ACCOUNT_DEFAULT_KEY");
  });
});
