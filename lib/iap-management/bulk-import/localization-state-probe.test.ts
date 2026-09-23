/**
 * `[BULKIMPORT-loc-step]` — the temporary state probe.
 *
 * ⚠ These tests pin the DISTINCTIONS the probe exists to make. If the line
 * could not tell "Apple omitted the field" from "Apple sent an empty string",
 * it would answer the question wrongly rather than not at all — which is worse,
 * because the answer gets written into the KB and believed.
 */
import { describe, it, expect } from "vitest";
import { describeLocalizationStatesForLog } from "./localization-state-probe";

describe("describeLocalizationStatesForLog", () => {
  it("reports a populated state", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: "ACTIVE" } },
    ]);
    expect(line).toContain("LOC-STATE-PROBE product=com.a");
    expect(line).toContain("total=1");
    expect(line).toContain("vi=ACTIVE");
  });

  it("ABSENT when the key is missing — the primary question", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi" } },
    ]);
    expect(line).toContain("vi=ABSENT");
  });

  it("EMPTY is NOT ABSENT — Apple sending \"\" means something different", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: "" } },
    ]);
    expect(line).toContain("vi=EMPTY");
    expect(line).not.toContain("vi=ABSENT");
  });

  it("explicit null is its own outcome", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: null } },
    ]);
    expect(line).toContain("vi=NULL");
  });

  it("a non-string state is reported rather than coerced", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: 3 } },
    ]);
    expect(line).toContain("vi=NON_STRING(number)");
  });

  it("missing attributes entirely does not throw", () => {
    expect(() => describeLocalizationStatesForLog("com.a", [{}])).not.toThrow();
    expect(describeLocalizationStatesForLog("com.a", [{}])).toContain(
      "ABSENT=ABSENT",
    );
  });

  // ─── question 2: duplicate locales ────────────────────────────────────────

  it("⭐ reports duplicate locales — the direct answer to 'does Apple return two rows?'", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: "ACTIVE" } },
      { attributes: { locale: "vi", state: "PREPARE_FOR_SUBMISSION" } },
      { attributes: { locale: "en-US", state: "ACTIVE" } },
    ]);
    expect(line).toContain("total=3");
    expect(line).toContain("dupes=[vi x2]");
    // Both rows are listed, so the PAIR of states is visible, not just a count.
    expect(line).toContain("vi=ACTIVE");
    expect(line).toContain("vi=PREPARE_FOR_SUBMISSION");
  });

  it("no duplicates ⇒ dupes is EMPTY, which is itself the answer", () => {
    const line = describeLocalizationStatesForLog("com.a", [
      { attributes: { locale: "vi", state: "ACTIVE" } },
      { attributes: { locale: "en-US", state: "ACTIVE" } },
    ]);
    expect(line).toContain("dupes=[]");
  });

  it("an empty response is still logged — 'Apple returned nothing' is a finding", () => {
    const line = describeLocalizationStatesForLog("com.a", []);
    expect(line).toContain("total=0");
    expect(line).toContain("rows=[]");
  });
});
