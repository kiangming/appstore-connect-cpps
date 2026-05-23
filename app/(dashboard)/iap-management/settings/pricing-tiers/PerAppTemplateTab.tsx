"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, RefreshCw, Trash2, Loader2, Table2 } from "lucide-react";
import type { AppTemplateSummary } from "@/lib/iap-management/queries/templates";

interface AscApp {
  id: string;
  name: string;
  bundle_id: string;
}

interface Props {
  appsWithTemplates: AppTemplateSummary[];
  /** Hotfix 11: current user's email; used to gate the "replacing
   *  someone else's template" confirmation modal. The Per-App template
   *  is REPLACE-ONLY (Q-A) so an unaware overwrite silently loses a
   *  teammate's work — confirm before overwriting. */
  currentUserEmail: string;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PerAppTemplateTab({
  appsWithTemplates,
  currentUserEmail,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  // IAP.p1.j Issue 3: live-fetch the app list from the active ASC account
  // every time the dropdown is opened. The previous behavior queried
  // iap_mgmt.apps (only locally-registered apps) which excluded apps the
  // Manager had never saved a draft for. Live fetch hits Apple via
  // /api/iap-management/asc-apps under the active getActiveAccount creds
  // so an account switch + reopen surfaces the new account's catalog.
  const [ascApps, setAscApps] = useState<AscApp[]>([]);
  const [ascAccountName, setAscAccountName] = useState<string | null>(null);
  const [ascAppsLoading, setAscAppsLoading] = useState(false);
  const [ascAppsError, setAscAppsError] = useState<string | null>(null);
  const fetchInFlight = useRef<Promise<void> | null>(null);

  async function refreshAscApps() {
    if (fetchInFlight.current) return fetchInFlight.current;
    setAscAppsLoading(true);
    setAscAppsError(null);
    const p = (async () => {
      try {
        const res = await fetch("/api/iap-management/asc-apps", {
          cache: "no-store",
        });
        const data = (await res.json()) as
          | { apps: AscApp[]; account_name?: string }
          | { error: string };
        if (!res.ok) {
          setAscAppsError("error" in data ? data.error : `Fetch failed (${res.status})`);
          return;
        }
        if ("apps" in data) {
          setAscApps(data.apps);
          setAscAccountName(data.account_name ?? null);
        }
      } catch (err) {
        setAscAppsError(err instanceof Error ? err.message : "Network error");
      } finally {
        setAscAppsLoading(false);
      }
    })();
    fetchInFlight.current = p;
    try {
      await p;
    } finally {
      fetchInFlight.current = null;
    }
  }

  // Initial hydration once on mount; subsequent fetches fire on dropdown
  // open (mousedown / focus) so an account switch picked up live.
  useEffect(() => {
    void refreshAscApps();
  }, []);

  async function handleFile(file: File, appleAppId: string) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "APP");
    // IAP.p1.j Issue 3: dropdown carries Apple's numeric ID; the upload
    // endpoint resolves to the internal iap_mgmt.apps UUID via
    // ensureAppRegistered (auto-registers if not yet known locally).
    form.append("apple_app_id", appleAppId);

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

    // Hotfix 11: REPLACE-ONLY (Q-A) wipes the existing entries CASCADE.
    // If the existing template was uploaded by a different user, warn
    // before overwriting their work. Same-user replace and first-upload
    // skip the prompt.
    const existing = appsWithTemplates.find(
      (a) => a.apple_app_id === selectedAppId,
    );
    if (existing && existing.template.uploaded_by !== currentUserEmail) {
      const when = formatTimestamp(existing.template.uploaded_at);
      const ok = window.confirm(
        `This template was last uploaded by ${existing.template.uploaded_by} at ${when}. ` +
          `Uploading will REPLACE their entries entirely. Continue?`,
      );
      if (!ok) return;
    }

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

  // ASC IDs are Apple's numeric strings; iap_mgmt.apps stores them under
  // `apple_app_id` (NOT the internal UUID). The dropdown carries the
  // Apple ID as the value, and the upload endpoint resolves to internal
  // via ensureAppRegistered — see /api/iap-management/pricing-templates.
  // For now we exclude apps that already have a per-app template by
  // matching against the existing AppTemplateSummary.bundle_id.
  const appsWithoutTemplates = ascApps.filter(
    (a) => !appsWithTemplates.some((t) => t.bundle_id === a.bundle_id),
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
        <div>
          <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
            App
          </label>
          {/* Row aligns the select + button along their shared baseline.
              The "Apps from ASC account:" helper renders BELOW the row so
              it doesn't push the button out of line with the select. */}
          <div className="flex items-center gap-3">
            <select
              value={selectedAppId}
              onChange={(e) => setSelectedAppId(e.target.value)}
              onMouseDown={() => {
                // IAP.p1.j Issue 3: refetch on every dropdown open so an
                // account switch picked up live without page reload.
                void refreshAscApps();
              }}
              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#0071E3]"
            >
              <option value="">
                {ascAppsLoading
                  ? "Loading apps…"
                  : ascAppsError
                    ? `Failed: ${ascAppsError}`
                    : "— Select an app —"}
              </option>
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
                    <option key={a.apple_app_id} value={a.apple_app_id}>
                      {a.app_name} ({a.bundle_id})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !selectedAppId}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50 shrink-0"
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
          {ascAccountName && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
              Apps from ASC account:{" "}
              <span className="font-medium text-slate-600 dark:text-slate-400">
                {ascAccountName}
              </span>
              {ascAppsLoading && (
                <Loader2 className="inline h-3 w-3 ml-1 animate-spin" />
              )}
            </p>
          )}
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
                <th className="px-6 py-3">ASC Account</th>
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
                  <td className="px-6 py-3 text-xs text-slate-600 dark:text-slate-400">
                    {a.asc_account_name ? (
                      a.asc_account_name
                    ) : (
                      <span className="text-slate-400 dark:text-slate-600">—</span>
                    )}
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
                    <div className="inline-flex items-center gap-4 whitespace-nowrap">
                      <Link
                        href={`/iap-management/settings/pricing-tiers/per-app-matrix/${encodeURIComponent(a.app_id)}`}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded-md transition whitespace-nowrap"
                        title="View matrix"
                      >
                        <Table2 className="h-3.5 w-3.5" />
                        View matrix
                      </Link>
                      <button
                        onClick={() => handleRemove(a.template.id, a.app_name)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-md transition whitespace-nowrap"
                        title="Remove template"
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
        )}
      </div>
    </div>
  );
}
