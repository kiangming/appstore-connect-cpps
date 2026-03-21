"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useAppIcon, getAvatarColor, getInitials } from "@/lib/use-app-icon";

export function AppSubNav() {
  const pathname = usePathname();
  const match = pathname.match(/^\/apps\/([^/]+)/);
  const appId = match ? match[1] : null;

  const [appName, setAppName] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setAppName(null);
      setBundleId(null);
      return;
    }
    fetch(`/api/asc/apps/${appId}`)
      .then((r) => r.json())
      .then((data) => {
        setAppName(data?.data?.attributes?.name ?? null);
        setBundleId(data?.data?.attributes?.bundleId ?? null);
      })
      .catch(() => { setAppName(null); setBundleId(null); });
  }, [appId]);

  const iconUrl = useAppIcon(bundleId);
  const [imgError, setImgError] = useState(false);

  if (!appId) return null;

  const color = appName ? getAvatarColor(appName) : "bg-slate-300";
  const initials = appName ? getInitials(appName) : "";

  return (
    <div className="h-24 bg-white border-b border-slate-200 flex items-center px-8 gap-4 flex-shrink-0">
      {/* App icon */}
      {iconUrl && !imgError ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconUrl}
          alt={appName ?? ""}
          width={60}
          height={60}
          className="w-[60px] h-[60px] rounded-[16px] object-cover shadow-sm flex-shrink-0"
          onError={() => setImgError(true)}
        />
      ) : (
        <div
          className={`w-[60px] h-[60px] rounded-[16px] flex-shrink-0 flex items-center justify-center ${color} shadow-sm`}
        >
          <span className="text-white text-[20px] font-bold tracking-tight">
            {initials}
          </span>
        </div>
      )}

      {/* App name */}
      <span className="text-[22px] font-semibold text-slate-900 tracking-tight truncate max-w-[480px]">
        {appName ?? <span className="text-slate-400">Loading…</span>}
      </span>

      {/* New CPP button */}
      <Link
        href={`/apps/${appId}/cpps/new`}
        className="ml-1 flex items-center gap-2 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[15px] font-semibold rounded-lg px-5 py-3 transition-colors flex-shrink-0"
      >
        <Plus className="h-5 w-5" strokeWidth={2.5} />
        New CPP
      </Link>
    </div>
  );
}
