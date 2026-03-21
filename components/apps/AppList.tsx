"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { App } from "@/types/asc";

const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-pink-500",
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function AppIcon({ name, bundleId }: { name: string; bundleId: string }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    fetch(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=vn`
    )
      .then((r) => r.json())
      .then((data) => {
        const url = data.results?.[0]?.artworkUrl512 ?? null;
        setIconUrl(url);
      })
      .catch(() => {});
  }, [bundleId]);

  if (iconUrl && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt={name}
        width={52}
        height={52}
        className="w-[52px] h-[52px] rounded-[12px] object-cover shadow-sm flex-shrink-0"
        onError={() => setImgError(true)}
      />
    );
  }

  const color = getAvatarColor(name);
  const initials = getInitials(name);

  return (
    <div
      className={`w-[52px] h-[52px] rounded-[12px] flex-shrink-0 flex items-center justify-center ${color} shadow-sm`}
    >
      <span className="text-white text-[17px] font-semibold tracking-tight">
        {initials}
      </span>
    </div>
  );
}

function AppCard({ app }: { app: App }) {
  return (
    <Link
      href={`/apps/${app.id}/cpps`}
      className="group flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-5 hover:border-[#0071E3] hover:shadow-md hover:scale-[1.01] transition-all duration-150"
    >
      <AppIcon name={app.attributes.name} bundleId={app.attributes.bundleId} />
      <div className="w-full text-center min-w-0">
        <p className="text-[15px] font-semibold text-slate-900 truncate">
          {app.attributes.name}
        </p>
        <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
          {app.attributes.bundleId}
        </p>
      </div>
      <span className="text-xs text-[#0071E3] font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        View CPPs →
      </span>
    </Link>
  );
}

export default function AppList({ apps }: { apps: App[] }) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? apps.filter(
        (app) =>
          app.attributes.bundleId.toLowerCase().includes(query.toLowerCase()) ||
          app.attributes.name.toLowerCase().includes(query.toLowerCase())
      )
    : apps;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <h1 className="text-2xl font-bold text-slate-900">Your Apps</h1>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
          {apps.length}
        </span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="search"
          placeholder="Search by name or bundle ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-white pl-9 pr-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0071E3] focus:border-transparent transition shadow-sm"
        />
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <span className="text-5xl mb-4">📭</span>
          <p className="text-sm font-medium text-slate-600">No apps found</p>
          {query && (
            <p className="text-xs text-slate-400 mt-1">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
