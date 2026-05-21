export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { listAppsForAccount } from "@/lib/google-iap-management/repository/apps";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import {
  getGlobalTemplateOverview,
  listAppTemplates,
} from "@/lib/google-iap-management/queries/templates";
import { PricingTemplatesClient } from "@/components/google-iap-management/pricing-templates/PricingTemplatesClient";

export default async function PricingTemplatesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) redirect("/google-iap-management");

  const cookieActiveId = readActiveAccountId();
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0].id;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;

  const [defaultOverview, appTemplates, cachedApps] = await Promise.all([
    getGlobalTemplateOverview(),
    listAppTemplates(),
    listAppsForAccount(activeAccountId),
  ]);

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href="/google-iap-management"
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Google IAP Management
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        Pricing Templates
      </h1>
      <p className="text-sm text-slate-500 mb-6 max-w-prose">
        Default Template applies to every app; per-app templates override the
        Default for specific apps. Google&apos;s auto-equalisation fills in
        regions that no template covers.
      </p>
      <PricingTemplatesClient
        defaultOverview={defaultOverview}
        appTemplates={appTemplates}
        cachedApps={cachedApps.map((a) => ({
          id: a.id,
          package_name: a.package_name,
          display_name: a.display_name,
        }))}
      />
    </div>
  );
}
