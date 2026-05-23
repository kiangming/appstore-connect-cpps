export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ArrowLeft, Sparkles, Upload } from "lucide-react";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { fetchDefaultMatrix } from "@/lib/google-iap-management/queries/template-matrix";
import { getGlobalTemplateOverview } from "@/lib/google-iap-management/queries/templates";
import { DefaultMatrixView } from "@/components/google-iap-management/pricing-templates/DefaultMatrixView";

export default async function DefaultMatrixPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) redirect("/google-iap-management");

  const [matrix, overview] = await Promise.all([
    fetchDefaultMatrix(),
    getGlobalTemplateOverview(),
  ]);

  if (!matrix) {
    return (
      <div className="p-8 max-w-3xl">
        <Link
          href="/google-iap-management/settings/pricing-templates"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
        >
          <ArrowLeft className="h-3 w-3" />
          Pricing Templates
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Default Pricing Template
        </h1>
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center mt-6">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            No Default Template uploaded yet
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            Upload the Manager-provided{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">
              pricing-template-google.xlsx
            </code>{" "}
            on the Settings page to populate this matrix.
          </p>
          <Link
            href="/google-iap-management/settings/pricing-templates"
            className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
          >
            <Upload className="h-4 w-4" />
            Go to Settings · Upload Default Template
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1400px]">
      <DefaultMatrixView
        matrix={matrix}
        uploadedAt={overview.template?.uploaded_at ?? null}
        uploadedBy={overview.template?.uploaded_by ?? null}
      />
    </div>
  );
}
