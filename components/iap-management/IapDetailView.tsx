"use client";

/**
 * IAP.p2.g — composition root for the View Detail page.
 *
 * Renders, top-to-bottom:
 *   1. Top crumb + sticky action bar (Back · Refresh · View on Apple Connect · Edit)
 *   2. <IapHeaderSection>       — p2.c
 *   3. <IapPriceScheduleSection>— p2.d
 *   4. <IapLocalizationSection> — p2.e
 *   5. <IapReviewInfoSection>   — p2.f
 *
 * Each section owns its own error/empty handling — the page only manages:
 *   - the action-bar (router.refresh + Apple Connect deep link)
 *   - per-section error boundaries (a thrown render error in one section
 *     surfaces a friendly inline notice without taking down the page)
 *
 * Q-G sticky cluster: the action bar uses `sticky top-0` so Manager keeps
 * Refresh / Edit reachable as they scroll the long view.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft,
  Pencil,
  RefreshCw,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { IapHeaderSection } from "./view-detail/IapHeaderSection";
import { IapPriceScheduleSection } from "./view-detail/IapPriceScheduleSection";
import { IapLocalizationSection } from "./view-detail/IapLocalizationSection";
import { IapReviewInfoSection } from "./view-detail/IapReviewInfoSection";
import { SectionErrorBoundary } from "./view-detail/SectionErrorBoundary";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
} from "@/types/iap-management/apple";
import type { PriceScheduleView } from "@/lib/iap-management/queries/iap-detail";

interface Props {
  appAppleId: string;
  appName: string;
  internalIapId: string;
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
  priceSchedule: PriceScheduleView | null;
  priceScheduleError: string | null;
  /** Server-captured ISO timestamp for the "Real-time as of …" line. */
  fetchedAt: string;
}

/**
 * Build the Apple Connect URL for this IAP. Apple's canonical path
 * encodes the numeric appAppleId + the IAP's Apple opaque id. The link
 * opens the same page Manager would reach by drilling down through
 * App Store Connect manually.
 */
function appleConnectUrl(appAppleId: string, iapAppleId: string): string {
  return `https://appstoreconnect.apple.com/apps/${appAppleId}/inappPurchases/${iapAppleId}`;
}

export function IapDetailView({
  appAppleId,
  appName,
  internalIapId,
  iap,
  localizations,
  screenshot,
  priceSchedule,
  priceScheduleError,
  fetchedAt,
}: Props) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      router.refresh();
      toast.success("Re-fetched from Apple.");
    } finally {
      // router.refresh() resolves asynchronously; clear the spinner on
      // next paint so Manager sees the icon update.
      setTimeout(() => setRefreshing(false), 300);
    }
  }

  const editHref = `/iap-management/apps/${appAppleId}/iaps/${internalIapId}`;
  const appleHref = appleConnectUrl(appAppleId, iap.id);

  return (
    <div className="space-y-6">
      {/* Sticky action bar — Q-G top-right cluster, Q-H single Apple link. */}
      <div className="sticky top-0 z-10 -mx-8 px-8 py-3 bg-slate-50/80 backdrop-blur border-b border-slate-200 flex items-start justify-between gap-4">
        <Link
          href={`/iap-management/apps/${appAppleId}`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#0071E3] transition"
        >
          <ChevronLeft className="h-4 w-4" />
          IAPs · {appName || appAppleId}
        </Link>

        <div className="flex items-center gap-2 shrink-0">
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

          <a
            href={appleHref}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg transition"
            title="Open this IAP in App Store Connect"
          >
            View on Apple Connect
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>

          <Link
            href={editHref}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Link>
        </div>
      </div>

      <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
        {iap.attributes.name}
      </h1>

      <SectionErrorBoundary label="header">
        <IapHeaderSection iap={iap} fetchedAt={fetchedAt} />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="price schedule">
        <IapPriceScheduleSection
          priceSchedule={priceSchedule}
          priceScheduleError={priceScheduleError}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="localization">
        <IapLocalizationSection
          editBaseHref={editHref}
          localizations={localizations}
        />
      </SectionErrorBoundary>

      <SectionErrorBoundary label="review information">
        <IapReviewInfoSection
          screenshot={screenshot}
          reviewNote={iap.attributes.reviewNote ?? null}
        />
      </SectionErrorBoundary>
    </div>
  );
}
