import { describe, it, expect, vi, beforeEach } from "vitest";

// Test-only 32-byte hex key — NOT a real secret. Set before any import so
// lib/asc-crypto.ts's module-level env read (inside its functions) sees it.
process.env.ENCRYPTION_KEY = "a".repeat(64);

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => ({ from: fromMock }) }));

const log = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ log }));

import {
  getActiveHubTrackingCredentials,
  getHubTrackingGate,
  getHubTrackingConfigPublic,
  saveHubTrackingConfig,
  resolveTokenForValidation,
} from "./config";
import { encryptPrivateKey } from "@/lib/asc-crypto";

interface Row {
  id: string;
  workflow_id: string;
  token_enc: string;
  enabled: boolean;
  updated_at: string;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "default",
    workflow_id: "iap-bulk-import",
    token_enc: encryptPrivateKey("real-secret-token"),
    enabled: true,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

let selectResult: { data: Row | null; error: { message: string } | null } = {
  data: null,
  error: null,
};
let upsertCalls: Array<{ payload: Record<string, unknown>; opts: unknown }> = [];
let upsertResult: { error: { message: string } | null } = { error: null };

function makeSelectChain() {
  const chain: {
    select: () => typeof chain;
    eq: () => typeof chain;
    maybeSingle: () => Promise<typeof selectResult>;
  } = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(selectResult),
  };
  return chain;
}

beforeEach(() => {
  selectResult = { data: null, error: null };
  upsertCalls = [];
  upsertResult = { error: null };
  log.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation((table: string) => {
    expect(table).toBe("hub_tracking_config");
    return {
      ...makeSelectChain(),
      upsert: (payload: Record<string, unknown>, opts: unknown) => {
        upsertCalls.push({ payload, opts });
        return Promise.resolve(upsertResult);
      },
    };
  });
});

describe("no in-memory cache — every read hits the DB", () => {
  // Root-cause fix for two Manager-reported bugs: a stale cached read (up
  // to 5 min, or on a different Railway process/replica than the one that
  // wrote) made a blank-token save wrongly see "no existing row" (Part 2)
  // and made the `enabled` toggle appear to silently revert across
  // sessions (Part 3). This table is read only a handful of times per
  // bulk-import batch — nowhere near hot enough to justify the staleness
  // risk a cache introduces.
  it("getActiveHubTrackingCredentials re-queries on every call, never caches", async () => {
    selectResult = { data: makeRow(), error: null };
    await getActiveHubTrackingCredentials();
    await getActiveHubTrackingCredentials();
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  it("a save is immediately visible to the very next read — no TTL window", async () => {
    selectResult = { data: null, error: null };
    await expect(getHubTrackingConfigPublic()).resolves.toMatchObject({ configured: false });

    selectResult = { data: makeRow(), error: null };
    await expect(getHubTrackingConfigPublic()).resolves.toMatchObject({ configured: true });
  });
});

describe("getHubTrackingGate — GATE logging source of truth", () => {
  it("reports configured=false enabled=false credentials=null when no row exists", async () => {
    await expect(getHubTrackingGate()).resolves.toEqual({
      configured: false,
      enabled: false,
      credentials: null,
    });
  });

  it("reports configured=true enabled=false credentials=null when the toggle is off", async () => {
    selectResult = { data: makeRow({ enabled: false }), error: null };
    await expect(getHubTrackingGate()).resolves.toEqual({
      configured: true,
      enabled: false,
      credentials: null,
    });
  });

  it("reports full credentials when configured and enabled", async () => {
    selectResult = {
      data: makeRow({ workflow_id: "wf-x", token_enc: encryptPrivateKey("shh") }),
      error: null,
    };
    await expect(getHubTrackingGate()).resolves.toEqual({
      configured: true,
      enabled: true,
      credentials: { workflowId: "wf-x", token: "shh" },
    });
  });

  it("returns credentials:null (not a throw) when the token fails to decrypt", async () => {
    selectResult = { data: makeRow({ token_enc: "not-valid-base64-ciphertext" }), error: null };
    const gate = await getHubTrackingGate();
    expect(gate.configured).toBe(true);
    expect(gate.enabled).toBe(true);
    expect(gate.credentials).toBeNull();
  });
});

describe("getActiveHubTrackingCredentials — the one no-op gate", () => {
  it("returns null when no row exists (unconfigured)", async () => {
    await expect(getActiveHubTrackingCredentials()).resolves.toBeNull();
  });

  it("returns null when the row exists but enabled is false (Settings toggle off)", async () => {
    selectResult = { data: makeRow({ enabled: false }), error: null };
    await expect(getActiveHubTrackingCredentials()).resolves.toBeNull();
  });

  it("returns decrypted credentials when configured and enabled", async () => {
    selectResult = {
      data: makeRow({ workflow_id: "wf-x", token_enc: encryptPrivateKey("shh") }),
      error: null,
    };
    await expect(getActiveHubTrackingCredentials()).resolves.toEqual({
      workflowId: "wf-x",
      token: "shh",
    });
  });

  it("throws when the underlying query errors", async () => {
    selectResult = { data: null, error: { message: "db down" } };
    await expect(getActiveHubTrackingCredentials()).rejects.toThrow(/db down/);
  });
});

describe("getHubTrackingConfigPublic — never returns the token", () => {
  it("reports not configured when no row exists", async () => {
    await expect(getHubTrackingConfigPublic()).resolves.toEqual({
      workflow_id: "",
      configured: false,
      enabled: false,
      updated_at: null,
    });
  });

  it("reports workflow_id/configured/enabled/updated_at and nothing else", async () => {
    selectResult = { data: makeRow({ enabled: false }), error: null };
    const result = await getHubTrackingConfigPublic();
    expect(result).toEqual({
      workflow_id: "iap-bulk-import",
      configured: true,
      enabled: false,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    expect(Object.keys(result).sort()).toEqual(
      ["workflow_id", "configured", "enabled", "updated_at"].sort(),
    );
  });
});

describe("saveHubTrackingConfig", () => {
  it("throws when configuring for the first time without a token (blank + NO existing token)", async () => {
    await expect(
      saveHubTrackingConfig({ workflowId: "wf", enabled: true, updatedBy: "a@b.com" }),
    ).rejects.toThrow(/Token is required/);
    expect(upsertCalls).toHaveLength(0);
  });

  it("includes an encrypted token_enc on first-time save (token value given)", async () => {
    await saveHubTrackingConfig({
      workflowId: "wf",
      token: "secret",
      enabled: true,
      updatedBy: "a@b.com",
    });
    expect(upsertCalls).toHaveLength(1);
    const payload = upsertCalls[0].payload;
    expect(payload.workflow_id).toBe("wf");
    expect(payload.enabled).toBe(true);
    expect(typeof payload.token_enc).toBe("string");
    expect(payload.token_enc).not.toBe("secret");
  });

  it("Part 2 fix — blank token + EXISTING token saved: succeeds, token_enc untouched, other fields updated", async () => {
    selectResult = { data: makeRow(), error: null };
    await saveHubTrackingConfig({
      workflowId: "wf-renamed",
      enabled: false,
      updatedBy: "a@b.com",
    });
    const payload = upsertCalls[0].payload;
    expect(payload).not.toHaveProperty("token_enc");
    expect(payload.workflow_id).toBe("wf-renamed");
    expect(payload.enabled).toBe(false);
  });

  it("overwrites the token when a new one is submitted on update", async () => {
    selectResult = { data: makeRow(), error: null };
    await saveHubTrackingConfig({
      workflowId: "wf",
      token: "new-secret",
      enabled: true,
      updatedBy: "a@b.com",
    });
    expect(upsertCalls[0].payload).toHaveProperty("token_enc");
  });

  it("Part 3 fix — enabled persists across a blank-token re-save (was silently reverting)", async () => {
    // First save: token + enabled=true, as if configuring for the first time.
    await saveHubTrackingConfig({
      workflowId: "wf",
      token: "secret",
      enabled: true,
      updatedBy: "a@b.com",
    });
    const firstPayload = upsertCalls[0].payload;
    expect(firstPayload.enabled).toBe(true);

    // Simulate the DB now holding that row, as a real DB would after the upsert.
    selectResult = {
      data: {
        id: "default",
        workflow_id: "wf",
        token_enc: firstPayload.token_enc as string,
        enabled: true,
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      error: null,
    };

    // GET reflects the persisted true — no staleness.
    await expect(getHubTrackingConfigPublic()).resolves.toMatchObject({
      enabled: true,
      configured: true,
    });

    // Re-save with a BLANK token (the exact reported bug scenario) — enabled
    // must stay true, not silently reset to false.
    await saveHubTrackingConfig({
      workflowId: "wf",
      enabled: true,
      updatedBy: "a@b.com",
    });
    const secondPayload = upsertCalls[1].payload;
    expect(secondPayload.enabled).toBe(true);
    expect(secondPayload).not.toHaveProperty("token_enc");
  });

  it("surfaces the Supabase error message on upsert failure", async () => {
    upsertResult = { error: { message: "constraint violation" } };
    await expect(
      saveHubTrackingConfig({
        workflowId: "wf",
        token: "secret",
        enabled: true,
        updatedBy: "a@b.com",
      }),
    ).rejects.toThrow(/constraint violation/);
  });
});

describe("resolveTokenForValidation — Settings save-time validation input", () => {
  it("returns the freshly submitted token without touching the DB", async () => {
    const token = await resolveTokenForValidation({ token: "fresh-token" });
    expect(token).toBe("fresh-token");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("falls back to the stored (decrypted) token when omitted", async () => {
    selectResult = { data: makeRow({ token_enc: encryptPrivateKey("stored-secret") }), error: null };
    await expect(resolveTokenForValidation({})).resolves.toBe("stored-secret");
  });

  it("returns null when omitted and nothing is stored", async () => {
    await expect(resolveTokenForValidation({})).resolves.toBeNull();
  });
});

describe("Railway logging — [hub-tracking] config: found/enabled, token never logged", () => {
  function loggedMessages(): string[] {
    return log.mock.calls.map((c) => String(c[1]));
  }

  it("logs found=false enabled=false when no row exists", async () => {
    await getHubTrackingConfigPublic();
    expect(loggedMessages()).toContain("[hub-tracking] config: found=false enabled=false");
  });

  it("logs found=true enabled=true when configured and enabled", async () => {
    selectResult = { data: makeRow({ enabled: true }), error: null };
    await getHubTrackingConfigPublic();
    expect(loggedMessages()).toContain("[hub-tracking] config: found=true enabled=true");
  });

  it("logs found=true enabled=false when configured but disabled", async () => {
    selectResult = { data: makeRow({ enabled: false }), error: null };
    await getHubTrackingConfigPublic();
    expect(loggedMessages()).toContain("[hub-tracking] config: found=true enabled=false");
  });

  it("logs a decrypt error without the token/ciphertext value", async () => {
    selectResult = { data: makeRow({ token_enc: "not-valid-base64-ciphertext" }), error: null };
    await getHubTrackingGate();
    const messages = loggedMessages();
    expect(messages.some((m) => m.startsWith("[hub-tracking] config: decrypt error (no token logged):"))).toBe(
      true,
    );
    expect(messages.join("\n")).not.toContain("not-valid-base64-ciphertext");
  });

  it("logs a DB read error without ever including token_enc", async () => {
    selectResult = { data: null, error: { message: "connection refused" } };
    await expect(getHubTrackingConfigPublic()).rejects.toThrow();
    expect(
      loggedMessages().some((m) => m.startsWith("[hub-tracking] config: read error (no token logged):")),
    ).toBe(true);
  });
});
