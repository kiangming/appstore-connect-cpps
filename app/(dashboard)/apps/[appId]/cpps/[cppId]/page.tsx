import { getCpp, getCppVersionLocalizations } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { CppEditor } from "@/components/cpp/CppEditor";
import type { AppCustomProductPageVersion, AppCustomProductPageLocalization } from "@/types/asc";
import Link from "next/link";

interface Props {
  params: { appId: string; cppId: string };
}

export default async function CppEditorPage({ params }: Props) {
  let cpp;
  let versions: AppCustomProductPageVersion[] = [];
  let localizations: AppCustomProductPageLocalization[] = [];
  let fetchError: string | null = null;

  try {
    const creds = await getActiveAccount();
    const res = await getCpp(creds, params.cppId);
    cpp = res.data;

    const included = res.included ?? [];
    versions = included.filter(
      (r) => r.type === "appCustomProductPageVersions"
    ) as unknown as AppCustomProductPageVersion[];

    if (versions.length > 0) {
      const locRes = await getCppVersionLocalizations(creds, versions[0].id);
      localizations = locRes.data;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load CPP";
  }

  if (fetchError) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {fetchError}
        </div>
      </div>
    );
  }

  if (!cpp) return null;

  return (
    <div className="p-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-slate-400 mb-1">
          <Link href={`/apps/${params.appId}/cpps`} className="hover:text-slate-600">
            CPP List
          </Link>
          <span>/</span>
          <span className="text-slate-600">{cpp.attributes.name}</span>
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">
          {cpp.attributes.name}
        </h1>
        <p className="text-xs font-mono text-slate-400 mt-0.5">{cpp.id}</p>
      </div>

      <CppEditor
        cpp={cpp}
        appId={params.appId}
        versions={versions}
        localizations={localizations}
      />
    </div>
  );
}
