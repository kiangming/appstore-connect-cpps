/**
 * [LOC-ACTIVE-state] — the state must reach the decision, and the list of
 * editable states must be an ALLOW-list.
 *
 * ⚠ WHAT WENT WRONG. On 2026-09-22 twenty rows of an 88-row import failed
 * identically with `failed: ["vi"]` and `error: null`. Apple's reason —
 * "Cannot edit InAppPurchaseLocalization when it is in ACTIVE state" — was
 * being returned on every one of them, and the tool never looked: the execute
 * route mapped Apple's response to `{ id, locale }` on the line immediately
 * before planning, dropping `state` one statement before the decision that
 * needed it.
 *
 * ⚠ WHY ALLOW-LIST IS THE LOAD-BEARING WORD. Apple's own v4.4.1 schema
 * enumerates the localization states as PREPARE_FOR_SUBMISSION /
 * WAITING_FOR_REVIEW / APPROVED / REJECTED — `ACTIVE` is NOT among them (a
 * machine scan of every enum in the document finds "ACTIVE" only under
 * `Profile.profileState` and `PhasedReleaseState`). A deny-list built from
 * that enum would have missed the exact state that caused the incident.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyLocalizationState,
  describeLocalizationState,
  PATCHABLE_LOCALIZATION_STATES,
  KNOWN_BLOCKED_LOCALIZATION_STATES,
} from "./localization-state";
import { planLocalizationSync } from "@/lib/iap-management/bulk-import/localization-sync";

describe("classifyLocalizationState — allow-list, three outcomes", () => {
  it("⚠ ACTIVE is BLOCKED — the state that caused the incident", () => {
    expect(classifyLocalizationState("ACTIVE")).toBe("BLOCKED");
  });

  it("PREPARE_FOR_SUBMISSION is PATCHABLE — the state ASC creates for editing", () => {
    expect(classifyLocalizationState("PREPARE_FOR_SUBMISSION")).toBe("PATCHABLE");
  });

  it("⚠ AN UNSEEN STATE IS `UNKNOWN`, NEVER `PATCHABLE` — this is the allow-list", () => {
    // A deny-list would answer PATCHABLE here, which is exactly how ACTIVE
    // slipped through: it was not on any list of bad states, so it read fine.
    expect(classifyLocalizationState("SOME_STATE_APPLE_ADDS_IN_2027")).toBe("UNKNOWN");
    expect(classifyLocalizationState("READY_FOR_SALE")).toBe("UNKNOWN");
  });

  it("⚠ states in Apple's enum are NOT assumed editable without evidence", () => {
    // APPROVED / REJECTED / WAITING_FOR_REVIEW appear in the v4.4.1 enum, and
    // nothing in the repo shows a successful PATCH against any of them.
    // Claiming they are editable would be inference, not measurement.
    for (const s of ["APPROVED", "REJECTED", "WAITING_FOR_REVIEW"]) {
      expect(classifyLocalizationState(s)).not.toBe("PATCHABLE");
    }
  });

  it("absent state is UNKNOWN, not PATCHABLE and not BLOCKED", () => {
    expect(classifyLocalizationState(undefined)).toBe("UNKNOWN");
    expect(classifyLocalizationState(null)).toBe("UNKNOWN");
    expect(classifyLocalizationState("")).toBe("UNKNOWN");
  });

  it("⚠ the two sets do not overlap — a state cannot be both", () => {
    for (const s of PATCHABLE_LOCALIZATION_STATES) {
      expect(KNOWN_BLOCKED_LOCALIZATION_STATES.has(s)).toBe(false);
    }
  });
});

describe("describeLocalizationState — the sentence a Manager can act on", () => {
  it("⚠ names the state AND the real remedy, not 'retry'", () => {
    const msg = describeLocalizationState("vi", "ACTIVE");
    expect(msg).toContain("vi");
    expect(msg).toContain("ACTIVE");
    // Editing a live localization needs a NEW VERSION — a retry never helps.
    expect(msg).toMatch(/new .*version/i);
    expect(msg).toMatch(/review/i);
  });

  it("does not claim certainty for a state it has never seen", () => {
    const msg = describeLocalizationState("vi", "MYSTERY_STATE");
    expect(msg).toContain("MYSTERY_STATE");
    expect(msg).toMatch(/no record|may be refused/i);
  });

  it("says so plainly when Apple reported no state at all", () => {
    expect(describeLocalizationState("vi", undefined)).toMatch(/did not report a state/i);
  });
});

describe("planLocalizationSync carries state through to the PATCH plan", () => {
  it("⚠ toPatch entries keep the state — the planner can no longer be blind", () => {
    const plan = planLocalizationSync(
      [{ id: "L1", locale: "vi", state: "ACTIVE" }],
      [{ locale: "vi", display_name: "N", description: "D" }],
    );
    expect(plan.toPatch).toHaveLength(1);
    expect(plan.toPatch[0].state).toBe("ACTIVE");
  });

  it("omits state cleanly when Apple did not report one", () => {
    const plan = planLocalizationSync(
      [{ id: "L1", locale: "vi" }],
      [{ locale: "vi", display_name: "N", description: "D" }],
    );
    expect(plan.toPatch[0].state).toBeUndefined();
  });

  it("⚠ carrying state does NOT change the plan's shape (behaviour frozen)", () => {
    // W1 is observability only. Manager has not decided whether a blocked
    // locale should be skipped — Apple's refusal is authoritative, a stale
    // local read is not. If this ever starts dropping rows from toPatch,
    // that is a behaviour change that needs its own gate.
    const plan = planLocalizationSync(
      [
        { id: "L1", locale: "vi", state: "ACTIVE" },
        { id: "L2", locale: "en-US", state: "PREPARE_FOR_SUBMISSION" },
      ],
      [
        { locale: "vi", display_name: "N", description: "D" },
        { locale: "en-US", display_name: "N", description: "D" },
      ],
    );
    expect(plan.toPatch.map((p) => p.locale).sort()).toEqual(["en-US", "vi"]);
  });
});

// ─── structural: the route must not drop the field again ───────────────────

const routeSrc = readFileSync(
  join(
    __dirname, "..", "..", "..",
    "app", "api", "iap-management", "apps", "[appId]",
    "bulk-import", "execute", "route.ts",
  ),
  "utf8",
);
const code = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("execute/route.ts stops dropping state", () => {
  it("⚠ the pre-fix two-field map is gone", () => {
    // The exact shape that caused it: `{ id: l.id, locale: l.attributes.locale }`
    // with nothing after. Its return is the regression.
    expect(code).not.toMatch(
      /\{\s*id:\s*l\.id,\s*locale:\s*l\.attributes\.locale\s*\}/,
    );
  });

  it("⚠ the map now forwards l.attributes.state", () => {
    expect(code).toMatch(/l\.attributes\.state/);
  });

  it("⚠ the failure message is built from the state, not just the locale", () => {
    expect(code).toContain("describeLocalizationState(p.locale, p.state)");
  });
});
