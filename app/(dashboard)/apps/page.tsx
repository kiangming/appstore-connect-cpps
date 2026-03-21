import { Suspense } from "react";
import { getApps } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import AppList from "@/components/apps/AppList";

function AppListSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-32 rounded-lg bg-slate-200 animate-pulse" />
        <div className="h-5 w-8 rounded-full bg-slate-200 animate-pulse" />
      </div>
      <div className="h-10 w-full rounded-xl bg-slate-200 animate-pulse" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-5"
          >
            <div className="w-[52px] h-[52px] rounded-[12px] bg-slate-200 animate-pulse" />
            <div className="w-full space-y-1.5">
              <div className="h-4 w-3/4 mx-auto rounded bg-slate-200 animate-pulse" />
              <div className="h-3 w-1/2 mx-auto rounded bg-slate-200 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function AppsContent() {
  let error: string | null = null;
  let appList: Awaited<ReturnType<typeof getApps>> | null = null;

  try {
    const creds = await getActiveAccount();
    appList = await getApps(creds);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load apps";
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  return appList ? <AppList apps={appList.data} /> : null;
}

export default function AppsPage() {
  return (
    <div className="p-8 max-w-6xl">
      <Suspense fallback={<AppListSkeleton />}>
        <AppsContent />
      </Suspense>
    </div>
  );
}
