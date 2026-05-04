/**
 * Pure helper: pull unique version strings out of a ticket's
 * `type_payloads` JSONB array.
 *
 * **Production data shape** — authoritative source: the ticket-engine
 * RPC INSERT in `supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql`,
 * which is the *only* writer to `tickets.type_payloads`:
 *
 *     jsonb_build_array(jsonb_build_object(
 *       'payload', v_type_payload,
 *       'first_seen_at', to_char(...)
 *     ))
 *
 * Each array element is therefore:
 *
 *     {
 *       payload: { version: "4.4.0", platform: "iOS", ... },
 *       first_seen_at: "2026-05-01T10:22:00Z"
 *     }
 *
 * Version is nested at `p.payload.version`, **not** `p.version`. This
 * helper reads strict-nested only — there is no legacy flat shape in
 * the DB (the RPC has been the sole writer since PR-9), so a defensive
 * fallback would just add parsing noise.
 *
 * Pipeline source: classifier `type-matcher.ts` extracts named captures
 * (`version`, `platform`, `count`, `name`, `uuid`, `version_code`); the
 * RPC wraps that record in `{ payload, first_seen_at }` on insert.
 * Apple patterns reliably populate `<version>`; other platforms may
 * not — non-Apple payloads return `[]` here and the calling UI omits
 * the section entirely (`VersionsSection` in TicketDetailPanel).
 *
 * Order semantics: insertion order preserved so the last element is
 * the most recently extracted version (latest submission). The
 * detail-panel chips render that last value with a "← latest" accent.
 *
 * Defensive parsing: `payloads` is typed `unknown[]` because JSONB is
 * opaque at the TS layer. Each item is narrowed step-by-step (item is
 * an object → has `payload` field → `payload` is an object → has
 * `version` field → version is a non-empty string) and only valid
 * versions are kept.
 *
 * History: PR-17.2.5 hotfix. The original PR-17.2 helper read
 * `p.version` (top-level) — fixtures matched, production didn't,
 * VersionsSection was silently hidden on real Manager tickets. Pattern
 * 9 N-layer cascade trap: test doubles drifted from production.
 */
export function extractVersions(payloads: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of payloads) {
    if (!p || typeof p !== 'object') continue;
    const inner = (p as { payload?: unknown }).payload;
    if (!inner || typeof inner !== 'object' || !('version' in inner)) continue;
    const v = (inner as { version: unknown }).version;
    if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      ordered.push(v);
    }
  }
  return ordered;
}
