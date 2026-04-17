export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { HubPage } from "./HubPage";

export default async function DashboardRoot() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return <HubPage />;
}
