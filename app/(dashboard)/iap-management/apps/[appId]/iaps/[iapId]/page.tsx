import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapSession } from "@/lib/iap-management/auth";
import { listTiers } from "@/lib/iap-management/queries/price-tiers";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getTemplateSummary } from "@/lib/iap-management/queries/templates";
import { getCustomPriceState } from "@/lib/iap-management/custom-prices/repository";
import { resolvePricePointSource } from "@/lib/iap-management/queries/price-point-donor";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { IapForm } from "@/components/iap-management/iap-form/IapForm";
import {
  getAvailabilityForIap,
  getAllTerritoryIds,
} from "@/lib/iap-management/apple/availabilities";
import type {
  IapFormState,
  FormLocalization,
} from "@/lib/iap-management/validation";
import type { TerritorySelection } from "@/lib/iap-management/apple/territory-selection";
import { editSurfaceDefaultSelection } from "@/lib/iap-management/apple/availability-surface-defaults";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string; iapId: string };
}

export default async function EditIapPage({ params }: PageProps) {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  await requireIapSession();

  const data = await getIapWithRelations(params.iapId);
  if (!data) notFound();

  let appName = "";
  let creds: Awaited<ReturnType<typeof getActiveAccount>> | null = null;
  try {
    creds = await getActiveAccount();
    const app = await getApp(creds, params.appId);
    appName = app.data.attributes.name;
  } catch {
    // header degrades gracefully
  }

  const tiers = await listTiers();

  /**
   * SC5 — the Apple-side availability for Section 5, as a real selection.
   *
   * The subset state is no longer collapsed into a radio. Pre-SC5 this block
   * mapped Apple's answer onto "ALL" | "NONE" and, when the item genuinely
   * held a subset, gave up and returned null — the Manager saw two radios that
   * could not express what was actually on Apple. Now the exact territory list
   * comes through verbatim and the picker renders it.
   *
   * ⚠ Both reads here are ALREADY PAID: `getAvailabilityForIap` supplies the
   * current territory ids and `getAllTerritoryIds` the catalogue, and both were
   * already being fetched at this point to derive the old radio. SC5 adds ZERO
   * Apple requests to opening this page — it stops throwing away what the page
   * had already read.
   *
   * ⚠ `null` selection means Apple has no availability resource (Removed from
   * Sale). A FAILED read is `previousKnown: false` with a null selection, and
   * the two must not be conflated: writing "removed" into the audit for an item
   * nobody could read would be a fact we invented.
   */
  let availabilitySelection: TerritorySelection | null = null;
  let availabilityPreviousKnown = false;
  let allTerritoryIds: string[] = [];
  if (creds && data.iap.apple_iap_id) {
    try {
      const [avail, totalIds] = await Promise.all([
        getAvailabilityForIap(creds, data.iap.apple_iap_id),
        getAllTerritoryIds(creds).catch(() => [] as string[]),
      ]);
      allTerritoryIds = totalIds;
      availabilityPreviousKnown = true;
      // Ids pass through untouched — no sort, no case change (SC1 rule).
      availabilitySelection = avail
        ? {
            territoryIds: avail.territoryIds,
            availableInNewTerritories: avail.availableInNewTerritories,
          }
        : null;
    } catch {
      // Read failed. Leave previousKnown false so nothing downstream can read
      // the null selection as "this item is removed from sale".
      availabilityPreviousKnown = false;
    }
  }

  // Map DB rows back to form state
  const localizations: Record<string, FormLocalization> = {};
  for (const loc of data.localizations) {
    localizations[loc.locale] = {
      locale: loc.locale,
      display_name: loc.display_name,
      description: loc.description,
    };
  }

  const screenshot = data.screenshots[0];
  const initial: IapFormState = {
    reference_name: data.iap.reference_name,
    product_id: data.iap.product_id,
    type: (data.iap.type as InAppPurchaseType) ?? "",
    tier_id: data.iap.tier_id,
    localizations,
    screenshot_filename: screenshot?.file_name ?? null,
    review_note: data.iap.review_note ?? null,
    family_sharable: Boolean(data.iap.family_sharable),
    // IAP.p1.j Issue 1: hydrate persisted pricing-source so the form
    // doesn't re-derive Q-D default and override the Manager's choice.
    pricing_source: data.iap.pricing_source ?? undefined,
    // SC5 default = the item's CURRENT territories (Manager decision 2 —
    // surfaces A and B default to ALL, surface C to what the item already has).
    // The policy lives in a tested pure function rather than inline here: it is
    // the single most consequential behaviour in the feature, and inline in a
    // server component nothing could assert it.
    availability_selection: editSurfaceDefaultSelection(
      availabilitySelection,
      availabilityPreviousKnown,
    ),
  };

  // IAP.p1.f: per-edit pricing-source selection. Defaults to most-specific
  // available (Q-D) since edit-time the previous source isn't persisted
  // (Q-J per-creation explicit). Manager re-selects each Update-on-Apple.
  let defaultTemplateAvailable = false;
  let defaultTemplateEntryCount = 0;
  let appTemplateAvailable = false;
  let appTemplateEntryCount = 0;
  try {
    const def = creds
      ? await getTemplateSummary({ kind: "ACCOUNT", account_id: creds.id })
      : null;
    if (def) {
      defaultTemplateAvailable = true;
      defaultTemplateEntryCount = def.entry_count;
    }
    const app = await getTemplateSummary({ kind: "APP", app_id: data.iap.app_id });
    if (app) {
      appTemplateAvailable = true;
      appTemplateEntryCount = app.entry_count;
    }
  } catch {
    // non-essential
  }

  // SC2 — the persisted custom set + its fingerprint (SC1's single writer), and
  // J-1 donor availability so the picker's disabled state is decided BEFORE the
  // Manager opens the dialog rather than after a failed fetch.
  let customPrices: Awaited<ReturnType<typeof getCustomPriceState>> = {
    entries: [],
    baseline: null,
  };
  let pricePointDonorAvailable = false;
  try {
    customPrices = await getCustomPriceState(params.iapId);
    pricePointDonorAvailable =
      (await resolvePricePointSource({
        iapId: params.iapId,
        appId: data.iap.app_id,
        appleIapId: data.iap.apple_iap_id,
        type: data.iap.type,
      })) !== null;
  } catch {
    // Degrade to "no customs, picker disabled" rather than failing the page —
    // every other field on this form stays editable.
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link
        href={`/iap-management/apps/${params.appId}`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition mb-4"
      >
        <ChevronLeft className="h-4 w-4" />
        IAPs · {appName || params.appId}
      </Link>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-slate-900">
          Edit IAP — {data.iap.reference_name}
        </h1>
        <div className="flex items-center gap-2 text-xs">
          {data.iap.apple_iap_id ? (
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              Synced
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-slate-50 text-slate-600 border border-slate-200">
              Local draft
            </span>
          )}
          <span className="font-mono text-slate-400">
            {data.iap.product_id}
          </span>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        State:{" "}
        <span className="font-medium text-slate-700">{data.iap.state}</span>
        {data.iap.synced_at && ` · Synced ${new Date(data.iap.synced_at).toLocaleString()}`}
      </p>
      <IapForm
        mode="edit"
        appAppleId={params.appId}
        iapId={params.iapId}
        syncedToApple={data.iap.apple_iap_id !== null}
        appleState={data.iap.state}
        initial={initial}
        tiers={tiers}
        defaultTemplateAvailable={defaultTemplateAvailable}
        appTemplateAvailable={appTemplateAvailable}
        defaultTemplateEntryCount={defaultTemplateEntryCount}
        appTemplateEntryCount={appTemplateEntryCount}
        availabilitySelection={availabilitySelection}
        availabilityPreviousKnown={availabilityPreviousKnown}
        allTerritoryIds={allTerritoryIds}
        baseTerritory={data.iap.base_territory}
        customPrices={customPrices.entries}
        customPricesBaseline={customPrices.baseline}
        pricePointDonorAvailable={pricePointDonorAvailable}
      />
    </div>
  );
}
