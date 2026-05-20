"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { AccountSwitcher } from "./AccountSwitcher";
import { GoogleAccountSwitcher } from "@/components/google-iap-management/layout/GoogleAccountSwitcher";

export function TopNav() {
  const { data: session } = useSession();
  const pathname = usePathname() ?? "";
  const email = session?.user?.email ?? "";

  // Q-GIAP.H route-based context mutex — only one of {Apple, Google}
  // switchers is visible at a time. Google is selected when the user is
  // inside /google-iap-management/*; Apple (ASC) is the default everywhere
  // else.
  const isGoogleRoute = pathname.startsWith("/google-iap-management");

  return (
    <nav className="h-14 bg-white border-b border-slate-200 flex items-center px-6 flex-shrink-0 z-30">
      {/* Spacer — pushes right side to the end */}
      <div className="flex-1" />

      {/* Right side */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {isGoogleRoute ? <GoogleAccountSwitcher /> : <AccountSwitcher />}

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
