"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher";

const ICONS = ["🦊", "🐻", "🐼", "🦁", "🐯", "🦝", "🦔", "🐨", "🦦", "🦋"];

function iconForEmail(email: string): string {
  const seed = email.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return ICONS[seed % ICONS.length];
}

function NavTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`relative flex items-center h-14 px-4 text-sm transition-colors ${
        active
          ? "text-slate-900 font-semibold"
          : "text-slate-500 font-medium hover:text-slate-800"
      }`}
    >
      {children}
      {active && (
        <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#0071E3] rounded-t-sm" />
      )}
    </Link>
  );
}

export function TopNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);

  const email = session?.user?.email ?? "";
  const icon = email ? iconForEmail(email) : null;

  async function handleLogout() {
    setLoggingOut(true);
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <nav className="h-14 bg-white border-b border-slate-200 flex items-center px-6 flex-shrink-0 z-50">
      {/* Logo */}
      <Link
        href="/apps"
        className="flex items-center gap-2 mr-6 flex-shrink-0 group"
      >
        <div className="w-[26px] h-[26px] bg-[#0071E3] rounded-[7px] flex items-center justify-center text-white text-[13px] font-bold select-none">
          C
        </div>
        <span className="font-semibold text-[15px] text-slate-900 tracking-tight">
          CPP Manager
        </span>
      </Link>

      {/* Nav tabs */}
      <div className="flex items-stretch h-14 flex-1">
        <NavTab href="/apps" active={pathname.startsWith("/apps")}>
          Apps
        </NavTab>
        <NavTab href="/settings" active={pathname === "/settings"}>
          Settings
        </NavTab>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <AccountSwitcher />

        {email && (
          <div className="flex items-center gap-2 pl-3 ml-1 border-l border-slate-200">
            <span className="text-base leading-none select-none">{icon}</span>
            <span className="text-xs text-slate-500 max-w-[160px] truncate hidden md:block">
              {email}
            </span>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              title="Sign out"
              className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
