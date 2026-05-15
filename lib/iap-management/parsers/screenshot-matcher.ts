/**
 * Screenshot filename → productId matcher.
 *
 * Manager Q-IAP convention (locked answer C — robust both-forms):
 *   Bulk-import screenshots may be named EITHER:
 *     (a) literal:     `<productId>.jpg`             e.g. com.vng.example.product1.jpg
 *     (b) normalized:  `<productId-dots→underscores>.jpg`  e.g. com_vng_example_product1.jpg
 *
 * Precedence: literal match wins over normalized when both apply (literal is
 * unambiguous; normalized has theoretical collisions when productIds contain
 * underscores — Apple's productId charset permits [A-Za-z0-9_.-]).
 *
 * When normalization produces multiple candidates (extremely rare in practice
 * — only if Manager's IAP set contains productIds that differ only in
 * dot-vs-underscore separation), we return `ambiguous` and the bulk-import
 * wizard surfaces the candidates for manual disambiguation.
 */

export type ScreenshotMatchResult =
  | { kind: "matched"; productId: string; method: "literal" | "normalized" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "no-match" };

/**
 * Strip a recognised image extension. Returns the basename in lowercase-
 * preserved form (we do NOT lowercase the productId — Apple productIds are
 * case-sensitive: `com.vng.Product1` ≠ `com.vng.product1`).
 */
function stripImageExtension(filename: string): string {
  return filename.replace(/\.(jpg|jpeg|png)$/i, "");
}

export function matchScreenshotToProductId(
  filename: string,
  candidateProductIds: readonly string[],
): ScreenshotMatchResult {
  const base = stripImageExtension(filename);

  const literalMatches: string[] = [];
  const normalizedMatches: string[] = [];

  for (const pid of candidateProductIds) {
    if (base === pid) {
      literalMatches.push(pid);
      continue;
    }
    if (base === pid.replace(/\./g, "_")) {
      normalizedMatches.push(pid);
    }
  }

  if (literalMatches.length === 1) {
    return { kind: "matched", productId: literalMatches[0], method: "literal" };
  }
  if (literalMatches.length > 1) {
    return { kind: "ambiguous", candidates: literalMatches };
  }
  if (normalizedMatches.length === 1) {
    return { kind: "matched", productId: normalizedMatches[0], method: "normalized" };
  }
  if (normalizedMatches.length > 1) {
    return { kind: "ambiguous", candidates: normalizedMatches };
  }

  return { kind: "no-match" };
}
