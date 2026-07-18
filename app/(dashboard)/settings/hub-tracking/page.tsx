export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getHubTrackingConfigPublic } from "@/lib/cpp-hub-tracking/config";
import { HubTrackingClient } from "./HubTrackingClient";

export default async function HubTrackingSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") redirect("/");

  const config = await getHubTrackingConfigPublic();

  return <HubTrackingClient initialConfig={config} />;
}
