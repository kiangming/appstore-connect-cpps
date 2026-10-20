/**
 * [TEMPLATE-xlsx-reimport] PA2 — the contract of the "Export for editing"
 * file, SHARED by its writer (`xlsx-template-matrix-export.ts`, exceljs) and
 * its reader (PA2.2, xlsx). One module so the two cannot drift: a header the
 * writer formats one way and the reader parses another would turn every
 * column of an unedited file into a refusal — or, worse, into another
 * territory.
 *
 * Imports NOTHING, on purpose: it sits on both sides of the Excel-library
 * fence (KB §4.17 — xlsx reads, exceljs writes) and must drag neither.
 *
 * Manager 2026-10-19 (design-template-matrix-reimport.md §L2.9):
 *   Q-C  the territory header carries code AND currency, `Vietnam (VNM_VND)` —
 *        the same shape as format A's header, parsed by the SAME regex;
 *   Q-D  a new override's currency is the header's;
 *   Q-E  the file states its scope (Default of which account / Per-App of
 *        which app) so an import into the wrong one is blocked.
 */

/**
 * `Name (AAA_CCC)` — the territory header of format A (the Manager's template,
 * parsers/price-tiers.ts) and of the "for editing" export. Group 2 = territory
 * code (alpha-3, as stored), group 3 = currency. The name in front is for the
 * reader of the file only — identity never comes from it (KB §4.20: no
 * name → code conversion, ever).
 *
 * ⚠ ONE regex for both formats. Moved here from parsers/price-tiers.ts
 *   unchanged, so format A keeps parsing exactly as before.
 */
export const TERRITORY_HEADER_RE = /^(.+?)\s*\(([A-Z]{3})_([A-Z]{3})\)\s*$/;

export function formatTerritoryHeader(name: string, code: string, currency: string): string {
  return `${name} (${code}_${currency})`;
}

/** The sheet that states where the file belongs. Found BY NAME (Numbers puts an
 *  "Export Summary" sheet first — measured), written hidden: Excel keeps it
 *  hidden; Numbers shows it but keeps its content (measured, §2.3). Its values
 *  are checked against the import's target, never trusted to choose it. */
export const EDIT_INFO_SHEET = "_import_info";
export const EDIT_FORMAT = "apple-pricing-template-for-editing";
export const EDIT_FORMAT_VERSION = "1";

export type EditScopeInfo =
  | { kind: "ACCOUNT"; accountId: string; accountName: string }
  | { kind: "APP"; appId: string; bundleId: string; appName: string };

export interface EditExportInfo {
  scope: EditScopeInfo;
  exportedAt: string;
  exportedBy: string;
}

/** The info sheet's rows, in order: a header row, then key/value pairs. Only
 *  the keys of the file's own scope are written. */
export function editInfoRows(info: EditExportInfo): Array<[string, string]> {
  const scopeRows: Array<[string, string]> =
    info.scope.kind === "ACCOUNT"
      ? [
          ["scope", "ACCOUNT"],
          ["account_id", info.scope.accountId],
          ["account_name", info.scope.accountName],
        ]
      : [
          ["scope", "APP"],
          ["app_id", info.scope.appId],
          ["bundle_id", info.scope.bundleId],
          ["app_name", info.scope.appName],
        ];
  return [
    ["key", "value"],
    ["format", EDIT_FORMAT],
    ["version", EDIT_FORMAT_VERSION],
    ...scopeRows,
    ["exported_at", info.exportedAt],
    ["exported_by", info.exportedBy],
  ];
}
