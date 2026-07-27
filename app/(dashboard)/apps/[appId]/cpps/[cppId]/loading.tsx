// T1-7 (perf review 2026-07-27): own skeleton for the CPP detail/editor so it
// isn't blanketed by the parent cpps/ list skeleton, and paints immediately
// instead of blanking on the two sequential live Apple calls (getCpp +
// getCppVersionLocalizations). Perceived-latency only.
export default function CppDetailLoading() {
  return (
    <div className="p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-slate-100 animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-56 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-40 bg-slate-50 rounded animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-40 bg-white border border-slate-200 rounded-xl p-4 space-y-3"
            >
              <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
              <div className="h-3 w-full bg-slate-50 rounded animate-pulse" />
              <div className="h-3 w-2/3 bg-slate-50 rounded animate-pulse" />
              <div className="h-24 w-full bg-slate-50 rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
