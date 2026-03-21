import { TopNav } from "@/components/layout/TopNav";
import { AppSubNav } from "@/components/layout/AppSubNav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      <TopNav />
      <AppSubNav />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
