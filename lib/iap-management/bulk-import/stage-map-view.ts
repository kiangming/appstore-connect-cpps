/**
 * C3 chunk B — turning a row's stage map into something a Manager reads.
 *
 * ⚠ WHY THIS IS A MODULE AND NOT JSX. Every function here answers a question
 * the badges ask — "did pricing actually happen?", "is there anything worth
 * expanding?" — and chunk A's whole point is that those answers come from the
 * MAP, never from the row's status. Keeping them pure means the rule can be
 * tested directly instead of through a rendered DOM, and means the badges
 * cannot quietly start guessing from `status` again without deleting a call.
 */
import type { RowStages, StageState } from "./row-outcome";
import { CREATE_STAGE_ORDER } from "./row-outcome";

/** Label per stage, in the order the pipeline runs them. */
const STAGE_TITLE: Record<keyof RowStages, string> = {
  create: "Create",
  localizations: "Localizations",
  pricing: "Pricing",
  screenshot: "Screenshot",
  availability: "Availability",
  submit: "Submit",
};

/**
 * How each state reads in the expanded map. ⚠ "not sent" and "failed" are
 * deliberately different words: one is safe to re-run, the other needs
 * looking at. Collapsing them is the exact distinction chunk A created
 * SKIPPED_BY_STOP to preserve.
 */
const STATE_TITLE: Record<StageState, string> = {
  OK: "ok",
  FAILED: "failed",
  SKIPPED_BY_STOP: "not sent — rate limit",
  NOT_APPLICABLE: "n/a",
};

/**
 * Does this map have anything to say beyond "everything went fine"?
 *
 * ⚠ READ THE MAP, NOT THE STATUS. This is what the results table gates the
 * expandable detail on, and deriving it from `status === "PARTIAL"` would
 * reintroduce exactly the coupling C3 removed — the status is downstream of
 * the map, so asking the map is both equivalent and honest.
 */
export function stageMapHasFindings(stages: RowStages): boolean {
  const loc = stages.localizations;
  if (loc.state !== "NOT_APPLICABLE" && loc.done < loc.total) return true;
  return CREATE_STAGE_ORDER.some((k) => {
    const st = stages[k].state;
    return st === "FAILED" || st === "SKIPPED_BY_STOP";
  });
}

/** `12/39 done · 27 not sent · 0 failed` — the denominator chunk A added. */
export function formatLocalizationCounts(
  loc: RowStages["localizations"],
): string {
  if (loc.total === 0) return "no localizations in the row";
  const parts = [`${loc.done}/${loc.total} done`];
  if (loc.skippedByStop > 0) parts.push(`${loc.skippedByStop} not sent`);
  if (loc.failed.length > 0) {
    parts.push(`${loc.failed.length} failed: ${loc.failed.join(", ")}`);
  }
  return parts.join(" · ");
}

/** The trailing note for one stage, or "" when the state says it all. */
function stageDetail(key: keyof RowStages, stages: RowStages): string {
  if (key === "localizations") {
    return formatLocalizationCounts(stages.localizations);
  }
  const st = stages[key];
  const bits: string[] = [];
  if ("outcome" in st && st.outcome) bits.push(String(st.outcome));
  if ("note" in st && st.note) bits.push(String(st.note));
  if ("error" in st && st.error) bits.push(String(st.error));
  return bits.join(" · ");
}

/**
 * The whole map as an aligned plain-text block, for `ExpandableErrorCell`'s
 * detail pane. Text rather than a bespoke component because that disclosure
 * already exists in this table, already handles its own open/close state per
 * row, and already renders monospace — a second framework for the same
 * gesture would be a new thing to keep in sync for no gain.
 */
export function formatStageMap(stages: RowStages): string {
  const width = Math.max(...CREATE_STAGE_ORDER.map((k) => STAGE_TITLE[k].length));
  return CREATE_STAGE_ORDER.map((key) => {
    const state = STATE_TITLE[stages[key].state];
    const detail = stageDetail(key, stages);
    const head = `${STAGE_TITLE[key].padEnd(width)}  ${state}`;
    return detail ? `${head}  —  ${detail}` : head;
  }).join("\n");
}

/**
 * Did pricing actually land? ⚠ The badges ask THIS instead of reading the
 * row's status, so a PARTIAL row whose price DID get set still shows its
 * price. Under-reporting a stage that succeeded is a lie of omission, and it
 * is the specific debt chunk A shipped with.
 */
export function pricingRan(stages: RowStages | undefined): boolean {
  return stages ? stages.pricing.state === "OK" : false;
}
