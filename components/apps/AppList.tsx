"use client";

import { useState } from "react";
import Link from "next/link";
import type { App } from "@/types/asc";

export default function AppList({ apps }: { apps: App[] }) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? apps.filter((app) =>
        app.attributes.bundleId.toLowerCase().includes(query.toLowerCase()) ||
        app.attributes.name.toLowerCase().includes(query.toLowerCase())
      )
    : apps;

  return (
    <div className="space-y-4">
      <input
        type="search"
        placeholder="Search by name or bundle ID…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition"
      />

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">No apps match &ldquo;{query}&rdquo;.</p>
      )}

      <div className="space-y-2">
        {filtered.map((app) => (
          <Link
            key={app.id}
            href={`/apps/${app.id}/cpps`}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:border-[#0071E3] hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">📱</span>
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {app.attributes.name}
                </p>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  {app.attributes.bundleId}
                </p>
              </div>
            </div>
            <span className="text-xs text-[#0071E3] font-medium">
              View CPPs →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
