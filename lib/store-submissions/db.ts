/**
 * Supabase client wrapper for Store Management module.
 *
 * All DB queries from Store Management must go through this helper,
 * which auto-applies schema('store_mgmt').
 *
 * WHY: isolate Store Management tables from CPP Manager's public.* schema.
 * Without this wrapper, queries would hit public.tickets (CPP) instead of
 * store_mgmt.tickets (Store Management) — silent data corruption risk.
 *
 * Usage (server-side only — Supabase service role required):
 *
 *   import { storeDb } from '@/lib/store-submissions/db';
 *
 *   const { data, error } = await storeDb()
 *     .from('tickets')
 *     .select('*')
 *     .eq('state', 'NEW');
 *
 *   // Equivalent raw SQL: SELECT * FROM store_mgmt.tickets WHERE state = 'NEW'
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client scoped to the `store_mgmt` Postgres schema.
 *
 * The supabase-js v2 generics are: `SupabaseClient<Database, SchemaNameOrClientOptions, SchemaName, ...>`.
 * When `createClient(url, key, { db: { schema: 'store_mgmt' } })` is called
 * without an explicit `Database` type, the return is
 * `SupabaseClient<any, any, 'store_mgmt', ...>` — i.e. the schema literal
 * lands in the third generic slot, not the second. We reflect that here so
 * the alias actually matches createClient's return and callers get proper
 * method typing.
 *
 * Once we generate a real `Database` type from the schema, replace `any`
 * in the first slot. See TODO.md PR-4-hotfix entry.
 */
export type StoreMgmtClient = SupabaseClient<any, any, 'store_mgmt'>;

let cachedClient: StoreMgmtClient | null = null;

function getServiceClient(): StoreMgmtClient {
  if (cachedClient !== null) return cachedClient;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. ' +
        'Store Management requires service role (backend-only).',
    );
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'store_mgmt' },
  }) as StoreMgmtClient;

  cachedClient = client;
  return client;
}

/**
 * Get Supabase client scoped to store_mgmt schema.
 *
 * SERVER-SIDE ONLY. Do not call this from Client Components.
 */
export function storeDb(): StoreMgmtClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'storeDb() must not be called from the browser. ' +
        'Use Server Actions or API Routes for Store Management DB access.',
    );
  }
  return getServiceClient();
}

/**
 * For advanced queries needing raw SQL (e.g. FOR UPDATE locks in transactions),
 * use the pg client directly with fully-qualified table names:
 *
 *   SELECT * FROM store_mgmt.tickets WHERE ... FOR UPDATE
 *
 * Supabase JS client doesn't expose transaction API directly; use postgres-js
 * or drizzle for transactions if needed. See docs/store-submissions/04-ticket-engine.md
 * section 3.2 for FOR UPDATE pattern.
 */
