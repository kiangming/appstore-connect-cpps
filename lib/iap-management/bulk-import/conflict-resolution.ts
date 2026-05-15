/**
 * Conflict resolution for bulk import (Q-IAP.8 lock — overwrite default
 * + per-item skip option). Pure logic; consumed by the wizard preview UI
 * and the execute endpoint.
 *
 * Decision rule for each parsed item, in priority order:
 *   1. Validation error → ALWAYS exclude (Manager must fix source data).
 *   2. Per-item override (Manager toggled in the preview) → applies.
 *   3. Conflict + global mode = SKIP → skip.
 *   4. Conflict + global mode = OVERWRITE → overwrite (re-push to Apple).
 *   5. No conflict → create.
 */

import type { ParsedIapItem } from "../parsers/iap-items";

export type ConflictMode = "OVERWRITE" | "SKIP";

export type Disposition = "CREATE" | "OVERWRITE" | "SKIP" | "ERROR";

export interface ConflictDecision {
  product_id: string;
  disposition: Disposition;
  reason: string;
  /** True if the productId already exists on Apple (conflict context). */
  conflict: boolean;
  /** Source row in the original parsed list (for re-index after resolution). */
  source: ParsedIapItem;
}

export interface ResolveInput {
  parsed: ParsedIapItem[];
  /** Set of productIds that already exist on Apple. */
  existing_product_ids: Set<string>;
  /** Default behaviour when a productId conflicts. */
  default_mode: ConflictMode;
  /** Per-item overrides keyed by productId. Wins over default_mode when set. */
  overrides?: Record<string, ConflictMode>;
}

export interface ResolveResult {
  decisions: ConflictDecision[];
  counts: {
    create: number;
    overwrite: number;
    skip: number;
    error: number;
  };
}

/**
 * Pre-import validators for fields that aren't fully enforced at parse time.
 * Returns a non-empty error string when invalid; null when OK.
 *
 * Hard rules: product_id charset (Apple regex), reference name length.
 * Other parse-time validations (numeric prices, locale headers) already
 * surfaced as throw from parseIapItemsXlsx.
 */
function validateRow(item: ParsedIapItem): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.product_id)) {
    return `Product ID "${item.product_id}" contains invalid characters.`;
  }
  if (item.reference_name.length > 64) {
    return `Reference name exceeds 64 chars (${item.reference_name.length}).`;
  }
  if (!Number.isFinite(item.price_usd) || item.price_usd < 0) {
    return `Price (USD) must be a non-negative number.`;
  }
  return null;
}

export function resolveConflicts(input: ResolveInput): ResolveResult {
  const overrides = input.overrides ?? {};
  const decisions: ConflictDecision[] = input.parsed.map((source) => {
    const productId = source.product_id;
    const validationError = validateRow(source);
    if (validationError) {
      return {
        product_id: productId,
        disposition: "ERROR",
        reason: validationError,
        conflict: input.existing_product_ids.has(productId),
        source,
      };
    }

    const conflict = input.existing_product_ids.has(productId);
    if (!conflict) {
      return {
        product_id: productId,
        disposition: "CREATE",
        reason: "New product — will be created on Apple.",
        conflict: false,
        source,
      };
    }

    const mode = overrides[productId] ?? input.default_mode;
    if (mode === "SKIP") {
      return {
        product_id: productId,
        disposition: "SKIP",
        reason: "Already exists on Apple — skipped per conflict policy.",
        conflict: true,
        source,
      };
    }
    return {
      product_id: productId,
      disposition: "OVERWRITE",
      reason: "Already exists on Apple — will overwrite with new data.",
      conflict: true,
      source,
    };
  });

  const counts = { create: 0, overwrite: 0, skip: 0, error: 0 };
  for (const d of decisions) {
    if (d.disposition === "CREATE") counts.create++;
    else if (d.disposition === "OVERWRITE") counts.overwrite++;
    else if (d.disposition === "SKIP") counts.skip++;
    else counts.error++;
  }

  return { decisions, counts };
}
