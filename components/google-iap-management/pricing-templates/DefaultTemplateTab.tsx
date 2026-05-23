"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Upload,
  RefreshCw,
  Sparkles,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Table2,
} from "lucide-react";

import type { TemplateOverview } from "@/lib/google-iap-management/queries/templates";
import { EntriesPreviewTable } from "./EntriesPreviewTable";

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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setSuccess(null);
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("scope", "GLOBAL");
    try {
      const res = await fetch("/api/google-iap-management/pricing-templates", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        template_id?: string;
        inserted_entry_count?: number;
        tier_count?: number;
        territory_count?: number;
        warnings?: string[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        const message =
          data.error ?? data.errors?.join(" · ") ?? `Upload failed (HTTP ${res.status})`;
        setError(message);
        return;
      }
      const w = data.warnings && data.warnings.length > 0
        ? ` · ${data.warnings.length} warning(s)`
        : "";
      setSuccess(
        `Replaced — ${data.inserted_entry_count ?? 0} entries across ${data.tier_count ?? 0} tiers × ${data.territory_count ?? 0} regions${w}.`,
      );
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

  async function handleRemove() {
    if (!overview.template) return;
    if (
      !window.confirm(
        "Remove the Default Template? IAPs that use the Default source will fall back to base price + Google auto-equalisation.",
      )
    ) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(
        `/api/google-iap-management/pricing-templates/${overview.template.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Delete failed (HTTP ${res.status})`);
        return;
      }
      setSuccess("Default Template removed.");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    }
  }

  return (
    <div className="space-y-4">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Default Template
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-prose">
              Applied to every app unless overridden by a per-app template.
              Sparse cells are permitted — missing (tier, region) pairs fall
              back to Google&apos;s auto-equalisation.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {overview.template && (
              <Link
                href="/google-iap-management/settings/pricing-templates/default"
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg transition"
              >
                <Table2 className="h-4 w-4" />
                Open matrix view
              </Link>
            )}
            {overview.template && (
              <button
                onClick={handleRemove}
                disabled={uploading}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
            >
              {uploading ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading
                ? "Uploading…"
                : overview.template
                  ? "Replace"
                  : "Upload .xlsx"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Tiers" value={overview.tierCount} />
          <Stat label="Regions" value={overview.territoryCount} />
          <Stat label="Entries" value={overview.entryCount} />
          <Stat
            label="Uploaded"
            value={formatTimestamp(overview.template?.uploaded_at)}
            hint={overview.template?.uploaded_by ?? null}
          />
        </div>
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

      {overview.template === null ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            No Default Template
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Upload the Manager-provided{" "}
            <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">
              pricing-template-google.xlsx
            </code>{" "}
            to set per-region pricing shared across all apps.
          </p>
        </div>
      ) : (
        <EntriesPreviewTable
          entries={overview.sampleEntries}
          totalEntryCount={overview.entryCount}
        />
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
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1 truncate">
        {value}
      </p>
      {hint && (
        <p className="text-[11px] text-slate-400 mt-0.5 truncate">{hint}</p>
      )}
    </div>
  );
}
