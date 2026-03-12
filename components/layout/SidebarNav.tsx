"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight, ChevronLeft, Settings } from "lucide-react";

export function SidebarNav() {
  const pathname = usePathname();

  // Extract appId from /apps/[appId]/...
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

  return (
    <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
      {appId ? (
        <>
          <Link
            href="/apps"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-slate-400 hover:text-slate-600 transition-colors mb-2"
          >
            <ChevronLeft className="h-3 w-3" />
            All Apps
          </Link>

          <div className="mb-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm font-medium text-slate-700">
              <span className="text-base">📱</span>
              <span className="truncate">{appName ?? "Loading…"}</span>
            </div>

            <div className="ml-4 mt-0.5 space-y-0.5">
              <Link
                href={`/apps/${appId}/cpps`}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-sm transition-colors ${
                  pathname === `/apps/${appId}/cpps`
                    ? "bg-slate-100 text-slate-900 font-medium"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <ChevronRight className="h-3 w-3 text-slate-400" />
                CPP List
              </Link>
              <Link
                href={`/apps/${appId}/cpps/new`}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-sm transition-colors ${
                  pathname === `/apps/${appId}/cpps/new`
                    ? "bg-slate-100 text-slate-900 font-medium"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <ChevronRight className="h-3 w-3 text-slate-400" />
                New CPP
              </Link>
            </div>
          </div>
        </>
      ) : (
        <div>
          <p className="px-2 mb-1 text-xs font-medium text-slate-400 uppercase tracking-wider">
            Apps
          </p>
          <Link
            href="/apps"
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
              pathname === "/apps"
                ? "bg-slate-100 text-slate-900 font-medium"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <span className="text-base">📱</span>
            All Apps
          </Link>
        </div>
      )}

      <div className="pt-2 border-t border-slate-100 mt-2">
        <Link
          href="/settings"
          className={`flex items-center gap-2 px-2 py-2 rounded-md text-sm transition-colors ${
            pathname === "/settings"
              ? "bg-slate-100 text-slate-900 font-medium"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </nav>
  );
}
