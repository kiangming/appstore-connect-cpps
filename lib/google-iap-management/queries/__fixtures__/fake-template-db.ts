/**
 * Fake Supabase builder cho hai bảng `pricing_templates` +
 * `pricing_template_entries`, CÓ LỌC THẬT.
 *
 * ⚠ Vì sao lọc thật chứ không phải spy đếm lời gọi `.eq()`: hai hàm
 * count/head của module (`templateExists`, `getTemplateAvailability`)
 * KHÔNG ném lỗi khi thiếu bộ lọc — chúng trả số sai. Chỉ một fake lọc
 * thật mới cho phép khẳng định bằng GIÁ TRỊ ĐỌC RA, và chỉ khẳng định
 * bằng giá trị mới đỏ khi ai đó xoá mệnh đề lọc account.
 *
 * Dùng chung bởi templates.account-isolation.test.ts và
 * template-matrix.account-isolation.test.ts — một bản fake, để hai file
 * không trôi khỏi nhau.
 */
export const ACCT_A = "acct-aaaa";
export const ACCT_B = "acct-bbbb";

export type TplRow = {
  id: string;
  scope_type: string;
  scope_app_id: string | null;
  scope_account_id: string | null;
  uploaded_at: string;
  uploaded_by: string;
  source_filename: string | null;
  origin_note: string | null;
};
export type EntryRow = {
  template_id: string;
  identifier: string;
  region_code: string;
  currency: string;
  price_micros: string;
  sort_order: number | null;
};

export function tpl(id: string, over: Partial<TplRow>): TplRow {
  return {
    id,
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: null,
    uploaded_at: "2026-05-21T00:00:00Z",
    uploaded_by: "SYSTEM_MIGRATION",
    source_filename: "t.xlsx",
    origin_note: "bản sao",
    ...over,
  };
}

/** Fake mô hình đúng hai bảng, có LỌC THẬT — nhờ vậy khẳng định nằm ở
 *  GIÁ TRỊ đọc ra, không phải ở việc "đã gọi .eq() nào". */
export type AppRow = {
  id: string;
  package_name: string;
  display_name: string | null;
  google_console_account_id: string;
};

export class FakeDb {
  templates: TplRow[] = [];
  entries: EntryRow[] = [];
  apps: AppRow[] = [];
  nextId = 1;
  from(table: string) {
    return new FakeBuilder(this, table);
  }
}

class FakeBuilder {
  private filters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private orderBy: Array<[string, boolean]> = [];
  private head = false;
  private op: "select" | "delete" | "insert" = "select";
  private payload: unknown = null;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select(_cols?: string, opts?: { head?: boolean; count?: string }) {
    if (opts?.head) this.head = true;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  insert(payload: unknown) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.inFilters.push([col, vals]);
    return this;
  }
  /**
   * ⚠ SẮP THẬT, không phải no-op.
   *
   * Bản đầu của fake này trả thẳng `this` cho `.order()`. Một fake như
   * thế làm MỌI test về thứ tự thành vô nghĩa: chúng xanh kể cả khi truy
   * vấn thật không có ORDER BY nào — đúng loại "phép đo tự vô hiệu".
   * Nhiều lời gọi `.order()` xếp chồng thành khoá phụ, như PostgREST.
   * NULL xếp cuối ở chiều tăng, khớp mặc định của Postgres.
   */
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push([col, opts?.ascending !== false]);
    return this;
  }
  private rows(): Array<Record<string, unknown>> {
    const src: Array<Record<string, unknown>> =
      this.table === "pricing_templates"
        ? (this.db.templates as unknown as Array<Record<string, unknown>>)
        : this.table === "apps"
          ? (this.db.apps as unknown as Array<Record<string, unknown>>)
          : (this.db.entries as unknown as Array<Record<string, unknown>>);
    const out = src
      .filter((r) => this.filters.every(([c, v]) => r[c] === v))
      .filter((r) => this.inFilters.every(([c, vs]) => vs.includes(r[c])));
    if (this.orderBy.length === 0) return out;
    return [...out].sort((a, b) => {
      for (const [col, asc] of this.orderBy) {
        const av = a[col];
        const bv = b[col];
        // NULL LAST ở chiều tăng — mặc định của Postgres.
        if (av === null || av === undefined) {
          if (bv !== null && bv !== undefined) return 1;
          continue;
        }
        if (bv === null || bv === undefined) return -1;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return asc ? cmp : -cmp;
      }
      return 0;
    });
  }
  async maybeSingle() {
    if (this.op === "insert") {
      const row = tpl(`tpl-new-${this.db.nextId++}`, {
        ...(this.payload as Partial<TplRow>),
      });
      this.db.templates.push(row);
      return { data: { id: row.id }, error: null };
    }
    const m = this.rows();
    return { data: m[0] ?? null, error: null };
  }
  async single() {
    return this.maybeSingle();
  }
  then(
    resolve: (v: {
      data: unknown;
      count: number | null;
      error: null;
    }) => unknown,
  ) {
    if (this.op === "delete") {
      const doomed = new Set(this.rows().map((r) => r.id));
      this.db.templates = this.db.templates.filter((t) => !doomed.has(t.id));
      this.db.entries = this.db.entries.filter(
        (e) => !doomed.has(e.template_id),
      );
      return Promise.resolve(
        resolve({ data: null, count: null, error: null }),
      );
    }
    if (this.op === "insert") {
      for (const r of this.payload as EntryRow[]) this.db.entries.push(r);
      return Promise.resolve(
        resolve({ data: null, count: null, error: null }),
      );
    }
    const m = this.rows();
    return Promise.resolve(
      resolve({
        data: this.head ? null : m,
        count: m.length,
        error: null,
      }),
    );
  }
}

