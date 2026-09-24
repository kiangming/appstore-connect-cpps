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
 * ⭐ IT ALSO CLOSES THE MOST DANGEROUS OPEN QUESTION WITHOUT A SINGLE WRITE.
 * The question is **§1.6 / inheritance**: when a second version comes into
 * existence for a live IAP, does it CARRY OVER the approved version's other
 * locales, or start with only the locale that changed?
 *
 *   · If it starts empty-but-one, then a multi-locale product whose version
 *     ships with a single locale could **lose the rest at approval**. That is
 *     data loss on an item that is currently selling.
 *   · The Manager has ALREADY produced such a second version by hand in App
 *     Store Connect (KB §28.11 / §28.11.a — two `Vietnamese` rows, two distinct
 *     version ids). ⇒ The evidence already exists on Apple's servers. It only
 *     had to be READ.
 *
 * ⇒ Snapshot an item the Manager edited by hand, with **two or more locales**,
 *   and count the localizations on each version. No write, no review cycle, no
 *   permanent artifact. See KB §31.
 *
 * ⚠ WHAT THIS MODULE DOES **NOT** ANSWER — do not let the snapshot be read as
 * more than it is. It cannot say what Apple does when you `PATCH
 * /v2/inAppPurchaseLocalizations/{id}` against a localization owned by an
 * APPROVED version. Nothing read-only can: that question is about a WRITE, and
 * only the write answers it. Part 2 exists for exactly that one question.
 *
 * ⚠⚠ REMOVAL IS PART OF THE JOB. Precedent: `localization-state-probe.ts`, and
 * the DEBUG 429-header line from the key-pool arc — each added to settle a
 * named question, each removed once settled. An "informative" log kept forever
 * is how a log file becomes unreadable.
 */

/** One version row, as loosely as Apple might actually send it. */
export interface ProbeVersion {
  id?: unknown;
  attributes?: { state?: unknown; version?: unknown };
  relationships?: {
    localizations?: { data?: unknown };
  };
}

/** One `included[]` row, as loosely as Apple might actually send it. */
export interface ProbeIncluded {
  type?: unknown;
  id?: unknown;
  attributes?: { locale?: unknown; name?: unknown; description?: unknown };
}

/**
 * ⚠ THREE OUTCOMES FOR THE JOIN EDGE, NOT TWO — and telling them apart IS one
 * of the questions.
 *
 *   NO_EDGE — `relationships.localizations.data` is absent entirely. This is
 *             the JSON:API quirk CLAUDE.md records for CPP (`included[]`
 *             resources ship `links` and omit `data`) appearing on the PRIMARY
 *             side, where it is NOT supposed to. If versions come back this
 *             way, the whole primary-side join plan is unbuildable and the
 *             design has to change.
 *   []      — the edge is present and the version genuinely owns no
 *             localization. A real, different fact.
 *   [ids…]  — the edge is present and populated.
 *
 * Collapsing NO_EDGE into `[]` would destroy the distinction being probed, and
 * would do it in the reassuring direction: "this version has no localizations"
 * reads as data when it is really "we could not tell". Same failure shape as
 * ABSENT-vs-EMPTY in `localization-state-probe.ts`.
 */
export type LocalizationEdge = { kind: "NO_EDGE" } | { kind: "IDS"; ids: string[] };

export interface VersionSnapshotRow {
  versionId: string;
  state: string;
  edge: LocalizationEdge;
  /** Locales resolved through the edge, in edge order. */
  locales: string[];
  /** Edge ids with no matching `included[]` row — the join half-failed. */
  unresolvedIds: string[];
}

export interface VersionSnapshot {
  productId: string;
  versions: VersionSnapshotRow[];
  /** Total localization rows Apple put in `included[]`. */
  includedTotal: number;
  /**
   * `included[]` localizations that NO version claimed through its edge.
   *
   * ⚠ A non-empty value here is a LOUD signal, not a detail: Apple returned
   * localization content the primary-side join cannot place. Reading it as
   * "belongs to the first version" is the guess this field exists to prevent.
   */
  unclaimedLocales: string[];
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
 * Build the structured snapshot. Pure + deterministic — no Apple I/O — so the
 * distinctions above are unit-tested independently of the request.
 */
export function summarizeVersionSnapshot(
  productId: string,
  versions: ReadonlyArray<ProbeVersion>,
  included: ReadonlyArray<ProbeIncluded>,
): VersionSnapshot {
  const localeById = new Map<string, string>();
  let includedTotal = 0;
  for (const inc of included) {
    if (inc.type !== "inAppPurchaseLocalizations") continue;
    includedTotal++;
    const id = str(inc.id);
    if (!id) continue;
    // ⚠ A localization whose `locale` is missing still COUNTS — dropping it
    // would understate what Apple sent. It is named so it stays visible.
    localeById.set(id, str(inc.attributes?.locale) ?? "LOCALE_ABSENT");
  }

  const claimed = new Set<string>();
  const rows: VersionSnapshotRow[] = versions.map((v) => {
    const edge = readEdge(v);
    const locales: string[] = [];
    const unresolvedIds: string[] = [];
    if (edge.kind === "IDS") {
      for (const id of edge.ids) {
        claimed.add(id);
        const locale = localeById.get(id);
        if (locale === undefined) unresolvedIds.push(id);
        else locales.push(locale);
      }
    }
    return {
      versionId: str(v.id) ?? "ID_ABSENT",
      state: str(v.attributes?.state) ?? "STATE_ABSENT",
      edge,
      locales,
      unresolvedIds,
    };
  });

  const unclaimedLocales: string[] = [];
  for (const [id, locale] of localeById) {
    if (!claimed.has(id)) unclaimedLocales.push(locale);
  }

  return { productId, versions: rows, includedTotal, unclaimedLocales };
}

/**
 * One greppable line per IAP. Shape is STABLE — the Manager greps it:
 *
 *   LOCV2-SNAPSHOT product=<id> versions=[v1:APPROVED, v2:PREPARE_FOR_SUBMISSION]
 *     locsByVersion=[v1:{vi,en}, v2:{vi}] total=3 unclaimed=[]
 *
 * ⭐ `locsByVersion` IS THE ANSWER TO THE INHERITANCE QUESTION. Two versions
 * where the approved one lists `{vi,en}` and the draft lists `{vi}` means
 * **NO inheritance** — and that is a design-changing fact obtained for zero
 * writes.
 *
 * ⚠ `NO_EDGE` in place of a brace list means Apple omitted the primary-side
 * relationship data. That is not "no localizations"; it is "unanswerable from
 * this document".
 */
export function describeVersionSnapshotForLog(snapshot: VersionSnapshot): string {
  const versions = snapshot.versions
    .map((r) => `${r.versionId}:${r.state}`)
    .join(", ");
  const locs = snapshot.versions
    .map((r) => {
      if (r.edge.kind === "NO_EDGE") return `${r.versionId}:NO_EDGE`;
      const parts = [...r.locales, ...r.unresolvedIds.map((id) => `UNRESOLVED(${id})`)];
      return `${r.versionId}:{${parts.join(",")}}`;
    })
    .join(", ");
  return (
    `LOCV2-SNAPSHOT product=${snapshot.productId} ` +
    `versions=[${versions}] ` +
    `locsByVersion=[${locs}] ` +
    `total=${snapshot.includedTotal} ` +
    `unclaimed=[${snapshot.unclaimedLocales.join(",")}]`
  );
}
