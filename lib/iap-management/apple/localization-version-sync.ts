/**
 * ⭐ O3+O4 — the ONE place localization edits reach Apple under the V2 model.
 * Arc `[LOC-V2-model]`, chunk `[LOCV2-orchestrate]`.
 *
 * ⚠⚠ THIS IS THE TWIN-PATH FIX, AND IT IS A SHARED FUNCTION RATHER THAN TWO
 * SYMMETRICAL EDITS — ON PURPOSE. Bulk import (`execute/route.ts`) and the
 * single-IAP form (`update-orchestration.ts`) both wrote localizations, both
 * through the V1 model, and CLAUDE.md meta-rule P1 says the fix for that is one
 * choke point, not N patches kept in step by hand. Editing both call sites
 * symmetrically would have left two copies of a four-step Apple protocol that
 * must agree about version selection forever. They now agree by construction.
 *
 * ⚠ `[LOC-ACTIVE-state-single]` was the backlog entry predicting exactly this:
 * the form had the same hole as bulk import and nobody had hit it yet only
 * because nobody had edited a live item's localization through the form.
 *
 * ─── THE FOUR STEPS (KB §32.1, measured from ASC's own network traffic) ────
 *
 *   1. read the versions and their localizations
 *   2. compare against the APPROVED baseline → is a write needed AT ALL?
 *   3. only if so: resolve a writable version — reuse a draft, else POST one
 *   4. PATCH / POST localizations on THAT version
 *
 * ⭐ Step 2 before step 3 is the whole safety property. In CA 1 step 3 `POST`s
 * a version that **cannot be deleted** (`inAppPurchaseVersions` has no DELETE,
 * verified three ways), so an item whose file already matches what is live must
 * never reach step 3. Comparing first is what makes that true.
 *
 * ⚠ DELETE IS AN ARGUMENT, NOT A BRANCH. `removeLocales` is passed by the form
 * (where removing a locale is an explicit act) and NOT passed by bulk import
 * (Q3: "the file does not list locale X" ≠ "delete locale X"). The difference
 * between the two surfaces is one parameter at the call site rather than a fork
 * in here — so it is visible where the decision is made.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listInAppPurchaseVersions,
  listLocalizationsForVersion,
  createInAppPurchaseVersion,
  updateInAppPurchaseLocalizationV2,
  createInAppPurchaseLocalizationV2,
  deleteInAppPurchaseLocalizationV2,
} from "./client";
import {
  resolveWriteTargetVersion,
  WriteTargetRefused,
} from "./write-target-version";
import {
  planLocalizationWrites,
  resolveWriteOps,
  describeWriteTargetRefusal,
  type DesiredLocalization,
  type SkippedLocale,
  type VersionLocalization,
} from "../bulk-import/localization-version-plan";
import type { InAppPurchaseVersion } from "@/types/iap-management/apple";

const APPROVED_STATES = new Set(["APPROVED", "ACCEPTED"]);
const DRAFT_STATE = "PREPARE_FOR_SUBMISSION";

export interface LocalizationSyncFailure {
  locale: string;
  message: string;
}

export interface LocalizationVersionSyncResult {
  /** Locales deliberately not written, each with the Manager-facing reason. */
  skipped: SkippedLocale[];
  /** Locales PATCHed successfully. */
  patched: string[];
  /**
   * Locales POSTed onto the target version, WITH the new Apple id.
   * ⚠ The id is carried because the form's audit row records it — returning
   * only the locale would have quietly dropped a field that was already being
   * written before this rewrite.
   */
  created: Array<{ locale: string; id: string }>;
  /** Locales deleted (form only — bulk import never passes `removeLocales`). */
  deleted: string[];
  failures: LocalizationSyncFailure[];
  /** ⚠ True when a PERMANENT version was created on Apple by this call. */
  versionCreated: boolean;
  /** The version written to, when anything was written. */
  targetVersionId?: string;
}

export interface LocalizationVersionSyncArgs {
  creds: AscCredentials;
  appleIapId: string;
  desired: ReadonlyArray<DesiredLocalization>;
  /**
   * Locales to remove. **Bulk import must not pass this** (Q3). The form does,
   * because there "remove this locale" is something a human clicked.
   */
  removeLocales?: ReadonlyArray<string>;
  /**
   * Wraps every Apple call — retry, rate counters, whatever the caller uses.
   * Bulk import passes its `trackedWithRetry`; the form passes `withRetry`.
   */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Where the caller's log lines go, so the trail lands where it is grepped. */
  log: (message: string, level?: "INFO" | "WARN") => Promise<void> | void;
}

function toRows(
  rows: ReadonlyArray<{ id: string; attributes?: { locale?: string; name?: string; description?: string } }>,
): VersionLocalization[] {
  return rows.map((r) => ({
    id: r.id,
    locale: r.attributes?.locale ?? "",
    name: r.attributes?.name ?? "",
    description: r.attributes?.description ?? "",
  }));
}

export async function syncLocalizationsToVersion(
  args: LocalizationVersionSyncArgs,
): Promise<LocalizationVersionSyncResult> {
  const { creds, appleIapId, desired, run } = args;
  const failures: LocalizationSyncFailure[] = [];
  const patched: string[] = [];
  const created: Array<{ locale: string; id: string }> = [];
  const deleted: string[] = [];

  // ── Step 1 — versions, then each one's localizations ────────────────────
  // ⚠ Two-stage on purpose: the V2 relationship pointer truncates at 10 IDs
  // (KB §4.1 LANDMARK) and a short read here would look like "this locale is
  // not on Apple", turning a PATCH into a POST.
  const versionsRes = await run(() => listInAppPurchaseVersions(creds, appleIapId));
  const versions = (versionsRes.data ?? []) as InAppPurchaseVersion[];

  const approvedVersion = versions.find((v) => APPROVED_STATES.has(v.attributes?.state));
  const draftVersions = versions.filter((v) => v.attributes?.state === DRAFT_STATE);

  const approved = approvedVersion
    ? toRows((await run(() => listLocalizationsForVersion(creds, approvedVersion.id))).data ?? [])
    : [];
  // ⚠ Only read a draft when there is exactly one. With two, O1 refuses anyway,
  // and reading "the first" would seed the comparison from a row nobody chose.
  const draft =
    draftVersions.length === 1
      ? toRows((await run(() => listLocalizationsForVersion(creds, draftVersions[0].id))).data ?? [])
      : [];

  // ── Step 2 — does anything need writing AT ALL? ─────────────────────────
  const plan = planLocalizationWrites({ approved, draft, desired });
  const removals = args.removeLocales ?? [];

  if (!plan.needsWrite && removals.length === 0) {
    // ⭐ NOTHING IS CREATED HERE. This is the branch that keeps CA 1 from
    // POSTing an undeletable version for an item that needed no change.
    return {
      skipped: plan.skipped,
      patched,
      created,
      deleted,
      failures,
      versionCreated: false,
    };
  }

  // ── Step 3 — resolve a writable version (may POST) ──────────────────────
  let target: { versionId: string; created: boolean };
  try {
    target = await resolveWriteTargetVersion(appleIapId, {
      readVersions: async () => versions,
      createVersion: async () => {
        const res = await run(() => createInAppPurchaseVersion(creds, appleIapId));
        return res.data.id;
      },
      // ⚠ THE TRAIL LEAVES THIS MODULE. The created version is permanent and
      // there is no DELETE, so "which item, which version id" has to reach the
      // caller's log — where a Manager actually greps — and not stop here.
      onCreate: (phase, detail) =>
        args.log(`LOCV2-VERSION-${phase.toUpperCase()} ${detail}`, "WARN"),
    });
  } catch (err) {
    if (err instanceof WriteTargetRefused) {
      // ⚠⚠ NOT a generic catch. A refusal is a decision with a reason, and it
      // must read as "deliberately not written" rather than "unknown error".
      const intended = [
        ...plan.toWrite.map((w) => w.locale),
        ...removals,
      ];
      failures.push(...describeWriteTargetRefusal(intended, err.message));
      await args.log(
        `LOCV2-REFUSED iap=${appleIapId} ${err.message}`,
        "WARN",
      );
      return { skipped: plan.skipped, patched, created, deleted, failures, versionCreated: false };
    }
    throw err;
  }

  // ── Step 4 — write onto THAT version ────────────────────────────────────
  // A freshly created version carries copies of every approved locale with NEW
  // ids (KB §32.2), so its rows must be re-read — the approved ids are wrong
  // here, and using them is exactly the 409 this arc removes.
  const targetRows = target.created
    ? toRows((await run(() => listLocalizationsForVersion(creds, target.versionId))).data ?? [])
    : draft.length > 0
      ? draft
      : toRows((await run(() => listLocalizationsForVersion(creds, target.versionId))).data ?? []);

  const ops = resolveWriteOps(plan.toWrite, targetRows);

  for (const p of ops.toPatch) {
    try {
      await run(() =>
        updateInAppPurchaseLocalizationV2(creds, p.id, {
          name: p.name,
          description: p.description,
        }),
      );
      patched.push(p.locale);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ locale: p.locale, message: `${p.locale}: ${message}` });
      await args.log(`patch loc ${p.locale} on iap=${appleIapId}: ${message}`, "WARN");
    }
  }

  for (const c of ops.toCreate) {
    try {
      const res = await run(() =>
        createInAppPurchaseLocalizationV2(creds, {
          versionId: target.versionId,
          locale: c.locale,
          name: c.name,
          description: c.description,
        }),
      );
      created.push({ locale: c.locale, id: res.data.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ locale: c.locale, message: `${c.locale}: ${message}` });
      await args.log(`create loc ${c.locale} on iap=${appleIapId}: ${message}`, "WARN");
    }
  }

  // ⚠ Deletes target the WRITABLE version's rows, never the approved ones —
  // the same rule as the patches, for the same reason.
  const targetByLocale = new Map(targetRows.map((r) => [r.locale, r]));
  for (const locale of removals) {
    const row = targetByLocale.get(locale);
    if (!row) {
      // Already absent on the version being written — idempotent, not an error.
      deleted.push(locale);
      continue;
    }
    try {
      await run(() => deleteInAppPurchaseLocalizationV2(creds, row.id));
      deleted.push(locale);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ locale, message: `${locale}: ${message}` });
      await args.log(`delete loc ${locale} on iap=${appleIapId}: ${message}`, "WARN");
    }
  }

  return {
    skipped: plan.skipped,
    patched,
    created,
    deleted,
    failures,
    versionCreated: target.created,
    targetVersionId: target.versionId,
  };
}
