/**
 * O3+O4 — the shared V2 localization sync.
 *
 * ⚠⚠ THE PARITY CLAIM IS THE HEADLINE, AND IT IS MEASURED AT ONE LAYER:
 *
 *   an item that is **not yet live** already has a `PREPARE_FOR_SUBMISSION`
 *   version (design doc §0 Q1, measured on 5 real IAPs) ⇒ **CA 2** ⇒ the sync
 *   REUSES it ⇒ **no `POST`** ⇒ behaviour identical to before this arc.
 *
 * That is what makes this rewrite safe to ship: the everyday path — creating
 * and editing IAPs that have never been reviewed — does not change at all. The
 * new behaviour appears only where the old code was BROKEN (a live item, where
 * it used to 409).
 *
 * ⚠ And the mutation that matters: make CA 2 create a version anyway and this
 * file must go RED. An unnecessary `POST` is a permanent artifact on a selling
 * product, because `inAppPurchaseVersions` has no DELETE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listInAppPurchaseVersions = vi.hoisted(() => vi.fn());
const listLocalizationsForVersion = vi.hoisted(() => vi.fn());
const createInAppPurchaseVersion = vi.hoisted(() => vi.fn());
const updateInAppPurchaseLocalizationV2 = vi.hoisted(() => vi.fn());
const createInAppPurchaseLocalizationV2 = vi.hoisted(() => vi.fn());
const deleteInAppPurchaseLocalizationV2 = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  listInAppPurchaseVersions,
  listLocalizationsForVersion,
  createInAppPurchaseVersion,
  updateInAppPurchaseLocalizationV2,
  createInAppPurchaseLocalizationV2,
  deleteInAppPurchaseLocalizationV2,
}));

import { syncLocalizationsToVersion } from "./localization-version-sync";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds = { id: "acc", name: "n" } as unknown as AscCredentials;
const logs: string[] = [];
const args = (over: Record<string, unknown> = {}) => ({
  creds,
  appleIapId: "iap-1",
  desired: [{ locale: "en-US", display_name: "New", description: "D" }],
  run: <T,>(fn: () => Promise<T>) => fn(),
  log: (m: string) => {
    logs.push(m);
  },
  ...over,
});

const version = (id: string, state: string) => ({ id, attributes: { state } });
const loc = (id: string, locale: string, name: string, description: string) => ({
  id,
  attributes: { locale, name, description },
});

beforeEach(() => {
  logs.length = 0;
  for (const m of [
    listInAppPurchaseVersions,
    listLocalizationsForVersion,
    createInAppPurchaseVersion,
    updateInAppPurchaseLocalizationV2,
    createInAppPurchaseLocalizationV2,
    deleteInAppPurchaseLocalizationV2,
  ]) {
    m.mockReset();
  }
  updateInAppPurchaseLocalizationV2.mockResolvedValue({ data: { id: "x" } });
  createInAppPurchaseLocalizationV2.mockResolvedValue({ data: { id: "new-loc" } });
  deleteInAppPurchaseLocalizationV2.mockResolvedValue(undefined);
});

describe("⭐⭐ PARITY — an item that is not yet live never creates a version", () => {
  it("CA 2: a draft exists ⇒ REUSE, and createInAppPurchaseVersion is NEVER called", async () => {
    // The everyday path. §0 Q1 measured that every READY_TO_SUBMIT IAP already
    // carries a PREPARE_FOR_SUBMISSION version, so this is what normal use
    // looks like — and it must behave exactly as it did before the rewrite.
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("d-en", "en-US", "Old", "D")],
    });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(out.versionCreated).toBe(false);
    expect(out.patched).toEqual(["en-US"]);
    expect(updateInAppPurchaseLocalizationV2).toHaveBeenCalledWith(creds, "d-en", {
      name: "New",
      description: "D",
    });
  });

  it("⭐ nothing to change ⇒ no version, no write, not even on a LIVE item", async () => {
    // The gate that stops CA 1 from POSTing an undeletable version for an item
    // whose file already matches what is live.
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-approved", "APPROVED")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("a-en", "en-US", "New", "D")],
    });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(updateInAppPurchaseLocalizationV2).not.toHaveBeenCalled();
    expect(out.skipped[0].reason).toBe("IDENTICAL_TO_LIVE");
    expect(out.versionCreated).toBe(false);
  });
});

describe("CA 1 — a live item with no draft", () => {
  it("⭐ creates a version, re-reads ITS rows, and PATCHes the copy", async () => {
    // KB §32.1: ASC does exactly this. And §32.2: the new version arrives with
    // copies of every approved locale under NEW ids — so the ids must be
    // re-read. Reusing the approved ids is the 409 this arc exists to remove.
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-approved", "APPROVED")],
    });
    listLocalizationsForVersion
      .mockResolvedValueOnce({ data: [loc("a-en", "en-US", "Old", "D")] }) // approved
      .mockResolvedValueOnce({ data: [loc("copy-en", "en-US", "Old", "D")] }); // new version
    createInAppPurchaseVersion.mockResolvedValue({ data: { id: "v-new" } });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseVersion).toHaveBeenCalledTimes(1);
    expect(out.versionCreated).toBe(true);
    expect(out.targetVersionId).toBe("v-new");
    // ⚠ The id written is the COPY's, never the approved row's.
    expect(updateInAppPurchaseLocalizationV2).toHaveBeenCalledWith(creds, "copy-en", {
      name: "New",
      description: "D",
    });
    expect(updateInAppPurchaseLocalizationV2).not.toHaveBeenCalledWith(
      creds,
      "a-en",
      expect.anything(),
    );
  });

  it("⚠⚠ the permanent creation is announced through the CALLER's log", async () => {
    // There is no DELETE endpoint; the log trail is the only remedy for an
    // orphan, so it must reach where a Manager greps rather than stop inside
    // the helper.
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-approved", "APPROVED")],
    });
    listLocalizationsForVersion
      .mockResolvedValueOnce({ data: [loc("a-en", "en-US", "Old", "D")] })
      .mockResolvedValueOnce({ data: [loc("copy-en", "en-US", "Old", "D")] });
    createInAppPurchaseVersion.mockResolvedValue({ data: { id: "v-new" } });

    await syncLocalizationsToVersion(args());

    expect(logs.some((l) => l.includes("LOCV2-VERSION-BEFORE") && l.includes("iap=iap-1"))).toBe(true);
    expect(logs.some((l) => l.includes("LOCV2-VERSION-AFTER") && l.includes("v-new"))).toBe(true);
    expect(logs.some((l) => l.includes("no DELETE"))).toBe(true);
  });
});

describe("⚠ REFUSE — a decision with a reason, not an unknown error", () => {
  it("two drafts ⇒ no write at all, and every intended locale carries the reason", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [
        version("v-approved", "APPROVED"),
        version("d1", "PREPARE_FOR_SUBMISSION"),
        version("d2", "PREPARE_FOR_SUBMISSION"),
      ],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("a-en", "en-US", "Old", "D")],
    });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(updateInAppPurchaseLocalizationV2).not.toHaveBeenCalled();
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].message).toContain("refusing to guess");
    expect(out.failures[0].message).toContain("Không có thay đổi nào được gửi lên Apple");
  });

  it("a review already in flight ⇒ refuses rather than creating a second version", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-approved", "APPROVED"), version("v-rev", "IN_REVIEW")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("a-en", "en-US", "Old", "D")],
    });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseVersion).not.toHaveBeenCalled();
    expect(out.failures[0].message).toContain("review cycle");
  });
});

describe("⚠ Q3 — delete is an ARGUMENT, not a branch", () => {
  it("bulk import passes no removeLocales ⇒ nothing is ever deleted", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("d-en", "en-US", "Old", "D"), loc("d-th", "th", "T", "DT")],
    });

    await syncLocalizationsToVersion(args());

    expect(deleteInAppPurchaseLocalizationV2).not.toHaveBeenCalled();
  });

  it("the form passes removeLocales ⇒ the TARGET version's row is deleted", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("d-en", "en-US", "Old", "D"), loc("d-th", "th", "T", "DT")],
    });

    const out = await syncLocalizationsToVersion(args({ removeLocales: ["th"] }));

    expect(deleteInAppPurchaseLocalizationV2).toHaveBeenCalledWith(creds, "d-th");
    expect(out.deleted).toEqual(["th"]);
  });

  it("a removal of a locale the version does not have is idempotent, not an error", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("d-en", "en-US", "New", "D")],
    });

    const out = await syncLocalizationsToVersion(
      args({ desired: [], removeLocales: ["th"] }),
    );

    expect(deleteInAppPurchaseLocalizationV2).not.toHaveBeenCalled();
    expect(out.deleted).toEqual(["th"]);
    expect(out.failures).toEqual([]);
  });
});

describe("per-locale failures", () => {
  it("a failed PATCH fails only that locale, and carries Apple's message", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({
      data: [loc("d-en", "en-US", "Old", "D"), loc("d-th", "th", "Old", "D")],
    });
    updateInAppPurchaseLocalizationV2
      .mockRejectedValueOnce(new Error("409 something"))
      .mockResolvedValueOnce({ data: { id: "d-th" } });

    const out = await syncLocalizationsToVersion(
      args({
        desired: [
          { locale: "en-US", display_name: "New", description: "D" },
          { locale: "th", display_name: "New", description: "D" },
        ],
      }),
    );

    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].locale).toBe("en-US");
    expect(out.failures[0].message).toContain("409 something");
    expect(out.patched).toEqual(["th"]);
  });

  it("a new locale is POSTed onto the target version, with its new id returned", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      data: [version("v-draft", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({ data: [] });

    const out = await syncLocalizationsToVersion(args());

    expect(createInAppPurchaseLocalizationV2).toHaveBeenCalledWith(creds, {
      versionId: "v-draft",
      locale: "en-US",
      name: "New",
      description: "D",
    });
    expect(out.created).toEqual([{ locale: "en-US", id: "new-loc" }]);
  });
});
