import { requireIapSession } from "@/lib/iap-management/auth";
import {
  getTemplateOverview,
  listAppsWithTemplates,
} from "@/lib/iap-management/queries/templates";
import { PricingTiersClient } from "./PricingTiersClient";

export const dynamic = "force-dynamic";

export default async function PricingTiersPage() {
  // Hotfix 11: page is member-accessible; the Default Template tab renders
  // read-only for non-admins (S1.B). Default mutation routes still enforce
  // admin role server-side (POST /pricing-templates scope=GLOBAL + DELETE on
  // GLOBAL templates).
  const session = await requireIapSession();
  const isAdmin = session.user.role === "admin";
  const currentUserEmail = session.user.email ?? "unknown";

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
      isAdmin={isAdmin}
      currentUserEmail={currentUserEmail}
    />
  );
}
