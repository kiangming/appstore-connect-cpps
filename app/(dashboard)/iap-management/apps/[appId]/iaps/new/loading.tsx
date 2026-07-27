// T1-7 (perf review 2026-07-27): IAP create page skeleton — blocks on live
// Apple getApp + template/tier DB reads before paint. Form shape. Perceived only.
export default function IapNewLoading() {
  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="h-7 w-48 bg-slate-100 rounded animate-pulse" />
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-28 bg-slate-100 rounded animate-pulse" />
              <div className="h-10 w-full bg-slate-50 rounded-lg animate-pulse" />
            </div>
          ))}
          <div className="h-10 w-32 bg-slate-100 rounded-lg animate-pulse" />
        </div>
      </div>
    </div>
  );
}
