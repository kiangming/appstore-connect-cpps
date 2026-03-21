"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";

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

export function AppSubNav() {
  const pathname = usePathname();
  const match = pathname.match(/^\/apps\/([^/]+)/);
  const appId = match ? match[1] : null;

  const [appName, setAppName] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setAppName(null);
      return;
    }
    fetch(`/api/asc/apps/${appId}`)
      .then((r) => r.json())
      .then((data) => setAppName(data?.data?.attributes?.name ?? null))
      .catch(() => setAppName(null));
  }, [appId]);

  if (!appId) return null;

  const color = appName ? getAvatarColor(appName) : "bg-slate-300";
  const initials = appName ? getInitials(appName) : "";

  return (
    <div className="h-12 bg-white border-b border-slate-200 flex items-center px-8 gap-3 flex-shrink-0">
      {/* App avatar */}
      <div
        className={`w-[30px] h-[30px] rounded-[8px] flex-shrink-0 flex items-center justify-center ${color} shadow-sm`}
      >
        <span className="text-white text-[11px] font-bold tracking-tight">
          {initials}
        </span>
      </div>

      {/* App name */}
      <span className="text-[15px] font-semibold text-slate-900 tracking-tight truncate max-w-[320px]">
        {appName ?? <span className="text-slate-400">Loading…</span>}
      </span>

      {/* New CPP button */}
      <Link
        href={`/apps/${appId}/cpps/new`}
        className="ml-1 flex items-center gap-1.5 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[13px] font-semibold rounded-lg px-3 py-[6px] transition-colors flex-shrink-0"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        New CPP
      </Link>
    </div>
  );
}
