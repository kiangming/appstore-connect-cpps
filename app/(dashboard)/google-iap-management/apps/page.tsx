export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { Settings } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { listAppsForAccount } from "@/lib/google-iap-management/repository/apps";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import { AppsListClient } from "@/components/google-iap-management/apps/AppsListClient";

export default async function GoogleAppsListPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);

  if (accounts.length === 0) {
    return (
      <div className="p-8 max-w-3xl">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">
            No Google Console accounts configured
          </h2>
          <p className="text-sm text-amber-800 mb-4">
            Upload a Service Account .json to start managing apps and IAPs.
          </p>
          <Link
            href="/google-iap-management/settings/google-accounts"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition"
          >
            <Settings className="h-4 w-4" />
            Open settings
          </Link>
        </div>
      </div>
    );
  }

  const cookieActiveId = readActiveAccountId();
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0].id;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;
  const activeAccount = accounts.find((a) => a.id === activeAccountId)!;

  const apps = await listAppsForAccount(activeAccountId).catch(() => []);

  // Hotfix 29 — derive last-refreshed-at from the most recent cached
  // app row so the auto-refresh staleness check is stable even when
  // apps[0] happens to be a row that hasn't been touched lately.
  const initialLastRefreshedAt = apps.reduce<string | null>((max, a) => {
    if (!a.last_synced_at) return max;
    if (!max || a.last_synced_at > max) return a.last_synced_at;
    return max;
  }, null);

  return (
    <AppsListClient
      activeAccount={activeAccount}
      initialApps={apps}
      initialLastRefreshedAt={initialLastRefreshedAt}
    />
  );
}
