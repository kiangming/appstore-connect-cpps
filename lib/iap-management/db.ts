/**
 * Supabase client wrapper for IAP Management module.
 *
 * All DB queries from IAP Management must go through this helper, which
 * auto-applies `schema('iap_mgmt')` per CLAUDE.md invariant #9 (schema
 * isolation). Mirrors lib/store-submissions/db.ts.
 *
 * Usage (server-side only):
 *
 *   import { iapDb } from "@/lib/iap-management/db";
 *
 *   const { data, error } = await iapDb()
 *     .from("price_tiers")
 *     .select("*");
 *
 *   // Equivalent raw SQL: SELECT * FROM iap_mgmt.price_tiers
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IapMgmtClient = SupabaseClient<any, any, "iap_mgmt">;

let cachedClient: IapMgmtClient | null = null;

function getServiceClient(): IapMgmtClient {
  if (cachedClient !== null) return cachedClient;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "IAP Management requires service role (backend-only).",
    );
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "iap_mgmt" },
  }) as IapMgmtClient;

  cachedClient = client;
  return client;
}

/** SERVER-SIDE ONLY. Do not call from Client Components. */
export function iapDb(): IapMgmtClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "iapDb() must not be called from the browser. " +
        "Use Server Actions or API Routes for IAP Management DB access.",
    );
  }
  return getServiceClient();
}
