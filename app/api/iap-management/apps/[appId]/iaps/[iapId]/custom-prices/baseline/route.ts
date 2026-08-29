/**
 * GET /api/iap-management/apps/[appId]/iaps/[iapId]/custom-prices/baseline
 *     ?tier_id=TIER_10&pricing_source=APP_TEMPLATE
 *
 * Everything the custom-prices dialog needs to render its ~175 rows, in ONE
 * request — and with ZERO price-point fetches (design gate G3). Price points are
 * a separate, per-territory, lazy call (../price-points).
 *
 * Assembled from:
 *   territories      Apple /v1/territories (existing cached helper)
 *   template         price_tier_template_entries for the CURRENT tier + source
 *   existing manual  the G4 schedule read — synced IAPs only
 *   customs          iap_custom_prices via SC1's single-writer repository
 *
 * ⚠ The G4 read is `getPriceScheduleForIap` (price-schedules.ts:308-375), which
 * already mitigates Apple's V2 `?include` 10-ID relationship truncation
 * internally (KB LANDMARK §4.1 — the trap that once made this tool render fewer
 * rows than Apple Connect). Do not re-derive that; call it and inherit the fix.
 * The response is filtered to startDate === null by `effectiveNowManualPrices`
 * so a scheduled FUTURE change can never be read as the current price.
 *
 * Fail-soft per section: a territory-list or schedule failure degrades that
 * column (and says so) rather than failing the dialog. A template read failure
 * likewise. The dialog is a read surface; a partial table the Manager can see is
 * more useful than an error page.
 */
import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { getAllTerritoryIds } from "@/lib/iap-management/apple/availabilities";
import {
  getPriceScheduleForIap,
  NoPriceScheduleError,
} from "@/lib/iap-management/apple/price-schedules";
import { unpackPriceSchedule } from "@/lib/iap-management/queries/iap-detail";
import {
  getDefaultTemplate,
  getAppTemplate,
} from "@/lib/iap-management/queries/templates";
import { getTierUsdPrice } from "@/lib/iap-management/queries/price-tiers";
import { listCustomPrices } from "@/lib/iap-management/custom-prices/repository";
import { effectiveNowManualPrices } from "@/lib/iap-management/custom-prices/baseline";
import { resolvePricePointSource } from "@/lib/iap-management/queries/price-point-donor";
import { territoryName } from "@/components/iap-management/view-detail/territory-name";
import { currencyForTerritory } from "@/lib/iap-management/territory-catalog";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import countries from "i18n-iso-countries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BASE_TERRITORY = "USA";

export interface CustomPriceBaselineResponse {
  base_territory: string;
  base_price: number | null;
  territories: Array<{ code: string; name: string; currency: string | null }>;
  template_entries: Array<{
    territory_code: string;
    customer_price: number;
    currency_code: string;
  }>;
  existing_manual: Array<{
    territory: string;
    customerPrice: number;
    currency: string | null;
  }>;
  custom_prices: Array<{
    territory_code: string;
    customer_price: number;
    currency_code: string;
  }>;
  /** J-1: false ⇒ the picker must be disabled with the reason shown. */
  donor_available: boolean;
  /** Per-section degradation, surfaced so the dialog can say which column is
   *  incomplete instead of implying the data is authoritative. */
  warnings: string[];
}

/** Apple ships alpha-3; the currency catalog is keyed alpha-2. */
function currencyFor(alpha3: string): string | null {
  const alpha2 = countries.alpha3ToAlpha2(alpha3);
  return alpha2 ? currencyForTerritory(alpha2) : null;
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

  const url = new URL(req.url);
  const tierId = url.searchParams.get("tier_id");
  const pricingSource = (url.searchParams.get("pricing_source") ??
    "APPLE") as PricingSourceKind;

  const existing = await getIapWithRelations(ctx.params.iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }

  const warnings: string[] = [];

  // ── Apple credentials (territory list + schedule need them) ──────────────
  let creds: Awaited<ReturnType<typeof getActiveAccount>> | null = null;
  try {
    creds = await getActiveAccount();
  } catch (err) {
    warnings.push(
      `Apple credentials unavailable (${err instanceof Error ? err.message : "unknown"}) — territory list and live prices omitted.`,
    );
  }

  // ── Territories ──────────────────────────────────────────────────────────
  let territoryCodes: string[] = [];
  if (creds) {
    try {
      territoryCodes = await getAllTerritoryIds(creds);
    } catch (err) {
      warnings.push(
        `Territory list fetch failed (${err instanceof Error ? err.message : "unknown"}).`,
      );
    }
  }

  // ── Template entries for the CURRENT tier + source ────────────────────────
  // Only this tier's rows: a Default Template is ~16,800 entries and the dialog
  // needs ~175 of them.
  const templateEntries: CustomPriceBaselineResponse["template_entries"] = [];
  if (tierId && pricingSource !== "APPLE") {
    try {
      const template =
        pricingSource === "APP_TEMPLATE"
          ? await getAppTemplate(existing.iap.app_id)
          : creds
            ? await getDefaultTemplate(creds.id)
            : null;
      if (template) {
        for (const entry of template.entries) {
          if (entry.tier_id !== tierId) continue;
          templateEntries.push({
            territory_code: entry.territory_code,
            customer_price: entry.customer_price,
            currency_code: entry.currency_code,
          });
        }
      }
    } catch (err) {
      warnings.push(
        `Template read failed (${err instanceof Error ? err.message : "unknown"}) — template column incomplete.`,
      );
    }
  }

  // ── Existing manual prices on Apple (G4) — synced IAPs only ───────────────
  let existingManual: CustomPriceBaselineResponse["existing_manual"] = [];
  if (creds && existing.iap.apple_iap_id) {
    try {
      const res = await getPriceScheduleForIap(creds, existing.iap.apple_iap_id);
      const unpacked = unpackPriceSchedule(res);
      // ⚠ startDate === null only. A future-dated entry is an upcoming change,
      // not the current price — importing one would set tomorrow's price today.
      existingManual = effectiveNowManualPrices(unpacked.entries).map((e) => ({
        territory: e.territory,
        customerPrice: Number(e.customerPrice),
        currency: e.currency,
      }));
    } catch (err) {
      // Apple having no schedule yet is not an error worth surfacing.
      // ⚠ Was `/404/.test(err.message)` — a REGEX OVER A MESSAGE STRING.
      // It matched any error whose text happened to contain "404" (including
      // one whose URL did), and it could not tell a stage-1 404 from a
      // stage-2 one. The type carries the fact now; nothing parses it back
      // out of prose.
      if (!(err instanceof NoPriceScheduleError)) {
        const msg = err instanceof Error ? err.message : "unknown";
        warnings.push(`Live Apple prices unavailable (${msg}).`);
      }
    }
  }

  // ── Customs (SC1 single writer) ───────────────────────────────────────────
  const customPrices = await listCustomPrices(ctx.params.iapId);

  // ── Base price for the base row ───────────────────────────────────────────
  let basePrice: number | null = null;
  if (tierId) {
    try {
      basePrice = await getTierUsdPrice(tierId);
    } catch {
      // Non-fatal — the base row shows no number rather than a wrong one.
    }
  }

  // ── J-1 donor availability ────────────────────────────────────────────────
  let donorAvailable = false;
  try {
    donorAvailable =
      (await resolvePricePointSource({
        iapId: ctx.params.iapId,
        appId: existing.iap.app_id,
        appleIapId: existing.iap.apple_iap_id,
        type: existing.iap.type,
      })) !== null;
  } catch (err) {
    warnings.push(
      `Donor lookup failed (${err instanceof Error ? err.message : "unknown"}) — picker disabled.`,
    );
  }

  const body: CustomPriceBaselineResponse = {
    base_territory: existing.iap.base_territory ?? DEFAULT_BASE_TERRITORY,
    base_price: basePrice,
    territories: territoryCodes.map((code) => ({
      code,
      name: territoryName(code),
      currency: currencyFor(code),
    })),
    template_entries: templateEntries,
    existing_manual: existingManual,
    custom_prices: customPrices,
    donor_available: donorAvailable,
    warnings,
  };
  return NextResponse.json(body);
}
