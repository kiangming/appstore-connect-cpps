/**
 * X2 — the Active / Inactive filter for the item-list export.
 *
 * ─── WHERE THE TWO SIDES READ FROM, AND WHY THEY DISAGREE ──────────────────
 *
 * The dialog counts from the **mirror** (`google_iap_mgmt.iaps.status`, already
 * a prop on the page — `listIapsWithDefaultLocale`), so changing the filter
 * costs **0 Google requests**. The export route filters the **live** fetch,
 * because the file is the artifact that leaves the tool and it must be true
 * about Google at the moment it was made, not about the last Refresh.
 *
 * ⚠ THOSE TWO CAN DISAGREE, AND THE ANSWER IS TO SAY SO, NOT TO PICK ONE.
 * An item whose status changed on Play Console since the last Refresh is
 * counted one way on screen and the other way in the file. Making the dialog
 * fetch live would cost a request per filter click; making the file follow the
 * mirror would ship a file that contradicts Google. So the file follows
 * Google, and the counts are published side by side — `skipped` is what the
 * filter removed, and a mismatch against the screen is stated in words rather
 * than left for the operator to notice.
 *
 * ─── ⚠ "ACTIVE" IS THE TOOL'S WORD, AND IT COVERS TWO OF GOOGLE'S ──────────
 *
 * `mapStateToStatus` (google/onetime-product-adapter.ts:117-122) reads, verbatim:
 *
 *     if (state === "ACTIVE" || state === "INACTIVE_PUBLISHED") return "active";
 *     return "inactive";
 *
 * So a purchase option Google calls `INACTIVE_PUBLISHED` is filtered as
 * **Active** here. That is not a bug to hide behind a nicer label — it is the
 * mapping every other surface in this module already uses, and the cache
 * column (`iaps.status CHECK IN ('active','inactive')`) cannot express more.
 * What would be a defect is a control that says "Active" and lets the operator
 * believe it means Google's `ACTIVE` alone. `STATUS_FILTER_NOTE` is that
 * disclosure, kept here rather than inline in the component so there is one
 * place to change it and a test can assert it reached the screen.
 *
 * ⚠ THE FULL SET OF GOOGLE STATES IS NOT KNOWN FROM THE TYPES.
 * `googleapis@171.4.0` declares `state?: string | null` with no enum
 * (Schema$OneTimeProductPurchaseOption, "Output only"), and the adapter's own
 * docblock names `ACTIVE/INACTIVE/DRAFT/...` with an ellipsis. The two strings
 * above are the only ones this codebase acts on; anything else falls to
 * `inactive`. Do not write a list of states from memory — read the adapter.
 */

/** The tool's mirror column, `google_iap_mgmt.iaps.status`. */
export type IapStatus = "active" | "inactive";

/** `all` is the default and means "no filter" — today's behaviour exactly. */
export type ExportStatusFilter = "all" | IapStatus;

export const EXPORT_STATUS_FILTERS: readonly ExportStatusFilter[] = [
  "all",
  "active",
  "inactive",
];

/**
 * ⚠ THE DISCLOSURE THE LABEL OWES THE OPERATOR. A control reading plain
 * "Active" would be making a claim about Google's state that the tool cannot
 * keep — see the header. Rendered next to the filter; asserted by
 * `export-status-filter.test.ts` and by the dialog's own test.
 */
export const STATUS_FILTER_NOTE =
  'Google calls a purchase option ACTIVE or INACTIVE_PUBLISHED; this tool ' +
  'counts both as "Active". "Inactive" is everything else.';

export function isExportStatusFilter(v: unknown): v is ExportStatusFilter {
  return (
    typeof v === "string" &&
    (EXPORT_STATUS_FILTERS as readonly string[]).includes(v)
  );
}

/** Does one item's status survive the filter? `all` keeps everything. */
export function matchesStatusFilter(
  status: string | null | undefined,
  filter: ExportStatusFilter,
): boolean {
  if (filter === "all") return true;
  // Anything that is not exactly "active" is inactive — the same collapse the
  // adapter already performs, so the filter cannot disagree with the Status
  // column the file prints beside it.
  const normalised: IapStatus = status === "active" ? "active" : "inactive";
  return normalised === filter;
}

export interface StatusCounts {
  all: number;
  active: number;
  inactive: number;
}

/**
 * Counts for the dialog's three options, from whatever list the caller has.
 *
 * ⚠ COSTS NOTHING. On the client this is the `initialIaps` prop the page
 * already rendered; on the server it is the live array already fetched. Either
 * way no request is made to produce these numbers, which is the whole reason
 * the filter can be changed freely.
 */
export function countByStatus(
  items: readonly { status: string | null | undefined }[],
): StatusCounts {
  let active = 0;
  for (const i of items) if (i.status === "active") active += 1;
  return { all: items.length, active, inactive: items.length - active };
}

export interface StatusPartition<T> {
  included: T[];
  /** How many the filter removed. Published to the operator — never dropped
   *  silently, which is the defect class this arc keeps removing. */
  skipped: number;
}

/** Split a list by the filter, keeping the count of what was removed. */
export function partitionByStatusFilter<
  T extends { status?: string | null },
>(items: readonly T[], filter: ExportStatusFilter): StatusPartition<T> {
  const included = items.filter((i) => matchesStatusFilter(i.status, filter));
  return { included, skipped: items.length - included.length };
}

/**
 * The sentence the UI shows after an export.
 *
 * ⚠ THE DIVERGENCE LINE IS NOT OPTIONAL DECORATION. `expectedFromMirror` is
 * what the screen promised; `exported` is what Google actually had. When they
 * differ, saying nothing would leave the operator with a file that is short
 * (or long) by a row against a count they just read, with nothing anywhere
 * explaining it — the same silent-drop shape as the territory intersection
 * this arc is also removing.
 */
export function exportSummaryLine(args: {
  exported: number;
  skipped: number;
  filter: ExportStatusFilter;
  expectedFromMirror: number | null;
}): string {
  const { exported, skipped, filter, expectedFromMirror } = args;
  const plural = (n: number) => (n === 1 ? "item" : "items");
  let out = `Exported ${exported} ${plural(exported)}.`;
  if (filter !== "all") {
    out += ` ${skipped} ${plural(skipped)} skipped by the "${filter}" filter.`;
  }
  if (expectedFromMirror !== null && expectedFromMirror !== exported) {
    out +=
      ` The list on screen showed ${expectedFromMirror} — Google's live data` +
      ` differs, and the file follows Google. Refresh to update the list.`;
  }
  return out;
}
