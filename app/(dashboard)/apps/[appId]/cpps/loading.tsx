// T1-7 (perf review 2026-07-27): route-scoped skeleton so the CPP list paints
// chrome + placeholders immediately instead of blanking on the live Apple
// getCpps fetch. Perceived-latency only — does not change actual speed.
export default function CppListLoading() {
  return (
    <div className="p-8">
      <div className="space-y-6">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-40 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-5 w-8 bg-slate-100 rounded-full animate-pulse" />
        </div>
        <div className="h-10 w-full max-w-md bg-slate-100 rounded-xl animate-pulse" />
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-16 border-b border-slate-100 last:border-b-0 flex items-center px-6 gap-4"
            >
              <div className="w-10 h-10 rounded-lg bg-slate-100 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-48 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 w-32 bg-slate-50 rounded animate-pulse" />
              </div>
              <div className="h-5 w-20 bg-slate-100 rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
