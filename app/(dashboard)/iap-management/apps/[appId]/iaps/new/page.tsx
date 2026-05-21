import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapSession } from "@/lib/iap-management/auth";
import { listTiers } from "@/lib/iap-management/queries/price-tiers";
import { findAppByAppleId } from "@/lib/iap-management/queries/iaps";
import { getTemplateSummary } from "@/lib/iap-management/queries/templates";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { emptyIapForm } from "@/lib/iap-management/validation";
import { IapForm } from "@/components/iap-management/iap-form/IapForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string };
}

export default async function NewIapPage({ params }: PageProps) {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  await requireIapSession();

  let appName = "";
  try {
    const creds = await getActiveAccount();
    const app = await getApp(creds, params.appId);
    appName = app.data.attributes.name;
  } catch {
    // Non-fatal — header just shows the appId.
  }

  const tiers = await listTiers();

  // IAP.p1.f: surface pricing-template availability so the selector can
  // gray-out unavailable options + pick the most-specific default (Q-D).
  let defaultTemplateAvailable = false;
  let defaultTemplateEntryCount = 0;
  let appTemplateAvailable = false;
  let appTemplateEntryCount = 0;
  try {
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
    // template lookups are non-essential — degrade silently to APPLE-only
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
        New In-App Purchase
      </h1>
      <p className="text-sm text-slate-500 mb-6">
        Save as Draft to persist locally. Create on Apple after the 5
        Group A prerequisites pass; Submit for Review lives on the IAP
        list page.
      </p>
      <IapForm
        mode="create"
        appAppleId={params.appId}
        iapId={null}
        syncedToApple={false}
        initial={emptyIapForm()}
        tiers={tiers}
        defaultTemplateAvailable={defaultTemplateAvailable}
        appTemplateAvailable={appTemplateAvailable}
        defaultTemplateEntryCount={defaultTemplateEntryCount}
        appTemplateEntryCount={appTemplateEntryCount}
      />
    </div>
  );
}
