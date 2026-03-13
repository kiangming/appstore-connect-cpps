import { SidebarNav } from "@/components/layout/SidebarNav";
import { AccountSwitcher } from "@/components/layout/AccountSwitcher";
import { UserFooter } from "@/components/layout/UserFooter";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-slate-200">
          <span className="font-semibold text-slate-900 text-sm">CPP Manager</span>
        </div>
        <SidebarNav />
        <UserFooter />
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar with account switcher */}
        <header className="h-14 flex items-center justify-end px-6 border-b border-slate-200 bg-white flex-shrink-0">
          <AccountSwitcher />
        </header>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
