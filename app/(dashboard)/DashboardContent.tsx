"use client";

import { usePathname } from "next/navigation";
import { TopNav } from "@/components/layout/TopNav";
import { AppSubNav } from "@/components/layout/AppSubNav";

export function DashboardContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isHub = pathname === "/";

  return (
    <>
      {!isHub && <TopNav />}
      {!isHub && <AppSubNav />}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </>
  );
}
