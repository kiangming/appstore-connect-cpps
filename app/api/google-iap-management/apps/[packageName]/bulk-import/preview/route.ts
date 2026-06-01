/**
 * Bulk-import preview endpoint (g1.i).
 *
 * Accepts a multipart-form Excel upload, parses it via the IAP template
 * parser, looks up which SKUs already exist in cache, and returns a
 * structured preview the wizard can render. Does NOT call Google.
 *
 * Hotfix 19: when the Manager selected a template-based pricing source
 * (default_template / app_template), per-row candidate-tier metadata is
 * surfaced inline. The wizard's Preview step uses these to render the
 * Tier column: 0 candidates → "Auto-converted from USD", 1 → read-only
 * tier display, >1 → dropdown with primary tier pre-selected.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { listIapsForApp } from "@/lib/google-iap-management/repository/iaps";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { parseIapTemplate } from "@/lib/google-iap-management/parsers/excel-parser";
import { decimalToMicros, microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";
import {
  findRowCandidates,
  getPrimaryTierFromCandidates,
  type TierCandidate,
} from "@/lib/google-iap-management/queries/templates";
import {
  detectCrossCurrencyTrigger,
  findCrossCurrencyCandidates,
  resolveAppCurrencyEntryForTier,
  fileDecimalToAnchorMicros,
  REFUSAL_REASONS,
} from "@/lib/google-iap-management/orchestration/cross-currency";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { withConcurrency } from "@/lib/iap-management/concurrency";

type PricingSource = "google_default" | "default_template" | "app_template";
const VALID_PRICING_SOURCES: PricingSource[] = [
  "google_default",
  "default_template",
  "app_template",
];
const CANDIDATE_LOOKUP_CONCURRENCY = 5;

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      {
        error:
          "No Google Console accounts configured. Add one in Settings → Google Console Accounts first.",
      },
      { status: 400 },
    );
  }

  const packageName = decodeURIComponent(params.packageName);
  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' field is required." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes); cap is ${MAX_BYTES}.` },
      { status: 413 },
    );
  }

  // Hotfix 19: pricingSource arrives alongside the file so the API can
  // pre-compute per-row tier candidates. Optional — wizard sends it from
  // Step 1; falls back to "google_default" for older clients.
  const rawPricingSource = form.get("pricingSource");
  const pricingSource: PricingSource = (() => {
    if (typeof rawPricingSource === "string" && (VALID_PRICING_SOURCES as string[]).includes(rawPricingSource)) {
      return rawPricingSource as PricingSource;
    }
    return "google_default";
  })();

  const buffer = Buffer.from(await file.arrayBuffer());
  // Hotfix 16: thread the app's default currency so the parser can
  // resolve generic "Price" / "Default Price" / "Base Price" headers to
  // the right currency. Falls back to USD when the app row never had a
  // default_currency cached (pre-Hotfix-4 row).
  const parsed = parseIapTemplate(buffer, {
    appDefaultCurrency: app.default_currency ?? "USD",
  });
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { errors: parsed.errors, warnings: parsed.warnings },
      { status: 422 },
    );
  }

  const existing = await listIapsForApp(app.id).catch(() => []);
  const existingSkus = new Set(existing.map((i) => i.sku));

  // Per-row candidate lookup. Two branches:
  //   - SAME-currency (raw price fits row.baseCurrency precision): use
  //     Hotfix 19 findRowCandidates (SKU + (row.baseCurrency, baseMicros)).
  //   - CROSS-currency (raw price violates row.baseCurrency precision,
  //     e.g. "4.99" in a VND app): Cycle 43 — re-interpret Price as a
  //     USD anchor, look up template tiers by (USD, anchorMicros). When
  //     exactly 1 candidate is found, also resolve the app-currency
  //     entry so the wizard can show the RESOLVED app-currency price
  //     before push. When 0 or >1, surface refusal/needs-choice.
  //
  // Skipped when pricingSource is google_default: that path can't
  // resolve cross-currency (no template) — refusals are surfaced
  // inline so the wizard can flag rows up front.
  const appCurrencyNorm = (app.default_currency ?? "").trim().toUpperCase();
  const scope: "APP" | "GLOBAL" =
    pricingSource === "app_template" ? "APP" : "GLOBAL";
  const scopeAppId = pricingSource === "app_template" ? app.id : null;

  type RowResolution =
    | { kind: "same_currency" }
    | {
        kind: "cross_currency_resolved";
        anchorUsdMicros: string;
        chosenTier: string;
        appCurrencyPrice: {
          currency: string;
          priceMicros: string;
          priceDecimal: string;
        };
      }
    | { kind: "cross_currency_needs_choice"; anchorUsdMicros: string }
    | {
        kind: "cross_currency_refused";
        anchorUsdMicros: string | null;
        reason: string;
        refusalKind:
          | "google_default"
          | "template_miss"
          | "missing_entries"
          | "no_app_currency_entry";
      };

  type RowCandidateData = {
    candidates: TierCandidate[];
    defaultTierSelection: string | null;
    matchedBy: "sku" | "currency_price" | "none";
    resolution: RowResolution;
  };
  let candidateLookupError: string | null = null;

  const candidateData: RowCandidateData[] = await withConcurrency(
    parsed.rows,
    CANDIDATE_LOOKUP_CONCURRENCY,
    async (row): Promise<RowCandidateData> => {
      const trigger = detectCrossCurrencyTrigger({
        basePriceDecimal: row.basePriceDecimal,
        baseCurrency: row.baseCurrency,
        priceHeaderSource: row.priceHeaderSource,
        appDefaultCurrency: app.default_currency,
      });

      if (trigger) {
        // Cross-currency row: surface resolution outcome up front so
        // the wizard's preview shows the resolved app-currency price
        // (or refusal reason) before push instead of failing only at
        // push time. Anchor currency comes from the trigger — XXX for
        // explicit "Price (XXX)" headers, USD for the value-based
        // fallback path.
        const anchorMicros = fileDecimalToAnchorMicros(
          row.basePriceDecimal,
          trigger.anchorCurrency,
        );
        if (pricingSource === "google_default" || !appCurrencyNorm) {
          return {
            candidates: [],
            defaultTierSelection: null,
            matchedBy: "none",
            resolution: {
              kind: "cross_currency_refused",
              anchorUsdMicros: anchorMicros,
              reason: REFUSAL_REASONS.googleDefault(
                appCurrencyNorm || row.baseCurrency || "(unknown)",
                row.basePriceDecimal,
                trigger.anchorCurrency,
              ),
              refusalKind: "google_default",
            },
          };
        }
        try {
          const crossCandidates = await findCrossCurrencyCandidates({
            scope,
            appId: scopeAppId,
            filePriceDecimal: row.basePriceDecimal,
            anchorCurrency: trigger.anchorCurrency,
          });
          if (crossCandidates.length === 0) {
            return {
              candidates: [],
              defaultTierSelection: null,
              matchedBy: "none",
              resolution: {
                kind: "cross_currency_refused",
                anchorUsdMicros: anchorMicros,
                reason: REFUSAL_REASONS.templateMiss(
                  appCurrencyNorm,
                  row.basePriceDecimal,
                  trigger.anchorCurrency,
                ),
                refusalKind: "template_miss",
              },
            };
          }
          if (crossCandidates.length > 1) {
            // Surface as needs-choice; wizard reuses the existing
            // Hotfix 19 multi-candidate dropdown.
            return {
              candidates: crossCandidates,
              defaultTierSelection: getPrimaryTierFromCandidates(
                crossCandidates,
              ),
              matchedBy: "currency_price",
              resolution: {
                kind: "cross_currency_needs_choice",
                anchorUsdMicros: anchorMicros ?? "",
              },
            };
          }
          // Exactly 1 candidate — auto-resolve so preview shows the
          // exact app-currency amount the push will send.
          const tier = crossCandidates[0];
          const outcome = await resolveAppCurrencyEntryForTier({
            scope,
            appId: scopeAppId,
            identifier: tier.identifier,
            appDefaultCurrency: appCurrencyNorm,
          });
          if (outcome.kind === "resolved") {
            return {
              candidates: crossCandidates,
              defaultTierSelection: tier.identifier,
              matchedBy: "currency_price",
              resolution: {
                kind: "cross_currency_resolved",
                anchorUsdMicros: anchorMicros ?? "",
                chosenTier: tier.identifier,
                appCurrencyPrice: {
                  currency: outcome.entry.currency,
                  priceMicros: outcome.entry.priceMicros,
                  priceDecimal: microsToDecimal(outcome.entry.priceMicros, 6),
                },
              },
            };
          }
          // Tier matched the anchor price but has no entry for the
          // app's currency, or has no entries at all — surface as
          // refusal.
          const refusalReason =
            outcome.kind === "missing-entries"
              ? REFUSAL_REASONS.missingEntries(tier.identifier)
              : REFUSAL_REASONS.noAppCurrencyEntry(
                  tier.identifier,
                  appCurrencyNorm,
                );
          const refusalKind =
            outcome.kind === "missing-entries"
              ? ("missing_entries" as const)
              : ("no_app_currency_entry" as const);
          return {
            candidates: crossCandidates,
            defaultTierSelection: tier.identifier,
            matchedBy: "currency_price",
            resolution: {
              kind: "cross_currency_refused",
              anchorUsdMicros: anchorMicros,
              reason: refusalReason,
              refusalKind,
            },
          };
        } catch (err) {
          candidateLookupError =
            err instanceof Error ? err.message : String(err);
          console.warn(
            `[google-iap:bulk-import:preview] cross-currency lookup failed sku=${row.sku} err="${candidateLookupError}"`,
          );
          return {
            candidates: [],
            defaultTierSelection: null,
            matchedBy: "none",
            resolution: {
              kind: "cross_currency_refused",
              anchorUsdMicros: anchorMicros,
              reason: `Cross-currency lookup failed: ${candidateLookupError}`,
              refusalKind: "template_miss",
            },
          };
        }
      }

      // Same-currency path: existing Hotfix 19 lookup, unchanged.
      if (pricingSource === "google_default") {
        return {
          candidates: [],
          defaultTierSelection: null,
          matchedBy: "none",
          resolution: { kind: "same_currency" },
        };
      }
      try {
        const baseMicros = decimalToMicros(
          row.basePriceDecimal,
          row.baseCurrency,
        );
        const result = await findRowCandidates({
          scope,
          appId: scopeAppId,
          sku: row.sku,
          currencyCode: row.baseCurrency,
          priceMicros: baseMicros,
        });
        return {
          candidates: result.candidates,
          defaultTierSelection: getPrimaryTierFromCandidates(result.candidates),
          matchedBy: result.matchedBy,
          resolution: { kind: "same_currency" },
        };
      } catch (err) {
        candidateLookupError =
          err instanceof Error ? err.message : String(err);
        console.warn(
          `[google-iap:bulk-import:preview] candidate lookup failed sku=${row.sku} err="${candidateLookupError}"`,
        );
        return {
          candidates: [],
          defaultTierSelection: null,
          matchedBy: "none",
          resolution: { kind: "same_currency" },
        };
      }
    },
  );

  const rows = parsed.rows.map((row, i) => ({
    ...row,
    exists: existingSkus.has(row.sku),
    tierCandidates: candidateData[i].candidates,
    defaultTierSelection: candidateData[i].defaultTierSelection,
    tierMatchedBy: candidateData[i].matchedBy,
    // Cycle 43 cross-currency resolution outcome (one of:
    // same_currency / cross_currency_resolved / cross_currency_needs_choice
    // / cross_currency_refused). Wizard renders resolved app-currency
    // price or refusal banner based on `resolution.kind`.
    resolution: candidateData[i].resolution,
  }));

  const ambiguousCount = rows.filter((r) => r.tierCandidates.length > 1).length;
  const crossCurrencyResolvedCount = rows.filter(
    (r) => r.resolution.kind === "cross_currency_resolved",
  ).length;
  const crossCurrencyRefusedCount = rows.filter(
    (r) => r.resolution.kind === "cross_currency_refused",
  ).length;
  const crossCurrencyNeedsChoiceCount = rows.filter(
    (r) => r.resolution.kind === "cross_currency_needs_choice",
  ).length;
  const warningsOut = [...parsed.warnings];
  if (candidateLookupError) {
    // Corrected wording (Cycle 43): the old "fall through to
    // auto-bootstrap at push time" message was untrue — the push path
    // re-throws the same precision error. The new message states the
    // actual behavior: rows are resolved-from-template, marked
    // needs-choice, or refused.
    warningsOut.push(
      `Tier candidate lookup failed for one or more rows (${candidateLookupError}); affected rows will be REFUSED at push time (per-row fail-soft) instead of crashing the batch.`,
    );
  }
  if (crossCurrencyRefusedCount > 0) {
    warningsOut.push(
      `${crossCurrencyRefusedCount} row(s) cannot be resolved and will be refused on push (per-row fail-soft). Inspect the Resolved price column for the reason on each refused row.`,
    );
  }

  return NextResponse.json({
    filename: file.name,
    pricingSource,
    rows,
    warnings: warningsOut,
    counts: {
      total: rows.length,
      existing: rows.filter((r) => r.exists).length,
      new: rows.filter((r) => !r.exists).length,
      ambiguous: ambiguousCount,
      // Cycle 43 cross-currency counts so the wizard banner can show a
      // single-line summary ("3 resolved, 1 refused, 1 needs choice").
      crossCurrencyResolved: crossCurrencyResolvedCount,
      crossCurrencyRefused: crossCurrencyRefusedCount,
      crossCurrencyNeedsChoice: crossCurrencyNeedsChoiceCount,
    },
  });
}
