export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { findAllAccountsPublic } from "@/lib/asc-account-repository";

export default async function Settings() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") redirect("/");

  const accounts = await findAllAccountsPublic().catch(() => []);

  return <SettingsPage accounts={accounts} />;
}
