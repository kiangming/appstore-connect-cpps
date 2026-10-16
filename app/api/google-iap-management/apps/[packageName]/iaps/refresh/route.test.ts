/**
 * D0 [arc-google-missing-purchase-options] — the IAP refresh route is the ONLY
 * writer of apps.iaps_last_synced_at, and it stamps ONLY a complete mirror.
 *
 * Why the rule is "full list fetched AND failed === 0": bulk import treats a
 * stamped mirror as the truth about which SKUs exist. A refresh that left some
 * products out of the mirror (failed > 0) would make those SKUs preview as
 * NEW — the incident shape. Census also measured that a refresh can answer
 * 200 {ok:true, synced:0, failed:28}; that must not unblock bulk import.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const listAccounts = vi.hoisted(() => vi.fn());
const getEncryptedCredentials = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
  getEncryptedCredentials,
}));

const getAppByPackage = vi.hoisted(() => vi.fn());
const markIapsMirrorSynced = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage,
  markIapsMirrorSynced,
}));

const batchSyncIapsFromGoogle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/iaps", () => ({ batchSyncIapsFromGoogle }));

const appendAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({ appendAction }));

const listInAppProducts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/publisher-client", () => ({ listInAppProducts }));

const jwtClientFromEncrypted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/google/auth", () => ({ jwtClientFromEncrypted }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

import { POST } from "./route";

const ctx = { params: { packageName: "com.vnggames.ballisticherotwid" } };
const req = () => new Request("http://localhost/api/x", { method: "POST" });
const noFlags = { flagged: 0, unflagged: 0, flaggedSkus: [], unflaggedSkus: [], skippedReason: null };

beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { email: "m@vng.com.vn" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  getEncryptedCredentials.mockReset().mockResolvedValue({ enc: "x" });
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  jwtClientFromEncrypted.mockReset().mockReturnValue({});
  getAppByPackage.mockReset().mockResolvedValue({ id: "app-1" });
  markIapsMirrorSynced.mockReset().mockResolvedValue(undefined);
  appendAction.mockReset().mockResolvedValue(undefined);
  listInAppProducts.mockReset().mockResolvedValue(new Array(28).fill({ sku: "s" }));
  batchSyncIapsFromGoogle
    .mockReset()
    .mockResolvedValue({ synced: 28, failed: 0, flagReconcile: noFlags });
});

describe("IAP refresh — D0 stamps only a complete mirror", () => {
  it("full list + 0 failed ⇒ stamps THIS app row once, and returns the stamp", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(markIapsMirrorSynced).toHaveBeenCalledTimes(1);
    const [appId, at] = markIapsMirrorSynced.mock.calls[0] as [string, string];
    expect(appId).toBe("app-1");
    const body = (await res.json()) as { mirror_complete: boolean; mirror_synced_at: string | null };
    expect(body.mirror_complete).toBe(true);
    expect(body.mirror_synced_at).toBe(at);
    expect(Number.isNaN(Date.parse(at))).toBe(false);
  });

  it("some products failed to cache ⇒ NO stamp, mirror_complete false, null stamp in the response", async () => {
    batchSyncIapsFromGoogle.mockResolvedValue({ synced: 0, failed: 28, flagReconcile: noFlags });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(markIapsMirrorSynced).not.toHaveBeenCalled();
    const body = (await res.json()) as { mirror_complete: boolean; mirror_synced_at: string | null };
    expect(body.mirror_complete).toBe(false);
    expect(body.mirror_synced_at).toBeNull();
  });

  it("list fetch failed ⇒ 500, NO stamp", async () => {
    listInAppProducts.mockRejectedValue(new Error("list: new API failed (INTERNAL) boom"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect(markIapsMirrorSynced).not.toHaveBeenCalled();
  });

  it("stamp write failed ⇒ 500 — never 'ok' while bulk import would still see 'never synced'", async () => {
    markIapsMirrorSynced.mockRejectedValue(
      new Error("Failed to record IAP mirror sync time: expected 1 app row updated, got 0."),
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/expected 1 app row updated, got 0/);
    // The sync itself happened and is audited before the stamp is attempted.
    expect(appendAction).toHaveBeenCalledTimes(1);
  });
});
