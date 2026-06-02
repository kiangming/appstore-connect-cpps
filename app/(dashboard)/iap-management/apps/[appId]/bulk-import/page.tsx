import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapSession } from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getActiveAccount } from "@/lib/get-active-account";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";
import { findAppByAppleId } from "@/lib/iap-management/queries/iaps";
import {
  getTemplateSummary,
  listUsdTiersForSource,
} from "@/lib/iap-management/queries/templates";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import { BulkImportWizard } from "./BulkImportWizard";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string };
}

export default async function BulkImportPage({ params }: PageProps) {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  await requireIapSession();

  let appName = "";
  let existingProductIds: string[] = [];
  // Cycle 43: per-source USA/USD tier lists. The wizard selects the active
  // list by the chosen pricing source so preview tier-resolution reads the
  // SAME source the matrix + /execute read (template tables), not the legacy
  // price_tier_territories cache. APPLE stays on the legacy cache (back-compat).
  const emptyBySource: Record<PricingSourceKind, UsdTierEntry[]> = {
    APPLE: [],
    DEFAULT_TEMPLATE: [],
    APP_TEMPLATE: [],
  };
  let usdTiersBySource: Record<PricingSourceKind, UsdTierEntry[]> = emptyBySource;
  let defaultTemplateAvailable = false;
  let defaultTemplateEntryCount = 0;
  let appTemplateAvailable = false;
  let appTemplateEntryCount = 0;
  try {
    const creds = await getActiveAccount();
    const [appRes, iapsRes] = await Promise.all([
      getApp(creds, params.appId),
      listAllInAppPurchases(creds, params.appId),
    ]);
    appName = appRes.data.attributes.name;
    existingProductIds = (iapsRes.data ?? []).map(
      (iap) => iap.attributes.productId,
    );

    // IAP.p1.g: feed pricing-source availability into the wizard so the
    // Step 3 selector can gray-out unavailable options + pick Q-D default.
    const internalAppId = await findAppByAppleId(params.appId);
    const [appleTiers, defaultTiers, appTiers, def, appTpl] = await Promise.all([
      listUsdTiersForSource({ kind: "APPLE" }),
      listUsdTiersForSource({ kind: "DEFAULT_TEMPLATE" }),
      internalAppId
        ? listUsdTiersForSource({ kind: "APP_TEMPLATE", app_id: internalAppId })
        : Promise.resolve<UsdTierEntry[]>([]),
      getTemplateSummary({ kind: "GLOBAL" }),
      internalAppId
        ? getTemplateSummary({ kind: "APP", app_id: internalAppId })
        : Promise.resolve(null),
    ]);
    usdTiersBySource = {
      APPLE: appleTiers,
      DEFAULT_TEMPLATE: defaultTiers,
      APP_TEMPLATE: appTiers,
    };
    if (def) {
      defaultTemplateAvailable = true;
      defaultTemplateEntryCount = def.entry_count;
    }
    if (appTpl) {
      appTemplateAvailable = true;
      appTemplateEntryCount = appTpl.entry_count;
    }
  } catch {
    // The wizard can still render; conflict + tier detection degrade.
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
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        Bulk Import IAPs
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Upload the Manager-provided Excel template + companion screenshots.
        Tool orchestrates Apple creation, localizations, and screenshot upload
        per IAP with bounded concurrency.
      </p>
      <BulkImportWizard
        appId={params.appId}
        appName={appName}
        existingProductIds={existingProductIds}
        usdTiersBySource={usdTiersBySource}
        defaultTemplateAvailable={defaultTemplateAvailable}
        appTemplateAvailable={appTemplateAvailable}
        defaultTemplateEntryCount={defaultTemplateEntryCount}
        appTemplateEntryCount={appTemplateEntryCount}
      />
    </div>
  );
}
