"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { TemplateOverview } from "@/lib/iap-management/queries/templates";
import { TemplateEntriesTable } from "@/components/iap-management/pricing-tiers/TemplateEntriesTable";

interface Props {
  overview: TemplateOverview;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DefaultTemplateTab({ overview }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function handleFile(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "GLOBAL");

    try {
      const res = await fetch("/api/iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | {
            template_id: string;
            inserted_entry_count: number;
            tier_count?: number;
            territory_count?: number;
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
      const tierCount = "tier_count" in data ? data.tier_count ?? 0 : 0;
      const territoryCount = "territory_count" in data ? data.territory_count ?? 0 : 0;
      toast.success(
        `Default Template replaced — ${"inserted_entry_count" in data ? data.inserted_entry_count : 0} entries across ${tierCount} tiers × ${territoryCount} territories.`,
      );
      startTransition(() => router.refresh());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      toast.error(message);
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

  async function handleRemove() {
    if (!overview.template) return;
    if (
      !window.confirm(
        "Remove the Default Template? IAPs created from now on with the Default source will skip per-territory overrides.",
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/iap-management/pricing-templates/${overview.template.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      toast.success("Default Template removed.");
      startTransition(() => router.refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
              Default Template
            </h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
              Applies to every app unless overridden by a per-app template.
              Sparse entries are permitted — missing (tier, territory) cells
              fall back to Apple&apos;s auto-equalization.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {overview.template && (
              <button
                onClick={handleRemove}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-50"
            >
              {uploading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? "Uploading…" : overview.template ? "Replace" : "Upload .xlsx"}
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

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Tiers" value={overview.tiers.length} />
          <Stat label="Territories" value={overview.territory_count} />
          <Stat label="Populated entries" value={overview.populated_entry_count} />
          <Stat
            label="Uploaded"
            value={formatTimestamp(overview.template?.uploaded_at)}
            hint={overview.template?.uploaded_by}
          />
        </div>
      </div>

      {/* Empty state vs entries table */}
      {overview.template === null ? (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            No Default Template
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
            Upload the Manager-provided price-tiers-template.xlsx to set
            per-territory overrides shared across all apps.
          </p>
        </div>
      ) : (
        <TemplateEntriesTable tiers={overview.tiers} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wide">
        {label}
      </p>
      <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
        {value}
      </p>
      {hint && (
        <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{hint}</p>
      )}
    </div>
  );
}
