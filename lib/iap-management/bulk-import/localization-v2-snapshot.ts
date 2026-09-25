/**
 * ⏳ TEMPORARY INSTRUMENTATION — DELETE ONCE IT HAS ANSWERED.
 * Arc `[LOC-V2-model]`, chunk **V0-snapshot**. Manager-approved 2026-09-24.
 *
 * ⚠⚠ THIS IS THE **READ-ONLY** HALF OF A TWO-PART MEASUREMENT, AND THE SPLIT
 * IS THE POINT. The Manager's instruction, verbatim: *"Quyết định ghi trước khi
 * nhìn là quyết định mù."* Part 1 (this module) writes NOTHING to Apple and
 * runs over several IAPs; the Manager reads the result and only then chooses
 * which single IAP part 2 may write to.
 *
 * ⭐⭐ IT CLOSED THE MOST DANGEROUS OPEN QUESTION WITHOUT A SINGLE WRITE — AND
 * THE ANSWER IS IN (2026-09-25, KB §31.11).
 * The question was **inheritance**: when a second version comes into existence
 * for a live IAP, does it CARRY OVER the approved version's other locales, or
 * start with only the locale that changed? Starting empty-but-one would mean a
 * multi-locale product could **lose the rest at approval** — data loss on an
 * item that is currently selling.
 *
 *   **ĐÃ ĐO: IT INHERITS.** `com.pure3q.sea.mb6`, hand-edited in ASC, came back
 *   with TWO versions and BOTH list `{en-US, id, th}` — the draft carries the
 *   full locale set, not just the edited one. `flags=[]`, so the reading is
 *   clean. ⇒ The design no longer copies locales onto a new version.
 *
 * ⚠ THE EVIDENCE WAS ALREADY ON APPLE'S SERVERS, put there by the Manager's own
 * hand-edit weeks earlier. ⭐ Worth keeping as a habit: before designing a
 * WRITE experiment, check whether the system has already produced the evidence
 * by accident.
 *
 * ⚠ LIMIT OF THAT MEASUREMENT — do not widen it. The version was created by
 * **ASC**. Whether a version created by the **API**
 * (`POST /v1/inAppPurchaseVersions`) also inherits is **CHƯA ĐO**: ASC could
 * copy at the UI layer while the API hands back an empty container. It only
 * matters if the "tool must create the version itself" branch turns out true.
 *
 * ─── ⚠⚠ WHY THIS MODULE TAKES **TWO** SOURCES AND NOT ONE ──────────────────
 *
 * The first version of this file joined localizations to versions through
 * `version.relationships.localizations.data[]` — the relationship pointer —
 * and argued at length that reading "from the primary side" was correct.
 * **That was wrong for Apple V2, and the repo already knew.**
 *
 *   KB §4.1 LANDMARK (IAP.p2.m): Apple V2 `?include` truncates the relationship
 *   pointer at **10 IDs** while the real set is larger (12 observed at MV30).
 *   *"never trust `relationships.{rel}.data` as the authoritative ID list for
 *   an included relation."*
 *
 * ⚠ AND THE FAILURE DIRECTION IS THE ONE THAT FLIPS THE ANSWER. A truncated
 * pointer makes a version look like it owns FEWER locales than it does, which
 * reads as **"no inheritance"** — the exact conclusion that would change the
 * whole design. A confident wrong answer, in the direction nobody would
 * question.
 *
 * ⇒ So the authoritative count comes from the **V1 sub-resource per version**
 *   (`listLocalizationsForVersion`), and the pointer is kept only to be
 *   COMPARED against it. That comparison is itself a measurement: the landmark
 *   was established on `manualPrices`, never on `localizations`, and
 *   `pointerDisagrees` reports whether it holds here too. Same diagnostic
 *   fingerprint the KB names — "Stage 1 rel_count < Stage 2 total".
 *
 * ⚠⚠ AND THE FIRST RUN DID NOT CLEAR THE LANDMARK — DO NOT COLLAPSE BACK TO
 * ONE STAGE. Every version read on 2026-09-25 had **n=3** locales and
 * `pointerDisagrees` was false everywhere. §4.1 is a cap at **10 IDs**: at n=3
 * truncation CANNOT be observed. That run proves "no truncation at n=3", not
 * "no truncation". Apple ships ~40 App Store locales, so the condition simply
 * has not occurred yet. ⭐ A guard that has never fired because its trigger has
 * never occurred is not a dead guard (cf. §29.4, where the guarded value did
 * not exist at all — a different thing).
 *
 * ⚠ WHAT THIS MODULE DOES **NOT** ANSWER. It cannot say what Apple does when
 * you `PATCH /v2/inAppPurchaseLocalizations/{id}` against a localization owned
 * by an APPROVED version. Nothing read-only can: that is a question about a
 * WRITE. Part 2 exists for exactly that one question.
 *
 * ⚠⚠ REMOVAL IS PART OF THE JOB. Precedent: `localization-state-probe.ts`, and
 * the DEBUG 429-header line from the key-pool arc — each added to settle a
 * named question, each removed once settled.
 */

/** One version row, as loosely as Apple might actually send it. */
export interface ProbeVersion {
  id?: unknown;
  attributes?: { state?: unknown; version?: unknown };
  relationships?: {
    localizations?: { data?: unknown; meta?: unknown };
  };
}

/** One localization row, as loosely as Apple might actually send it. */
export interface ProbeLocalization {
  type?: unknown;
  id?: unknown;
  attributes?: { locale?: unknown; name?: unknown; description?: unknown };
}

/**
 * Stage 2 — the authoritative per-version read, plus whether Apple said there
 * was more than one page of it.
 */
export interface VersionLocalizationsFetch {
  versionId: string;
  /** Rows from `GET /v1/inAppPurchaseVersions/{id}/localizations`. */
  rows: ReadonlyArray<ProbeLocalization>;
  /**
   * `links.next` was present ⇒ Apple has MORE than this page.
   *
   * ⚠ THIS MUST NEVER BE SWALLOWED. A short list reads as "that locale is not
   * in this version" ⇒ "no inheritance" ⇒ the wrong design. Unpaged overflow
   * is reported as loudly as a failure, because for this question it IS one.
   */
  hasMorePages?: boolean;
  /** Stage 2 failed for this version — distinct from "it has none". */
  error?: string;
}

export type LocalizationEdge = { kind: "NO_EDGE" } | { kind: "IDS"; ids: string[] };

export interface VersionSnapshotRow {
  versionId: string;
  state: string;
  /** ⭐ AUTHORITATIVE — locales from the V1 sub-resource. */
  locales: string[];
  /** Apple said there are more pages than the one that was read. */
  truncatedPages: boolean;
  /** Stage 2 could not be read. `locales` is then NOT a count of anything. */
  fetchError?: string;
  /** The V2 relationship pointer, kept ONLY to be checked against `locales`. */
  edge: LocalizationEdge;
  /**
   * ⭐ The §4.1 landmark, measured on THIS relationship: the pointer listed
   * fewer ids than the sub-resource actually returned.
   */
  pointerDisagrees: boolean;
}

export interface VersionSnapshot {
  productId: string;
  versions: VersionSnapshotRow[];
  /** True when any row is missing data — the whole snapshot is then partial. */
  incomplete: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function readEdge(v: ProbeVersion): LocalizationEdge {
  const data = v.relationships?.localizations?.data;
  if (!Array.isArray(data)) return { kind: "NO_EDGE" };
  const ids: string[] = [];
  for (const entry of data) {
    const id =
      entry && typeof entry === "object"
        ? str((entry as { id?: unknown }).id)
        : null;
    if (id) ids.push(id);
  }
  return { kind: "IDS", ids };
}

/**
 * Build the structured snapshot. Pure + deterministic — no Apple I/O — so every
 * distinction above is unit-tested independently of the requests.
 */
export function summarizeVersionSnapshot(
  productId: string,
  versions: ReadonlyArray<ProbeVersion>,
  fetched: ReadonlyArray<VersionLocalizationsFetch>,
): VersionSnapshot {
  const byVersion = new Map<string, VersionLocalizationsFetch>();
  for (const f of fetched) byVersion.set(f.versionId, f);

  let incomplete = false;
  const rows: VersionSnapshotRow[] = versions.map((v) => {
    const versionId = str(v.id) ?? "ID_ABSENT";
    const edge = readEdge(v);
    const fetch = byVersion.get(versionId);

    if (!fetch || fetch.error) {
      // ⚠ NOT an empty locale list. "Apple would not tell us" and "this version
      // owns no localization" are different facts and only one of them is a
      // finding. Collapsing them manufactures the "no inheritance" answer.
      incomplete = true;
      return {
        versionId,
        state: str(v.attributes?.state) ?? "STATE_ABSENT",
        locales: [],
        truncatedPages: false,
        fetchError: fetch?.error ?? "not fetched",
        edge,
        pointerDisagrees: false,
      };
    }

    const locales = fetch.rows.map(
      (r) => str(r.attributes?.locale) ?? "LOCALE_ABSENT",
    );
    const truncatedPages = fetch.hasMorePages === true;
    if (truncatedPages) incomplete = true;

    return {
      versionId,
      state: str(v.attributes?.state) ?? "STATE_ABSENT",
      locales,
      truncatedPages,
      edge,
      // Only a SHORT pointer is the landmark. A pointer with more ids than the
      // sub-resource returned would be a different anomaly, and calling both
      // "disagrees" would blur a measurement into a warning.
      pointerDisagrees: edge.kind === "IDS" && edge.ids.length < locales.length,
    };
  });

  return { productId, versions: rows, incomplete };
}

/**
 * One greppable line per IAP. Shape is STABLE — the Manager greps it:
 *
 *   LOCV2-SNAPSHOT product=<id> versions=[v1:APPROVED, v2:PREPARE_FOR_SUBMISSION]
 *     locsByVersion=[v1:{vi,en-US}, v2:{vi}] ptr=[v1:2, v2:1] flags=[]
 *
 * ⭐ `locsByVersion` IS THE ANSWER TO THE INHERITANCE QUESTION, and it is the
 * AUTHORITATIVE read. An approved version listing `{vi,en-US}` beside a draft
 * listing `{vi}` means **no inheritance** — a design-changing fact for zero
 * writes.
 *
 * ⚠ `flags` IS NOT DECORATION. Any flag means the line above it may be short,
 * and a short line is the wrong answer in the reassuring direction:
 *   FETCH_FAILED(v)  — that version's locales are unknown, NOT empty
 *   MORE_PAGES(v)    — Apple has more than one page; the list is cut
 *   PTR_SHORT(v n<m) — ⭐ KB §4.1 truncation, observed on `localizations`
 */
export function describeVersionSnapshotForLog(snapshot: VersionSnapshot): string {
  const versions = snapshot.versions
    .map((r) => `${r.versionId}:${r.state}`)
    .join(", ");
  const locs = snapshot.versions
    .map((r) =>
      r.fetchError ? `${r.versionId}:UNKNOWN` : `${r.versionId}:{${r.locales.join(",")}}`,
    )
    .join(", ");
  const ptr = snapshot.versions
    .map((r) =>
      r.edge.kind === "NO_EDGE"
        ? `${r.versionId}:NO_EDGE`
        : `${r.versionId}:${r.edge.ids.length}`,
    )
    .join(", ");

  const flags: string[] = [];
  for (const r of snapshot.versions) {
    if (r.fetchError) flags.push(`FETCH_FAILED(${r.versionId})`);
    if (r.truncatedPages) flags.push(`MORE_PAGES(${r.versionId})`);
    if (r.pointerDisagrees) {
      flags.push(`PTR_SHORT(${r.versionId} ${r.edge.kind === "IDS" ? r.edge.ids.length : "?"}<${r.locales.length})`);
    }
  }

  return (
    `LOCV2-SNAPSHOT product=${snapshot.productId} ` +
    `versions=[${versions}] ` +
    `locsByVersion=[${locs}] ` +
    `ptr=[${ptr}] ` +
    `flags=[${flags.join(",")}]`
  );
}
