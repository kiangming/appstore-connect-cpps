/**
 * Arc `[LOC-V2-model]` [LOCV2-write-probe] — the decision logic for the ONE
 * write this arc makes.
 *
 * ⚠ TWO CLASSES OF FAILURE ARE PINNED HERE, AND THEY COST DIFFERENT THINGS:
 *
 *   · choosing WRONGLY    → a PATCH lands on a resource nobody inspected, on a
 *                           live selling product. Expensive and irreversible-ish.
 *   · reading WRONGLY     → the write happens but the answer is misfiled. The
 *                           write is spent and the question stays open, which
 *                           means spending ANOTHER write to learn what this one
 *                           already showed.
 *
 * Branch 4 (`WROTE_INTO_EXISTING_DRAFT`) gets the most attention because it is
 * both the best outcome and the one that hides: version count unchanged,
 * locale list unchanged, only content moves.
 */
import { describe, it, expect } from "vitest";
import {
  chooseWriteTarget,
  readWriteProbeResult,
  describeWriteProbeForLog,
  type WriteTarget,
} from "./localization-v2-write-probe";
import type { VersionSnapshot, VersionSnapshotRow } from "./localization-v2-snapshot";

const row = (
  versionId: string,
  state: string,
  locs: Array<[string, string, string, string]>,
): VersionSnapshotRow => ({
  versionId,
  state,
  locales: locs.map((l) => l[1]),
  localizations: locs.map(([id, locale, name, description]) => ({
    id,
    locale,
    name,
    description,
  })),
  truncatedPages: false,
  edge: { kind: "IDS", ids: locs.map((l) => l[0]) },
  pointerDisagrees: false,
});

/** The real shape from `mb6`, with names changed only where a test needs it. */
function snapshot(
  versions: VersionSnapshotRow[],
  over: Partial<VersionSnapshot> = {},
): VersionSnapshot {
  const approved = versions.filter((v) => v.state === "APPROVED" || v.state === "ACCEPTED");
  const drafts = versions.filter((v) => v.state === "PREPARE_FOR_SUBMISSION");
  const divergentLocales: VersionSnapshot["divergentLocales"] = [];
  if (approved.length === 1 && drafts.length === 1) {
    const byLocale = new Map(drafts[0].localizations.map((l) => [l.locale, l]));
    for (const a of approved[0].localizations) {
      const d = byLocale.get(a.locale);
      if (!d) continue;
      if (a.name === d.name && a.description === d.description) continue;
      divergentLocales.push({
        locale: a.locale,
        approvedLocalizationId: a.id,
        approved: { name: a.name, description: a.description },
        draft: { name: d.name, description: d.description },
      });
    }
  }
  return {
    productId: "com.pure3q.sea.mb6",
    versions,
    incomplete: false,
    divergentLocales,
    comparable:
      approved.length === 1 && drafts.length === 1
        ? { ok: true }
        : { ok: false, reason: `found ${approved.length} approved, ${drafts.length} draft` },
    ...over,
  };
}

const APPROVED_ID = "fc859670";
const DRAFT_ID = "4f063e61";

/** The measured `mb6` state: en-US diverges, id + th identical. */
const mb6 = () =>
  snapshot([
    row("42624658", "APPROVED", [
      [APPROVED_ID, "en-US", "6 Ticket", "Recharge and receive 6 Ticket"],
      ["a-id", "id", "6 Tiket", "Isi ulang"],
      ["a-th", "th", "6 ตั๋ว", "เติมเงิน"],
    ]),
    row("8f825f18", "PREPARE_FOR_SUBMISSION", [
      [DRAFT_ID, "en-US", "6 Tickets.", "Recharge and receive 6 Tickets."],
      ["d-id", "id", "6 Tiket", "Isi ulang"],
      ["d-th", "th", "6 ตั๋ว", "เติมเงิน"],
    ]),
  ]);

describe("chooseWriteTarget", () => {
  it("⭐ picks the diverging locale and sends the APPROVED content", () => {
    const c = chooseWriteTarget(mb6(), APPROVED_ID);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.target.locale).toBe("en-US");
    expect(c.target.localizationId).toBe(APPROVED_ID);
    expect(c.target.payload).toEqual({
      name: "6 Ticket",
      description: "Recharge and receive 6 Ticket",
    });
    // What the Manager is told they may lose.
    expect(c.target.draftBefore.name).toBe("6 Tickets.");
  });

  it("⚠⚠ an expectation mismatch REFUSES — the state moved since the snapshot", () => {
    const c = chooseWriteTarget(mb6(), "some-other-id");
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("refusing to write");
    expect(c.reason).toContain(APPROVED_ID);
  });

  it("⚠⚠ ZERO diverging locales REFUSES — the write could not be interpreted", () => {
    // S1 sends the approved content. If the draft already matches it, branch 4
    // and "nothing happened" become indistinguishable — the write would be
    // spent for no answer.
    const same = snapshot([
      row("42624658", "APPROVED", [[APPROVED_ID, "en-US", "X", "D"]]),
      row("8f825f18", "PREPARE_FOR_SUBMISSION", [[DRAFT_ID, "en-US", "X", "D"]]),
    ]);
    const c = chooseWriteTarget(same, APPROVED_ID);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("no locale differs");
  });

  it("⚠ TWO diverging locales REFUSES — the probe needs one moving part", () => {
    const two = snapshot([
      row("42624658", "APPROVED", [
        [APPROVED_ID, "en-US", "A", "D"],
        ["a-th", "th", "T", "DT"],
      ]),
      row("8f825f18", "PREPARE_FOR_SUBMISSION", [
        [DRAFT_ID, "en-US", "B", "D"],
        ["d-th", "th", "T2", "DT"],
      ]),
    ]);
    const c = chooseWriteTarget(two, APPROVED_ID);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("2 locales differ");
  });

  it("⚠⚠ an INCOMPLETE snapshot REFUSES — a flagged read may be short", () => {
    const c = chooseWriteTarget(snapshot(mb6().versions, { incomplete: true }), APPROVED_ID);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("incomplete");
  });

  it("⚠ NOT COMPARABLE REFUSES — no approved/draft pair to derive from", () => {
    const onlyApproved = snapshot([
      row("42624658", "APPROVED", [[APPROVED_ID, "en-US", "X", "D"]]),
    ]);
    const c = chooseWriteTarget(onlyApproved, APPROVED_ID);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("not comparable");
  });
});

// ─── reading the result — the four branches ────────────────────────────────

const target: WriteTarget = {
  localizationId: APPROVED_ID,
  locale: "en-US",
  payload: { name: "6 Ticket", description: "Recharge and receive 6 Ticket" },
  draftBefore: { name: "6 Tickets.", description: "Recharge and receive 6 Tickets." },
};

describe("readWriteProbeResult — the four branches", () => {
  it("409 ⇒ APPLE_REFUSED", () => {
    const r = readWriteProbeResult(mb6(), mb6(), target, false);
    expect(r.verdict).toBe("APPLE_REFUSED");
  });

  it("⭐ a NEW version ⇒ APPLE_CREATED_VERSION", () => {
    const after = snapshot([
      ...mb6().versions,
      row("99999999", "PREPARE_FOR_SUBMISSION", [["n-en", "en-US", "6 Ticket", "Recharge and receive 6 Ticket"]]),
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("APPLE_CREATED_VERSION");
    expect(r.newVersionIds).toEqual(["99999999"]);
  });

  it("⭐⭐ BRANCH 4 — draft content moved, no new version ⇒ WROTE_INTO_EXISTING_DRAFT", () => {
    // The exact signal expected on mb6: the draft's en-US reverts
    // "6 Tickets." → "6 Ticket". Version count and locale list are unchanged,
    // so ONLY the content tier shows it.
    const after = snapshot([
      mb6().versions[0],
      row("8f825f18", "PREPARE_FOR_SUBMISSION", [
        [DRAFT_ID, "en-US", "6 Ticket", "Recharge and receive 6 Ticket"],
        ["d-id", "id", "6 Tiket", "Isi ulang"],
        ["d-th", "th", "6 ตั๋ว", "เติมเงิน"],
      ]),
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("WROTE_INTO_EXISTING_DRAFT");
    expect(r.newVersionIds).toEqual([]);
    expect(r.contentChanges).toHaveLength(1);
    expect(r.contentChanges[0].versionId).toBe("8f825f18");
    expect(r.contentChanges[0].after.name).toBe("6 Ticket");
  });

  it("the APPROVED version's own content moved ⇒ EDITED_LIVE_IN_PLACE", () => {
    const after = snapshot([
      row("42624658", "APPROVED", [
        [APPROVED_ID, "en-US", "CHANGED", "Recharge and receive 6 Ticket"],
        ["a-id", "id", "6 Tiket", "Isi ulang"],
        ["a-th", "th", "6 ตั๋ว", "เติมเงิน"],
      ]),
      mb6().versions[1],
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("EDITED_LIVE_IN_PLACE");
    expect(r.summary).toContain("do not swallow");
  });

  it("200 with nothing moved ⇒ AMBIGUOUS_NO_CHANGE (S2, Manager-gated)", () => {
    const r = readWriteProbeResult(mb6(), mb6(), target, true);
    expect(r.verdict).toBe("AMBIGUOUS_NO_CHANGE");
    expect(r.summary).toContain("S2");
  });

  it("⚠⚠ a locale OUTSIDE the target moved ⇒ UNEXPECTED_COLLATERAL, outranking everything", () => {
    // Manager's addition: `id` and `th` must not be touched. If they are, the
    // PATCH reached more than one resource — a fact no other verdict may bury,
    // so it is checked FIRST, even ahead of a new version appearing.
    const after = snapshot([
      row("42624658", "APPROVED", [
        [APPROVED_ID, "en-US", "6 Ticket", "Recharge and receive 6 Ticket"],
        ["a-id", "id", "TOUCHED", "Isi ulang"],
        ["a-th", "th", "6 ตั๋ว", "เติมเงิน"],
      ]),
      mb6().versions[1],
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("UNEXPECTED_COLLATERAL");
    expect(r.collateral).toHaveLength(1);
    expect(r.collateral[0].locale).toBe("id");
    expect(r.summary).toContain("STOP");
  });

  it("⚠ collateral outranks a new version too — checked before, not after", () => {
    const after = snapshot([
      row("42624658", "APPROVED", [
        [APPROVED_ID, "en-US", "6 Ticket", "Recharge and receive 6 Ticket"],
        ["a-id", "id", "TOUCHED", "Isi ulang"],
        ["a-th", "th", "6 ตั๋ว", "เติมเงิน"],
      ]),
      mb6().versions[1],
      row("99999999", "PREPARE_FOR_SUBMISSION", [["n-en", "en-US", "X", "D"]]),
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("UNEXPECTED_COLLATERAL");
  });

  it("⚠ whitespace-only movement is NOT a change — same rule as everywhere else", () => {
    const after = snapshot([
      mb6().versions[0],
      row("8f825f18", "PREPARE_FOR_SUBMISSION", [
        [DRAFT_ID, "en-US", "6 Tickets. ", "Recharge and receive 6 Tickets."],
        ["d-id", "id", "6 Tiket", "Isi ulang"],
        ["d-th", "th", "6 ตั๋ว", "เติมเงิน"],
      ]),
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    expect(r.verdict).toBe("AMBIGUOUS_NO_CHANGE");
  });
});

describe("describeWriteProbeForLog", () => {
  it("carries the fields that distinguish the branches, and Apple's body", () => {
    const after = snapshot([
      mb6().versions[0],
      row("8f825f18", "PREPARE_FOR_SUBMISSION", [
        [DRAFT_ID, "en-US", "6 Ticket", "Recharge and receive 6 Ticket"],
      ]),
    ]);
    const r = readWriteProbeResult(mb6(), after, target, true);
    const line = describeWriteProbeForLog(
      "com.pure3q.sea.mb6",
      target,
      200,
      mb6(),
      after,
      r,
      '{"data":{}}',
    );
    expect(line).toMatch(/^LOCV2-WRITE-PROBE product=com\.pure3q\.sea\.mb6 /);
    expect(line).toContain(`locId=${APPROVED_ID}`);
    expect(line).toContain("locale=en-US");
    expect(line).toContain("http=200");
    expect(line).toContain("newVersion=n");
    expect(line).toContain("contentChanged=[8f825f18:en-US]");
    expect(line).toContain("verdict=WROTE_INTO_EXISTING_DRAFT");
    expect(line).toContain('body={"data":{}}');
  });
});
