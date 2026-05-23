export const dynamic = "force-dynamic";

import Link from "next/link";
import { ArrowLeft, Sparkles, Upload } from "lucide-react";

import { requireIapSession } from "@/lib/iap-management/auth";
import { fetchDefaultMatrix } from "@/lib/iap-management/queries/template-matrix";
import { DefaultMatrixView } from "@/components/iap-management/pricing-templates/DefaultMatrixView";

export default async function DefaultMatrixPage() {
  // Hotfix 11 parity: page is member-accessible; the Default Template
  // is read-only for non-admins on the upload tab. Matrix view shows
  // the same data either way — no admin gate here.
  await requireIapSession();

  const result = await fetchDefaultMatrix();

  if (!result) {
    return (
      <div className="p-8 max-w-3xl">
        <Link
          href="/iap-management/settings/pricing-tiers"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
        >
          <ArrowLeft className="h-3 w-3" />
          Pricing Tiers
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
              price-tiers-template.xlsx
            </code>{" "}
            on the Settings page to populate this matrix.
          </p>
          <Link
            href="/iap-management/settings/pricing-tiers"
            className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
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
        matrix={result.matrix}
        uploadedAt={result.header.uploaded_at}
        uploadedBy={result.header.uploaded_by}
      />
    </div>
  );
}
