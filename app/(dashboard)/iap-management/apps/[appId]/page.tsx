import { Suspense } from "react";
import { getApp } from "@/lib/asc-client";
import { listInAppPurchases } from "@/lib/iap-management/apple/client";
import { withRetry } from "@/lib/iap-management/apple/fetch";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  findAppByAppleId,
  listDraftIaps,
  type IapDbRow,
} from "@/lib/iap-management/queries/iaps";
import { IapListClient } from "./IapListClient";
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
  let error: string | null = null;
  let appName: string | null = null;
  let appBundleId: string | null = null;
  let iaps: InAppPurchase[] = [];
  let drafts: IapDbRow[] = [];

  try {
    const creds = await getActiveAccount();
    const [appRes, iapsRes] = await Promise.all([
      getApp(creds, appId),
      withRetry(() => listInAppPurchases(creds, appId)),
    ]);
    appName = appRes.data.attributes.name;
    appBundleId = appRes.data.attributes.bundleId;
    iaps = iapsRes.data ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load IAPs";
  }

  // Drafts are read-only-by-default: only fetch if the app exists in our
  // schema (= a draft has been saved at least once). findAppByAppleId is a
  // pure read; it returns null for un-registered apps which is normal.
  try {
    const internalAppId = await findAppByAppleId(appId);
    if (internalAppId) {
      drafts = (await listDraftIaps(internalAppId)).drafts;
    }
  } catch {
    // drafts are non-essential — degrade silently
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return (
    <IapListClient
      appId={appId}
      appName={appName ?? ""}
      appBundleId={appBundleId ?? ""}
      iaps={iaps}
      drafts={drafts}
    />
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
