/**
 * K2 — key selection, cooldown, and the two different kinds of "no key".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listPoolKeys = vi.hoisted(() => vi.fn());
const persistCooldown = vi.hoisted(() => vi.fn());
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, listPoolKeys, persistCooldown };
});

import {
  selectKey,
  markKeyRateLimited,
  cooldownDurationMs,
  __resetSelectorForTests,
} from "./selector";
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
  persistCooldown.mockReset().mockResolvedValue(undefined);
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

    await markKeyRateLimited(account.id, "K1", null);

    // This is the retry attempt. It must not be handed K1 again.
    const second = await selectKey(account);
    expect(second.creds.keyId).toBe("K2");
    const third = await selectKey(account);
    expect(third.creds.keyId).toBe("K2");
  });

  it("marking every key produces the exhausted signal, not an empty one", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2")]);
    await markKeyRateLimited(account.id, "K1", null);
    await markKeyRateLimited(account.id, "K2", null);
    const s = await selectKey(account);
    expect(s.missReason).toBe("exhausted");
  });

  it("honours Apple's Retry-After when it sent one", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1")]);
    await markKeyRateLimited(account.id, "K1", 50);
    expect((await selectKey(account)).fromPool).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    // Short Retry-After → back in rotation quickly, rather than idle for the
    // conservative fallback hour.
    expect((await selectKey(account)).creds.keyId).toBe("K1");
  });

  it("a marking is scoped to its account", async () => {
    listPoolKeys.mockResolvedValue([poolKey("K1")]);
    await markKeyRateLimited("acct-a", "K1", null);
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

describe("K3 — the cooldown is durable, and its duration is a rolling hour", () => {
  it("⚠ persists to the column so a SIBLING INSTANCE sees it", async () => {
    // The in-memory marker only protects this process. Another Railway
    // instance learns about a spent key exactly one way: this write.
    await markKeyRateLimited("acct-a", "K1", null);
    expect(persistCooldown).toHaveBeenCalledWith("acct-a", "K1", expect.any(Date));
  });

  it("⚠ the in-memory marker is set EVEN IF the write fails", async () => {
    // The retry this exists to protect runs microseconds from now, in this
    // process. It must not depend on a DB round-trip having succeeded.
    persistCooldown.mockRejectedValue(new Error("db down"));
    listPoolKeys.mockResolvedValue([poolKey("K1"), poolKey("K2")]);
    await markKeyRateLimited("acct-a", "K1", null).catch(() => {});
    expect((await selectKey(account)).creds.keyId).toBe("K2");
  });

  it("the persisted deadline matches the in-memory one", async () => {
    const before = Date.now();
    await markKeyRateLimited("acct-a", "K1", null);
    const until = persistCooldown.mock.calls[0][2] as Date;
    const ms = until.getTime() - before;
    // One rolling hour, within scheduling slop.
    expect(ms).toBeGreaterThan(59 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });
});

describe("cooldownDurationMs", () => {
  const HOUR = 60 * 60 * 1000;

  it("⚠ defaults to the rolling hour — the FALLBACK is the load-bearing path", () => {
    // Whether Apple sends Retry-After on an IAP-endpoint 429 has never been
    // observed here, and those endpoints are known not to send x-rate-limit
    // at all. Assuming the other header would repeat the Hotfix 25 mistake.
    expect(cooldownDurationMs(null)).toBe(HOUR);
    expect(cooldownDurationMs(undefined)).toBe(HOUR);
    expect(cooldownDurationMs(0)).toBe(HOUR);
  });

  it("honours a real Retry-After — it can only ever SHORTEN the wait", () => {
    expect(cooldownDurationMs(5000)).toBe(5000);
  });

  it("⚠ never exceeds the rolling window, whatever Apple claims", () => {
    // A malformed or absurd Retry-After must not park a key for a day.
    expect(cooldownDurationMs(99 * HOUR)).toBe(HOUR);
  });

  it("a negative value is not a duration — falls back", () => {
    expect(cooldownDurationMs(-5)).toBe(HOUR);
  });
});

/**
 * ⚠ THE POINT OF A DURABLE COOLDOWN, PROVEN BEHAVIOURALLY.
 *
 * Asserting that `persistCooldown` was called is a mock assertion — it
 * passes for a write that goes nowhere. What actually matters is that a
 * DIFFERENT Railway instance, which shares none of this process's memory,
 * stops handing out the spent key. That instance is simulated by wiping the
 * in-memory selector state (a fresh process has none) while a fake store
 * keeps what the write left behind.
 */
describe("K3 — a sibling instance honours a cooldown it never observed", () => {
  /** Stands in for the `cooldown_until` column. */
  const stored = new Map<string, Date>();

  beforeEach(() => {
    stored.clear();
    persistCooldown.mockReset().mockImplementation(
      async (acct: string, keyId: string, until: Date) => {
        stored.set(`${acct}::${keyId}`, until);
      },
    );
    // Reads reflect whatever the column holds, exactly as the real one does.
    listPoolKeys.mockReset().mockImplementation(async (acct: string) =>
      ["K1", "K2"].map((k) => poolKey(k, stored.get(`${acct}::${k}`) ?? null)),
    );
  });

  it("⚠ instance B skips the key instance A burned", async () => {
    // ── instance A ──
    const first = await selectKey(account);
    expect(first.creds.keyId).toBe("K1");
    await markKeyRateLimited(account.id, "K1", null);

    // ── instance B: fresh process, no in-memory marks, no round-robin cursor ──
    __resetSelectorForTests();

    const onB = await selectKey(account);
    expect(onB.creds.keyId).toBe("K2");
  });

  it("⚠ and when A burned them all, B sees an exhausted pool — not a healthy one", async () => {
    await markKeyRateLimited(account.id, "K1", null);
    await markKeyRateLimited(account.id, "K2", null);

    __resetSelectorForTests();

    const onB = await selectKey(account);
    expect(onB.fromPool).toBe(false);
    expect(onB.missReason).toBe("exhausted");
  });

  it("an EXPIRED stored cooldown does not keep the key out", async () => {
    stored.set(`${account.id}::K1`, new Date(Date.now() - 1000));
    __resetSelectorForTests();
    expect((await selectKey(account)).creds.keyId).toBe("K1");
  });
});
