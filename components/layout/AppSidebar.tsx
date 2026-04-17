"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";
import { Layers, Settings, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "cpp-manager",
    label: "CPP Manager",
    icon: Layers,
    href: "/apps",
  },
  // Add new tools here
];

const ICONS = ["🦊", "🐻", "🐼", "🦁", "🐯", "🦝", "🦔", "🐨", "🦦", "🦋"];

function iconForEmail(email: string): string {
  const seed = email.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return ICONS[seed % ICONS.length];
}

export function AppSidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [hovered, setHovered] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const email = session?.user?.email ?? "";
  const userIcon = email ? iconForEmail(email) : "👤";

  async function handleLogout() {
    setLoggingOut(true);
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <aside
      className="fixed left-0 top-0 h-full z-40 flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setShowUserMenu(false);
      }}
    >
      {/* Icon rail — always visible */}
      <div className="w-[56px] h-full bg-white border-r border-slate-200 flex flex-col items-center py-3 flex-shrink-0">
        {/* Logo → Hub */}
        <Link
          href="/"
          className="w-[34px] h-[34px] bg-[#0071E3] rounded-[9px] flex items-center justify-center text-white text-[15px] font-bold select-none mb-6 hover:bg-[#005fcc] transition-colors"
        >
          C
        </Link>

        {/* Tool icons */}
        <div className="flex flex-col items-center gap-1 flex-1">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.id}
                href={item.href}
                title={item.label}
                className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                  isActive
                    ? "text-[#0071E3] bg-blue-50"
                    : "text-slate-400 hover:text-slate-600 hover:bg-slate-50"
                }`}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#0071E3] rounded-r-full" />
                )}
                <item.icon className="h-[20px] w-[20px]" strokeWidth={1.8} />
              </Link>
            );
          })}
        </div>

        {/* Settings */}
        <Link
          href="/settings"
          title="Settings"
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors mb-1 ${
            pathname === "/settings"
              ? "text-[#0071E3] bg-blue-50"
              : "text-slate-400 hover:text-slate-600 hover:bg-slate-50"
          }`}
        >
          <Settings className="h-[20px] w-[20px]" strokeWidth={1.8} />
        </Link>

        {/* User avatar */}
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="w-10 h-10 rounded-lg flex items-center justify-center text-lg hover:bg-slate-50 transition-colors relative"
          title={email || "User"}
        >
          {userIcon}
        </button>
      </div>

      {/* Flyout panel — on hover */}
      {hovered && (
        <div className="w-[180px] h-full bg-white border-r border-slate-200 shadow-md flex flex-col py-3 animate-in slide-in-from-left-2 duration-150">
          {/* Logo label */}
          <div className="px-4 mb-6 flex items-center h-[34px]">
            <span className="font-semibold text-[13px] text-slate-900 tracking-tight">
              CPP Manager
            </span>
          </div>

          {/* Tool labels */}
          <div className="flex flex-col flex-1">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`flex items-center gap-3 h-10 px-4 text-[13px] transition-colors ${
                    isActive
                      ? "text-[#0071E3] font-semibold bg-blue-50"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`}
                >
                  <item.icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.8} />
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Settings label */}
          <Link
            href="/settings"
            className={`flex items-center gap-3 h-10 px-4 text-[13px] transition-colors mb-1 ${
              pathname === "/settings"
                ? "text-[#0071E3] font-semibold bg-blue-50"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            <Settings className="h-4 w-4 flex-shrink-0" strokeWidth={1.8} />
            Settings
          </Link>

          {/* User section */}
          <div className="px-4 flex items-center h-10 relative">
            <span className="text-xs text-slate-500 truncate flex-1">
              {email || "User"}
            </span>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              title="Sign out"
              className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* User dropdown — when icon rail avatar clicked (no hover) */}
      {!hovered && showUserMenu && (
        <div className="absolute left-[56px] bottom-2 w-[200px] bg-white rounded-lg shadow-lg border border-slate-200 p-2 animate-in fade-in duration-100">
          <div className="px-3 py-2 text-xs text-slate-500 truncate border-b border-slate-100 mb-1">
            {email}
          </div>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}
