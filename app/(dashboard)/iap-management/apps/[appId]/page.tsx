import { Suspense } from "react";
import { getApp } from "@/lib/asc-client";
import { listAllInAppPurchases } from "@/lib/iap-management/apple/client";
import { getActiveAccount } from "@/lib/get-active-account";
import { requireIapSession } from "@/lib/iap-management/auth";
import {
  ensureAppRegistered,
  listDraftIaps,
  listSyncedAppleIapMap,
  seedMissingIapStubs,
  type IapDbRow,
} from "@/lib/iap-management/queries/iaps";
import {
  getTemplateSummary,
  type TemplateHeader,
} from "@/lib/iap-management/queries/templates";
import { IapListClient } from "./IapListClient";
import { AppPricingTemplateSection } from "@/components/iap-management/pricing-tiers/AppPricingTemplateSection";
import type {
  InAppPurchase,
} from "@/types/iap-management/apple";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { appId: string };
}

function IapListSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-[60px] h-[60px] rounded-[16px] bg-slate-200 animate-pulse" />
        <div className="space-y-2">
          <div className="h-7 w-64 rounded bg-slate-200 animate-pulse" />
          <div className="h-4 w-40 rounded bg-slate-200 animate-pulse" />
        </div>
      </div>
      <div className="h-10 w-full rounded-xl bg-slate-200 animate-pulse" />
      <div className="rounded-xl border border-slate-200 bg-white">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-12 px-4 flex items-center gap-4 border-b border-slate-100 last:border-0"
          >
            <div className="h-3 w-40 rounded bg-slate-200 animate-pulse" />
            <div className="h-3 w-32 rounded bg-slate-200 animate-pulse ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

async function IapListContent({ appId }: { appId: string }) {
  // Hotfix 11: thread current user's email to AppPricingTemplateSection
  // so the Replace flow can confirm before overwriting a different
  // teammate's per-app template.
  const session = await requireIapSession();
  const currentUserEmail = session.user.email ?? "unknown";

  let error: string | null = null;
  let appName: string | null = null;
  let appBundleId: string | null = null;
  let iaps: InAppPurchase[] = [];
  let drafts: IapDbRow[] = [];
  let appleToInternal: Record<string, string> = {};
  let internalAppId: string | null = null;
  let ascAccountId: string | null = null;

  try {
    const creds = await getActiveAccount();
    ascAccountId = creds.id;
    const [appRes, iapsRes] = await Promise.all([
      getApp(creds, appId),
      listAllInAppPurchases(creds, appId),
    ]);
    appName = appRes.data.attributes.name;
    appBundleId = appRes.data.attributes.bundleId;
    iaps = iapsRes.data ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load IAPs";
  }

  // Hotfix 13: register the app + seed missing local stubs so the
  // per-row View/Edit buttons + functional checkboxes always render.
  // Prior behaviour required Manager to click "Refresh from Apple"
  // first to populate appleToInternal — apps that had never been
  // refreshed showed 200+ live Apple IAPs with no action affordances.
  // Auto-seed is INSERT-only; the explicit Refresh button still owns
  // state-drift reconciliation (UPDATE_STATE + UNCHANGED counters).
  let appTemplate: TemplateHeader | null = null;
  let appTemplateEntryCount = 0;
  let defaultTemplateExists = false;
  try {
    if (appName && appBundleId) {
      internalAppId = await ensureAppRegistered({
        apple_app_id: appId,
        bundle_id: appBundleId,
        name: appName,
        asc_account_id: ascAccountId,
      });
      if (iaps.length > 0) {
        await seedMissingIapStubs(internalAppId, iaps);
      }
    }
    if (internalAppId) {
      drafts = (await listDraftIaps(internalAppId)).drafts;
      appleToInternal = await listSyncedAppleIapMap(internalAppId);
      const summary = await getTemplateSummary({ kind: "APP", app_id: internalAppId });
      if (summary) {
        appTemplate = summary.template;
        appTemplateEntryCount = summary.entry_count;
      }
    }
    const def = await getTemplateSummary({ kind: "GLOBAL" });
    defaultTemplateExists = def !== null;
  } catch {
    // registration + seed + drafts + template lookups are non-essential
    // for the read view — degrade silently. View/Edit buttons may stay
    // hidden if seed failed but the rest of the list still renders.
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  // Hotfix 25 — Strategy A → D pivot. The Server Component used to bulk
  // prefetch Apple availability for every IAP here; production verified
  // that Apple's 250 req/hour cap cascades into 429s on multi-app
  // workflows. The page now returns immediately; the Availabilities
  // column lazy-loads per row via IntersectionObserver + a client-side
  // concurrency queue (see components/iap-management/AvailabilityCell.tsx
  // + lib/iap-management/client-fetch-queue.ts).
  return (
    <>
      <AppPricingTemplateSection
        internalAppId={internalAppId}
        template={appTemplate}
        entryCount={appTemplateEntryCount}
        defaultTemplateExists={defaultTemplateExists}
        currentUserEmail={currentUserEmail}
      />
      <IapListClient
        appId={appId}
        appName={appName ?? ""}
        appBundleId={appBundleId ?? ""}
        iaps={iaps}
        drafts={drafts}
        appleToInternal={appleToInternal}
      />
    </>
  );
}

export default function IapAppDetailPage({ params }: PageProps) {
  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Suspense fallback={<IapListSkeleton />}>
        <IapListContent appId={params.appId} />
      </Suspense>
    </div>
  );
}
