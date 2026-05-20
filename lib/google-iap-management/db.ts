/**
 * Supabase client wrapper for Google IAP Management module.
 *
 * All DB queries from Google IAP Management must go through this helper, which
 * auto-applies `schema('google_iap_mgmt')` per CLAUDE.md invariant #9 (schema
 * isolation). Mirrors lib/iap-management/db.ts and lib/store-submissions/db.ts.
 *
 * Usage (server-side only):
 *
 *   import { googleIapDb } from "@/lib/google-iap-management/db";
 *
 *   const { data, error } = await googleIapDb()
 *     .from("apps")
 *     .select("*");
 *
 *   // Equivalent raw SQL: SELECT * FROM google_iap_mgmt.apps
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GoogleIapMgmtClient = SupabaseClient<any, any, "google_iap_mgmt">;

let cachedClient: GoogleIapMgmtClient | null = null;

function getServiceClient(): GoogleIapMgmtClient {
  if (cachedClient !== null) return cachedClient;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Google IAP Management requires service role (backend-only).",
    );
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "google_iap_mgmt" },
  }) as GoogleIapMgmtClient;

  cachedClient = client;
  return client;
}

/** SERVER-SIDE ONLY. Do not call from Client Components. */
export function googleIapDb(): GoogleIapMgmtClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "googleIapDb() must not be called from the browser. " +
        "Use Server Actions or API Routes for Google IAP Management DB access.",
    );
  }
  return getServiceClient();
}
