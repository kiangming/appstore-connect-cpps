/**
 * Which localizations a Bulk Import run is allowed to touch.
 * Arc `[BULKIMPORT-loc-step]` C2 — the CHOKE POINT.
 *
 * ⚠ WHY THIS EXISTS. The import template carries EVERYTHING — price and
 * localization — because it is a faithful dump of what App Store Connect
 * already has. But a real job is usually "change one part". On 2026-09-22 the
 * Manager wanted to update PRICE only; the tool processed localizations too,
 * and 20 of 88 rows came back `409 Cannot edit InAppPurchaseLocalization when
 * it is in ACTIVE state` — rows that never needed a localization write at all.
 *
 * ⚠⚠ WHY ONE FUNCTION AND NOT EIGHT GUARDS. `item.localizations` is read in
 * EIGHT places in the execute route (`:946 · :968 · :971 · :1241 · :1249` on
 * the CREATE path, `:1393 · :1477 · :1615` on OVERWRITE). Gating each one is
 * eight chances to miss one, and a missed one fails SILENTLY — it writes.
 * Filtering ONCE, immediately after the parse, means all eight read an
 * already-filtered list and none of them changes. CLAUDE.md meta-rule P1: one
 * shared choke point, not N separate patches. Same shape as
 * `resolveBatchAvailabilitySelection`.
 *
 * ⚠ WHY IT LIVES SERVER-SIDE ON RE-PARSED DATA. The route re-parses the
 * spreadsheet itself (`route.ts`: *"Re-parse Excel server-side (don't trust the
 * client)"*), so the client never ships localization CONTENT. The Manager's
 * choice therefore has to arrive as a small SELECTION in `config` — the same
 * route `tier_overrides` and `availability_selection` already take — and be
 * applied here, to data the server produced.
 *
 * ⚠ THIS IS NOT THE "PARSE BUT IGNORE" PATTERN. `template-spec.ts` notes that
 * GT Price / GT Currency are parsed and "consumed nowhere downstream". That is
 * a SILENT drop, and silent drops are the exact bug class this arc exists to
 * kill. Everything dropped here is counted and reported.
 */
import type { ParsedIapItem } from "../parsers/iap-items";

/** Raw, untrusted `config.localization_selection` straight off the wire. */
export interface RawLocalizationSelection {
  /** "Ignore all localizations" — process price only. */
  ignore_all?: unknown;
  /** productId → the locales allowed for THAT item. */
  selected?: unknown;
}

export interface LocalizationSelectionResult {
  /** Items with `localizations` narrowed to the Manager's selection. */
  items: ParsedIapItem[];
  /** Cells (item × locale) that WILL be written. */
  kept: number;
  /** Cells present in the file that will NOT be written. */
  dropped: number;
  /**
   * Anomalies worth surfacing — never a reason to throw, always a reason to
   * say something. An empty array means "nothing surprising happened".
   */
  anomalies: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The locales explicitly allowed for one product, or `null` for "not stated". */
function allowedFor(
  selected: Record<string, unknown> | null,
  productId: string,
): ReadonlySet<string> | null {
  if (!selected || !(productId in selected)) return null;
  const raw = selected[productId];
  if (!Array.isArray(raw)) return null;
  return new Set(raw.filter((x): x is string => typeof x === "string"));
}

/**
 * Narrow every item's localizations to what the Manager selected.
 *
 * ⚠⚠ THE DEFAULT IS THE PARITY GATE. `selection` undefined — an older client,
 * or a Manager who changed nothing — returns every item's localizations
 * UNTOUCHED. That is what makes this change a no-op by default, and it is
 * asserted directly rather than left to be inferred.
 *
 * ⚠ AN ITEM THE SELECTION DOES NOT MENTION KEEPS ITS LOCALIZATIONS, AND SAYS
 * SO. The opposite default (unmentioned ⇒ drop) would turn any client/server
 * version skew into a silent mass-skip — the same failure mode as the incident,
 * pointing the other way. So the conservative branch keeps the data AND records
 * an anomaly, because a stated selection that forgot an item is genuinely odd.
 */
export function applyLocalizationSelection(
  items: ReadonlyArray<ParsedIapItem>,
  selection: RawLocalizationSelection | null | undefined,
): LocalizationSelectionResult {
  const total = items.reduce((n, it) => n + it.localizations.length, 0);

  // ── No selection at all ⇒ today's behaviour, byte for byte. ──────────────
  if (!selection || !isPlainObject(selection)) {
    return { items: items.slice(), kept: total, dropped: 0, anomalies: [] };
  }

  // ── "Ignore all" ⇒ price only. Every cell dropped, and counted. ──────────
  if (selection.ignore_all === true) {
    return {
      items: items.map((it) => ({ ...it, localizations: [] })),
      kept: 0,
      dropped: total,
      anomalies: [],
    };
  }

  const selected = isPlainObject(selection.selected) ? selection.selected : null;

  // A `selected` that is present but unreadable is NOT the same as absent —
  // absent means "no opinion", malformed means a client bug. Keep everything
  // (safe) and say so (loud).
  if (selection.selected !== undefined && selected === null) {
    return {
      items: items.slice(),
      kept: total,
      dropped: 0,
      anomalies: [
        "localization_selection.selected was not an object — ignored, every localization in the file will be processed.",
      ],
    };
  }

  if (!selected) {
    return { items: items.slice(), kept: total, dropped: 0, anomalies: [] };
  }

  const anomalies: string[] = [];
  let kept = 0;
  let dropped = 0;

  const out = items.map((it) => {
    // An item with nothing in the file is not a decision the Manager made —
    // there was never a cell to tick. Do not report it as "forgotten".
    if (it.localizations.length === 0) return it;

    const allow = allowedFor(selected, it.product_id);
    if (allow === null) {
      anomalies.push(
        `${it.product_id}: not listed in the localization selection — its ${it.localizations.length} localization(s) will be processed.`,
      );
      kept += it.localizations.length;
      return it;
    }

    const next = it.localizations.filter((l) => allow.has(l.locale));
    kept += next.length;
    dropped += it.localizations.length - next.length;
    return next.length === it.localizations.length
      ? it
      : { ...it, localizations: next };
  });

  return { items: out, kept, dropped, anomalies };
}
