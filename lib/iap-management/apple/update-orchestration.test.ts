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
// ⭐ O4 — the localizations stage no longer talks to the V1 client. It calls
// the ONE shared V2 path that bulk import calls, so the mock surface is that
// function, not three client helpers. If this ever grows client mocks back,
// the twin paths have drifted apart again.
const syncLocalizationsToVersion = vi.hoisted(() => vi.fn());
const replaceScreenshotOnApple = vi.hoisted(() => vi.fn());
const applyPricingSchedule = vi.hoisted(() => vi.fn());
// SC5 — the orchestrator now goes through the ONE shared write path; the two
// legacy helpers are no longer called from Stage 5.
const setAvailabilityTerritories = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());

vi.mock("./poll-iap-ready", () => ({ pollIapReadyForPricing }));
vi.mock("./client", () => ({ updateInAppPurchase }));
vi.mock("./localization-version-sync", () => ({ syncLocalizationsToVersion }));
vi.mock("./screenshot-upload", () => ({ replaceScreenshotOnApple }));
vi.mock("./pricing-orchestration", () => ({ applyPricingSchedule }));
vi.mock("./availabilities", () => ({
  setAvailabilityTerritories,
}));
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
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  subsetSelection,
  type TerritorySelection,
} from "./territory-selection";

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
    availability_changed: null,
    custom_prices_changed: null,
  };
}

beforeEach(() => {
  pollIapReadyForPricing.mockReset();
  updateInAppPurchase.mockReset();
  syncLocalizationsToVersion.mockReset();
  syncLocalizationsToVersion.mockResolvedValue({
    skipped: [],
    patched: [],
    created: [],
    deleted: [],
    failures: [],
    versionCreated: false,
  });
  replaceScreenshotOnApple.mockReset();
  applyPricingSchedule.mockReset();
  setAvailabilityTerritories.mockReset();
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
    // ⭐ The localizations stage now reaches Apple only through the shared V2
    // sync, so "did it touch Apple?" is asked of that one function.
    expect(syncLocalizationsToVersion).not.toHaveBeenCalled();
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

describe("updateIapOnApple — localizations stage (V2, shared path)", () => {
  it("⭐ delegates to the SAME shared sync bulk import uses — updated + added become `desired`", () => {
    syncLocalizationsToVersion.mockResolvedValueOnce({
      skipped: [],
      patched: ["en"],
      created: [{ locale: "ja", id: "loc-ja-new" }],
      deleted: [],
      failures: [],
      versionCreated: false,
      targetVersionId: "v-draft",
    });
    return updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", description: "New desc" }],
          added: [{ locale: "ja", name: "Ja name", description: "Ja desc" }],
          removed: [],
        },
      },
      audit: baseAudit,
    }).then((out) => {
      const call = syncLocalizationsToVersion.mock.calls[0][0];
      expect(call.appleIapId).toBe("iap-1");
      expect(call.desired.map((d: { locale: string }) => d.locale)).toEqual(["en", "ja"]);
      expect(out.stages.localizations.results).toContainEqual({
        op: "update",
        locale: "en",
        ok: true,
      });
      expect(out.stages.localizations.results).toContainEqual({
        op: "add",
        locale: "ja",
        ok: true,
        loc_id: "loc-ja-new",
      });
    });
  });

  it("⚠⚠ THE FORM passes removeLocales — bulk import must not (Q3)", async () => {
    // The asymmetry between the two surfaces lives at the call sites. Here a
    // human clicked "remove this locale"; in an import file a missing locale
    // only means the file was partial.
    syncLocalizationsToVersion.mockResolvedValueOnce({
      skipped: [],
      patched: [],
      created: [],
      deleted: ["vi"],
      failures: [],
      versionCreated: false,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: { updated: [], added: [], removed: [{ locale: "vi" }] },
      },
      audit: baseAudit,
    });
    expect(syncLocalizationsToVersion.mock.calls[0][0].removeLocales).toEqual(["vi"]);
    expect(out.stages.localizations.results?.[0]).toMatchObject({
      op: "delete",
      locale: "vi",
      ok: true,
    });
  });

  it("⚠ a SKIPPED locale is reported as a result, never dropped", async () => {
    // The Manager asked for a change; "Apple already has exactly this" is an
    // answer, and a silent nothing is the failure class this arc removes.
    syncLocalizationsToVersion.mockResolvedValueOnce({
      skipped: [
        { locale: "en", reason: "IDENTICAL_TO_LIVE", label: "Giống bản đang bán — không có gì để đổi" },
      ],
      patched: [],
      created: [],
      deleted: [],
      failures: [],
      versionCreated: false,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", name: "X" }],
          added: [],
          removed: [],
        },
      },
      audit: baseAudit,
    });
    expect(out.stages.localizations.results).toContainEqual({
      op: "update",
      locale: "en",
      ok: true,
    });
    const skipRow = auditInsert.mock.calls
      .flatMap((c) => c[0])
      .find((r: { payload?: { skipped?: string } }) => r?.payload?.skipped);
    expect(skipRow.payload.note).toContain("Giống bản đang bán");
  });

  it("⚠⚠ a per-locale failure carries the REASON, not a generic error", async () => {
    syncLocalizationsToVersion.mockResolvedValueOnce({
      skipped: [],
      patched: [],
      created: [],
      deleted: [],
      failures: [
        {
          locale: "en",
          message:
            "en: không ghi được vì tool không xác định được version an toàn để ghi — 2 versions are in PREPARE_FOR_SUBMISSION. Không có thay đổi nào được gửi lên Apple cho locale này.",
        },
      ],
      versionCreated: false,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", name: "X" }],
          added: [],
          removed: [],
        },
      },
      audit: baseAudit,
    });
    const row = out.stages.localizations.results?.[0] as { error: string };
    expect(row.error).toContain("2 versions are in PREPARE_FOR_SUBMISSION");
    expect(row.error).toContain("Không có thay đổi nào được gửi lên Apple");
  });

  it("⚠ a PERMANENT version creation is announced in the audit trail", async () => {
    // `inAppPurchaseVersions` has no DELETE, so the only remedy for an orphan
    // is being able to find it.
    syncLocalizationsToVersion.mockResolvedValueOnce({
      skipped: [],
      patched: ["en"],
      created: [],
      deleted: [],
      failures: [],
      versionCreated: true,
      targetVersionId: "v-new",
    });
    await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        localizations_changed: {
          updated: [{ locale: "en", name: "X" }],
          added: [],
          removed: [],
        },
      },
      audit: baseAudit,
    });
    const created = auditInsert.mock.calls
      .flatMap((c) => c[0])
      .find((r: { payload?: { stage?: string } }) => r?.payload?.stage === "version-created");
    expect(created.payload.version_id).toBe("v-new");
  });

  it("a sync throw surfaces as per-op error rows so the UI can show each intended op", async () => {
    syncLocalizationsToVersion.mockRejectedValueOnce(new Error("api down"));
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
    const results = out.stages.localizations.results ?? [];
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
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

  // ── SC3 GATE 2 — the real guard, not a mirror ─────────────────────────────
  //
  // A customs-ONLY edit under source APPLE. Reverting the `customsChanged`
  // clause in runPricingStage makes THIS test fail with zero
  // applyPricingSchedule calls, which is the whole point: the merge can be
  // perfect and the change still never reaches it.
  it("⚠ GATE 2: runs the pricing stage for a customs-ONLY change under source APPLE", async () => {
    applyPricingSchedule.mockResolvedValueOnce({
      kind: "set",
      price_point_id: "pp-1",
      schedule_id: "sched-1",
      usd_price: 9.99,
      attempts: 1,
      source_kind: "APPLE",
      overridden_territory_count: 1,
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        custom_prices_changed: { count: 1, diverging_territories: ["VNM"] },
      },
      newUsdPrice: 9.99,
      currentTierId: "TIER_10",
      // source omitted ⇒ APPLE, the case the old guard skipped entirely
      customPrices: [
        { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
      ],
      audit: baseAudit,
    });
    expect(applyPricingSchedule).toHaveBeenCalledTimes(1);
    expect(applyPricingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        customPrices: [
          { territory_code: "VNM", customer_price: 25000, currency_code: "VND" },
        ],
      }),
    );
    expect(out.stages.pricing.changed).toBe(true);
    expect(out.overall).toBe("SUCCESS");
  });

  it("still skips the pricing stage when nothing pricing-related changed", async () => {
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        attributes_changed: { name: "Renamed" },
      },
      audit: baseAudit,
    });
    expect(applyPricingSchedule).not.toHaveBeenCalled();
    expect(out.stages.pricing.changed).toBe(false);
  });

  // ── J-5 — a failed custom must not read as success ────────────────────────
  it("J-5: partial-custom-fail downgrades overall and NAMES the territory", async () => {
    applyPricingSchedule.mockResolvedValueOnce({
      kind: "partial-custom-fail",
      schedule_id: "sched-1",
      attempts: 1,
      source_kind: "APPLE",
      overridden_territory_count: 0,
      missing_price_points: [],
      failed_custom_territories: [
        {
          tier_id: null,
          territory_code: "VNM",
          customer_price: 99999,
          source: "custom",
          reason: "no-apple-price-point",
        },
      ],
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...emptyDiff(),
        custom_prices_changed: { count: 1, diverging_territories: ["VNM"] },
      },
      newUsdPrice: 9.99,
      currentTierId: "TIER_10",
      audit: baseAudit,
    });
    expect(out.overall).not.toBe("SUCCESS");
    // Per-territory, never a bare count — the Manager must be able to tell WHICH
    // explicit instruction failed.
    expect(out.summary).toContain("VNM");
    expect(out.summary).toContain("no-apple-price-point");
    expect(out.summary).toMatch(/custom prices NOT applied/i);
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
      source: { kind: "DEFAULT_TEMPLATE", account_id: "acct-1" },
      currentTierId: "TIER_5",
      audit: baseAudit,
    });
    expect(applyPricingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        localTierId: "TIER_5",
        usdPrice: 1.99,
        source: { kind: "DEFAULT_TEMPLATE", account_id: "acct-1" },
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

describe("updateIapOnApple — availability stage", () => {
  const CATALOGUE = ["USA", "VNM", "BRA"];
  const change = (
    next: TerritorySelection,
    prev: TerritorySelection | null = allTerritoriesSelection(CATALOGUE),
    previous_known = true,
  ) => ({
    ...emptyDiff(),
    availability_changed: {
      old_selection: prev,
      new_selection: next,
      previous_known,
    },
  });

  /** The payload the audit row carried. */
  const auditRow = (action: string) =>
    auditInsert.mock.calls.find(
      (c) => (c[0] as { action_type: string }).action_type === action,
    )?.[0] as { action_type: string; payload: Record<string, unknown> } | undefined;

  it("an EMPTY selection writes AVAILABILITY_REMOVE_FROM_SALES through the shared path", async () => {
    setAvailabilityTerritories.mockResolvedValueOnce({
      data: { id: "avail-removed-1", type: "inAppPurchaseAvailabilities" },
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(noTerritoriesSelection()),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(setAvailabilityTerritories).toHaveBeenCalledWith(
      creds,
      "iap-1",
      noTerritoriesSelection(),
    );
    expect(out.stages.availability).toMatchObject({
      changed: true,
      ok: true,
      target: "NONE",
      apple_availability_id: "avail-removed-1",
    });
    expect(out.overall).toBe("SUCCESS");
    expect(auditRow("AVAILABILITY_REMOVE_FROM_SALES")).toBeDefined();
  });

  it("ALL + the forward flag keeps AVAILABILITY_SET_ALL_TERRITORIES", async () => {
    setAvailabilityTerritories.mockResolvedValueOnce({
      data: { id: "avail-all-1", type: "inAppPurchaseAvailabilities" },
    });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(allTerritoriesSelection(CATALOGUE), noTerritoriesSelection()),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(out.stages.availability).toMatchObject({
      changed: true,
      ok: true,
      target: "ALL",
    });
    expect(auditRow("AVAILABILITY_SET_ALL_TERRITORIES")).toBeDefined();
  });

  // ── SC5: the action type follows WHAT WAS SENT ────────────────────────────

  it("⚠ a SUBSET writes AVAILABILITY_SET_TERRITORIES, not SET_ALL", async () => {
    setAvailabilityTerritories.mockResolvedValueOnce({ data: { id: "avail-2" } });
    const sel = subsetSelection(["USA", "VNM"]);
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(sel),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(out.stages.availability.target).toBe("SUBSET");
    expect(auditRow("AVAILABILITY_SET_ALL_TERRITORIES")).toBeUndefined();
    const row = auditRow("AVAILABILITY_SET_TERRITORIES");
    expect(row).toBeDefined();
    // SC2 reconstructability: the FULL sent list, verbatim, plus honest counts.
    expect(row!.payload).toMatchObject({
      territories: ["USA", "VNM"],
      territory_count: 2,
      available_in_new_territories: false,
      previous_territory_count: 3,
      previous_known: true,
      source: "edit",
    });
  });

  it("⚠ all-ticked-by-hand is SET_TERRITORIES, not SET_ALL — the flag decides", async () => {
    // Same ids as the catalogue but the forward flag off: a different request,
    // so a different action type. Recording SET_ALL here would make the row
    // assert something false about what Apple was told (KB §4.13).
    setAvailabilityTerritories.mockResolvedValueOnce({ data: { id: "avail-3" } });
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(subsetSelection(CATALOGUE), noTerritoriesSelection()),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(out.stages.availability.target).toBe("ALL_FROZEN");
    expect(auditRow("AVAILABILITY_SET_ALL_TERRITORIES")).toBeUndefined();
    expect(auditRow("AVAILABILITY_SET_TERRITORIES")!.payload).toMatchObject({
      available_in_new_territories: false,
      territory_count: 3,
    });
  });

  it("records previous_known: false honestly rather than inventing a count", async () => {
    setAvailabilityTerritories.mockResolvedValueOnce({ data: { id: "avail-4" } });
    await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(subsetSelection(["USA"]), null, false),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(auditRow("AVAILABILITY_SET_TERRITORIES")!.payload).toMatchObject({
      previous_known: false,
      previous_territory_count: null,
    });
  });

  it("sends Apple's ids verbatim — no sort, no rewrite", async () => {
    setAvailabilityTerritories.mockResolvedValueOnce({ data: { id: "avail-5" } });
    await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: change(subsetSelection(["VNM", "USA"])),
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    const [, , sent] = setAvailabilityTerritories.mock.calls[0];
    expect((sent as TerritorySelection).territoryIds).toEqual(["VNM", "USA"]);
  });

  it("surfaces a stage failure without breaking sibling stages", async () => {
    updateInAppPurchase.mockResolvedValueOnce({ data: { id: "iap-1" } });
    setAvailabilityTerritories.mockRejectedValueOnce(
      new Error("Apple 409 PRICING_LOCK"),
    );
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: {
        ...change(noTerritoriesSelection()),
        attributes_changed: { name: "New" },
      },
      allTerritoryIds: CATALOGUE,
      audit: baseAudit,
    });
    expect(out.stages.attributes.ok).toBe(true);
    expect(out.stages.availability.ok).toBe(false);
    expect(out.stages.availability.error).toContain("Apple 409 PRICING_LOCK");
    expect(out.overall).toBe("PARTIAL");
    // The failure is still reconstructable.
    expect(auditRow("AVAILABILITY_REMOVE_FROM_SALES")!.payload).toMatchObject({
      result: "ERROR",
      territory_count: 0,
    });
  });

  it("stays a no-op (no Apple call) when diff.availability_changed is null", async () => {
    const out = await updateIapOnApple({
      creds,
      appleIapId: "iap-1",
      diff: emptyDiff(),
      audit: baseAudit,
    });
    expect(setAvailabilityTerritories).not.toHaveBeenCalled();
    expect(out.stages.availability.changed).toBe(false);
  });
});
