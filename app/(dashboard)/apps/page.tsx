import { getApps } from "@/lib/asc-client";
import AppList from "@/components/apps/AppList";

export default async function AppsPage() {
  let apps: Awaited<ReturnType<typeof getApps>> | null = null;
  let error: string | null = null;

  try {
    apps = await getApps();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load apps";
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900 mb-6">Your Apps</h1>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {apps && <AppList apps={apps.data} />}
    </div>
  );
}
