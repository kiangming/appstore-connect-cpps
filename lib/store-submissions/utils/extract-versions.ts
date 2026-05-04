/**
 * Pure helper: pull unique version strings out of a ticket's
 * `type_payloads` JSONB array.
 *
 * Pipeline source: classifier → `type-matcher.ts` extracts named
 * captures (`version`, `platform`, `count`, `name`, `uuid`,
 * `version_code`) and the engine appends each match as a JSONB row on
 * `tickets.type_payloads`. Apple patterns reliably populate `version`;
 * other platforms may not have a `<version>` capture in their type
 * regex and produce payloads without that field — in which case this
 * returns `[]` and the calling UI omits the section entirely.
 *
 * Order semantics: insertion order preserved so the last element is
 * the most recently extracted version (latest submission). The
 * detail-panel chips render that last value with a "← latest"
 * accent.
 *
 * Defensive parsing: `payloads` is typed `unknown[]` because the JSONB
 * shape is opaque at the TS layer. Each item is narrowed before
 * accessing `.version`, and only non-empty strings are kept.
 */
export function extractVersions(payloads: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of payloads) {
    if (p && typeof p === 'object' && 'version' in p) {
      const v = (p as { version: unknown }).version;
      if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
        seen.add(v);
        ordered.push(v);
      }
    }
  }
  return ordered;
}
