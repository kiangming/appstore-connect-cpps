// T1-7 (perf review 2026-07-27): IAP view page has its OWN skeleton so it is
// not blanketed by the parent iaps/[iapId]/ edit skeleton. Read-only detail
// shape (panels). Perceived-latency only.
export default function IapViewLoading() {
  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-slate-100 animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-56 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-40 bg-slate-50 rounded animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-28 bg-white border border-slate-200 rounded-xl p-4 space-y-3"
            >
              <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
              <div className="h-4 w-40 bg-slate-50 rounded animate-pulse" />
              <div className="h-3 w-32 bg-slate-50 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
