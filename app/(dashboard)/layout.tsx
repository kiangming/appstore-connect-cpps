import { SidebarNav } from "@/components/layout/SidebarNav";

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
      </aside>

      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
