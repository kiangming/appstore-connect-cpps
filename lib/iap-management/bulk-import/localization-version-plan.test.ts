/**
 * O2 — the version-aware planner.
 *
 * ⚠ THE TWO EXPENSIVE MISTAKES THIS PINS:
 *
 *   · writing when nothing needs writing → on CA 1 that means `POST`ing a
 *     version that CANNOT BE DELETED, onto a product that is currently selling
 *   · writing to the wrong version's row → that is literally the
 *     `409 IAP_VERSION_UNMODIFIABLE` this arc exists to remove
 *
 * Everything below is one of those two, or the Q3/Q4/Q5 decisions that shape
 * them.
 */
import { describe, it, expect } from "vitest";
import {
  planLocalizationWrites,
  resolveWriteOps,
  describeWriteTargetRefusal,
  SKIP_LABELS,
  type VersionLocalization,
} from "./localization-version-plan";

const row = (id: string, locale: string, name: string, description: string): VersionLocalization => ({
  id,
  locale,
  name,
  description,
});
const want = (locale: string, display_name: string, description: string) => ({
  locale,
  display_name,
  description,
});

describe("planLocalizationWrites — what needs writing at all", () => {
  it("content differs from live ⇒ write", () => {
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "6 Ticket", "D")],
      draft: [],
      desired: [want("en-US", "6 Tickets", "D")],
    });
    expect(p.needsWrite).toBe(true);
    expect(p.toWrite).toHaveLength(1);
    expect(p.skipped).toEqual([]);
  });

  it("a locale Apple has never seen ⇒ write", () => {
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "X", "D")],
      draft: [],
      desired: [want("th", "T", "DT")],
    });
    expect(p.toWrite.map((w) => w.locale)).toEqual(["th"]);
  });

  // ─── ca B ─────────────────────────────────────────────────────────────────

  it("⭐⭐ ca B — identical to live ⇒ skip, and needsWrite is FALSE", () => {
    // needsWrite === false is the gate that stops CA 1 from POSTing a version
    // that can never be deleted. This is the single most consequential
    // assertion in the file.
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "6 Ticket", "D")],
      draft: [],
      desired: [want("en-US", "6 Ticket", "D")],
    });
    expect(p.needsWrite).toBe(false);
    expect(p.toWrite).toEqual([]);
    expect(p.skipped[0].reason).toBe("IDENTICAL_TO_LIVE");
    expect(p.skipped[0].label).toBe("Giống bản đang bán — không có gì để đổi");
  });

  it("ca B still holds when a draft exists carrying the SAME content", () => {
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "X", "D")],
      draft: [row("d1", "en-US", "X", "D")],
      desired: [want("en-US", "X", "D")],
    });
    expect(p.skipped[0].reason).toBe("IDENTICAL_TO_LIVE");
  });

  // ─── the re-run case ──────────────────────────────────────────────────────

  it("⭐⭐ file matches the PENDING draft ⇒ skip — the re-run guard", () => {
    // The Manager re-ran the failed import three times during the incident, so
    // this is the second run of every batch, not an edge case. Under V2 the
    // write target is the draft's row, so re-sending what it already has is a
    // no-op that costs a request.
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "6 Ticket", "D")],
      draft: [row("d1", "en-US", "6 Tickets", "D")],
      desired: [want("en-US", "6 Tickets", "D")],
    });
    expect(p.needsWrite).toBe(false);
    expect(p.skipped[0].reason).toBe("ALREADY_IN_DRAFT");
    expect(p.skipped[0].label).toBe("Bản nháp đã mang thay đổi này — đang chờ duyệt");
  });

  // ─── the third case ───────────────────────────────────────────────────────

  it("⚠⚠ file matches live but a DIFFERENT change is pending ⇒ its own reason", () => {
    // Same action as ca B, different fact about the world: this item HAS a
    // change waiting for Apple. Collapsing the two labels would delete exactly
    // the information the Manager would otherwise open ASC to find.
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "6 Ticket", "D")],
      draft: [row("d1", "en-US", "SOMETHING ELSE", "D")],
      desired: [want("en-US", "6 Ticket", "D")],
    });
    expect(p.needsWrite).toBe(false);
    expect(p.skipped[0].reason).toBe("LIVE_MATCHES_BUT_DRAFT_DIFFERS");
    expect(p.skipped[0].label).not.toBe(SKIP_LABELS.IDENTICAL_TO_LIVE);
    expect(p.skipped[0].label).toContain("bản nháp");
  });

  it("⚠ the three skip labels are all different — the whole point of having three", () => {
    const labels = Object.values(SKIP_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // ─── Q3 ───────────────────────────────────────────────────────────────────

  it("⚠⚠ Q3 — a locale on Apple but absent from the file produces NOTHING", () => {
    // Not a delete, not a write, not a skip entry: the file simply did not
    // mention it. "File does not list locale X" ≠ "delete locale X".
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "X", "D"), row("a2", "th", "T", "DT")],
      draft: [],
      desired: [want("en-US", "X2", "D")],
    });
    expect(p.toWrite.map((w) => w.locale)).toEqual(["en-US"]);
    expect(p.skipped).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("th");
    expect(p).not.toHaveProperty("toDelete");
  });

  // ─── Q5 ───────────────────────────────────────────────────────────────────

  it("⭐ Q5 — NFD in the file vs NFC on Apple is NOT a change", () => {
    // Without this, a cell that truly matches would be classified as changed —
    // and on CA 1 that costs a permanent version plus a review cycle for an
    // edit that does not exist.
    const live = "V\u00e0ng"; // precomposed — 4 code points
    const file = "Va\u0300ng"; // decomposed — 5 code points
    // ⚠ TRIPWIRE. Written as escapes and asserted, because a literal typed
    // in NFD gets silently recomposed by editors, formatters and shell
    // heredocs — it happened twice while writing this arc. Recomposed, this
    // test would compare NFC against NFC and pass for the wrong reason.
    expect(live.length).toBe(4);
    expect(file.length).toBe(5);

    const p = planLocalizationWrites({
      approved: [row("a1", "vi", live, "D")],
      draft: [],
      desired: [want("vi", file, "D")],
    });
    expect(p.needsWrite).toBe(false);
    expect(p.skipped[0].reason).toBe("IDENTICAL_TO_LIVE");
  });

  it("⚠ but a real edit next to a different encoding is still a real edit", () => {
    const file = "Va\u0300ng."; // decomposed AND a full stop — 6 code points
    expect(file.length).toBe(6);
    const p = planLocalizationWrites({
      approved: [row("a1", "vi", "V\u00e0ng", "D")],
      draft: [],
      desired: [want("vi", file, "D")],
    });
    expect(p.needsWrite).toBe(true);
  });

  it("an empty desired list writes nothing", () => {
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "X", "D")],
      draft: [],
      desired: [],
    });
    expect(p.needsWrite).toBe(false);
    expect(p.skipped).toEqual([]);
  });

  it("mixed: one writes, one skips, and both are reported", () => {
    const p = planLocalizationWrites({
      approved: [row("a1", "en-US", "X", "D"), row("a2", "th", "T", "DT")],
      draft: [],
      desired: [want("en-US", "X", "D"), want("th", "T2", "DT")],
    });
    expect(p.toWrite.map((w) => w.locale)).toEqual(["th"]);
    expect(p.skipped.map((s) => s.locale)).toEqual(["en-US"]);
    expect(p.needsWrite).toBe(true);
  });
});

describe("resolveWriteOps — mapping writes onto the TARGET version", () => {
  it("⭐ ids come from the WRITABLE version, never the approved one", () => {
    // PATCHing an approved version's id is the 409 this arc exists to remove.
    const ops = resolveWriteOps(
      [want("en-US", "New", "D")],
      [row("draft-en", "en-US", "Old", "D")],
    );
    expect(ops.toPatch).toEqual([
      { id: "draft-en", locale: "en-US", name: "New", description: "D" },
    ]);
    expect(ops.toCreate).toEqual([]);
  });

  it("a locale the target version does not have ⇒ POST", () => {
    const ops = resolveWriteOps([want("th", "T", "DT")], [row("d1", "en-US", "X", "D")]);
    expect(ops.toPatch).toEqual([]);
    expect(ops.toCreate).toEqual([{ locale: "th", name: "T", description: "DT" }]);
  });

  it("⭐ CA 1 — Apple copies the locales into a new version, so it PATCHes", () => {
    // KB §32.2: a freshly POSTed version already carries every approved locale
    // with NEW ids. So the common CA-1 path is a PATCH against those new ids,
    // not a POST — and the tool never copies content itself.
    const ops = resolveWriteOps(
      [want("en-US", "New", "D")],
      [row("copy-en", "en-US", "Old", "D"), row("copy-th", "th", "T", "DT")],
    );
    expect(ops.toPatch[0].id).toBe("copy-en");
    expect(ops.toCreate).toEqual([]);
  });

  it("⚠⚠ Q5 — the payload is the file's bytes, NOT the comparison key", () => {
    // If this ever passes through `localizationComparisonKey`, the Manager's
    // text gets silently re-encoded on its way to Apple.
    const nfd = "Va\u0300ng"; // decomposed — 5 code points
    expect(nfd.length).toBe(5);
    const ops = resolveWriteOps([want("vi", nfd, nfd)], [row("d1", "vi", "x", "y")]);
    expect(ops.toPatch[0].name).toBe(nfd);
    expect(ops.toPatch[0].name.length).toBe(5);
    expect(ops.toPatch[0].description).toBe(nfd);
  });

  it("⚠ Q5 applies to the POST path too", () => {
    const nfd = "Va\u0300ng";
    expect(nfd.length).toBe(5);
    const ops = resolveWriteOps([want("vi", nfd, nfd)], []);
    expect(ops.toCreate[0].name).toBe(nfd);
    expect(ops.toCreate[0].name.length).toBe(5);
  });

  it("nothing to write ⇒ no ops at all", () => {
    const ops = resolveWriteOps([], [row("d1", "en-US", "X", "D")]);
    expect(ops).toEqual({ toPatch: [], toCreate: [] });
  });
});

describe("describeWriteTargetRefusal — a refusal must not read as an unknown error", () => {
  it("⚠⚠ every intended locale gets the REASON, not a generic failure", () => {
    const out = describeWriteTargetRefusal(
      ["en-US", "th"],
      "2 versions are in PREPARE_FOR_SUBMISSION",
    );
    expect(out).toHaveLength(2);
    expect(out[0].locale).toBe("en-US");
    expect(out[0].message).toContain("2 versions are in PREPARE_FOR_SUBMISSION");
    // And it must say the write did NOT happen — a refusal that reads as
    // "maybe it went through" is worse than no message.
    expect(out[0].message).toContain("Không có thay đổi nào được gửi");
  });

  it("no intended locales ⇒ no messages invented", () => {
    expect(describeWriteTargetRefusal([], "whatever")).toEqual([]);
  });
});
