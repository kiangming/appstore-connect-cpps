import { describe, it, expect } from "vitest";
import {
  validateIapFormState,
  emptyIapForm,
  filledLocalizationCount,
  REFERENCE_NAME_MAX,
  type IapFormState,
} from "./validation";

function fullyValidForm(): IapFormState {
  return {
    reference_name: "Diamond Pack S",
    product_id: "com.vng.lineagew.diamond_s",
    type: "CONSUMABLE",
    tier_id: "TIER_1",
    localizations: {
      "en-US": {
        locale: "en-US",
        display_name: "Small Diamond Pack",
        description: "Get 100 diamonds for in-game purchases.",
      },
    },
    screenshot_filename: "com.vng.lineagew.diamond_s.jpg",
  };
}

describe("validateIapFormState — 6-prerequisite checklist (Q-IAP.h.3)", () => {
  it("empty form fails all 6 prerequisites", () => {
    const result = validateIapFormState(emptyIapForm());
    expect(result.passedCount).toBe(0);
    expect(result.allPassed).toBe(false);
    expect(result.items.every((i) => !i.passed)).toBe(true);
  });

  it("fully valid form passes all 6 prerequisites", () => {
    const result = validateIapFormState(fullyValidForm());
    expect(result.passedCount).toBe(6);
    expect(result.allPassed).toBe(true);
  });

  it("rejects reference name over 64 characters", () => {
    const form = fullyValidForm();
    form.reference_name = "x".repeat(REFERENCE_NAME_MAX + 1);
    const result = validateIapFormState(form);
    const ref = result.items.find((i) => i.key === "reference_name")!;
    expect(ref.passed).toBe(false);
    expect(ref.detail).toContain(`${REFERENCE_NAME_MAX + 1}/${REFERENCE_NAME_MAX}`);
  });

  it("accepts reference name at exactly 64 characters", () => {
    const form = fullyValidForm();
    form.reference_name = "x".repeat(REFERENCE_NAME_MAX);
    const result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "reference_name")!.passed).toBe(true);
  });

  it("rejects product IDs with invalid characters", () => {
    const cases = [
      "has spaces.in.id",
      "has/slash",
      "has+plus",
      "_starts.with.underscore",
      "has.unicode.café",
    ];
    for (const productId of cases) {
      const form = fullyValidForm();
      form.product_id = productId;
      const result = validateIapFormState(form);
      const pid = result.items.find((i) => i.key === "product_id")!;
      expect(pid.passed, `expected "${productId}" to fail`).toBe(false);
    }
  });

  it("accepts canonical product IDs", () => {
    const cases = [
      "com.vng.app.product1",
      "com.vng.app.product_1",
      "com.vng.app.product-1",
      "Product1",
      "a",
    ];
    for (const productId of cases) {
      const form = fullyValidForm();
      form.product_id = productId;
      const result = validateIapFormState(form);
      const pid = result.items.find((i) => i.key === "product_id")!;
      expect(pid.passed, `expected "${productId}" to pass`).toBe(true);
    }
  });

  it("rejects partially-filled localizations (Display Name only)", () => {
    const form = fullyValidForm();
    form.localizations = {
      "en-US": {
        locale: "en-US",
        display_name: "Only Name",
        description: "   ", // whitespace-only counts as empty
      },
    };
    const result = validateIapFormState(form);
    const loc = result.items.find((i) => i.key === "localization")!;
    expect(loc.passed).toBe(false);
    expect(loc.detail).toBe("required");
  });

  it("counts only fully-filled locale pairs", () => {
    const localizations = {
      "en-US": {
        locale: "en-US",
        display_name: "English Name",
        description: "English desc",
      },
      vi: { locale: "vi", display_name: "Vi", description: "" },
      ja: { locale: "ja", display_name: "Japanese", description: "Description" },
    };
    expect(filledLocalizationCount(localizations)).toBe(2);
  });

  it("requires non-empty screenshot filename", () => {
    const form = fullyValidForm();
    form.screenshot_filename = null;
    let result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(false);

    form.screenshot_filename = "";
    result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(false);

    form.screenshot_filename = "shot.jpg";
    result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(true);
  });

  it("requires type to be one of the 3 allowed types (Q1 lock)", () => {
    const form = fullyValidForm();
    form.type = "";
    const result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "type")!.passed).toBe(false);
  });

  it("requires tier_id non-null AND non-empty string", () => {
    const form = fullyValidForm();
    form.tier_id = null;
    expect(
      validateIapFormState(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(false);

    form.tier_id = "";
    expect(
      validateIapFormState(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(false);

    form.tier_id = "FREE";
    expect(
      validateIapFormState(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);

    form.tier_id = "TIER_1";
    expect(
      validateIapFormState(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);

    form.tier_id = "ALT_A";
    expect(
      validateIapFormState(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);
  });

  it("partial-fill detail reports the filled count", () => {
    const form = fullyValidForm();
    form.localizations = {
      "en-US": form.localizations["en-US"],
      vi: { locale: "vi", display_name: "Vi name", description: "Vi desc" },
    };
    const result = validateIapFormState(form);
    expect(result.items.find((i) => i.key === "localization")!.detail).toBe("2 filled");
  });
});
