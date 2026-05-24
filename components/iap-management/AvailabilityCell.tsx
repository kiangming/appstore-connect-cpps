"use client";

/**
 * Hotfix 25 — Apple Availabilities lazy-load cell.
 *
 * Replaces the Cycle 39 Phase 2 server-prefetched cell render. Each row
 * mounts an `<AvailabilityCell internalIapId=… />` which:
 *
 *   1. Renders an instant "pending" skeleton.
 *   2. Mounts an IntersectionObserver with `rootMargin: 100px` so the
 *      fetch starts slightly before the row scrolls into view (Manager
 *      sees a populated cell by the time the row is centred).
 *   3. On intersection, acquires a slot from the client-fetch-queue
 *      (max 3 in flight per tab) and hits the per-IAP API route.
 *   4. Renders one of six terminal states (per kickoff Step 3):
 *
 *        pending      — skeleton placeholder before observer fires
 *        loading      — skeleton shimmer once a slot is acquired
 *        available    — green "Available" + globe icon
 *        removed      — red "Remove from Sales" + minus icon
 *        failed       — gray em-dash + "(fetch failed)" + click-to-retry
 *        rate_limited — amber em-dash + "(rate limited)" + click-to-retry
 *
 * Click-to-retry on the two terminal failure states flips back to
 * `pending` and re-triggers the IntersectionObserver code path.
 *
 * Rows without an internal UUID (unsynced Apple-only rows, prior to
 * Refresh from Apple seeding the local cache) render the gray em-dash
 * stand-in directly — no fetch, no observer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, MinusCircle, AlertTriangle } from "lucide-react";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";
import { classifyAvailability } from "@/lib/iap-management/apple/availability-classify";
import {
  acquireSlot,
  releaseSlot,
} from "@/lib/iap-management/client-fetch-queue";

export type AvailabilityCellState =
  | "pending"
  | "loading"
  | "available"
  | "removed"
  | "failed"
  | "rate_limited";

export interface AvailabilityCellProps {
  /** Internal `iap_mgmt.iaps.id` UUID. `null` for Apple-only rows that
   *  haven't been seeded locally yet — cell renders an em-dash without
   *  attempting a fetch. */
  internalIapId: string | null;
}

interface ApiResponse {
  state: AvailabilityForIap | null;
  error?: "rate_limited" | "fetch_failed" | "iap_not_found" | "not_synced";
  reason?: string;
}

export function AvailabilityCell({ internalIapId }: AvailabilityCellProps) {
  const [cellState, setCellState] = useState<AvailabilityCellState>("pending");
  const containerRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runFetch = useCallback(async () => {
    if (!internalIapId) return;
    setCellState("loading");
    await acquireSlot();
    if (!mountedRef.current) {
      releaseSlot();
      return;
    }
    try {
      const res = await fetch(
        `/api/iap-management/iaps/${internalIapId}/availability`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as ApiResponse;
      if (!mountedRef.current) return;
      if (data.error === "rate_limited") {
        setCellState("rate_limited");
        return;
      }
      if (data.error === "iap_not_found" || data.error === "not_synced") {
        // No availability is reachable for this row — render as failed
        // so Manager has a retry affordance if they Refresh from Apple
        // later, but don't pretend the cell is available.
        setCellState("failed");
        return;
      }
      if (data.error === "fetch_failed") {
        setCellState("failed");
        return;
      }
      const bucket = classifyAvailability(data.state ?? null, false);
      setCellState(bucket === "available" ? "available" : "removed");
    } catch {
      if (mountedRef.current) setCellState("failed");
    } finally {
      releaseSlot();
    }
  }, [internalIapId]);

  // IntersectionObserver — only fire fetch when the cell is in / near the
  // viewport, AND only when state is "pending". Re-attaches every time
  // cellState transitions back to "pending" (the click-to-retry path).
  useEffect(() => {
    if (!internalIapId) return;
    if (cellState !== "pending") return;
    const el = containerRef.current;
    if (!el) return;

    // Defensive — older browsers without IntersectionObserver still get
    // the cell; we fetch immediately as a fallback.
    if (typeof IntersectionObserver === "undefined") {
      void runFetch();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            void runFetch();
            break;
          }
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cellState, internalIapId, runFetch]);

  const handleRetry = () => {
    if (cellState === "failed" || cellState === "rate_limited") {
      setCellState("pending");
    }
  };

  // Apple-only rows without a seeded local UUID stay inert — em-dash,
  // no fetch, no retry.
  if (!internalIapId) {
    return (
      <span
        className="text-slate-400 text-xs"
        title="Local stub missing — click Refresh from Apple to enable this cell."
      >
        —
      </span>
    );
  }

  if (cellState === "pending" || cellState === "loading") {
    return (
      <span
        ref={containerRef}
        className="inline-flex items-center"
        aria-label="Loading availability…"
      >
        <SkeletonPill />
      </span>
    );
  }

  if (cellState === "available") {
    return (
      <span
        ref={containerRef}
        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
      >
        <Globe className="h-3 w-3" aria-hidden />
        Available
      </span>
    );
  }

  if (cellState === "removed") {
    return (
      <span
        ref={containerRef}
        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400"
      >
        <MinusCircle className="h-3 w-3" aria-hidden />
        Remove from Sales
      </span>
    );
  }

  if (cellState === "rate_limited") {
    return (
      <button
        ref={containerRef as unknown as React.RefObject<HTMLButtonElement>}
        type="button"
        onClick={handleRetry}
        className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
        title="Apple ASC rate limit hit. Click to retry."
      >
        <AlertTriangle className="h-3 w-3" aria-hidden />
        — <span className="text-[10px]">(rate limited)</span>
      </button>
    );
  }

  // failed
  return (
    <button
      ref={containerRef as unknown as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={handleRetry}
      className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 hover:underline"
      title="Apple fetch failed. Click to retry."
    >
      — <span className="text-[10px]">(fetch failed)</span>
    </button>
  );
}

function SkeletonPill() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-20 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse"
    />
  );
}
