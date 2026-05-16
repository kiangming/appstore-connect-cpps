import { describe, it, expect } from "vitest";
import {
  validateIapFormForCreate,
  validateIapFormForSubmit,
  validateIapFormGrouped,
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

function formNoScreenshot(): IapFormState {
  return { ...fullyValidForm(), screenshot_filename: null };
}

describe("validateIapFormForCreate — Group A (5 items, no screenshot gate)", () => {
  it("empty form fails all 5 Group A prerequisites", () => {
    const result = validateIapFormForCreate(emptyIapForm());
    expect(result.passedCount).toBe(0);
    expect(result.allPassed).toBe(false);
    expect(result.items).toHaveLength(5);
    expect(result.items.every((i) => !i.passed)).toBe(true);
  });

  it("fully valid form passes Group A", () => {
    const result = validateIapFormForCreate(fullyValidForm());
    expect(result.passedCount).toBe(5);
    expect(result.allPassed).toBe(true);
  });

  it("Group A passes even when screenshot is missing", () => {
    const result = validateIapFormForCreate(formNoScreenshot());
    expect(result.allPassed).toBe(true);
    expect(result.items.map((i) => i.key)).not.toContain("screenshot");
  });

  it("returns exactly 5 Group A items in stable order", () => {
    const result = validateIapFormForCreate(emptyIapForm());
    expect(result.items.map((i) => i.key)).toEqual([
      "reference_name",
      "product_id",
      "type",
      "tier",
      "localization",
    ]);
  });
});

describe("validateIapFormForSubmit — Group A + Group B (6 items)", () => {
  it("empty form fails all 6 prerequisites", () => {
    const result = validateIapFormForSubmit(emptyIapForm());
    expect(result.passedCount).toBe(0);
    expect(result.allPassed).toBe(false);
    expect(result.items).toHaveLength(6);
  });

  it("fully valid form passes all 6 prerequisites", () => {
    const result = validateIapFormForSubmit(fullyValidForm());
    expect(result.passedCount).toBe(6);
    expect(result.allPassed).toBe(true);
  });

  it("missing screenshot blocks submit but Group A still 5/5", () => {
    const result = validateIapFormForSubmit(formNoScreenshot());
    expect(result.allPassed).toBe(false);
    expect(result.passedCount).toBe(5);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(
      false,
    );
  });

  it("rejects reference name over 64 characters", () => {
    const form = fullyValidForm();
    form.reference_name = "x".repeat(REFERENCE_NAME_MAX + 1);
    const result = validateIapFormForSubmit(form);
    const ref = result.items.find((i) => i.key === "reference_name")!;
    expect(ref.passed).toBe(false);
    expect(ref.detail).toContain(`${REFERENCE_NAME_MAX + 1}/${REFERENCE_NAME_MAX}`);
  });

  it("accepts reference name at exactly 64 characters", () => {
    const form = fullyValidForm();
    form.reference_name = "x".repeat(REFERENCE_NAME_MAX);
    const result = validateIapFormForSubmit(form);
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
      const result = validateIapFormForSubmit(form);
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
      const result = validateIapFormForSubmit(form);
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
        description: "   ",
      },
    };
    const result = validateIapFormForSubmit(form);
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
    let result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(false);

    form.screenshot_filename = "";
    result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(false);

    form.screenshot_filename = "shot.jpg";
    result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "screenshot")!.passed).toBe(true);
  });

  it("requires type to be one of the 3 allowed types (Q1 lock)", () => {
    const form = fullyValidForm();
    form.type = "";
    const result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "type")!.passed).toBe(false);
  });

  it("requires tier_id non-null AND non-empty string", () => {
    const form = fullyValidForm();
    form.tier_id = null;
    expect(
      validateIapFormForSubmit(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(false);

    form.tier_id = "";
    expect(
      validateIapFormForSubmit(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(false);

    form.tier_id = "FREE";
    expect(
      validateIapFormForSubmit(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);

    form.tier_id = "TIER_1";
    expect(
      validateIapFormForSubmit(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);

    form.tier_id = "ALT_A";
    expect(
      validateIapFormForSubmit(form).items.find((i) => i.key === "tier")!.passed,
    ).toBe(true);
  });

  it("partial-fill detail reports the filled count", () => {
    const form = fullyValidForm();
    form.localizations = {
      "en-US": form.localizations["en-US"],
      vi: { locale: "vi", display_name: "Vi name", description: "Vi desc" },
    };
    const result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "localization")!.detail).toBe("2 filled");
  });

  it("rejects whitespace-only reference name", () => {
    const form = fullyValidForm();
    form.reference_name = "   \t  ";
    const result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "reference_name")!.passed).toBe(false);
  });

  it("rejects whitespace-only product_id", () => {
    const form = fullyValidForm();
    form.product_id = "   ";
    const result = validateIapFormForSubmit(form);
    expect(result.items.find((i) => i.key === "product_id")!.passed).toBe(false);
  });

  it("returns exactly 6 items in stable order", () => {
    const result = validateIapFormForSubmit(emptyIapForm());
    expect(result.items.map((i) => i.key)).toEqual([
      "reference_name",
      "product_id",
      "type",
      "tier",
      "localization",
      "screenshot",
    ]);
  });
});

describe("validateIapFormGrouped — UI grouping helper", () => {
  it("empty form: createReady=false, submitReady=false, counts=0", () => {
    const grouped = validateIapFormGrouped(emptyIapForm());
    expect(grouped.createReady).toBe(false);
    expect(grouped.submitReady).toBe(false);
    expect(grouped.createPassedCount).toBe(0);
    expect(grouped.submitPassedCount).toBe(0);
    expect(grouped.createItems).toHaveLength(5);
    expect(grouped.submitOnlyItems).toHaveLength(1);
  });

  it("no-screenshot form: createReady=true, submitReady=false", () => {
    const grouped = validateIapFormGrouped(formNoScreenshot());
    expect(grouped.createReady).toBe(true);
    expect(grouped.submitReady).toBe(false);
    expect(grouped.createPassedCount).toBe(5);
    expect(grouped.submitPassedCount).toBe(0);
  });

  it("fully valid form: createReady=true, submitReady=true", () => {
    const grouped = validateIapFormGrouped(fullyValidForm());
    expect(grouped.createReady).toBe(true);
    expect(grouped.submitReady).toBe(true);
    expect(grouped.createPassedCount).toBe(5);
    expect(grouped.submitPassedCount).toBe(1);
  });

  it("Group B never qualifies as submitReady when Group A fails", () => {
    const form = fullyValidForm();
    form.reference_name = ""; // break Group A
    const grouped = validateIapFormGrouped(form);
    expect(grouped.createReady).toBe(false);
    expect(grouped.submitPassedCount).toBe(1); // screenshot still present
    expect(grouped.submitReady).toBe(false);
  });
});
