import { redirect } from "next/navigation";
import {
  requireGoogleIapAdmin,
  GoogleIapUnauthorizedError,
  GoogleIapForbiddenError,
} from "@/lib/google-iap-management/auth";
import { getHubTrackingConfigPublic } from "@/lib/google-iap-management/hub-tracking/config";
import { HubTrackingClient } from "./HubTrackingClient";

export const dynamic = "force-dynamic";

export default async function GoogleHubTrackingSettingsPage() {
  // Mirrors settings/google-accounts: hard redirect for non-admins (this
  // module's existing convention), rather than Apple's member-visible
  // read-only render — so the client component never needs an isAdmin flag.
  try {
    await requireGoogleIapAdmin();
  } catch (err) {
    if (err instanceof GoogleIapUnauthorizedError || err instanceof GoogleIapForbiddenError) {
      redirect("/");
    }
    throw err;
  }

  const config = await getHubTrackingConfigPublic();
  return <HubTrackingClient initialConfig={config} />;
}
