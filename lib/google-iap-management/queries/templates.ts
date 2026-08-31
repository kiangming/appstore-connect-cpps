/**
 * Pricing-template queries + mutations (g1.j).
 *
 * Mirrors the Apple IAP.p1 pattern: GLOBAL scope holds the Default
 * Template (at most one row, enforced by partial unique index); APP scope
 * holds at most one row per app. Replace-on-upload is wired via
 * delete-then-insert, transactional via two-step (delete header → insert
 * new header + entries) since supabase-js doesn't expose transactions
 * directly. A failed insert leaves the slot empty, which the upload UI
 * surfaces as an error.
 */
import { googleIapDb } from "../db";
import { microsToDecimal } from "../google/price-conversion";
import type { ParsedPricingEntry } from "../parsers/pricing-template-parser";

export type TemplateScope = "ACCOUNT" | "APP";

/**
 * G1b — mọi truy vấn template phải nói RÕ nó đang đọc template CỦA AI.
 *
 * Kiểu này là bản sao 1:1 của CHECK trong DB
 * (`pricing_templates_scope_coherent_check`, migration
 * 20260831000000): đúng MỘT trong hai cột định danh khác NULL. Cố ý —
 * trạng thái không mạch lạc không biểu diễn được, nên không cần guard
 * runtime cho tính mạch lạc ở từng hàm.
 *
 * ⚠ KHÔNG CÒN biến thể "GLOBAL". Trước G1 cả hệ thống dùng CHUNG một
 *   Default Template; từ G1 mỗi account một bản. Bỏ hẳn giá trị cũ khỏi
 *   kiểu là CỐ Ý: mọi `=== "GLOBAL"` còn sót lại thành LỖI TSC thay vì
 *   một nhánh chết im lặng.
 */
export type TemplateScopeRef =
  | { scope: "ACCOUNT"; accountId: string; appId: null }
  | { scope: "APP"; accountId: null; appId: string };

/**
 * ĐIỂM NGHẼN DUY NHẤT áp bộ lọc scope lên một query `pricing_templates`.
 *
 * ⚠ VÌ SAO TỒN TẠI: trước G1b mệnh đề lọc này được CHÉP TAY ở 10 chỗ
 *   (getGlobalTemplateOverview · getAppTemplateOverview ·
 *   getTemplateAvailability ×2 · replaceTemplate DELETE ·
 *   lookupTemplateEntriesForIdentifier · findTemplateId · templateExists ·
 *   listTemplateTiers · findCandidateTiersForCurrencyPrice), cộng 1 bản
 *   nữa ở template-matrix.ts. Mười một bản sao là mười một chỗ để sau này
 *   sửa một bên quên bên kia.
 *
 * ⚠ HÀM ĐỌC TEMPLATE MỚI PHẢI ĐI QUA ĐÂY. Tự chép `.eq("scope_type", …)`
 *   ở chỗ khác là mở lại đúng lớp lỗi đó. `templates.structure.test.ts`
 *   canh tính chất này.
 */
/**
 * Kiểm tính mạch lạc của ref. TÁCH RIÊNG khỏi `applyScopeFilter` là CỐ Ý,
 * không phải chia nhỏ cho đẹp.
 *
 * ⚠ TÍNH CHẤT PHẢI GIỮ: guard nổ TRƯỚC khi dựng client DB.
 *   `applyScopeFilter` nhận vào `db.from(...)`, nghĩa là `googleIapDb()`
 *   đã chạy xong rồi mới tới lượt nó. Trong môi trường thiếu biến môi
 *   trường, `googleIapDb()` ném "Missing SUPABASE_URL…" và NUỐT MẤT lỗi
 *   lập trình thật. Đo được, không phải suy đoán: khi guard còn nằm
 *   trong applyScopeFilter, 8 test Hotfix 17 đỏ với đúng thông báo đó.
 *   Vì vậy mỗi hàm công khai gọi `assertScopeRef(args)` ở DÒNG ĐẦU.
 */
function assertScopeRef(ref: TemplateScopeRef): void {
  if (ref.scope === "APP") {
    if (!ref.appId) {
      throw new Error('applyScopeFilter: scope="APP" requires a non-empty appId.');
    }
    return;
  }
  if (!ref.accountId) {
    throw new Error(
      'applyScopeFilter: scope="ACCOUNT" requires a non-empty accountId.',
    );
  }
}

function applyScopeFilter<T>(query: T, ref: TemplateScopeRef): T {
  // ⚠ VÌ SAO CÓ ÉP KIỂU Ở ĐÂY (lý do bắt buộc phải ghi, CLAUDE.md #9).
  //   Cách viết tự nhiên là ràng buộc generic đệ quy
  //   `T extends { eq: (col, val) => T }`. Đã thử: tsc bung TS2589
  //   "Type instantiation is excessively deep and possibly infinite" —
  //   ràng buộc tự tham chiếu đó nhân với kiểu builder nhiều tầng của
  //   supabase-js. Ép kiểu gói gọn TRONG hàm này, còn mọi call site vẫn
  //   giữ nguyên kiểu builder chính xác vì hàm trả đúng `T`.
  const q = query as unknown as {
    eq: (col: string, val: unknown) => typeof q;
  };
  // Gọi lại lần nữa: hàm này là điểm nghẽn cuối trước khi mệnh đề lọc
  // được sinh ra, nên nó tự bảo vệ mình chứ không tin caller đã kiểm.
  // `.eq("scope_account_id", "")` KHÔNG lỗi — nó khớp 0 dòng, rồi caller
  // đọc ra "account này chưa có template" và âm thầm rơi về nhánh khác.
  // Một câu trả lời SAI mà im lặng tệ hơn một ngoại lệ.
  assertScopeRef(ref);
  if (ref.scope === "APP") {
    return q.eq("scope_type", "APP").eq("scope_app_id", ref.appId) as unknown as T;
  }
  return q
    .eq("scope_type", "ACCOUNT")
    .eq("scope_account_id", ref.accountId) as unknown as T;
}

export interface PricingTemplateRow {
  id: string;
  scope_type: TemplateScope;
  scope_app_id: string | null;
  /** G1 M-1: account sở hữu bản Default này khi scope_type='ACCOUNT'. */
  scope_account_id: string | null;
  /** G1 M-1: NOT NULL ⇒ bản do migration nhân bản, CHƯA ai cấu hình
   *  riêng cho account. Đây là điều kiện rẽ nhánh của modal Replace ở
   *  G1c — KHÔNG so chuỗi `uploaded_by === "SYSTEM_MIGRATION"`, vì
   *  uploaded_by là dữ liệu người dùng nhập được, origin_note thì không. */
  origin_note: string | null;
  uploaded_at: string;
  uploaded_by: string;
  source_filename: string | null;
}

export interface TemplateOverview {
  template: PricingTemplateRow | null;
  tierCount: number;
  territoryCount: number;
  entryCount: number;
  sampleEntries: ParsedPricingEntry[];
}

export interface AppTemplateSummary {
  app_id: string;
  package_name: string;
  display_name: string | null;
  template: PricingTemplateRow;
  tier_count: number;
  entry_count: number;
}

const SAMPLE_SIZE = 50;

/** Cột header template. G1 M-1 thêm scope_account_id + origin_note; giữ
 *  MỘT hằng số để không đường đọc nào lỡ thiếu hai cột mới. */
const TEMPLATE_COLUMNS =
  "id, scope_type, scope_app_id, scope_account_id, uploaded_at, uploaded_by, source_filename, origin_note";

async function fetchOverviewForTemplate(
  template: PricingTemplateRow | null,
): Promise<TemplateOverview> {
  if (!template) {
    return {
      template: null,
      tierCount: 0,
      territoryCount: 0,
      entryCount: 0,
      sampleEntries: [],
    };
  }
  const db = googleIapDb();
  const { data: entries, error } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", template.id)
    .order("identifier", { ascending: true })
    .order("region_code", { ascending: true });

  if (error) {
    throw new Error(`Failed to load template entries: ${error.message}`);
  }
  const rows = (entries ?? []) as Array<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>;
  const tiers = new Set<string>();
  const territories = new Set<string>();
  for (const row of rows) {
    tiers.add(row.identifier);
    territories.add(row.region_code);
  }
  return {
    template,
    tierCount: tiers.size,
    territoryCount: territories.size,
    entryCount: rows.length,
    sampleEntries: rows.slice(0, SAMPLE_SIZE).map((r) => ({
      identifier: r.identifier,
      regionCode: r.region_code,
      currency: r.currency,
      priceMicros: r.price_micros,
    })),
  };
}

/**
 * Default Template CỦA MỘT ACCOUNT.
 *
 * ⚠ B1 — ĐỔI CHỮ KÝ THỦ CÔNG, tsc KHÔNG bắt được việc này.
 *   Bản trước tên `getGlobalTemplateOverview()`, KHÔNG nhận tham số nào,
 *   và hardcode `.eq("scope_type","GLOBAL")` ngay trong thân hàm. Nếu chỉ
 *   THÊM bộ lọc account vào thân hàm thì chữ ký không đổi ⇒ mọi call site
 *   vẫn biên dịch sạch trong khi hàm âm thầm đọc sai. ĐỔI TÊN chính là
 *   guard: nó biến mọi call site cũ thành lỗi tsc.
 */
export async function getAccountTemplateOverview(
  accountId: string,
): Promise<TemplateOverview> {
  assertScopeRef({ scope: "ACCOUNT", accountId, appId: null });
  const db = googleIapDb();
  const { data, error } = await applyScopeFilter(
    db.from("pricing_templates").select(TEMPLATE_COLUMNS),
    { scope: "ACCOUNT", accountId, appId: null },
  ).maybeSingle();
  if (error) {
    throw new Error(`Failed to load default template: ${error.message}`);
  }
  return fetchOverviewForTemplate((data as PricingTemplateRow | null) ?? null);
}

export async function getAppTemplateOverview(
  appId: string,
): Promise<TemplateOverview> {
  const db = googleIapDb();
  const { data, error } = await applyScopeFilter(
    db.from("pricing_templates").select(TEMPLATE_COLUMNS),
    { scope: "APP", appId, accountId: null },
  ).maybeSingle();
  if (error) {
    throw new Error(`Failed to load app template: ${error.message}`);
  }
  return fetchOverviewForTemplate((data as PricingTemplateRow | null) ?? null);
}

/**
 * G1c/C4 — RÒ RỈ CROSS-ACCOUNT ĐÃ SỬA.
 *
 * Trước G1c hàm này liệt kê template APP của MỌI account, trong khi
 * `listAppsForAccount` ngay cạnh nó trên CÙNG MỘT MÀN HÌNH thì có lọc:
 * hai nửa của một màn trả lời hai câu hỏi khác nhau.
 *
 * ⚠ LỌC Ở BƯỚC GHÉP APP, KHÔNG PHẢI BẰNG `.in()` DANH SÁCH APP.
 *   Lọc bằng cách nạp trước toàn bộ app của account rồi `.in(appIds)` sẽ
 *   đẩy 142 UUID (VNG Sing) vào query string. Repo này đã có tiền lệ đúng
 *   lớp đó: `.in()` quá dài làm gateway từ chối và đường đọc trả RỖNG
 *   (repository/iaps-list-read.test.ts). Ở đây `.in()` bị chặn trên bởi
 *   SỐ TEMPLATE (census: 3), không phải số app.
 */
export async function listAppTemplates(
  accountId: string,
): Promise<AppTemplateSummary[]> {
  const db = googleIapDb();
  const { data: templates, error } = await db
    .from("pricing_templates")
    .select(
      TEMPLATE_COLUMNS,
    )
    .eq("scope_type", "APP")
    .order("uploaded_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list app templates: ${error.message}`);
  }
  const rows = (templates ?? []) as PricingTemplateRow[];
  if (rows.length === 0) return [];

  const appIds = rows.map((r) => r.scope_app_id).filter((x): x is string => !!x);
  const { data: apps, error: appsErr } = await db
    .from("apps")
    .select("id, package_name, display_name, google_console_account_id")
    .in("id", appIds)
    .eq("google_console_account_id", accountId);
  if (appsErr) {
    throw new Error(`Failed to load app metadata: ${appsErr.message}`);
  }
  const appsById = new Map(
    ((apps ?? []) as Array<{
      id: string;
      package_name: string;
      display_name: string | null;
      google_console_account_id: string;
    }>).map((a) => [a.id, a]),
  );

  const { data: entries, error: entriesErr } = await db
    .from("pricing_template_entries")
    .select("template_id, identifier")
    .in(
      "template_id",
      rows.map((r) => r.id),
    );
  if (entriesErr) {
    throw new Error(`Failed to load entry counts: ${entriesErr.message}`);
  }
  const tierByTemplate = new Map<string, Set<string>>();
  const countByTemplate = new Map<string, number>();
  for (const e of (entries ?? []) as Array<{ template_id: string; identifier: string }>) {
    const set = tierByTemplate.get(e.template_id) ?? new Set<string>();
    set.add(e.identifier);
    tierByTemplate.set(e.template_id, set);
    countByTemplate.set(e.template_id, (countByTemplate.get(e.template_id) ?? 0) + 1);
  }

  return rows
    .map((t) => {
      const app = t.scope_app_id ? appsById.get(t.scope_app_id) : undefined;
      // `app` vắng mặt ở ĐÚNG HAI ca, và cả hai đều phải bị loại:
      //   1. hàng app đã bị xoá mà template còn sót (ca cũ);
      //   2. G1c — app thuộc account KHÁC nên không nằm trong lượt đọc
      //      đã lọc ở trên. Đây chính là chỗ rò rỉ được bịt.
      if (!app) return null;
      return {
        app_id: app.id,
        package_name: app.package_name,
        display_name: app.display_name,
        template: t,
        tier_count: tierByTemplate.get(t.id)?.size ?? 0,
        entry_count: countByTemplate.get(t.id) ?? 0,
      };
    })
    .filter((x): x is AppTemplateSummary => x !== null);
}

export type ReplaceTemplateInput = TemplateScopeRef & {
  uploadedBy: string;
  sourceFilename: string | null;
  entries: ParsedPricingEntry[];
};

export interface ReplaceTemplateResult {
  templateId: string;
  insertedEntryCount: number;
}

export async function replaceTemplate(
  input: ReplaceTemplateInput,
): Promise<ReplaceTemplateResult> {
  assertScopeRef(input);
  const db = googleIapDb();

  // Delete existing template in this slot (partial unique index ensures
  // at most one row).
  // ⚠ Replace = DELETE-rồi-INSERT. Bộ lọc của lệnh DELETE này là thứ
  //   quyết định XOÁ TEMPLATE CỦA AI. Trước G1b nó chép tay mệnh đề scope;
  //   thiếu bộ lọc account ở đây nghĩa là Manager upload Default cho
  //   account mình lại xoá Default của cả 6 account. Đi qua choke point.
  const { error: delErr } = await applyScopeFilter(
    db.from("pricing_templates").delete(),
    input,
  );
  if (delErr) {
    throw new Error(`Failed to clear existing template: ${delErr.message}`);
  }

  // Insert new header.
  const { data: inserted, error: insErr } = await db
    .from("pricing_templates")
    .insert({
      scope_type: input.scope,
      scope_app_id: input.appId,
      scope_account_id: input.accountId,
      uploaded_by: input.uploadedBy,
      source_filename: input.sourceFilename,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    throw new Error(`Failed to insert template header: ${insErr?.message ?? "unknown"}`);
  }
  const templateId = (inserted as { id: string }).id;

  // Insert entries in chunks so we don't exceed Supabase's per-request cap.
  let insertedCount = 0;
  const CHUNK = 500;
  for (let i = 0; i < input.entries.length; i += CHUNK) {
    const chunk = input.entries.slice(i, i + CHUNK).map((e) => ({
      template_id: templateId,
      identifier: e.identifier,
      region_code: e.regionCode,
      currency: e.currency,
      price_micros: e.priceMicros,
    }));
    if (chunk.length === 0) continue;
    const { error: chunkErr } = await db
      .from("pricing_template_entries")
      .insert(chunk);
    if (chunkErr) {
      throw new Error(
        `Failed to insert template entries (chunk starting at ${i}): ${chunkErr.message}`,
      );
    }
    insertedCount += chunk.length;
  }

  return { templateId, insertedEntryCount: insertedCount };
}

/** Availability flags for the 3-source pricing selector (Q-GIAP.D). */
export interface PricingTemplateAvailability {
  defaultExists: boolean;
  appExists: boolean;
}

/**
 * ⚠ B1 — ĐỔI CHỮ KÝ THỦ CÔNG, tsc KHÔNG bắt được. Bản trước nhận đúng
 *   `appId: string | null` và hardcode GLOBAL inline; thêm account vào
 *   thân hàm mà giữ nguyên chữ ký thì mọi call site vẫn xanh.
 *
 * ⚠ HÀM NGUY HIỂM NHẤT ARC. Nó KHÔNG ném lỗi — nó TRẢ VỀ SỐ. Đọc thiếu
 *   bộ lọc account thì `defaultExists` bật `true` nhờ template của
 *   account KHÁC, radio "Default Template" sáng lên, và `pickByPriority`
 *   (PricingSourceSelector.tsx:61-65) chọn đúng nguồn giá đó để ĐẨY LÊN
 *   GOOGLE. Không có exception nào ở giữa để ai kịp thấy.
 *   Vì thế test của nó khẳng định bằng GIÁ TRỊ ĐẾM ĐƯỢC, không phải bằng
 *   "có ném lỗi không" — templates.account-isolation.test.ts.
 */
export async function getTemplateAvailability(args: {
  accountId: string;
  appId: string | null;
}): Promise<PricingTemplateAvailability> {
  const db = googleIapDb();
  const accountCount = await applyScopeFilter(
    db.from("pricing_templates").select("id", { count: "exact", head: true }),
    { scope: "ACCOUNT", accountId: args.accountId, appId: null },
  );
  const defaultExists = (accountCount.count ?? 0) > 0;

  let appExists = false;
  if (args.appId) {
    const appCount = await applyScopeFilter(
      db.from("pricing_templates").select("id", { count: "exact", head: true }),
      { scope: "APP", appId: args.appId, accountId: null },
    );
    appExists = (appCount.count ?? 0) > 0;
  }
  return { defaultExists, appExists };
}

/** Lookup all entries for a given (scope, appId, identifier) tuple.
 *  Returns the most-specific template's entries when present
 *  (Q-GIAP.D: App template > Default template > base price). */
export async function lookupTemplateEntriesForIdentifier(
  args: TemplateScopeRef & { identifier: string },
): Promise<ParsedPricingEntry[]> {
  assertScopeRef(args);
  // Hotfix 17 (guard giữ nguyên ý nghĩa, đã chuyển vào applyScopeFilter):
  // scope=APP + thiếu appId phải NÉM, không được âm thầm rơi về Default.
  const db = googleIapDb();
  const { data: template, error } = await applyScopeFilter(
    db.from("pricing_templates").select("id"),
    args,
  ).maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;
  const { data: entries, error: entriesErr } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", templateId)
    .eq("identifier", args.identifier);
  if (entriesErr) {
    throw new Error(`Failed to load template entries: ${entriesErr.message}`);
  }
  return ((entries ?? []) as Array<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>).map((r) => ({
    identifier: r.identifier,
    regionCode: r.region_code,
    currency: r.currency,
    priceMicros: r.price_micros,
  }));
}

/** Pure helper: from a flat array of pricing-template entries, find the
 *  tier identifier whose (currency, price_micros) pair matches the
 *  request. Region-agnostic — within a single tier the (currency,
 *  price) pair uniquely identifies the tier even when multiple regions
 *  share the same currency (e.g. multiple Eurozone regions under EUR
 *  all carry the same tier-EUR price).
 *
 *  Hotfix 16 generalisation: replaces the USD-only `pickTierByUsdMicros`
 *  helper Hotfix 15 shipped. Backward-compat alias preserved below.
 *
 *  Returns the first matching tier identifier (deterministic = query
 *  order). Returns null when no entry matches.
 *
 *  Exported so it can be unit-tested without mocking the DB client.
 *  Used by `findTemplateTierByCurrencyMicros` (the I/O wrapper). */
export function pickTierByCurrencyMicros(
  entries: ReadonlyArray<{
    identifier: string;
    currency: string;
    price_micros: string;
  }>,
  currencyCode: string,
  priceMicros: string,
): string | null {
  const normalisedCurrency = currencyCode.trim().toUpperCase();
  for (const e of entries) {
    if (e.currency !== normalisedCurrency) continue;
    if (e.price_micros === priceMicros) return e.identifier;
  }
  return null;
}
/* B4 (G1b) — ĐÃ XOÁ 3 HÀM CHẾT, 0 caller sản phẩm tại thời điểm xoá:
 *   pickTierByUsdMicros · findTemplateTierByCurrencyMicros ·
 *   findTemplateTierByUsdMicros
 * Cả ba là di sản Hotfix 15/16. Hai hàm I/O trong số đó nhận
 * `{scope, appId}` KHÔNG có account — giữ lại qua G1 nghĩa là để sẵn hai
 * đường đọc template KHÔNG lọc account cho người sau vô tình gọi.
 * Bảng đối chiếu test cũ → bản thay: xem báo cáo B4.
 */

/** Hotfix 18: companion to `templateExists` — returns the template id
 *  (UUID) for the given scope, or null if no template row exists.
 *  Used by orchestrators that need to surface which template was
 *  actually queried in audit logs + diagnostic traces (Manager debugging
 *  "audit says matched but Google received wrong price").
 *
 *  Same defensive guard as the sibling helpers: scope=APP without an
 *  appId throws before any DB I/O. */
export async function findTemplateId(
  args: TemplateScopeRef,
): Promise<string | null> {
  assertScopeRef(args);
  const db = googleIapDb();
  const { data, error } = await applyScopeFilter(
    db.from("pricing_templates").select("id"),
    args,
  ).maybeSingle();
  if (error) {
    throw new Error(`findTemplateId failed: ${error.message}`);
  }
  return data ? (data as { id: string }).id : null;
}

/** Hotfix 17: lightweight existence probe — returns true when a
 *  template row exists for the given scope. For scope=APP an appId is
 *  required; throws when missing (same defensive stance as
 *  `lookupTemplateEntriesForIdentifier` / `findTemplateTierByCurrencyMicros`).
 *
 *  Used by `executeBulkImport`'s pre-flight: when Manager selects
 *  `app_template` but no Per-App template has been uploaded for this
 *  app, the orchestrator fails fast with an actionable message rather
 *  than silently auto-bootstrapping every row and leaving Manager to
 *  wonder why "Per-App" produced auto-converted prices. */
/** ⚠ Hàm count/head: KHÔNG ném khi đọc thiếu bộ lọc, chỉ TRẢ SỐ SAI.
 *  Cùng lớp nguy hiểm với `getTemplateAvailability` — nó là pre-flight
 *  của bulk import, đếm sai là cho qua rồi mới hỏng ở giữa chừng. Test
 *  khẳng định bằng GIÁ TRỊ, không bằng "có ném không". */
export async function templateExists(
  args: TemplateScopeRef,
): Promise<boolean> {
  assertScopeRef(args);
  const db = googleIapDb();
  const { count, error } = await applyScopeFilter(
    db.from("pricing_templates").select("id", { head: true, count: "exact" }),
    args,
  );
  if (error) {
    throw new Error(`Template existence probe failed: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

/** List distinct tier identifiers under the active scope (used by the
 *  single-IAP form's tier picker when Manager picks a template source). */
export async function listTemplateTiers(
  args: TemplateScopeRef,
): Promise<string[]> {
  assertScopeRef(args);
  const db = googleIapDb();
  const { data: template, error } = await applyScopeFilter(
    db.from("pricing_templates").select("id"),
    args,
  ).maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;
  const { data: rows, error: rowsErr } = await db
    .from("pricing_template_entries")
    .select("identifier")
    .eq("template_id", templateId)
    .order("identifier", { ascending: true });
  if (rowsErr) {
    throw new Error(`Failed to load tier identifiers: ${rowsErr.message}`);
  }
  const seen = new Set<string>();
  for (const r of (rows ?? []) as Array<{ identifier: string }>) {
    seen.add(r.identifier);
  }
  return [...seen];
}

/** Hotfix 19: tier candidate descriptor surfaced to the Bulk Import wizard
 *  Preview step so Manager can disambiguate when multiple template tiers
 *  share the same `(currency, priceMicros)` pair. Production trap (batch
 *  4895756e, PASS SDK): a Per-App template had 4 tiers all priced 0.99
 *  USD — `pickTierByCurrencyMicros` returned the first one silently and
 *  Google received the wrong VN value (25,000 VND instead of 27,000 VND).
 *
 *  `vnCurrency` / `vnPriceMicros` / `vnPriceDecimal` are the VN-region
 *  row inside this tier (null when the tier has no VN entry). VN is
 *  surfaced because the Manager primarily reads VND prices when
 *  distinguishing tiers — the dropdown format is
 *  "{identifier} — {vnPriceDecimal} VND · {regionCount} regions". */
export interface TierCandidate {
  identifier: string;
  templateId: string;
  regionCount: number;
  vnCurrency: string | null;
  vnPriceMicros: string | null;
  vnPriceDecimal: string | null;
}

/** Pure helper: given a flat list of pricing-template entries and the
 *  set of candidate tier identifiers, build per-tier `TierCandidate`
 *  descriptors. Exported so the wizard's pre-selection / formatting
 *  paths can be unit-tested without mocking Supabase.
 *
 *  - `regionCount` counts distinct `region_code` values per tier.
 *  - VN entry: first row in `entries` where `region_code === "VN"` (the
 *    template parser writes one row per tier+region pair, so a single
 *    `find` is sufficient — a defensive `null` is returned when no VN
 *    row exists). */
export function buildCandidatesFromEntries(
  templateId: string,
  identifiers: ReadonlyArray<string>,
  entries: ReadonlyArray<{
    identifier: string;
    region_code: string;
    currency: string;
    price_micros: string;
  }>,
): TierCandidate[] {
  return identifiers.map((id) => {
    const tierEntries = entries.filter((e) => e.identifier === id);
    const vnEntry = tierEntries.find((e) => e.region_code === "VN") ?? null;
    const regionCount = new Set(tierEntries.map((e) => e.region_code)).size;
    return {
      identifier: id,
      templateId,
      regionCount,
      vnCurrency: vnEntry?.currency ?? null,
      vnPriceMicros: vnEntry?.price_micros ?? null,
      // Strip trailing fractional zeros so VND/JPY (zero-fraction
      // currencies) render as "27000" not "27000.000000" without losing
      // precision for fractional currencies (e.g. "0.99" stays "0.99").
      vnPriceDecimal: vnEntry
        ? stripTrailingZeros(microsToDecimal(vnEntry.price_micros, 6))
        : null,
    };
  });
}

function stripTrailingZeros(decimal: string): string {
  if (!decimal.includes(".")) return decimal;
  return decimal.replace(/\.?0+$/, "");
}

/** Hotfix 19: returns *all* tier identifiers whose `(currency,
 *  priceMicros)` row matches the request — not just the first match
 *  (which was Hotfix 15/16's behaviour and the root cause of batch
 *  4895756e). The Bulk Import Preview step uses the array length to
 *  decide between read-only (==1) and dropdown (>1) rendering.
 *
 *  Same defensive guards as the sibling helpers (Hotfix 17): scope=APP
 *  without `appId` throws before any DB I/O. */
export async function findCandidateTiersForCurrencyPrice(
  args: TemplateScopeRef & { currencyCode: string; priceMicros: string },
): Promise<TierCandidate[]> {
  assertScopeRef(args);
  const db = googleIapDb();
  const { data: template, error } = await applyScopeFilter(
    db.from("pricing_templates").select("id"),
    args,
  ).maybeSingle();
  if (error) {
    throw new Error(`Failed to look up template: ${error.message}`);
  }
  if (!template) return [];
  const templateId = (template as { id: string }).id;

  const normalisedCurrency = args.currencyCode.trim().toUpperCase();
  const { data: matchingRows, error: matchErr } = await db
    .from("pricing_template_entries")
    .select("identifier")
    .eq("template_id", templateId)
    .eq("currency", normalisedCurrency)
    .eq("price_micros", args.priceMicros);
  if (matchErr) {
    throw new Error(
      `Failed to load candidate tiers (${normalisedCurrency}/${args.priceMicros}): ${matchErr.message}`,
    );
  }
  const candidateIdentifiers = Array.from(
    new Set(
      ((matchingRows ?? []) as Array<{ identifier: string }>).map(
        (r) => r.identifier,
      ),
    ),
  );
  if (candidateIdentifiers.length === 0) return [];

  // Fetch all rows for the candidate tiers so we can build per-tier
  // metadata (region count + VN entry). Single query keeps fan-out
  // bounded — `IN` clause on identifier handles all candidates at once.
  const { data: allRows, error: allErr } = await db
    .from("pricing_template_entries")
    .select("identifier, region_code, currency, price_micros")
    .eq("template_id", templateId)
    .in("identifier", candidateIdentifiers);
  if (allErr) {
    throw new Error(
      `Failed to load candidate tier metadata: ${allErr.message}`,
    );
  }
  return buildCandidatesFromEntries(
    templateId,
    candidateIdentifiers,
    (allRows ?? []) as Array<{
      identifier: string;
      region_code: string;
      currency: string;
      price_micros: string;
    }>,
  );
}

/** Hotfix 19: unified per-row candidate lookup. Mirrors the
 *  orchestrator's two-strategy logic so the Preview API and the
 *  orchestrator agree on what the candidate set is for each row.
 *
 *  Strategy 1 (documented): SKU == template identifier — exact match.
 *  Strategy 2 (Hotfix 16): `(currency, priceMicros)` fallback. May
 *  return >1 candidates when Manager's template has alternate tiers
 *  sharing the same price (the trap Hotfix 19 fixes).
 *
 *  Caller decides ambiguity rendering:
 *    candidates.length === 0 → no template match → auto-bootstrap
 *    candidates.length === 1 → unambiguous → render read-only
 *    candidates.length  >  1 → ambiguous   → Manager picks via dropdown */
export async function findRowCandidates(
  args: TemplateScopeRef & {
    sku: string;
    currencyCode: string;
    priceMicros: string;
  },
): Promise<{
  candidates: TierCandidate[];
  matchedBy: "sku" | "currency_price" | "none";
}> {
  // ⚠ Truyền NGUYÊN ref xuống, không tách rồi ghép lại từng trường: tách
  //   ra là chỗ để quên `accountId` mà vẫn biên dịch sạch.
  const skuEntries = await lookupTemplateEntriesForIdentifier({
    ...args,
    identifier: args.sku,
  });
  if (skuEntries.length > 0) {
    const templateId = await findTemplateId(args);
    const candidates = buildCandidatesFromEntries(
      templateId ?? "",
      [args.sku],
      skuEntries.map((e) => ({
        identifier: args.sku,
        region_code: e.regionCode,
        currency: e.currency,
        price_micros: e.priceMicros,
      })),
    );
    return { candidates, matchedBy: "sku" };
  }
  const candidates = await findCandidateTiersForCurrencyPrice(args);
  return {
    candidates,
    matchedBy: candidates.length > 0 ? "currency_price" : "none",
  };
}

/** Pure helper: Q5.B primary-tier preference algorithm.
 *
 *  Selects a sensible default tier when multiple candidates share the
 *  same `(currency, priceMicros)`. Pure function so the UI's "primary
 *  tier pre-selected" behaviour is unit-testable.
 *
 *  Algorithm (Manager-locked, 2026-05-23):
 *    1. Filter out identifiers starting with "Alternate" (case-insensitive,
 *       word-boundary so "AlternateX" without space still matches).
 *    2. If anything remains, return the first in numeric-ascending order
 *       (Intl.Collator { numeric: true }). "Tier 1" beats "Tier 10".
 *    3. If everything was Alternate, return the first in numeric-ascending
 *       order across the full set — "Alternate Tier 1" beats "Alternate
 *       Tier A" (numeric beats alpha).
 *
 *  Returns null only when the input is empty (caller's responsibility
 *  to handle no-candidates separately — different UI state). */
export function getPrimaryTierFromCandidates(
  candidates: ReadonlyArray<{ identifier: string }>,
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].identifier;
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const isAlternate = (id: string) => /^alternate\b/i.test(id.trim());
  const nonAlternate = candidates.filter((c) => !isAlternate(c.identifier));
  const pool = nonAlternate.length > 0 ? nonAlternate : candidates;
  const sorted = [...pool].sort((a, b) =>
    collator.compare(a.identifier, b.identifier),
  );
  return sorted[0].identifier;
}

/**
 * G1c — TRA scope của một template THEO ID, để route biết mình đang gác
 * cái gì TRƯỚC khi xoá.
 *
 * ⚠ VÌ SAO TỒN TẠI: `deleteTemplate(id)` xoá theo id trần. Một gate đặt
 *   trước nó mà không biết id đó là template ACCOUNT hay APP thì hoặc gác
 *   nhầm (chặn cả APP, đổi quy tắc hiện có), hoặc không gác gì (ai cũng
 *   xoá được Default của cả 6 account). Đọc trước, gác sau.
 */
export interface TemplateScopeProbe {
  id: string;
  scope_type: TemplateScope;
  scope_app_id: string | null;
  scope_account_id: string | null;
  uploaded_by: string;
  origin_note: string | null;
}

export async function getTemplateScopeById(
  templateId: string,
): Promise<TemplateScopeProbe | null> {
  const db = googleIapDb();
  const { data, error } = await db
    .from("pricing_templates")
    .select(
      "id, scope_type, scope_app_id, scope_account_id, uploaded_by, origin_note",
    )
    .eq("id", templateId)
    .maybeSingle();
  if (error) {
    throw new Error(`getTemplateScopeById failed: ${error.message}`);
  }
  return (data as TemplateScopeProbe | null) ?? null;
}

/**
 * ⚠ XOÁ THEO ID TRẦN — CÓ CHỦ Ý, nhưng KHÔNG được gọi thẳng từ route.
 *   Route phải `getTemplateScopeById` trước để biết áp gate nào
 *   (G1c: ACCOUNT → gate admin; APP → quy tắc cũ là mọi user đã đăng
 *   nhập). Test hàng rào canh đúng thứ tự đó:
 *   pricing-templates-delete-gate.test.ts
 */
export async function deleteTemplate(templateId: string): Promise<void> {
  const db = googleIapDb();
  const { error } = await db.from("pricing_templates").delete().eq("id", templateId);
  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}
