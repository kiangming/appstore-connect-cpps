import { getCpps } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { CppList } from "@/components/cpp/CppList";
import type { AppCustomProductPage, AppCustomProductPageVersion, CppState } from "@/types/asc";

interface Props {
  params: { appId: string };
}

export default async function CppsPage({ params }: Props) {
  let cpps: AppCustomProductPage[] = [];
  const versionStates: Record<string, CppState> = {};
  const versionIds: Record<string, string> = {};
  const rejectReasons: Record<string, string> = {};
  let fetchError: string | null = null;

  try {
    const creds = await getActiveAccount();
    const res = await getCpps(creds, params.appId);
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
