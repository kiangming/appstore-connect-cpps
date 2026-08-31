/**
 * Cycle 36 — pricing-template matrix data composer.
 *
 * Builds the `{ tiers, markets, cells }` shape the Default and Per-App
 * matrix views consume. Pure functions over a flat
 * `pricing_template_entries` array — the DB-bound wrappers live below
 * and call `composeMatrix` after fetching.
 *
 * Cell key is `${tier_identifier}|${region_code}` — the natural unique
 * key for a template entry. The composer never mutates input.
 *
 * Per-App matrix views need diff info against the Default Template; the
 * composer accepts an optional `defaultEntries` parameter and, when
 * present, annotates each cell with `defaultPriceMicros` / `isDiff` so
 * the client can render the ★ marker + tooltip without re-fetching.
 */
import { googleIapDb } from "../db";
import { findTemplateId } from "./templates";
import {
  getContinentForRegion,
  type Continent,
} from "../region-continent";
import { regionNameFromCode } from "../region-name";

/** Raw row shape from `pricing_template_entries`. */
export interface TemplateEntryRow {
  identifier: string;
  region_code: string;
  currency: string;
  price_micros: string;
  /** G1d — thứ tự CỘT trong file .xlsx nguồn, 1-based. NULL = hàng có
   *  trước G1d mà M-1 chưa backfill (xem `columnOrderUnknown`). */
  sort_order?: number | null;
}

export interface MatrixMarket {
  code: string;
  name: string;
  currency: string;
  continent: Continent | null;
}

export interface MatrixCell {
  priceMicros: string;
  currency: string;
  /** Present only when a Default Template was passed alongside the
   *  primary entries — the Per-App view uses it to render the diff
   *  tooltip. Identical-cell semantics: same currency + same micros. */
  defaultPriceMicros?: string;
  defaultCurrency?: string;
  isDiff?: boolean;
}

export interface MatrixData {
  tiers: string[];
  markets: MatrixMarket[];
  /** Sparse map keyed by `${tier}|${region}`. */
  cells: Record<string, MatrixCell>;
  /** Currencies actually used by the template, sorted alphabetically.
   *  Powers the "template-used currencies only" dropdown (Manager Q2). */
  currenciesUsed: string[];
  /** Per-continent market counts. UI uses these in the toggle pills. */
  continentCounts: Record<Continent, number>;
  /**
   * G1d/D3 — CỜ BÁO THỨ TỰ CỘT KHÔNG ĐÁNG TIN.
   *
   * `true` khi có entry mang `sort_order` NULL. Khi đó thứ tự cột được
   * giữ NGUYÊN như thứ tự dòng đọc về (đúng hành vi trước G1d), chứ
   * KHÔNG rơi về alphabet — Hotfix 24 đã sửa đúng lỗi alphabet-hoá đó
   * một lần rồi, tái phạm âm thầm là tệ hơn cả ban đầu.
   *
   * ⚠ CỜ NÀY TỒN TẠI ĐỂ KHÔNG IM LẶNG. Ca sinh ra nó rất hẹp — template
   * upload trong cửa sổ giữa M-1 và deploy G1d — nhưng nếu có thì màn
   * đang hiện một thứ tự cột KHÔNG bảo đảm, và người xem phải biết điều
   * đó thay vì tin nhầm.
   */
  columnOrderUnknown: boolean;
}

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Tier sort: numeric-aware so "Tier 2" < "Tier 10"; non-Alternate
 *  identifiers precede Alternate ones. Mirrors the spirit of
 *  `getPrimaryTierFromCandidates` in `queries/templates.ts` (Hotfix 19). */
function compareTiers(a: string, b: string): number {
  const isAltA = /^alternate\b/i.test(a.trim());
  const isAltB = /^alternate\b/i.test(b.trim());
  if (isAltA !== isAltB) return isAltA ? 1 : -1;
  return COLLATOR.compare(a, b);
}

/** Pure composer: take a flat entry list (optionally + a Default
 *  Template entry list for diff) and yield the matrix shape. */
export function composeMatrix(
  entries: ReadonlyArray<TemplateEntryRow>,
  defaultEntries?: ReadonlyArray<TemplateEntryRow>,
): MatrixData {
  const tierSet = new Set<string>();
  const marketCurrencyByCode = new Map<string, string>();
  /** sort_order nhỏ nhất quan sát được cho mỗi region. */
  const marketSortByCode = new Map<string, number>();
  let sawNullSortOrder = false;
  const cells: Record<string, MatrixCell> = {};
  const currenciesUsed = new Set<string>();

  for (const e of entries) {
    tierSet.add(e.identifier);
    if (!marketCurrencyByCode.has(e.region_code)) {
      marketCurrencyByCode.set(e.region_code, e.currency);
    }
    if (e.sort_order === null || e.sort_order === undefined) {
      sawNullSortOrder = true;
    } else {
      const prev = marketSortByCode.get(e.region_code);
      if (prev === undefined || e.sort_order < prev) {
        marketSortByCode.set(e.region_code, e.sort_order);
      }
    }
    currenciesUsed.add(e.currency);
    const key = `${e.identifier}|${e.region_code}`;
    cells[key] = { priceMicros: e.price_micros, currency: e.currency };
  }

  if (defaultEntries) {
    const defaultByKey = new Map<string, { priceMicros: string; currency: string }>();
    for (const d of defaultEntries) {
      defaultByKey.set(`${d.identifier}|${d.region_code}`, {
        priceMicros: d.price_micros,
        currency: d.currency,
      });
    }
    for (const [key, cell] of Object.entries(cells)) {
      const def = defaultByKey.get(key);
      if (!def) continue;
      cell.defaultPriceMicros = def.priceMicros;
      cell.defaultCurrency = def.currency;
      cell.isDiff =
        def.priceMicros !== cell.priceMicros || def.currency !== cell.currency;
    }
  }

  const tiers = Array.from(tierSet).sort(compareTiers);

  // G1d — THỨ TỰ CỘT LÀ `sort_order`, TƯỜNG MINH.
  //
  // Hotfix 24 giữ đúng ý định (thứ tự nước theo file Excel của Manager,
  // KHÔNG phải alphabet) nhưng giữ bằng một thứ không cam kết: Map iterate
  // theo thứ tự chèn = thứ tự dòng Postgres trả về khi SELECT không
  // ORDER BY. G1d giữ NGUYÊN ý định đó và thay chỗ dựa: cột nay sắp theo
  // `sort_order` do parser ghi lúc upload.
  //
  // ⚠ Sắp TƯỜNG MINH chứ không dựa vào thứ tự dòng đến, kể cả khi truy vấn
  //   đã có ORDER BY: với template THƯA, một nước chỉ xuất hiện ở tier về
  //   sau sẽ được gặp muộn và rơi xuống cuối dù sort_order của nó nhỏ.
  //
  // ⚠ KHÔNG có nhánh nào rơi về alphabet. Khi thiếu sort_order
  //   (`columnOrderUnknown`), giữ NGUYÊN thứ tự dòng đến — đúng hành vi
  //   trước G1d — và báo bằng cờ, chứ không lặng lẽ đổi sang alphabet.
  const marketCodes = Array.from(marketCurrencyByCode.keys());
  if (!sawNullSortOrder) {
    marketCodes.sort(
      (a, b) =>
        (marketSortByCode.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (marketSortByCode.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  const markets: MatrixMarket[] = marketCodes.map((code) => ({
    code,
    name: regionNameFromCode(code),
    currency: marketCurrencyByCode.get(code) as string,
    continent: getContinentForRegion(code),
  }));

  const continentCounts: Record<Continent, number> = {
    Asia: 0,
    Europe: 0,
    Americas: 0,
    Africa: 0,
    Oceania: 0,
  };
  for (const m of markets) {
    if (m.continent) continentCounts[m.continent] += 1;
  }

  return {
    tiers,
    markets,
    cells,
    currenciesUsed: Array.from(currenciesUsed).sort(),
    continentCounts,
    columnOrderUnknown: sawNullSortOrder,
  };
}

/** Fetch every entry for a template id. Returns [] when templateId is
 *  null (caller's responsibility to short-circuit the empty-state UI). */
async function fetchEntriesForTemplate(
  templateId: string | null,
): Promise<TemplateEntryRow[]> {
  if (!templateId) return [];
  const db = googleIapDb();
  const { data, error } = await db
    .from("pricing_template_entries")
    // G1d — cùng hợp đồng thứ tự với đường overview bên templates.ts
    // (xem doc của ENTRY_SELECT ở đó): `(identifier, sort_order)`.
    //
    // ⚠ ĐO ĐƯỢC, GHI LẠI ĐỂ KHỎI HIỂU LẦM: bỏ hai dòng `.order()` này
    //   KHÔNG làm test nào đỏ (đột biến D4-1). KHÔNG phải test thiếu
    //   răng — là vì `composeMatrix` nay sắp cột TƯỜNG MINH theo
    //   `sort_order` và các ô thì tra theo khoá `tier|region`, nên thứ
    //   tự dòng trả về không còn quan sát được QUA MA TRẬN. Đó chính là
    //   điều G1d muốn: bảo đảm không còn treo vào thứ tự dòng nữa.
    //   GIỮ hai dòng này vì (a) D2 yêu cầu hai đường đọc CÙNG một hợp
    //   đồng, và (b) bất kỳ người dùng tương lai nào đọc thẳng kết quả
    //   hàm này sẽ nhận thứ tự xác định thay vì tuỳ Postgres.
    .select("identifier, region_code, currency, price_micros, sort_order")
    .eq("template_id", templateId)
    .order("identifier", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) {
    throw new Error(`Failed to load template entries: ${error.message}`);
  }
  return (data ?? []) as TemplateEntryRow[];
}

/* G1b — `findTemplateIdForScope` ĐÃ XOÁ. Nó là BẢN SAO THỨ 11 của mệnh
 * đề lọc scope, đứng riêng ở file này nên mọi lần siết bảo mật bên
 * templates.ts đều bỏ sót nó. Thay bằng `findTemplateId` — cùng một
 * điểm nghẽn `applyScopeFilter` với 10 đường còn lại.
 * Đây chính là ĐƯỜNG ẨN mà census cảnh báo: nó được gọi BÊN TRONG
 * `fetchPerAppMatrix`, nên grep ở tầng page KHÔNG nhìn thấy. */

/** Server-side fetcher for the Default matrix view của MỘT account.
 *  Trả null khi account đó chưa có Default Template — page render empty
 *  state. */
export async function fetchDefaultMatrix(
  accountId: string,
): Promise<MatrixData | null> {
  const templateId = await findTemplateId({
    scope: "ACCOUNT",
    accountId,
    appId: null,
  });
  if (!templateId) return null;
  const entries = await fetchEntriesForTemplate(templateId);
  if (entries.length === 0) return null;
  return composeMatrix(entries);
}

/** Server-side fetcher for the Per-App matrix view. Loads the app's
 *  entries + the Default Template entries (when present) so the
 *  composer can annotate diff cells. Returns null when the Per-App
 *  template has not been uploaded — the page renders the empty state. */
export async function fetchPerAppMatrix(args: {
  appId: string;
  /**
   * ⚠ HỢP ĐỒNG (quyết định Manager, 2026-08-31 — ĐỪNG "sửa cho nhất quán"):
   *   ĐÂY LÀ ACCOUNT SỞ HỮU APP (`apps.google_console_account_id`),
   *   KHÔNG PHẢI account đang active trong cookie.
   *
   *   Cookie là trạng thái ĐIỀU HƯỚNG UI; nó trả lời "người dùng đang
   *   xem account nào", không trả lời "app này thuộc về ai". Hai câu đó
   *   TÁCH NHAU thật, không phải lý thuyết: `getAppById` không lọc
   *   account (repository/apps.ts), và census đã chứng minh có 2 package
   *   nằm dưới 2 account khác nhau.
   *
   *   Lấy nhầm cookie ⇒ ma trận Per-App so giá với Default của account
   *   KHÁC, và bulk-import đẩy giá theo Default sai lên Google. Cùng họ
   *   với vụ ghi đè 1140 ô ở arc Apple C-D, nhưng tệ hơn: Apple ghi đè
   *   template (nhìn thấy được), đây là GIÁ SAI đã lên store.
   *
   *   Test ghim tính chất này: template-matrix.account-isolation.test.ts
   *   — fixture app thuộc account B trong khi cookie active là A.
   */
  accountId: string;
}): Promise<MatrixData | null> {
  const [perAppTemplateId, defaultTemplateId] = await Promise.all([
    findTemplateId({ scope: "APP", appId: args.appId, accountId: null }),
    findTemplateId({
      scope: "ACCOUNT",
      accountId: args.accountId,
      appId: null,
    }),
  ]);
  if (!perAppTemplateId) return null;
  const [perAppEntries, defaultEntries] = await Promise.all([
    fetchEntriesForTemplate(perAppTemplateId),
    fetchEntriesForTemplate(defaultTemplateId),
  ]);
  if (perAppEntries.length === 0) return null;
  return composeMatrix(perAppEntries, defaultEntries);
}
