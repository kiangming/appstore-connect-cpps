"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, RefreshCw, Trash2 } from "lucide-react";
import type {
  AppOption,
  AppTemplateSummary,
} from "@/lib/iap-management/queries/templates";

interface Props {
  appsWithTemplates: AppTemplateSummary[];
  activeApps: AppOption[];
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PerAppTemplateTab({ appsWithTemplates, activeApps }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function handleFile(file: File, appId: string) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "APP");
    form.append("app_id", appId);

    try {
      const res = await fetch("/api/iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | {
            template_id: string;
            inserted_entry_count: number;
            warnings?: string[];
          }
        | { error: string };

      if (!res.ok) {
        const message =
          "error" in data ? data.error : `Upload failed (HTTP ${res.status})`;
        toast.error(message);
        return;
      }

      if ("warnings" in data && data.warnings && data.warnings.length > 0) {
        toast.warning(
          `${data.warnings.length} parse warning${data.warnings.length === 1 ? "" : "s"} — see audit log`,
        );
      }
      toast.success(
        `Per-app template uploaded — ${"inserted_entry_count" in data ? data.inserted_entry_count : 0} entries.`,
      );
      setSelectedAppId("");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !selectedAppId) return;
    void handleFile(file, selectedAppId);
  }

  async function handleRemove(templateId: string, appName: string) {
    if (
      !window.confirm(
        `Remove the per-app template for "${appName}"? IAPs in this app will fall back to Default Template (or Apple base).`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/iap-management/pricing-templates/${templateId}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      toast.success(`Removed template for ${appName}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    }
  }

  const appsWithoutTemplates = activeApps.filter(
    (a) => !appsWithTemplates.some((t) => t.app_id === a.id),
  );

  return (
    <div className="space-y-4">
      {/* Upload card */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6">
        <h2 className="text-base font-medium text-slate-900 dark:text-slate-100 mb-1">
          Upload for an app
        </h2>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
          Per-app templates override the Default Template for the selected app.
          Apps without a per-app template fall back to the Default Template
          (and unmatched territories fall through to Apple&apos;s
          auto-equalization).
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
              App
            </label>
            <select
              value={selectedAppId}
              onChange={(e) => setSelectedAppId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#0071E3]"
            >
              <option value="">— Select an app —</option>
              {appsWithoutTemplates.length > 0 && (
                <optgroup label="No template yet">
                  {appsWithoutTemplates.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.bundle_id})
                    </option>
                  ))}
                </optgroup>
              )}
              {appsWithTemplates.length > 0 && (
                <optgroup label="Has template (will replace)">
                  {appsWithTemplates.map((a) => (
                    <option key={a.app_id} value={a.app_id}>
                      {a.app_name} ({a.bundle_id})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !selectedAppId}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50"
          >
            {uploading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? "Uploading…" : "Upload .xlsx"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      </div>

      {/* List card */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
            Apps with custom templates
          </h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
            {appsWithTemplates.length} app{appsWithTemplates.length === 1 ? "" : "s"} configured.
          </p>
        </div>
        {appsWithTemplates.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No per-app templates yet. Use the form above to upload one.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-6 py-3">App</th>
                <th className="px-6 py-3">Bundle ID</th>
                <th className="px-6 py-3 text-right">Entries</th>
                <th className="px-6 py-3">Uploaded</th>
                <th className="px-6 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {appsWithTemplates.map((a) => (
                <tr key={a.template.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-6 py-3 text-slate-800 dark:text-slate-200">
                    {a.app_name}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {a.bundle_id}
                  </td>
                  <td className="px-6 py-3 text-right text-slate-700 dark:text-slate-300">
                    {a.entry_count}
                  </td>
                  <td className="px-6 py-3 text-xs text-slate-500 dark:text-slate-400">
                    {formatTimestamp(a.template.uploaded_at)}
                    <div className="text-[11px] text-slate-400 dark:text-slate-500">
                      {a.template.uploaded_by}
                    </div>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <button
                      onClick={() => handleRemove(a.template.id, a.app_name)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded transition"
                      title="Remove template"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
