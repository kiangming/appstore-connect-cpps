import { getCpps } from "@/lib/asc-client";
import { CppList } from "@/components/cpp/CppList";
import Link from "next/link";
import type { AppCustomProductPageVersion, CppState } from "@/types/asc";

interface Props {
  params: { appId: string };
}

export default async function CppsPage({ params }: Props) {
  let cpps;
  let versionStates: Record<string, CppState> = {};
  let fetchError: string | null = null;

  try {
    const res = await getCpps(params.appId);
    cpps = res.data;

    const included = res.included ?? [];
    const versions = included.filter(
      (r) => r.type === "appCustomProductPageVersions"
    ) as unknown as AppCustomProductPageVersion[];

    for (const cpp of cpps) {
      const rels = cpp.relationships as {
        appCustomProductPageVersions?: { data?: Array<{ id: string }> };
      };
      const versionIds = rels?.appCustomProductPageVersions?.data?.map((d) => d.id) ?? [];
      const match = versions.find((v) => versionIds.includes(v.id));
      if (match) versionStates[cpp.id] = match.attributes.state;
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
            Manage CPPs for app <code className="font-mono text-xs bg-slate-100 px-1 rounded">{params.appId}</code>
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
        <CppList cpps={cpps ?? []} appId={params.appId} versionStates={versionStates} />
      )}
    </div>
  );
}
