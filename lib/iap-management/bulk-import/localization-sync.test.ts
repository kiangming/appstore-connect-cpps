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
