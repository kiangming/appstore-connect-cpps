import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { findAllAccountsPublic } from "@/lib/asc-account-repository";
import { AscAccountsManager } from "@/components/admin/AscAccountsManager";

export default async function AdminAscAccountsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") redirect("/");

  const accounts = await findAllAccountsPublic();
  return <AscAccountsManager accounts={accounts} />;
}
