"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload,
  RefreshCw,
  Package2,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Table2,
} from "lucide-react";

import type { AppTemplateSummary } from "@/lib/google-iap-management/queries/templates";

interface Props {
  appTemplates: AppTemplateSummary[];
  cachedApps: Array<{ id: string; package_name: string; display_name: string | null }>;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PerAppTemplateTab({ appTemplates, cachedApps }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Apps that already have a template — handy to mark in the dropdown.
  const appsWithTemplate = new Set(appTemplates.map((t) => t.app_id));

  async function handleFile(file: File) {
    if (!selectedAppId) {
      setError("Pick an app first.");
      return;
    }
    setError(null);
    setSuccess(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "APP");
    form.append("appId", selectedAppId);
    try {
      const res = await fetch("/api/google-iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        inserted_entry_count?: number;
        tier_count?: number;
        territory_count?: number;
        warnings?: string[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        setError(
          data.error ?? data.errors?.join(" · ") ?? `Upload failed (HTTP ${res.status})`,
        );
        return;
      }
      setSuccess(
        `Uploaded — ${data.inserted_entry_count ?? 0} entries across ${data.tier_count ?? 0} tiers × ${data.territory_count ?? 0} regions.`,
      );
      setSelectedAppId("");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void handleFile(file);
  }

  async function handleDelete(templateId: string, packageName: string) {
    if (
      !window.confirm(
        `Remove the per-app template for ${packageName}? Future IAPs for this app will fall back to the Default Template (if any) or Google auto-equalisation.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/google-iap-management/pricing-templates/${templateId}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      setSuccess(`Template for ${packageName} removed.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-4">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-slate-900 mb-1">
          Upload for a specific app
        </h2>
        <p className="text-xs text-slate-500 mb-4 max-w-prose">
          Per-app templates take precedence over the Default Template when an
          IAP for that app uses the &quot;App Template&quot; pricing source.
        </p>
        <div className="flex items-center gap-2">
          <select
            value={selectedAppId}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="flex-1 max-w-sm rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
          >
            <option value="">— Select an app —</option>
            {cachedApps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name ?? a.package_name}{" "}
                {appsWithTemplate.has(a.id) ? "· has template" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedAppId || uploading}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
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
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
        {cachedApps.length === 0 && (
          <p className="text-xs text-slate-400 mt-2 italic">
            No apps cached yet. Refresh the apps list under{" "}
            <em>Google IAP Management → Apps</em> first.
          </p>
        )}
      </section>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {appTemplates.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Package2 className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            No per-app templates yet
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Pick an app above and upload its tailored pricing template.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5">App</th>
                <th className="px-4 py-2.5 text-right">Entries</th>
                <th className="px-4 py-2.5 text-right">Tiers</th>
                <th className="px-4 py-2.5">Uploaded</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {appTemplates.map((t) => (
                <tr key={t.template.id} className="hover:bg-slate-50 transition">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-slate-900">
                      {t.display_name ?? t.package_name}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500">
                      {t.package_name}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-700">
                    {t.entry_count}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-700">
                    {t.tier_count}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    <p>{formatTimestamp(t.template.uploaded_at)}</p>
                    <p className="text-[10px] text-slate-400">
                      by {t.template.uploaded_by}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Link
                        href={`/google-iap-management/settings/pricing-templates/per-app/${encodeURIComponent(t.app_id)}`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 rounded px-2 py-1 transition"
                      >
                        <Table2 className="h-3.5 w-3.5" />
                        View matrix
                      </Link>
                      <button
                        onClick={() => handleDelete(t.template.id, t.package_name)}
                        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 rounded px-2 py-1 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
