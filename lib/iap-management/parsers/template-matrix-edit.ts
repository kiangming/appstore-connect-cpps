/**
 * [TEMPLATE-xlsx-reimport] PA2.2 — reader of the "Export for editing" file.
 *
 * Manager 2026-10-19 (design-template-matrix-reimport.md §L2.9):
 *   1. the FILE is the only truth — import makes the template exactly the file;
 *   2. a cell with a price ⇒ an override at exactly that price;
 *   3. an empty / "·" cell ⇒ no override ⇒ Apple's price.
 * Output is format A's own sparse structure (`PriceTiersParseResult`, proceeds
 * null — Q-G), so the write goes through the SAME `replaceTemplate` (KB P1).
 *
 * ⚠ STRICT, BECAUSE THE WRITE IS A REPLACE. Format A warns-and-skips an
 *   unknown tier row; under rule 1 a skipped row is a DELETED row. So every
 *   doubt here is a refusal, listed with its cell address, and nothing is
 *   written: unknown or non-canonical tier names (Q-H), territory codes Apple
 *   does not sell in (Q-I), more than 4 decimals (Q-J), ambiguous text
 *   (Q-K), a Currency cell that contradicts its header (Q-D), formulas, and a
 *   file with no price at all (Q-Q — an empty file must not empty a template).
 *
 * ⚠ IDENTITY NEVER COMES FROM A NAME (KB §4.20): the territory is the code in
 *   its header `Name (CODE_CUR)`, the tier is the canonical tier name.
 *
 * Reads with `xlsx` (KB §4.17: xlsx reads, exceljs writes) and walks the cells
 * that EXIST — never `sheet_to_json` over `!ref`, which a `<dimension>`
 * inflated to A1:XFD1048576 turns into a minute-long loop (measured, §4.7).
 */
import * as XLSX from "xlsx";

import { APPLE_TERRITORIES_ALPHA3 } from "../apple/apple-territories.snapshot";
import {
  EDIT_FORMAT,
  EDIT_FORMAT_VERSION,
  EDIT_INFO_SHEET,
  MATRIX_SHEET_NAME,
  TERRITORY_HEADER_RE,
  type EditScopeInfo,
} from "../template-matrix-edit-spec";
import {
  tierIdFromName,
  type ParsedPriceTier,
  type ParsedTerritoryPrice,
  type PriceTiersParseResult,
} from "./price-tiers";

/** Same ceiling as format A's upload. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Far below NUMERIC(18,4)'s 1e14 (which overflows AFTER the old template is
 *  deleted — measured) and far above any real price (max seen: 2.5e7). */
const MAX_CUSTOMER_PRICE = 1e12;
/** Q-J — at most 4 decimals, judged on the shortest decimal form of the
 *  double. Exact over the whole range, unlike `round(x·1e4)/1e4 === x`,
 *  which fails above 2^38 (measured). Excel's 17-digit `<v>` forms read back
 *  as the same double and pass. */
const PRICE_NUMBER_RE = /^\d+(\.\d{1,4})?$/;
/** Q-K — the only text accepted as a price: unambiguous. "49.000" (could be
 *  forty-nine thousand, Vietnamese style) and anything with a comma are not. */
const PRICE_TEXT_RE = /^(\d+|\d+\.\d{1,2})$/;

const KNOWN_TERRITORIES: ReadonlySet<string> = new Set(APPLE_TERRITORIES_ALPHA3);

export interface MatrixEditProblem {
  /** A1-style address, or null for a file-level problem. */
  cell: string | null;
  message: string;
}

export class MatrixEditFileError extends Error {
  constructor(
    /** NOT_EDIT_FILE — this is not an "Export for editing" file at all
     *  (a view export, an old export, format A). INVALID_FILE — it is one,
     *  but it cannot be imported as it stands. */
    readonly code: "NOT_EDIT_FILE" | "INVALID_FILE",
    message: string,
    readonly problems: MatrixEditProblem[] = [],
  ) {
    super(message);
    this.name = "MatrixEditFileError";
  }
}

export interface MatrixEditFile {
  /** Where the file says it belongs — to be CHECKED against the import's
   *  target, never used to choose it (KB §25.2). */
  scope: EditScopeInfo;
  exportedAt: string | null;
  exportedBy: string | null;
  /** Format A's structure — what replaceTemplate takes. */
  parsed: PriceTiersParseResult;
  /** Territory codes in column order, and tier ids in row order: what the
   *  file covers (an absent column or row is "no override" for all of it). */
  territories: string[];
  tierIds: string[];
  /** territory → the currency its header states. */
  headerCurrency: Map<string, string>;
}

const NOT_EDIT_MESSAGE =
  'This is not an "Export for editing" file. Export the template with ' +
  '"Export for editing" on the matrix view, edit that file, and import it. ' +
  "(A pricing-template file is uploaded in Settings → Pricing templates.)";

/** Cheap sniff: does the workbook carry the info sheet? Reads only the sheet
 *  names. Never throws — anything unreadable is "not an edit file", and the
 *  caller's normal path decides what to say about it. */
export async function isMatrixEditFile(file: File): Promise<boolean> {
  try {
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", bookSheets: true });
    return wb.SheetNames.includes(EDIT_INFO_SHEET);
  } catch {
    return false;
  }
}

type Cell = XLSX.CellObject;

/** Cells that exist in a sheet, by row then column — `!ref` is not trusted. */
function cellsOf(ws: XLSX.WorkSheet): Map<number, Map<number, Cell>> {
  const rows = new Map<number, Map<number, Cell>>();
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    if (!rows.has(r)) rows.set(r, new Map());
    rows.get(r)!.set(c, ws[addr] as Cell);
  }
  return rows;
}

const addr = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });

/** A cell with nothing in it: absent, a stub (Numbers pads, merges leave
 *  partners), or whitespace text. A formula is NEVER empty. */
function isBlank(cell: Cell | undefined): boolean {
  if (!cell) return true;
  if (cell.f) return false;
  if (cell.t === "z") return true;
  return cell.t === "s" && String(cell.v ?? "").trim() === "";
}

function textOf(cell: Cell | undefined): string {
  return cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : "";
}

type PriceRead = { kind: "empty" } | { kind: "price"; value: number } | { kind: "bad"; reason: string };

/** Rules 2 and 3, for one Price cell. `.f` is checked BEFORE `.v`: a formula
 *  with no cached value reads as `{t:"z", v:0}` and would otherwise be 0. */
function readPrice(cell: Cell | undefined): PriceRead {
  if (cell?.f) return { kind: "bad", reason: "is a formula — type the price as a number" };
  if (isBlank(cell)) return { kind: "empty" };
  if (cell!.t === "n") {
    const v = cell!.v as number;
    if (!Number.isFinite(v) || v < 0) return { kind: "bad", reason: `${String(v)} is not a price (negative or not finite)` };
    if (v >= MAX_CUSTOMER_PRICE) return { kind: "bad", reason: `${String(v)} is too large to be a price` };
    if (!PRICE_NUMBER_RE.test(String(v))) {
      return { kind: "bad", reason: `${String(v)} has more than 4 decimals — Apple prices have at most 4` };
    }
    return { kind: "price", value: v };
  }
  if (cell!.t === "s") {
    const t = String(cell!.v).trim();
    if (t === "·") return { kind: "empty" };
    if (PRICE_TEXT_RE.test(t)) return { kind: "price", value: Number(t) };
    if (t.includes(",")) return { kind: "bad", reason: `"${t}" is text with a comma — type the price as a number (e.g. 49000)` };
    if (/^\d+\.\d{3}$/.test(t)) {
      return { kind: "bad", reason: `"${t}" is ambiguous text (forty-nine or forty-nine thousand?) — type the price as a number` };
    }
    return { kind: "bad", reason: `"${t}" is text, not a price` };
  }
  return { kind: "bad", reason: "is not a price (boolean, date or error value)" };
}

function readInfo(ws: XLSX.WorkSheet | undefined): Map<string, string> {
  const info = new Map<string, string>();
  if (!ws) return info;
  for (const [r, cols] of cellsOf(ws)) {
    if (r === 0) continue; // key | value header
    const key = textOf(cols.get(0));
    if (key) info.set(key, textOf(cols.get(1)));
  }
  return info;
}

function scopeFromInfo(info: Map<string, string>): { scope: EditScopeInfo | null; problems: MatrixEditProblem[] } {
  const where = `${EDIT_INFO_SHEET} sheet`;
  const problems: MatrixEditProblem[] = [];
  if (info.get("format") !== EDIT_FORMAT || info.get("version") !== EDIT_FORMAT_VERSION) {
    problems.push({
      cell: null,
      message:
        `The ${where} does not describe a supported file (format "${info.get("format") ?? ""}", ` +
        `version "${info.get("version") ?? ""}"). Export the template for editing again.`,
    });
    return { scope: null, problems };
  }
  const kind = info.get("scope");
  if (kind === "ACCOUNT" && info.get("account_id")) {
    return {
      scope: { kind: "ACCOUNT", accountId: info.get("account_id")!, accountName: info.get("account_name") ?? "" },
      problems,
    };
  }
  if (kind === "APP" && info.get("app_id")) {
    return {
      scope: {
        kind: "APP",
        appId: info.get("app_id")!,
        bundleId: info.get("bundle_id") ?? "",
        appName: info.get("app_name") ?? "",
      },
      problems,
    };
  }
  problems.push({
    cell: null,
    message: `The ${where} does not say which template the file belongs to. Export the template for editing again.`,
  });
  return { scope: null, problems };
}

/**
 * Parse an "Export for editing" file. Throws `MatrixEditFileError` with EVERY
 * problem found (not the first), or returns the file as format A's structure.
 *
 * `knownTiers` = `price_tiers` (tier_id → canonical tier_name): a tier row must
 * name a tier that exists, spelled exactly as it is stored (Q-H) — a new id or
 * a different spelling would otherwise create or rename a tier for EVERY
 * account (replaceTemplate upserts tier names into the global table).
 */
export async function parseMatrixEditFile(
  file: File,
  knownTiers: ReadonlyMap<string, string>,
): Promise<MatrixEditFile> {
  if (file.size > MAX_FILE_SIZE) {
    throw new MatrixEditFileError("INVALID_FILE", `File too large (${file.size} bytes, max ${MAX_FILE_SIZE}).`);
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
      type: "array",
      cellFormula: true,
      sheetStubs: true,
    });
  } catch {
    throw new MatrixEditFileError("NOT_EDIT_FILE", NOT_EDIT_MESSAGE);
  }
  if (!wb.SheetNames.includes(EDIT_INFO_SHEET)) {
    throw new MatrixEditFileError("NOT_EDIT_FILE", NOT_EDIT_MESSAGE);
  }

  const info = readInfo(wb.Sheets[EDIT_INFO_SHEET]);
  const { scope, problems: infoProblems } = scopeFromInfo(info);
  if (!scope) {
    throw new MatrixEditFileError("INVALID_FILE", infoProblems[0].message, infoProblems);
  }

  const sheetName = scope.kind === "ACCOUNT" ? MATRIX_SHEET_NAME.default : MATRIX_SHEET_NAME["per-app"];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    const message = `The sheet "${sheetName}" is missing — it holds the prices. Export the template for editing again.`;
    throw new MatrixEditFileError("INVALID_FILE", message, [{ cell: null, message }]);
  }

  const problems: MatrixEditProblem[] = [];
  const grid = cellsOf(ws);
  const row0 = grid.get(0) ?? new Map<number, Cell>();
  const row1 = grid.get(1) ?? new Map<number, Cell>();

  if (textOf(row0.get(0)) !== "Tier") {
    problems.push({ cell: "A1", message: 'must say "Tier" — the first column holds the tier names' });
  }

  // ── Territory columns: one pair (Price, Currency) per header ─────────────
  const pairs = new Map<number, { code: string; currency: string }>(); // pair index → territory
  const badHeaderPairs = new Set<number>(); // already reported — their cells are not re-reported
  const seenCode = new Map<string, string>(); // code → header address
  let lastPair = -1;
  for (const [, cols] of grid) for (const c of cols.keys()) if (c >= 1) lastPair = Math.max(lastPair, Math.floor((c - 1) / 2));
  for (let k = 0; k <= lastPair; k += 1) {
    const c = 1 + 2 * k;
    const headerCell = row0.get(c);
    if (isBlank(headerCell)) continue;
    const text = textOf(headerCell);
    const m = TERRITORY_HEADER_RE.exec(text);
    if (!m) {
      problems.push({ cell: addr(0, c), message: `territory header must look like "Vietnam (VNM_VND)" — got "${text}"` });
      badHeaderPairs.add(k);
      continue;
    }
    const [, , code, currency] = m;
    if (!KNOWN_TERRITORIES.has(code)) {
      problems.push({ cell: addr(0, c), message: `"${code}" is not a territory Apple sells in` });
      badHeaderPairs.add(k);
      continue;
    }
    if (seenCode.has(code)) {
      problems.push({ cell: addr(0, c), message: `${code} appears twice (also ${seenCode.get(code)}) — one column per territory` });
      badHeaderPairs.add(k);
      continue;
    }
    seenCode.set(code, addr(0, c));
    pairs.set(k, { code, currency });
    if (!isBlank(row0.get(c + 1))) {
      problems.push({ cell: addr(0, c + 1), message: "must be empty — it is the second half of the territory header" });
    }
    if (textOf(row1.get(c)) !== "Price") problems.push({ cell: addr(1, c), message: 'must say "Price"' });
    if (textOf(row1.get(c + 1)) !== "Currency") problems.push({ cell: addr(1, c + 1), message: 'must say "Currency"' });
  }

  // ── Every value must sit inside the grid ─────────────────────────────────
  for (const [r, cols] of grid) {
    for (const [c, cell] of cols) {
      if (c === 0 || isBlank(cell)) continue;
      const k = Math.floor((c - 1) / 2);
      if (pairs.has(k) || badHeaderPairs.has(k)) continue;
      problems.push({ cell: addr(r, c), message: "has a value but its column has no territory header" });
    }
  }

  // ── Tier rows ────────────────────────────────────────────────────────────
  const tiers: ParsedPriceTier[] = [];
  const seenTier = new Map<string, string>();
  const sortedRows = [...grid.keys()].filter((r) => r >= 2).sort((a, b) => a - b);
  let entryCount = 0;
  for (const r of sortedRows) {
    const cols = grid.get(r)!;
    const hasValue = [...cols.entries()].some(([, cell]) => !isBlank(cell));
    if (!hasValue) continue;
    const nameCell = cols.get(0);
    const name = textOf(nameCell);
    if (!name) {
      problems.push({ cell: addr(r, 0), message: "this row has values but no tier name" });
      continue;
    }
    const decoded = tierIdFromName(name);
    if (!decoded) {
      problems.push({ cell: addr(r, 0), message: `"${name}" is not a tier name (e.g. "Tier 5", "Free Tier", "Alternate Tier A")` });
      continue;
    }
    const canonical = knownTiers.get(decoded.tier_id);
    if (canonical === undefined) {
      problems.push({
        cell: addr(r, 0),
        message: `"${name}" — there is no such tier. New tiers come with a pricing-template file in Settings.`,
      });
      continue;
    }
    if (canonical !== name) {
      problems.push({ cell: addr(r, 0), message: `write the tier exactly as "${canonical}"` });
      continue;
    }
    if (seenTier.has(decoded.tier_id)) {
      problems.push({ cell: addr(r, 0), message: `${canonical} appears twice (also ${seenTier.get(decoded.tier_id)})` });
      continue;
    }
    seenTier.set(decoded.tier_id, addr(r, 0));

    const territories: ParsedTerritoryPrice[] = [];
    for (const [k, t] of pairs) {
      const pc = 1 + 2 * k;
      const price = readPrice(cols.get(pc));
      if (price.kind === "empty") continue; // rule 3 — the Currency cell beside it is ignored
      if (price.kind === "bad") {
        problems.push({ cell: addr(r, pc), message: price.reason });
        continue;
      }
      const curCell = cols.get(pc + 1);
      if (curCell?.f) {
        problems.push({ cell: addr(r, pc + 1), message: "is a formula — leave the currency as exported" });
      } else if (!isBlank(curCell) && textOf(curCell) !== "·" && textOf(curCell).toUpperCase() !== t.currency) {
        problems.push({
          cell: addr(r, pc + 1),
          message:
            `Currency says "${textOf(curCell)}" but the column is ${t.code}_${t.currency} — the currency ` +
            "comes from the column header (Apple's currency for that territory); change only the price",
        });
      }
      territories.push({ territory_code: t.code, currency_code: t.currency, customer_price: price.value, proceeds: null });
    }
    entryCount += territories.length;
    tiers.push({ tier_id: decoded.tier_id, tier_name: canonical, is_alternate: decoded.is_alternate, territories });
  }

  if (problems.length === 0 && entryCount === 0) {
    problems.push({
      cell: null,
      message:
        "The file has no prices. Importing it would remove every override of the template — " +
        "to remove a template, use Remove in Settings.",
    });
  }
  if (problems.length > 0) {
    throw new MatrixEditFileError(
      "INVALID_FILE",
      `The file cannot be imported: ${problems.length} problem${problems.length === 1 ? "" : "s"}. Nothing was written.`,
      problems,
    );
  }

  const territoryCodes = [...pairs.values()].map((p) => p.code);
  return {
    scope,
    exportedAt: info.get("exported_at") || null,
    exportedBy: info.get("exported_by") || null,
    parsed: {
      tiers,
      territory_count: territoryCodes.length,
      alternate_tier_count: tiers.filter((t) => t.is_alternate).length,
      populated_entry_count: entryCount,
      warnings: [],
    },
    territories: territoryCodes,
    tierIds: tiers.map((t) => t.tier_id),
    headerCurrency: new Map([...pairs.values()].map((p) => [p.code, p.currency])),
  };
}
