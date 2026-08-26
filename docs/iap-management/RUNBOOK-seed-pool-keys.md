# Runbook — Seed key vào Apple ASC key pool

> **Dành cho Manager.** Làm theo từng bước, không cần đọc code.
> Mọi lệnh và tên biến trong tài liệu này được **trích từ source thật**
> (`scripts/seed-asc-pool-key.mjs`, `supabase/migrations/…`), không viết
> theo trí nhớ.
>
> Liên quan: `TODO.md` → `[RATELIMIT-keypool-design]` (K4) ·
> `[POOL-key-management-UI]` · KB `§15` (kiến trúc) · KB `§4.9` (rate limit).

---

## 0. Điều KHÔNG làm

| ❌ Đừng | Vì sao |
|---|---|
| **Đừng tìm nút "Add key" trong tool** | **Không có UI quản lý key.** v1 cố ý chỉ có script. |
| **Đừng vào Settings thêm gì** | Settings quản lý **account** (`asc_accounts`) — không phải pool key. |
| **Đừng tạo account mới** | 5 account **giữ nguyên**. Key pool là **con** của account sẵn có, nằm ở bảng riêng `iap_mgmt.asc_account_keys`. |
| **Đừng dán nội dung `.p8` vào form hay SQL Editor** | Sẽ lưu private key của Apple ở **dạng phẳng**. |

**Lý do (quyết định v1 `[K1.3]`):** key pool phải nằm ngoài `asc_accounts` vì
dropdown chọn account của bảng đó **dùng chung với CPP Manager** — thêm key vào
đấy sẽ làm pool key hiện trong tool khác. Và `private_key_enc` phải là ciphertext
**AES-256-GCM** sinh bởi đúng routine mà app dùng để giải mã; SQL Editor không tạo
được giá trị đó. Script `seed-asc-pool-key.mjs` mã hoá bằng **cùng một routine**,
nên key nó ghi là key app đọc được — và nếu `ENCRYPTION_KEY` sai thì **lỗi ngay lúc
seed**, không phải lúc 2h sáng giữa một bulk import.

> UI quản lý key là backlog: `[POOL-key-management-UI]` trong `TODO.md`.

---

## 1. Bảng tra account — `id` nào là tài khoản nào

Chạy trong **Supabase SQL Editor**:

```sql
SELECT id, name, issuer_id, key_id, is_active
FROM public.asc_accounts
ORDER BY id;
```

**Không phải UUID.** `asc_accounts.id` là `TEXT` do người đặt, dạng đọc được
(ví dụ `vng`, `vngsing`, `vnggames-co-ltd`) — chính là giá trị điền vào
`--account` ở bước 3.

⚠ **Cột `issuer_id` là cột quan trọng nhất ở bảng này cho việc seed.** Mỗi team
Apple có **một** Issuer ID. Hai dòng account có **cùng `issuer_id`** nghĩa là
chúng trỏ **cùng một team Apple** → xem cảnh báo ở mục 2.

---

## 2. Tạo key trên App Store Connect (làm cho **từng** account)

1. Đăng nhập App Store Connect **bằng đúng team của account đó**.
2. **Users and Access → Integrations → App Store Connect API → `+`**
3. Role: **App Manager**. (Không cần Admin — pool chỉ gọi các endpoint
   IAP metadata + pricing, đều thuộc phạm vi app.)
4. Bấm **Generate**, rồi **Download API Key** để tải file `.p8`.

> ### 🚫 `.p8` CHỈ TẢI ĐƯỢC MỘT LẦN
> Apple không cho tải lại. Tải xong **cất ngay** vào nơi an toàn.
> Mất file = phải revoke key và tạo key mới.

### ⚠ Chỗ DUY NHẤT có thể gán nhầm là bàn phím

Code đã được chứng minh **không thể** lấy key account này dùng cho account khác
(query lọc `account_id`, cache tách theo account, fallback luôn về key gốc của
chính account đó — pin bởi `lib/iap-management/key-pool/isolation.test.ts`).

Rủi ro còn lại **chỉ là gõ sai**: cầm key của team X mà chạy `--account <id của
team Y>`. Hai lưới đỡ:

- **Apple từ chối, không im lặng.** JWT sẽ ký bằng `issuerId` của account Y +
  `kid` của key team X → Apple trả **401**. Sai lệch là *fail-closed*, không phải
  âm thầm đọc nhầm dữ liệu team khác.
- **Bước 4 bắt được** — làm bước 4 trước khi nhân ra 4 account còn lại.

⚠ Cơ sở dữ liệu **không** đỡ được: `account_id` là `TEXT` soft-reference,
**không có foreign key** (quy tắc cấm FK xuyên schema), nên gõ sai id sẽ được
insert bình thường.

### ⚠ Không seed cùng một `key_id` cho 2 account trỏ CÙNG team

Ràng buộc trong schema là `UNIQUE (account_id, key_id)` — một **cặp**. Nghĩa là
cùng `key_id` ở **hai account khác nhau** là **hợp lệ về schema**. Nếu hai account
đó thật sự cùng một team Apple (cùng `issuer_id` ở bảng mục 1), bạn sẽ **chia đôi
budget của đúng một key** trong khi bảng trông như đã tăng headroom.

**Cách kiểm:** so cột `issuer_id` ở bảng mục 1. Trùng `issuer_id` → hai account
dùng chung team → mỗi account phải có key **riêng**.

---

## 3. Chạy script seed

### 3.1 ⚠ Script đọc `.env.local` — KHÔNG đọc biến môi trường

Đây là điểm dễ sai nhất. Script **mở file `.env.local` ở thư mục gốc repo và tự
parse**; nó **không** đọc `process.env`. Vì vậy:

```bash
export ENCRYPTION_KEY=...      # ❌ KHÔNG có tác dụng với script này
```

Phải có **file** `.env.local` tại gốc repo, chứa 3 biến (tên chính xác như script
yêu cầu):

| Biến | Ghi chú |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | script chấp nhận `SUPABASE_URL` làm phương án thay thế |
| `SUPABASE_SERVICE_ROLE_KEY` | service role — bỏ qua RLS |
| `ENCRYPTION_KEY` | **phải đúng 64 ký tự hex**; script tự kiểm và báo lỗi nếu sai |

Thiếu biến nào script in `Missing <TÊN> in .env.local` rồi thoát — không ghi gì.

### 3.2 Lấy giá trị ở đâu, chạy ở đâu

Chạy **trên máy local**, với `.env.local` trỏ **database PRODUCTION**. Lấy 3 giá
trị từ **Railway → service `web` → Variables**.

> **Repo chưa có quy ước sẵn cho việc này.** Cách ít rủi ro nhất:
>
> 1. Nếu đang có `.env.local` trỏ môi trường khác → **đổi tên tạm**
>    (`mv .env.local .env.local.bak`), đừng sửa đè.
> 2. Tạo `.env.local` mới chỉ với 3 biến trên.
> 3. Seed xong **cả 5 account** → **xoá** file production và khôi phục file cũ.
>
> `.env.local` đã nằm trong `.gitignore`, nhưng nó vẫn là service-role key của
> production nằm trên máy — đừng để lâu hơn mức cần.

### 3.3 Kiểm "đúng DB production chưa" — làm TRƯỚC khi ghi

```bash
node scripts/seed-asc-pool-key.mjs --account <id> --list
```

In ra: `Pool keys for account "<id>": N`. Đối chiếu với SQL Editor **của
production**:

```sql
SELECT count(*) FROM iap_mgmt.asc_account_keys WHERE account_id = '<id>';
```

Hai số **phải khớp**. Lệch → `.env.local` đang trỏ nhầm database. **Dừng.**
(Lần đầu cả hai đều là `0` — đó là kết quả đúng và vẫn có giá trị: nó chứng minh
script kết nối được và đọc đúng bảng.)

### 3.4 Lệnh seed

```bash
node scripts/seed-asc-pool-key.mjs \
  --account vnggames-co-ltd \
  --key-id  2X9R4HXF34 \
  --p8      ~/Downloads/AuthKey_2X9R4HXF34.p8 \
  --note    "pool key 2"
```

| Cờ | Bắt buộc | Ý nghĩa |
|---|---|---|
| `--account` | ✅ | `asc_accounts.id` từ bảng mục 1 |
| `--key-id` | ✅ | Key ID Apple cấp (trùng phần `AuthKey_<KID>.p8`) |
| `--p8` | ✅ | Đường dẫn file `.p8`. Chấp nhận `~`. |
| `--note` | — | ghi chú tự do |
| `--by` | — | người tạo; mặc định `seed-script` |
| `--list` | — | chỉ xem pool hiện tại, không ghi |

Thành công in:
```
✓ Registered key 2X9R4HXF34 for account vnggames-co-ltd.
```

**File `.p8` chỉ được đọc, mã hoá rồi bỏ** — không ghi vào repo, không log ra.

Nếu key đã tồn tại cho account đó, insert **thất bại** do `UNIQUE (account_id,
key_id)` — đây là hành vi mong muốn: đăng ký một key hai lần sẽ chia đôi budget
thật của nó trong khi trông như tăng headroom.

---

## 4. TỰ KIỂM SAU SEED

> ### 🚦 Seed **1 account đầu tiên** → làm xong **cả 3 bước 4a/4b/4c** → mới nhân ra 4 account còn lại.
> Sai sót ở account đầu mà nhân ra 5 lần thì phải dọn 5 lần.

### 4a. SQL — đối chiếu bằng mắt

```sql
SELECT account_id, key_id, enabled, cooldown_until
FROM iap_mgmt.asc_account_keys
ORDER BY account_id, key_id;
```

Soi **từng dòng**: `key_id` này có đúng là key bạn vừa tạo trong team của
`account_id` đó không? Đây là bước bắt lỗi gõ nhầm `--account` — thứ mà cả
database lẫn test đều không bắt được.

Mong đợi: `enabled = true`, `cooldown_until = NULL` (chưa từng bị rate limit).

### 4b. Kiểm SỐNG — rẻ nhất là 1 request

1. Trong tool, chọn **đúng account vừa seed** (AccountSwitcher góc trên).
2. Vào **1 app bất kỳ** → mở danh sách IAP → bấm **Refresh from Apple**.
3. Mở **Railway → service `web` → Logs**, tìm:

```
[asc-client] GET /v2/inAppPurchases/… → 200 budget=…/3600 duration=…ms key=<KID>
```

| `key=` là gì | Nghĩa | Làm gì |
|---|---|---|
| **KID vừa seed** | Pool đang hoạt động, rotation chọn nó | ✅ Đúng |
| **Key gốc của chính account đó** (cột `key_id` bảng mục 1) | Pool chưa được đọc hoặc mọi key đang cooldown | ✅ Chấp nhận được — xem 4c |
| **KID của account KHÁC** | ❌ | **DỪNG NGAY, báo team dev** |

> ⚠ Không phải request nào cũng in dòng `[asc-client]`. KB §4.9: một số endpoint
> Apple **không gửi** header rate-limit — `GET /v2/inAppPurchases/{id}` và
> `…/manualPrices` là hai ví dụ. Nếu không thấy dòng nào, thử thao tác khác phát
> sinh request tới endpoint **có** header (ví dụ màn hình đọc territories).

### 4c. Quan sát rotation — không cần ép 429

Hành vi **đã ship**, để bạn biết thế nào là đúng:

- **Round-robin theo từng account.** Mỗi lần chọn key, con trỏ nhích 1. Account
  có 2 key → các request lần lượt `KEY1, KEY2, KEY1, KEY2, …`
- **Con trỏ riêng cho từng account.** Account A xoay không ảnh hưởng account B.
- **Chọn key ở mỗi REQUEST, không phải mỗi thao tác.** Một thao tác gồm nhiều
  request sẽ thấy `key=` đổi **giữa các dòng log**.
- **Retry cũng đổi key.** Một request bị 429 và thử lại sẽ dùng key khác — rotation
  nằm **bên trong** vòng retry.
- **Cooldown 1 giờ.** Key nào ăn 429 sống sót hết vòng retry sẽ bị loại khỏi vòng
  xoay **1 tiếng** và ghi `cooldown_until` (thấy được ở 4a).

**Cách xem nhanh:** làm 3–4 thao tác đọc liên tiếp rồi lọc log:

```
[asc-client]
```

| Thấy gì | Kết luận |
|---|---|
| `key=` **đổi qua lại** giữa các KID **của cùng account đó** | ✅ Rotation đúng |
| `key=` luôn là **một** KID dù account có ≥2 key | ⚠ Có thể mới seed 1 key, hoặc key kia đang cooldown — kiểm `cooldown_until` ở 4a |
| `key=` là KID của **account khác** | ❌ **DỪNG, báo ngay** |

---

## 5. D1 — đo per-key hay per-team (chạy ngay khi account đầu tiên có ≥2 key)

**Vì sao bắt buộc:** cả pool key chỉ có giá trị **nếu** Apple đếm budget
**theo từng key**. Nếu Apple đếm **theo team**, thêm key **không thêm gì cả**.
Manager đã xác nhận per-key từ kinh nghiệm vận hành một tool khác — bằng chứng
mạnh, nhưng **không phải phép đo trên hệ thống này**. KB §4.9 tồn tại chính vì
tài liệu Apple ghi 3.600 mà tool chạy nhầm 250 suốt nhiều tháng do **không ai đọc
số thật trên dây**.

> ### ⚠ Script D1 gốc KHÔNG còn tồn tại
> `TODO.md:547` trỏ tới `scratchpad/CENSUS-rate-limit-strategy.md` (`rl-lib.sh`).
> **File đó không có trên đĩa, không có trong git history, không bị gitignore** —
> nó là file tạm của phiên làm việc và đã mất. Phần dưới là **quy trình dựng lại
> từ KB §4.9**, không phải bản chép của script cũ.

### Nguyên tắc đo

`GET /v1/territories` là endpoint **có** trả `x-rate-limit` (KB §4.9 đã xác minh
bằng cách dump toàn bộ header). Ý tưởng:

1. Gọi `/v1/territories` **10 lần** bằng **key A**. Đọc `user-hour-rem` ở lần cuối.
2. Gọi `/v1/territories` **1 lần** bằng **key B** (cùng team). Đọc `user-hour-rem`.

| Kết quả | Kết luận |
|---|---|
| `rem` của B ≈ `lim − 1` (≈ **3599**) | ✅ **PER-KEY** — pool hợp lệ. Ghi kết quả vào KB §4.9. |
| `rem` của B ≈ `lim − 11` (đã trừ phần A tiêu) | ❌ **PER-TEAM** |

### ❌ Nếu ra PER-TEAM

**DỪNG TOÀN BỘ nhánh pool và báo ngay.** Điều kiện đã ghi ở `TODO.md`
(`[RATELIMIT-keypool-design]`):

- Pool ở lại trạng thái **dark vĩnh viễn**.
- **KHÔNG gỡ code.** Bảng rỗng thì đường fallback chính là đường trước khi có
  pool, nên để lại **không tốn gì**, còn gỡ đi là rủi ro thuần.
- Không seed tiếp cho 4 account còn lại.

> ⚠ Đây là quy tắc đã thống nhất: **phép đo thắng niềm tin, kể cả niềm tin của
> Manager.** Nếu số liệu ngược với dự đoán thì số liệu đúng.

---

## 6. Checklist — mỗi account một cột

Điền ✅ / ❌. **Account 1 phải xong hết cột mới bắt đầu account 2.**

| Bước | Acct 1 | Acct 2 | Acct 3 | Acct 4 | Acct 5 |
|---|---|---|---|---|---|
| `id` (từ mục 1) | | | | | |
| `issuer_id` — có trùng account nào khác không? | | | | | |
| 2 · Tạo key trên **đúng team**, role App Manager | | | | | |
| 2 · Đã tải `.p8` và cất an toàn | | | | | |
| 3.3 · `--list` khớp SQL Editor (đúng DB) | | | | | |
| 3.4 · Seed chạy, in `✓ Registered` | | | | | |
| 4a · SQL: key nằm **đúng** account | | | | | |
| 4b · Log `key=` đúng account | | | | | |
| 4c · Rotation quan sát đúng (nếu ≥2 key) | | | | | |
| 5 · D1 đã chạy (chỉ account đầu, khi có ≥2 key) | | | | | |
| Dọn `.env.local` production sau khi xong cả 5 | | | | | |

**Bất kỳ ô nào ❌ ở 4a / 4b → dừng, không seed tiếp, báo team dev.**
