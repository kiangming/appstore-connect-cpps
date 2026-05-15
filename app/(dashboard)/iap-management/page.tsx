import { redirect } from "next/navigation";

/**
 * Root /iap-management/ — redirects to Settings until IAP.g lands the
 * apps list as the canonical landing page.
 */
export default function IapManagementRoot() {
  redirect("/iap-management/settings/pricing-tiers");
}
