export default function InboxLoading() {
  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto">
        {/* Header skeleton — mirrors page.tsx shape */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-slate-100 animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-24 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-56 bg-slate-50 rounded animate-pulse" />
          </div>
        </div>

        {/* Filter-bar skeleton (slot for 10.2.2) */}
        <div className="flex items-center gap-2 mb-4">
          <div className="h-9 w-64 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-9 w-28 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-9 w-28 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-9 w-28 bg-slate-100 rounded-lg animate-pulse" />
        </div>

        {/* Table skeleton */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-14 border-b border-slate-100 last:border-b-0 flex items-center px-6 gap-4"
            >
              <div className="w-24 h-3 bg-slate-100 rounded animate-pulse" />
              <div className="flex-1 h-3 bg-slate-100 rounded animate-pulse" />
              <div className="w-20 h-3 bg-slate-50 rounded animate-pulse" />
              <div className="w-16 h-5 bg-slate-100 rounded-full animate-pulse" />
              <div className="w-24 h-3 bg-slate-50 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
