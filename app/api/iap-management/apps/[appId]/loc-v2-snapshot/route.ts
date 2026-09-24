/**
 * ⏳ TEMPORARY INSTRUMENTATION — DELETE ONCE IT HAS ANSWERED.
 * Arc `[LOC-V2-model]`, chunk **V0-snapshot**. Manager-approved 2026-09-24.
 *
 *   GET /api/iap-management/apps/{appleAppId}/loc-v2-snapshot?products=a,b,c
 *
 * ⚠⚠ THIS ROUTE WRITES NOTHING TO APPLE. That is not a hope, it is the
 * contract, and `loc-v2-snapshot.zero-write.structural.test.ts` enforces it
 * against this file's source. The Manager's whole reason for splitting the
 * measurement in two is that part 1 must be safe to run on live, selling
 * products before anyone decides what part 2 may touch:
 *   *"Quyết định ghi trước khi nhìn là quyết định mù."*
 *
 * ⚠ WHY A ROUTE AND NOT A LOG LINE INSIDE BULK IMPORT. The existing probe
 * (`LOC-STATE-PROBE`) rides the OVERWRITE path, so reading it costs a real
 * bulk-import run and a Railway log grep, and it only ever sees whichever
 * products happened to be in the spreadsheet. This question needs the opposite:
 * SEVERAL products the Manager names — edited-by-hand, never-edited,
 * multi-locale — compared side by side, before any run. A URL the Manager opens
 * in the browser delivers that with no spreadsheet and no write.
 *
 * ⚠ THE ANSWER IS RETURNED IN THE RESPONSE, NOT ONLY LOGGED. Railway logs are
 * where `LOC-STATE-PROBE` had to be read from, and that cost a round trip every
 * time. The greppable line is still emitted (same habit, same grep), but the
 * Manager reads the JSON directly.
 *
 * ⚠ SEQUENTIAL, NOT PARALLEL. One Apple request per product with a pause
 * between. This is a diagnostic, not a hot path; a fan-out here would spend
 * rate budget the import itself needs (KB: Hotfix 26 dropped bulk-import
 * concurrency 5 → 2 after 429 cascades).
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
} from "@/lib/iap-management/apple/client";
import { withRetry } from "@/lib/iap-management/apple/fetch";
import {
  summarizeVersionSnapshot,
  describeVersionSnapshotForLog,
  type VersionSnapshot,
  type ProbeVersion,
  type ProbeIncluded,
} from "@/lib/iap-management/bulk-import/localization-v2-snapshot";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_FEATURE = "iap-locv2-snapshot";

/**
 * ⚠ A CAP, AND IT IS ANNOUNCED. Twenty products is 20 Apple requests plus the
 * enumeration. Beyond that the Manager should run it twice rather than have the
 * route quietly truncate — a silent cap reads as "that is all there is"
 * (CLAUDE.md: no silent caps).
 */
const MAX_PRODUCTS = 20;

/** Pause between per-product reads. Same order as bulk import's inter-row gap. */
const PAUSE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProductOutcome {
  product_id: string;
  /** Present when the read succeeded. */
  snapshot?: VersionSnapshot;
  /** The greppable line, so the response and the log say the same thing. */
  line?: string;
  /** Present when this ONE product failed — the others still ran. */
  error?: string;
}

export async function GET(
  req: Request,
  ctx: { params: { appId: string } },
) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const raw = new URL(req.url).searchParams.get("products");
  const requested = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  if (requested.length === 0) {
    return NextResponse.json(
      {
        error:
          "Missing ?products=<productId>[,<productId>…]. Naming the products " +
          "is deliberate: this reads live, selling items and the Manager " +
          "chooses which ones.",
      },
      { status: 400 },
    );
  }
  if (requested.length > MAX_PRODUCTS) {
    return NextResponse.json(
      {
        error:
          `${requested.length} products requested; this diagnostic reads at ` +
          `most ${MAX_PRODUCTS} per call. Split the list — it is not truncated ` +
          `silently.`,
      },
      { status: 400 },
    );
  }

  const creds = await getActiveAccount();

  // One enumeration resolves productId → Apple id for every requested product.
  const all = await listAllInAppPurchases(creds, ctx.params.appId);
  const appleIdByProduct = new Map<string, string>();
  for (const iap of all.data ?? []) {
    appleIdByProduct.set(iap.attributes.productId, iap.id);
  }

  const results: ProductOutcome[] = [];
  for (let i = 0; i < requested.length; i++) {
    const productId = requested[i];
    const appleIapId = appleIdByProduct.get(productId);
    if (!appleIapId) {
      // ⚠ NOT an empty snapshot. "Apple has no such product in this app" and
      // "Apple has a product with no versions" are different facts, and the
      // second one is a finding while the first is a typo.
      results.push({
        product_id: productId,
        error: "not found in this app's In-App Purchase list",
      });
      continue;
    }
    try {
      // ⚠ WRAPPED EXACTLY ONCE, AND `listAllInAppPurchases` ABOVE IS NOT —
      // that asymmetry is the contract, not an inconsistency.
      // `listInAppPurchaseVersionsWithLocalizations` is a retry-NAIVE leaf (a
      // bare `iapFetch`), so one wrapper here is its only retry.
      // `listAllInAppPurchases` owns its retry internally and wrapping it
      // again is the exact double-wrap `retry-composition.structural.test.ts`
      // was written to stop. Both rules are enforced by that test.
      const res = await withRetry(() =>
        listInAppPurchaseVersionsWithLocalizations(creds, appleIapId),
      );
      const snapshot = summarizeVersionSnapshot(
        productId,
        (res.data ?? []) as unknown as ProbeVersion[],
        (res.included ?? []) as unknown as ProbeIncluded[],
      );
      const line = describeVersionSnapshotForLog(snapshot);
      await log(LOG_FEATURE, line);
      results.push({ product_id: productId, snapshot, line });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await log(
        LOG_FEATURE,
        `LOCV2-SNAPSHOT product=${productId} FAILED ${message}`,
        "WARN",
      );
      results.push({ product_id: productId, error: message });
    }
    if (i < requested.length - 1) await sleep(PAUSE_MS);
  }

  return NextResponse.json({
    app_id: ctx.params.appId,
    read_only: true,
    requested: requested.length,
    results,
  });
}
