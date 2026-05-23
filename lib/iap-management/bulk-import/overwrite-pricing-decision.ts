/**
 * Hotfix 23 — pure decision helper for the Bulk Import OVERWRITE
 * pricing-stage gate.
 *
 * Pre-Hotfix-23 the orchestrator only re-applied pricing when the
 * resolved tier_id differed from the locally cached row:
 *
 *   if (resolvedTier && resolvedTier !== cachedTier) { ... }
 *
 * That optimisation broke when Manager replaced a Per-App template in
 * place (v1 → v2) but the tier_id mapping for the re-imported SKU
 * stayed the same: same tier_id pre/post replace ⇒ POST skipped ⇒
 * Apple kept the v1 territory list (Manager's "10 countries" stayed
 * even after the v2 4-country template landed).
 *
 * Apple's POST /v1/inAppPurchasePriceSchedules is REPLACE-ALL per
 * §4.2 (idempotent on identical content) and `applyPricingSchedule`
 * fetches templates fresh per call (no orchestration-level cache),
 * so the safe + correct fix is to always run pricing on OVERWRITE
 * when a tier resolves. The "tier unchanged" flag is preserved
 * purely as a diagnostic surfaced in the audit log + console output.
 *
 * Exported as a pure function so the regression test covers the
 * before/after semantic without spinning up Supabase.
 */

export interface OverwritePricingDecision {
  /** Caller should call `applyPricingSchedule` when true. */
  shouldRunPricing: boolean;
  /** Diagnostic only: was the resolved tier_id identical to the
   *  cached row? Surfaced in the audit log so post-hoc queries can
   *  separate "schedule actually changed" from "schedule re-pushed
   *  but identical" cases. */
  tierUnchanged: boolean;
  /** Diagnostic only: would the pre-Hotfix-23 gate have skipped this
   *  row? Useful for one-shot audit-log scans that quantify the
   *  pre-fix silent-drift fleet. */
  preFixWouldSkip: boolean;
}

export function decideOverwritePricing(args: {
  resolvedTierId: string | null;
  cachedTierId: string | null;
}): OverwritePricingDecision {
  const { resolvedTierId, cachedTierId } = args;
  if (!resolvedTierId) {
    // No resolved tier (Manager skipped pricing for this row, or the
    // resolver failed) — nothing to push. Matches the pre-fix branch.
    return {
      shouldRunPricing: false,
      tierUnchanged: false,
      preFixWouldSkip: true,
    };
  }
  const tierUnchanged = resolvedTierId === cachedTierId;
  return {
    shouldRunPricing: true,
    tierUnchanged,
    preFixWouldSkip: tierUnchanged,
  };
}
