/**
 * IAP.o.12a — Apple edit-on-Apple orchestration.
 *
 * Composes the 5 Apple-side stages required to push form edits to a synced
 * IAP. Reuses primitives shipped across the IAP.o.6 → IAP.o.11 cycle so the
 * new orchestration surface is minimal:
 *
 *   • Stage 0 — precheck poll (IAP.o.11a) — confirm Apple has the IAP record.
 *   • Stage 1 — PATCH attributes (`name`, `reviewNote`, `familySharable`).
 *   • Stage 2 — Localization sync (PATCH / POST / DELETE per diff bucket).
 *   • Stage 3 — Screenshot replace (IAP.o.8a `replaceScreenshotOnApple`).
 *   • Stage 4 — Pricing schedule (IAP.o.11d `applyPricingSchedule` — owns
 *               its own audit log row + retry budget + jitter).
 *
 * Per Manager IAP.o.11 instrumentation-first discipline: every stage emits
 * `[update-on-apple] stage=X start/result` console.log so Railway tail shows
 * the path taken, and every stage writes its own audit row inside this
 * orchestrator (Stage 4 delegates to the pricing orchestrator's own audit).
 * Stage failures NEVER cascade — partial success is the expected outcome
 * when Apple rejects a single field but accepts the rest.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import { AppleApiError } from "./fetch";
import {
  listInAppPurchaseLocalizations,
  updateInAppPurchase,
  createInAppPurchaseLocalization,
  updateInAppPurchaseLocalization,
  deleteInAppPurchaseLocalization,
} from "./client";
import { pollIapReadyForPricing } from "./poll-iap-ready";
import { replaceScreenshotOnApple } from "./screenshot-upload";
import {
  applyPricingSchedule,
  type PricingOutcome,
  type PricingSource,
} from "./pricing-orchestration";
import type { IapDiff } from "./diff-detector";
import { iapDb } from "@/lib/iap-management/db";

export interface UpdateAuditContext {
  iapId: string;
  actor: string;
}

export interface UpdateIapOnAppleArgs {
  creds: AscCredentials;
  appleIapId: string;
  diff: IapDiff;
  /** New screenshot File when `diff.screenshot_changed`. */
  screenshotFile?: File;
  /** Resolved USA/USD price for the new tier_id. Resolver lives in the
   *  route handler so this module stays free of DB coupling for pricing. */
  newUsdPrice?: number | null;
  audit: UpdateAuditContext;
  /** IAP.p1.h: pricing source applied by Stage 4. Defaults to APPLE. When
   *  the source is template-backed, the stage runs even if `diff.tier_changed`
   *  is null so per-territory overrides get re-applied for the current tier. */
  source?: PricingSource;
  /** IAP.p1.h: current tier_id from the form, used when source is
   *  template-backed and tier didn't change (the pricing stage still needs
   *  a tier to look up USD + match Apple's price-point). */
  currentTierId?: string | null;
}

// ─── Stage result shapes ─────────────────────────────────────────────────────

export interface StageAttributesResult {
  changed: boolean;
  ok?: boolean;
  error?: string;
  /** Fields successfully patched on Apple. */
  patched?: { name?: string; reviewNote?: string | null; familySharable?: boolean };
}

export type LocalizationOpResult =
  | { op: "update"; locale: string; ok: true }
  | { op: "update"; locale: string; ok: false; error: string }
  | { op: "add"; locale: string; ok: true; loc_id: string }
  | { op: "add"; locale: string; ok: false; error: string }
  | { op: "delete"; locale: string; ok: true }
  | { op: "delete"; locale: string; ok: false; error: string };

export interface StageLocalizationsResult {
  changed: boolean;
  results?: LocalizationOpResult[];
}

export interface StageScreenshotResult {
  changed: boolean;
  ok?: boolean;
  apple_screenshot_id?: string;
  file_name?: string;
  file_size?: number;
  error?: string;
  stage_detail?: string;
}

export interface StagePricingResult {
  changed: boolean;
  outcome?: PricingOutcome;
}

export interface StagePrecheckResult {
  ready: boolean;
  attempts: number;
  total_ms: number;
  reason?: string;
}

export interface UpdateIapOutcome {
  stages: {
    precheck: StagePrecheckResult;
    attributes: StageAttributesResult;
    localizations: StageLocalizationsResult;
    screenshot: StageScreenshotResult;
    pricing: StagePricingResult;
  };
  /** Aggregate roll-up: SUCCESS only when every changed stage succeeded;
   *  PARTIAL when at least one stage succeeded AND at least one failed;
   *  FAILURE when no change succeeded. NO_CHANGES when nothing was diffed. */
  overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_CHANGES";
  summary: string;
}

// ─── Orchestration entry point ───────────────────────────────────────────────

export async function updateIapOnApple(
  args: UpdateIapOnAppleArgs,
): Promise<UpdateIapOutcome> {
  const { creds, appleIapId, diff, audit } = args;
  console.log(
    `[update-on-apple] start apple_iap_id=${appleIapId} attr=${diff.attributes_changed !== null} loc=${diff.localizations_changed !== null} scr=${diff.screenshot_changed} tier=${diff.tier_changed !== null}`,
  );

  // ── Stage 0 — precheck poll (IAP.o.11a reuse) ─────────────────────────
  console.log(
    `[update-on-apple] stage=precheck start apple_iap_id=${appleIapId}`,
  );
  const poll = await pollIapReadyForPricing({ creds, appleIapId });
  const precheck: StagePrecheckResult = {
    ready: poll.ready,
    attempts: poll.attempts,
    total_ms: poll.total_ms,
    ...(poll.ready ? {} : { reason: poll.reason }),
  };
  console.log(
    `[update-on-apple] stage=precheck result apple_iap_id=${appleIapId} ready=${poll.ready} attempts=${poll.attempts}`,
  );
  if (!poll.ready) {
    await writeAuditRow(audit, "UPDATE_ATTRIBUTES_ON_APPLE", {
      apple_iap_id: appleIapId,
      result: "ERROR",
      stage: "precheck",
      poll_attempts: poll.attempts,
      poll_total_ms: poll.total_ms,
      reason: poll.reason,
    });
    return {
      stages: {
        precheck,
        attributes: { changed: diff.attributes_changed !== null },
        localizations: { changed: diff.localizations_changed !== null },
        screenshot: { changed: diff.screenshot_changed },
        pricing: { changed: diff.tier_changed !== null },
      },
      overall: "FAILURE",
      summary: `Apple IAP not ready (${poll.reason ?? "timeout"})`,
    };
  }

  // ── Stage 1 — Attributes ──────────────────────────────────────────────
  const attributes = await runAttributesStage(args);

  // ── Stage 2 — Localizations ───────────────────────────────────────────
  const localizations = await runLocalizationsStage(args);

  // ── Stage 3 — Screenshot ──────────────────────────────────────────────
  const screenshot = await runScreenshotStage(args);

  // ── Stage 4 — Pricing ─────────────────────────────────────────────────
  const pricing = await runPricingStage(args);

  // ── Aggregate ─────────────────────────────────────────────────────────
  const aggregated = aggregate({
    attributes,
    localizations,
    screenshot,
    pricing,
  });

  console.log(
    `[update-on-apple] complete apple_iap_id=${appleIapId} overall=${aggregated.overall}`,
  );
  return {
    stages: { precheck, attributes, localizations, screenshot, pricing },
    ...aggregated,
  };
}

// ─── Stage 1 — Attributes ───────────────────────────────────────────────────

async function runAttributesStage(
  args: UpdateIapOnAppleArgs,
): Promise<StageAttributesResult> {
  const { creds, appleIapId, diff, audit } = args;
  if (!diff.attributes_changed) {
    return { changed: false };
  }
  console.log(
    `[update-on-apple] stage=attributes start apple_iap_id=${appleIapId} fields=${Object.keys(diff.attributes_changed).join(",")}`,
  );
  try {
    await updateInAppPurchase(creds, appleIapId, {
      ...(diff.attributes_changed.name !== undefined
        ? { name: diff.attributes_changed.name }
        : {}),
      ...(diff.attributes_changed.reviewNote !== undefined
        ? { reviewNote: diff.attributes_changed.reviewNote ?? undefined }
        : {}),
      ...(diff.attributes_changed.familySharable !== undefined
        ? { familySharable: diff.attributes_changed.familySharable }
        : {}),
    });
    console.log(
      `[update-on-apple] stage=attributes success apple_iap_id=${appleIapId}`,
    );
    await writeAuditRow(audit, "UPDATE_ATTRIBUTES_ON_APPLE", {
      apple_iap_id: appleIapId,
      result: "SUCCESS",
      patched: diff.attributes_changed,
    });
    return { changed: true, ok: true, patched: diff.attributes_changed };
  } catch (err) {
    const errStr = errToString(err);
    console.error(
      `[update-on-apple] stage=attributes failure apple_iap_id=${appleIapId}: ${errStr}`,
    );
    await writeAuditRow(audit, "UPDATE_ATTRIBUTES_ON_APPLE", {
      apple_iap_id: appleIapId,
      result: "ERROR",
      error: errStr,
      attempted: diff.attributes_changed,
    });
    return { changed: true, ok: false, error: errStr };
  }
}

// ─── Stage 2 — Localizations ────────────────────────────────────────────────

async function runLocalizationsStage(
  args: UpdateIapOnAppleArgs,
): Promise<StageLocalizationsResult> {
  const { creds, appleIapId, diff, audit } = args;
  if (!diff.localizations_changed) {
    return { changed: false };
  }
  console.log(
    `[update-on-apple] stage=localizations start apple_iap_id=${appleIapId} updated=${diff.localizations_changed.updated.length} added=${diff.localizations_changed.added.length} removed=${diff.localizations_changed.removed.length}`,
  );

  // The cache doesn't store Apple loc IDs, so resolve them from Apple now.
  // PATCH and DELETE both need the Apple-side localization id.
  let localeToApple: Map<string, string> = new Map();
  if (
    diff.localizations_changed.updated.length > 0 ||
    diff.localizations_changed.removed.length > 0
  ) {
    try {
      const res = await listInAppPurchaseLocalizations(creds, appleIapId);
      const rows = (res.data ?? []) as Array<{
        id: string;
        attributes?: { locale?: string };
      }>;
      localeToApple = new Map(
        rows
          .filter((r) => typeof r.attributes?.locale === "string")
          .map((r) => [r.attributes!.locale as string, r.id]),
      );
    } catch (err) {
      const errStr = errToString(err);
      console.error(
        `[update-on-apple] stage=localizations lookup-fail apple_iap_id=${appleIapId}: ${errStr}`,
      );
      // Without loc IDs, updated/removed cannot proceed. Surface a single
      // synthetic failure per locale so the UI can show what was intended.
      const results: LocalizationOpResult[] = [
        ...diff.localizations_changed.updated.map(
          (u): LocalizationOpResult => ({
            op: "update",
            locale: u.locale,
            ok: false,
            error: `Apple localization lookup failed: ${errStr}`,
          }),
        ),
        ...diff.localizations_changed.removed.map(
          (r): LocalizationOpResult => ({
            op: "delete",
            locale: r.locale,
            ok: false,
            error: `Apple localization lookup failed: ${errStr}`,
          }),
        ),
      ];
      await writeAuditRow(audit, "UPDATE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        result: "ERROR",
        stage: "lookup",
        error: errStr,
      });
      return { changed: true, results };
    }
  }

  const results: LocalizationOpResult[] = [];

  for (const upd of diff.localizations_changed.updated) {
    const locId = localeToApple.get(upd.locale);
    if (!locId) {
      const error = `Apple has no localization for locale=${upd.locale} — cache out of sync`;
      console.warn(`[update-on-apple] ${error}`);
      results.push({ op: "update", locale: upd.locale, ok: false, error });
      await writeAuditRow(audit, "UPDATE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: upd.locale,
        result: "ERROR",
        error,
      });
      continue;
    }
    try {
      await updateInAppPurchaseLocalization(creds, locId, {
        ...(upd.name !== undefined ? { name: upd.name } : {}),
        ...(upd.description !== undefined ? { description: upd.description } : {}),
      });
      results.push({ op: "update", locale: upd.locale, ok: true });
      await writeAuditRow(audit, "UPDATE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: upd.locale,
        loc_id: locId,
        result: "SUCCESS",
        patched: { name: upd.name, description: upd.description },
      });
    } catch (err) {
      const errStr = errToString(err);
      console.error(
        `[update-on-apple] stage=localizations update fail locale=${upd.locale}: ${errStr}`,
      );
      results.push({ op: "update", locale: upd.locale, ok: false, error: errStr });
      await writeAuditRow(audit, "UPDATE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: upd.locale,
        loc_id: locId,
        result: "ERROR",
        error: errStr,
      });
    }
  }

  for (const add of diff.localizations_changed.added) {
    try {
      const res = await createInAppPurchaseLocalization(creds, {
        iapId: appleIapId,
        locale: add.locale,
        name: add.name,
        description: add.description,
      });
      results.push({ op: "add", locale: add.locale, ok: true, loc_id: res.data.id });
      await writeAuditRow(audit, "ADD_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: add.locale,
        loc_id: res.data.id,
        result: "SUCCESS",
      });
    } catch (err) {
      const errStr = errToString(err);
      console.error(
        `[update-on-apple] stage=localizations add fail locale=${add.locale}: ${errStr}`,
      );
      results.push({ op: "add", locale: add.locale, ok: false, error: errStr });
      await writeAuditRow(audit, "ADD_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: add.locale,
        result: "ERROR",
        error: errStr,
      });
    }
  }

  for (const rem of diff.localizations_changed.removed) {
    const locId = localeToApple.get(rem.locale);
    if (!locId) {
      // Already absent on Apple — treat as ok (idempotent).
      results.push({ op: "delete", locale: rem.locale, ok: true });
      continue;
    }
    try {
      await deleteInAppPurchaseLocalization(creds, locId);
      results.push({ op: "delete", locale: rem.locale, ok: true });
      await writeAuditRow(audit, "DELETE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: rem.locale,
        loc_id: locId,
        result: "SUCCESS",
      });
    } catch (err) {
      const errStr = errToString(err);
      console.error(
        `[update-on-apple] stage=localizations delete fail locale=${rem.locale}: ${errStr}`,
      );
      results.push({ op: "delete", locale: rem.locale, ok: false, error: errStr });
      await writeAuditRow(audit, "DELETE_LOCALIZATION_ON_APPLE", {
        apple_iap_id: appleIapId,
        locale: rem.locale,
        loc_id: locId,
        result: "ERROR",
        error: errStr,
      });
    }
  }

  console.log(
    `[update-on-apple] stage=localizations complete apple_iap_id=${appleIapId} ok=${results.filter((r) => r.ok).length}/${results.length}`,
  );
  return { changed: true, results };
}

// ─── Stage 3 — Screenshot ────────────────────────────────────────────────────

async function runScreenshotStage(
  args: UpdateIapOnAppleArgs,
): Promise<StageScreenshotResult> {
  const { creds, appleIapId, diff, screenshotFile, audit } = args;
  if (!diff.screenshot_changed) {
    return { changed: false };
  }
  if (!screenshotFile) {
    const error = "screenshot_changed=true but no File provided";
    console.error(`[update-on-apple] stage=screenshot ${error}`);
    await writeAuditRow(audit, "REPLACE_SCREENSHOT_ON_APPLE", {
      apple_iap_id: appleIapId,
      result: "ERROR",
      error,
    });
    return { changed: true, ok: false, error };
  }
  console.log(
    `[update-on-apple] stage=screenshot start apple_iap_id=${appleIapId} file=${screenshotFile.name}`,
  );
  const result = await replaceScreenshotOnApple(creds, appleIapId, screenshotFile);
  if (result.ok) {
    console.log(
      `[update-on-apple] stage=screenshot success apple_iap_id=${appleIapId}`,
    );
    await writeAuditRow(audit, "REPLACE_SCREENSHOT_ON_APPLE", {
      apple_iap_id: appleIapId,
      result: "SUCCESS",
      apple_screenshot_id: result.apple_screenshot_id,
      file_name: result.file_name,
      file_size: result.file_size,
    });
    return {
      changed: true,
      ok: true,
      apple_screenshot_id: result.apple_screenshot_id,
      file_name: result.file_name,
      file_size: result.file_size,
    };
  }
  console.error(
    `[update-on-apple] stage=screenshot failure apple_iap_id=${appleIapId} stage_detail=${result.stage}: ${result.error}`,
  );
  await writeAuditRow(audit, "REPLACE_SCREENSHOT_ON_APPLE", {
    apple_iap_id: appleIapId,
    result: "ERROR",
    stage_detail: result.stage,
    error: result.error,
  });
  return {
    changed: true,
    ok: false,
    error: result.error,
    stage_detail: result.stage,
  };
}

// ─── Stage 4 — Pricing ──────────────────────────────────────────────────────

async function runPricingStage(
  args: UpdateIapOnAppleArgs,
): Promise<StagePricingResult> {
  const { creds, appleIapId, diff, newUsdPrice, audit, source, currentTierId } = args;
  const effectiveSource: PricingSource = source ?? { kind: "APPLE" };
  // IAP.p1.h: run pricing stage either when the tier changed (legacy
  // behavior) OR when the Manager picked a template-backed source — for the
  // latter we re-apply per-territory overrides for the current tier.
  const shouldRun =
    diff.tier_changed !== null || effectiveSource.kind !== "APPLE";
  if (!shouldRun) {
    return { changed: false };
  }
  const tierId = diff.tier_changed?.new_tier_id ?? currentTierId ?? null;
  if (!tierId) {
    // Source-only change without a tier in the form — nothing to apply.
    console.log(
      `[update-on-apple] stage=pricing skip apple_iap_id=${appleIapId} source=${effectiveSource.kind} reason=no-tier`,
    );
    return { changed: false };
  }
  console.log(
    `[update-on-apple] stage=pricing start apple_iap_id=${appleIapId} tier=${tierId} source=${effectiveSource.kind} usd=${newUsdPrice}`,
  );
  // Reuse the IAP.o.11d pricing orchestrator wholesale — it owns its own
  // audit log (SET_PRICE_SCHEDULE) with the result severity convention,
  // retry budget, and instrumentation. p1.e extended the orchestrator with
  // the 3-source model; we just thread the chosen source through.
  const outcome = await applyPricingSchedule({
    creds,
    appleIapId,
    localTierId: tierId,
    usdPrice: newUsdPrice ?? null,
    source: effectiveSource,
    // Precheck already done in Stage 0; pass ready so the pricing
    // orchestrator doesn't poll twice.
    precheck: { ready: true, attempts: 1, total_ms: 0 },
    audit: { iapId: audit.iapId, actor: audit.actor },
  });
  console.log(
    `[update-on-apple] stage=pricing result apple_iap_id=${appleIapId} outcome=${outcome.kind}`,
  );
  return { changed: true, outcome };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function aggregate(stages: {
  attributes: StageAttributesResult;
  localizations: StageLocalizationsResult;
  screenshot: StageScreenshotResult;
  pricing: StagePricingResult;
}): { overall: UpdateIapOutcome["overall"]; summary: string } {
  const changedFlags = [
    stages.attributes.changed,
    stages.localizations.changed,
    stages.screenshot.changed,
    stages.pricing.changed,
  ];
  if (!changedFlags.some(Boolean)) {
    return { overall: "NO_CHANGES", summary: "No changes detected." };
  }

  const okFlags: boolean[] = [];
  const failureSummaries: string[] = [];

  if (stages.attributes.changed) {
    const ok = stages.attributes.ok === true;
    okFlags.push(ok);
    if (!ok) failureSummaries.push(`attributes: ${stages.attributes.error}`);
  }
  if (stages.localizations.changed) {
    const okCount = stages.localizations.results?.filter((r) => r.ok).length ?? 0;
    const total = stages.localizations.results?.length ?? 0;
    okFlags.push(okCount === total && total > 0);
    if (total > 0 && okCount < total) {
      failureSummaries.push(`localizations: ${total - okCount}/${total} failed`);
    }
  }
  if (stages.screenshot.changed) {
    const ok = stages.screenshot.ok === true;
    okFlags.push(ok);
    if (!ok) failureSummaries.push(`screenshot: ${stages.screenshot.error}`);
  }
  if (stages.pricing.changed) {
    const ok = stages.pricing.outcome?.kind === "set";
    okFlags.push(ok);
    if (!ok) {
      failureSummaries.push(`pricing: ${stages.pricing.outcome?.kind ?? "unknown"}`);
    }
  }

  const everyOk = okFlags.every((f) => f);
  const anyOk = okFlags.some((f) => f);
  if (everyOk) {
    return {
      overall: "SUCCESS",
      summary: `All ${okFlags.length} stage(s) succeeded.`,
    };
  }
  if (anyOk) {
    return {
      overall: "PARTIAL",
      summary: `Partial success — ${failureSummaries.join("; ")}`,
    };
  }
  return {
    overall: "FAILURE",
    summary: failureSummaries.join("; ") || "All stages failed.",
  };
}

function errToString(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write a single actions_log row for one update stage. Wrapped in try/catch
 * per the IAP.o.11a discipline so an INSERT failure (constraint, RLS, etc.)
 * surfaces to Railway console explicitly rather than dropping the trace.
 */
async function writeAuditRow(
  audit: UpdateAuditContext,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await iapDb().from("actions_log").insert({
      iap_id: audit.iapId,
      actor: audit.actor,
      action_type: actionType,
      payload,
    });
    if (error) {
      console.error(
        `[update-on-apple] audit insert error action=${actionType}: ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[update-on-apple] audit insert threw action=${actionType}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
