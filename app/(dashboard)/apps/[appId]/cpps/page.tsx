import { getCpps, getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { CppList } from "@/components/cpp/CppList";
import Link from "next/link";
import type { AppCustomProductPage, AppCustomProductPageVersion, CppState } from "@/types/asc";

interface Props {
  params: { appId: string };
}

export default async function CppsPage({ params }: Props) {
  let cpps: AppCustomProductPage[] = [];
  let appName: string | null = null;
  let versionStates: Record<string, CppState> = {};
  let versionIds: Record<string, string> = {};
  let rejectReasons: Record<string, string> = {};
  let fetchError: string | null = null;

  try {
    const creds = await getActiveAccount();
    const [res, appRes] = await Promise.all([
      getCpps(creds, params.appId),
      getApp(creds, params.appId),
    ]);
    appName = appRes.data.attributes.name;
    cpps = res.data;

    const included = res.included ?? [];
    const versions = included.filter(
      (r) => r.type === "appCustomProductPageVersions"
    ) as unknown as AppCustomProductPageVersion[];

    for (const cpp of cpps) {
      const rels = cpp.relationships as {
        appCustomProductPageVersions?: { data?: Array<{ id: string }> };
      };
      const versionIdList = rels?.appCustomProductPageVersions?.data?.map((d) => d.id) ?? [];
      const match = versions.find((v) => versionIdList.includes(v.id));
      if (match) {
        versionStates[cpp.id] = match.attributes.state;
        versionIds[cpp.id] = match.id;
        if (match.attributes.rejectedVersionUserFeedback) {
          rejectReasons[cpp.id] = match.attributes.rejectedVersionUserFeedback;
        }
      }
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load CPPs";
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Custom Product Pages
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage CPPs for app <span className="font-medium text-slate-700">{appName ?? params.appId}</span>
            <span className="ml-2 text-slate-400">[{cpps?.length ?? 0}/70]</span>
          </p>
        </div>
        <Link
          href={`/apps/${params.appId}/cpps/new`}
          className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#0077ED] text-white font-medium text-sm rounded-lg px-4 py-2 transition"
        >
          + New CPP
        </Link>
      </div>

      {fetchError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fetchError}
        </div>
      ) : (
        <CppList cpps={cpps ?? []} appId={params.appId} versionStates={versionStates} versionIds={versionIds} rejectReasons={rejectReasons} />
      )}
    </div>
  );
}
