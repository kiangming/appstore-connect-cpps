/**
 * ⭐ O1 — **WHICH version may a localization edit be written into?**
 * Arc `[LOC-V2-model]`, chunk `[LOCV2-orchestrate]`.
 *
 * ⚠⚠ THIS IS THE HINGE OF THE WHOLE ARC, AND IT IS A HINGE FOR ONE REASON:
 * **checking for an existing draft BEFORE creating one is not an optimisation —
 * it is the only thing that avoids orphan versions.** An item that already has
 * a draft is written in place and creates NOTHING, so there is nothing that can
 * be orphaned. An item without one must `POST`, and that POST is permanent:
 * `inAppPurchaseVersions` has **no DELETE** (verified three ways — 8 paths,
 * no `_deleteInstance`, against a control group of 13 DELETEs on sibling
 * `*Version*` resources). A blind POST on an item that already had a draft
 * would be both redundant AND an irreversible artifact on a selling product.
 *
 * ─── WHAT IS MEASURED, AND WHERE ───────────────────────────────────────────
 *
 * ĐÃ ĐO (KB §32.1, DevTools capture of ASC on `com.pure3q.sea.mb30`): editing a
 * live IAP's localization makes ASC do exactly this —
 *   1. read the versions              2. **POST a new version**
 *   3. read the NEW version's locs    4. PATCH the copy
 * Apple populates the new version with a full COPY of every locale, new ids
 * (§32.2) — so this module never copies content, it only decides the target.
 *
 * ĐÃ ĐO (KB §31.11, §28.11): an item that already has a
 * `PREPARE_FOR_SUBMISSION` version is edited **in place**, no new version.
 *
 * ⇒ Two cases, both measured. This function is the thing that tells them apart.
 *
 * ─── ⚠⚠ THE SET BELOW IS NOT `SUBMITTABLE_VERSION_STATES` ──────────────────
 *
 * `submit-v2.ts:44` has a set that LOOKS like this one:
 *
 *     SUBMITTABLE_VERSION_STATES = { PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW }
 *
 * ⛔ **DO NOT REUSE IT HERE, AND DO NOT "UNIFY" THEM.** They answer different
 * questions about the same field:
 *   · *submittable* — may this version be attached to a review submission?
 *   · *writable*    — may its metadata still be edited?
 * `READY_FOR_REVIEW` is submittable and **NOT writable**: Apple's own words for
 * that state are *"The version belongs to a review submission and is waiting
 * for you to mark that submission `submitted`"*, and the IAP-status reference
 * says that while a product sits there *"you can edit only the reference name,
 * pricing, and availability"* (KB §31.2 — both quoted from
 * developer.apple.com, read byte-for-byte).
 *
 * ⚠ This is the §28.2 / §30.4 trap in its purest form: **two sets over the same
 * enum, for two different purposes.** Merging them would let an edit be aimed
 * at a version Apple will refuse — and the refusal would look exactly like the
 * 409 this whole arc started from.
 */
import type { InAppPurchaseVersion } from "@/types/iap-management/apple";

/** The ONLY state whose metadata Apple still accepts edits for. */
const WRITABLE_VERSION_STATE = "PREPARE_FOR_SUBMISSION";

/**
 * States that mean a review cycle is already under way.
 *
 * ⚠ Creating a SECOND version while one of these is in flight is **CHƯA ĐO**,
 * and the circumstantial evidence points the wrong way: design doc §0 Q3
 * records that the sibling `AppStoreVersion` resource rejects a second
 * in-flight version. Since the POST is irreversible, the unmeasured case
 * REFUSES rather than guesses (CLAUDE.md: prefer a missed signal over a wrong
 * one). This is also ca N of the situation matrix, which §31.2 gave a
 * documentary basis.
 */
const IN_FLIGHT_VERSION_STATES = new Set([
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
]);

export type WriteTargetDecision =
  /** A draft already exists — write into it. Creates nothing. */
  | { kind: "REUSE"; versionId: string }
  /** No draft and nothing in flight — a version must be created. */
  | { kind: "CREATE" }
  /** Refuse, with a reason a Manager can act on. Creates nothing. */
  | { kind: "REFUSE"; reason: string };

/**
 * Pure decision — no Apple I/O, so every branch is unit-testable without
 * touching a live product.
 *
 * ⚠ `REFUSE` IS A FIRST-CLASS OUTCOME, NOT AN ERROR PATH. Each refusal below
 * is a case where writing would be a guess, and a guess here is irreversible:
 *
 *   · more than one draft — Apple's behaviour with two drafts is CHƯA ĐO, and
 *     picking one is exactly the `Map` last-wins bug this arc already fixed
 *     once (`pickPatchTarget`, KB §28.11.a). Choose nothing, say so.
 *   · in flight, no draft   — a review cycle is running; see above.
 */
export function pickWriteTargetVersion(
  versions: ReadonlyArray<InAppPurchaseVersion>,
): WriteTargetDecision {
  const drafts = versions.filter(
    (v) => v.attributes?.state === WRITABLE_VERSION_STATE,
  );

  if (drafts.length === 1) {
    return { kind: "REUSE", versionId: drafts[0].id };
  }
  if (drafts.length > 1) {
    return {
      kind: "REFUSE",
      reason:
        `${drafts.length} versions are in ${WRITABLE_VERSION_STATE} ` +
        `(${drafts.map((d) => d.id).join(", ")}) — refusing to guess which one ` +
        `an edit belongs in`,
    };
  }

  const inFlight = versions.filter((v) =>
    IN_FLIGHT_VERSION_STATES.has(v.attributes?.state ?? ""),
  );
  if (inFlight.length > 0) {
    return {
      kind: "REFUSE",
      reason:
        `a review cycle is already under way ` +
        `(${inFlight.map((v) => `${v.id}:${v.attributes.state}`).join(", ")}) ` +
        `— Apple accepts only reference name, pricing and availability while a ` +
        `product is in review, and creating a second version in this state has ` +
        `never been measured`,
    };
  }

  return { kind: "CREATE" };
}

export interface ResolvedWriteTarget {
  versionId: string;
  /** True when this call POSTed a version — i.e. a permanent Apple artifact. */
  created: boolean;
}

/**
 * The I/O half. Reads the versions, decides, and creates one ONLY when the
 * decision says so.
 *
 * ⚠ `createVersion` IS INJECTED, and so is `readVersions` — not for test
 * convenience but because this function's contract is *"POSTs at most once,
 * and only in the CREATE branch"*, and injection is what lets a test COUNT the
 * calls instead of trusting the shape of the code.
 *
 * ⚠ THE CREATION IS ANNOUNCED TWICE — before and after — and both lines carry
 * the IAP id. Same discipline as `submit-v2.ts:124-137`: the version now exists
 * on Apple whether or not anything after this point succeeds, so a later
 * failure must leave a greppable trail pointing at the artifact. An orphan
 * nobody can name is an orphan nobody can clean up (and there is no DELETE to
 * clean it up WITH — the trail is the only remedy).
 *
 * Throws on REFUSE so the caller's per-row error handling reports it like any
 * other Apple-side refusal, with the reason intact.
 */
export class WriteTargetRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WriteTargetRefused";
  }
}

export interface ResolveWriteTargetDeps {
  readVersions: () => Promise<ReadonlyArray<InAppPurchaseVersion>>;
  createVersion: () => Promise<string>;
  onCreate?: (phase: "before" | "after", detail: string) => Promise<void> | void;
}

export async function resolveWriteTargetVersion(
  appleIapId: string,
  deps: ResolveWriteTargetDeps,
): Promise<ResolvedWriteTarget> {
  const versions = await deps.readVersions();
  const decision = pickWriteTargetVersion(versions);

  if (decision.kind === "REFUSE") {
    throw new WriteTargetRefused(decision.reason);
  }
  if (decision.kind === "REUSE") {
    // ⭐ THE WHOLE POINT: this path creates nothing, so nothing can be orphaned.
    return { versionId: decision.versionId, created: false };
  }

  await deps.onCreate?.(
    "before",
    `iap=${appleIapId} no ${WRITABLE_VERSION_STATE} version — creating one ` +
      `(PERMANENT: inAppPurchaseVersions has no DELETE)`,
  );
  const versionId = await deps.createVersion();
  await deps.onCreate?.("after", `iap=${appleIapId} created version id=${versionId}`);
  return { versionId, created: true };
}
