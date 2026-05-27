/**
 * Hotfix 29 — staleness check for the Apps list auto-refresh.
 *
 * Pure helper so the threshold logic is unit-testable without
 * mounting the client component. Returns true when the cached
 * `last_synced_at` timestamp is older than `thresholdSeconds` ago,
 * or when the input is null / unparseable (defensive — never block
 * a refresh because of a malformed date).
 */
export function isStale(
  lastRefreshedAt: string | null | undefined,
  thresholdSeconds: number,
): boolean {
  if (!lastRefreshedAt) return true;
  const ts = Date.parse(lastRefreshedAt);
  if (Number.isNaN(ts)) return true;
  const ageMs = Date.now() - ts;
  return ageMs > thresholdSeconds * 1000;
}
