/**
 * C3 chunk A — what actually happened to one Bulk Import row, stage by stage.
 *
 * ⚠ WHY THIS TYPE LEFT `execute/route.ts`. It was declared there and NOT
 * exported, so `BulkImportWizard.tsx` re-declared it by hand — and the copy
 * had already drifted: it still said `status: "SUCCESS" | "ERROR" |
 * "SKIPPED"` after C2 shipped `NOT_ATTEMPTED`. Nothing failed, because
 * TypeScript happily narrows a wider server value into a narrower client type
 * across a `fetch` boundary. That is the third time this arc has met the same
 * bug ([PRICING-429] found three copies of `PricingOutcome["kind"]`), so the
 * type now lives where both sides can import it.
 */
import type { PricingOutcome } from "@/lib/iap-management/apple/pricing-orchestration";

/**
 * ⚠ FOUR STATES, AND `SKIPPED_BY_STOP` IS NOT A FAILURE.
 *
 *   OK              — the stage ran and Apple accepted it.
 *   FAILED          — the stage ran and Apple refused, or it threw.
 *   SKIPPED_BY_STOP — **nothing was sent.** The row stopped earlier (a 429
 *                     that survived retry), so this stage never executed.
 *                     Telling a Manager this failed would send them looking
 *                     for a problem that does not exist; the fix is to run
 *                     the import again, not to investigate.
 *   NOT_APPLICABLE  — there was nothing to do: no screenshot file for this
 *                     product, no tier to price, submit not requested. Also
 *                     not a failure, and must not drag the row to PARTIAL.
 */
export type StageState = "OK" | "FAILED" | "SKIPPED_BY_STOP" | "NOT_APPLICABLE";

export type ScreenshotNote =
  | "replaced"
  | "uploaded-new"
  | "no-file"
  | "delete-locked"
  | "failed";

export type SubmitOutcome = "submitted" | "deferred" | "failed";

/**
 * ⚠ NO `changed` FLAG, DELIBERATELY.
 *
 * `update-orchestration.ts`'s `UpdateIapOutcome` — the shape this ports —
 * carries `changed: boolean` per stage, because it diffs an existing IAP and
 * a stage that changed nothing is a real, distinct outcome there. On the
 * CREATE path every stage changes something by definition, so copying the
 * field would ship one that is always `true`: noise that looks like signal.
 * Meta-rule P9 is exactly this — the risk is highest where a feature LOOKS
 * like a proven pattern.
 */
export interface RowStages {
  /** Unreachable unless OK: a create failure returns ERROR before stages exist. */
  create: { state: StageState };
  /**
   * ⚠ `total` IS THE NEW FIELD THAT MAKES THE MAP READABLE. The row already
   * carried `failed_locales` — WHICH ones broke — but never the denominator,
   * so "12 of 39" could not be rendered from it. `done + failed.length +
   * skippedByStop === total` is the invariant.
   */
  localizations: {
    state: StageState;
    done: number;
    total: number;
    failed: string[];
    /** Remainder after a rate-limit break — never sent, safe to re-run. */
    skippedByStop: number;
  };
  pricing: { state: StageState; outcome?: PricingOutcome["kind"]; error?: string };
  screenshot: { state: StageState; note?: ScreenshotNote; error?: string };
  availability: { state: StageState; error?: string };
  submit: { state: StageState; outcome?: SubmitOutcome; error?: string };
}

/** Stage order on the CREATE path — pricing runs BEFORE screenshot. */
export const CREATE_STAGE_ORDER = [
  "create",
  "localizations",
  "pricing",
  "screenshot",
  "availability",
  "submit",
] as const satisfies readonly (keyof RowStages)[];

export interface RowRollUp {
  status: "SUCCESS" | "PARTIAL";
  summary: string;
}

/** Human labels for the summary sentence. */
const STAGE_LABEL: Record<keyof RowStages, string> = {
  create: "create",
  localizations: "localizations",
  pricing: "pricing",
  screenshot: "screenshot",
  availability: "availability",
  submit: "submit",
};

/**
 * Roll a stage map up into the row's status and one readable sentence.
 *
 * ⚠ THE ONLY WAY A ROW REACHES "SUCCESS" IS EVERY STAGE BEING OK OR
 * NOT_APPLICABLE. That is the whole point of C3: before this, five of the six
 * stages swallowed their errors and the row returned a hard-coded
 * `status: "SUCCESS"`, so an IAP created on Apple with no localizations, no
 * price and no screenshot reported as a clean success — the symptom KB §10.8
 * recorded under Hotfix 26 while the cause stayed put.
 *
 * ⚠ A PARTIALLY-DONE LOCALIZATION SET COUNTS AS INCOMPLETE even when no
 * single locale "failed": stopping at 12 of 39 because the budget ran out is
 * exactly the case the Manager must see.
 */
export function rollUpRowOutcome(stages: RowStages): RowRollUp {
  const incomplete: string[] = [];
  const stopped: string[] = [];

  for (const key of CREATE_STAGE_ORDER) {
    const st = stages[key];
    if (st.state === "SKIPPED_BY_STOP") {
      stopped.push(STAGE_LABEL[key]);
    } else if (st.state === "FAILED") {
      incomplete.push(STAGE_LABEL[key]);
    }
  }

  const loc = stages.localizations;
  const localesShort =
    loc.state !== "NOT_APPLICABLE" && loc.done < loc.total;

  // ⚠ The lead depends on what the row DID. An OVERWRITE row was not
  // created — saying so would be a small lie in the one line a Manager reads.
  const lead = stages.create.state === "OK" ? "Created on Apple" : "Updated on Apple";

  if (incomplete.length === 0 && stopped.length === 0 && !localesShort) {
    return { status: "SUCCESS", summary: `${lead} · all stages OK` };
  }

  // ⚠ The sentence is assembled from the map, never from a status. It has to
  // survive a Manager reading only this line — [Q-C3.partial]'s requirement.
  const parts = [lead];
  if (loc.total > 0) {
    parts.push(
      loc.done === loc.total
        ? `all ${loc.total} locales`
        : `${loc.done}/${loc.total} locales`,
    );
  }
  if (incomplete.length > 0) parts.push(`missing ${incomplete.join(", ")}`);
  if (stopped.length > 0) {
    parts.push(`stopped by rate limit before ${stopped.join(", ")}`);
  }
  return { status: "PARTIAL", summary: parts.join(" · ") };
}
