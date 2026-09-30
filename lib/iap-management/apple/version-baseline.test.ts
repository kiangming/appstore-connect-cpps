/**
 * C1 — the shared baseline reader. Arc `[BULKIMPORT-loc-compare-apple]`.
 *
 * The assertions here are about WHICH VERSION the baseline comes from, because
 * that is the one thing the preview and the write must never disagree on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listInAppPurchaseVersions = vi.hoisted(() => vi.fn());
const listLocalizationsForVersion = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  listInAppPurchaseVersions,
  listLocalizationsForVersion,
}));

import { readVersionBaseline } from "./version-baseline";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds = { id: "acc" } as unknown as AscCredentials;
const run = <T,>(fn: () => Promise<T>) => fn();
const args = { creds, appleIapId: "iap-1", run };

const version = (id: string, state: string) => ({ id, attributes: { state } });
const loc = (id: string, locale: string, name: string, description: string) => ({
  id,
  attributes: { locale, name, description },
});

beforeEach(() => {
  listInAppPurchaseVersions.mockReset();
  listLocalizationsForVersion.mockReset();
});

describe("readVersionBaseline — which version is the baseline", () => {
  it("⭐ the baseline is the APPROVED version, not the draft", async () => {
    // KB §28.11.c: the approved row is what buyers see, so it is the only
    // honest answer to "does this need changing?".
    listInAppPurchaseVersions.mockResolvedValue({
      complete: true,
      versions: [version("v-draft", "PREPARE_FOR_SUBMISSION"), version("v-appr", "APPROVED")],
    });
    listLocalizationsForVersion
      .mockResolvedValueOnce({ data: [loc("a-en", "en-US", "Live", "LD")] })
      .mockResolvedValueOnce({ data: [loc("d-en", "en-US", "Draft", "DD")] });

    const out = await readVersionBaseline(args);

    expect(listLocalizationsForVersion).toHaveBeenNthCalledWith(1, creds, "v-appr");
    expect(out.approved).toEqual([
      { id: "a-en", locale: "en-US", name: "Live", description: "LD" },
    ]);
    expect(out.draft).toEqual([
      { id: "d-en", locale: "en-US", name: "Draft", description: "DD" },
    ]);
    expect(out.hasApproved).toBe(true);
    expect(out.hasDraft).toBe(true);
    expect(out.readable).toBe(true);
  });

  it("⚠ ACCEPTED also counts as approved — it did on the write path before this extraction", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      complete: true,
      versions: [version("v-acc", "ACCEPTED")],
    });
    listLocalizationsForVersion.mockResolvedValue({ data: [loc("x", "th", "N", "D")] });
    const out = await readVersionBaseline(args);
    expect(out.hasApproved).toBe(true);
    expect(listLocalizationsForVersion).toHaveBeenCalledWith(creds, "v-acc");
  });

  it("⚠ TWO drafts ⇒ draft is empty and hasDraft is false — the write path refuses that state anyway", async () => {
    // Reporting "has a draft" here would let the preview promise an in-place
    // edit that `pickWriteTargetVersion` is going to refuse.
    listInAppPurchaseVersions.mockResolvedValue({
      complete: true,
      versions: [
        version("v-appr", "APPROVED"),
        version("d1", "PREPARE_FOR_SUBMISSION"),
        version("d2", "PREPARE_FOR_SUBMISSION"),
      ],
    });
    listLocalizationsForVersion.mockResolvedValue({ data: [loc("a", "en-US", "N", "D")] });

    const out = await readVersionBaseline(args);

    expect(out.draft).toEqual([]);
    expect(out.hasDraft).toBe(false);
    // and neither draft was read — "the first one" is a row nobody chose
    expect(listLocalizationsForVersion).toHaveBeenCalledTimes(1);
  });

  it("an item that has never been live ⇒ approved empty, readable true", async () => {
    listInAppPurchaseVersions.mockResolvedValue({
      complete: true,
      versions: [version("d1", "PREPARE_FOR_SUBMISSION")],
    });
    listLocalizationsForVersion.mockResolvedValue({ data: [loc("d", "en-US", "N", "D")] });
    const out = await readVersionBaseline(args);
    expect(out.hasApproved).toBe(false);
    expect(out.approved).toEqual([]);
    expect(out.readable).toBe(true);
  });
});

describe("⚠⚠ readVersionBaseline — an incomplete listing is NOT an empty Apple", () => {
  it("complete:false ⇒ readable:false, and NO localization read is attempted", async () => {
    // We cannot know the version we would pick is the approved one; a later
    // page could hold another. A baseline read off an unverified version looks
    // authoritative and is not.
    listInAppPurchaseVersions.mockResolvedValue({
      complete: false,
      versions: [version("v-appr", "APPROVED")],
    });

    const out = await readVersionBaseline(args);

    expect(out.readable).toBe(false);
    expect(listLocalizationsForVersion).not.toHaveBeenCalled();
    expect(out.approved).toEqual([]);
    expect(out.draft).toEqual([]);
    expect(out.hasApproved).toBe(false);
    expect(out.hasDraft).toBe(false);
  });

  it("⭐ the listing is passed through WHOLE, flag intact", async () => {
    // The write path hands this to `resolveWriteTargetVersion`, which refuses
    // on `complete:false`. Flattening it to an array here is exactly how "could
    // not finish reading" becomes "there is no draft" (chunk 0).
    const listing = { complete: false, versions: [version("v", "APPROVED")] };
    listInAppPurchaseVersions.mockResolvedValue(listing);
    const out = await readVersionBaseline(args);
    expect(out.listing).toBe(listing);
    expect(out.listing.complete).toBe(false);
  });

  it("⚠ errors PROPAGATE — this module does not decide that a 401 means 'unreadable'", async () => {
    // The write path's caller reports Apple's real message. The PREVIEW route
    // is where one item failing must not break the step, so the catch lives
    // there — not here, where it would blur a true sentence into a vague one.
    listInAppPurchaseVersions.mockRejectedValue(new Error("401 Unauthorized"));
    await expect(readVersionBaseline(args)).rejects.toThrow("401");
  });
});
