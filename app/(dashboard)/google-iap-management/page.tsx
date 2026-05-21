import Link from "next/link";
import { PlayCircle, Settings, ListOrdered, Coins } from "lucide-react";

import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";

export const dynamic = "force-dynamic";

/**
 * Module landing — a brief launchpad. The dedicated apps list lives at
 * /google-iap-management/apps (built in g1.e). For now this page surfaces
 * the empty-state when no accounts are configured and points to settings.
 */
export default async function GoogleIapManagementIndex() {
  const accounts = await listAccounts().catch(() => []);
  const hasAccounts = accounts.length > 0;

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <PlayCircle className="h-7 w-7 text-emerald-600" strokeWidth={1.5} />
          <h1 className="text-2xl font-semibold text-slate-900">
            Google IAP Management
          </h1>
        </div>
        <p className="text-sm text-slate-500">
          Create + bulk-import Google Play in-app products via Service Account.
        </p>
      </div>

      {!hasAccounts ? (
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
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link
            href="/google-iap-management/apps"
            className="group bg-white rounded-xl border border-slate-200 p-5 hover:border-emerald-500 hover:shadow-sm transition"
          >
            <ListOrdered className="h-7 w-7 text-emerald-600 mb-3" strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-slate-900 mb-1">Apps</h2>
            <p className="text-sm text-slate-500">
              Browse Google Play apps reachable by your Service Account.
            </p>
          </Link>
          <Link
            href="/google-iap-management/settings/pricing-templates"
            className="group bg-white rounded-xl border border-slate-200 p-5 hover:border-emerald-500 hover:shadow-sm transition"
          >
            <Coins className="h-7 w-7 text-emerald-600 mb-3" strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-slate-900 mb-1">
              Pricing Templates
            </h2>
            <p className="text-sm text-slate-500">
              Default + per-app pricing tables applied at IAP create / import.
            </p>
          </Link>
          <Link
            href="/google-iap-management/settings/google-accounts"
            className="group bg-white rounded-xl border border-slate-200 p-5 hover:border-emerald-500 hover:shadow-sm transition"
          >
            <Settings className="h-7 w-7 text-emerald-600 mb-3" strokeWidth={1.5} />
            <h2 className="text-base font-semibold text-slate-900 mb-1">
              Settings
            </h2>
            <p className="text-sm text-slate-500">
              Manage Google Console account credentials.
            </p>
          </Link>
        </div>
      )}
    </div>
  );
}
