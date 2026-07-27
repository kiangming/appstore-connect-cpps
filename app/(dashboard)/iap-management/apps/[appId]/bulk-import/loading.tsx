// T1-7 (perf review 2026-07-27): highest-priority skeleton — the IAP bulk-
// import page is the #1-complained surface and blocks on a paginated live
// Apple listAllInAppPurchases + getApp + 5 template queries with no fallback.
// Paints the wizard chrome (stepper + first panel) immediately. Perceived only.
export default function BulkImportLoading() {
  return (
    <div className="p-8">
      <div className="space-y-6">
        <div className="h-4 w-40 bg-slate-100 rounded animate-pulse" />
        {/* Stepper */}
        <div className="flex items-center gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-slate-100 animate-pulse" />
              <div className="h-3 w-16 bg-slate-100 rounded animate-pulse" />
              {i < 3 && <div className="h-px w-8 bg-slate-100" />}
            </div>
          ))}
        </div>
        {/* Step panel */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="h-4 w-56 bg-slate-100 rounded animate-pulse" />
          <div className="h-3 w-80 bg-slate-50 rounded animate-pulse" />
          <div className="h-40 w-full bg-slate-50 rounded-lg border-2 border-dashed border-slate-200 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
