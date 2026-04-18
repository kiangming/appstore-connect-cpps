export default function TeamLoading() {
  return (
    <div className="px-8 py-10">
      <div className="max-w-5xl">
        <div className="flex items-center justify-between mb-6">
          <div className="h-7 w-32 bg-slate-100 rounded animate-pulse" />
          <div className="h-9 w-28 bg-slate-100 rounded-lg animate-pulse" />
        </div>
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-16 border-b border-slate-100 last:border-b-0 flex items-center px-6 gap-4"
            >
              <div className="w-9 h-9 rounded-full bg-slate-100 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-40 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 w-56 bg-slate-50 rounded animate-pulse" />
              </div>
              <div className="h-5 w-16 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
