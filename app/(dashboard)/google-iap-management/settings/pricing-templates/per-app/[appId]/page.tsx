export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { Package2, Upload } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppById } from "@/lib/google-iap-management/repository/apps";
import { fetchPerAppMatrix } from "@/lib/google-iap-management/queries/template-matrix";
import {
  getAppTemplateOverview,
  templateExists,
} from "@/lib/google-iap-management/queries/templates";
import { MatrixBreadcrumb } from "@/components/google-iap-management/pricing-templates/MatrixBreadcrumb";
import { PerAppMatrixView } from "@/components/google-iap-management/pricing-templates/PerAppMatrixView";

export default async function PerAppMatrixPage({
  params,
}: {
  params: { appId: string };
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) redirect("/google-iap-management");

  const appId = decodeURIComponent(params.appId);
  const app = await getAppById(appId);
  if (!app) notFound();

  const [matrix, overview, defaultTemplateExists] = await Promise.all([
    fetchPerAppMatrix(appId),
    getAppTemplateOverview(appId),
    templateExists({ scope: "GLOBAL", appId: null }),
  ]);

  if (!matrix) {
    return (
      <div className="p-8 max-w-3xl">
        <MatrixBreadcrumb
          trail={[
            { label: "Settings", href: "/google-iap-management" },
            {
              label: "Pricing Templates",
              href: "/google-iap-management/settings/pricing-templates",
            },
            {
              label: "Per-App Templates",
              href: "/google-iap-management/settings/pricing-templates",
            },
            { label: app.display_name ?? app.package_name },
          ]}
        />
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Per-App Pricing Template — {app.display_name ?? app.package_name}
        </h1>
        <p className="text-xs text-slate-500 mb-6 font-mono">{app.package_name}</p>

        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Package2 className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-base font-medium text-slate-700 mb-1">
            No Per-App template uploaded yet
          </p>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto mb-5">
            Per-App templates override Default Template entries for this specific
            app. When no Per-App template exists, the Default Template values apply.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/google-iap-management/settings/pricing-templates"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
            >
              <Upload className="h-4 w-4" />
              Upload Per-App Template
            </Link>
            {defaultTemplateExists && (
              <Link
                href="/google-iap-management/settings/pricing-templates/default"
                className="text-sm text-emerald-700 hover:underline"
              >
                View Default Template instead →
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1400px]">
      <PerAppMatrixView
        matrix={matrix}
        packageName={app.package_name}
        appDisplayName={app.display_name}
        uploadedAt={overview.template?.uploaded_at ?? null}
        uploadedBy={overview.template?.uploaded_by ?? null}
        defaultTemplateExists={defaultTemplateExists}
      />
    </div>
  );
}
