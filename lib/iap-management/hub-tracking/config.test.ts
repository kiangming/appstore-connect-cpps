import { describe, it, expect, vi, beforeEach } from "vitest";

// Test-only 32-byte hex key — NOT a real secret. Set before any import so
// lib/asc-crypto.ts's module-level env read (inside its functions) sees it.
process.env.ENCRYPTION_KEY = "a".repeat(64);

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({ iapDb: () => ({ from: fromMock }) }));

import {
  getActiveHubTrackingCredentials,
  getHubTrackingConfigPublic,
  saveHubTrackingConfig,
  resolveTokenForValidation,
  invalidateHubTrackingCache,
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
  invalidateHubTrackingCache();
  selectResult = { data: null, error: null };
  upsertCalls = [];
  upsertResult = { error: null };
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

  it("caches the row — a second call within TTL doesn't re-query", async () => {
    selectResult = { data: makeRow(), error: null };
    await getActiveHubTrackingCredentials();
    await getActiveHubTrackingCredentials();
    expect(fromMock).toHaveBeenCalledTimes(1);
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
  it("throws when configuring for the first time without a token", async () => {
    await expect(
      saveHubTrackingConfig({ workflowId: "wf", enabled: true, updatedBy: "a@b.com" }),
    ).rejects.toThrow(/Token is required/);
    expect(upsertCalls).toHaveLength(0);
  });

  it("includes an encrypted token_enc on first-time save", async () => {
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

  it("keeps the existing token when omitted on update — no token_enc key in the payload", async () => {
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

  it("invalidates the cache so a subsequent read reflects the save", async () => {
    await getHubTrackingConfigPublic(); // populate cache with "no row"
    selectResult = { data: makeRow(), error: null };
    await saveHubTrackingConfig({
      workflowId: "wf",
      token: "secret",
      enabled: true,
      updatedBy: "a@b.com",
    });
    const result = await getHubTrackingConfigPublic();
    expect(result.configured).toBe(true);
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
