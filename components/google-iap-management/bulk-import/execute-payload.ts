/**
 * The bulk-import wizard's Preview → Execute hand-off, as pure functions.
 *
 * ⚠ ONE builder (KB P1). The wizard calls these to map the preview
 *   response, seed tier selections, gate Push and build the WHOLE execute
 *   request body, and the route-level pricing test
 *   (bulk-import/file-currency-invariance.test.ts) calls the SAME functions
 *   to drive the real execute route. A hand-copied payload in the test would
 *   be a twin that drifts the first time the wizard changes what it sends.
 *   The structural guard in that test fails if the wizard stops using them.
 */
import { filePriceOf } from "@/lib/google-iap-management/orchestration/file-price";
import { PRICING_RULE } from "@/lib/google-iap-management/bulk-import-contract";
import type { PreviewRefusedRow, PreviewRow, PricingSource } from "./BulkImportWizard";
import type { CustomPriceSet } from "./CustomPricesDialog";

/** Preview response rows → wizard rows. Every row starts as "create"; the
 *  Manager sets Overwrite / Skip on existing rows. */
export function previewRowsFromResponse(
  rows: ReadonlyArray<Omit<PreviewRow, "decision">>,
): PreviewRow[] {
  return rows.map((r) => ({
    ...r,
    // Defensive defaults — older clients may not carry these fields.
    tierCandidates: r.tierCandidates ?? [],
    defaultTierSelection: r.defaultTierSelection ?? null,
    tierMatchedBy: r.tierMatchedBy ?? "none",
    decision: r.exists ? "create" : "create",
  }));
}

/** Hotfix 19: every row with candidates starts on its primary tier (Q5.B).
 *  The Manager can change it via the dropdown. */
export function seedTierSelections(
  rows: ReadonlyArray<Pick<PreviewRow, "rowNumber" | "tierCandidates" | "defaultTierSelection">>,
): Record<number, string> {
  const seed: Record<number, string> = {};
  for (const r of rows) {
    if (r.tierCandidates.length >= 1) {
      const pick = r.defaultTierSelection ?? r.tierCandidates[0].identifier;
      if (pick) seed[r.rowNumber] = pick;
    }
  }
  return seed;
}

/** Rows with a saved custom set that are not set to Skip. Skip is the only
 *  deactivator — the pricing source is deliberately NOT a condition. */
export function activeCustomSkuSet(
  rows: ReadonlyArray<Pick<PreviewRow, "sku" | "decision">>,
  customPrices: Readonly<Record<string, CustomPriceSet>>,
): Set<string> {
  return new Set(rows.filter((r) => customPrices[r.sku] && r.decision !== "skip").map((r) => r.sku));
}

export function buildExecuteRows(
  previewRows: ReadonlyArray<PreviewRow>,
  state: {
    tierSelections: Readonly<Record<number, string>>;
    customPrices: Readonly<Record<string, CustomPriceSet>>;
    activeCustomSkus: ReadonlySet<string>;
  },
) {
  return previewRows.map((r) => ({
    rowNumber: r.rowNumber,
    sku: r.sku,
    // The parser's currency, verbatim — the currency written in the file's
    // price header. ⚠ Never the app's currency: the Hotfix 4 stomp to
    // appDefaultCurrency is exactly what H4 removed (the wizard test that
    // captures the real fetch body fails on any rewrite here).
    baseCurrency: r.baseCurrency,
    basePriceDecimal: r.basePriceDecimal,
    regionOverrides: r.regionOverrides,
    listings: r.listings,
    decision: r.decision,
    // Hotfix 19: explicit tier selection (null when no
    // template lookup applied). Orchestrator honours it
    // verbatim — no silent fallback. The companion fields
    // let the audit log distinguish:
    //   - single_match           (1 candidate, no choice)
    //   - default_accepted       (>1 candidates, primary kept)
    //   - manager_explicit       (>1 candidates, override)
    //   - no_candidates_auto_bootstrap (0 candidates)
    chosenTierIdentifier: state.tierSelections[r.rowNumber] ?? null,
    defaultTierIdentifier: r.defaultTierSelection,
    tierCandidateCount: r.tierCandidates.length,
    // Phase 3 — per-item custom prices. Sent when the row has a
    // saved set and is not set to Skip (activeCustomSkus encodes
    // both).
    //
    // ⚠ SCOPE — the pricing source is deliberately NOT a
    // condition here. This once read "…and the batch source is a
    // template", because custom was template-only; custom now
    // applies under ALL THREE sources, and under Google
    // Conversion it is a sparse overlay on the base price. Adding
    // a source condition back would silently stop sending
    // customs on that path — the same shape of bug as the
    // unqualified "no exception" defaultPrice comment, which
    // cost two defects last cycle. Skip is the only deactivator.
    customPrices: state.activeCustomSkus.has(r.sku)
      ? (() => {
          const set = state.customPrices[r.sku];
          return {
            entries: set.entries,
            baselineTier: set.baseline.kind === "template" ? set.baseline.identifier : null,
            editedAt: set.editedAt,
          };
        })()
      : null,
  }));
}

/** The whole execute request body. The wizard sends exactly this, with
 *  nothing added or rewritten after it (pinned by the wizard test that
 *  captures the real fetch body). */
export function buildExecuteRequestBody(args: {
  pricingSource: PricingSource | null;
  sourceFilename: string | null;
  /** Threaded to the execute route's `finally` block, which closes the Hub
   *  run with the batch's terminal status. Null when no run was opened
   *  (tracking unconfigured/disabled, start failed, or the 1s cap won) —
   *  the route treats that identically to a missing field (no-op). */
  hubRunId: string | null;
  rows: ReturnType<typeof buildExecuteRows>;
  /** H4.3 — the rows the preview refused, which the Manager confirmed
   *  leaving out. Required (not optional) so no caller can forget them: a
   *  partial import whose dropped rows never reach the server closes the
   *  Hub run SUCCESS (P5). */
  droppedRows: ReadonlyArray<PreviewRefusedRow>;
  /** H4.4 — the file's price header as the preview read it, for the import
   *  audit (informational: pricing reads each row's currency). */
  priceHeader: string | null;
}) {
  return {
    // H4.3 — the execute route refuses a request without it (a pre-H4 tab).
    pricing_rule: PRICING_RULE,
    pricingSource: args.pricingSource,
    sourceFilename: args.sourceFilename,
    hub_run_id: args.hubRunId,
    rows: args.rows,
    droppedRows: args.droppedRows.map((d) => ({ rowNumber: d.rowNumber, sku: d.sku, reason: d.reason })),
    priceHeader: args.priceHeader,
  };
}

/** Push gate (Hotfix 28): rows whose base price the file-price choke point
 *  refuses (filePriceOf — the same rules as the parser and the server). The
 *  parser already refused such rows, so this is defence in depth. Push stays
 *  disabled while this is non-empty. */
export function computePrecisionViolations(
  previewRows: ReadonlyArray<PreviewRow>,
): Array<{ rowNumber: number; sku: string; error: string }> {
  const violations: Array<{ rowNumber: number; sku: string; error: string }> = [];
  for (const row of previewRows) {
    if (row.decision === "skip") continue;
    if (!row.baseCurrency) continue;
    const r = filePriceOf({ currency: row.baseCurrency, priceDecimal: row.basePriceDecimal });
    if (!r.ok) {
      violations.push({ rowNumber: row.rowNumber, sku: row.sku, error: r.reason });
    }
  }
  return violations;
}

/** The file's GT (GT Price + GT Currency — one country per row). */
export type PreviewGt = { region: string; currency: string; priceDecimal: string };

/**
 * H4.3 — Manager Q5: what happens to a row's GT at push, for the preview
 * table. Q5 does NOT change the GT's semantics; this only SAYS them:
 *   - custom prices replace the GT, under every source (bulk-import.ts
 *     custom pre-pass);
 *   - under Google Conversion the GT is sent (no template loop);
 *   - under a template, a matched tier's entries replace ALL overrides, the
 *     GT included — even when the tier does not list the GT's country (then
 *     Google converts it); no tier ⇒ the GT is sent.
 * ⚠ Reads EXACTLY the expressions buildExecuteRows sends (the tier selection
 *   by rowNumber, the active-custom set), so the label is what the push does
 *   with the same state. It cannot know a template edited after the preview.
 * ⚠ The client knows a tier's price only for VN (TierCandidate). For another
 *   country it says "the tier's price, or Google's conversion" — never a
 *   number it does not have.
 */
export type GtPlan =
  | { kind: "none" }
  | { kind: "skip"; gt: PreviewGt }
  | { kind: "sent"; gt: PreviewGt }
  | { kind: "replaced_by_custom"; gt: PreviewGt; customEntry: { currency: string; priceDecimal: string } | null }
  | {
      kind: "replaced_by_tier";
      gt: PreviewGt;
      tier: string;
      tierEntry: { kind: "known"; currency: string; priceDecimal: string } | { kind: "absent" } | { kind: "unknown" };
    }
  | { kind: "pending_tier"; gt: PreviewGt }
  | { kind: "unknown_lookup_failed"; gt: PreviewGt };

export function gtPlanOf(
  row: Pick<PreviewRow, "rowNumber" | "sku" | "decision" | "regionOverrides" | "tierCandidates" | "tierMatchedBy">,
  state: {
    pricingSource: PricingSource | null;
    tierSelections: Readonly<Record<number, string>>;
    customPrices: Readonly<Record<string, CustomPriceSet>>;
    activeCustomSkus: ReadonlySet<string>;
  },
): GtPlan {
  const gt = row.regionOverrides[0];
  if (!gt) return { kind: "none" };
  if (row.decision === "skip") return { kind: "skip", gt };
  if (state.activeCustomSkus.has(row.sku)) {
    const e = state.customPrices[row.sku]?.entries.find((x) => x.region === gt.region);
    return { kind: "replaced_by_custom", gt, customEntry: e ? { currency: e.currency, priceDecimal: e.priceDecimal } : null };
  }
  if (state.pricingSource === "google_default") return { kind: "sent", gt };
  const tier = state.tierSelections[row.rowNumber] ?? null;
  if (tier) {
    const candidate = row.tierCandidates.find((c) => c.identifier === tier);
    let tierEntry: Extract<GtPlan, { kind: "replaced_by_tier" }>["tierEntry"] = { kind: "unknown" };
    if (gt.region === "VN" && candidate) {
      tierEntry =
        candidate.vnCurrency && candidate.vnPriceDecimal
          ? { kind: "known", currency: candidate.vnCurrency, priceDecimal: candidate.vnPriceDecimal }
          : { kind: "absent" };
    }
    return { kind: "replaced_by_tier", gt, tier, tierEntry };
  }
  if (row.tierCandidates.length > 0) return { kind: "pending_tier", gt };
  if (row.tierMatchedBy === "lookup_failed") return { kind: "unknown_lookup_failed", gt };
  return { kind: "sent", gt };
}
