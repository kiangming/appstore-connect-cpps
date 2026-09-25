/**
 * O1 — the hinge. These tests pin ONE property above all others:
 *
 *   ⭐⭐ **`POST` happens only when there is nothing to reuse.**
 *
 * `inAppPurchaseVersions` has no DELETE, so a POST that should not have
 * happened is a permanent artifact on a product that is currently selling.
 * Every other assertion here exists to keep that one honest — which is why the
 * creator is INJECTED and COUNTED rather than inspected.
 */
import { describe, it, expect, vi } from "vitest";
import {
  pickWriteTargetVersion,
  resolveWriteTargetVersion,
  WriteTargetRefused,
} from "./write-target-version";
import type { InAppPurchaseVersion } from "@/types/iap-management/apple";

const v = (id: string, state: string) =>
  ({ id, type: "inAppPurchaseVersions", attributes: { state } }) as InAppPurchaseVersion;

describe("pickWriteTargetVersion", () => {
  it("⭐ CA 2 — an existing draft is REUSED", () => {
    expect(pickWriteTargetVersion([v("a", "APPROVED"), v("b", "PREPARE_FOR_SUBMISSION")])).toEqual(
      { kind: "REUSE", versionId: "b" },
    );
  });

  it("⭐ CA 1 — live item with only an approved version ⇒ CREATE", () => {
    // The measured shape of mb30/mb68: one APPROVED version, no draft.
    expect(pickWriteTargetVersion([v("a", "APPROVED")])).toEqual({ kind: "CREATE" });
  });

  it("an IAP with no versions at all ⇒ CREATE", () => {
    expect(pickWriteTargetVersion([])).toEqual({ kind: "CREATE" });
  });

  it("ACCEPTED is not writable either — it is a passed review, not a draft", () => {
    expect(pickWriteTargetVersion([v("a", "ACCEPTED")])).toEqual({ kind: "CREATE" });
  });

  it("⚠⚠ READY_FOR_REVIEW is SUBMITTABLE but NOT writable — the two sets differ", () => {
    // `submit-v2.ts` accepts READY_FOR_REVIEW as a submit target. Reusing that
    // set here would aim an edit at a version Apple refuses to edit, and the
    // refusal would look exactly like the 409 this arc started from.
    const d = pickWriteTargetVersion([v("a", "APPROVED"), v("b", "READY_FOR_REVIEW")]);
    expect(d.kind).toBe("REFUSE");
    if (d.kind !== "REFUSE") return;
    expect(d.reason).toContain("review cycle is already under way");
  });

  it.each(["WAITING_FOR_REVIEW", "IN_REVIEW"])(
    "⚠ %s with no draft ⇒ REFUSE, never a second version",
    (state) => {
      const d = pickWriteTargetVersion([v("a", "APPROVED"), v("b", state)]);
      expect(d.kind).toBe("REFUSE");
    },
  );

  it("⭐ an in-flight version does NOT block a draft that also exists", () => {
    // Refusal is about having nowhere to write, not about the item being busy.
    expect(
      pickWriteTargetVersion([v("a", "IN_REVIEW"), v("b", "PREPARE_FOR_SUBMISSION")]),
    ).toEqual({ kind: "REUSE", versionId: "b" });
  });

  it("⚠⚠ TWO drafts ⇒ REFUSE — no winner is picked", () => {
    // Choosing one here is the `Map` last-wins bug this arc already fixed once
    // (KB §28.11.a), except irreversible.
    const d = pickWriteTargetVersion([
      v("b", "PREPARE_FOR_SUBMISSION"),
      v("c", "PREPARE_FOR_SUBMISSION"),
    ]);
    expect(d.kind).toBe("REFUSE");
    if (d.kind !== "REFUSE") return;
    expect(d.reason).toContain("refusing to guess");
  });

  it("REJECTED / DEVELOPER_REJECTED / REPLACED_WITH_NEW_VERSION are neither writable nor in flight", () => {
    for (const state of ["REJECTED", "DEVELOPER_REJECTED", "REPLACED_WITH_NEW_VERSION"]) {
      expect(pickWriteTargetVersion([v("a", state)])).toEqual({ kind: "CREATE" });
    }
  });

  it("a version with no state at all is not mistaken for a draft", () => {
    const noState = { id: "x", type: "inAppPurchaseVersions" } as unknown as InAppPurchaseVersion;
    expect(pickWriteTargetVersion([noState])).toEqual({ kind: "CREATE" });
  });
});

describe("resolveWriteTargetVersion — POST happens only when it must", () => {
  const mkDeps = (versions: InAppPurchaseVersion[]) => ({
    readVersions: vi.fn().mockResolvedValue(versions),
    createVersion: vi.fn().mockResolvedValue("new-version"),
    onCreate: vi.fn(),
  });

  it("⭐⭐ CA 2 — a draft exists ⇒ createVersion is NEVER called", () => {
    // This is the assertion the whole chunk exists for.
    const deps = mkDeps([v("a", "APPROVED"), v("b", "PREPARE_FOR_SUBMISSION")]);
    return resolveWriteTargetVersion("iap-1", deps).then((r) => {
      expect(r).toEqual({ versionId: "b", created: false });
      expect(deps.createVersion).not.toHaveBeenCalled();
      expect(deps.onCreate).not.toHaveBeenCalled();
    });
  });

  it("⭐ CA 1 — no draft ⇒ createVersion called EXACTLY ONCE", async () => {
    const deps = mkDeps([v("a", "APPROVED")]);
    const r = await resolveWriteTargetVersion("iap-1", deps);
    expect(r).toEqual({ versionId: "new-version", created: true });
    expect(deps.createVersion).toHaveBeenCalledTimes(1);
  });

  it("⚠ the creation is announced BEFORE and AFTER, both naming the IAP", async () => {
    // The version exists on Apple whether or not anything later succeeds, and
    // there is no DELETE — the log trail is the only way to find an orphan.
    const deps = mkDeps([v("a", "APPROVED")]);
    await resolveWriteTargetVersion("iap-1", deps);
    expect(deps.onCreate).toHaveBeenCalledTimes(2);
    const [beforeCall, afterCall] = deps.onCreate.mock.calls;
    expect(beforeCall[0]).toBe("before");
    expect(beforeCall[1]).toContain("iap=iap-1");
    expect(beforeCall[1]).toContain("no DELETE");
    expect(afterCall[0]).toBe("after");
    expect(afterCall[1]).toContain("new-version");
  });

  it("⚠⚠ REFUSE throws and creates NOTHING", async () => {
    const deps = mkDeps([
      v("b", "PREPARE_FOR_SUBMISSION"),
      v("c", "PREPARE_FOR_SUBMISSION"),
    ]);
    await expect(resolveWriteTargetVersion("iap-1", deps)).rejects.toBeInstanceOf(
      WriteTargetRefused,
    );
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("⚠ an in-flight refusal also creates nothing", async () => {
    const deps = mkDeps([v("a", "APPROVED"), v("b", "IN_REVIEW")]);
    await expect(resolveWriteTargetVersion("iap-1", deps)).rejects.toThrow(
      /review cycle/,
    );
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("the versions are read exactly once — no double round trip", async () => {
    const deps = mkDeps([v("a", "APPROVED")]);
    await resolveWriteTargetVersion("iap-1", deps);
    expect(deps.readVersions).toHaveBeenCalledTimes(1);
  });

  it("⚠ a read failure propagates and creates nothing", async () => {
    const deps = mkDeps([]);
    deps.readVersions = vi.fn().mockRejectedValue(new Error("429 rate limited"));
    await expect(resolveWriteTargetVersion("iap-1", deps)).rejects.toThrow("429");
    expect(deps.createVersion).not.toHaveBeenCalled();
  });
});
