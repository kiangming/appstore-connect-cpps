/**
 * [#5] CLEARING A COOLDOWN — and the trap that clearing the DB alone is not enough.
 *
 * ⚠ THE ASSERTION THIS FILE EXISTS FOR is the one that fails when someone
 * "simplifies" the route to a single UPDATE. `isCoolingDown` checks the
 * process-local Map FIRST and returns true on a live marker WITHOUT reading
 * the row (selector.ts:124-125), so a DB-only clear leaves the running
 * instance refusing every key for the rest of the hour while the table looks
 * clean. That is the shape the cooldown-misattribution incident took, and the
 * only thing that catches it is a test that clears one half and checks the key
 * is STILL refused.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  selectKey,
  markKeyRateLimited,
  clearInMemoryCooldowns,
  __resetSelectorForTests,
} from "./selector";
import type { AscCredentials } from "@/lib/asc-jwt";

const ACCOUNT: AscCredentials = {
  id: "acct-1",
  name: "Acct",
  issuerId: "iss",
  keyId: "ACCOUNT_KEY",
  privateKey: "pk-account",
};

/** Two pool keys, neither cooled in the DB. */
const dbKeys = [
  { id: "row-a", keyId: "K_A", privateKey: "pk-a", cooldownUntil: null },
  { id: "row-b", keyId: "K_B", privateKey: "pk-b", cooldownUntil: null },
];

vi.mock("./repository", () => ({
  listPoolKeys: vi.fn(async () => dbKeys),
  persistCooldown: vi.fn(async () => {}),
  poolKeyToCredentials: (
    account: AscCredentials,
    key: { keyId: string; privateKey: string },
  ) => ({ ...account, keyId: key.keyId, privateKey: key.privateKey }),
}));

beforeEach(() => {
  __resetSelectorForTests();
  vi.clearAllMocks();
});

describe("clearInMemoryCooldowns — the half a SQL UPDATE cannot reach", () => {
  /**
   * ⚠ THE TRAP, ASSERTED. The DB mock reports NO cooldown on either key
   * throughout this test — that is a DB-only clear, exactly what SQL does.
   * The keys are still refused, because the in-memory markers are live.
   */
  it("⚠ with the DB already clean, in-memory markers STILL refuse every key", async () => {
    await markKeyRateLimited(ACCOUNT.id, "K_A", null);
    await markKeyRateLimited(ACCOUNT.id, "K_B", null);

    const sel = await selectKey(ACCOUNT);
    expect(sel.fromPool).toBe(false);
    expect(sel.missReason).toBe("exhausted");
    // ⚠ And the DB said nothing was cooling — proving the refusal is local.
    expect(dbKeys.every((k) => k.cooldownUntil === null)).toBe(true);
  });

  it("clearing the in-memory half puts the keys back in rotation", async () => {
    await markKeyRateLimited(ACCOUNT.id, "K_A", null);
    await markKeyRateLimited(ACCOUNT.id, "K_B", null);
    expect((await selectKey(ACCOUNT)).missReason).toBe("exhausted");

    const dropped = clearInMemoryCooldowns(ACCOUNT.id);

    expect(dropped).toBe(2);
    const sel = await selectKey(ACCOUNT);
    expect(sel.fromPool).toBe(true);
  });

  /**
   * ⚠ ONE KEY IS ENOUGH. The refusal is `eligible.length === 0`
   * (selector.ts:204-206), so the route deliberately offers a per-row action
   * rather than a "clear all": the smallest intervention that works.
   */
  it("one key freed is enough to end the exhausted state", async () => {
    await markKeyRateLimited(ACCOUNT.id, "K_A", null);
    await markKeyRateLimited(ACCOUNT.id, "K_B", null);
    // Simulate clearing only K_A's marker by clearing all then re-parking K_B.
    clearInMemoryCooldowns(ACCOUNT.id);
    await markKeyRateLimited(ACCOUNT.id, "K_B", null);

    const sel = await selectKey(ACCOUNT);
    expect(sel.fromPool).toBe(true);
    expect(sel.creds.keyId).toBe("K_A");
  });

  it("is scoped to one account — another account's markers survive", async () => {
    await markKeyRateLimited(ACCOUNT.id, "K_A", null);
    await markKeyRateLimited("other-acct", "K_A", null);

    const dropped = clearInMemoryCooldowns(ACCOUNT.id);

    expect(dropped).toBe(1);
    // The other account's marker is still there: clearing it again finds one.
    expect(clearInMemoryCooldowns("other-acct")).toBe(1);
  });

  it("with no argument it clears every account", async () => {
    await markKeyRateLimited(ACCOUNT.id, "K_A", null);
    await markKeyRateLimited("other-acct", "K_B", null);
    expect(clearInMemoryCooldowns()).toBe(2);
    expect(clearInMemoryCooldowns()).toBe(0);
  });

  it("clearing when nothing is parked is a no-op returning 0", () => {
    expect(clearInMemoryCooldowns(ACCOUNT.id)).toBe(0);
  });

  /**
   * ⚠ IT MUST NOT TOUCH THE ROUND-ROBIN CURSOR. `__resetSelectorForTests`
   * clears `cursors` too, which is fixture hygiene; doing that on an operator
   * action would re-bias rotation toward the first key for no reason. Same
   * Map, different intent — the two functions stay separate.
   */
  it("⚠ leaves the round-robin cursor alone, unlike the test-only reset", async () => {
    const first = await selectKey(ACCOUNT);
    expect(first.creds.keyId).toBe("K_A");
    clearInMemoryCooldowns(ACCOUNT.id);
    const second = await selectKey(ACCOUNT);
    // Cursor advanced despite the clear — K_B, not K_A again.
    expect(second.creds.keyId).toBe("K_B");
  });
});
