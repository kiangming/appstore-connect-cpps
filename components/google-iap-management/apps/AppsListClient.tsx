"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  Search,
  Package,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react";

import type { AppRow } from "@/lib/google-iap-management/repository/apps";
import type { GoogleConsoleAccountPublic } from "@/lib/google-iap-management/repository/google-accounts";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";

interface Props {
  activeAccount: GoogleConsoleAccountPublic;
  initialApps: AppRow[];
}

const PAGE_SIZE = 20;

export function AppsListClient({ activeAccount, initialApps }: Props) {
  const router = useRouter();
  // Apps are kept in sync via router.refresh() after a successful
  // POST — the server page re-reads the cache and the new initialApps
  // arrives as a fresh render, so we read directly from props.
  const apps = initialApps;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(
    initialApps[0]?.last_synced_at ?? null,
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      `${a.display_name ?? ""} ${a.package_name}`.toLowerCase().includes(q),
    );
  }, [apps, search]);

  const meta = computePageMeta(filtered.length, page, PAGE_SIZE);
  const slice = filtered.slice(meta.startIndex, meta.endIndex);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/google-iap-management/apps/refresh", {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        apps_count?: number;
        error?: string;
      };
      if (!res.ok) {
        setRefreshError(body.error ?? `Refresh failed (HTTP ${res.status}).`);
        return;
      }
      // Server tree refresh — page.tsx re-reads the apps cache and feeds
      // initialApps back in via the props.
      router.refresh();
      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Apps</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Google Play apps reachable by{" "}
            <span className="font-mono text-emerald-700">
              {activeAccount.display_name}
            </span>
            {lastRefreshedAt && (
              <>
                {" · "}
                <span className="text-slate-400">
                  Last synced {new Date(lastRefreshedAt).toLocaleString()}
                </span>
              </>
            )}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
          {refreshing ? "Refreshing…" : "Refresh from Google"}
        </button>
      </div>

      {refreshError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{refreshError}</span>
        </div>
      )}

      {/* Search */}
      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search by name or package…"
          className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
        />
      </div>

      {apps.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <Package className="h-10 w-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-sm font-medium text-slate-700 mb-1">
            No apps cached yet
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Click &ldquo;Refresh from Google&rdquo; to populate the list from
            the Reporting API.
          </p>
        </div>
      ) : slice.length === 0 ? (
        <p className="text-sm text-slate-400 italic text-center py-6">
          No apps match &ldquo;{search}&rdquo;.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {slice.map((app) => (
            <Link
              key={app.id}
              href={`/google-iap-management/apps/${encodeURIComponent(app.package_name)}`}
              className="group bg-white border border-slate-200 rounded-xl p-4 hover:border-emerald-500 hover:shadow-sm transition"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <Package className="h-5 w-5 text-emerald-600" strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold text-slate-900 truncate">
                    {app.display_name ?? app.package_name}
                  </h2>
                  <p className="text-xs text-slate-500 font-mono truncate mt-0.5">
                    {app.package_name}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination — IAP.q.3 hide-when-≤PAGE_SIZE */}
      {filtered.length > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Showing {meta.displayStart}-{meta.displayEnd} of {filtered.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={meta.page <= 1}
              className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-default transition"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 text-xs text-slate-600">
              Page {meta.page} of {meta.totalPages}
            </span>
            <button
              onClick={() =>
                setPage((p) => Math.min(meta.totalPages, p + 1))
              }
              disabled={meta.page >= meta.totalPages}
              className="p-1.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-default transition"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
