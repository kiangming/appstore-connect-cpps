import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireIapSession } from "@/lib/iap-management/auth";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getIapViewData } from "@/lib/iap-management/queries/iap-detail";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { IapDetailView } from "@/components/iap-management/IapDetailView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string; iapId: string };
}

/**
 * /iap-management/apps/[appId]/iaps/[iapId]/view — IAP.o.8c + IAP.o.10b.
 *
 * Read-only Apple-canonical detail view. Manager requested real-time fetch
 * on every page load — no cached payload. Edit button → existing
 * /iaps/[iapId] route preserves bookmark stability for the edit URL.
 *
 * Drafts (apple_iap_id NULL) can't be viewed here — they redirect to the
 * edit page. The view URL is meaningless without an Apple-side IAP.
 *
 * IAP.o.10b: Apple fetch wrapped in try/catch so transient Apple failures
 * render a friendly inline error instead of throwing a server-side 500
 * (which surfaces as a blank page in production and was the silent-fail
 * pattern Manager reported across IAP.o.8c–IAP.o.9c).
 */
export default async function ViewIapPage({ params }: PageProps) {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  await requireIapSession();

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
  let detail;
  try {
    detail = await getIapViewData(creds, local.iap.apple_iap_id);
  } catch (err) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <Link
          href={`/iap-management/apps/${params.appId}`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-4"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to {appName || "app"} IAPs
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h2 className="text-base font-semibold text-red-900 mb-2">
            Couldn&apos;t fetch this IAP from Apple
          </h2>
          <p className="text-sm text-red-700 mb-3">
            Apple&apos;s API returned an error fetching the canonical state
            for this IAP. The IAP itself is still on Apple — only this
            real-time snapshot failed.
          </p>
          <pre className="text-[11px] font-mono bg-white border border-red-200 rounded px-3 py-2 text-red-900 overflow-x-auto">
            {err instanceof Error ? err.message : String(err)}
          </pre>
          <p className="text-xs text-red-600 mt-3">
            Try refreshing the page. If the error persists, check{" "}
            <Link href="/settings" className="underline">
              Settings → ASC Accounts
            </Link>{" "}
            and verify the credentials are valid.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <IapDetailView
        appAppleId={params.appId}
        appName={appName}
        internalIapId={params.iapId}
        iap={detail.iap}
        localizations={detail.localizations}
        screenshot={detail.screenshot}
        priceSchedule={detail.priceSchedule}
        priceScheduleError={detail.priceScheduleError}
        fetchedAt={fetchedAt}
      />
    </div>
  );
}
