import { redirect, notFound } from "next/navigation";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getIapDetailFromApple } from "@/lib/iap-management/queries/iap-detail";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { IapDetailView } from "@/components/iap-management/IapDetailView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string; iapId: string };
}

/**
 * /iap-management/apps/[appId]/iaps/[iapId]/view — IAP.o.8c.
 *
 * Read-only Apple-canonical detail view. Manager requested real-time fetch
 * on every page load — no cached payload. Edit button → existing
 * /iaps/[iapId] route preserves bookmark stability for the edit URL.
 *
 * Drafts (apple_iap_id NULL) can't be viewed here — they redirect to the
 * edit page. The view URL is meaningless without an Apple-side IAP.
 */
export default async function ViewIapPage({ params }: PageProps) {
  try {
    await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapForbiddenError) redirect("/");
    throw err;
  }

  const local = await getIapWithRelations(params.iapId);
  if (!local) notFound();

  // Drafts (never pushed to Apple) belong on the edit page — there's no
  // Apple-side data to display in /view.
  if (!local.iap.apple_iap_id) {
    redirect(`/iap-management/apps/${params.appId}/iaps/${params.iapId}`);
  }

  const creds = await getActiveAccount();
  let appName = "";
  try {
    const app = await getApp(creds, params.appId);
    appName = app.data.attributes.name;
  } catch {
    // header degrades gracefully
  }

  const fetchedAt = new Date().toISOString();
  const detail = await getIapDetailFromApple(creds, local.iap.apple_iap_id);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <IapDetailView
        appAppleId={params.appId}
        appName={appName}
        internalIapId={params.iapId}
        iap={detail.iap}
        localizations={detail.localizations}
        screenshot={detail.screenshot}
        fetchedAt={fetchedAt}
        cachedTierId={local.iap.tier_id}
      />
    </div>
  );
}
