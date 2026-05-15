"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ChevronLeft, Inbox } from "lucide-react";
import type {
  InAppPurchase,
  InAppPurchaseType,
} from "@/types/iap-management/apple";
import { useAppIcon, getAvatarColor, getInitials } from "@/lib/use-app-icon";

interface Props {
  appId: string;
  appName: string;
  appBundleId: string;
  iaps: InAppPurchase[];
}

const TYPE_LABEL: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "Consumable",
  NON_CONSUMABLE: "Non-Consumable",
  NON_RENEWING_SUBSCRIPTION: "Non-Renewing Sub",
};

const TYPE_BADGE: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "bg-blue-50 text-blue-700 border-blue-200",
  NON_CONSUMABLE: "bg-purple-50 text-purple-700 border-purple-200",
  NON_RENEWING_SUBSCRIPTION: "bg-orange-50 text-orange-700 border-orange-200",
};

function stateBadge(state: string): string {
  switch (state) {
    case "READY_FOR_SALE":
    case "APPROVED":
      return "bg-green-50 text-green-700 border-green-200";
    case "IN_REVIEW":
    case "WAITING_FOR_REVIEW":
    case "PENDING_APPLE_RELEASE":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "REJECTED":
    case "DEVELOPER_ACTION_NEEDED":
      return "bg-red-50 text-red-700 border-red-200";
    case "REMOVED_FROM_SALE":
    case "DEVELOPER_REMOVED_FROM_SALE":
      return "bg-slate-50 text-slate-500 border-slate-200";
    case "MISSING_METADATA":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "READY_TO_SUBMIT":
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function stateLabel(state: string): string {
  return state.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function AppHeaderIcon({ name, bundleId }: { name: string; bundleId: string }) {
  const iconUrl = useAppIcon(bundleId);
  const [imgError, setImgError] = useState(false);

  if (iconUrl && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt={name}
        width={60}
        height={60}
        className="w-[60px] h-[60px] rounded-[16px] object-cover shadow-sm flex-shrink-0"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className={`w-[60px] h-[60px] rounded-[16px] flex-shrink-0 flex items-center justify-center ${getAvatarColor(name)} shadow-sm`}
    >
      <span className="text-white text-[20px] font-bold tracking-tight">
        {getInitials(name)}
      </span>
    </div>
  );
}

export function IapListClient({ appId, appName, appBundleId, iaps }: Props) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<InAppPurchaseType | "ALL">("ALL");
  const [stateFilter, setStateFilter] = useState<string>("ALL");

  const allStates = useMemo(() => {
    const s = new Set<string>();
    for (const iap of iaps) s.add(iap.attributes.state);
    return Array.from(s).sort();
  }, [iaps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return iaps.filter((iap) => {
      if (typeFilter !== "ALL" && iap.attributes.inAppPurchaseType !== typeFilter) {
        return false;
      }
      if (stateFilter !== "ALL" && iap.attributes.state !== stateFilter) {
        return false;
      }
      if (q) {
        const productId = iap.attributes.productId.toLowerCase();
        const name = iap.attributes.name.toLowerCase();
        if (!productId.includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
  }, [iaps, query, typeFilter, stateFilter]);

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/iap-management/apps"
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition"
      >
        <ChevronLeft className="h-4 w-4" />
        All apps
      </Link>

      {/* App header */}
      <div className="flex items-center gap-4">
        <AppHeaderIcon name={appName} bundleId={appBundleId} />
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight truncate">
            {appName || "Loading…"}
          </h1>
          <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
            {appBundleId}
          </p>
        </div>
        <span className="ml-auto inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
          {iaps.length} IAP{iaps.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Product ID or Reference Name…"
            className="w-full pl-10 pr-3 py-2 rounded-lg border border-slate-200 bg-white text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as InAppPurchaseType | "ALL")}
          className="rounded-lg border border-slate-200 bg-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
        >
          <option value="ALL">All types</option>
          <option value="CONSUMABLE">Consumable</option>
          <option value="NON_CONSUMABLE">Non-Consumable</option>
          <option value="NON_RENEWING_SUBSCRIPTION">Non-Renewing Sub</option>
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
        >
          <option value="ALL">All states</option>
          {allStates.map((s) => (
            <option key={s} value={s}>
              {stateLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <Inbox className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-700">
            {iaps.length === 0 ? "No IAPs for this app." : "No matches."}
          </p>
          {iaps.length === 0 && (
            <p className="text-xs text-slate-400 mt-1">
              Use Bulk Import (coming in IAP.i) or Create IAP (coming in IAP.h)
              to populate.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-3">Product ID</th>
                <th className="px-4 py-3">Reference Name</th>
                <th className="px-4 py-3 w-36">Type</th>
                <th className="px-4 py-3 w-44">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((iap) => (
                <tr
                  key={iap.id}
                  className="hover:bg-slate-50 transition cursor-default"
                >
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                    {iap.attributes.productId}
                  </td>
                  <td className="px-4 py-2.5 text-slate-800 truncate max-w-[260px]">
                    {iap.attributes.name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${TYPE_BADGE[iap.attributes.inAppPurchaseType]}`}
                    >
                      {TYPE_LABEL[iap.attributes.inAppPurchaseType]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${stateBadge(iap.attributes.state)}`}
                    >
                      {stateLabel(iap.attributes.state)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hidden — referenced by appId in URL; placeholder marker for IAP.h */}
      <div className="text-xs text-slate-400" data-app-id={appId}>
        {/* IAP.h will add Create button here */}
      </div>
    </div>
  );
}
