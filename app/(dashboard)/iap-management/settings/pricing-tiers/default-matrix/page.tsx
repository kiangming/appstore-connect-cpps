export const dynamic = "force-dynamic";

import Link from "next/link";
import { ArrowLeft, Sparkles, Upload } from "lucide-react";

import { requireIapSession } from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { fetchDefaultMatrix } from "@/lib/iap-management/queries/template-matrix";
import { listTierNames } from "@/lib/iap-management/queries/price-tiers";
import { DefaultMatrixView } from "@/components/iap-management/pricing-templates/DefaultMatrixView";
import { EmptyMatrixImport } from "@/components/iap-management/pricing-templates/EmptyMatrixImport";

export default async function DefaultMatrixPage() {
  // Hotfix 11 parity: page is member-accessible; the Default Template
  // is read-only for non-admins on the upload tab. Matrix view shows
  // the same data either way — no admin gate here.
  const session = await requireIapSession();

  // C-A: xem ma trận của template mặc định NÀO — account đang chọn.
  const creds = await getActiveAccount();
  const result = await fetchDefaultMatrix(creds.id);
  // Import into a Default is admin-only — the same gate as uploading one.
  const canImport = session.user.role === "admin";

  if (!result) {
    // PA2.3 — no template to show (never uploaded, deleted, or emptied by a
    // write that broke part-way): an edit file can still be imported HERE —
    // the Settings upload refuses it (wrong door), so this is the only place
    // "import the same file again" can happen.
    const tierNames = canImport
      ? [...(await listTierNames())].map(([tier_id, tier_name]) => ({ tier_id, tier_name }))
      : [];
    return (
      <div className="p-8 max-w-3xl">
        <Link
          href="/iap-management/settings/pricing-tiers"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition mb-3"
        >
          <ArrowLeft className="h-3 w-3" />
          Pricing Templates
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Default Pricing Template — {creds.name}
        </h1>
        <p className="text-xs text-slate-500">
          Account <span className="font-mono text-slate-700">{creds.id}</span> — the account selected in the top bar.
        </p>
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
            on the Settings page to populate this matrix
            {canImport && <>, or import a file made with &ldquo;Export for editing&rdquo;</>}.
          </p>
          <div className="flex items-center justify-center gap-3 mt-4">
            <Link
              href="/iap-management/settings/pricing-tiers"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
            >
              <Upload className="h-4 w-4" />
              Go to Settings · Upload Default Template
            </Link>
            {canImport && (
              <EmptyMatrixImport
                target={{ kind: "ACCOUNT", accountId: creds.id }}
                label={`Default template · ${creds.name} (${creds.id})`}
                isPerApp={false}
                tierNames={tierNames}
              />
            )}
          </div>
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
        // PA2.3 — the account this page shows, named on screen and the only
        // target an import from here may write to (never re-resolved later).
        account={{ id: creds.id, name: creds.name }}
        canImport={canImport}
      />
    </div>
  );
}
