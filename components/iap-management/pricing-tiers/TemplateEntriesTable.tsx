"use client";

import { useMemo, useState } from "react";
import { Tag, ChevronRight, Search } from "lucide-react";
import type { TemplateTierDetail } from "@/lib/iap-management/queries/templates";

const TOP_MARKETS = ["USA", "VNM", "JPN", "KOR", "CHN", "GBR", "DEU", "FRA", "ESP", "IDN"];

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

/**
 * Renders a template's tier rows with expandable per-territory detail.
 * Shared between the Default-template tab and per-app template views — the
 * shape is the same (TemplateTierDetail[]).
 *
 * Sparse-template aware: tier rows with no entries render as empty (no
 * USD price, no expand chevron). Templates that fully populate every
 * (tier, territory) cell continue to render identically to the pre-IAP.p1
 * Settings page.
 */
export function TemplateEntriesTable({
  tiers,
}: {
  tiers: TemplateTierDetail[];
}) {
  if (tiers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No template entries yet.
        </p>
      </div>
    );
  }

  const standardTiers = tiers.filter((t) => !t.is_alternate);
  const alternateTiers = tiers.filter((t) => t.is_alternate);

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
          <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            <th className="px-4 py-3 w-8"></th>
            <th className="px-4 py-3 w-24">Tier ID</th>
            <th className="px-4 py-3">Tier Name</th>
            <th className="px-4 py-3 w-32 text-right">USD Price</th>
            <th className="px-4 py-3 w-28 text-right">Territories</th>
            <th className="px-4 py-3 w-24 text-right">Type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {standardTiers.map((t) => (
            <TierRow key={t.tier_id} tier={t} />
          ))}
          {alternateTiers.length > 0 && (
            <tr className="bg-slate-50 dark:bg-slate-800/50">
              <td
                colSpan={6}
                className="px-4 py-2 text-xs font-medium text-slate-500 dark:text-slate-400"
              >
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
  );
}

function TierRow({ tier }: { tier: TemplateTierDetail }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = tier.entries.length > 0;

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
        <td className="px-4 py-2.5 text-right text-xs text-slate-500 dark:text-slate-400">
          {tier.entries.length}
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
      {expanded && hasDetail && (
        <tr className="bg-slate-50/70 dark:bg-slate-800/30">
          <td></td>
          <td colSpan={5} className="px-4 py-3">
            <TerritoryDetail entries={tier.entries} />
          </td>
        </tr>
      )}
    </>
  );
}

function TerritoryDetail({
  entries,
}: {
  entries: TemplateTierDetail["entries"];
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = entries;
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
  }, [entries, query, showAll]);

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
          {showAll ? `Top markets only` : `Show all ${entries.length}`}
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
                  {t.proceeds !== null
                    ? formatPrice(t.proceeds, t.currency_code)
                    : "—"}
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
