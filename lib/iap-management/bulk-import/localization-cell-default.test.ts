/**
 * C2 — cell defaults + the Q-F version-creation count.
 * Arc `[BULKIMPORT-loc-compare-apple]`.
 */
import { describe, it, expect } from "vitest";
import {
  buildCellDefaults,
  itemWillCreateVersion,
  CELL_LABELS,
  type ItemAppleState,
} from "./localization-cell-default";
import { SKIP_LABELS } from "./localization-version-plan";

const want = (locale: string, display_name: string, description: string) => ({
  locale,
  display_name,
  description,
});
const row = (id: string, locale: string, name: string, description: string) => ({
  id,
  locale,
  name,
  description,
});
const read = (
  approved: ReturnType<typeof row>[],
  draft: ReturnType<typeof row>[] = [],
): ItemAppleState => ({ kind: "READ", approved, draft });

describe("buildCellDefaults — the six states", () => {
  it("① file matches live, nothing pending ⇒ UNTICK, 'Giống bản đang bán'", () => {
    const out = buildCellDefaults(
      [want("en-US", "N", "D")],
      read([row("a", "en-US", "N", "D")]),
    );
    expect(out[0].default).toEqual({
      tick: false,
      kind: "SKIPPED",
      reason: "IDENTICAL_TO_LIVE",
      label: SKIP_LABELS.IDENTICAL_TO_LIVE,
    });
  });

  it("② file matches the DRAFT (re-run) ⇒ UNTICK, 'Bản nháp đã mang thay đổi này'", () => {
    const out = buildCellDefaults(
      [want("en-US", "New", "D")],
      read([row("a", "en-US", "Old", "D")], [row("d", "en-US", "New", "D")]),
    );
    expect(out[0].default).toMatchObject({
      tick: false,
      reason: "ALREADY_IN_DRAFT",
      label: SKIP_LABELS.ALREADY_IN_DRAFT,
    });
  });

  it("③ file matches live but the draft carries something ELSE ⇒ UNTICK, third sentence", () => {
    const out = buildCellDefaults(
      [want("en-US", "N", "D")],
      read([row("a", "en-US", "N", "D")], [row("d", "en-US", "Other", "D")]),
    );
    expect(out[0].default).toMatchObject({
      tick: false,
      reason: "LIVE_MATCHES_BUT_DRAFT_DIFFERS",
      label: SKIP_LABELS.LIVE_MATCHES_BUT_DRAFT_DIFFERS,
    });
  });

  it("⚠ the three skip sentences are DISTINCT — merging them erases the fact Manager needs", () => {
    const labels = new Set([
      SKIP_LABELS.IDENTICAL_TO_LIVE,
      SKIP_LABELS.ALREADY_IN_DRAFT,
      SKIP_LABELS.LIVE_MATCHES_BUT_DRAFT_DIFFERS,
    ]);
    expect(labels.size).toBe(3);
  });

  it("④ file differs ⇒ TICK, and the CHANGED FIELD is named", () => {
    const out = buildCellDefaults(
      [want("en-US", "New name", "D")],
      read([row("a", "en-US", "Old name", "D")]),
    );
    expect(out[0].default).toEqual({
      tick: true,
      kind: "DIFFERS",
      changed: { name: true, description: false },
      label: CELL_LABELS.CHANGED_NAME,
    });
  });

  it("④b a DESCRIPTION-only edit is still a change — the shortcut that drops it is name-only comparison", () => {
    const out = buildCellDefaults(
      [want("en-US", "N", "New desc")],
      read([row("a", "en-US", "N", "Old desc")]),
    );
    expect(out[0].default).toMatchObject({
      tick: true,
      changed: { name: false, description: true },
      label: CELL_LABELS.CHANGED_DESC,
    });
  });

  it("④c both fields ⇒ 'Đổi cả hai'", () => {
    const out = buildCellDefaults(
      [want("en-US", "X", "Y")],
      read([row("a", "en-US", "N", "D")]),
    );
    expect(out[0].default).toMatchObject({ label: CELL_LABELS.CHANGED_BOTH });
  });

  it("⑤ Apple genuinely lacks the locale ⇒ TICK, 'Chưa có trên Apple'", () => {
    const out = buildCellDefaults(
      [want("th", "N", "D")],
      read([row("a", "en-US", "N", "D")]),
    );
    expect(out[0].default).toEqual({
      tick: true,
      kind: "NEW_LOCALE",
      label: CELL_LABELS.NEW_LOCALE,
    });
  });

  it("⑥ the read failed ⇒ UNTICK, 'Không đọc được trạng thái trên Apple'", () => {
    const out = buildCellDefaults([want("th", "N", "D")], { kind: "UNREADABLE" });
    expect(out[0].default).toEqual({
      tick: false,
      kind: "UNREADABLE",
      label: CELL_LABELS.UNREADABLE,
    });
  });

  it("item CREATE ⇒ TICK, Q-D label, and nothing is compared", () => {
    const out = buildCellDefaults(
      [want("en-US", "N", "D"), want("th", "N2", "D2")],
      { kind: "NEW_ITEM" },
    );
    expect(out.map((c) => c.default)).toEqual([
      { tick: true, kind: "NEW_ITEM", label: CELL_LABELS.NEW_ITEM },
      { tick: true, kind: "NEW_ITEM", label: CELL_LABELS.NEW_ITEM },
    ]);
  });
});

describe("⚠⚠ 'chưa có' and 'không đọc được' point OPPOSITE ways — in one table", () => {
  it("same locale, same file text: NEW_LOCALE ticks, UNREADABLE does not", () => {
    // The single assertion this whole fail-safe exists for. Collapsing the two
    // into one state is only safe in one direction, and it is not this one.
    const desired = [want("th", "N", "D")];
    const readable = buildCellDefaults(desired, read([row("a", "en-US", "N", "D")]));
    const unreadable = buildCellDefaults(desired, { kind: "UNREADABLE" });

    expect(readable[0].default.tick).toBe(true);
    expect(unreadable[0].default.tick).toBe(false);
    expect(readable[0].default.kind).not.toBe(unreadable[0].default.kind);
  });

  it("⚠ an UNREADABLE item never produces a SKIPPED reason — it made no finding about Apple", () => {
    const out = buildCellDefaults(
      [want("en-US", "N", "D")],
      { kind: "UNREADABLE" },
    );
    expect(out[0].default.kind).toBe("UNREADABLE");
    expect(out[0].default).not.toHaveProperty("reason");
  });
});

describe("⭐ Q-F — itemWillCreateVersion counts ITEMS, and asks the planner", () => {
  it("live item, no draft, a locale that CHANGED ⇒ counted", () => {
    expect(
      itemWillCreateVersion({
        hasApproved: true,
        hasDraft: false,
        writeLocales: ["en-US"],
        tickedLocales: ["en-US"],
      }),
    ).toBe(true);
  });

  it("⚠⚠ live item whose only ticked locale is a NEW LOCALE ⇒ counted", () => {
    // The undercount trap. Phrasing condition (3) as "differs from what is
    // live" reads a locale Apple has never seen as "not different" and skips
    // the warning — while Apple still forces a new version for the add.
    // `writeLocales` holds both cases, which is why the planner is the source.
    expect(
      itemWillCreateVersion({
        hasApproved: true,
        hasDraft: false,
        writeLocales: ["th"], // never on Apple; planner still says write
        tickedLocales: ["th"],
      }),
    ).toBe(true);
  });

  it("⚠ ticked by hand but the planner will SKIP it ⇒ NOT counted", () => {
    expect(
      itemWillCreateVersion({
        hasApproved: true,
        hasDraft: false,
        writeLocales: [],
        tickedLocales: ["en-US", "th"],
      }),
    ).toBe(false);
  });

  it("⚠ item already has a draft ⇒ NOT counted, even with real changes (CA 2 creates nothing)", () => {
    expect(
      itemWillCreateVersion({
        hasApproved: true,
        hasDraft: true,
        writeLocales: ["en-US"],
        tickedLocales: ["en-US"],
      }),
    ).toBe(false);
  });

  it("item not live ⇒ NOT counted", () => {
    expect(
      itemWillCreateVersion({
        hasApproved: false,
        hasDraft: true,
        writeLocales: ["en-US"],
        tickedLocales: ["en-US"],
      }),
    ).toBe(false);
  });

  it("⭐ THREE ticked cells on ONE item is ONE version, not three", () => {
    // The unit of the confirm-dialog line. Counting cells overstates by
    // exactly the locale count, on a warning about something irreversible.
    const counted = itemWillCreateVersion({
      hasApproved: true,
      hasDraft: false,
      writeLocales: ["en-US", "th", "id"],
      tickedLocales: ["en-US", "th", "id"],
    });
    expect(counted).toBe(true);
    expect(typeof counted).toBe("boolean"); // per ITEM, not a count of cells
  });
});
