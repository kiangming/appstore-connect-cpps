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
 *
 * ─── [EXPORT-availability-filter] C5 — MIRROR-FIRST ────────────────────────
 *
 * Census M2/M3 found two defects that share one cause — nothing was ever kept:
 *
 *   • Every mount re-read Apple. 100 rows scrolled = 200 Apple requests, every
 *     visit, for an answer the tool had already bought minutes earlier.
 *   • Nothing could refresh the cell. After a Remove from Sales in this tool
 *     the column kept saying "Available" — `router.refresh()` re-renders the
 *     server tree but this component never unmounts, so the early return at
 *     `cellState !== "pending"` blocked any re-read. Only a hard reload fixed
 *     it, and a Manager watching the column had every reason to believe their
 *     removal had failed.
 *
 * So the cell now takes a `mirror` prop:
 *
 *   mirror present  → render it. No fetch, no observer. (~0 requests from the
 *                     second visit onward.)
 *   mirror absent   → the ORIGINAL path, unchanged: observer → queue → fetch.
 *                     Lazy-load is not replaced, it is what fills the mirror.
 *   mirror CHANGES  → adopt the newer answer, even mid-life. This is what makes
 *                     Refresh from Apple and Remove from Sales update the
 *                     column without a reload.
 *
 * ⚠ THE CLASSIFICATION LOGIC BELOW IS UNTOUCHED. `classifyAvailability` is
 * still the only thing that decides available-vs-removed for a fetched answer,
 * and the four terminal/error states render exactly as before. The mirror
 * supplies an answer earlier; it does not supply a different rule.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, MinusCircle, AlertTriangle } from "lucide-react";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";
import { classifyAvailability } from "@/lib/iap-management/apple/availability-classify";
import type { AvailabilityMirrorRecord } from "@/lib/iap-management/apple/availability-as-of";
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
  /**
   * C5 — what the mirror already knows about this item, from the server
   * render. `undefined`/`null` means never synced, and that is the ONLY
   * condition under which this cell reads Apple.
   *
   * ⚠ Absence is not a verdict. A cell with no mirror record fetches; it does
   * not render "Available" or "Removed" on the strength of having nothing.
   */
  mirror?: AvailabilityMirrorRecord | null;
  /**
   * C6 — called whenever this cell learns a verdict Apple confirmed, so the
   * page's "as of last sync" line and its Unknown count stay true without a
   * reload. Fired only for real answers: a rate-limited or failed cell reports
   * nothing, because nothing was learned.
   */
  onResolved?: (record: AvailabilityMirrorRecord) => void;
}

interface ApiResponse {
  state: AvailabilityForIap | null;
  error?: "rate_limited" | "fetch_failed" | "iap_not_found" | "not_synced";
  reason?: string;
  /** C2 — when the read landed in the mirror, the instant it was stamped. */
  syncedAt?: string;
}

/** The mirror verdict as this component's own state vocabulary. */
function stateFromMirror(
  record: AvailabilityMirrorRecord,
): AvailabilityCellState {
  return record.state === "AVAILABLE" ? "available" : "removed";
}

export function AvailabilityCell({
  internalIapId,
  mirror,
  onResolved,
}: AvailabilityCellProps) {
  // ⚠ Seeded from the mirror so a known item renders instantly and never
  //   mounts an observer. Unknown items start "pending" exactly as before.
  const [cellState, setCellState] = useState<AvailabilityCellState>(() =>
    mirror ? stateFromMirror(mirror) : "pending",
  );
  const containerRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef(true);
  /**
   * The vintage of whatever this cell is currently showing.
   *
   * ⚠ THIS IS WHAT FIXES M3. Without it, a cell that has already resolved can
   * never change: the observer effect returns early on any non-pending state,
   * so a fresh mirror arriving via `router.refresh()` — after Refresh from
   * Apple, or after a Remove from Sales — would be ignored and the column
   * would keep showing the pre-change answer until a hard reload.
   *
   * ⚠ And it is a comparison, not a blanket overwrite. Adopting any incoming
   * mirror unconditionally would let a server render that raced this cell's
   * own just-completed fetch push the OLDER answer back on screen.
   */
  const shownSyncedAtRef = useRef<string | null>(mirror?.syncedAt ?? null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Adopt a newer mirror answer whenever the server sends one. ───────────
  useEffect(() => {
    if (!mirror) return;
    const shown = shownSyncedAtRef.current;
    if (shown !== null && mirror.syncedAt <= shown) return;
    shownSyncedAtRef.current = mirror.syncedAt;
    setCellState(stateFromMirror(mirror));
  }, [mirror]);

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
      // ⚠ UNCHANGED — the classifier is still the only thing that turns
      //   Apple's answer into a verdict here.
      const bucket = classifyAvailability(data.state ?? null, false);
      setCellState(bucket === "available" ? "available" : "removed");
      // C6 — tell the page what we learned, so its as-of line and Unknown
      // count reflect this cell without waiting for a server round-trip.
      // `syncedAt` is absent only when the mirror write itself failed; the
      // cell still renders, and the page simply keeps counting this item as
      // unknown rather than inventing a timestamp for it.
      if (data.syncedAt) {
        shownSyncedAtRef.current = data.syncedAt;
        onResolved?.({
          state: bucket === "available" ? "AVAILABLE" : "REMOVED",
          territoryCount: data.state?.territoryCount ?? 0,
          syncedAt: data.syncedAt,
        });
      }
    } catch {
      if (mountedRef.current) setCellState("failed");
    } finally {
      releaseSlot();
    }
  }, [internalIapId, onResolved]);

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
