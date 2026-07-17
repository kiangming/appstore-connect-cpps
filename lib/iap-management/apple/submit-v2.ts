/**
 * IAP submission via Apple's reviewSubmissions / reviewSubmissionItems
 * mechanism (v2) — mirrors CPP's proven `prepareCppSubmission` /
 * `confirmCppSubmission` / `rollbackCppSubmission` shape (lib/asc-client.ts),
 * with the IAP-specific delta: reading (rarely creating) an
 * `inAppPurchaseVersion` before attaching it to a reviewSubmissionItem.
 *
 * Kept ENTIRELY separate from the legacy `submitInAppPurchase` v1 flow
 * (client.ts's `POST /v1/inAppPurchaseSubmissions`) — that code stays
 * intact and is what runs when `submit-v2-toggle.ts` says v2 is off for an
 * app. See docs/iap-management/design-iap-v2-submission-migration.md.
 *
 * Decision A (never silently co-submit): `checkForConflict` is READ-ONLY —
 * it never creates or adds anything, so the caller can show a conflict
 * dialog before any Apple write happens. `executeSubmitV2` is the write
 * phase, only ever called once the caller has confirmed (or there was
 * nothing to confirm).
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { withRetry, AppleApiError } from "@/lib/shared/apple-fetch";
import {
  findOpenReviewSubmission,
  createOrReuseReviewSubmission,
  getReviewSubmissionItems,
  addReviewSubmissionItem,
  submitReviewSubmission,
  deleteReviewSubmission,
  summarizeForeignItems,
  type ForeignItemsSummary,
} from "@/lib/shared/review-submission";
import {
  listInAppPurchaseVersions,
  createInAppPurchaseVersion,
} from "./client";
import { log } from "@/lib/logger";

const LOG_TAG = "iap-submit-v2";

/** Reuses the same pacing pattern as bulk-import's INTER_ROW_DELAY_MS —
 *  see app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts. */
const INTER_ITEM_DELAY_MS = 1000;

const SUBMITTABLE_VERSION_STATES = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface SubmitV2Item {
  iapId: string;
  appleIapId: string;
  productId: string;
}

// ─── Conflict check (Decision A) — read-only, zero writes ──────────────────

export type ConflictCheckResult =
  | { kind: "clear-no-existing" }
  | { kind: "clear-reuse"; reviewSubmissionId: string }
  | { kind: "conflict"; reviewSubmissionId: string; foreignItemsSummary: ForeignItemsSummary };

/**
 * Check whether the app already has an open items-only reviewSubmission
 * containing anything. Purely read-only (at most 2 GETs) — safe to call
 * before showing (or skipping) the conflict dialog.
 */
export async function checkForConflict(
  creds: AscCredentials,
  appleAppId: string,
): Promise<ConflictCheckResult> {
  const existing = await withRetry(() =>
    findOpenReviewSubmission(creds, appleAppId, "IOS", LOG_TAG),
  );
  if (!existing) {
    return { kind: "clear-no-existing" };
  }

  const items = await withRetry(() =>
    getReviewSubmissionItems(creds, existing.id, LOG_TAG),
  );
  // Nothing has been added by THIS flow yet at check time, so every item
  // currently in a reused-but-nonempty submission counts as foreign.
  const foreignItemsSummary = summarizeForeignItems(
    items,
    "inAppPurchaseVersion",
    new Set(),
  );
  if (foreignItemsSummary.count === 0) {
    return { kind: "clear-reuse", reviewSubmissionId: existing.id };
  }
  return { kind: "conflict", reviewSubmissionId: existing.id, foreignItemsSummary };
}

// ─── Version resolution (rare defensive fallback) ──────────────────────────

interface ResolvedVersion {
  id: string;
  createdFallback: boolean;
}

async function resolveInAppPurchaseVersionId(
  creds: AscCredentials,
  item: SubmitV2Item,
): Promise<ResolvedVersion> {
  const existing = await listInAppPurchaseVersions(creds, item.appleIapId);
  const submittable = (existing.data ?? []).find((v) =>
    SUBMITTABLE_VERSION_STATES.has(v.attributes.state),
  );
  if (submittable) {
    return { id: submittable.id, createdFallback: false };
  }

  // Rare defensive fallback — confirmed empirically (design doc §0 Q1) that
  // READY_TO_SUBMIT IAPs already have a submittable version, so this should
  // be rare-to-never in practice. No DELETE endpoint exists for
  // inAppPurchaseVersions, so this creates a PERMANENT Apple-side artifact —
  // log explicitly so an orphan (if the subsequent item-add then fails) is
  // visible in Railway for spot-checking.
  await log(
    LOG_TAG,
    `app=${item.appleIapId} iap=${item.iapId} created fallback version — no existing submittable inAppPurchaseVersion found`,
    "WARN",
  );
  const created = await createInAppPurchaseVersion(creds, item.appleIapId);
  await log(
    LOG_TAG,
    `app=${item.appleIapId} iap=${item.iapId} created fallback version id=${created.data.id}`,
    "WARN",
  );
  return { id: created.data.id, createdFallback: true };
}

// ─── Write phase — create-or-reuse + item adds (paced + retried) ──────────

export interface SubmitV2ItemResult {
  iapId: string;
  appleIapId: string;
  productId: string;
  status: "SUCCESS" | "ERROR";
  error?: string;
  usedFallbackVersionCreate?: boolean;
  /** True when a fallback version was created on Apple for this item but
   *  the subsequent reviewSubmissionItem add then failed — the version now
   *  permanently exists on Apple and cannot be auto-removed. Surface this
   *  to the user distinctly from an ordinary submit failure. */
  orphanedVersionWarning?: boolean;
}

export interface ExecuteSubmitV2Result {
  reviewSubmissionId: string;
  reused: boolean;
  items: SubmitV2ItemResult[];
}

/**
 * Write phase: create-or-reuse the reviewSubmission, then sequentially add
 * each item (inter-item pacing + `withRetry` 429 handling on every Apple
 * call — version read, rare version create, item add). Does NOT submit
 * (PATCH `submitted:true`) — call `confirmSubmitV2` once the caller has
 * decided how to handle any per-item failures (see
 * `docs/iap-management/design-iap-v2-submission-migration.md` §5 rate-limit
 * plan: this is the N+3-call path when versions pre-exist).
 */
export async function executeSubmitV2(
  creds: AscCredentials,
  appleAppId: string,
  items: SubmitV2Item[],
): Promise<ExecuteSubmitV2Result> {
  const { submission, reused } = await withRetry(() =>
    createOrReuseReviewSubmission(creds, appleAppId, "IOS", LOG_TAG),
  );

  const results: SubmitV2ItemResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) await sleep(INTER_ITEM_DELAY_MS);

    let versionInfo: ResolvedVersion | null = null;
    try {
      const resolved = await withRetry(() =>
        resolveInAppPurchaseVersionId(creds, item),
      );
      versionInfo = resolved;
      await withRetry(() =>
        addReviewSubmissionItem(
          creds,
          submission.id,
          "inAppPurchaseVersion",
          "inAppPurchaseVersions",
          resolved.id,
          LOG_TAG,
        ),
      );
      results.push({
        iapId: item.iapId,
        appleIapId: item.appleIapId,
        productId: item.productId,
        status: "SUCCESS",
        usedFallbackVersionCreate: resolved.createdFallback,
      });
    } catch (err) {
      const orphaned = Boolean(versionInfo?.createdFallback);
      const baseError = errMsg(err);
      results.push({
        iapId: item.iapId,
        appleIapId: item.appleIapId,
        productId: item.productId,
        status: "ERROR",
        error: orphaned
          ? `${baseError} — a fallback inAppPurchaseVersion was created for this IAP on Apple before this failure and cannot be auto-removed; check App Store Connect if this recurs.`
          : baseError,
        orphanedVersionWarning: orphaned,
      });
    }
  }

  return { reviewSubmissionId: submission.id, reused, items: results };
}

// ─── Confirm / rollback ─────────────────────────────────────────────────────

export async function confirmSubmitV2(
  creds: AscCredentials,
  reviewSubmissionId: string,
): Promise<void> {
  await withRetry(() => submitReviewSubmission(creds, reviewSubmissionId, LOG_TAG));
}

export interface RollbackResult {
  deleted: boolean;
}

/**
 * Rollback for a partially-failed batch. A REUSED submission is NEVER
 * deleted — it may contain items this flow never added (other IAPs, CPP
 * pages, a prior partial batch) and deleting it would cancel those too.
 * For a freshly-created submission (safe — contains only what this flow
 * added), DELETE cancels the whole container, matching CPP's existing
 * rollback semantics.
 */
export async function rollbackOrLeaveSubmitV2(
  creds: AscCredentials,
  reviewSubmissionId: string,
  reused: boolean,
): Promise<RollbackResult> {
  if (reused) {
    await log(
      LOG_TAG,
      `reviewSubmission=${reviewSubmissionId} was reused — leaving in place on rollback (never delete a shared container)`,
      "WARN",
    );
    return { deleted: false };
  }
  await deleteReviewSubmission(creds, reviewSubmissionId, LOG_TAG);
  return { deleted: true };
}
