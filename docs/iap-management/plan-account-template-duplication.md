# Nhân bản template GLOBAL → template theo account — ĐÁNH GIÁ + PLAN

**Tag:** `[ACCOUNT-default-template]` · **Trạng thái:** ⏸ **PLAN CHỜ DUYỆT.**
Chưa code, chưa migration thật, chưa commit.

> ⚠ **File này KHÔNG PHẢI migration.** SQL trong đây là **bản nháp để review**.
> Không có file nào được tạo trong `supabase/migrations/`.

**Quyết định Manager đã chốt (không bàn lại):** nhân bản GLOBAL → mọi account ·
bỏ scope GLOBAL · chuỗi `app → account → Apple` · giữ enum `'DEFAULT_TEMPLATE'`
(nghĩa mới) · dropdown chọn account trong tab Default (khuôn Key Pool).

**Chốt vòng 2 (sau khi đọc plan này):**

| | Chốt | Lý do Manager nêu |
|---|---|---|
| §P2.2 | **CÁCH B** — Manager dán danh sách account từ output V0 vào migration | cách A không chống được U4: bảng rỗng ⇒ chạy **thành công** mà nhân bản 0 dòng. B bắt danh sách đi qua mắt Manager, và giữ quy ước không đọc chéo schema |
| §P2.2 phụ | **VẪN phải có guard** `RAISE EXCEPTION` nếu số dòng INSERT ≠ N × entry_gốc | "0 dòng" và "thành công" không được trông giống nhau |
| §3.4 | **GHI MỚI kèm dấu vết nguồn gốc**, không copy `uploaded_by`/`uploaded_at` gốc | giữ `minhgv@` / 2026-05-18 cho cả N account sẽ khiến sau này nhìn tab một account tưởng đã có người cấu hình chủ động |
| §3.5 bước 0 | **DUYỆT** — tạo bảng backup trước mọi thứ | đường lui đọc được duy nhất |

⚠ Cách B **không** làm guard thừa: guard bắt được cả ca "dán thiếu account"
lẫn ca "dán đủ nhưng entry copy hụt", tức nó canh đúng thứ mà mắt người không
canh được.

---

## ⚠ DANH SÁCH "KHÔNG ĐỌC ĐƯỢC TỪ CODE" — cần Manager xác nhận

Tôi không có quyền truy cập DB. Mọi mục dưới đây **không** được suy đoán:

| # | Thông tin | Vì sao không đọc được | Cần gì |
|---|---|---|---|
| **U1** | **N = số account sẽ nhân bản** | `asc_accounts` là dữ liệu runtime, không nằm trong repo | Manager chạy **V0** (§P4) |
| **U2** | **6 chuỗi Manager dán là `id` hay `name`?** | `asc_accounts` có **cả hai** cột TEXT. Runbook nêu ví dụ `id` dạng `vng`, `vngsing`, `vnggames-co-ltd` ([RUNBOOK-seed-pool-keys.md §1](docs/iap-management/RUNBOOK-seed-pool-keys.md)) — **khác kiểu chữ** với danh sách Manager dán (`vng-corp`, `vnggames-vn`…). Không suy ra được | **V0** trả cả `id` lẫn `name` → Manager đối chiếu |
| **U3** | **1140 entry / 12 territory có đúng không** | số liệu Manager cung cấp | **V1** đối chiếu lại (phép nhân 95 tier × 12 territory = 1140 tự nhất quán, nhưng đó là *suy ra*, không phải *đọc*) |
| **U4** | **`public.asc_accounts` có thật sự chứa 6 dòng không** | ⚠ **rủi ro thật** — xem U4 chi tiết bên dưới | **V0** |
| **U5** | **Tên thật của 2 CHECK constraint** | migration khai báo **không đặt tên** → Postgres tự sinh | **V0c** đọc `pg_constraint` |
| **U6** | `price_tier_territories` còn khớp GLOBAL hiện tại không | dữ liệu runtime | **V8** (dùng cho câu hỏi đường lui) |

### ⚠ U4 — rủi ro nghiêm trọng nhất: danh sách account có thể KHÔNG nằm trong DB

[`lib/asc-account-repository.ts:78-104`](lib/asc-account-repository.ts#L78-L104)

```ts
export async function findAllAccounts(): Promise<AscAccount[]> {
  if (!shouldUseSupabase()) return getEnvAccounts();      // ← nhánh env
  …
  if (!data || data.length === 0) {
    return getEnvAccounts();                              // ← nhánh env thứ 2
  }
```

`getEnvAccounts()` đọc biến môi trường `ASC_ACCOUNTS` (JSON array,
[`lib/asc-accounts.ts:41-80`](lib/asc-accounts.ts#L41-L80)). Nghĩa là **6 account
Manager thấy trong AccountSwitcher có thể đến từ env var chứ không phải từ bảng**
— và khi đó **SQL không đọc được chúng**, migration sẽ nhân bản ra **0 template**
mà không báo lỗi gì.

**Bằng chứng ngược lại (ủng hộ nhánh DB):**
[RUNBOOK-seed-pool-keys.md §1](docs/iap-management/RUNBOOK-seed-pool-keys.md) bảo
Manager chạy `SELECT id, name, issuer_id, key_id, is_active FROM public.asc_accounts`
như quy trình chuẩn, và nói *"5 account giữ nguyên"* — tức tại thời điểm đó bảng
**có** dữ liệu. Nhưng đó là tài liệu tháng 8/2026, không phải trạng thái hôm nay.

⇒ **V0 là điều kiện tiên quyết.** Nếu `V0` trả về 0 dòng thì **toàn bộ phương án
"migration tự SELECT account" sụp đổ** và phải chuyển sang cách B (§P2.2).

---

## P1 — SCHEMA & TÍNH KHẢ THI

### 1.1 `iap_mgmt.price_tier_templates` — trích đủ

Nguồn: [`20260519000000_iap_mgmt_pricing_templates.sql:23-50`](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L23-L50).
**Không có migration nào sau đó ALTER bảng này** (grep `price_tier_templates`
trên toàn `supabase/migrations/` → chỉ file 20260519 + 1 dòng comment ở
20260812). Định nghĩa dưới đây là **hiện trạng**.

| Cột | Kiểu | NULL? | Default | Ràng buộc |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PRIMARY KEY |
| `scope_type` | TEXT | NOT NULL | — | `CHECK (scope_type IN ('GLOBAL','APP'))` (inline, **không tên**) |
| `scope_app_id` | UUID | **nullable** | — | `REFERENCES iap_mgmt.apps(id) ON DELETE CASCADE` |
| `uploaded_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | — |
| `uploaded_by` | TEXT | **NOT NULL** | **không có default** | — |
| `source_filename` | TEXT | nullable | — | — |

CHECK thứ 2 (table-level, **không tên**), dòng 31-35:

```sql
CHECK ( (scope_type = 'GLOBAL' AND scope_app_id IS NULL)
     OR (scope_type = 'APP'    AND scope_app_id IS NOT NULL) )
```

**Không có trigger** trên bảng này (grep `TRIGGER` trong file 20260519 → 0 hit;
khác `iap_mgmt.apps`/`iaps` vốn có `tg_..._updated_at`). ⇒ INSERT không bị
trigger nào can thiệp.

**Từng cột khi INSERT bản sao — giá trị lấy từ đâu:**

| Cột | Bắt buộc? | Nguồn giá trị |
|---|---|---|
| `id` | không | **sinh mới** — để DB tự `gen_random_uuid()`. ⚠ Không copy `id` gốc (PK trùng) |
| `scope_type` | **có** | **hằng `'ACCOUNT'`** (giá trị mới, cần mở CHECK trước — §1.5) |
| `scope_app_id` | không | **`NULL`** — CHECK coherence mới bắt buộc NULL với scope ACCOUNT |
| `scope_account_id` | **có** | ⚠ **CỘT CHƯA TỒN TẠI** — §1.3. Giá trị = `asc_accounts.id`, **đọc từ bảng**, không hardcode |
| `uploaded_at` | không | **quyết định của Manager** — §3.4 |
| `uploaded_by` | **CÓ — NOT NULL, không default** | **quyết định của Manager** — §3.4 |
| `source_filename` | không | **quyết định của Manager** — §3.4 (đây là cột duy nhất chứa được dấu vết nguồn gốc) |

### 1.2 `iap_mgmt.price_tier_template_entries` — trích đủ

Nguồn: [dòng 53-66](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L53-L66).

| Cột | Kiểu | NULL? | Ràng buộc |
|---|---|---|---|
| `template_id` | UUID | NOT NULL | `REFERENCES iap_mgmt.price_tier_templates(id)` **`ON DELETE CASCADE`** |
| `tier_id` | TEXT | NOT NULL | `REFERENCES iap_mgmt.price_tiers(tier_id)` **`ON DELETE CASCADE`** |
| `territory_code` | TEXT | NOT NULL | — |
| `currency_code` | TEXT | NOT NULL | — |
| `customer_price` | NUMERIC(18,4) | NOT NULL | — |
| `proceeds` | NUMERIC(18,4) | **nullable** | — |
| **PK** | | | `(template_id, tier_id, territory_code)` |

Index phụ: `(template_id, tier_id)`.

**Hai FK, hai hệ quả cần biết:**

1. `template_id → templates(id) ON DELETE CASCADE` ⇒ **xoá header GLOBAL là xoá
   luôn 1140 entry**. Đây là lý do §3.5 (đường lui) tồn tại.
2. `tier_id → price_tiers(tier_id) ON DELETE CASCADE` ⇒ bản sao **dùng chung**
   các dòng `price_tiers` sẵn có, không cần nhân bản tier metadata. Không có
   rủi ro FK khi copy.

**Nháp `INSERT … SELECT` (⚠ CHƯA CHẠY, chỉ để review):**

```sql
-- Bước 4 của plan §P5. Giả định: cột scope_account_id đã tồn tại (bước 1),
-- CHECK đã mở (bước 2-3). CHẠY TRONG CÙNG 1 TRANSACTION với bước 5.

-- 4a. Header: 1 dòng ACCOUNT cho mỗi account đọc được từ bảng.
INSERT INTO iap_mgmt.price_tier_templates
  (scope_type, scope_app_id, scope_account_id, uploaded_at, uploaded_by, source_filename)
SELECT
  'ACCOUNT',
  NULL,
  a.id,                       -- ⚠ ĐỌC TỪ BẢNG, không hardcode
  g.uploaded_at,              -- ⟵ §3.4 lựa chọn (giữ mốc gốc) — CHỜ MANAGER
  g.uploaded_by,              -- ⟵ §3.4
  g.source_filename           -- ⟵ §3.4
FROM public.asc_accounts a                            -- ⚠ cross-schema — §P2.2
CROSS JOIN (
  SELECT id, uploaded_at, uploaded_by, source_filename
  FROM iap_mgmt.price_tier_templates
  WHERE scope_type = 'GLOBAL'
) g
WHERE a.is_active = true                              -- ⟵ §P2.3
  AND NOT EXISTS (                                    -- ⟵ §3.3 idempotency
    SELECT 1 FROM iap_mgmt.price_tier_templates t
    WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = a.id
  );

-- 4b. Entries: copy 1140 dòng cho MỖI header vừa tạo.
INSERT INTO iap_mgmt.price_tier_template_entries
  (template_id, tier_id, territory_code, currency_code, customer_price, proceeds)
SELECT
  new_t.id,
  e.tier_id, e.territory_code, e.currency_code, e.customer_price, e.proceeds
FROM iap_mgmt.price_tier_template_entries e
JOIN iap_mgmt.price_tier_templates g
  ON g.id = e.template_id AND g.scope_type = 'GLOBAL'
CROSS JOIN iap_mgmt.price_tier_templates new_t
WHERE new_t.scope_type = 'ACCOUNT'
  AND NOT EXISTS (                                    -- ⟵ §3.3
    SELECT 1 FROM iap_mgmt.price_tier_template_entries e2
    WHERE e2.template_id = new_t.id
  );
```

⚠ **Điểm cần review kỹ ở 4b:** `CROSS JOIN` nhân **mọi** entry GLOBAL với **mọi**
header ACCOUNT. Nếu Manager chạy lại lần 2 khi đã có account tự upload template
riêng, mệnh đề `NOT EXISTS` là thứ **duy nhất** ngăn việc chèn thêm entry vào
template của họ. Tôi coi đây là chỗ nguy hiểm nhất của cả script và đề nghị
Manager review riêng dòng này.

### 1.3 ⚠ Cột chứa account: **CHƯA CÓ. Bắt buộc `ADD COLUMN`.**

Đọc lại toàn bộ định nghĩa bảng (§1.1): cột giữ scope chỉ có **`scope_app_id`
UUID**. **Không có `scope_account_id`.** Grep xác nhận không migration nào thêm
nó về sau.

**Kiểu: `TEXT` soft-ref, KHÔNG FK.** Không phải tôi tự quyết — đây là kết luận
đọc từ 2 tiền lệ và 1 điều khoản:

| Nguồn | Trích |
|---|---|
| [`20260520000000_iap_mgmt_p1j_hotfix.sql:12-17`](supabase/migrations/20260520000000_iap_mgmt_p1j_hotfix.sql#L12-L17) | *"`iap_mgmt.apps.asc_account_id` … **Soft reference (TEXT, no FK)** since `asc_accounts` lives in public schema and CLAUDE.md invariant #9 forbids cross-schema FKs"* → cột thật: `ALTER TABLE iap_mgmt.apps ADD COLUMN … asc_account_id TEXT` (dòng 27) |
| [`20260825010000_iap_mgmt_asc_account_keys.sql:15-22`](supabase/migrations/20260825010000_iap_mgmt_asc_account_keys.sql#L15-L22) | *"⚠ **SOFT REF, NOT A FOREIGN KEY.** `public.asc_accounts` lives in another schema and CLAUDE.md invariant #9 forbids cross-schema queries … Cost, stated plainly: deleting an account in CPP does NOT cascade here."* → cột thật: `account_id TEXT NOT NULL` (dòng 26) |
| `CLAUDE.md` invariant #9 | schema isolation |

⇒ **`scope_account_id TEXT`**, nullable ở tầng cột (vì dòng APP không có
account), tính bắt buộc do **CHECK coherence** đảm nhiệm.

⚠ **Cái giá phải nói thẳng (copy từ chính comment của asc_account_keys):** xoá
account trong Settings **không** cascade sang template. Template mồ côi sẽ nằm
lại. Hiện `deleteAccount` là **soft delete** (`is_active = false`,
[`asc-account-repository.ts:194`](lib/asc-account-repository.ts#L194)) nên dòng
`asc_accounts` không biến mất — nhưng template của account đã tắt sẽ vẫn còn và
không surface nào hiển thị nó. Cần Manager biết trước, không phải để chặn.

### 1.4 Partial unique index GLOBAL

Định nghĩa hiện tại ([dòng 41-43](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L41-L43)):

```sql
CREATE UNIQUE INDEX idx_iap_mgmt_price_tier_templates_global_unique
  ON iap_mgmt.price_tier_templates(scope_type)
  WHERE scope_type = 'GLOBAL';
```

**Đề xuất: DROP nó, tạo index mới theo account.** Lý do: sau khi CHECK cấm
`'GLOBAL'` (§1.5), index này canh một giá trị **không thể tồn tại** → chỉ còn là
rác gây hiểu nhầm cho người đọc sau.

```sql
DROP INDEX IF EXISTS iap_mgmt.idx_iap_mgmt_price_tier_templates_global_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_mgmt_price_tier_templates_account_unique
  ON iap_mgmt.price_tier_templates(scope_account_id)
  WHERE scope_type = 'ACCOUNT';
```

**Về gợi ý `UNIQUE (scope_type, scope_account_id)`:** chạy được nhưng **không
ép đúng điều ta muốn**. Với dòng APP, cặp giá trị là `('APP', NULL)`, và trong
Postgres **NULL khác NULL** trong unique index → 3 template APP vẫn tồn tại song
song (may mắn đúng), nhưng tính đúng đắn đó đến từ ngữ nghĩa NULL chứ không từ ý
định. **Partial index rõ ràng hơn và khớp đúng style 2 index đang có.**

⚠ Index `idx_..._app_unique` (dòng 45-47) **giữ nguyên, không đụng** — 3 template
APP của Manager phụ thuộc vào nó.

### 1.5 CHECK trên `scope_type` — nguyên văn + thứ tự an toàn

**Nguyên văn hiện tại** (dòng 25, inline trong `CREATE TABLE`):

```sql
scope_type TEXT NOT NULL CHECK (scope_type IN ('GLOBAL', 'APP')),
```

⚠ **CẢ HAI CHECK ĐỀU KHÔNG ĐƯỢC ĐẶT TÊN** trong migration → tên do Postgres tự
sinh (thường `price_tier_templates_scope_type_check` và
`price_tier_templates_check`, nhưng **đó là suy đoán, không phải đọc**). Repo đã
từng vấp đúng chỗ này: [`20260515010000:27-31`](supabase/migrations/20260515010000_iap_mgmt_tier_id_text.sql#L27-L31)
phải `DROP CONSTRAINT IF EXISTS` **hai tên khác nhau**, kèm comment
*"IF EXISTS for resilience against Postgres constraint-naming variations."*

⇒ **Bắt buộc chạy V0c (§P4) đọc tên thật từ `pg_constraint` TRƯỚC khi viết
migration.** Đây là mục **U5**.

**Thứ tự an toàn — không có thời điểm nào dữ liệu vi phạm CHECK:**

| Bước | Việc | Vì sao an toàn |
|---|---|---|
| 1 | `ADD COLUMN scope_account_id TEXT` | thêm cột nullable, dòng cũ = NULL, không CHECK nào đụng |
| 2 | **MỞ RỘNG** `scope_type` CHECK → `('GLOBAL','APP','ACCOUNT')` | **superset** — mọi dòng đang có vẫn thoả |
| 3 | Thay CHECK coherence → thêm nhánh `ACCOUNT` | vẫn superset của luật cũ |
| 4 | INSERT header + entries ACCOUNT | hợp lệ vì bước 2-3 đã cho phép |
| 5 | `DELETE … WHERE scope_type = 'GLOBAL'` (CASCADE dọn entry) | |
| 6 | **THU HẸP** `scope_type` CHECK → `('ACCOUNT','APP')` | ⚠ **chỉ an toàn SAU bước 5** |
| 7 | DROP index GLOBAL, CREATE index ACCOUNT | |

⚠ **Bước 6 vừa là thay đổi vừa là cái chốt kiểm tra.** Postgres validate CHECK
mới **trên toàn bộ dữ liệu đang có** khi `ADD CONSTRAINT`. Nếu bước 5 sót dù chỉ
1 dòng GLOBAL, bước 6 **thất bại và transaction rollback** — không thể có trạng
thái "đã thu hẹp CHECK nhưng còn dòng GLOBAL". Đây là guard miễn phí, đừng bỏ.

**Làm ngược lại (thu hẹp trước khi xoá) sẽ hỏng.** Không được đảo bước 5 và 6.

---

## P2 — NGUỒN DANH SÁCH ACCOUNT

### 2.1 Bảng `asc_accounts`

Nguồn: [`20260407000000_create_asc_accounts.sql:5-15`](supabase/migrations/20260407000000_create_asc_accounts.sql#L5-L15).

⚠ Migration viết `CREATE TABLE IF NOT EXISTS asc_accounts (…)` — **không ghi rõ
schema**, tức rơi vào schema mặc định của `search_path` (thực tế là `public`;
code gọi `supabase.from("asc_accounts")` không qua `.schema()`,
[`asc-account-repository.ts:85-86`](lib/asc-account-repository.ts#L85-L86), và
`createServerSupabaseClient()` mặc định `public`). Các tài liệu/comment trong repo
đều gọi nó là `public.asc_accounts`.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | **TEXT PRIMARY KEY** | comment migration: *"e.g. 'vng', 'vngsing'"* — **không phải UUID** |
| `name` | TEXT NOT NULL | *"Display name, e.g. 'VNG Corp'"* |
| `key_id`, `issuer_id` | TEXT NOT NULL | |
| `private_key_enc` | TEXT NOT NULL | AES-256-GCM |
| `is_active` | BOOLEAN NOT NULL DEFAULT true | *"Soft delete flag"* |
| `created_by`, `created_at`, `updated_at` | | |

RLS bật, **không policy** → chỉ `service_role` (dòng 18-19).

**Không chép bất kỳ giá trị nào** — bảng này chỉ đọc được lúc runtime.

### 2.2 ⚠ Migration đọc account bằng cách nào — **KHÔNG CÓ TIỀN LỆ**

Tôi đã grep toàn bộ `supabase/migrations/`:

```
grep -rn 'public\.' supabase/migrations/*.sql
```

→ **6 file có chuỗi `public.`, và TẤT CẢ đều nằm trong COMMENT.** Không một câu
`SELECT` / `INSERT … SELECT` / `JOIN` nào trong repo đọc chéo schema. Cụ thể:
`20260101100000:3`, `20260515000000:3`, `20260515020000:23`, `20260715000000:3,5`,
`20260520010000:4`, `20260825010000:8,15,25,34,73` — kiểm từng dòng, đều là chú
thích giải thích **tại sao KHÔNG** đọc chéo.

Và comment mạnh nhất, [`asc_account_keys:15-17`](supabase/migrations/20260825010000_iap_mgmt_asc_account_keys.sql#L15-L17),
nói invariant #9 cấm **"cross-schema queries"** — chứ không chỉ cấm FK.

⇒ **Nói thẳng: nếu làm cách A thì đây là migration ĐẦU TIÊN trong repo đọc chéo
schema.** Về mặt kỹ thuật Postgres cho phép (cùng database, migration chạy bằng
role owner); về mặt quy ước của repo thì đây là một ngoại lệ có chủ đích và phải
được Manager biết, không phải lặng lẽ làm.

**Hai cách — CHỜ MANAGER CHỌN:**

| | Cách A — migration `SELECT` chéo schema | Cách B — Manager truyền danh sách vào |
|---|---|---|
| Hình dạng | `FROM public.asc_accounts WHERE is_active` như nháp §1.2 | migration mở đầu bằng `VALUES ('…'),('…')` do Manager dán, **lấy từ output của V0** |
| Ưu | Không thể gõ sai/thiếu account. Tự đúng kể cả khi Manager nhớ nhầm | Không phá quy ước schema isolation. Manager thấy chính xác cái gì sẽ được tạo trước khi chạy |
| Nhược | Ngoại lệ đầu tiên của invariant #9 trong migration. ⚠ **Và nếu account đến từ env var (U4) thì tạo ra 0 template mà không lỗi** | Chép tay = có thể sai/thiếu. Nhưng V0 chạy ngay trước đó nên rủi ro thấp |
| Chống được U4? | ❌ **không** — bảng rỗng thì INSERT lặng lẽ 0 dòng | ✅ **có** — Manager dán từ danh sách thật họ nhìn thấy |
| Chống được U2 (id vs name)? | ✅ dùng đúng `a.id` | ⚠ phụ thuộc Manager dán đúng cột `id` |

⚠ **Nếu chọn cách A, phải thêm một chốt an toàn** để U4 không im lặng: sau bước
4a, kiểm số dòng vừa tạo và **chủ động `RAISE EXCEPTION` nếu = 0**. Không có
chốt này thì "0 account" và "chạy thành công" trông giống hệt nhau — đúng hình
dạng bẫy silent-fail mà KB §9 P2 mô tả.

✅ **ĐÃ CHỐT: CÁCH B.** Migration mở đầu bằng một `VALUES` list Manager dán
từ output **V0** (cột `id`, không phải `name` — xem U2), kèm guard
`RAISE EXCEPTION` bắt buộc.

Cả hai cách **đều KHÔNG hardcode 6 tên Manager dán vào migration.** Ở cách B,
giá trị đến từ output V0 mà Manager tự chạy, và bước verify V2 đối chiếu lại với
bảng — nên nếu dán thiếu, verify sẽ báo.

### 2.3 Lọc `is_active` — đọc code trước, rồi mới đề xuất

`is_active` chỉ được dùng ở **3 chỗ** trong toàn bộ code liên quan account
(grep `is_active`, loại test và loại 3 module hub-tracking dùng cột trùng tên ở
bảng khác):

| File:dòng | Dùng thế nào |
|---|---|
| [`asc-account-repository.ts:88`](lib/asc-account-repository.ts#L88) | `findAllAccounts()` → `.eq("is_active", true)` |
| [`asc-account-repository.ts:157`](lib/asc-account-repository.ts#L157) | `createAccount` ghi `is_active: true` |
| [`asc-account-repository.ts:194`](lib/asc-account-repository.ts#L194) | `deleteAccount` = **soft delete**, `is_active: false` |

Và mọi surface đều đi qua `findAllAccounts()`:
`findAllAccountsPublic()` ([dòng 123-126](lib/asc-account-repository.ts#L123-L126))
→ `GET /api/asc/accounts` → **AccountSwitcher**; `getActiveAccount()` →
`findAccountById` / `findDefaultAccount` → mọi route Apple.

⇒ **Account `is_active = false` KHÔNG hiện ở bất kỳ đâu**: không trong
AccountSwitcher, không trong dropdown Key Pool, không thể là active account.

**Đề xuất: chỉ nhân bản `is_active = true`.** Ca "account thấy được nhưng không
có template" **không thể xảy ra**, vì account tắt thì không thấy được. Nhân bản
cả account tắt chỉ tạo template không bao giờ được đọc.

⚠ Một hệ quả cần Manager biết: nếu sau này **bật lại** một account đã tắt
(hiện **không có UI/hàm nào làm việc này** — grep `is_active: true` chỉ thấy ở
`createAccount`), nó sẽ xuất hiện lại **không có template** → rơi vào ca 2.4.

### 2.4 Account tạo SAU migration

**Xác nhận: có, và theo chốt của Manager thì đây là hành vi ĐÚNG.** Migration là
ảnh chụp một lần; `createAccount`
([`asc-account-repository.ts:~150`](lib/asc-account-repository.ts#L150)) không
đụng gì tới `iap_mgmt` — không có hook, không có trigger (và **không thể** có
trigger sạch sẽ, vì cross-schema).

⚠ **Nhưng chuỗi mới là `app → account → Apple`, không còn tầng global đỡ.** Nên
account mới sẽ rơi thẳng về Apple auto-equalize. Trong code hiện tại, cú rơi đó
**chỉ có một dòng `console.warn`**
([`pricing-orchestration.ts:424-430`](lib/iap-management/apple/pricing-orchestration.ts#L424-L430))
— người dùng không thấy gì.

**UI phải nói gì (đề xuất, mockup đã vẽ ở State 2):**

1. **Tab Default** — account chưa có template: empty state ghi rõ tên account +
   *"IAP của account này sẽ dùng giá auto-equalize của Apple cho mọi territory
   cho tới khi có template."*
2. **Dropdown account** — badge `chưa có` ngay cạnh tên (State 1), để thấy được
   **mà không cần bấm vào**.
3. **`PricingSourceSelector`** — radio "Default Template" phải **disabled** kèm
   helper nêu tên account, đúng cơ chế `defaultTemplateAvailable` đã có
   ([`PricingSourceSelector.tsx:81-92`](components/iap-management/iap-form/PricingSourceSelector.tsx#L81-L92)).
   Cơ chế này đã chạy sẵn — chỉ cần cho nó biết template được tra theo account.

---

## P3 — RỦI RO CỦA CHÍNH VIỆC NHÂN BẢN

### 3.1 Kích thước

**Không đọc được từ code** (U1, U3). Theo số Manager cung cấp:

| | Giá trị | Nguồn |
|---|---|---|
| entry của GLOBAL | 1140 | **Manager cung cấp** — xác nhận lại bằng **V1** |
| territory | 12 | Manager cung cấp |
| tier (suy ra) | 1140 ÷ 12 = **95** | *phép chia, không phải đọc* — **V1** trả số thật |
| N account | **KHÔNG ĐỌC ĐƯỢC** | **V0** |
| Tổng dòng entries mới | **1140 × N** | nếu N = 6 → **6.840** |

**Quy mô: nhỏ.** So sánh cùng bảng: comment init dự trù *"~175 × 96 ≈ 16,800
rows"* cho một template đầy đủ
([`20260515000000:40`](supabase/migrations/20260515000000_iap_mgmt_init.sql#L40)),
và `templates.ts` có sẵn đường phân trang cho template 16.800 entry. 6.840 dòng
INSERT một lần là chuyện vặt với Postgres — **kích thước không phải rủi ro ở
đây**; các mục 3.2-3.5 mới là.

### 3.2 Transaction

**Đọc được:** **không migration nào trong repo dùng `BEGIN;`/`COMMIT;`**
(grep → 0 hit). 6 file dùng `DO $$ … $$` block, trong đó có chính
[`20260519000000:79`](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L79)
— tức tiền lệ gần nhất (data migration của p1.a) chạy trong một `DO` block,
bản thân nó là một câu lệnh nên có tính nguyên tử.

**Không đọc được:** Supabase SQL Editor có tự bọc script nhiều câu lệnh vào một
transaction hay không. Tôi **không xác minh được từ repo** và không đoán.

⇒ **Đề xuất: bọc `BEGIN; … COMMIT;` tường minh**, không phụ thuộc hành vi của
editor. Đây sẽ là migration đầu tiên trong repo làm vậy — nêu rõ để Manager biết
là cố ý. (DDL trong Postgres có tính transaction, nên `ALTER TABLE` +
`CREATE INDEX` **không** `CONCURRENTLY` nằm chung transaction được. Ta không
dùng `CONCURRENTLY` — bảng vài nghìn dòng, khoá vài mili-giây.)

**Trạng thái nửa vời nếu đứt mà KHÔNG có transaction** — xấu nhất là đứt **giữa
4a và 4b**: N header ACCOUNT tồn tại với **0 entry**. Khi đó
`getAccountTemplate()` trả về một template **không null nhưng rỗng** →
`tierEntries.length === 0` → orchestrator ghi "template overrides resolved
matched=0" rồi POST **chỉ giá USA**, im lặng. Đúng nghĩa "có template mà không
có entry là ca tệ nhất" — Manager thấy UI báo "đã có template", giá lại ra như
APPLE.

**Chống bằng 3 lớp:** (1) `BEGIN/COMMIT`; (2) verify **V4** so số entry từng
account với bản gốc; (3) nếu Manager muốn chắc hơn nữa — thêm `RAISE EXCEPTION`
khi số entry chèn ≠ `1140 × N` **đọc từ chính DB**, không phải hằng số gõ tay.

### 3.3 Idempotency — chạy 2 lần

| Câu lệnh | Chạy lần 2 |
|---|---|
| `ADD COLUMN … IF NOT EXISTS` | ✅ no-op (tiền lệ: `20260520000000:24,28`) |
| `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` | ✅ nếu luôn DROP trước ADD (tiền lệ `20260515010000:22-31`) |
| INSERT 4a/4b | ✅ **chỉ nhờ `NOT EXISTS`**; nếu bỏ mệnh đề đó → unique index chặn 4a (lỗi to, transaction rollback), nhưng 4b **không có gì chặn** ngoài PK ⇒ **`NOT EXISTS` ở 4b là bắt buộc, không phải tuỳ chọn** |
| `DELETE … WHERE scope_type='GLOBAL'` | ✅ xoá 0 dòng |
| Thu hẹp CHECK bước 6 | ✅ DROP IF EXISTS + ADD |
| DROP/CREATE INDEX `IF EXISTS`/`IF NOT EXISTS` | ✅ |

⚠ **Nhưng phải nói rõ một tính chất không hiển nhiên:** sau lần chạy đầu, **dòng
GLOBAL đã bị xoá**, nên lần chạy thứ 2 có nguồn copy rỗng → 4a/4b chèn 0 dòng.
Script **an toàn khi chạy lại** (không hỏng gì) nhưng **không thể làm lại việc**.
Nếu lần 1 sai, lần 2 không sửa được — chỉ có §3.5 cứu.

⚠ **Tính chất quan trọng thứ 2:** `NOT EXISTS` cũng bảo vệ template mà Manager
đã tự upload đè sau đó. Chạy lại script **không** ghi đè lên chúng.

### 3.4 `uploaded_by` / `uploaded_at` — ✅ ĐÃ CHỐT: ghi mới + dấu vết

**Chốt:** không copy giá trị gốc. Bản sao mang giá trị hệ thống, và dấu vết
"cái này do nhân bản mà có" phải đọc được.

#### Bằng chứng mới — `uploaded_by` KHÔNG chỉ là chữ hiển thị

Grep lại toàn bộ chỗ đọc `uploaded_by` cho thấy nó là **điều kiện rẽ nhánh
hành vi**, không phải metadata trang trí:

| File:dòng | Dùng làm gì |
|---|---|
| [`AppPricingTemplateSection.tsx:97-103`](components/iap-management/pricing-tiers/AppPricingTemplateSection.tsx#L97-L103) | `if (template.uploaded_by !== currentUserEmail)` → **hiện modal xác nhận** "đang ghi đè template của người khác" |
| [`PerAppTemplateTab.tsx:154-157`](app/(dashboard)/iap-management/settings/pricing-tiers/PerAppTemplateTab.tsx#L154-L157) | y hệt, ở tab Per-App |
| [`DefaultTemplateTab.tsx:195`](app/(dashboard)/iap-management/settings/pricing-tiers/DefaultTemplateTab.tsx#L195) | hiển thị dưới thẻ "Uploaded" |
| [`AppPricingTemplateSection.tsx:164`](components/iap-management/pricing-tiers/AppPricingTemplateSection.tsx#L164) · 2 trang matrix | hiển thị |

⇒ **Chốt của Manager tình cờ chọn đúng hành vi an toàn hơn.** Nếu copy
`minhgv@vng.com.vn` sang bản sao thì đúng người đó sẽ **không** thấy modal
cảnh báo khi upload đè — lặng lẽ thay một template mà họ chưa từng cấu hình
cho account đó. Với giá trị hệ thống, **mọi người đều** thấy modal, và câu chữ
"template này do hệ thống nhân bản" là đúng sự thật.

⚠ Kèm theo: tab Default **hiện chưa có** modal này (chỉ tab Per-App + App
detail có). Khi tab Default thành per-account thì phải port modal sang — đã vẽ
ở mockup State 4.

#### `uploaded_by` ghi gì — 3 lựa chọn, **CHỜ MANAGER CHỐT lúc duyệt SQL**

| | Giá trị | Ưu | Nhược |
|---|---|---|---|
| **(1)** ⭐ | `'SYSTEM_MIGRATION'` | **có tiền lệ chính xác** trong repo: data migration p1.a ghi đúng chuỗi này ([`20260519000000:88`](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L88)). Một câu `WHERE uploaded_by='SYSTEM_MIGRATION'` tìm ra cả hai đợt migrate | không phân biệt được đợt này với đợt p1.a nếu chỉ nhìn cột này |
| **(2)** | `'SYSTEM_MIGRATION_ACCOUNT_SPLIT'` | tự phân biệt được đợt, không cần join actions_log | lệch tiền lệ; chuỗi dài hiện trong UI |
| **(3)** | `'system@migration'` hay email giả | hiển thị đồng dạng với các dòng khác | ❌ **trông như người thật** — đúng cái Manager muốn tránh |

**Đề xuất: (1)**, vì `source_filename` / `origin_note` đã gánh phần phân biệt
đợt, và tiền lệ có sẵn đáng giá hơn sự tiện lợi của (2).

`uploaded_at` = `NOW()` ở cả 3 lựa chọn (thời điểm nhân bản, không phải thời
điểm Manager upload bản gốc).

#### Dấu vết nguồn gốc — có cột hợp hơn `source_filename` không? **CÓ.**

Manager dặn "đừng nhét vào `source_filename` nếu có chỗ đúng hơn". Đọc lại:

- Bảng **không có** cột `notes` / `metadata` / JSONB nào (§1.1 — đúng 6 cột).
- `source_filename` **được render như một tên file**, font mono:
  [`AppPricingTemplateSection.tsx:165-166`](components/iap-management/pricing-tiers/AppPricingTemplateSection.tsx#L165-L166)
  → `<span className="font-mono"> · {template.source_filename}</span>`.
  Nhét `"…xlsx (migrated from global 2026-05-18)"` vào đó sẽ hiện ra một
  "tên file" không phải tên file, bằng font mono, ngay cạnh entry count.

| | Cách | Đánh giá |
|---|---|---|
| **(a)** ⭐ | **Thêm cột `origin_note TEXT`** trong cùng migration (đã `ADD COLUMN scope_account_id` rồi) | ⚠ **chi phí code = 0**: mọi query đều `select()` **liệt kê cột tường minh** ([`templates.ts:102`](lib/iap-management/queries/templates.ts#L102), `:265`, `:616`, [`template-matrix.ts:259`](lib/iap-management/queries/template-matrix.ts#L259)) → cột mới **không lọt vào** type `TemplateHeader`, không file nào phải sửa. Muốn hiện lên UI thì thêm sau, khi cần |
| (b) | Hậu tố vào `source_filename` | rẻ nhất, nhưng làm bẩn một cột có ngữ nghĩa "tên file" và **đang được render** |
| (c) | Chỉ ghi `actions_log`, không đụng cột nào | dấu vết đúng chỗ nhưng **không đọc được từ chính dòng template** — phải join mới biết |

**Đề xuất: (a) + (c).** Cột `origin_note` mang câu đọc được ngay trên dòng
(vd `'duplicated from GLOBAL template <id> on <ngày>'`), `actions_log` mang
dòng audit đầy đủ. `source_filename` **copy nguyên xi từ bản gốc** — đúng sự
thật, vì nội dung 1140 ô đúng là đến từ file đó.

⚠ Nếu Manager thấy thêm cột là quá tay cho một dấu vết, cách (b) vẫn chấp
nhận được — chỉ cần biết là nó sẽ hiện ra trên UI dạng mono.

#### Dòng `actions_log` (phần (c))

`actions_log` đọc được: `actor` NOT NULL, `payload` JSONB NOT NULL DEFAULT
`'{}'`, `iap_id`/`batch_id` **nullable**
([`20260515000000:180-197`](supabase/migrations/20260515000000_iap_mgmt_init.sql#L180-L197)).
`'PRICE_TIER_IMPORT'` **đã có trong CHECK** ([`action-types.ts:66`](lib/iap-management/action-types.ts#L66))
⇒ **không cần `action_type` mới**, không chạm bẫy P2.

```sql
INSERT INTO iap_mgmt.actions_log (actor, action_type, payload)
SELECT 'SYSTEM_MIGRATION', 'PRICE_TIER_IMPORT',
       jsonb_build_object(
         'op',                        'duplicate_global_to_account',
         'scope',                     'ACCOUNT',
         'scope_account_id',          t.scope_account_id,
         'template_id',               t.id,
         'source_global_template_id', <id đọc từ V0d>,
         'source_uploaded_by',        <uploaded_by gốc, từ V0d>,
         'source_uploaded_at',        <uploaded_at gốc, từ V0d>,
         'entry_count',               (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
                                        WHERE e.template_id = t.id))
FROM iap_mgmt.price_tier_templates t
WHERE t.scope_type = 'ACCOUNT';
```

⚠ `source_uploaded_by` / `source_uploaded_at` ở đây là **nơi duy nhất** thông
tin tác giả gốc còn sống sót sau khi bước 5 xoá dòng GLOBAL. Đừng bỏ.

### 3.5 Đường lui

**Đọc được, và câu trả lời thẳng: sau bước 5, bản GLOBAL gốc KHÔNG còn ở đâu cả.**

| Ứng viên "backup" | Verdict | Bằng chứng |
|---|---|---|
| Chính bảng templates | ❌ `ON DELETE CASCADE` trên `template_id` ([dòng 54](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L54)) xoá luôn 1140 entry cùng header | |
| `actions_log` payload | ❌ **KHÔNG phải backup** — payload chỉ chứa `scope`, `scope_app_id`, `template_id`, `entry_count`, `tier_count`, `territory_count`, `warnings`. **Không có một dòng entry nào** | [`templates.ts:570-582`](lib/iap-management/queries/templates.ts#L570-L582) |
| `iap_mgmt.price_tier_territories` | ⚠ **có thể**, nhưng **không xác minh được từ code** | bảng vẫn tồn tại (`20260515000000:41-48`), `templates.ts:11` gọi nó *"retained as defensive backup (Q-B)"*. **NHƯNG**: nó chỉ được ghi bởi `replacePriceTiers` ([`price-tiers.ts:371`](lib/iap-management/queries/price-tiers.ts#L371)) qua route `POST /api/iap-management/pricing-tiers` — và **không UI nào gọi route đó** (grep `api/iap-management/pricing-tiers` trong `.tsx` → 0 hit). Nội dung của nó là ảnh chụp **lần import cũ**, không nhất thiết khớp 1140 entry hiện tại |
| File `.xlsx` gốc Manager giữ | ✅ thực tế nhất | ngoài phạm vi code |

⇒ **Đề xuất: bước 0 của script là tạo bảng backup.** Additive, thuận
forward-only, và là **đường lui duy nhất đọc được**:

```sql
-- BƯỚC 0 — chạy TRƯỚC mọi thứ. Không xoá gì, chỉ chụp ảnh.
CREATE TABLE IF NOT EXISTS iap_mgmt.price_tier_templates_backup_global AS
  SELECT * FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';

CREATE TABLE IF NOT EXISTS iap_mgmt.price_tier_template_entries_backup_global AS
  SELECT e.* FROM iap_mgmt.price_tier_template_entries e
  JOIN iap_mgmt.price_tier_templates t
    ON t.id = e.template_id AND t.scope_type = 'GLOBAL';
```

⚠ `CREATE TABLE … AS` **không** copy constraint/index/default — đó là **đúng ý**
ở đây: ta cần một bản chụp trơ, không phải bảng sống. Bảng backup **không** có
FK nên không bị CASCADE khi bước 5 xoá GLOBAL.

⚠ Và phải nói thẳng: **bảng backup này sẽ nằm lại trong schema.** Cần một mục
dọn dẹp trong TODO, kèm điều kiện dọn (Manager xác nhận N template account chạy
đúng qua ít nhất một lần submit thật).

**V8** (§P4) so `price_tier_territories` với template GLOBAL, để Manager biết
mình đang có mấy đường lui chứ không phải một.

---

## P4 — VERIFY SQL (viết, **KHÔNG chạy**)

> Chạy trong Supabase SQL Editor. **V0 chạy TRƯỚC** (điều kiện tiên quyết).
> V1-V8 chạy **SAU** khi apply. Mỗi query tự nêu điều kiện PASS.
> **Không hardcode N** — mọi phép so đều đọc N từ bảng.

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- V0 — TIỀN ĐIỀU KIỆN (chạy TRƯỚC migration). Đây là mục U1/U2/U4.
-- PASS: trả về đúng số account Manager nhìn thấy trong AccountSwitcher.
--       Nếu trả 0 dòng → DỪNG, account đang đến từ env var, KHÔNG apply.
-- Cột `id` là giá trị migration sẽ ghi vào scope_account_id; `name` chỉ để
-- Manager đối chiếu với danh sách mình có.
SELECT id, name, is_active, created_at
FROM public.asc_accounts
ORDER BY is_active DESC, id;

-- V0b — N chính thức (chỉ account active).
SELECT COUNT(*) AS n_account_se_nhan_ban
FROM public.asc_accounts WHERE is_active = true;

-- V0c — TÊN THẬT của 2 CHECK constraint (mục U5). Bắt buộc đọc trước khi
-- viết DROP CONSTRAINT. PASS: thấy đúng 2 dòng CHECK.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'iap_mgmt.price_tier_templates'::regclass
  AND contype = 'c'
ORDER BY conname;

-- V0d — ảnh chụp trạng thái gốc, để V4/V6 so lại. LƯU KẾT QUẢ LẠI.
SELECT t.id AS global_template_id, t.uploaded_at, t.uploaded_by, t.source_filename,
       COUNT(e.tier_id)                 AS entry_count,
       COUNT(DISTINCT e.tier_id)        AS tier_count,
       COUNT(DISTINCT e.territory_code) AS territory_count
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
GROUP BY t.id, t.uploaded_at, t.uploaded_by, t.source_filename;
-- ═══════════════════════════════════════════════════════════════════════════
-- V1..V8 — SAU KHI APPLY
-- ═══════════════════════════════════════════════════════════════════════════

-- V1 — đúng N template ACCOUNT, N đọc từ bảng account (KHÔNG hardcode).
-- PASS: n_template_account = n_account_active, va_khop = true.
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates WHERE scope_type='ACCOUNT')
    AS n_template_account,
  (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active = true)
    AS n_account_active,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates WHERE scope_type='ACCOUNT')
  = (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active = true)
    AS va_khop;

-- V2 — mọi account active đều có template, và mọi template đều trỏ tới một
-- account có thật (soft-ref nên không có FK bảo vệ).
-- PASS: cả hai phần đều trả 0 dòng.
SELECT a.id AS account_thieu_template
FROM public.asc_accounts a
WHERE a.is_active = true
  AND NOT EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates t
                  WHERE t.scope_type='ACCOUNT' AND t.scope_account_id = a.id)
UNION ALL
SELECT t.scope_account_id AS template_tro_toi_account_khong_ton_tai
FROM iap_mgmt.price_tier_templates t
WHERE t.scope_type='ACCOUNT'
  AND NOT EXISTS (SELECT 1 FROM public.asc_accounts a WHERE a.id = t.scope_account_id);

-- V3 — 0 template GLOBAL. PASS: 0.
SELECT COUNT(*) AS con_lai_global
FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';

-- V4 — mỗi template ACCOUNT có SỐ ENTRY BẰNG NHAU, và bằng bản gốc.
-- PASS: mọi dòng có entry_count giống nhau và = entry_count của V0d.
--       Không dòng nào entry_count = 0  ← ca "có header, không entry" (§3.2).
SELECT t.scope_account_id, t.id AS template_id, COUNT(e.tier_id) AS entry_count,
       COUNT(DISTINCT e.tier_id) AS tier_count,
       COUNT(DISTINCT e.territory_code) AS territory_count
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'ACCOUNT'
GROUP BY t.scope_account_id, t.id
ORDER BY t.scope_account_id;

-- V4b — cùng ý V4, dạng 1 dòng PASS/FAIL, so với BẢNG BACKUP (không gõ số).
-- PASS: khop = true.
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
     JOIN iap_mgmt.price_tier_templates t ON t.id=e.template_id
    WHERE t.scope_type='ACCOUNT')                                  AS tong_entry_moi,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global) AS entry_goc,
  (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active=true)  AS n,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
     JOIN iap_mgmt.price_tier_templates t ON t.id=e.template_id
    WHERE t.scope_type='ACCOUNT')
  = (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global)
    * (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active=true)  AS khop;

-- V4c — nội dung có thật sự giống bản gốc không (không chỉ đếm).
-- PASS: 0 dòng. So từng ô của MỖI template ACCOUNT với bảng backup; bắt cả
-- thiếu, thừa lẫn sai giá. Mỗi vế bọc ngoặc riêng — set operator trong
-- Postgres kết hợp trái sang phải, không bọc là ra kết quả khác hẳn.
WITH goc AS (
  SELECT tier_id, territory_code, currency_code, customer_price, proceeds
  FROM iap_mgmt.price_tier_template_entries_backup_global
),
moi AS (
  SELECT t.scope_account_id,
         e.tier_id, e.territory_code, e.currency_code, e.customer_price, e.proceeds
  FROM iap_mgmt.price_tier_templates t
  JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
  WHERE t.scope_type = 'ACCOUNT'
),
acct AS (SELECT DISTINCT scope_account_id FROM moi)
SELECT * FROM (
  (  -- có ở bản mới nhưng không có ở bản gốc
    SELECT m.scope_account_id, m.tier_id, m.territory_code,
           m.customer_price, 'thua_o_ban_moi' AS van_de
    FROM moi m
    EXCEPT ALL
    SELECT a.scope_account_id, g.tier_id, g.territory_code,
           g.customer_price, 'thua_o_ban_moi'
    FROM acct a CROSS JOIN goc g
  )
  UNION ALL
  (  -- có ở bản gốc nhưng thiếu ở bản mới
    SELECT a.scope_account_id, g.tier_id, g.territory_code,
           g.customer_price, 'thieu_o_ban_moi' AS van_de
    FROM acct a CROSS JOIN goc g
    EXCEPT ALL
    SELECT m.scope_account_id, m.tier_id, m.territory_code,
           m.customer_price, 'thieu_o_ban_moi'
    FROM moi m
  )
) diff
ORDER BY scope_account_id, tier_id, territory_code;

-- V5 — CHECK mới không còn 'GLOBAL', và có 'ACCOUNT'.
-- PASS: definition chứa 'ACCOUNT' và 'APP', KHÔNG chứa 'GLOBAL'.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'iap_mgmt.price_tier_templates'::regclass AND contype='c'
ORDER BY conname;

-- V5b — thử vi phạm (chạy trong transaction rồi ROLLBACK, KHÔNG commit).
-- PASS: cả 2 lệnh đều BỊ TỪ CHỐI.
-- BEGIN;
--   INSERT INTO iap_mgmt.price_tier_templates (scope_type, uploaded_by)
--   VALUES ('GLOBAL', 'verify-test');          -- kỳ vọng: lỗi CHECK scope_type
--   INSERT INTO iap_mgmt.price_tier_templates (scope_type, uploaded_by)
--   VALUES ('ACCOUNT', 'verify-test');         -- kỳ vọng: lỗi CHECK coherence
-- ROLLBACK;

-- V6 — index: cũ đã xử, mới đã có, index APP còn nguyên.
-- PASS: KHÔNG thấy ..._global_unique · THẤY ..._account_unique · THẤY ..._app_unique.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='iap_mgmt' AND tablename='price_tier_templates'
ORDER BY indexname;

-- V7 — 3 template APP KHÔNG bị đụng (so với V0d-app dưới đây).
-- PASS: đúng 3 dòng, entry_count + uploaded_at + uploaded_by y như trước.
SELECT t.id, t.scope_app_id, a.apple_app_id, a.name AS app_name,
       t.uploaded_at, t.uploaded_by, COUNT(e.tier_id) AS entry_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY t.id, t.scope_app_id, a.apple_app_id, a.name, t.uploaded_at, t.uploaded_by
ORDER BY a.name;
-- ⚠ Chạy CÙNG query này TRƯỚC khi apply và lưu lại để so.

-- V8 — có mấy đường lui (§3.5). Chỉ để biết, không PASS/FAIL.
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global)
    AS entry_trong_bang_backup,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_territories)
    AS entry_trong_bang_legacy,
  (SELECT COUNT(DISTINCT territory_code) FROM iap_mgmt.price_tier_territories)
    AS territory_trong_bang_legacy;
-- Nếu entry_trong_bang_legacy KHÁC entry_trong_bang_backup thì bảng legacy là
-- ảnh chụp của một lần import CŨ, KHÔNG dùng làm đường lui được.
```

---

## P5 — TÁCH LÀM HAI MIGRATION (X1-X3) — kế hoạch apply cuối cùng

### X1 — cửa sổ apply→deploy TRÁNH ĐƯỢC HẲN

Bản gộp trước đó làm 3 việc trong một transaction. **Chỉ (c) mới làm code cũ
gãy**, nên (c) tách sang M-2.

| | Migration | Nội dung | Apply lúc nào |
|---|---|---|---|
| **M-1** | `20260828010000_..._m1_additive.sql` | backup · ADD COLUMN · **nới** CHECK · index account_unique · nhân bản 6 template · audit | **TRƯỚC** deploy — thuần cộng thêm |
| **M-2** | `20260828020000_..._m2_drop_global.sql` | **xoá** GLOBAL · **thu hẹp** CHECK · drop index global_unique | **SAU** deploy + verify |

**Bằng chứng M-1 an toàn với code cũ** — grep 11 site chạm
`price_tier_templates`, **không site nào thiếu bộ lọc**:

| # | Site | Bộ lọc | 6 dòng ACCOUNT lọt vào? |
|---|---|---|---|
| 1-2 | [`templates.ts:101-103`](lib/iap-management/queries/templates.ts#L101-L103) + [`applyScopeFilter:90-93`](lib/iap-management/queries/templates.ts#L90-L93) | `.eq(scope_type,'GLOBAL').is(scope_app_id,null)` / `.eq(scope_type,'APP').eq(scope_app_id,…)` | ❌ |
| 3 | [`templates.ts:264-267`](lib/iap-management/queries/templates.ts#L264-L267) `listAppsWithTemplates` | `.eq(scope_type,'APP')` | ❌ |
| 4 | `templates.ts:520` xoá bản cũ | `.eq(id,…)` | ❌ |
| 5 | `templates.ts:530-536` insert | đường GHI — xem dưới | — |
| 6-7 | `templates.ts:615` · `:628` `deleteTemplate` | `.eq(id,…)` | ❌ |
| 8 | [`template-matrix.ts:193-199`](lib/iap-management/queries/template-matrix.ts#L193-L199) | `.eq(scope_type,…)` + `.is/.eq(scope_app_id)` | ❌ |
| 9 | `template-matrix.ts:258-260` | `.eq(id,…)` | ❌ |
| 10 | [`per-app-matrix/[appId]/page.tsx:34-37`](app/(dashboard)/iap-management/settings/pricing-tiers/per-app-matrix/[appId]/page.tsx#L34-L37) | `.eq(scope_type,'GLOBAL')` count | ❌ |
| 11 | [`pricing-templates/[templateId]/route.ts:41-44`](app/api/iap-management/pricing-templates/[templateId]/route.ts#L41-L44) | `.eq(id,…)` | ❌ |

Hai hệ quả:

1. **`.maybeSingle()` trên nhánh GLOBAL vẫn thấy đúng 1 dòng** — M-1 không
   đụng dòng GLOBAL. Không có `PGRST116`.
2. **Đường GHI của code cũ vẫn qua được CHECK coherence mới.**
   `replaceTemplate` insert `{scope_type, scope_app_id, uploaded_by,
   source_filename}` — không set `scope_account_id` → NULL → thoả cả nhánh
   `(GLOBAL, app NULL, account NULL)` lẫn `(APP, app NOT NULL, account NULL)`.
   Manager vẫn Replace/Remove được như thường.

⇒ **M-1 an toàn ⇒ tách hai migration là đường KHÔNG CÓ CỬA SỔ.** Khuyến nghị
mạnh, và đã viết thành hai file.

⚠ **Một hạn chế vận hành thay cho cửa sổ kỹ thuật:** đừng Replace/Remove
Default Template ở tab Settings trong khoảng giữa M-1 và M-2. 6 bản sao được
chụp tại thời điểm M-1. M-2 có **GUARD 3** bắt đúng ca này (so `id` + số entry
của GLOBAL với bảng backup) và sẽ **từ chối chạy** — không im lặng.

### X2 — guard/verify chia theo ranh giới mới

| | M-1 | M-2 |
|---|---|---|
| **Guard trong migration** | GLOBAL **còn nguyên** sau khi chạy · N template ACCOUNT · mọi id trong danh sách có template · mỗi bản sao có đúng 1140 entry · tổng = N×1140 · số template APP trước = sau | M-1 đã chạy (≠0 ACCOUNT) · không bản sao nào rỗng · **GLOBAL còn khớp ảnh chụp M-1** (id + entry count) · sau khi xoá: 0 GLOBAL, ≠0 ACCOUNT, backup ≠ rỗng |
| **Verify** | M1-V1 (N) · **M1-V2 CỔNG** (đối chiếu id ↔ asc_accounts) · M1-V3 (**GLOBAL = 1**) · M1-V4 (tổng) · M1-V5 (nội dung từng ô) · M1-V6 (CHECK **vẫn còn GLOBAL**, index global_unique **vẫn còn**, account_unique mới) · M1-V7 (APP) · **M1-V8 smoke test trên code cũ** | M2-V1 (GLOBAL = 0) · M2-V2 (CHECK thu hẹp + 3 test vi phạm) · M2-V3 (index đã thay) · M2-V4 (APP + backup + audit) |

**Idempotency xét lại theo ranh giới mới:**

- **M-1 giờ TỰ CHẠY LẠI ĐƯỢC ĐẦY ĐỦ, không chỉ "an toàn".** Nó không phá
  nguồn copy của chính nó (GLOBAL vẫn còn) — khác hẳn bản gộp, nơi chạy lần 2
  gặp nguồn rỗng và không làm lại được việc. Đây là lợi ích thứ hai của việc
  tách, ngoài chuyện bỏ cửa sổ.
- ⚠ **Bẫy mới do tách sinh ra, đã chặn:** chạy lại M-1 **sau khi** M-2 đã chạy
  sẽ **nới lại CHECK** và âm thầm cho `'GLOBAL'` quay về hợp lệ. M-1 bọc bước
  nới CHECK trong điều kiện *"chỉ nới khi còn dòng GLOBAL"* — M-1 không thể
  lùi bước tiến của M-2.
- **M-2 chạy lại**: không còn GLOBAL + có template ACCOUNT → `RAISE NOTICE`
  bỏ qua phần dữ liệu; các bước CHECK/index idempotent nên cho ra cùng trạng
  thái.

### X3 — đường lui: hai tầng, GIỮ CẢ HAI

**Xác nhận đúng:** sau M-1 mà phát hiện sai thì **xoá 6 dòng ACCOUNT là xong**,
GLOBAL chưa mất. Entry đi theo nhờ `ON DELETE CASCADE` trên `template_id`
([`20260519000000:54`](supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql#L54)):

```sql
DELETE FROM iap_mgmt.price_tier_templates
 WHERE scope_type = 'ACCOUNT' AND origin_note IS NOT NULL;
```

⚠ Mệnh đề `origin_note IS NOT NULL` không thừa: nó chừa lại template mà Manager
đã tự upload sau đó. (Cột `origin_note` được thêm cho việc ghi dấu vết §3.4, và
hoá ra nó gánh luôn vai trò phân biệt này.)

**Nhưng KHÔNG bỏ bảng backup.** Ba lý do, mỗi lý do là một ca mà đường lui
tầng 1 không phủ:

1. **M-2 mới là bước phá huỷ.** Đường lui "xoá 6 dòng ACCOUNT" chỉ tồn tại
   *trước* M-2. Sau M-2, dòng GLOBAL đã bị `DELETE` + CASCADE — không còn gì
   để lùi về nếu không có bản chụp.
2. **Bảng backup là mốc so nội dung.** M1-V5 so từng ô của bản sao với bản
   chụp. Không có nó thì "1140 dòng" chỉ chứng minh được số lượng, không chứng
   minh được **giá đúng**.
3. **Bảng backup là cách M-2 phát hiện Default bị thay giữa hai lần apply**
   (GUARD 3). Guard đó không tồn tại được nếu không có ảnh chụp tại thời điểm
   M-1.

⇒ **Đường lui chính theo chặng:** trước M-2 → xoá 6 dòng ACCOUNT. Sau M-2 →
dữ liệu vẫn nằm trong N bản sao; bảng backup là thứ dựng lại được dòng GLOBAL
(nhớ CHECK đã cấm `'GLOBAL'`, phải nới lại trước).

### Thứ tự apply cuối cùng

| Bước | Việc | Ai làm | Gate |
|---|---|---|---|
| 1 | apply **M-1** — copy TOÀN BỘ `supabase/migrations/20260828010000_iap_mgmt_account_templates_m1_additive.sql` (497 dòng, giữ nguyên `BEGIN;` dòng 122 và `COMMIT;` dòng 497), dán vào Supabase SQL Editor, Run một lần. **Không sửa dòng nào.** | Manager (SQL Editor) | — |
| 2 | chạy **M1-V0** (bảng kiểm gộp, một dòng) rồi **M1-V1…V7** trong `docs/iap-management/queries/verify-account-template-duplication.sql` | Manager | **M1-V2 là cổng** |
| 3 | **M1-V8 smoke test** trên code cũ | Manager | Default tab phải hiện y như trước |
| 4 | viết + push code mới (~20 file) | dev | pre-push checklist CLAUDE.md |
| 5 | kiểm code mới chạy thật (1 IAP, xem giá) | Manager | |
| 6 | apply **M-2** | Manager | ⚠ không sớm hơn bước 4 |
| 7 | chạy **M2-V1…V4** | Manager | |
| 8 | (sau) dọn 2 bảng backup | Manager | chỉ khi đã submit thật thành công |

### ⚠ HẠN CHẾ VẬN HÀNH — từ M-1 tới lúc DEPLOY, không phải tới M-2

**Đừng Replace/Remove Default Template ở Settings → Pricing Templates trong
khoảng từ lúc apply M-1 tới lúc deploy code mới (bước 4 của bảng trên).**

⚠ **Cửa sổ này ngắn hơn bản viết đầu tiên** — sửa sau phát hiện C4. Sau khi
C-C lên production, tab Default đọc/ghi dòng scope `ACCOUNT` và nút Remove xoá
dòng `ACCOUNT`; dòng `GLOBAL` **không thể chạm tới từ UI** nữa. Từ lúc deploy
trở đi Manager upload đè thoải mái, GUARD 3 của M-2 vẫn đúng. Chỉ **code cũ**
mới sửa được dòng GLOBAL.

N bản sao được chụp tại thời điểm M-1. Thay bản gốc sau đó làm chúng mang nội
dung **cũ**, trong khi tab Settings hiển thị nội dung **mới** — hai thứ khác
nhau và không surface nào nói ra.

**Nếu lỡ làm:** GUARD 3 trong M-2 **từ chối chạy** (so `id` + số entry của
GLOBAL với ảnh chụp M-1) — không im lặng. Cách gỡ: xoá các bản sao
(`DELETE … WHERE scope_type='ACCOUNT' AND origin_note IS NOT NULL`), xoá 2 bảng
backup, chạy lại M-1, verify, rồi mới tới M-2.

Đây là hạn chế **tạm**, chỉ tồn tại trong cửa sổ M-1→M-2. Ghi ở 3 chỗ Manager
sẽ đọc: đầu file M-2, mục này, và báo cáo gửi Manager. **Không** đưa vào User
Guide — nó không phải hành vi lâu dài của tool.

### Không dry-run — phương án C (Manager chốt)

**Quyết định: apply thẳng M-1, không dựng bước dry-run.** Lý do ghi lại:

1. **M-1 đã tự dry-run chính nó.** Mọi guard bên trong là `RAISE EXCEPTION`,
   và một exception trong transaction làm **cả transaction rollback** — sai thì
   không ghi gì. `BEGIN;`/`COMMIT;` tường minh ở dòng 122 và 497 là thứ bảo
   đảm điều đó, không phụ thuộc Supabase SQL Editor có tự bọc transaction hay
   không.
2. **Rollback của M-1 rẻ bất thường vì M-1 KHÔNG XOÁ gì** — 1 `DELETE` +
   2 `DROP TABLE` là về trạng thái cũ (§X3).
3. **Phương án nhân bản file bị loại**: chép 497 dòng cho một file dùng đúng
   một lần; `sha` + test chống được trôi nhưng đó là **cơ chế bảo trì vĩnh
   viễn cho lợi ích một lần**. Và chính arc này đã dạy: *hai bản phải khớp
   nhau là hai bản sẽ không khớp*.

**Phần đáng giữ của file dry-run đã được tách ra**, không xoá theo: bảng kiểm
gộp-một-dòng nay là **M1-V0** trong
`docs/iap-management/queries/verify-account-template-duplication.sql`. Nó tồn
tại vì Supabase SQL Editor chỉ hiện kết quả của câu lệnh **cuối** trong script
nhiều lệnh — M1-V0 cho toàn cảnh trong một lần Run, các query chi tiết chạy
từng cái một khi cần soi.

**Khi guard nổ, Manager thấy gì:** một lỗi đỏ dạng `ERROR: GUARD: <mô tả>`.
Đó là **thất bại an toàn**, không phải hỏng — transaction đã rollback,
database y như trước khi bấm Run. Sửa nguyên nhân rồi chạy lại cả file.

⚠ **Số dòng trong hướng dẫn tự vô hiệu hoá khi file bị sửa.** Đã gặp ngay khi
viết mục này: thêm block hướng dẫn vào đầu M-1 làm đổi hết số dòng của chính
nó. Nên hướng dẫn trong M-1 nêu **cả mô tả lẫn số**: *"câu lệnh chạy được đầu
tiên của file"* / *"dòng cuối cùng của file"* — và dặn tin vào mô tả nếu hai
thứ lệch nhau.

## ⏸ DỪNG — chờ Manager

1. Chạy **V0 / V0b / V0c / V0d** → trả kết quả (giải U1, U2, U4, U5, U3).
2. Chốt **§P2.2**: cách A (migration SELECT chéo schema) hay cách B (Manager dán
   danh sách từ V0)?
3. Chốt **§3.4**: `uploaded_by`/`uploaded_at` — cách 1, 2 hay 3?
4. Xác nhận **§2.3** (chỉ nhân bản `is_active = true`) và **§2.4** (account mới
   tự upload).
5. Duyệt bảng backup **§3.5** + nháp SQL **§1.2**.

Sau đó mới viết migration thật.
