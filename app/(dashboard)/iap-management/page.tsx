import { redirect } from "next/navigation";

/** Root /iap-management/ — canonical landing is the apps list. */
export default function IapManagementRoot() {
  redirect("/iap-management/apps");
}
