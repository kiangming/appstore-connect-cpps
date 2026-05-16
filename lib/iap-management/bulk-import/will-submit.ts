/**
 * Computes the "Will create + submit" count for Step 3 of the bulk-import
 * wizard (IAP.o.6c — Manager outcome bifurcation lock).
 *
 * A row contributes to the count iff ALL three conditions hold:
 *   • disposition === "CREATE" — overwrite path skips submission
 *   • Apple requires a screenshot before submit — productId must be present
 *     in the matched-screenshots set (resolved upstream by the screenshot
 *     filename matcher)
 *   • Manager explicitly opted in via the "Submit after create" checkbox
 */

export interface WillSubmitDecisionLike {
  product_id: string;
  disposition: "CREATE" | "OVERWRITE" | "SKIP" | "ERROR";
}

export function computeWillSubmitCount(
  decisions: WillSubmitDecisionLike[],
  matchedScreenshotProductIds: Set<string>,
  submitOnCreate: boolean,
): number {
  if (!submitOnCreate) return 0;
  let n = 0;
  for (const d of decisions) {
    if (d.disposition !== "CREATE") continue;
    if (!matchedScreenshotProductIds.has(d.product_id)) continue;
    n++;
  }
  return n;
}
