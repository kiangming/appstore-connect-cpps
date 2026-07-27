// T1-7 (perf review 2026-07-27): IAP edit page skeleton — blocks on getApp
// (live Apple) + getIapWithRelations + availability + templates before paint.
// Perceived-latency only.
export default function IapEditLoading() {
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
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-32 bg-slate-100 rounded animate-pulse" />
              <div className="h-10 w-full bg-slate-50 rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
