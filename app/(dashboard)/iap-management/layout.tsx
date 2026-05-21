import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * IAP Management module layout. Q-IAP.8 lock: reuse global admin/member
 * RBAC. Any signed-in user gets in; admin-only pages (Settings — pricing
 * tiers / templates) enforce role check at the page or API level. Per
 * Hotfix 10 lock pivot, IAP CRUD / submit / bulk-import are member-
 * accessible.
 */
export default async function IapManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/login");
  }
  return (
    <>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
