import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireIapAdmin, IapForbiddenError } from "@/lib/iap-management/auth";
import { listTiers } from "@/lib/iap-management/queries/price-tiers";
import { getIapWithRelations } from "@/lib/iap-management/queries/iaps";
import { getTemplateSummary } from "@/lib/iap-management/queries/templates";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { IapForm } from "@/components/iap-management/iap-form/IapForm";
import type {
  IapFormState,
  FormLocalization,
} from "@/lib/iap-management/validation";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string; iapId: string };
}

export default async function EditIapPage({ params }: PageProps) {
  try {
    await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapForbiddenError) redirect("/");
    throw err;
  }

  const data = await getIapWithRelations(params.iapId);
  if (!data) notFound();

  let appName = "";
  try {
    const creds = await getActiveAccount();
    const app = await getApp(creds, params.appId);
    appName = app.data.attributes.name;
  } catch {
    // header degrades gracefully
  }

  const tiers = await listTiers();

  // Map DB rows back to form state
  const localizations: Record<string, FormLocalization> = {};
  for (const loc of data.localizations) {
    localizations[loc.locale] = {
      locale: loc.locale,
      display_name: loc.display_name,
      description: loc.description,
    };
  }

  const screenshot = data.screenshots[0];
  const initial: IapFormState = {
    reference_name: data.iap.reference_name,
    product_id: data.iap.product_id,
    type: (data.iap.type as InAppPurchaseType) ?? "",
    tier_id: data.iap.tier_id,
    localizations,
    screenshot_filename: screenshot?.file_name ?? null,
    review_note: data.iap.review_note ?? null,
    family_sharable: Boolean(data.iap.family_sharable),
    // IAP.p1.j Issue 1: hydrate persisted pricing-source so the form
    // doesn't re-derive Q-D default and override the Manager's choice.
    pricing_source: data.iap.pricing_source ?? undefined,
  };

  // IAP.p1.f: per-edit pricing-source selection. Defaults to most-specific
  // available (Q-D) since edit-time the previous source isn't persisted
  // (Q-J per-creation explicit). Manager re-selects each Update-on-Apple.
  let defaultTemplateAvailable = false;
  let defaultTemplateEntryCount = 0;
  let appTemplateAvailable = false;
  let appTemplateEntryCount = 0;
  try {
    const def = await getTemplateSummary({ kind: "GLOBAL" });
    if (def) {
      defaultTemplateAvailable = true;
      defaultTemplateEntryCount = def.entry_count;
    }
    const app = await getTemplateSummary({ kind: "APP", app_id: data.iap.app_id });
    if (app) {
      appTemplateAvailable = true;
      appTemplateEntryCount = app.entry_count;
    }
  } catch {
    // non-essential
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link
        href={`/iap-management/apps/${params.appId}`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition mb-4"
      >
        <ChevronLeft className="h-4 w-4" />
        IAPs · {appName || params.appId}
      </Link>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold text-slate-900">
          Edit IAP — {data.iap.reference_name}
        </h1>
        <div className="flex items-center gap-2 text-xs">
          {data.iap.apple_iap_id ? (
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              Synced
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-slate-50 text-slate-600 border border-slate-200">
              Local draft
            </span>
          )}
          <span className="font-mono text-slate-400">
            {data.iap.product_id}
          </span>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        State:{" "}
        <span className="font-medium text-slate-700">{data.iap.state}</span>
        {data.iap.synced_at && ` · Synced ${new Date(data.iap.synced_at).toLocaleString()}`}
      </p>
      <IapForm
        mode="edit"
        appAppleId={params.appId}
        iapId={params.iapId}
        syncedToApple={data.iap.apple_iap_id !== null}
        appleState={data.iap.state}
        initial={initial}
        tiers={tiers}
        defaultTemplateAvailable={defaultTemplateAvailable}
        appTemplateAvailable={appTemplateAvailable}
        defaultTemplateEntryCount={defaultTemplateEntryCount}
        appTemplateEntryCount={appTemplateEntryCount}
      />
    </div>
  );
}
