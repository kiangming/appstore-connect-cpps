/**
 * ⭐ C1 — **the ONE definition of "what is this IAP's baseline?"**
 * Arc `[BULKIMPORT-loc-compare-apple]`.
 *
 * ⚠⚠ THIS EXISTS BECAUSE A SECOND READER WOULD BE A SECOND TWIN PATH.
 * Two surfaces now need the same answer:
 *
 *   · `syncLocalizationsToVersion` — at WRITE time, to decide what to send.
 *   · the Bulk Import preview route — at PREVIEW time, to decide which cells
 *     the Manager sees ticked.
 *
 * Those two must agree about **which version is "the one customers see"**, or
 * the preview promises one thing and the write does another. Re-implementing
 * the selection in the route would have left two copies of a rule — the exact
 * shape CLAUDE.md meta-rule P1 forbids and the exact shape `[LOC-V2-model]`
 * spent an arc removing (KB §32.12). They now agree by construction.
 *
 * ─── THE RULE, LIFTED VERBATIM FROM THE WRITE PATH ─────────────────────────
 *
 *   BASELINE = the APPROVED version's localizations. What buyers see today,
 *              and therefore the only honest answer to "does this need
 *              changing?" (KB §28.11.c).
 *   DRAFT    = the pending version's localizations, read **only when there is
 *              exactly one**. With two, `pickWriteTargetVersion` refuses
 *              anyway, and seeding a comparison from "the first one" would be
 *              reading a row nobody chose.
 *
 * ⚠ `ACCEPTED` COUNTS AS APPROVED, and that is not a typo. It was in the write
 * path before this extraction and moving it would silently change which row is
 * the baseline for items in that state.
 *
 * ─── ⚠⚠ WHAT THIS FUNCTION DOES **NOT** DO: SWALLOW ERRORS ────────────────
 *
 * Exceptions propagate. This is a faithful extraction of the write path, and
 * the write path's caller (`execute/route.ts`, `update-orchestration.ts`) has
 * its own per-row error handling that reports Apple's actual message. Turning a
 * 401 into `readable: false` here would replace a true sentence ("Apple said
 * unauthorized") with a vaguer one, on a path where nobody asked for that.
 *
 * ⇒ The PREVIEW route catches instead — because there, and only there, one
 *   item failing must not break the step. Same axis, decided where the
 *   requirement actually lives.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import { listInAppPurchaseVersions, listLocalizationsForVersion } from "./client";
import {
  toVersionLocalizations,
  type VersionLocalization,
} from "../bulk-import/localization-version-plan";
import type { VersionListing } from "@/types/iap-management/apple";

/**
 * ⚠ KEPT IN SYNC WITH NOTHING — these are the only copies. They used to live
 * inline in `localization-version-sync.ts`; if you are about to write a second
 * pair somewhere, that is the bug this module was extracted to prevent.
 */
const APPROVED_STATES = new Set(["APPROVED", "ACCEPTED"]);
const DRAFT_STATE = "PREPARE_FOR_SUBMISSION";

export interface VersionBaselineRead {
  /**
   * The raw listing, passed through whole.
   * ⚠ A caller that must choose a WRITE target needs it **with its `complete`
   * flag intact** — stripping it down to an array here is how "we could not
   * finish reading" would quietly become "there is no draft" (chunk 0).
   */
  listing: VersionListing;
  /** The APPROVED version's rows. Empty when the item has never been live. */
  approved: VersionLocalization[];
  /** The single pending draft's rows, or empty. */
  draft: VersionLocalization[];
  hasApproved: boolean;
  hasDraft: boolean;
  /**
   * ⚠⚠ `false` ⇒ **we do not know**, NEVER "there is nothing on Apple".
   * Reading it as the latter turns every cell into "chưa có trên Apple", ticks
   * them all, and recreates the 409 the previous arc existed to remove.
   */
  readable: boolean;
}

export async function readVersionBaseline(args: {
  creds: AscCredentials;
  appleIapId: string;
  /** Retry / rate-counter wrapper. Bulk import, the form and the route each
   *  pass their own — the reads are identical, the accounting is not. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<VersionBaselineRead> {
  const { creds, appleIapId, run } = args;

  const listing = await run(() => listInAppPurchaseVersions(creds, appleIapId));

  // ⭐ SHORT-CIRCUIT ON AN INCOMPLETE LISTING, AND IT IS NOT AN OPTIMISATION.
  // If the enumeration could not be finished we cannot know that the version we
  // would pick IS the approved one — a later page could hold another. Reading
  // localizations off a version we are not sure about produces a baseline that
  // looks authoritative and is not. Two requests saved is the side effect.
  if (!listing.complete) {
    return {
      listing,
      approved: [],
      draft: [],
      hasApproved: false,
      hasDraft: false,
      readable: false,
    };
  }

  const versions = listing.versions;
  const approvedVersion = versions.find((v) =>
    APPROVED_STATES.has(v.attributes?.state),
  );
  const draftVersions = versions.filter(
    (v) => v.attributes?.state === DRAFT_STATE,
  );

  const approved = approvedVersion
    ? toVersionLocalizations(
        (await run(() => listLocalizationsForVersion(creds, approvedVersion.id)))
          .data ?? [],
      )
    : [];
  const draft =
    draftVersions.length === 1
      ? toVersionLocalizations(
          (await run(() =>
            listLocalizationsForVersion(creds, draftVersions[0].id),
          )).data ?? [],
        )
      : [];

  return {
    listing,
    approved,
    draft,
    hasApproved: approvedVersion !== undefined,
    // ⚠ "has a draft" means "has exactly ONE draft". Two drafts is a state the
    // write path REFUSES, so reporting it as "has a draft" would let the
    // preview promise an in-place edit that will not happen.
    hasDraft: draftVersions.length === 1,
    readable: true,
  };
}
