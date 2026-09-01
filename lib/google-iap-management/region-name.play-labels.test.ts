/**
 * The Play Console label table — its own claims, checked against its own
 * source text.
 *
 * `PLAY_CONSOLE_LABELS` (region-name.ts) is DATA transcribed from a screen.
 * Data transcribed from a screen has exactly two failure modes and neither is
 * a logic bug: a row is missing, or a character is not the character it looks
 * like. Both are invisible in review — "Côte d'Ivoire" and "Côte d’Ivoire"
 * differ by one code point and render almost identically in a diff.
 *
 * So this file reads the SOURCE TEXT rather than only calling the function.
 * A behavioural test can only ask about codes it names; the source can be
 * asked about every character it contains.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { regionNameFromCode } from "./region-name";
// ⚠ IMPORTED FROM THE FIXTURE MODULE, NOT FROM THE OTHER TEST FILE. It lived
// in `export-territory-header.test.ts` first, and importing it from there
// re-registered that file's whole suite inside this one — 22 extra tests
// reported under this filename, failing for reasons belonging to another
// file. A test module is not a library; importing one runs it.
import { GOOGLE_REGIONS_173 } from "./__fixtures__/google-regions-173";

const SRC = readFileSync(join(__dirname, "region-name.ts"), "utf8");

/** The `PLAY_CONSOLE_LABELS = { … }` object literal, as raw source text. */
function tableSource(): string {
  const start = SRC.indexOf("const PLAY_CONSOLE_LABELS");
  expect(start, "PLAY_CONSOLE_LABELS not found").toBeGreaterThan(-1);
  const open = SRC.indexOf("{", start);
  const close = SRC.indexOf("\n};", open);
  expect(close).toBeGreaterThan(open);
  return SRC.slice(open, close);
}

function tableEntries(): Array<[string, string]> {
  return [...tableSource().matchAll(/([A-Z]{2}): "([^"]*)"/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
}

describe("PLAY_CONSOLE_LABELS — the table is complete and well-formed", () => {
  it("holds exactly 173 entries, no duplicates", () => {
    const entries = tableEntries();
    expect(entries).toHaveLength(173);
    expect(new Set(entries.map(([c]) => c)).size).toBe(173);
  });

  it("covers exactly the 173 markets Google sells in — no more, no less", () => {
    // A row missing here is a country whose header silently falls back to the
    // ISO name; a row too many is a market Google does not sell in, which
    // means the transcription came from the wrong Console screen. The
    // Manager's first list was 176 rows from COUNTRY TARGETING (it carried CN
    // CU IR SD and "Rest of World", and was missing CF) — this assertion is
    // what tells those two screens apart.
    const codes = tableEntries().map(([c]) => c).sort();
    expect(codes).toEqual([...GOOGLE_REGIONS_173].sort());
  });

  it("every label is non-empty and not just the code back again", () => {
    for (const [code, label] of tableEntries()) {
      expect(label.length, code).toBeGreaterThan(1);
      expect(label, code).not.toBe(code);
    }
  });
});

describe("⚠ PLAY_CONSOLE_LABELS — the exact code points of every non-ASCII character", () => {
  it("the table contains exactly three non-ASCII characters, and they are U+00F4, U+2019, U+00FC", () => {
    // Enumerated from the source, not asserted per-country: a fourth accented
    // character appearing in a future refresh must be looked at deliberately,
    // not absorbed silently.
    const found = [...tableSource()]
      .map((ch) => ch.codePointAt(0) ?? 0)
      .filter((cp) => cp > 127);
    expect(found).toEqual([0x00f4, 0x2019, 0x00fc]);
  });

  it("CI is `Côte d’Ivoire` with U+2019, NOT the ASCII apostrophe U+0027", () => {
    // THE ONE MOST LIKELY TO GO WRONG. Every editor, shell and paste buffer
    // is happy to turn ’ into ', the string still looks right, and the file
    // then disagrees with the Console by one invisible byte.
    const label = regionNameFromCode("CI");
    expect(label).toBe("Côte d’Ivoire");
    expect([...label].map((c) => c.codePointAt(0))).toContain(0x2019);
    expect(label).not.toContain("'");
    expect(label.codePointAt(1)).toBe(0x00f4);
  });

  it("TR is `Türkiye` with U+00FC — not `Turkiye`, not `Turkey`", () => {
    const label = regionNameFromCode("TR");
    expect(label).toBe("Türkiye");
    expect(label.codePointAt(1)).toBe(0x00fc);
  });
});

describe("⚠ the 16 labels this table changed — the reason it replaced a patch list", () => {
  // Measured 2026-09-01 against the tool's output BEFORE this change
  // (override map + i18n-iso-countries@7.14.0). 22 of the 173 differed from
  // the library's raw name; 7 were already corrected by an override, 1 was
  // made WRONG by one, so 16 labels actually moved.
  it.each([
    ["AG", "Antigua & Barbuda"],
    ["BA", "Bosnia & Herzegovina"],
    ["CD", "Congo - Kinshasa"],
    ["CG", "Congo - Brazzaville"],
    ["CI", "Côte d’Ivoire"],
    ["FM", "Micronesia"],
    ["GM", "Gambia"],
    ["KN", "St. Kitts & Nevis"],
    ["LC", "St. Lucia"],
    ["MK", "North Macedonia"],
    ["MM", "Myanmar (Burma)"],
    ["MO", "Macao"],
    ["TC", "Turks & Caicos Islands"],
    ["TT", "Trinidad & Tobago"],
    ["VA", "Vatican City"],
    ["VG", "British Virgin Islands"],
  ])("%s now reads %s", (code, expected) => {
    expect(regionNameFromCode(code)).toBe(expected);
  });

  it("⚠ MO was actively WRONG before, not merely uncovered", () => {
    // The old map pinned "Macau" with a comment noting ISO says "Macao" — a
    // deliberate divergence that landed on neither source. Everything else in
    // the 16 was simply not covered. This one is called out separately
    // because "the patch list was incomplete" and "the patch list was wrong"
    // are different failures, and only the second one argues for replacing
    // the whole list instead of extending it.
    expect(regionNameFromCode("MO")).toBe("Macao");
    expect(regionNameFromCode("MO")).not.toBe("Macau");
  });
});

describe("⚠ the 5 markets Google does NOT sell in keep their labels", () => {
  it("KP/IR/SY/PS/BN still resolve to the short names, via NON_PRICING_LABELS", () => {
    // These reach `regionNameFromCode` through `getAllRegions()` — the Edit
    // form's all-ISO picker — not through pricing. Dropping them while
    // replacing the pricing table would have changed a surface this change
    // was not aimed at, so they were kept and separated.
    expect(regionNameFromCode("KP")).toBe("North Korea");
    expect(regionNameFromCode("IR")).toBe("Iran");
    expect(regionNameFromCode("SY")).toBe("Syria");
    expect(regionNameFromCode("PS")).toBe("Palestine");
    expect(regionNameFromCode("BN")).toBe("Brunei");
  });

  it("none of them is in the pricing table", () => {
    const codes = new Set(tableEntries().map(([c]) => c));
    for (const c of ["KP", "IR", "SY", "PS", "BN"]) {
      expect(codes.has(c), `${c} must not be in PLAY_CONSOLE_LABELS`).toBe(false);
    }
  });
});

describe("⚠ the library is now the fallback, and only for codes outside the 173", () => {
  it("a code with no Console row still resolves through i18n-iso-countries", () => {
    // AD (Andorra) is one of the 25 markets the old shared catalog carried
    // that Google does not sell in.
    expect(regionNameFromCode("AD")).toBe("Andorra");
  });

  it("a code with no name anywhere still returns the code itself", () => {
    expect(regionNameFromCode("ZZ")).toBe("ZZ");
  });
});
