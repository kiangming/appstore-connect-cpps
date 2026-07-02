export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppByPackage } from "@/lib/google-iap-management/repository/apps";
import { listIapsWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import { IapListClient } from "@/components/google-iap-management/iap-list/IapListClient";

export default async function AppDetailPage({
  params,
}: {
  params: { packageName: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const packageName = decodeURIComponent(params.packageName);

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) {
    redirect("/google-iap-management");
  }

  const cookieActiveId = readActiveAccountId();
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0].id;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;

  const app = await getAppByPackage(activeAccountId, packageName);
  if (!app) {
    notFound();
  }

  // Distinguish "genuinely no items" from "the read failed". Swallowing a
  // load error into [] previously masked the >200-item read failure as an
  // empty list. Surface the failure so the UI can show an error state.
  let iaps: Awaited<ReturnType<typeof listIapsWithDefaultLocale>> = [];
  let loadError = false;
  try {
    iaps = await listIapsWithDefaultLocale(app.id);
  } catch (err) {
    loadError = true;
    console.error(
      `[google-iap] failed to load IAPs for ${packageName}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href="/google-iap-management/apps"
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        All apps
      </Link>
      <IapListClient
        packageName={packageName}
        appDisplayName={app.display_name}
        appLastSyncedAt={app.last_synced_at}
        initialIaps={iaps}
        loadError={loadError}
      />
    </div>
  );
}
