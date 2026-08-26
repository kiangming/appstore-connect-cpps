import { requireIapSession } from "@/lib/iap-management/auth";
import { KeyPoolClient } from "./KeyPoolClient";

export const dynamic = "force-dynamic";

/**
 * [POOL-key-management-UI] U2 — Settings → API Key Pool.
 *
 * ⚠ The page-level check is `requireIapSession`, matching the sibling
 * settings pages, and `isAdmin` only decides what renders. It is NOT the
 * security boundary: every `/api/iap-management/pool-keys*` route calls
 * `requireIapAdmin` itself. Client-side gating alone would be a guard on the
 * half of the system an attacker does not have to use.
 */
export default async function KeyPoolSettingsPage() {
  const session = await requireIapSession();
  return <KeyPoolClient isAdmin={session.user.role === "admin"} />;
}
