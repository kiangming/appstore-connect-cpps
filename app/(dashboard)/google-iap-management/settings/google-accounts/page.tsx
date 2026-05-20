export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { GoogleAccountsClient } from "@/components/google-iap-management/settings/GoogleAccountsClient";

export default async function GoogleAccountsSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") redirect("/");

  const accounts = await listAccounts().catch(() => []);

  return <GoogleAccountsClient initialAccounts={accounts} />;
}
