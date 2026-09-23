// @vitest-environment jsdom
/**
 * [BULKIMPORT-loc-step] C1 — STEP NUMBERING IS DERIVED, NEVER A BARE NUMBER.
 *
 * ⭐ THE LESSON THIS GUARDS. Inserting a step into the middle of this wizard
 * does not break the logic — it breaks every place that COUNTS steps with a
 * literal. SC7 inserted "Territories" as step 4 and left three such places
 * behind, all still wrong when C1 found them:
 *
 *   1. the stepper connector (`n < 4` with 5 labels ⇒ one connector missing)
 *   2. the Result heading ("Step 4 — Result" while rendering at step 5)
 *   3. the KB's stepper list (missing Territories entirely)
 *
 * Those are PRE-EXISTING bugs fixed alongside C1, not caused by it.
 *
 * ⚠ This arc inserts ANOTHER step (Localization), which makes it the number-one
 * candidate to repeat exactly that mistake. Hence a guard rather than a note:
 * a comment asking people to be careful is not a test.
 *
 * Two layers, deliberately:
 *   · SOURCE  — no bare step constant may reappear anywhere in the component.
 *   · DOM     — the stepper actually renders one connector fewer than steps,
 *               which is the bug itself and cannot be proven from source alone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { BulkImportWizard } from "./BulkImportWizard";
import type { PricingSourceKind } from "@/lib/iap-management/validation";
import type { UsdTierEntry } from "@/lib/iap-management/queries/price-tiers";

const SOURCE = readFileSync(join(__dirname, "BulkImportWizard.tsx"), "utf8");

/**
 * Source with comments stripped. Comments MAY name step numbers — the block
 * above this file's code does, and the component's own header explains the
 * bug using the literal it bans. Only executable code is policed.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = code(SOURCE);

const BANNED: ReadonlyArray<{ what: string; re: RegExp }> = [
  {
    what: "`step` compared against a bare number — use STEP.X / FIRST_STEP / LAST_STEP",
    re: /\bstep\s*(?:===|!==|<=|>=|<|>)\s*\d/g,
  },
  {
    what: "setStep() with a bare number — use STEP.X / LAST_STEP",
    re: /\bsetStep\(\s*\d/g,
  },
  {
    what: "useState<Step>() seeded with a bare number — use FIRST_STEP",
    re: /useState<Step>\(\s*\d/g,
  },
  {
    what: "stepper index compared against a bare number — derive from STEP_ORDER.length",
    re: /\bidx\s*(?:===|!==|<=|>=|<|>)\s*\d/g,
  },
  {
    what: 'a literal "Step N —" heading — use stepHeading(STEP.X, …)',
    re: /Step \d+\s*—/g,
  },
];

describe("[BULKIMPORT-loc-step] C1 — step numbering is centralised", () => {
  for (const { what, re } of BANNED) {
    it(`has no ${what}`, () => {
      const hits = CODE.match(new RegExp(re.source, re.flags)) ?? [];
      expect(hits).toEqual([]);
    });
  }

  it("declares STEP, STEP_LABELS and a derived STEP_ORDER", () => {
    expect(CODE).toContain("const STEP = {");
    // `satisfies Record<Step, string>` is load-bearing: adding a STEP member
    // without a label is then a COMPILE error, so the two cannot drift.
    expect(CODE).toContain("satisfies Record<Step, string>");
    expect(CODE).toContain("const STEP_ORDER: readonly Step[] = Object.values(STEP)");
  });

  it("draws the stepper connector from STEP_ORDER.length, not a literal", () => {
    expect(CODE).toContain("idx < STEP_ORDER.length - 1");
  });
});

const EMPTY_TIERS: Record<PricingSourceKind, UsdTierEntry[]> = {
  APPLE: [],
  DEFAULT_TEMPLATE: [],
  APP_TEMPLATE: [],
};

/** How many steps the component declares, read from its own source. */
function declaredStepCount(): number {
  const block = /const STEP = \{([\s\S]*?)\} as const;/.exec(SOURCE);
  if (!block) throw new Error("STEP block not found");
  return (block[1].match(/^\s*[A-Z_]+:\s*\d+,/gm) ?? []).length;
}

describe("[BULKIMPORT-loc-step] C1 — stepper renders every step and every connector", () => {
  /**
   * ⚠ ONE render, not two. Rendering the whole wizard is the most expensive
   * thing this file does, and the suite's slow tests sit close enough to the
   * 5s default that a second render measurably raised the full-run timeout
   * count (7 → 17 flaky failures across unrelated files). Both DOM facts are
   * asserted off the same mount, with an explicit timeout so this test states
   * its own budget instead of borrowing the default.
   */
  it(
    "draws one connector FEWER than steps, and carries the M-2 label",
    () => {
      const steps = declaredStepCount();
      expect(steps).toBeGreaterThanOrEqual(5);

      const { container } = render(
        <BulkImportWizard
          appId="123"
          appName="App"
          existingProductIds={[]}
          usdTiersBySource={EMPTY_TIERS}
        />,
      );

      // The pre-existing bug drew `steps - 2` (3 connectors for 5 labels).
      const connectors = container.querySelectorAll("span.h-px.w-8");
      expect(connectors).toHaveLength(steps - 1);

      // M-2 — the step-3 label, asserted off the same mount.
      expect(container.textContent).toContain("Preview itemID & Price");
    },
    15_000,
  );
});
