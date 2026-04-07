import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { getAscAccounts } from "@/lib/asc-accounts";

function maskKeyId(keyId: string): string {
  return keyId.slice(0, 4) + "••••••";
}

function maskIssuerId(issuerId: string): string {
  if (issuerId.length < 8) return "••••••••";
  return issuerId.slice(0, 4) + "-••••-••••-••••-••••" + issuerId.slice(-8);
}

export default async function Settings() {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user?.role === "admin";
  if (!isAdmin) redirect("/");

  let maskedAccounts: { name: string; keyId: string; issuerId: string }[] = [];
  try {
    const accounts = getAscAccounts();
    maskedAccounts = accounts.map((a) => ({
      name: a.name,
      keyId: maskKeyId(a.keyId),
      issuerId: maskIssuerId(a.issuerId),
    }));
  } catch {
    // No accounts configured yet — show empty state
  }

  return <SettingsPage currentAccounts={maskedAccounts} />;
}
