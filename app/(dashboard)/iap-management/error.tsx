"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

/**
 * IAP.o.10b — Module-level error boundary. Catches unhandled exceptions
 * thrown by server components (e.g. Apple fetch failures that escape
 * page-level try/catch, Supabase errors during /view rendering) and
 * surfaces a friendly inline error instead of a blank 500 page.
 *
 * The silent-fail pattern Manager reported across IAP.o.8c–IAP.o.9c was
 * partly this: an unhandled server exception rendered as a blank page
 * with no diagnostic context. This boundary changes that so the failure
 * mode is visible — error.message is shown, "try again" reloads, and the
 * back link returns to a known-good page.
 */
export default function IapManagementError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[iap-management] route error:", error);
  }, [error]);

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-red-600" />
          <h2 className="text-base font-semibold text-red-900">
            Something broke on this page
          </h2>
        </div>
        <p className="text-sm text-red-700 mb-3">
          An unexpected error occurred while loading this view. The IAP data
          itself is unaffected — only this page failed to render.
        </p>
        {error.message ? (
          <pre className="text-[11px] font-mono bg-white border border-red-200 rounded px-3 py-2 text-red-900 overflow-x-auto">
            {error.message}
          </pre>
        ) : null}
        {error.digest ? (
          <p className="text-[11px] text-red-600 mt-2">
            Reference: {error.digest}
          </p>
        ) : null}
        <div className="flex items-center gap-3 mt-4">
          <button
            type="button"
            onClick={reset}
            className="px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-md transition"
          >
            Try again
          </button>
          <Link
            href="/iap-management"
            className="text-sm font-medium text-red-700 hover:underline"
          >
            Back to IAP Management
          </Link>
        </div>
      </div>
    </div>
  );
}
