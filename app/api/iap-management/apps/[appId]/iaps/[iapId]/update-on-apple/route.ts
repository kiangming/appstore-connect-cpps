/**
 * POST /api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple
 *
 * IAP.o.12a — Push edits to an existing synced IAP on Apple. Manager-locked
 * scope (Q-IAP.o.12.A): maximum Apple-supported edit surface — attributes
 * (name/reviewNote/familySharable), localizations (per-locale PATCH /
 * POST / DELETE), screenshot replace (IAP.o.8a reuse), and pricing schedule
 * replace (IAP.o.11d reuse — Manager pricing emphasis).
 *
 * Diff-driven (Q-IAP.o.12.B): only Apple endpoints whose corresponding diff
 * bucket is non-null fire. "No changes detected" returns NO_CHANGES without
 * touching Apple at all.
 *
 * Apple state-locked handling (Q-IAP.o.12.C): no pre-block. Banner in the
 * UI surfaces likely-blocked states; the route always attempts the PATCH
 * and surfaces Apple's 409/422 to the Manager. Apple is the source of truth.
 *
 * Body shape: multipart/form-data
 *   • form        — JSON string of IapFormState.
 *   • screenshot  — File (optional, PNG/JPEG ≤ 8 MB). Required iff the form
 *                   filename differs from cached and the Manager intends a
 *                   replace.
 */

import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getTierUsdPrice } from "@/lib/iap-management/queries/price-tiers";
import { getCustomPriceState } from "@/lib/iap-management/custom-prices/repository";
import {
  fingerprintOf,
  isCustomPricesSubmitBlocked,
  describeBaselineDrift,
} from "@/lib/iap-management/custom-prices/model";
import { effectiveNowManualPrices } from "@/lib/iap-management/custom-prices/baseline";
import { customPricesDivergeFromApple } from "@/lib/iap-management/apple/diff-detector";
import { getPriceScheduleForIap } from "@/lib/iap-management/apple/price-schedules";
import { unpackPriceSchedule } from "@/lib/iap-management/queries/iap-detail";
import {
  detectIapChanges,
  isEmptyDiff,
  type CachedIapState,
} from "@/lib/iap-management/apple/diff-detector";
import {
  updateIapOnApple,
  type UpdateIapOutcome,
} from "@/lib/iap-management/apple/update-orchestration";
import {
  getAvailabilityForIap,
  getAllTerritoryIds,
} from "@/lib/iap-management/apple/availabilities";
import type { IapFormState } from "@/lib/iap-management/validation";
import type { TerritorySelection } from "@/lib/iap-management/apple/territory-selection";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const MAX_SCREENSHOT_SIZE = 8 * 1024 * 1024;
const ALLOWED_SCREENSHOT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
]);

/** The form's pricing source, needed before the existing resolution block. One
 *  reader so the two cannot disagree about the default. */
function formPricingSourceEarly(
  form: IapFormState,
): "APPLE" | "DEFAULT_TEMPLATE" | "APP_TEMPLATE" {
  return (
    (form as IapFormState & {
      pricing_source?: "APPLE" | "DEFAULT_TEMPLATE" | "APP_TEMPLATE";
    }).pricing_source ?? "APPLE"
  );
}

export async function POST(
  req: Request,
  ctx: { params: { appId: string; iapId: string } },
) {
  // 1. Auth
  let session;
  try {
    // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";
  const { iapId } = ctx.params;

  // 2. Parse multipart FormData
  let form: IapFormState;
  let screenshot: File | null = null;
  try {
    const data = await req.formData();
    const formField = data.get("form");
    if (typeof formField !== "string") {
      return NextResponse.json(
        { error: 'Missing "form" field (JSON string).' },
        { status: 400 },
      );
    }
    form = JSON.parse(formField) as IapFormState;
    const fileField = data.get("screenshot");
    if (fileField instanceof File && fileField.size > 0) {
      screenshot = fileField;
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid form body: ${err instanceof Error ? err.message : err}` },
      { status: 400 },
    );
  }

  if (screenshot) {
    if (screenshot.size > MAX_SCREENSHOT_SIZE) {
      return NextResponse.json(
        { error: `Screenshot exceeds 8MB limit (${(screenshot.size / 1024 / 1024).toFixed(1)}MB).` },
        { status: 422 },
      );
    }
    if (!ALLOWED_SCREENSHOT_TYPES.has(screenshot.type)) {
      return NextResponse.json(
        { error: `Unsupported screenshot type "${screenshot.type}". PNG or JPEG required.` },
        { status: 422 },
      );
    }
  }

  // 3. Load IAP + verify it's synced
  const existing = await getIapWithRelations(iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }
  const appleIapId = existing.iap.apple_iap_id;
  if (!appleIapId) {
    return NextResponse.json(
      {
        error:
          "IAP is a local draft — use Create on Apple first, then edits can be pushed.",
      },
      { status: 409 },
    );
  }

  // 4. Build CachedIapState from DB rows.
  //    Cycle 39 Phase 1 — fetch the Apple-side availability target as part
  //    of the cached snapshot. The diff stage requires server-side ground
  //    truth (the client's form value alone can't tell us whether the radio
  //    represents a change or matches what's already on Apple).
  const creds = await getActiveAccount();
  /**
   * SC5 — server-side ground truth for the availability diff. The client's
   * selection alone cannot say whether it represents a change, so the
   * comparison base is read here and the client's copy is never trusted for it.
   *
   * ⚠ `previousKnown` is the honest flag: a FAILED read leaves the selection
   * null AND `previousKnown` false, so the diff treats any explicit selection
   * as a change (write rather than skip) and the audit records
   * `previous_known: false` instead of a fabricated count. Pre-SC5 this block
   * silently turned a failed read into `null`, which the old 2-value model
   * could not distinguish from "removed from sale".
   */
  let cachedAvailabilitySelection: TerritorySelection | null = null;
  let cachedAvailabilityPreviousKnown = false;
  let allTerritoryIds: string[] = [];
  try {
    const [avail, totalIds] = await Promise.all([
      getAvailabilityForIap(creds, appleIapId),
      getAllTerritoryIds(creds).catch(() => [] as string[]),
    ]);
    allTerritoryIds = totalIds;
    cachedAvailabilityPreviousKnown = true;
    cachedAvailabilitySelection = avail
      ? {
          territoryIds: avail.territoryIds,
          availableInNewTerritories: avail.availableInNewTerritories,
        }
      : null;
  } catch (err) {
    await log(
      "iap-update-on-apple",
      `availability prefetch failed iap=${iapId}: ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
  }

  const cachedScreenshot = existing.screenshots[0];
  const cached: CachedIapState = {
    reference_name: existing.iap.reference_name,
    review_note: existing.iap.review_note ?? null,
    family_sharable: Boolean(existing.iap.family_sharable),
    tier_id:
      existing.iap.tier_id !== null && existing.iap.tier_id !== undefined
        ? String(existing.iap.tier_id)
        : null,
    localizations: Object.fromEntries(
      existing.localizations.map((l) => [
        l.locale,
        {
          locale: l.locale,
          display_name: l.display_name,
          description: l.description,
        },
      ]),
    ),
    screenshot_apple_id: cachedScreenshot?.apple_id ?? null,
    screenshot_file_name: cachedScreenshot?.file_name ?? null,
    availability_selection: cachedAvailabilitySelection,
    availability_previous_known: cachedAvailabilityPreviousKnown,
  };

  // 4.5 SC3 — custom prices: the stale guard, then the divergence that opens
  // gate 1.
  const customState = await getCustomPriceState(iapId);
  const currentCustomFingerprint = fingerprintOf({
    tier_id: form.tier_id ?? cached.tier_id,
    pricing_source: formPricingSourceEarly(form),
    base_territory: existing.iap.base_territory ?? "USA",
  });
  if (
    isCustomPricesSubmitBlocked({
      customPriceCount: customState.entries.length,
      current: currentCustomFingerprint,
      stored: customState.baseline,
    })
  ) {
    // Same pure function the client uses to disable the button — refused before
    // any Apple call, so a stale price can never reach the store even from a
    // stale tab.
    const drift = describeBaselineDrift(
      currentCustomFingerprint,
      customState.baseline,
    );
    return NextResponse.json(
      {
        error:
          `${customState.entries.length} custom price(s) were set against a different base ` +
          `(${drift.join(" · ")}). Resolve them first: "Clear all custom prices" or ` +
          `"Keep them (reviewed)".`,
        reason: "custom-prices-stale",
        drift,
      },
      { status: 422 },
    );
  }

  // Does Apple already charge what the customs say? Compared against the
  // effective-now manual prices from the G4 read — startDate === null only, so a
  // scheduled future change is never mistaken for the current price. Skipped
  // when there is nothing on either side, so IAPs without customs pay nothing.
  let customPricesDiverge: ReturnType<typeof customPricesDivergeFromApple> = null;
  if (customState.entries.length > 0) {
    try {
      const schedule = await getPriceScheduleForIap(
        creds,
        existing.iap.apple_iap_id!,
      );
      const live = effectiveNowManualPrices(
        unpackPriceSchedule(schedule).entries,
      );
      customPricesDiverge = customPricesDivergeFromApple({
        customs: customState.entries,
        appleManualPrices: live.map((e) => ({
          territory: e.territory,
          customerPrice: Number(e.customerPrice),
        })),
        baseTerritory: existing.iap.base_territory ?? "USA",
      });
    } catch (err) {
      // P7 — prefer a missed signal over a wrong one, inverted here: we cannot
      // prove Apple already has these prices, so assume a push IS needed. The
      // pricing POST is replace-all and idempotent, so re-sending is harmless;
      // skipping a needed push would silently lose the Manager's customs.
      await log(
        "iap-update-on-apple",
        `custom-price divergence check failed iap=${iapId}: ${err instanceof Error ? err.message : err}`,
        "WARN",
      );
      customPricesDiverge = {
        count: customState.entries.length,
        diverging_territories: customState.entries.map((e) => e.territory_code),
      };
    }
  }

  // 5. Diff
  const diff = detectIapChanges({
    form,
    cached,
    hasNewScreenshotFile: screenshot !== null,
    customPrices: customPricesDiverge,
  });
  if (isEmptyDiff(diff)) {
    return NextResponse.json({
      overall: "NO_CHANGES",
      summary: "No changes detected.",
      stages: {
        precheck: { ready: true, attempts: 0, total_ms: 0 },
        attributes: { changed: false },
        localizations: { changed: false },
        screenshot: { changed: false },
        pricing: { changed: false },
        availability: { changed: false },
      },
    } satisfies UpdateIapOutcome);
  }

  // 6. Resolve USD price when pricing stage will run.
  //    IAP.p1.h: pricing stage runs when tier_changed OR when source is
  //    template-backed (Q-J — Manager re-selects source each Update). For
  //    the source-only path we look up USD against the current tier_id.
  const formPricingSource = formPricingSourceEarly(form);
  const sourceTierId =
    diff.tier_changed?.new_tier_id ?? form.tier_id ?? cached.tier_id;
  let newUsdPrice: number | null = null;
  if (sourceTierId && (diff.tier_changed || formPricingSource !== "APPLE")) {
    try {
      newUsdPrice = await getTierUsdPrice(sourceTierId);
    } catch (err) {
      await log(
        "iap-update-on-apple",
        `usd price lookup failed iap=${iapId} tier=${sourceTierId}: ${err instanceof Error ? err.message : err}`,
        "WARN",
      );
    }
  }

  // 7. Orchestrate
  const outcome = await updateIapOnApple({
    creds,
    appleIapId,
    diff,
    ...(screenshot ? { screenshotFile: screenshot } : {}),
    newUsdPrice,
    audit: { iapId, actor },
    source:
      formPricingSource === "APP_TEMPLATE"
        ? { kind: "APP_TEMPLATE", app_id: existing.iap.app_id }
        : formPricingSource === "DEFAULT_TEMPLATE"
          ? { kind: "DEFAULT_TEMPLATE" }
          : { kind: "APPLE" },
    currentTierId: sourceTierId,
    customPrices: customState.entries,
    // Stage 5 classifies the outgoing selection against the SAME catalogue the
    // picker offered, so "all territories" is recorded as ALL and not SUBSET.
    allTerritoryIds,
  });

  // 8. Mirror successful stages into local DB so the cache stays in sync.
  await mirrorOutcomeToDb({
    iapId,
    appleIapId,
    diff,
    outcome,
    form,
    screenshot,
  });

  return NextResponse.json(outcome);
}

// ─── Local DB mirror after Apple-side success ───────────────────────────────

interface MirrorArgs {
  iapId: string;
  appleIapId: string;
  diff: ReturnType<typeof detectIapChanges>;
  outcome: UpdateIapOutcome;
  form: IapFormState;
  screenshot: File | null;
}

/**
 * Update iap_mgmt.iaps + iap_localizations + iap_screenshots to reflect the
 * stages that succeeded on Apple. Best-effort — a mirror write failure logs
 * but does NOT downgrade the Apple result returned to the Manager (Apple is
 * authoritative). The local cache stays slightly stale until the next sync.
 */
async function mirrorOutcomeToDb(args: MirrorArgs): Promise<void> {
  const { iapId, diff, outcome, form, screenshot } = args;
  const db = iapDb();

  // Attributes
  if (
    diff.attributes_changed &&
    outcome.stages.attributes.ok === true
  ) {
    const updates: Record<string, unknown> = {
      synced_at: new Date().toISOString(),
    };
    if (diff.attributes_changed.name !== undefined) {
      updates.reference_name = diff.attributes_changed.name;
    }
    if (diff.attributes_changed.reviewNote !== undefined) {
      updates.review_note = diff.attributes_changed.reviewNote;
    }
    if (diff.attributes_changed.familySharable !== undefined) {
      updates.family_sharable = diff.attributes_changed.familySharable;
    }
    const res = await db.from("iaps").update(updates).eq("id", iapId);
    if (res.error) {
      await log(
        "iap-update-on-apple",
        `mirror attr update failed iap=${iapId}: ${res.error.message}`,
        "WARN",
      );
    }
  }

  // Localizations
  if (
    diff.localizations_changed &&
    outcome.stages.localizations.results
  ) {
    for (const r of outcome.stages.localizations.results) {
      if (!r.ok) continue;
      if (r.op === "delete") {
        await db
          .from("iap_localizations")
          .delete()
          .eq("iap_id", iapId)
          .eq("locale", r.locale);
      } else if (r.op === "update") {
        const formLoc = form.localizations[r.locale];
        if (formLoc) {
          await db
            .from("iap_localizations")
            .update({
              display_name: formLoc.display_name.trim(),
              description: formLoc.description.trim(),
            })
            .eq("iap_id", iapId)
            .eq("locale", r.locale);
        }
      } else if (r.op === "add") {
        const formLoc = form.localizations[r.locale];
        if (formLoc) {
          await db.from("iap_localizations").insert({
            iap_id: iapId,
            locale: r.locale,
            display_name: formLoc.display_name.trim(),
            description: formLoc.description.trim(),
          });
        }
      }
    }
  }

  // Screenshot
  if (
    diff.screenshot_changed &&
    outcome.stages.screenshot.ok === true &&
    screenshot
  ) {
    await db.from("iap_screenshots").delete().eq("iap_id", iapId);
    await db.from("iap_screenshots").insert({
      iap_id: iapId,
      apple_id: outcome.stages.screenshot.apple_screenshot_id ?? null,
      file_name: outcome.stages.screenshot.file_name ?? screenshot.name,
      file_size: outcome.stages.screenshot.file_size ?? screenshot.size,
      uploaded_at: new Date().toISOString(),
    });
  }

  // Pricing — mirror only when the schedule actually flipped on Apple
  // (outcome.kind === "set"). All other PricingOutcome kinds mean the local
  // tier should NOT be advanced (Apple-side may still be on the old price).
  if (
    diff.tier_changed &&
    outcome.stages.pricing.outcome?.kind === "set"
  ) {
    const res = await db
      .from("iaps")
      .update({ tier_id: diff.tier_changed.new_tier_id })
      .eq("id", iapId);
    if (res.error) {
      await log(
        "iap-update-on-apple",
        `mirror tier update failed iap=${iapId}: ${res.error.message}`,
        "WARN",
      );
    }
  }
}
