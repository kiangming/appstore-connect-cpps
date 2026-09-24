/**
 * Arc `[LOC-V2-model]` chunk V2 — the six cases the Manager named, plus the
 * parity guard that keeps this from becoming a second implementation.
 *
 * ⚠ WHAT THESE TESTS ARE FOR. Every one of them decides, for one cell in the
 * Localization step, between "leave it ticked and write to Apple" and "untick
 * it, Apple already has this". Under the V2 model a wrong TICK on a live
 * product can mean a new version and another App Review cycle; a wrong UNTICK
 * silently drops an edit the Manager asked for. Neither direction is free,
 * which is why the rule is pinned case by case rather than described.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeLocalizationText,
  localizationTextEquals,
  localizationContentEquals,
} from "./localization-compare";

const content = (name: string, description: string) => ({ name, description });

describe("localizationTextEquals — the six cases", () => {
  it("1. identical ⇒ SAME", () => {
    expect(localizationTextEquals("188 Vàng", "188 Vàng")).toBe(true);
  });

  it("2. ⭐ one full stop ⇒ DIFFERENT — a real edit, never normalized away", () => {
    // The Manager's own example. Over-normalizing would swallow exactly this.
    expect(localizationTextEquals("188 Vàng", "188 Vàng.")).toBe(false);
  });

  it("3. surrounding whitespace ⇒ SAME — the sheet already trims", () => {
    expect(localizationTextEquals("188 Vàng ", "188 Vàng")).toBe(true);
    expect(localizationTextEquals("  188 Vàng  ", "188 Vàng")).toBe(true);
    // ⚠ INNER whitespace is content, not formatting.
    expect(localizationTextEquals("188  Vàng", "188 Vàng")).toBe(false);
  });

  it("4. ⚠⚠ NFC vs NFD ⇒ DIFFERENT **TODAY** — this test PINS the input to Q5, not the answer", () => {
    // ⚠ READ BEFORE CHANGING. This is NOT a decision that composed characters
    // must compare unequal. It is the record of what today's rule does, so
    // that when the Manager decides Q5 (after the codepoint measurement) the
    // change is visible as a change instead of arriving silently.
    const nfc = "Vàng"; // "Vàng" — precomposed à
    const nfd = "Vàng"; // "Vàng" — a + combining grave

    // The risk made explicit: to a human these are the same word.
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    // To this comparator, today, they are not.
    expect(localizationTextEquals(nfc, nfd)).toBe(false);

    // ⇒ If the measurement shows Excel and Apple disagree on encoding, a cell
    //   that truly matches would be classified as changed — and under the V2
    //   model that can cost a version and a re-review for an edit that does
    //   not exist. Q5 decides; this test then changes WITH the decision.
  });

  it("5. case differs ⇒ DIFFERENT — pinned explicitly, never left to be inferred", () => {
    expect(localizationTextEquals("vàng", "Vàng")).toBe(false);
  });

  it("6. null / undefined / empty collapse together", () => {
    expect(localizationTextEquals(null, "")).toBe(true);
    expect(localizationTextEquals(undefined, "")).toBe(true);
    expect(localizationTextEquals(null, undefined)).toBe(true);
    expect(localizationTextEquals(null, "x")).toBe(false);
  });
});

describe("localizationContentEquals — both fields, R2b's OR", () => {
  it("both match ⇒ SAME (the auto-untick case, R2a)", () => {
    expect(
      localizationContentEquals(content("188 Vàng", "Gói 188 vàng"), content("188 Vàng", "Gói 188 vàng")),
    ).toBe(true);
  });

  it("⭐ description differs while the display name matches ⇒ DIFFERENT", () => {
    // The shortcut this guards against — comparing only the display name —
    // would silently drop every description-only edit.
    expect(
      localizationContentEquals(content("188 Vàng", "Gói 188 vàng"), content("188 Vàng", "Gói 188 vàng.")),
    ).toBe(false);
  });

  it("display name differs while the description matches ⇒ DIFFERENT", () => {
    expect(
      localizationContentEquals(content("188 Vàng", "x"), content("189 Vàng", "x")),
    ).toBe(false);
  });

  it("trimming applies to both fields, not just the first", () => {
    expect(
      localizationContentEquals(content(" a ", " b "), content("a", "b")),
    ).toBe(true);
  });
});

describe("normalizeLocalizationText", () => {
  it("trims both ends and collapses nullish to empty", () => {
    expect(normalizeLocalizationText("  x  ")).toBe("x");
    expect(normalizeLocalizationText(null)).toBe("");
    expect(normalizeLocalizationText(undefined)).toBe("");
  });

  it("⚠ leaves the INTERIOR of the string alone — it is not a sanitizer", () => {
    expect(normalizeLocalizationText(" a  b ")).toBe("a  b");
    expect(normalizeLocalizationText("V̀")).toBe("V̀");
  });
});

describe("⚠ parity with the single-IAP edit form is STRUCTURAL, not a promise", () => {
  const diffSrc = readFileSync(
    join(__dirname, "apple", "diff-detector.ts"),
    "utf8",
  );

  it("diff-detector uses THIS module's rule rather than its own copy", () => {
    expect(diffSrc).toContain('from "../localization-compare"');
    expect(diffSrc).toContain("const normalize = normalizeLocalizationText;");
    expect(diffSrc).toContain("const eqText = localizationTextEquals;");
  });

  it("⚠⚠ and it does not re-inline a trim rule alongside the import", () => {
    // The failure this catches: someone adds `const normalize = (s) => …trim()`
    // back into diff-detector for a local tweak. Both surfaces keep passing
    // their own tests while quietly disagreeing about whether a product
    // changed — the drift this extraction exists to prevent.
    expect(diffSrc).not.toMatch(/const\s+normalize\s*=\s*\(/);
    expect(diffSrc).not.toMatch(/const\s+eqText\s*=\s*\(/);
  });
});
