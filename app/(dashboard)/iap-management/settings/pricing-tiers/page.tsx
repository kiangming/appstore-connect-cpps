import { redirect } from "next/navigation";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import {
  getTemplateOverview,
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

  // IAP.p1.j Issue 3: the "Upload for an app" dropdown moved to a live
  // client-side fetch against the active ASC account
  // (/api/iap-management/asc-apps), so the page no longer needs to
  // pre-list local apps. appsWithTemplates is still served from the DB
  // because the table also captures upload metadata + per-template
  // entry counts that aren't exposed by Apple's app catalog.
  const [defaultOverview, appsWithTemplates] = await Promise.all([
    getTemplateOverview({ kind: "GLOBAL" }),
    listAppsWithTemplates(),
  ]);

  return (
    <PricingTiersClient
      defaultOverview={defaultOverview}
      appsWithTemplates={appsWithTemplates}
    />
  );
}
