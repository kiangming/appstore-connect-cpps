"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload,
  Tag,
  RefreshCw,
  Sparkles,
  ChevronRight,
  Search,
} from "lucide-react";
import type {
  ImportSummary,
  PriceTierRow,
  TierTerritoryDetail,
} from "@/lib/iap-management/queries/price-tiers";

interface Props {
  summary: ImportSummary;
  tiers: PriceTierRow[];
  tiersDetail: TierTerritoryDetail[];
}

const TOP_MARKETS = ["USA", "VNM", "JPN", "KOR", "CHN", "GBR", "DEU", "FRA", "ESP", "IDN"];

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 100 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function PricingTiersClient({ summary, tiers, tiersDetail }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [, startTransition] = useTransition();

  // Index detail by tier_id for O(1) lookup on row expand.
  const detailByTier = useMemo(() => {
    const m = new Map<string, TierTerritoryDetail>();
    for (const d of tiersDetail) m.set(d.tier_id, d);
    return m;
  }, [tiersDetail]);

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
          `(${"alternate_count" in data ? (data.alternate_count ?? 0) : 0} alternate) × ` +
          `${"inserted_territory_count" in data ? Math.round(data.inserted_territory_count / Math.max(1, "inserted_tier_count" in data ? data.inserted_tier_count : 1)) : 0} territories.`,
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
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Pricing Tiers
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Apple price tier cache. Shared across all apps in the IAP Management
          module.
        </p>
      </div>

      {/* Summary card */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6 mb-4">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
              Current cache
            </h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
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
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            No tiers yet
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
            Import the Manager-provided price-tiers-template.xlsx to populate
            the cache.
          </p>
        </div>
      )}

      {/* Tier table */}
      {tiers.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3 w-8"></th>
                <th className="px-4 py-3 w-24">Tier ID</th>
                <th className="px-4 py-3">Tier Name</th>
                <th className="px-4 py-3 w-32 text-right">USD Price</th>
                <th className="px-4 py-3 w-24 text-right">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {standardTiers.map((t) => (
                <TierRow key={t.tier_id} tier={t} detail={detailByTier.get(t.tier_id)} />
              ))}
              {alternateTiers.length > 0 && (
                <tr className="bg-slate-50 dark:bg-slate-800/50">
                  <td
                    colSpan={5}
                    className="px-4 py-2 text-xs font-medium text-slate-500 dark:text-slate-400"
                  >
                    Alternate tiers ({alternateTiers.length})
                  </td>
                </tr>
              )}
              {alternateTiers.map((t) => (
                <TierRow key={t.tier_id} tier={t} detail={detailByTier.get(t.tier_id)} />
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

function TierRow({
  tier,
  detail,
}: {
  tier: PriceTierRow;
  detail: TierTerritoryDetail | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = (detail?.territories.length ?? 0) > 0;

  return (
    <>
      <tr
        className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 transition cursor-pointer ${
          expanded ? "bg-slate-50/50 dark:bg-slate-800/30" : ""
        }`}
        onClick={() => hasDetail && setExpanded((e) => !e)}
      >
        <td className="px-4 py-2.5 text-slate-400 dark:text-slate-500">
          {hasDetail && (
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400">
          {tier.tier_id}
        </td>
        <td className="px-4 py-2.5 text-slate-800 dark:text-slate-200">
          {tier.tier_name}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-700 dark:text-slate-300">
          {tier.usd_price !== null
            ? tier.usd_price === 0
              ? "—"
              : `$${tier.usd_price.toFixed(2)}`
            : "—"}
        </td>
        <td className="px-4 py-2.5 text-right">
          {tier.is_alternate ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <Tag className="h-3 w-3" />
              Alternate
            </span>
          ) : (
            <span className="text-[10px] text-slate-400 dark:text-slate-500">
              Standard
            </span>
          )}
        </td>
      </tr>
      {expanded && hasDetail && detail && (
        <tr className="bg-slate-50/70 dark:bg-slate-800/30">
          <td></td>
          <td colSpan={4} className="px-4 py-3">
            <TerritoryDetail territories={detail.territories} />
          </td>
        </tr>
      )}
    </>
  );
}

function TerritoryDetail({
  territories,
}: {
  territories: TierTerritoryDetail["territories"];
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = territories;
    if (!showAll) {
      list = list.filter((t) => TOP_MARKETS.includes(t.territory_code));
    }
    if (q) {
      list = list.filter(
        (t) =>
          t.territory_code.includes(q) || t.currency_code.includes(q),
      );
    }
    return list;
  }, [territories, query, showAll]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 dark:text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search territory or currency…"
            className="w-full pl-7 pr-2 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-[#0071E3]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowAll((v) => !v);
          }}
          className="text-[11px] text-[#0071E3] hover:underline"
        >
          {showAll
            ? `Top markets only`
            : `Show all ${territories.length}`}
        </button>
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium uppercase tracking-wide">
                Code
              </th>
              <th className="px-3 py-1.5 text-left font-medium uppercase tracking-wide">
                Currency
              </th>
              <th className="px-3 py-1.5 text-right font-medium uppercase tracking-wide">
                Customer price
              </th>
              <th className="px-3 py-1.5 text-right font-medium uppercase tracking-wide">
                Proceeds
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((t) => (
              <tr key={t.territory_code}>
                <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300">
                  {t.territory_code}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-500 dark:text-slate-400">
                  {t.currency_code}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-700 dark:text-slate-300">
                  {formatPrice(t.customer_price, t.currency_code)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-slate-500 dark:text-slate-400">
                  {formatPrice(t.proceeds, t.currency_code)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-3 text-center text-slate-400 dark:text-slate-500 italic"
                >
                  No territories match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
