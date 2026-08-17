/**
 * Tests for IAP.o.12a diff-detector. Pin every diff bucket and the
 * normalization behavior (trim + null/empty collapse) so a regression can't
 * silently drop a Manager-intended edit OR fire an Apple PATCH for an
 * unchanged field.
 */
import { describe, it, expect } from "vitest";
import {
  detectIapChanges,
  isEmptyDiff,
  type CachedIapState,
} from "./diff-detector";
import type { IapFormState } from "../validation";
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  subsetSelection,
} from "./territory-selection";

/** Fixture catalogue + the two named selections the old 2-value fixtures used. */
const CATALOGUE = ["USA", "VNM", "BRA"];
const ALL_SEL = allTerritoriesSelection(CATALOGUE);
const NONE_SEL = noTerritoriesSelection();

function baseForm(overrides: Partial<IapFormState> = {}): IapFormState {
  return {
    reference_name: "Diamond Pack",
    product_id: "com.x.diamonds",
    type: "CONSUMABLE",
    tier_id: "TIER_5",
    localizations: {
      en: { locale: "en", display_name: "Diamonds", description: "Buy diamonds" },
      vi: { locale: "vi", display_name: "Kim cương", description: "Mua kim cương" },
    },
    screenshot_filename: "shot.png",
    review_note: "Reviewer note",
    family_sharable: false,
    availability_selection: ALL_SEL,
    ...overrides,
  };
}

function baseCached(overrides: Partial<CachedIapState> = {}): CachedIapState {
  return {
    reference_name: "Diamond Pack",
    review_note: "Reviewer note",
    family_sharable: false,
    tier_id: "TIER_5",
    localizations: {
      en: { locale: "en", display_name: "Diamonds", description: "Buy diamonds" },
      vi: { locale: "vi", display_name: "Kim cương", description: "Mua kim cương" },
    },
    screenshot_apple_id: "scr-1",
    screenshot_file_name: "shot.png",
    availability_selection: ALL_SEL,
    availability_previous_known: true,
    ...overrides,
  };
}

describe("detectIapChanges — attributes", () => {
  it("detects no change when form and cache match (empty diff)", () => {
    const diff = detectIapChanges({
      form: baseForm(),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("detects name change only", () => {
    const diff = detectIapChanges({
      form: baseForm({ reference_name: "Diamond Pack PRO" }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toEqual({ name: "Diamond Pack PRO" });
    expect(diff.localizations_changed).toBeNull();
    expect(diff.tier_changed).toBeNull();
  });

  it("trims whitespace before comparing (no false positive)", () => {
    const diff = detectIapChanges({
      form: baseForm({ reference_name: "  Diamond Pack  " }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toBeNull();
  });

  it("detects reviewNote → null when form clears a previously-set note", () => {
    const diff = detectIapChanges({
      form: baseForm({ review_note: "" }),
      cached: baseCached({ review_note: "Reviewer note" }),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toEqual({ reviewNote: null });
  });

  it("detects familySharable boolean change", () => {
    const diff = detectIapChanges({
      form: baseForm({ family_sharable: true }),
      cached: baseCached({ family_sharable: false }),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toEqual({ familySharable: true });
  });

  it("treats undefined familySharable in form as 'no change' (back-compat)", () => {
    const diff = detectIapChanges({
      form: baseForm({ family_sharable: undefined }),
      cached: baseCached({ family_sharable: false }),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toBeNull();
  });

  it("treats null cached review_note vs empty form review_note as no change", () => {
    const diff = detectIapChanges({
      form: baseForm({ review_note: "" }),
      cached: baseCached({ review_note: null }),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toBeNull();
  });
});

describe("detectIapChanges — localizations", () => {
  it("detects updated locale (description changed)", () => {
    const diff = detectIapChanges({
      form: baseForm({
        localizations: {
          en: { locale: "en", display_name: "Diamonds", description: "Buy MORE diamonds" },
          vi: { locale: "vi", display_name: "Kim cương", description: "Mua kim cương" },
        },
      }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.localizations_changed?.updated).toEqual([
      { locale: "en", description: "Buy MORE diamonds" },
    ]);
    expect(diff.localizations_changed?.added).toEqual([]);
    expect(diff.localizations_changed?.removed).toEqual([]);
  });

  it("detects added locale (form has ja, cache doesn't)", () => {
    const diff = detectIapChanges({
      form: baseForm({
        localizations: {
          en: { locale: "en", display_name: "Diamonds", description: "Buy diamonds" },
          vi: { locale: "vi", display_name: "Kim cương", description: "Mua kim cương" },
          ja: { locale: "ja", display_name: "ダイヤモンド", description: "ダイヤモンドを買う" },
        },
      }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.localizations_changed?.added).toEqual([
      { locale: "ja", name: "ダイヤモンド", description: "ダイヤモンドを買う" },
    ]);
  });

  it("detects removed locale (cache has vi, form doesn't)", () => {
    const diff = detectIapChanges({
      form: baseForm({
        localizations: {
          en: { locale: "en", display_name: "Diamonds", description: "Buy diamonds" },
        },
      }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.localizations_changed?.removed).toEqual([{ locale: "vi" }]);
  });

  it("treats an all-empty form locale as removed (matches create-on-apple semantics)", () => {
    const diff = detectIapChanges({
      form: baseForm({
        localizations: {
          en: { locale: "en", display_name: "Diamonds", description: "Buy diamonds" },
          vi: { locale: "vi", display_name: "", description: "" },
        },
      }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.localizations_changed?.removed).toEqual([{ locale: "vi" }]);
  });

  it("handles update + add + remove in one diff", () => {
    const diff = detectIapChanges({
      form: baseForm({
        localizations: {
          en: { locale: "en", display_name: "Diamonds v2", description: "Buy diamonds" },
          ja: { locale: "ja", display_name: "ダイヤ", description: "ダイヤを買う" },
        },
      }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(diff.localizations_changed?.updated).toEqual([
      { locale: "en", name: "Diamonds v2" },
    ]);
    expect(diff.localizations_changed?.added).toEqual([
      { locale: "ja", name: "ダイヤ", description: "ダイヤを買う" },
    ]);
    expect(diff.localizations_changed?.removed).toEqual([{ locale: "vi" }]);
  });
});

describe("detectIapChanges — screenshot", () => {
  it("flags screenshot_changed only when a new file is staged AND filename differs", () => {
    const diff = detectIapChanges({
      form: baseForm({ screenshot_filename: "shot-v2.png" }),
      cached: baseCached({ screenshot_file_name: "shot.png" }),
      hasNewScreenshotFile: true,
    });
    expect(diff.screenshot_changed).toBe(true);
  });

  it("does NOT flag screenshot_changed when filename differs but no file staged (just rename in form)", () => {
    const diff = detectIapChanges({
      form: baseForm({ screenshot_filename: "shot-v2.png" }),
      cached: baseCached({ screenshot_file_name: "shot.png" }),
      hasNewScreenshotFile: false,
    });
    expect(diff.screenshot_changed).toBe(false);
  });

  it("does NOT flag screenshot_changed when same filename + new file (Manager re-staged same name)", () => {
    // Defensive choice: filename equality means no rename intent. Manager
    // re-uploading the same filename rarely happens; if they want to
    // force-replace they'd rename or remove first.
    const diff = detectIapChanges({
      form: baseForm({ screenshot_filename: "shot.png" }),
      cached: baseCached({ screenshot_file_name: "shot.png" }),
      hasNewScreenshotFile: true,
    });
    expect(diff.screenshot_changed).toBe(false);
  });
});

describe("detectIapChanges — pricing tier", () => {
  it("detects tier change", () => {
    const diff = detectIapChanges({
      form: baseForm({ tier_id: "TIER_10" }),
      cached: baseCached({ tier_id: "TIER_5" }),
      hasNewScreenshotFile: false,
    });
    expect(diff.tier_changed).toEqual({
      old_tier_id: "TIER_5",
      new_tier_id: "TIER_10",
    });
  });

  it("does NOT flag when form tier_id is null (Manager hasn't reset; preserve cached)", () => {
    const diff = detectIapChanges({
      form: baseForm({ tier_id: null }),
      cached: baseCached({ tier_id: "TIER_5" }),
      hasNewScreenshotFile: false,
    });
    expect(diff.tier_changed).toBeNull();
  });

  it("treats null → tier as add (first-time tier)", () => {
    const diff = detectIapChanges({
      form: baseForm({ tier_id: "TIER_5" }),
      cached: baseCached({ tier_id: null }),
      hasNewScreenshotFile: false,
    });
    expect(diff.tier_changed).toEqual({
      old_tier_id: null,
      new_tier_id: "TIER_5",
    });
  });
});

describe("isEmptyDiff", () => {
  it("returns true for a fully-empty diff", () => {
    const diff = detectIapChanges({
      form: baseForm(),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("returns false for any non-null bucket", () => {
    const diff = detectIapChanges({
      form: baseForm({ reference_name: "X" }),
      cached: baseCached(),
      hasNewScreenshotFile: false,
    });
    expect(isEmptyDiff(diff)).toBe(false);
  });
});

describe("detectIapChanges — availability", () => {
  it("detects all-territories → removed as an availability change", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: NONE_SEL }),
      cached: baseCached({ availability_selection: ALL_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toEqual({
      old_selection: ALL_SEL,
      new_selection: NONE_SEL,
      previous_known: true,
    });
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("detects removed → all-territories in the opposite direction", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: ALL_SEL }),
      cached: baseCached({ availability_selection: NONE_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toEqual({
      old_selection: NONE_SEL,
      new_selection: ALL_SEL,
      previous_known: true,
    });
  });

  it("returns null when the form selection matches cached", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: ALL_SEL }),
      cached: baseCached({ availability_selection: ALL_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toBeNull();
  });

  it("surfaces a diff when the previous state is UNKNOWN and the form picks one", () => {
    // previous_known false ⇒ we could not read Apple. Any explicit selection
    // must be treated as a change: skipping the write here would skip exactly
    // the items whose state we cannot see.
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: NONE_SEL }),
      cached: baseCached({
        availability_selection: null,
        availability_previous_known: false,
      }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toEqual({
      old_selection: null,
      new_selection: NONE_SEL,
      previous_known: false,
    });
  });

  it("returns null when the form selection is absent (Section 5 not rendered)", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: null }),
      cached: baseCached({ availability_selection: ALL_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toBeNull();
  });

  // ── SC5 additions ──────────────────────────────────────────────────────

  it("⚠ a SUBSET edit is a change — the model can express it now", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: subsetSelection(["USA", "VNM"]) }),
      cached: baseCached({ availability_selection: ALL_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed?.new_selection.territoryIds).toEqual([
      "USA",
      "VNM",
    ]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("⚠ same ids, different forward-flag IS a change (KB §4.13)", () => {
    // The whole reason the flag is a field and not a derivation. An id-only
    // comparison would call this a no-op and silently skip the write.
    const ids = ["USA", "VNM", "BRA"];
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: subsetSelection(ids) }),
      cached: baseCached({
        availability_selection: allTerritoriesSelection(ids),
      }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).not.toBeNull();
    expect(diff.availability_changed?.new_selection.availableInNewTerritories).toBe(
      false,
    );
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("territory id ORDER alone is not a change — Apple does not care", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: subsetSelection(["VNM", "USA"]) }),
      cached: baseCached({ availability_selection: subsetSelection(["USA", "VNM"]) }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toBeNull();
  });

  it("known-absent availability vs an empty selection is a no-op", () => {
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: NONE_SEL }),
      cached: baseCached({
        availability_selection: null,
        availability_previous_known: true,
      }),
      hasNewScreenshotFile: false,
    });
    expect(diff.availability_changed).toBeNull();
  });

  it("⚠ LAYER-GAP: an availability-ONLY edit is not an empty diff", () => {
    // isEmptyDiff is gate 1. If this regresses, the route answers NO_CHANGES
    // and the confirm modal never opens — the feature is silently dead on the
    // Edit path with no message anywhere.
    const diff = detectIapChanges({
      form: baseForm({ availability_selection: subsetSelection(["USA"]) }),
      cached: baseCached({ availability_selection: ALL_SEL }),
      hasNewScreenshotFile: false,
    });
    expect(diff.attributes_changed).toBeNull();
    expect(diff.localizations_changed).toBeNull();
    expect(diff.tier_changed).toBeNull();
    expect(diff.screenshot_changed).toBe(false);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});
