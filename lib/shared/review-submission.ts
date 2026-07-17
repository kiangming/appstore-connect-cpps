/**
 * Apple `reviewSubmissions` / `reviewSubmissionItems` helpers — shared by
 * CPP (custom product pages) and IAP v2 submission. Both submit through the
 * SAME container resource; Apple allows only one *items-only* (no app
 * version) open reviewSubmission per (app, platform) at a time — CPP and
 * IAP submissions are both items-only, so they contend for that single
 * slot. See docs/iap-management/design-iap-v2-submission-migration.md §0.
 *
 * `createOrReuseReviewSubmission` NEVER blind-creates: it always checks for
 * an existing open submission first. This closes a latent bug CPP has had
 * since its first reviewSubmissions implementation (always POSTed a new
 * container, 409ing whenever Apple already had one open) and is the
 * building block the IAP v2 conflict-dialog flow (Decision A) sits on top
 * of.
 */

import { appleFetch, withRetry } from "@/lib/shared/apple-fetch";
import type { AscCredentials } from "@/lib/asc-jwt";
import type {
  AscApiResponse,
  ReviewSubmission,
  ReviewSubmissionItem,
} from "@/types/asc";

export type ReviewSubmissionPlatform = "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";

/** Every state except the terminal `COMPLETE` counts as "open" per Apple's
 *  documented submission lifecycle (see design doc §0, Q2). */
const OPEN_STATES = new Set<string>([
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "UNRESOLVED_ISSUES",
  "CANCELING",
  "COMPLETING",
]);

/**
 * Find the app's currently open items-only reviewSubmission, if any.
 * Read-only — zero Apple writes.
 */
export async function findOpenReviewSubmission(
  creds: AscCredentials,
  appId: string,
  platform: ReviewSubmissionPlatform,
  logTag: string,
): Promise<ReviewSubmission | null> {
  const res = await appleFetch<AscApiResponse<ReviewSubmission[]>>(
    creds,
    "GET",
    `/v1/apps/${appId}/reviewSubmissions?filter[platform]=${platform}`,
    undefined,
    logTag,
  );
  const open = (res.data ?? []).find((s) =>
    OPEN_STATES.has(s.attributes.state ?? ""),
  );
  return open ?? null;
}

export async function createReviewSubmission(
  creds: AscCredentials,
  appId: string,
  platform: ReviewSubmissionPlatform,
  logTag: string,
): Promise<ReviewSubmission> {
  const res = await appleFetch<AscApiResponse<ReviewSubmission>>(
    creds,
    "POST",
    "/v1/reviewSubmissions",
    {
      data: {
        type: "reviewSubmissions",
        attributes: { platform },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    },
    logTag,
  );
  return res.data;
}

export interface CreateOrReuseResult {
  submission: ReviewSubmission;
  /** True when an existing open submission was reused rather than created —
   *  callers MUST NOT delete a reused submission on rollback (it may
   *  contain items from another flow/module entirely). */
  reused: boolean;
}

/**
 * Create-or-reuse: check for an open items-only submission first, reuse it
 * if present, only POST a new one when none exists. Never blind-creates.
 */
export async function createOrReuseReviewSubmission(
  creds: AscCredentials,
  appId: string,
  platform: ReviewSubmissionPlatform,
  logTag: string,
): Promise<CreateOrReuseResult> {
  const existing = await findOpenReviewSubmission(creds, appId, platform, logTag);
  if (existing) {
    return { submission: existing, reused: true };
  }
  const created = await createReviewSubmission(creds, appId, platform, logTag);
  return { submission: created, reused: false };
}

export async function getReviewSubmissionItems(
  creds: AscCredentials,
  submissionId: string,
  logTag: string,
): Promise<ReviewSubmissionItem[]> {
  const res = await appleFetch<AscApiResponse<ReviewSubmissionItem[]>>(
    creds,
    "GET",
    `/v1/reviewSubmissions/${submissionId}/items`,
    undefined,
    logTag,
  );
  return res.data ?? [];
}

export async function addReviewSubmissionItem(
  creds: AscCredentials,
  submissionId: string,
  relationshipKey: string,
  targetType: string,
  targetId: string,
  logTag: string,
): Promise<ReviewSubmissionItem> {
  const res = await appleFetch<AscApiResponse<ReviewSubmissionItem>>(
    creds,
    "POST",
    "/v1/reviewSubmissionItems",
    {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submissionId },
          },
          [relationshipKey]: {
            data: { type: targetType, id: targetId },
          },
        },
      },
    },
    logTag,
  );
  return res.data;
}

export async function submitReviewSubmission(
  creds: AscCredentials,
  submissionId: string,
  logTag: string,
): Promise<void> {
  await appleFetch<unknown>(
    creds,
    "PATCH",
    `/v1/reviewSubmissions/${submissionId}`,
    {
      data: {
        type: "reviewSubmissions",
        id: submissionId,
        attributes: { submitted: true },
      },
    },
    logTag,
  );
}

/** Cancels/deletes a submission container. Only safe to call on a
 *  submission this flow CREATED — never on a reused one (see
 *  `CreateOrReuseResult.reused`). */
export async function deleteReviewSubmission(
  creds: AscCredentials,
  submissionId: string,
  logTag: string,
): Promise<void> {
  await appleFetch<void>(
    creds,
    "DELETE",
    `/v1/reviewSubmissions/${submissionId}`,
    undefined,
    logTag,
  );
}

/**
 * Returns the relationship key describing what a reviewSubmissionItem
 * targets (e.g. "appCustomProductPageVersion", "inAppPurchaseVersion"), or
 * "unknown" if Apple returned an item whose relationships carry no `data`
 * (opaque — links only). JSON:API top-level `data[]` resources (which is
 * what `GET /v1/reviewSubmissions/{id}/items` returns) should always carry
 * `data`, but the "unknown" fallback keeps this defensive rather than
 * throwing on an unexpected shape.
 */
export function classifyReviewSubmissionItem(
  item: ReviewSubmissionItem,
): string {
  const rel = item.relationships ?? {};
  for (const key of Object.keys(rel)) {
    if (key === "reviewSubmission") continue;
    if (rel[key]?.data) return key;
  }
  return "unknown";
}

export interface ForeignItemsSummary {
  /** Total items in the submission that are NOT part of the caller's own
   *  batch (identified via `ownTargetIds`). */
  count: number;
  /** Count grouped by relationship key (e.g. { appCustomProductPageVersion: 3,
   *  inAppPurchaseVersion: 2 }). Includes "unknown" when Apple returned
   *  opaque items this app can't classify. */
  byKind: Record<string, number>;
  /** False when at least one foreign item's kind couldn't be determined —
   *  callers should degrade the conflict-dialog message to a bare count
   *  rather than claiming to enumerate exact item types. */
  typesKnown: boolean;
}

/**
 * Summarize everything in a reviewSubmission that ISN'T part of the
 * caller's own batch — the data the Decision A conflict dialog renders
 * ("3 Custom Product Pages, 2 other In-App Purchases already in this
 * submission").
 *
 * `ownRelationshipKey` + `ownTargetIds` identify "mine": an item counts as
 * "own" only if its relationship under `ownRelationshipKey` points at an id
 * in `ownTargetIds`. Everything else — including items under a DIFFERENT
 * relationship key entirely (e.g. CPP versions when the caller is IAP) — is
 * foreign.
 */
export function summarizeForeignItems(
  items: ReviewSubmissionItem[],
  ownRelationshipKey: string,
  ownTargetIds: ReadonlySet<string>,
): ForeignItemsSummary {
  const byKind: Record<string, number> = {};
  let typesKnown = true;

  for (const item of items) {
    const rel = item.relationships ?? {};
    const ownRef = rel[ownRelationshipKey];
    if (ownRef?.data && ownTargetIds.has(ownRef.data.id)) {
      continue; // one of ours — not foreign
    }
    const kind = classifyReviewSubmissionItem(item);
    if (kind === "unknown") typesKnown = false;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }

  const count = Object.values(byKind).reduce((a, b) => a + b, 0);
  return { count, byKind, typesKnown };
}

// Re-exported for callers that want the raw retry primitive alongside the
// review-submission helpers without a second import line.
export { withRetry };
