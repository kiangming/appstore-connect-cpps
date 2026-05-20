import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { readActiveAccountId } from "@/lib/google-iap-management/active-account";
import { GoogleAccountProvider } from "@/components/google-iap-management/layout/GoogleAccountContext";

export default async function GoogleIapManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const accounts = await listAccounts().catch(() => []);
  const cookieActiveId = readActiveAccountId();
  // Default to the first verified account, falling back to first account
  // overall if none have been verified yet. Stays null when accounts is [].
  const fallbackId =
    accounts.find((a) => a.status === "verified")?.id ?? accounts[0]?.id ?? null;
  const activeAccountId =
    cookieActiveId && accounts.some((a) => a.id === cookieActiveId)
      ? cookieActiveId
      : fallbackId;

  return (
    <GoogleAccountProvider
      accounts={accounts}
      activeAccountId={activeAccountId}
    >
      {children}
    </GoogleAccountProvider>
  );
}
