/**
 * ⚠ A POOL KEY MUST NEVER LEAVE ITS ACCOUNT.
 *
 * This is the invariant the Manager is UAT-ing before seeding keys for five
 * accounts, and it was the one thing the pool suite did NOT hold: deleting
 * `.eq("account_id", accountId)` from the read left all 45 existing tests
 * green. `repository.test.ts` stubbed the query builder so every method
 * returned itself, and `selector.test.ts` mocks `listPoolKeys` outright — so
 * between them, nothing ever observed the filter.
 *
 * Nothing else stands in the way either. `account_id` is a soft TEXT
 * reference with NO foreign key (schema isolation forbids a cross-schema FK),
 * so Postgres will not catch a wrong id, and `UNIQUE (account_id, key_id)` is
 * a PAIR — the same key_id is legal under two different accounts.
 *
 * ⚠ WHY THE FAKE DB FILTERS FOR REAL rather than just recording calls. A
 * spy-only test proves the code CALLED `.eq`; it cannot prove the call had an
 * effect. Here `from()` returns rows the way Postgres would — honouring the
 * eq() predicates that were actually applied — so dropping the filter does
 * not fail an assertion about a call, it makes account A genuinely receive
 * account B's key, which is the real defect. The real repository and the real
 * selector both run; only the database and the cipher are faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const decryptPrivateKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-crypto", () => ({ decryptPrivateKey }));

const iapDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb }));

import { listPoolKeys, __resetPoolKeyCacheForTests } from "./repository";
import { selectKey, __resetSelectorForTests } from "./selector";
import type { AscCredentials } from "@/lib/asc-jwt";

interface KeyRow {
  id: string;
  account_id: string;
  key_id: string;
  private_key_enc: string;
  /** ⚠ Widened on purpose — the exhaustion fixture below rewrites it to a
   *  timestamp, and an inferred `null` literal would reject that. */
  cooldown_until: string | null;
  enabled: boolean;
}

/** Two accounts on two different Apple teams, each with its own pool. */
const TABLE: KeyRow[] = [
  { id: "r1", account_id: "acct-a", key_id: "AAAA1111", private_key_enc: "enc:AAAA1111", cooldown_until: null, enabled: true },
  { id: "r2", account_id: "acct-a", key_id: "AAAA2222", private_key_enc: "enc:AAAA2222", cooldown_until: null, enabled: true },
  { id: "r3", account_id: "acct-b", key_id: "BBBB9999", private_key_enc: "enc:BBBB9999", cooldown_until: null, enabled: true },
  { id: "r4", account_id: "acct-b", key_id: "BBBB8888", private_key_enc: "enc:BBBB8888", cooldown_until: null, enabled: true },
];

const A: AscCredentials = {
  id: "acct-a", name: "Account A", keyId: "A_OWN_KEY",
  issuerId: "issuer-A", privateKey: "pk-account-A",
};
const B: AscCredentials = {
  id: "acct-b", name: "Account B", keyId: "B_OWN_KEY",
  issuerId: "issuer-B", privateKey: "pk-account-B",
};

/** Every `.eq(col, val)` the code applied, in order. */
let eqCalls: Array<[string, unknown]> = [];

/**
 * A query builder that behaves like the table. `.eq()` narrows the row set
 * exactly as Postgres would, so a filter the code FAILS to apply is a filter
 * whose rows come back.
 */
function fakeDb(rows: KeyRow[]) {
  return {
    from: () => {
      let current = [...rows];
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.order = self;
      b.update = self;
      b.eq = (col: string, val: unknown) => {
        eqCalls.push([col, val]);
        current = current.filter(
          (r) => (r as unknown as Record<string, unknown>)[col] === val,
        );
        return b;
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: current, error: null }).then(res, rej);
      return b;
    },
  };
}

beforeEach(() => {
  __resetPoolKeyCacheForTests();
  __resetSelectorForTests();
  eqCalls = [];
  decryptPrivateKey.mockReset().mockImplementation((v: string) => `dec(${v})`);
  iapDb.mockReset().mockImplementation(() => fakeDb(TABLE));
});

// ─── (i) the filter is applied ──────────────────────────────────────────────

describe("the read is scoped to one account", () => {
  it("⚠ filters on account_id — the exact mutation that used to survive", () => {
    return listPoolKeys("acct-a").then(() => {
      expect(eqCalls).toContainEqual(["account_id", "acct-a"]);
    });
  });

  it("still filters on enabled as well", async () => {
    await listPoolKeys("acct-a");
    expect(eqCalls).toContainEqual(["enabled", true]);
  });

  it("⚠ and the filter has an EFFECT — only that account's rows come back", async () => {
    // The assertion the spy cannot make: calling `.eq` is not the same as the
    // call narrowing anything.
    const keys = await listPoolKeys("acct-a");
    expect(keys.map((k) => k.keyId).sort()).toEqual(["AAAA1111", "AAAA2222"]);
    expect(keys.some((k) => k.keyId.startsWith("BBBB"))).toBe(false);
  });

  it("account B gets B's rows, and only those", async () => {
    const keys = await listPoolKeys("acct-b");
    expect(keys.map((k) => k.keyId).sort()).toEqual(["BBBB8888", "BBBB9999"]);
  });
});

// ─── (ii) selection never crosses ───────────────────────────────────────────

describe("⚠ selectKey never hands one account another account's key", () => {
  it("A rotates only through A's keys, across many turns", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const sel = await selectKey(A);
      expect(sel.fromPool).toBe(true);
      seen.add(sel.creds.keyId);
    }
    // Round-robin over exactly A's two keys, wrapping — and B's never appear.
    expect([...seen].sort()).toEqual(["AAAA1111", "AAAA2222"]);
  });

  it("B rotates only through B's keys, across many turns", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add((await selectKey(B)).creds.keyId);
    expect([...seen].sort()).toEqual(["BBBB8888", "BBBB9999"]);
  });

  it("⚠ interleaving the two accounts does not mix their pools", async () => {
    // The shape a real server has: concurrent requests for different
    // accounts hitting the same module-scoped cursor/cache maps.
    for (let i = 0; i < 8; i++) {
      expect((await selectKey(A)).creds.keyId).toMatch(/^AAAA/);
      expect((await selectKey(B)).creds.keyId).toMatch(/^BBBB/);
    }
  });

  it("⚠ the team-scoped fields stay the ACCOUNT's — a swapped key cannot borrow a team", async () => {
    // If a key ever did cross accounts, this is what stops it becoming
    // access to the other team's data: the JWT is signed with THIS account's
    // issuer, so Apple answers 401 rather than serving someone else's app.
    const sel = await selectKey(A);
    expect(sel.creds.issuerId).toBe("issuer-A");
    expect(sel.creds.id).toBe("acct-a");
    expect(sel.creds.name).toBe("Account A");
  });
});

// ─── (iii) exhaustion stays inside the account ──────────────────────────────

describe("⚠ an exhausted pool falls back INSIDE the account", () => {
  const cooled = () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return TABLE.map((r) =>
      r.account_id === "acct-a" ? { ...r, cooldown_until: until } : r,
    );
  };

  beforeEach(() => {
    iapDb.mockReset().mockImplementation(() => fakeDb(cooled()));
  });

  it('reports "exhausted" for A — not "empty", and not a B key', async () => {
    const sel = await selectKey(A);
    expect(sel.fromPool).toBe(false);
    expect(sel.missReason).toBe("exhausted");
    expect(sel.creds.keyId).toBe("A_OWN_KEY");
  });

  it("⚠ falls back to A's OWN key — never borrows B's healthy pool", async () => {
    // The failure this test exists for: a pool that "helpfully" reaches for
    // any available key would send account A's request signed with account
    // B's credentials. Cross-account borrowing must not be a recovery path.
    const sel = await selectKey(A);
    expect(sel.creds.privateKey).toBe("pk-account-A");
    expect(sel.creds.keyId).not.toMatch(/^BBBB/);
  });

  it("⚠ and B is UNAFFECTED — one account's exhaustion is not the pool's", async () => {
    const sel = await selectKey(B);
    expect(sel.fromPool).toBe(true);
    expect(sel.creds.keyId).toMatch(/^BBBB/);
  });
});
