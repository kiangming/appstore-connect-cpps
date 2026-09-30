/**
 * C1 — the preview route. Arc `[BULKIMPORT-loc-compare-apple]`.
 *
 * The assertions that matter here are about the UNREADABLE path, because that
 * is the one whose failure mode is silent: an error that arrives at the UI
 * looking like "Apple has nothing" ticks every cell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapSession = vi.hoisted(() => vi.fn());
const getActiveAccount = vi.hoisted(() => vi.fn());
const readVersionBaseline = vi.hoisted(() => vi.fn());

// ⚠ `vi.hoisted`, not a bare class declaration. `vi.mock` factories are hoisted
// above the module body, so a top-level `class` referenced inside one is still
// in its temporal dead zone when the factory runs.
const IapUnauthorizedError = vi.hoisted(
  () => class IapUnauthorizedError extends Error {},
);

vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession,
  IapUnauthorizedError,
}));
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));
vi.mock("@/lib/iap-management/apple/version-baseline", () => ({ readVersionBaseline }));
vi.mock("@/lib/iap-management/apple/fetch", () => ({
  withRetry: <T,>(fn: () => Promise<T>) => fn(),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

const req = (qs: string) =>
  new NextRequest(
    `http://localhost/api/iap-management/apps/app1/bulk-import/localization-baseline${qs}`,
  );

beforeEach(() => {
  requireIapSession.mockReset().mockResolvedValue(undefined);
  getActiveAccount.mockReset().mockResolvedValue({ id: "acc" });
  readVersionBaseline.mockReset();
});

describe("localization-baseline route", () => {
  it("returns the baseline rows and the two version facts", async () => {
    readVersionBaseline.mockResolvedValue({
      listing: { complete: true, versions: [] },
      approved: [{ id: "a", locale: "en-US", name: "N", description: "D" }],
      draft: [],
      hasApproved: true,
      hasDraft: false,
      readable: true,
    });

    const res = await GET(req("?appleIapId=iap-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.readable).toBe(true);
    expect(body.approved).toHaveLength(1);
    expect(body.hasApproved).toBe(true);
    expect(body.hasDraft).toBe(false);
    // ⚠ the raw listing is NOT serialised — the client has no business
    // choosing a write target.
    expect(body.listing).toBeUndefined();
  });

  it("⚠⚠ an Apple error becomes readable:false at 200 — never a 500, never empty-but-readable", async () => {
    // A 500 would make `fetch` reject and (depending on the caller) take the
    // whole step down. An `readable:true` with empty rows would read as "Apple
    // has nothing", tick every cell, and recreate the 409 incident.
    readVersionBaseline.mockRejectedValue(new Error("401 Unauthorized"));

    const res = await GET(req("?appleIapId=iap-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.readable).toBe(false);
    expect(body.approved).toEqual([]);
    expect(body.hasApproved).toBe(false);
    expect(body.reason).toMatch(/401/);
  });

  it("⚠ an incomplete version listing is passed through as readable:false", async () => {
    readVersionBaseline.mockResolvedValue({
      listing: { complete: false, versions: [] },
      approved: [],
      draft: [],
      hasApproved: false,
      hasDraft: false,
      readable: false,
    });
    const body = await (await GET(req("?appleIapId=iap-1"))).json();
    expect(body.readable).toBe(false);
  });

  it("⚠ a MISSING appleIapId is a 400, not an UNREADABLE", async () => {
    // Our bug, not Apple's. Dressing it as "Apple was unreachable" would hide a
    // client defect behind a sentence about Apple — on every cell at once.
    const res = await GET(req(""));
    expect(res.status).toBe(400);
    expect(readVersionBaseline).not.toHaveBeenCalled();
  });

  it("no session ⇒ 401 and Apple is never touched", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError("nope"));
    const res = await GET(req("?appleIapId=iap-1"));
    expect(res.status).toBe(401);
    expect(readVersionBaseline).not.toHaveBeenCalled();
  });

  it("⚠ the route never writes — it only reads the baseline", async () => {
    readVersionBaseline.mockResolvedValue({
      listing: { complete: true, versions: [] },
      approved: [], draft: [], hasApproved: false, hasDraft: false, readable: true,
    });
    await GET(req("?appleIapId=iap-1"));
    expect(readVersionBaseline).toHaveBeenCalledTimes(1);
  });
});
