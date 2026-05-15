"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Tag, RefreshCw, Sparkles } from "lucide-react";
import type {
  ImportSummary,
  PriceTierRow,
} from "@/lib/iap-management/queries/price-tiers";

interface Props {
  summary: ImportSummary;
  tiers: PriceTierRow[];
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PricingTiersClient({ summary, tiers }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  async function handleFile(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/iap-management/pricing-tiers", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as
        | {
            batch_id: string;
            inserted_tier_count: number;
            inserted_territory_count: number;
            alternate_count?: number;
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
        `Imported ${"inserted_tier_count" in data ? data.inserted_tier_count : 0} tiers ` +
          `(${"alternate_count" in data ? data.alternate_count ?? 0 : 0} alternate) × ` +
          `${"inserted_territory_count" in data ? Math.round(data.inserted_territory_count / Math.max(1, ("inserted_tier_count" in data ? data.inserted_tier_count : 1))) : 0} territories.`,
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
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    void handleFile(file);
  }

  const standardTiers = tiers.filter((t) => !t.is_alternate);
  const alternateTiers = tiers.filter((t) => t.is_alternate);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Pricing Tiers</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Apple price tier cache. Shared across all apps in the IAP Management
          module.
        </p>
      </div>

      {/* Summary card */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-medium text-slate-900">
              Current cache
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Replaces in full on every import (Q-IAP.7).
            </p>
          </div>
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
            {uploading ? "Importing…" : "Import .xlsx"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Total tiers" value={summary.tier_count} />
          <Stat
            label="Alternate tiers"
            value={summary.alternate_count}
            hint="Included per Manager scope (C)"
          />
          <Stat
            label="Territories / tier"
            value={summary.territory_count_per_tier}
          />
          <Stat
            label="Imported"
            value={formatTimestamp(summary.imported_at)}
            hint={summary.imported_by ?? undefined}
          />
        </div>
      </div>

      {/* Empty state */}
      {tiers.length === 0 && (
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">No tiers yet</p>
          <p className="text-xs text-slate-400 mt-1">
            Import the Manager-provided price-tiers-template.xlsx to populate
            the cache.
          </p>
        </div>
      )}

      {/* Tier table */}
      {tiers.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-3 w-24">Tier ID</th>
                <th className="px-4 py-3">Tier Name</th>
                <th className="px-4 py-3 w-24 text-right">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {standardTiers.map((t) => (
                <TierRow key={t.tier_id} tier={t} />
              ))}
              {alternateTiers.length > 0 && (
                <tr className="bg-slate-50">
                  <td colSpan={3} className="px-4 py-2 text-xs font-medium text-slate-500">
                    Alternate tiers ({alternateTiers.length})
                  </td>
                </tr>
              )}
              {alternateTiers.map((t) => (
                <TierRow key={t.tier_id} tier={t} />
              ))}
            </tbody>
          </table>
        </div>
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
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1 truncate">
        {value}
      </p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function TierRow({ tier }: { tier: PriceTierRow }) {
  return (
    <tr className="hover:bg-slate-50 transition">
      <td className="px-4 py-2.5 font-mono text-xs text-slate-600">
        {tier.tier_id}
      </td>
      <td className="px-4 py-2.5 text-slate-800">{tier.tier_name}</td>
      <td className="px-4 py-2.5 text-right">
        {tier.is_alternate ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <Tag className="h-3 w-3" />
            Alternate
          </span>
        ) : (
          <span className="text-[10px] text-slate-400">Standard</span>
        )}
      </td>
    </tr>
  );
}
