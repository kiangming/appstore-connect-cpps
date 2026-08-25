/**
 * K2 — key selection, cooldown, and the two different kinds of "no key".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listPoolKeys = vi.hoisted(() => vi.fn());
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, listPoolKeys };
});

import { selectKey, markKeyRateLimited, __resetSelectorForTests } from "./selector";
import type { AscCredentials } from "@/lib/asc-jwt";

const account: AscCredentials = {
  id: "acct-a",
  name: "Acct A",
  keyId: "ACCOUNT_KEY",
  issuerId: "issuer-1",
  privateKey: "account-pk",
};

const poolKey = (keyId: string, cooldownUntil: Date | null = null) => ({
  id: `row-${keyId}`,
  keyId,
  privateKey: `pk-${keyId}`,
  cooldownUntil,
});

beforeEach(() => {
  __resetSelectorForTests();
  listPoolKeys.mockReset().mockResolvedValue([]);
});

describe("selectKey — the two kinds of miss are not the same situation", () => {
  it('⚠ no pool keys → falls back, reason "empty" — a NORMAL state', async () => {
    // The pool is opt-in per account; most accounts will never have a key.
    // This must not read as a failure or enabling the pool for one account
    // becomes a risk to every other one.
    listPoolKeys.mockResolvedValue([]);
    const s = await selectKey(account);
    expect(s.fromPool).toBe(false);
    expect(s.missReason).toBe("empty");
    expect(s.creds.keyId).toBe("ACCOUNT_KEY");
  });

  it('⚠ keys exist but ALL cooling down → reason "exhausted", a real budget signal', async () => {
    const future = new Date(Date.now() + 60_000);
    listPoolKeys.mockResolvedValue([poolKey("K1", future), poolKey("K2", future)]);
    const s = await selectKey(account);
    expect(s.fromPool).toBe(false);
    expect(s.missReason).toBe("exhausted");
    // K2 still falls back — the account key has its own budget, so trying is
    // strictly better than failing. K3 turns this into an error.
    expect(s.creds.keyId).toBe("ACCOUNT_KEY");
  });

  it("the two reasons are distinguishable, which is the point", async () => {
    listPoolKeys.mockResolvedValue([]);
    const empty = await selectKey(account);
    __resetSelectorForTests();
    listPoolKeys.mockResolvedValue([poolKey("K1", new Date(Date.now() + 60_000))]);
    const exhausted = await selectKey(account);
    expect(empty.missReason).not.toBe(exhausted.missReason);
  });

  it("an EXPIRED cooldown is not a cooldown — the key comes back", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1", new Date(Date.now() - 1000))]);
    const s = await selectKey(account);
    expect(s.fromPool).toBe(true);
    expect(s.creds.keyId).toBe("K1");
  });
});

describe("selectKey — round robin", () => {
  it("hands out each key in turn, then wraps", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2"), poolKey("K3")]);
    const picked = [];
    for (let i = 0; i < 6; i++) picked.push((await selectKey(account)).creds.keyId);
    expect(picked).toEqual(["K1", "K2", "K3", "K1", "K2", "K3"]);
  });

  it("keeps the account's issuer and identity — only the key material changes", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1")]);
    const s = await selectKey(account);
    expect(s.creds.keyId).toBe("K1");
    expect(s.creds.privateKey).toBe("pk-K1");
    // ⚠ A JWT whose kid and iss disagree fails as a 401 — which reads like a
    // bad key rather than bad wiring.
    expect(s.creds.issuerId).toBe("issuer-1");
    expect(s.creds.id).toBe("acct-a");
  });

  it("cursors are per account", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2")]);
    await selectKey(account);
    const other = { ...account, id: "acct-b" };
    // acct-b starts its own rotation at the first key, not where acct-a left off.
    expect((await selectKey(other)).creds.keyId).toBe("K1");
  });
});

describe("markKeyRateLimited — the retry must not re-pick the spent key", () => {
  it("⚠ a marked key is skipped by the very next selection", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2")]);
    const first = await selectKey(account);
    expect(first.creds.keyId).toBe("K1");

    markKeyRateLimited(account.id, "K1", null);

    // This is the retry attempt. It must not be handed K1 again.
    const second = await selectKey(account);
    expect(second.creds.keyId).toBe("K2");
    const third = await selectKey(account);
    expect(third.creds.keyId).toBe("K2");
  });

  it("marking every key produces the exhausted signal, not an empty one", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2")]);
    markKeyRateLimited(account.id, "K1", null);
    markKeyRateLimited(account.id, "K2", null);
    const s = await selectKey(account);
    expect(s.missReason).toBe("exhausted");
  });

  it("honours Apple's Retry-After when it sent one", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1")]);
    markKeyRateLimited(account.id, "K1", 50);
    expect((await selectKey(account)).fromPool).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    // Short Retry-After → back in rotation quickly, rather than idle for the
    // conservative fallback hour.
    expect((await selectKey(account)).creds.keyId).toBe("K1");
  });

  it("a marking is scoped to its account", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1")]);
    markKeyRateLimited("acct-a", "K1", null);
    expect((await selectKey({ ...account, id: "acct-b" })).creds.keyId).toBe("K1");
  });
});

describe("⚠ a broken pool degrades to the account key — it is not a new failure mode", () => {
  it("a DB error falls back instead of throwing", async () => {
    // Reading the pool adds a DB round-trip to a path that had none. If that
    // could throw, one Supabase blip would take down every Apple request in
    // the module — including the ones that would have succeeded on the
    // account key, exactly as they did before the pool existed.
    listPoolKeys.mockRejectedValue(new Error("connection refused"));
    const s = await selectKey(account);
    expect(s.fromPool).toBe(false);
    expect(s.missReason).toBe("error");
    expect(s.creds.keyId).toBe("ACCOUNT_KEY");
  });

  it("a decrypt failure falls back too — one bad row is not an outage", async () => {
    listPoolKeys.mockRejectedValue(
      new Error('Failed to decrypt pool key "BAD" for account "acct-a".'),
    );
    await expect(selectKey(account)).resolves.toMatchObject({
      fromPool: false,
      missReason: "error",
    });
  });

  it("and it WARNS — degrading quietly would hide a real operational fault", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listPoolKeys.mockRejectedValue(new Error("boom"));
    await selectKey(account);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("acct-a"));
    warn.mockRestore();
  });

  it('"error" is distinct from "empty" — a broken pool is not an unpooled account', async () => {
    listPoolKeys.mockRejectedValue(new Error("boom"));
    const broken = await selectKey(account);
    listPoolKeys.mockResolvedValue([]);
    const unpooled = await selectKey(account);
    expect(broken.missReason).not.toBe(unpooled.missReason);
  });
});
