/**
 * ⏳⚠ TEMPORARY INSTRUMENTATION FOR A **WRITE**. DELETE ONCE IT HAS ANSWERED.
 * Arc `[LOC-V2-model]`, chunk **[LOCV2-write-probe]**. Manager-approved
 * 2026-09-25 with the target item (`com.pure3q.sea.mb6`) named explicitly.
 *
 * ⚠⚠ THIS IS THE DECISION LOGIC FOR THE ONLY WRITE THIS ARC MAKES. Its sibling
 * `localization-v2-snapshot.ts` is read-only; this one chooses what gets
 * PATCHed and then reads the result. It is pure — no Apple I/O — so both
 * halves are testable without touching a live, selling product.
 *
 * ─── THE ONE QUESTION ──────────────────────────────────────────────────────
 *
 *   `PATCH /v2/inAppPurchaseLocalizations/{id}` against a localization owned by
 *   an **APPROVED** version — what does Apple do, and does a new version come
 *   into existence?
 *
 * Nothing read-only can answer it: it is a question about a write. Everything
 * else in the arc has been settled by reading (KB §31.11); this is the
 * remainder.
 *
 * ─── ⚠ WHY THE TARGET IS COMPUTED, NEVER PASSED IN ─────────────────────────
 *
 * The locale to patch is DERIVED from the snapshot — the locale whose content
 * differs between the approved version and the draft. It is not a constant and
 * not an argument with a default.
 *
 * The reason is KB §31.14, and it was paid for: asked which locale had been
 * hand-edited, the Manager said `vi`. The app has no `vi` at all — the edited
 * locale is `en-US`. Human memory carried a word from an earlier incident; the
 * server did not. ⇒ **Take the PARAMETERS of a measurement from the data, not
 * from whoever created the state.**
 *
 * The caller still passes an EXPECTATION (`expectLocalizationId`), and a
 * mismatch STOPS the probe. That is the opposite of hard-coding: the derived
 * value leads, the human value is only allowed to veto.
 */
import type { VersionSnapshot, LocalizationContentRow } from "./localization-v2-snapshot";
import { localizationTextEquals } from "../localization-compare";

export interface WriteTarget {
  localizationId: string;
  locale: string;
  /** What will be SENT — the approved version's current content. */
  payload: { name: string; description: string };
  /** What currently sits in the draft and would be overwritten if Apple
   *  writes there. Printed for the Manager before anything is sent. */
  draftBefore: { name: string; description: string };
}

export type TargetChoice =
  | { ok: true; target: WriteTarget }
  | { ok: false; reason: string };

/**
 * Pick the localization to PATCH, or refuse.
 *
 * ⚠⚠ EVERY REFUSAL PATH HERE IS A **NO-WRITE** PATH, AND THAT IS THE POINT.
 * Each condition below was a way for the probe to fire at the wrong resource,
 * or to fire when the result could not be interpreted:
 *
 *   · snapshot incomplete      — a flagged read may be short; choosing from it
 *                                could target a locale that only LOOKS unique
 *   · not comparable           — no approved/draft pair, so "differs" is
 *                                meaningless
 *   · zero divergent locales   — S1 sends the approved content, so with the
 *                                draft ALREADY matching, branch 4 (Apple wrote
 *                                into the draft) would be indistinguishable
 *                                from branch 5 (nothing happened). The run
 *                                would cost a write and answer nothing.
 *   · more than one divergent  — two moving parts, no clean signal
 *   · expectation mismatch     — the state changed between the snapshot the
 *                                Manager read and this run. Writing anyway
 *                                would patch a resource nobody looked at.
 */
export function chooseWriteTarget(
  snapshot: VersionSnapshot,
  expectLocalizationId: string,
): TargetChoice {
  if (snapshot.incomplete) {
    return {
      ok: false,
      reason:
        "snapshot is incomplete (a FETCH_FAILED / MORE_PAGES / PTR_SHORT flag " +
        "is set) — refusing to choose a target from data that may be short",
    };
  }
  if (!snapshot.comparable.ok) {
    return { ok: false, reason: `not comparable: ${snapshot.comparable.reason ?? "?"}` };
  }
  if (snapshot.divergentLocales.length === 0) {
    return {
      ok: false,
      reason:
        "no locale differs between the approved version and the draft — S1 " +
        "sends the approved content, so a write here could not distinguish " +
        "'Apple wrote into the draft' from 'nothing happened'. Nothing sent.",
    };
  }
  if (snapshot.divergentLocales.length > 1) {
    return {
      ok: false,
      reason:
        `${snapshot.divergentLocales.length} locales differ ` +
        `(${snapshot.divergentLocales.map((d) => d.locale).join(", ")}) — the ` +
        `probe needs exactly one moving part`,
    };
  }

  const d = snapshot.divergentLocales[0];
  if (d.approvedLocalizationId !== expectLocalizationId) {
    return {
      ok: false,
      reason:
        `expected localization ${expectLocalizationId} but the data says ` +
        `${d.approvedLocalizationId} (locale ${d.locale}) — the state changed ` +
        `since the snapshot was read; refusing to write`,
    };
  }

  return {
    ok: true,
    target: {
      localizationId: d.approvedLocalizationId,
      locale: d.locale,
      // ⚠ SEND THE APPROVED CONTENT, i.e. the value already live. If Apple
      // refuses, nothing was lost; if Apple accepts, what customers see does
      // not change — only the version lifecycle does.
      payload: { name: d.approved.name, description: d.approved.description },
      draftBefore: { name: d.draft.name, description: d.draft.description },
    },
  };
}

// ─── Reading the result ─────────────────────────────────────────────────────

export interface ContentChange {
  versionId: string;
  versionState: string;
  locale: string;
  before: { name: string; description: string };
  after: { name: string; description: string };
}

export type WriteProbeVerdict =
  /** Apple refused. v2 is blocked on an approved version too. */
  | "APPLE_REFUSED"
  /** ⭐ Apple created a version itself — the tool never has to. */
  | "APPLE_CREATED_VERSION"
  /** ⭐⭐ Branch 4 — Apple wrote into the existing draft. Best outcome. */
  | "WROTE_INTO_EXISTING_DRAFT"
  /** Apple edited the live version in place. ⚠ Conflicts with the ASC evidence. */
  | "EDITED_LIVE_IN_PLACE"
  /** 200 but nothing observable changed. Needs S2, Manager-gated. */
  | "AMBIGUOUS_NO_CHANGE"
  /** ⚠⚠ Something outside the target locale moved. Stop and report. */
  | "UNEXPECTED_COLLATERAL";

export interface WriteProbeReading {
  verdict: WriteProbeVerdict;
  /** Versions present after but not before. */
  newVersionIds: string[];
  /** Every (version, locale) whose content moved. */
  contentChanges: ContentChange[];
  /** ⚠ Changes to a locale OTHER than the one patched. */
  collateral: ContentChange[];
  /** One sentence for the Manager. */
  summary: string;
}

function rowsByLocale(rows: ReadonlyArray<LocalizationContentRow>) {
  return new Map(rows.map((r) => [r.locale, r]));
}

/**
 * Diff two snapshots across **all three tiers**.
 *
 * ⚠⚠ THE THIRD TIER IS WHY THIS FUNCTION EXISTS. Comparing version COUNT and
 * locale LIST alone leaves branch 4 invisible: if Apple writes into the
 * existing draft, both are unchanged and only the CONTENT moves. That hole was
 * in the snapshot once already (KB §31.14) and it defeated the reason the
 * probe item was chosen. Losing it again here would waste the one write.
 */
export function readWriteProbeResult(
  before: VersionSnapshot,
  after: VersionSnapshot,
  target: WriteTarget,
  httpOk: boolean,
): WriteProbeReading {
  const beforeVersions = new Map(before.versions.map((v) => [v.versionId, v]));
  const newVersionIds = after.versions
    .filter((v) => !beforeVersions.has(v.versionId))
    .map((v) => v.versionId);

  const contentChanges: ContentChange[] = [];
  for (const av of after.versions) {
    const bv = beforeVersions.get(av.versionId);
    if (!bv) continue; // a brand-new version has no "before" to diff against
    const beforeRows = rowsByLocale(bv.localizations);
    for (const a of av.localizations) {
      const b = beforeRows.get(a.locale);
      if (!b) continue;
      if (
        localizationTextEquals(b.name, a.name) &&
        localizationTextEquals(b.description, a.description)
      ) {
        continue;
      }
      contentChanges.push({
        versionId: av.versionId,
        versionState: av.state,
        locale: a.locale,
        before: { name: b.name, description: b.description },
        after: { name: a.name, description: a.description },
      });
    }
  }

  const collateral = contentChanges.filter((c) => c.locale !== target.locale);

  // ⚠ ORDER IS DELIBERATE. Collateral outranks everything: a PATCH that moved
  // a locale nobody addressed is a fact about Apple's behaviour that no other
  // verdict should be allowed to bury.
  if (collateral.length > 0) {
    return {
      verdict: "UNEXPECTED_COLLATERAL",
      newVersionIds,
      contentChanges,
      collateral,
      summary:
        `⚠⚠ ${collateral.length} change(s) outside the patched locale ` +
        `(${collateral.map((c) => `${c.versionId}/${c.locale}`).join(", ")}) — ` +
        `the PATCH touched more than one resource. STOP and report.`,
    };
  }

  if (!httpOk) {
    return {
      verdict: "APPLE_REFUSED",
      newVersionIds,
      contentChanges,
      collateral,
      summary:
        "Apple refused the PATCH — v2 does not edit a localization owned by an " +
        "APPROVED version either. The tool must create the version itself; the " +
        "orphan-version constraints stay.",
    };
  }

  if (newVersionIds.length > 0) {
    return {
      verdict: "APPLE_CREATED_VERSION",
      newVersionIds,
      contentChanges,
      collateral,
      summary:
        `⭐ Apple created version(s) ${newVersionIds.join(", ")} by itself. The ` +
        `tool never calls POST /v1/inAppPurchaseVersions ⇒ no orphan-version ` +
        `risk; Apple owns the behaviour.`,
    };
  }

  const draftChanged = contentChanges.filter(
    (c) => c.versionState === "PREPARE_FOR_SUBMISSION",
  );
  if (draftChanged.length > 0) {
    return {
      verdict: "WROTE_INTO_EXISTING_DRAFT",
      newVersionIds,
      contentChanges,
      collateral,
      summary:
        "⭐⭐ Apple wrote into the EXISTING draft version — no new version, no " +
        "extra review cycle. Best possible outcome for the tool.",
    };
  }

  if (contentChanges.length > 0) {
    return {
      verdict: "EDITED_LIVE_IN_PLACE",
      newVersionIds,
      contentChanges,
      collateral,
      summary:
        "⚠ The APPROVED version's own content changed in place. This conflicts " +
        "with the ASC evidence (editing a live item produced a second row) — " +
        "explain it, do not swallow it.",
    };
  }

  return {
    verdict: "AMBIGUOUS_NO_CHANGE",
    newVersionIds,
    contentChanges,
    collateral,
    summary:
      "200 but nothing observable moved — cannot tell 'edits in place' from " +
      "'Apple saw no change and did nothing'. Needs S2, and S2 needs the " +
      "Manager's separate consent.",
  };
}

/**
 * The greppable line. Shape is STABLE — the Manager greps it.
 *
 * `contentChanged` lists `versionId:locale` pairs, which is the ONLY field that
 * distinguishes branch 4 from "nothing happened".
 */
export function describeWriteProbeForLog(
  productId: string,
  target: WriteTarget,
  httpStatus: number,
  before: VersionSnapshot,
  after: VersionSnapshot,
  reading: WriteProbeReading,
  body: string,
): string {
  const vids = (s: VersionSnapshot) =>
    s.versions.map((v) => `${v.versionId}:${v.state}`).join(", ");
  return (
    `LOCV2-WRITE-PROBE product=${productId} ` +
    `locId=${target.localizationId} locale=${target.locale} ` +
    `http=${httpStatus} ` +
    `versionsBefore=[${vids(before)}] ` +
    `versionsAfter=[${vids(after)}] ` +
    `newVersion=${reading.newVersionIds.length > 0 ? "y" : "n"} ` +
    `contentChanged=[${reading.contentChanges.map((c) => `${c.versionId}:${c.locale}`).join(",")}] ` +
    `verdict=${reading.verdict} ` +
    `body=${body.slice(0, 2000)}`
  );
}
