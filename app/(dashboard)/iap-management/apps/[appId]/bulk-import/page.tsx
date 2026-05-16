import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getActiveAccount } from "@/lib/get-active-account";
import { listUsdTiers } from "@/lib/iap-management/queries/price-tiers";
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
      />
    </div>
  );
}
