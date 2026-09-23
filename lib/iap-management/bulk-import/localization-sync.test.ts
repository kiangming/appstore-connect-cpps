/**
 * Problem 3b — localization delta planner.
 *
 * Replaces the broken delete-all-then-recreate strategy (which hit Apple's
 * "Cannot delete last localization" and left stale content). Proves:
 *  - locales present in BOTH are PATCHed, never deleted,
 *  - the last localization is never deleted (deletions suppressed when the
 *    desired set is empty),
 *  - genuine removals are deleted when others remain,
 *  - new locales are created.
 */
import { describe, it, expect } from "vitest";
import {
  planLocalizationSync,
  type ExistingLocalization,
  type DesiredLocalization,
} from "./localization-sync";

const ex = (id: string, locale: string): ExistingLocalization => ({ id, locale });
const want = (locale: string, n = `${locale} name`, d = `${locale} desc`): DesiredLocalization => ({
  locale,
  display_name: n,
  description: d,
});

/**
 * `[LOCSYNC-duplicate-locale]` — two rows, one locale.
 *
 * ⚠ BOTH ORDERS ARE TESTED, AND THAT IS THE ENTIRE POINT. Apple promises no
 * ordering, so a test that pins only one order would pass for the wrong
 * reason — it would still pass against a planner that simply takes the first
 * row, or one that simply takes the last. The pair together says: the choice
 * is made from `state`, NOT from position.
 *
 * ⚠ ON WHAT IS AND IS NOT MEASURED: the two-row SHAPE is observed (ASC, KB
 * §28.6/§28.7). Whether Apple's LIST returns both rows, and in which order, is
 * NOT measured anywhere in this repo (KB §28.11.b). These tests therefore pin
 * a DECISION RULE, not a reproduction of a seen failure.
 */
describe("planLocalizationSync — duplicate locale (live row + draft row)", () => {
  const live = (id: string, locale: string): ExistingLocalization => ({
    id,
    locale,
    // Apple's word for the live row, quoted back at us in the 409 that started
    // all this. NOT in Apple's published enum — see KB §28.1.
    state: "ACTIVE",
  });
  const draft = (id: string, locale: string): ExistingLocalization => ({
    id,
    locale,
    state: "PREPARE_FOR_SUBMISSION",
  });

  it("picks the DRAFT row when the live row is listed LAST", () => {
    const plan = planLocalizationSync(
      [draft("draft-vi", "vi"), live("live-vi", "vi")],
      [want("vi")],
    );
    expect(plan.toPatch).toHaveLength(1);
    expect(plan.toPatch[0].id).toBe("draft-vi");
    expect(plan.toPatch[0].state).toBe("PREPARE_FOR_SUBMISSION");
  });

  it("picks the DRAFT row when the live row is listed FIRST", () => {
    const plan = planLocalizationSync(
      [live("live-vi", "vi"), draft("draft-vi", "vi")],
      [want("vi")],
    );
    expect(plan.toPatch).toHaveLength(1);
    expect(plan.toPatch[0].id).toBe("draft-vi");
  });

  it("emits ONE patch for a duplicated locale, not one per row", () => {
    const plan = planLocalizationSync(
      [live("live-vi", "vi"), draft("draft-vi", "vi")],
      [want("vi")],
    );
    expect(plan.toPatch.filter((pp) => pp.locale === "vi")).toHaveLength(1);
    expect(plan.toCreate).toEqual([]);
  });

  it("when NO row is patchable it still attempts one — Apple's refusal is the authority, not a local read", () => {
    const plan = planLocalizationSync(
      [live("live-a", "vi"), live("live-b", "vi")],
      [want("vi")],
    );
    expect(plan.toPatch).toHaveLength(1);
    // The attempt goes out and carries the state, so the failure can say WHY
    // (`describeLocalizationState`) instead of just "failed: [vi]".
    expect(plan.toPatch[0].state).toBe("ACTIVE");
  });

  it("a row with NO state does not outrank an explicitly patchable one", () => {
    const stateless: ExistingLocalization = { id: "unknown-vi", locale: "vi" };
    const plan = planLocalizationSync(
      [stateless, draft("draft-vi", "vi")],
      [want("vi")],
    );
    expect(plan.toPatch[0].id).toBe("draft-vi");
  });
});

describe("planLocalizationSync", () => {
  it("PATCHes locales present in both old and new — never deletes them", () => {
    const plan = planLocalizationSync(
      [ex("e1", "en-US"), ex("e2", "zh-Hans")],
      [want("en-US"), want("zh-Hans")],
    );
    expect(plan.toPatch.map((p) => p.locale).sort()).toEqual(["en-US", "zh-Hans"]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.deletionsSuppressed).toBe(false);
    // PATCH carries the existing Apple id + the new content.
    const zh = plan.toPatch.find((p) => p.locale === "zh-Hans")!;
    expect(zh.id).toBe("e2");
    expect(zh.name).toBe("zh-Hans name");
    expect(zh.description).toBe("zh-Hans desc");
  });

  it("the zh-Hans-only case (the reported bug) PATCHes, never deletes the last localization", () => {
    const plan = planLocalizationSync([ex("e1", "zh-Hans")], [want("zh-Hans")]);
    expect(plan.toPatch.map((p) => p.locale)).toEqual(["zh-Hans"]);
    expect(plan.toDelete).toEqual([]);
  });

  it("POSTs locales that are new", () => {
    const plan = planLocalizationSync([ex("e1", "en-US")], [want("en-US"), want("fr-FR")]);
    expect(plan.toPatch.map((p) => p.locale)).toEqual(["en-US"]);
    expect(plan.toCreate.map((c) => c.locale)).toEqual(["fr-FR"]);
    expect(plan.toDelete).toEqual([]);
  });

  it("DELETEs genuinely-removed locales when others remain", () => {
    const plan = planLocalizationSync(
      [ex("e1", "en-US"), ex("e2", "fr-FR")],
      [want("en-US")],
    );
    expect(plan.toPatch.map((p) => p.locale)).toEqual(["en-US"]);
    expect(plan.toDelete).toEqual([{ id: "e2", locale: "fr-FR" }]);
    expect(plan.deletionsSuppressed).toBe(false);
  });

  it("never deletes the last localization — suppresses deletions when desired is empty", () => {
    const plan = planLocalizationSync([ex("e1", "zh-Hans")], []);
    expect(plan.toDelete).toEqual([]);
    expect(plan.deletionsSuppressed).toBe(true);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  it("replacing the ONLY locale with a different one: create new + delete old (safe via create-before-delete order)", () => {
    // existing zh only, desired en only. Plan creates en and deletes zh; the
    // caller applies create BEFORE delete, so en exists when zh is removed.
    const plan = planLocalizationSync([ex("e1", "zh-Hans")], [want("en-US")]);
    expect(plan.toCreate.map((c) => c.locale)).toEqual(["en-US"]);
    expect(plan.toDelete).toEqual([{ id: "e1", locale: "zh-Hans" }]);
    expect(plan.deletionsSuppressed).toBe(false);
  });

  it("fresh IAP with no existing localizations: all creates, no deletes", () => {
    const plan = planLocalizationSync([], [want("en-US"), want("zh-Hans")]);
    expect(plan.toCreate.map((c) => c.locale).sort()).toEqual(["en-US", "zh-Hans"]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});
