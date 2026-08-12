/**
 * GET /api/iap-management/apps/[appId]/iaps/[iapId]/price-points?territory=VNM
 *
 * The price points Apple supports in ONE territory — the option list for that
 * territory's picker. Called lazily, only when a picker opens (design gate G3):
 * ~600 objects, one request, typically fewer than ten per dialog session.
 * Eager-fetching all ~175 territories would be ~105,000 objects for a table
 * the Manager edits a handful of rows of.
 *
 * Reuses `listPricePointsForIap` — the SAME function the orchestrator matches
 * against at submit time. That is not incidental: it is what keeps the client
 * rule ("only offer prices Apple lists for this territory") and the server rule
 * ("`findPricePointByUsdPrice` must find a match") the same rule over the same
 * source. A second fetcher, or a DB-backed option list, would let the two
 * disagree (design §I.5).
 *
 * Deliberately NOT `territory-price-points-cache.ts`: that cache is
 * orchestration-lifetime and per-IAP by construction. And no server-side cache
 * of any kind here — this is a cold path, and a stale in-memory cache across
 * Railway's rolling-deploy instances is strictly worse than none (P6). The
 * dialog caches per territory in its own React state for its own lifetime.
 *
 * ⚠ Returns only PRICES, never price-point ids. The id is per-IAP and is
 * resolved server-side at submit from the price (gate G2); handing an id to the
 * client would invite storing it, and a stored id goes stale the moment Apple
 * withdraws that point.
 */
import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { listPricePointsForIap } from "@/lib/iap-management/apple/price-points";
import { resolvePricePointSource } from "@/lib/iap-management/queries/price-point-donor";
import { NO_DONOR_REASON } from "@/lib/iap-management/custom-prices/baseline";
import { normalizeTerritoryCode } from "@/lib/iap-management/custom-prices/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PricePointOptionsResponse {
  territory: string;
  /** Ascending customer prices Apple offers here. Prices only — no ids. */
  prices: number[];
  /** Present when the catalog came from another IAP in the same app. */
  donor?: { apple_iap_id: string; same_type: boolean };
}

export async function GET(
  req: Request,
  ctx: { params: { appId: string; iapId: string } },
) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const territoryParam = new URL(req.url).searchParams.get("territory");
  if (!territoryParam) {
    return NextResponse.json(
      { error: "Missing ?territory=<alpha-3>" },
      { status: 400 },
    );
  }
  const territory = normalizeTerritoryCode(territoryParam);

  const existing = await getIapWithRelations(ctx.params.iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }

  // J-1: no synced IAP anywhere in this app ⇒ no catalog to read. 409 with a
  // machine-readable reason so the dialog renders the disabled state rather
  // than a generic failure — and NO price_tier_territories fallback, which
  // would offer prices Apple may have no point for.
  const source = await resolvePricePointSource({
    iapId: ctx.params.iapId,
    appId: existing.iap.app_id,
    appleIapId: existing.iap.apple_iap_id,
    type: existing.iap.type,
  });
  if (!source) {
    return NextResponse.json(
      { error: NO_DONOR_REASON, reason: "no-donor" },
      { status: 409 },
    );
  }

  const creds = await getActiveAccount();
  try {
    const points = await listPricePointsForIap(creds, source.appleIapId, territory);
    const prices = [
      ...new Set(
        points
          .map((p) => Number(p.attributes.customerPrice))
          .filter((n) => Number.isFinite(n)),
      ),
    ].sort((a, b) => a - b);
    const body: PricePointOptionsResponse = {
      territory,
      prices,
      ...(source.iapId !== ctx.params.iapId
        ? {
            donor: {
              apple_iap_id: source.appleIapId,
              same_type: source.sameType,
            },
          }
        : {}),
    };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[custom-prices] price-point fetch failed iap=${ctx.params.iapId} territory=${territory}: ${message}`,
    );
    return NextResponse.json(
      { error: `Apple price-point lookup failed for ${territory}: ${message}` },
      { status: 502 },
    );
  }
}
