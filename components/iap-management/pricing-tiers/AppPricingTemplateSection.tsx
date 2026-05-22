"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, RefreshCw, Trash2, Tag } from "lucide-react";
import type { TemplateHeader } from "@/lib/iap-management/queries/templates";

interface Props {
  /** Internal UUID from iap_mgmt.apps.id, or null when the app hasn't been
   *  registered yet (e.g. no drafts created — the app exists on Apple but
   *  has no iap_mgmt record). When null, the section renders a passive
   *  hint instead of upload controls. */
  internalAppId: string | null;
  /** Current per-app template + entry count; null when none uploaded. */
  template: TemplateHeader | null;
  entryCount: number;
  /** Whether the Default Template exists — drives the "falls back to…" copy
   *  shown when no per-app template is configured. */
  defaultTemplateExists: boolean;
  /** Hotfix 11: current user's email; used to gate the "replacing
   *  someone else's template" confirmation modal. REPLACE-ONLY (Q-A)
   *  semantics mean an unaware overwrite silently loses teammate work. */
  currentUserEmail: string;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AppPricingTemplateSection({
  internalAppId,
  template,
  entryCount,
  defaultTemplateExists,
  currentUserEmail,
}: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function handleFile(file: File) {
    if (!internalAppId) return;
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "APP");
    form.append("app_id", internalAppId);

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
        `App template uploaded — ${"inserted_entry_count" in data ? data.inserted_entry_count : 0} entries.`,
      );
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
    if (!file) return;

    // Hotfix 11: warn before replacing a teammate's template. Same-user
    // replace + first-upload skip the prompt.
    if (template && template.uploaded_by !== currentUserEmail) {
      const ok = window.confirm(
        `This template was last uploaded by ${template.uploaded_by} at ${formatTimestamp(template.uploaded_at)}. ` +
          `Uploading will REPLACE their entries entirely. Continue?`,
      );
      if (!ok) return;
    }

    void handleFile(file);
  }

  async function handleRemove() {
    if (!template) return;
    if (
      !window.confirm(
        "Remove the per-app pricing template? IAPs in this app will fall back to Default Template (or Apple base).",
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/iap-management/pricing-templates/${template.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Per-app template removed.");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    }
  }

  // Passive variant — app hasn't been registered locally yet. No upload
  // affordance to avoid endpoint complexity around ensureAppRegistered.
  if (!internalAppId) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 p-4 mb-6">
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <Tag className="h-4 w-4" />
          <span>
            Per-app pricing templates become available after the app has at
            least one IAP draft. Currently using{" "}
            {defaultTemplateExists ? "the Default Template" : "Apple base data"}.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Pricing Template
          </h3>
          {template ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {entryCount} entries
              </span>{" "}
              · uploaded {formatTimestamp(template.uploaded_at)} by{" "}
              {template.uploaded_by}
              {template.source_filename && (
                <span className="font-mono"> · {template.source_filename}</span>
              )}
            </p>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              No per-app template — IAPs in this app fall back to{" "}
              {defaultTemplateExists
                ? "the Default Template"
                : "Apple base data"}
              .
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {template && (
            <button
              onClick={handleRemove}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-md transition disabled:opacity-50"
          >
            {uploading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {uploading ? "Uploading…" : template ? "Replace" : "Upload .xlsx"}
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
    </div>
  );
}
