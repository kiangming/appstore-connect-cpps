// T1-7 (perf review 2026-07-27): Reports/apple skeleton — the page runs a
// platform lookup + 6 parallel aggregation queries (force-dynamic, re-run on
// every date/type filter change) with no fallback. Mirrors the KPI + chart +
// two-table shape. Perceived-latency only.
export default function AppleReportsLoading() {
  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-slate-100 animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-40 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-56 bg-slate-50 rounded animate-pulse" />
          </div>
        </div>
        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
              <div className="h-6 w-16 bg-slate-50 rounded animate-pulse" />
            </div>
          ))}
        </div>
        {/* Trend chart */}
        <div className="h-64 bg-white border border-slate-200 rounded-xl animate-pulse" />
        {/* Two tables */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-48 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
