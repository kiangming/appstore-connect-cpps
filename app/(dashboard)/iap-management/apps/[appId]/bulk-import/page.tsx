import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getActiveAccount } from "@/lib/get-active-account";
import { listUsdTiers } from "@/lib/iap-management/queries/price-tiers";
import { findAppByAppleId } from "@/lib/iap-management/queries/iaps";
import { getTemplateSummary } from "@/lib/iap-management/queries/templates";
import { BulkImportWizard } from "./BulkImportWizard";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string };
}

export default async function BulkImportPage({ params }: PageProps) {
  try {
    await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapForbiddenError) redirect("/");
    throw err;
  }

  let appName = "";
  let existingProductIds: string[] = [];
  let usdTiers: Awaited<ReturnType<typeof listUsdTiers>> = [];
  let defaultTemplateAvailable = false;
  let defaultTemplateEntryCount = 0;
  let appTemplateAvailable = false;
  let appTemplateEntryCount = 0;
  try {
    const creds = await getActiveAccount();
    const [appRes, iapsRes, tiersRes] = await Promise.all([
      getApp(creds, params.appId),
      listAllInAppPurchases(creds, params.appId),
      listUsdTiers(),
    ]);
    appName = appRes.data.attributes.name;
    existingProductIds = (iapsRes.data ?? []).map(
      (iap) => iap.attributes.productId,
    );
    usdTiers = tiersRes;

    // IAP.p1.g: feed pricing-source availability into the wizard so the
    // Step 3 selector can gray-out unavailable options + pick Q-D default.
    const def = await getTemplateSummary({ kind: "GLOBAL" });
    if (def) {
      defaultTemplateAvailable = true;
      defaultTemplateEntryCount = def.entry_count;
    }
    const internalAppId = await findAppByAppleId(params.appId);
    if (internalAppId) {
      const app = await getTemplateSummary({ kind: "APP", app_id: internalAppId });
      if (app) {
        appTemplateAvailable = true;
        appTemplateEntryCount = app.entry_count;
      }
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
        usdTiers={usdTiers}
        defaultTemplateAvailable={defaultTemplateAvailable}
        appTemplateAvailable={appTemplateAvailable}
        defaultTemplateEntryCount={defaultTemplateEntryCount}
        appTemplateEntryCount={appTemplateEntryCount}
      />
    </div>
  );
}
