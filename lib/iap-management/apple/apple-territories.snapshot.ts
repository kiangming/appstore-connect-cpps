/**
 * Apple's territory list — A SNAPSHOT, not a live read.
 *
 * ─── WHAT THIS IS ──────────────────────────────────────────────────────────
 *
 *   MEASURED   2026-08-27, `GET /v1/territories?limit=200`, 175 territories.
 *   REFRESH    ASC_KEY_ID=… ASC_ISSUER_ID=… \
 *                ASC_PRIVATE_KEY="$(cat AuthKey_XXXX.p8)" \
 *                node scripts/probe-export-price-sources.mjs
 *              Step 2.6 prints the live list and DIFFS it against this file.
 *
 * ⚠ THIS IS A PHOTOGRAPH. Apple changes which territories it sells to — it
 * has done so before and will again. Nothing in this repo makes that change
 * appear here; a human runs the probe and edits this array. Treat every code
 * below as "true on 2026-08-27", never as "true".
 *
 * ─── WHY A SNAPSHOT AND NOT A LIVE READ ────────────────────────────────────
 *
 * The export needs this list to answer "all countries" (`[Q-EXPORT.union-
 * columns]`): the columns are the UNION of the territory catalog and Apple's
 * list, so that a country is never silently dropped by either side. Reading
 * `/v1/territories` per export would add a request to the one route whose
 * whole constraint is Apple's hourly budget, and would make the file's shape
 * depend on a network call that can fail — turning a column layout into
 * something that varies with Apple's uptime.
 *
 * ⚠ AND A SNAPSHOT THAT NOBODY CHECKS IS A LIE WITH A DATE ON IT. Two
 * detectors exist, on purpose, because they fail in opposite directions:
 *
 *   (a) THE PROBE DIFF — complete, but only runs when a human remembers.
 *       Sees additions AND removals, because it compares whole lists.
 *
 *   (b) THE RUNTIME WARNING — automatic, but partial. `unknownAppleTerritories`
 *       is called on every export with the codes Apple actually returned, and
 *       logs the ones this file does not know. It cannot see a REMOVAL (a
 *       territory Apple dropped simply stops appearing, which is
 *       indistinguishable from an item not being sold there) — but an
 *       ADDITION is the case that costs the Manager a missing column, and it
 *       catches that with nobody remembering anything.
 *
 * Neither alone is enough: (a) is complete and forgettable, (b) is automatic
 * and half-blind. Cost of (b) is one Set lookup per price row and a log line
 * that is silent in the normal case.
 *
 * ⚠ THE WARNING NEVER BLOCKS AN EXPORT. An unknown territory still gets its
 * price and its column — `buildExportPlan` unions the codes it actually saw
 * on top of the expansion, so a market Apple added yesterday still exports
 * today. The log is how we learn to refresh the file, not a gate.
 */

/**
 * Apple's alpha-3 territory codes. ⚠ ALPHA-3 — Apple's own alphabet. The
 * export speaks alpha-2 and converts at the boundary via `territory-code-map`
 * (which is also the only thing that knows Kosovo is `XKS` here and `XK`
 * everywhere else). A fixture that mixed the two alphabets already cost this
 * arc a debugging round: the codes looked plausible and only the COUNT was
 * wrong.
 */
export const APPLE_TERRITORIES_ALPHA3: readonly string[] = [
  "AFG", "AGO", "AIA", "ALB", "ARE", "ARG", "ARM", "ATG", "AUS", "AUT",
  "AZE", "BEL", "BEN", "BFA", "BGR", "BHR", "BHS", "BIH", "BLR", "BLZ",
  "BMU", "BOL", "BRA", "BRB", "BRN", "BTN", "BWA", "CAN", "CHE", "CHL",
  "CHN", "CIV", "CMR", "COD", "COG", "COL", "CPV", "CRI", "CYM", "CYP",
  "CZE", "DEU", "DMA", "DNK", "DOM", "DZA", "ECU", "EGY", "ESP", "EST",
  "FIN", "FJI", "FRA", "FSM", "GAB", "GBR", "GEO", "GHA", "GMB", "GNB",
  "GRC", "GRD", "GTM", "GUY", "HKG", "HND", "HRV", "HUN", "IDN", "IND",
  "IRL", "IRQ", "ISL", "ISR", "ITA", "JAM", "JOR", "JPN", "KAZ", "KEN",
  "KGZ", "KHM", "KNA", "KOR", "KWT", "LAO", "LBN", "LBR", "LBY", "LCA",
  "LKA", "LTU", "LUX", "LVA", "MAC", "MAR", "MDA", "MDG", "MDV", "MEX",
  "MKD", "MLI", "MLT", "MMR", "MNE", "MNG", "MOZ", "MRT", "MSR", "MUS",
  "MWI", "MYS", "NAM", "NER", "NGA", "NIC", "NLD", "NOR", "NPL", "NRU",
  "NZL", "OMN", "PAK", "PAN", "PER", "PHL", "PLW", "PNG", "POL", "PRT",
  "PRY", "QAT", "ROU", "RUS", "RWA", "SAU", "SEN", "SGP", "SLB", "SLE",
  "SLV", "SRB", "STP", "SUR", "SVK", "SVN", "SWE", "SWZ", "SYC", "TCA",
  "TCD", "THA", "TJK", "TKM", "TON", "TTO", "TUN", "TUR", "TWN", "TZA",
  "UGA", "UKR", "URY", "USA", "UZB", "VCT", "VEN", "VGB", "VNM", "VUT",
  "XKS", "YEM", "ZAF", "ZMB", "ZWE",
]

/** Fast membership for the runtime detector. Built once at module load. */
const APPLE_SET: ReadonlySet<string> = new Set(APPLE_TERRITORIES_ALPHA3);

/**
 * Detector (b) — Apple alpha-3 codes this snapshot does not know about.
 *
 * ⚠ PURE, and deduped, so the caller decides whether to log and the test can
 * assert without capturing console. Returns `[]` in the normal case, which is
 * the case that must stay free.
 *
 * ⚠ ADDITIONS ONLY, by construction. It is handed the codes Apple returned,
 * so a territory Apple REMOVED cannot appear in the input and cannot be
 * detected here — that is detector (a)'s job. Stated rather than left for
 * someone to discover the day a removal slips through.
 */
export function unknownAppleTerritories(
  observed: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const code of observed) {
    if (!APPLE_SET.has(code)) out.add(code);
  }
  return [...out].sort();
}
