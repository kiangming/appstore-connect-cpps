import { AppSidebar } from "@/components/layout/AppSidebar";
import { DashboardContent } from "./DashboardContent";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <AppSidebar />
      <div className="flex-1 flex flex-col ml-[56px]">
        <DashboardContent>
          {children}
        </DashboardContent>
      </div>
    </div>
  );
}
