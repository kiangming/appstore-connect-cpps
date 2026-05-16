"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft,
  Pencil,
  RefreshCw,
  Loader2,
  Image as ImageIcon,
  Globe,
  Tag,
} from "lucide-react";
import { localeNameFromCode } from "@/lib/locale-utils";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
  InAppPurchaseType,
} from "@/types/iap-management/apple";

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
  return state
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Props {
  appAppleId: string;
  appName: string;
  internalIapId: string;
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
  /** ISO timestamp captured by the server when this snapshot was fetched —
   *  surfaces "Real-time as of …" so Manager knows the data is fresh. */
  fetchedAt: string;
  /** Local cache tier id (when present). Real-time pricing fetch is deferred
   *  per Risk F4 — local cache is sufficient for current Manager workflow. */
  cachedTierId: string | null;
}

export function IapDetailView({
  appAppleId,
  appName,
  internalIapId,
  iap,
  localizations,
  screenshot,
  fetchedAt,
  cachedTierId,
}: Props) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      router.refresh();
      toast.success("Re-fetched from Apple.");
    } finally {
      // refresh resolves asynchronously; clear the spinner on next paint.
      setTimeout(() => setRefreshing(false), 300);
    }
  }

  const screenshotPreview =
    screenshot?.attributes.imageAsset?.templateUrl &&
    screenshot.attributes.imageAsset.templateUrl
      .replace("{w}", "200")
      .replace("{h}", "200")
      .replace("{f}", "png");

  return (
    <div className="space-y-6">
      <Link
        href={`/iap-management/apps/${appAppleId}`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition"
      >
        <ChevronLeft className="h-4 w-4" />
        IAPs · {appName || appAppleId}
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight truncate">
            {iap.attributes.name}
          </h1>
          <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
            {iap.attributes.productId}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition disabled:opacity-50"
            title="Re-fetch from Apple"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh from Apple
          </button>
          <Link
            href={`/iap-management/apps/${appAppleId}/iaps/${internalIapId}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Link>
        </div>
      </div>

      {/* Real-time indicator + state row */}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium border ${TYPE_BADGE[iap.attributes.inAppPurchaseType]}`}
        >
          {TYPE_LABEL[iap.attributes.inAppPurchaseType]}
        </span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium border ${stateBadge(iap.attributes.state)}`}
        >
          {stateLabel(iap.attributes.state)}
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">
          Real-time as of{" "}
          <span className="font-medium text-slate-700">
            {new Date(fetchedAt).toLocaleString()}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Localizations */}
        <section className="md:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
            <Globe className="h-4 w-4 text-slate-500" />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Localizations · {localizations.length}
            </h2>
          </header>
          {localizations.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-400">
              No localizations on Apple. Use Edit to add display names +
              descriptions.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {localizations.map((loc) => (
                <li key={loc.id} className="px-4 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    {localeNameFromCode(loc.attributes.locale)}
                    <span className="ml-2 font-mono text-slate-400 normal-case">
                      {loc.attributes.locale}
                    </span>
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-900">
                    {loc.attributes.name}
                  </p>
                  {loc.attributes.description && (
                    <p className="mt-0.5 text-xs text-slate-600 whitespace-pre-line">
                      {loc.attributes.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Right column: screenshot + pricing */}
        <div className="space-y-4">
          <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-slate-500" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Review Screenshot
              </h2>
            </header>
            <div className="p-4">
              {screenshot ? (
                <div>
                  {screenshotPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={screenshotPreview}
                      alt={screenshot.attributes.fileName}
                      className="w-full rounded-lg border border-slate-200"
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
                      {screenshot.attributes.fileName} · uploaded
                    </div>
                  )}
                  <p className="mt-2 text-[11px] text-slate-500 truncate">
                    {screenshot.attributes.fileName}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
                  No screenshot on Apple.
                </div>
              )}
            </div>
          </section>

          <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
              <Tag className="h-4 w-4 text-slate-500" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Pricing
              </h2>
            </header>
            <div className="px-4 py-3 text-xs">
              <p className="text-slate-500">Tier (local cache):</p>
              <p className="mt-1 font-mono text-slate-700">
                {cachedTierId ?? "—"}
              </p>
              <p className="mt-2 text-[11px] text-slate-400">
                Real-time price schedule fetch is not wired yet — local
                cache is shown.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
