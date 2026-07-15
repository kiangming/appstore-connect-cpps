import { requireIapSession } from "@/lib/iap-management/auth";
import { getHubTrackingConfigPublic } from "@/lib/iap-management/hub-tracking/config";
import { HubTrackingClient } from "./HubTrackingClient";

export const dynamic = "force-dynamic";

export default async function HubTrackingSettingsPage() {
  // Mirrors settings/pricing-tiers: page is member-visible, the save form
  // renders read-only for non-admins. The actual mutation route
  // (POST /api/iap-management/hub-tracking/config) enforces requireIapAdmin
  // server-side regardless of what the client renders.
  const session = await requireIapSession();
  const isAdmin = session.user.role === "admin";
  const config = await getHubTrackingConfigPublic();

  return <HubTrackingClient initialConfig={config} isAdmin={isAdmin} />;
}
