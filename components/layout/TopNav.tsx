"use client";

import { useSession } from "next-auth/react";
import { AccountSwitcher } from "./AccountSwitcher";

export function TopNav() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";

  return (
    <nav className="h-14 bg-white border-b border-slate-200 flex items-center px-6 flex-shrink-0 z-30">
      {/* Spacer — pushes right side to the end */}
      <div className="flex-1" />

      {/* Right side */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <AccountSwitcher />

        {email && (
          <div className="flex items-center pl-3 ml-1 border-l border-slate-200">
            <span className="text-xs text-slate-500 max-w-[200px] truncate">
              {email}
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}
