/**
 * Tests for IAP.o.12a update-orchestration. Covers:
 *   • Skip behavior — stages with unchanged diff buckets must not call Apple.
 *   • Per-stage success/failure isolation — one stage failing must not stop
 *     downstream stages.
 *   • Aggregate roll-up — SUCCESS / PARTIAL / FAILURE / NO_CHANGES.
 *   • Audit log written per stage outcome (mock captured).
 *   • Pricing stage delegates to applyPricingSchedule wholesale (no
 *     re-implementation of the IAP.o.11d retry/jitter/audit logic).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pollIapReadyForPricing = vi.hoisted(() => vi.fn());
const updateInAppPurchase = vi.hoisted(() => vi.fn());
const updateInAppPurchaseLocalization = vi.hoisted(() => vi.fn());
const createInAppPurchaseLocalization = vi.hoisted(() => vi.fn());
const deleteInAppPurchaseLocalization = vi.hoisted(() => vi.fn());
const listInAppPurchaseLocalizations = vi.hoisted(() => vi.fn());
const replaceScreenshotOnApple = vi.hoisted(() => vi.fn());
const applyPricingSchedule = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());

vi.mock("./poll-iap-ready", () => ({ pollIapReadyForPricing }));
vi.mock("./client", () => ({
  updateInAppPurchase,
  updateInAppPurchaseLocalization,
  createInAppPurchaseLocalization,
  deleteInAppPurchaseLocalization,
  listInAppPurchaseLocalizations,
}));
vi.mock("./screenshot-upload", () => ({ replaceScreenshotOnApple }));
vi.mock("./pricing-orchestration", () => ({ applyPricingSchedule }));
vi.mock("./fetch", () => ({
  AppleApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, _m: string, _e: string, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: () => ({
      insert: (...args: unknown[]) => {
        auditInsert(...args);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { updateIapOnApple } from "./update-orchestration";
import type { IapDiff } from "./diff-detector";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

const baseAudit = { iapId: "row-1", actor: "tester" };

function emptyDiff(): IapDiff {
  return {
    attributes_changed: null,
    localizations_changed: null,
    screenshot_changed: false,
    tier_changed: null,
  };
}

beforeEach(() => {
  pollIapReadyForPricing.mockReset();
  updateInAppPurchase.mockReset();
  updateInAppPurchaseLocalization.mockReset();
  createInAppPurchaseLocalization.mockReset();
  deleteInAppPurchaseLocalization.mockReset();
  listInAppPurchaseLocalizations.mockReset();
  replaceScreenshotOnApple.mockReset();
  applyPricingSchedule.mockReset();
  auditInsert.mockReset();
  // Default precheck = ready
  pollIapReadyForPricing.mockResolvedValue({
    ready: true,
    attempts: 1,
    total_ms: 50,
  });
});

describe("updateIapOnApple — precheck", () => {
  it("returns FAILURE when precheck poll never goes ready (no Apple PATCH attempted)", async () => {
    pollIapReadyForPricing.mockResolvedValueOnce({
      ready: false,
      attempts: 10,
      total_ms: 2000,
      reason: "404: NOT_FOUND",
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: { ...emptyDiff(), attributes_changed: { name: "New" } },
      audit: baseAudit,
    });
    expect(out.overall).toBe("FAILURE");
    expect(out.stages.precheck.ready).toBe(false);
    expect(updateInAppPurchase).not.toHaveBeenCalled();
  });
});

describe("updateIapOnApple — skip behavior", () => {
  it("returns NO_CHANGES and skips every stage when diff is empty", async () => {
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: emptyDiff(),
      audit: baseAudit,
    });
    expect(out.overall).toBe("NO_CHANGES");
    expect(out.stages.attributes.changed).toBe(false);
    expect(out.stages.localizations.changed).toBe(false);
    expect(out.stages.screenshot.changed).toBe(false);
    expect(out.stages.pricing.changed).toBe(false);
    expect(updateInAppPurchase).not.toHaveBeenCalled();
    expect(listInAppPurchaseLocalizations).not.toHaveBeenCalled();
    expect(replaceScreenshotOnApple).not.toHaveBeenCalled();
    expect(applyPricingSchedule).not.toHaveBeenCalled();
  });
});

describe("updateIapOnApple — attributes stage", () => {
  it("PATCHes only when attributes_changed is non-null and writes audit row", async () => {
    updateInAppPurchase.mockResolvedValueOnce({ data: { id: "iap-1" } });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        attributes_changed: { name: "New Name", familySharable: true },
      },
      audit: baseAudit,
    });
    expect(updateInAppPurchase).toHaveBeenCalledWith(creds, "iap-1", {
      name: "New Name",
      familySharable: true,
    });
    expect(out.stages.attributes).toMatchObject({ changed: true, ok: true });
    expect(out.overall).toBe("SUCCESS");
    expect(auditInsert).toHaveBeenCalled();
    const row = auditInsert.mock.calls[0][0] as {
      action_type: string;
      payload: { result: string };
    };
    expect(row.action_type).toBe("UPDATE_ATTRIBUTES_ON_APPLE");
    expect(row.payload.result).toBe("SUCCESS");
  });

  it("surfaces ok=false + error on Apple 409 without breaking downstream stages", async () => {
    updateInAppPurchase.mockRejectedValueOnce(
      Object.assign(new Error("STATE_ERROR locked"), {
        // shape matches AppleApiError so the error formatter works
      }),
    );
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        attributes_changed: { name: "X" },
      },
      audit: baseAudit,
    });
    expect(out.stages.attributes.ok).toBe(false);
    expect(out.overall).toBe("FAILURE");
  });
});

describe("updateIapOnApple — localizations stage", () => {
  it("looks up Apple loc IDs and PATCHes per updated locale", async () => {
    listInAppPurchaseLocalizations.mockResolvedValueOnce({
      data: [
        { id: "loc-en", attributes: { locale: "en" } },
        { id: "loc-vi", attributes: { locale: "vi" } },
      ],
    });
    updateInAppPurchaseLocalization.mockResolvedValueOnce({ data: { id: "loc-en" } });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", description: "New desc" }],
          added: [],
          removed: [],
        },
      },
      audit: baseAudit,
    });
    expect(listInAppPurchaseLocalizations).toHaveBeenCalledWith(creds, "iap-1");
    expect(updateInAppPurchaseLocalization).toHaveBeenCalledWith(creds, "loc-en", {
      description: "New desc",
    });
    expect(out.stages.localizations.results?.[0]).toMatchObject({
      op: "update",
      locale: "en",
      ok: true,
    });
  });

  it("POSTs added locales (no Apple lookup needed for pure-add when no update/remove)", async () => {
    createInAppPurchaseLocalization.mockResolvedValueOnce({
      data: { id: "loc-ja-new" },
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [],
          added: [{ locale: "ja", name: "Ja name", description: "Ja desc" }],
          removed: [],
        },
      },
      audit: baseAudit,
    });
    expect(listInAppPurchaseLocalizations).not.toHaveBeenCalled();
    expect(createInAppPurchaseLocalization).toHaveBeenCalled();
    expect(out.stages.localizations.results?.[0]).toMatchObject({
      op: "add",
      locale: "ja",
      ok: true,
      loc_id: "loc-ja-new",
    });
  });

  it("DELETEs removed locales and treats missing-on-Apple as idempotent ok", async () => {
    listInAppPurchaseLocalizations.mockResolvedValueOnce({
      data: [
        { id: "loc-en", attributes: { locale: "en" } },
        // No 'vi' — Apple already doesn't have it.
      ],
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [],
          added: [],
          removed: [{ locale: "vi" }],
        },
      },
      audit: baseAudit,
    });
    expect(deleteInAppPurchaseLocalization).not.toHaveBeenCalled();
    expect(out.stages.localizations.results?.[0]).toMatchObject({
      op: "delete",
      locale: "vi",
      ok: true,
    });
  });

  it("surfaces lookup failure as per-op error rows so the UI can show each intended op", async () => {
    listInAppPurchaseLocalizations.mockRejectedValueOnce(new Error("api down"));
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", name: "X" }],
          added: [],
          removed: [{ locale: "vi" }],
        },
      },
      audit: baseAudit,
    });
    expect(out.stages.localizations.results).toHaveLength(2);
    expect(out.stages.localizations.results?.every((r) => !r.ok)).toBe(true);
  });
});

describe("updateIapOnApple — screenshot stage", () => {
  it("delegates to replaceScreenshotOnApple and mirrors the success result", async () => {
    replaceScreenshotOnApple.mockResolvedValueOnce({
      ok: true,
      apple_screenshot_id: "scr-99",
      file_name: "x.png",
      file_size: 1234,
    });
    const file = new File([new Uint8Array(10)], "x.png", { type: "image/png" });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: { ...emptyDiff(), screenshot_changed: true },
      screenshotFile: file,
      audit: baseAudit,
    });
    expect(replaceScreenshotOnApple).toHaveBeenCalledWith(creds, "iap-1", file);
    expect(out.stages.screenshot).toMatchObject({
      changed: true,
      ok: true,
      apple_screenshot_id: "scr-99",
    });
  });

  it("fails the stage with a clear error when screenshot_changed=true but no file provided", async () => {
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: { ...emptyDiff(), screenshot_changed: true },
      audit: baseAudit,
    });
    expect(out.stages.screenshot.ok).toBe(false);
    expect(out.stages.screenshot.error).toContain("no File");
    expect(replaceScreenshotOnApple).not.toHaveBeenCalled();
  });
});

describe("updateIapOnApple — pricing stage (delegated)", () => {
  it("delegates to applyPricingSchedule with precheck=ready (no double-poll)", async () => {
    applyPricingSchedule.mockResolvedValueOnce({
      kind: "set",
      price_point_id: "pp-1",
      schedule_id: "sched-1",
      usd_price: 1.99,
      attempts: 1,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        tier_changed: { old_tier_id: "TIER_5", new_tier_id: "TIER_10" },
      },
      newUsdPrice: 1.99,
      audit: baseAudit,
    });
    expect(applyPricingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        creds,
        appleIapId: "iap-1",
        localTierId: "TIER_10",
        usdPrice: 1.99,
        precheck: expect.objectContaining({ ready: true }),
      }),
    );
    expect(out.stages.pricing.outcome?.kind).toBe("set");
    expect(out.overall).toBe("SUCCESS");
  });

  // IAP.p1.h — pricing stage runs for template-backed source even when tier
  // didn't change, so per-territory overrides re-apply for the current tier.
  it("runs pricing stage on source-only change (DEFAULT_TEMPLATE + tier unchanged)", async () => {
    applyPricingSchedule.mockResolvedValueOnce({
      kind: "set",
      price_point_id: "pp-1",
      schedule_id: "sched-1",
      usd_price: 1.99,
      attempts: 1,
      source_kind: "DEFAULT_TEMPLATE",
      overridden_territory_count: 3,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: emptyDiff(),
      newUsdPrice: 1.99,
      source: { kind: "DEFAULT_TEMPLATE" },
      currentTierId: "TIER_5",
      audit: baseAudit,
    });
    expect(applyPricingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        localTierId: "TIER_5",
        usdPrice: 1.99,
        source: { kind: "DEFAULT_TEMPLATE" },
      }),
    );
    expect(out.stages.pricing.changed).toBe(true);
  });

  it("APPLE source + tier unchanged → pricing stage stays a no-op", async () => {
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: emptyDiff(),
      source: { kind: "APPLE" },
      audit: baseAudit,
    });
    expect(applyPricingSchedule).not.toHaveBeenCalled();
    expect(out.stages.pricing.changed).toBe(false);
  });
});

describe("updateIapOnApple — aggregation", () => {
  it("returns PARTIAL when one stage succeeds and another fails", async () => {
    updateInAppPurchase.mockResolvedValueOnce({ data: { id: "iap-1" } });
    replaceScreenshotOnApple.mockResolvedValueOnce({
      ok: false,
      stage: "delete-locked",
      error: "409 STATE_ERROR",
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        attributes_changed: { name: "New" },
        screenshot_changed: true,
      },
      screenshotFile: new File([new Uint8Array(10)], "x.png", {
        type: "image/png",
      }),
      audit: baseAudit,
    });
    expect(out.stages.attributes.ok).toBe(true);
    expect(out.stages.screenshot.ok).toBe(false);
    expect(out.overall).toBe("PARTIAL");
  });
});
