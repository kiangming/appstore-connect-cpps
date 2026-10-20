export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { Package2, Upload } from "lucide-react";

import { requireIapSession } from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { iapDb } from "@/lib/iap-management/db";
import { fetchPerAppMatrix } from "@/lib/iap-management/queries/template-matrix";
import { templateExists } from "@/lib/iap-management/queries/templates";
import { listTierNames } from "@/lib/iap-management/queries/price-tiers";
import { MatrixBreadcrumb } from "@/components/iap-management/pricing-templates/MatrixBreadcrumb";
import { PerAppMatrixView } from "@/components/iap-management/pricing-templates/PerAppMatrixView";
import { EmptyMatrixImport } from "@/components/iap-management/pricing-templates/EmptyMatrixImport";

interface PageProps {
  params: { appId: string };
}

interface AppRow {
  id: string;
  name: string;
  bundle_id: string;
}

async function loadApp(appId: string): Promise<AppRow | null> {
  const { data, error } = await iapDb()
    .from("apps")
    .select("id, name, bundle_id")
    .eq("id", appId)
    .maybeSingle();
  if (error) throw new Error(`App lookup failed: ${error.message}`);
  return (data as AppRow | null) ?? null;
}

export default async function PerAppMatrixPage({ params }: PageProps) {
  await requireIapSession();

  const appId = decodeURIComponent(params.appId);
  const app = await loadApp(appId);
  if (!app) notFound();

  // C-B: `defaultTemplateExists()` từng là một query inline chạm thẳng
  // bảng — đường thứ 10 của census, đường DUY NHẤT mà C-A không bắt được
  // vì tsc không có kiểu nào để bám. Nay nó đi qua repository và hỏi đúng
  // câu hỏi mới: "ACCOUNT NÀY có template chưa", không phải "có GLOBAL không".
  const creds = await getActiveAccount();
  const [result, hasDefault] = await Promise.all([
    fetchPerAppMatrix(appId, creds.id),
    templateExists({ kind: "ACCOUNT", account_id: creds.id }),
  ]);

  if (!result) {
    // PA2.3 — an edit file can still be imported here (open to members, like
    // a Per-App upload): the only door for "import the same file again" after
    // a write that broke part-way, or for restoring a deleted template.
    const tierNames = [...(await listTierNames())].map(([tier_id, tier_name]) => ({ tier_id, tier_name }));
    return (
      <div className="p-8 max-w-3xl">
        <MatrixBreadcrumb
          trail={[
            { label: "Settings", href: "/iap-management/settings" },
            {
              label: "Pricing Templates",
              href: "/iap-management/settings/pricing-tiers",
            },
            {
              label: "Per-App Templates",
              href: "/iap-management/settings/pricing-tiers",
            },
            { label: app.name },
          ]}
        />
        <h1 className="text-2xl font-semibold text-slate-900 mb-1">
          Per-App Pricing Template — {app.name}
        </h1>
        <p className="text-xs text-slate-500 mb-6 font-mono">{app.bundle_id}</p>

        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Package2 className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-base font-medium text-slate-700 mb-1">
            No Per-App template uploaded yet
          </p>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto mb-5">
            A Per-App template is this app&apos;s own price list — an empty
            cell gets Apple&apos;s price, never the Default&apos;s. Without one,
            new IAPs are offered the Default Template as their pricing source;
            an IAP already saved with the Per-App source gets Apple&apos;s
            prices. You can also import a file made with &ldquo;Export for
            editing&rdquo;.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/iap-management/settings/pricing-tiers"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
            >
              <Upload className="h-4 w-4" />
              Upload Per-App Template
            </Link>
            <EmptyMatrixImport
              target={{ kind: "APP", appId: app.id }}
              label={`Per-App template · ${app.name} (${app.bundle_id})`}
              isPerApp
              tierNames={tierNames}
            />
            {hasDefault && (
              <Link
                href="/iap-management/settings/pricing-tiers/default-matrix"
                className="text-sm text-sky-700 hover:underline"
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
        matrix={result.matrix}
        appId={app.id}
        appName={app.name}
        bundleId={app.bundle_id}
        uploadedAt={result.header.uploaded_at}
        uploadedBy={result.header.uploaded_by}
        defaultTemplateExists={hasDefault}
      />
    </div>
  );
}
