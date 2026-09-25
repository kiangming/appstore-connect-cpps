/**
 * ⏳⚠⚠ TEMPORARY INSTRUMENTATION — **THIS ROUTE WRITES TO APPLE.**
 * Arc `[LOC-V2-model]`, chunk **[LOCV2-write-probe]**. Manager-approved
 * 2026-09-25 with the target item named. DELETE ONCE IT HAS ANSWERED.
 *
 *   GET /api/iap-management/apps/{appleAppId}/loc-v2-write-probe
 *       ?product={productId}&expect={localizationId}&confirm=WRITE
 *
 * ⚠ THE NAME SAYS `write-probe` ON PURPOSE. Its sibling `loc-v2-snapshot` is
 * read-only and is held to that by `zero-write.structural.test.ts`. That test
 * does NOT apply here — so this route has its own guard instead, and the guard
 * is narrower rather than absent: `one-write.structural.test.ts` pins that
 * exactly one write function is imported, called exactly once, against exactly
 * one localization id, with no loop and no batch.
 *
 * ─── THE ONE QUESTION ──────────────────────────────────────────────────────
 *
 *   `PATCH /v2/inAppPurchaseLocalizations/{id}` on a localization owned by an
 *   **APPROVED** version — what does Apple do, and does a new version appear?
 *
 * Everything else in the arc was settled by reading (KB §31.11). This cannot
 * be: it is a question about a write, and only a write answers it.
 *
 * ─── FOUR STEPS, ONE CLICK ─────────────────────────────────────────────────
 *
 *   1. SNAPSHOT BEFORE — versions + locales + **content** (two-stage read)
 *   2. CHOOSE TARGET   — derived from the data, vetoed by `expect`
 *   3. WRITE           — exactly one PATCH; full status + body logged
 *   4. SNAPSHOT AFTER  — diff across **three tiers**: version count, locale
 *                        list, and ⭐ content. Without tier 3, branch 4 —
 *                        Apple writing into the existing draft — is invisible,
 *                        and branch 4 is the whole reason this item was chosen.
 *
 * ─── ⚠ WHY A GET CAN BE SAFE ENOUGH HERE ───────────────────────────────────
 *
 * A GET that writes is normally a trap: browsers revisit, prefetch and restore
 * tabs. Three things bound it, and none of them alone would be enough:
 *   · `confirm=WRITE` must be present — an accidental or bookmarked hit of the
 *     bare path does nothing.
 *   · Step 2 refuses when no locale diverges. ⭐ After a successful write into
 *     the draft, the draft MATCHES the approved content, so a second run finds
 *     nothing to patch and stops. Re-running is therefore self-limiting — a
 *     property of the derive-the-target design, not an extra mechanism.
 *   · One product, one localization, no list parameter at all.
 */
import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  listAllInAppPurchases,
  listInAppPurchaseVersionsWithLocalizations,
  listLocalizationsForVersion,
  updateInAppPurchaseLocalizationV2,
} from "@/lib/iap-management/apple/client";
import { withRetry, AppleApiError } from "@/lib/iap-management/apple/fetch";
import {
  summarizeVersionSnapshot,
  type VersionSnapshot,
  type ProbeVersion,
  type ProbeLocalization,
  type VersionLocalizationsFetch,
} from "@/lib/iap-management/bulk-import/localization-v2-snapshot";
import {
  chooseWriteTarget,
  readWriteProbeResult,
  describeWriteProbeForLog,
} from "@/lib/iap-management/bulk-import/localization-v2-write-probe";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_FEATURE = "iap-locv2-write-probe";
const PAUSE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Steps 1 and 4 — the identical two-stage read, run twice. */
async function takeSnapshot(
  creds: Awaited<ReturnType<typeof getActiveAccount>>,
  productId: string,
  appleIapId: string,
): Promise<VersionSnapshot> {
  const versionsRes = await withRetry(() =>
    listInAppPurchaseVersionsWithLocalizations(creds, appleIapId),
  );
  const versions = (versionsRes.data ?? []) as unknown as ProbeVersion[];

  const fetched: VersionLocalizationsFetch[] = [];
  for (const v of versions) {
    const versionId = typeof v.id === "string" ? v.id : "";
    if (!versionId) continue;
    try {
      const locRes = await withRetry(() =>
        listLocalizationsForVersion(creds, versionId),
      );
      fetched.push({
        versionId,
        rows: (locRes.data ?? []) as unknown as ProbeLocalization[],
        hasMorePages: Boolean(locRes.links?.next),
      });
    } catch (err) {
      fetched.push({
        versionId,
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(PAUSE_MS);
  }
  return summarizeVersionSnapshot(productId, versions, fetched);
}

export async function GET(req: Request, ctx: { params: { appId: string } }) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const url = new URL(req.url);
  const productId = (url.searchParams.get("product") ?? "").trim();
  const expect = (url.searchParams.get("expect") ?? "").trim();
  const confirm = url.searchParams.get("confirm");

  if (!productId || !expect) {
    return NextResponse.json(
      {
        error:
          "Missing ?product=<productId>&expect=<localizationId>. `expect` is " +
          "the localization id the snapshot showed; a mismatch aborts the " +
          "write rather than patching a resource nobody looked at.",
      },
      { status: 400 },
    );
  }
  if (confirm !== "WRITE") {
    return NextResponse.json(
      {
        error:
          "This endpoint WRITES to Apple. Add &confirm=WRITE to proceed.",
        writes: true,
      },
      { status: 400 },
    );
  }

  const creds = await getActiveAccount();

  const all = await listAllInAppPurchases(creds, ctx.params.appId);
  const appleIapId = (all.data ?? []).find(
    (iap) => iap.attributes.productId === productId,
  )?.id;
  if (!appleIapId) {
    return NextResponse.json(
      { error: `${productId} not found in this app's In-App Purchase list` },
      { status: 404 },
    );
  }

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const before = await takeSnapshot(creds, productId, appleIapId);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const choice = chooseWriteTarget(before, expect);
  if (!choice.ok) {
    // ⚠ NO WRITE HAPPENED. Every refusal returns here, before step 3 exists.
    await log(LOG_FEATURE, `LOCV2-WRITE-PROBE product=${productId} ABORTED ${choice.reason}`, "WARN");
    return NextResponse.json(
      { product_id: productId, wrote: false, aborted: choice.reason, before },
      { status: 409 },
    );
  }
  const target = choice.target;

  // ── Step 3 — the one and only write ───────────────────────────────────────
  let httpStatus = 0;
  let body = "";
  let httpOk = false;
  try {
    const res = await updateInAppPurchaseLocalizationV2(
      creds,
      target.localizationId,
      target.payload,
    );
    httpStatus = 200;
    httpOk = true;
    body = JSON.stringify(res);
  } catch (err) {
    // ⚠ THE WHOLE BODY, VERBATIM — the habit that has now paid twice
    // (KB §28.8, §31.10). Apple's own words are the finding.
    if (err instanceof AppleApiError) {
      httpStatus = err.status;
      body = err.body;
    } else {
      body = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Step 4 ────────────────────────────────────────────────────────────────
  await sleep(PAUSE_MS);
  const after = await takeSnapshot(creds, productId, appleIapId);
  const reading = readWriteProbeResult(before, after, target, httpOk);

  await log(
    LOG_FEATURE,
    describeWriteProbeForLog(productId, target, httpStatus, before, after, reading, body),
    reading.verdict === "UNEXPECTED_COLLATERAL" ? "ERROR" : "INFO",
  );

  return NextResponse.json({
    product_id: productId,
    wrote: true,
    target,
    http: { status: httpStatus, body },
    verdict: reading.verdict,
    summary: reading.summary,
    new_version_ids: reading.newVersionIds,
    content_changes: reading.contentChanges,
    collateral: reading.collateral,
    before,
    after,
  });
}
