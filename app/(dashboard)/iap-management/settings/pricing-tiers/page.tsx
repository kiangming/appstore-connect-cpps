import { redirect } from "next/navigation";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import {
  getTemplateOverview,
  listActiveAppsForTemplateUpload,
  listAppsWithTemplates,
} from "@/lib/iap-management/queries/templates";
import { PricingTiersClient } from "./PricingTiersClient";

export const dynamic = "force-dynamic";

export default async function PricingTiersPage() {
  try {
    await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapForbiddenError) {
      redirect("/");
    }
    throw err;
  }

  const [defaultOverview, appsWithTemplates, activeApps] = await Promise.all([
    getTemplateOverview({ kind: "GLOBAL" }),
    listAppsWithTemplates(),
    listActiveAppsForTemplateUpload(),
  ]);

  return (
    <PricingTiersClient
      defaultOverview={defaultOverview}
      appsWithTemplates={appsWithTemplates}
      activeApps={activeApps}
    />
  );
}
