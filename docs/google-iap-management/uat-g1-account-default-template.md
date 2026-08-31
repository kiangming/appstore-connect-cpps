# UAT — G1: Default Pricing Template tách theo account (Google)

**Bản deploy cần kiểm:** `a995616` (và `3233d78` ngay dưới nó).
Trước khi bắt đầu, xác nhận Railway đã deploy xong đúng commit này —
kiểm ở Railway → service `web` → Deployments, dòng trên cùng phải là
`a995616`. Nếu chưa, mọi mục dưới đây vô nghĩa.

**Màn cần mở:** `/google-iap-management/settings/pricing-templates`
→ tab **Default Template**.

**Nhãn trong bảng dưới là NGUYÊN VĂN chuỗi trong code** — nếu màn hiện
chữ khác, đó là phát hiện, không phải bạn nhớ nhầm.

---

## ⚠ ĐỌC TRƯỚC — cửa sổ M-1 → deploy nay ĐÃ ĐÓNG

Từ lúc `a995616` lên production, việc Replace Default Template **đã an
toàn trở lại**. Trước đó thì không (6 bản sao được chụp tại M-1, và code
cũ ghi entry không có `sort_order`).

Mục **U6** dưới đây CỐ Ý yêu cầu Replace thật một lần — nó vừa là phép
kiểm, vừa là điều kiện để sau này dọn hai bảng backup (F4).

---

## U1 — Chip chọn account

- [ ] Thấy **6 chip**, mỗi chip có: tên account + id (chữ mono) + một nhãn
      nhỏ `có template` hoặc `chưa có`.
- [ ] Đủ cả 6 account: **MTP · NCV · VNG Corp · VNG Sing · VNGG Sing ·
      VNGG VN**.
- [ ] ⚠ **VNGG Sing (0 app) vẫn phải có mặt.** Đây là mục dễ tưởng là
      lỗi nhất: account không có app nào vẫn phải hiện, vì ẩn nó đi thì
      "chưa cấu hình" và "account không tồn tại" nhìn giống hệt nhau.
- [ ] Sau M-1, cả 6 chip đều là `có template`.

## U2 — ⚠ Bấm chip KHÔNG được đổi active account (mục quan trọng nhất)

- [ ] Nhìn **account đang hiện trên TopNav**, ghi lại tên nó.
- [ ] Bấm sang một chip KHÁC.
- [ ] Thanh địa chỉ đổi thành `…/pricing-templates?account=<id>`.
- [ ] **Account trên TopNav KHÔNG đổi** — vẫn đúng tên vừa ghi.
- [ ] Mở một màn khác của module (ví dụ danh sách app) → vẫn đang ở
      account cũ, không bị kéo theo.

> Vì sao mục này đứng riêng: chip là nút để **XEM**. Nếu nó đổi luôn
> ngữ cảnh của cả module thì danh sách app, bulk import và form IAP đều
> lặng lẽ nhảy sang account khác sau một cú bấm chỉ định xem.

## U3 — Badge trên tab

- [ ] Tab **Default Template** có badge đọc là **`6 / 6 account`**.
- [ ] (Ghi chú: tử số = account đã có template; mẫu số = account đang
      tồn tại. Nếu sau này thêm account thứ 7 mà chưa upload cho nó,
      badge phải thành `6 / 7 account` — đó là chủ ý.)

## U4 — Pill nguồn gốc

- [ ] Ở **mỗi** account trong 6 account, thẻ Default Template hiện pill:
      **`Do migration nhân bản · chưa ai cấu hình riêng cho account này`**
- [ ] Rê chuột lên pill → tooltip hiện câu ghi nguồn (`Bản sao tự động
      (G1/M-1) từ Default Template dùng chung trước đây — GLOBAL …`).

## U5 — Bảng toàn cảnh

- [ ] Cuối trang có bảng tiêu đề **`Toàn cảnh 6 account`**.
- [ ] Bảng có **6 dòng**, 4 cột: `Account` · `Trạng thái` · `Số ô` ·
      `Nguồn gốc`.
- [ ] Cột `Số ô` = **846** ở cả 6 dòng.
- [ ] Cột `Nguồn gốc` = **`bản sao migration`** ở cả 6 dòng.

## U6 — Replace thật một lần (biến thể XANH)

Chọn **một** account để thử — đề nghị dùng **VNGG Sing** vì nó 0 app nên
không ảnh hưởng IAP nào đang chạy.

- [ ] Bấm **Replace** → hiện modal, viền/nút **XANH**, tiêu đề
      **`Replace the Default Template?`**, dòng nhấn
      **`Chưa ai cấu hình riêng cho account này.`**
- [ ] Bấm **Replace** trong modal, chọn file .xlsx template.
- [ ] Upload xong: pill **`Do migration nhân bản…`** của account đó
      **biến mất**.
- [ ] Dòng của account đó trong bảng toàn cảnh: cột `Nguồn gốc` đổi từ
      `bản sao migration` → **email của bạn**.
- [ ] ⚠ **5 account còn lại KHÔNG đổi gì** — vẫn `bản sao migration`,
      vẫn 846 ô, vẫn còn pill. (Đây là điều toàn bộ arc sinh ra để bảo
      đảm.)
- [ ] Badge vẫn là `6 / 6 account`.

### U6b — biến thể ĐỎ (làm ngay sau U6)

- [ ] Bấm **Replace** LẦN NỮA trên **đúng account vừa upload**.
- [ ] Modal lần này viền/nút **ĐỎ**, tiêu đề
      **`Ghi đè Default Template của account này?`**, dòng nhấn
      **`Sẽ ghi đè việc của <email của bạn>.`**
- [ ] Bấm **Huỷ** — không cần upload lại.

> U6 + U6b là cặp: chúng chứng minh hai biến thể được chọn theo *nguồn
> gốc bản đang có*, không phải theo ai đang đăng nhập.

## U7 — Gate admin (chỉ làm được nếu có tài khoản test không phải admin)

- [ ] Đăng nhập bằng tài khoản **KHÔNG** nằm trong `ADMIN_EMAILS`.
- [ ] Tab Default Template: **không thấy** nút `Replace` và `Remove`;
      thay vào đó thấy **`Chỉ admin sửa được Default Template`**.
- [ ] Vẫn bấm được **`Open matrix view`** và xem được ma trận (xem không
      bị gate).

> ⚠ **Nếu không có tài khoản test: ghi "KHÔNG KIỂM ĐƯỢC" và bỏ qua.**
> Đừng sửa `ADMIN_EMAILS` trên production để thử — đổi biến đó cần
> restart service **và** đăng xuất/đăng nhập lại (role được đóng vào JWT
> lúc đăng nhập), nên nó là một thay đổi production thật chứ không phải
> một phép thử.
> Lớp chặn thật nằm ở server và đã có test tự động; mục U7 chỉ kiểm phần
> giao diện có phản ánh đúng hay không.

## U8 — Export .xlsx không hồi quy (G2)

- [ ] Màn **Default matrix** (`…/pricing-templates/default`): bấm
      **`Export XLSX`** → tải được file, mở lên đúng ma trận.
- [ ] Màn **Per-App matrix** của một app có template riêng (PASS SDK /
      Play Together / Light and Night): bấm **`Export XLSX`** → tải được.
- [ ] Thứ tự cột trong file: **US · VN · SG · MY · ID · PH · TH · HK ·
      TW** (không phải alphabet).

## U9 — Cờ "thứ tự cột chưa xác định"

⚠ **Ca này nhiều khả năng KHÔNG dựng được trên production, và như thế là
đúng.** M-1 đã backfill `sort_order` cho toàn bộ 10 template, nên không
template nào còn thiếu nó.

**Đừng tạo dữ liệu giả trên production để nhìn thấy cái cờ này.**

Cách kiểm cho đúng — chạy câu SQL READ-ONLY này trong Supabase SQL Editor:

```sql
-- Có template nào còn entry thiếu sort_order không?
-- KỲ VỌNG: 0 dòng ⇒ ca "thứ tự cột chưa xác định" KHÔNG tồn tại trên
-- dữ liệu thật ⇒ ghi "KHÔNG KIỂM ĐƯỢC (không có dữ liệu ca này)".
-- Nếu ra > 0 dòng ⇒ mở màn matrix của đúng template đó, phải thấy dải
-- xanh "Thứ tự cột của template này chưa xác định…".
SELECT t.id, t.scope_type, t.scope_account_id, t.scope_app_id,
       COUNT(*) FILTER (WHERE e.sort_order IS NULL) AS o_thieu_sort_order
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
GROUP BY t.id, t.scope_type, t.scope_account_id, t.scope_app_id
HAVING COUNT(*) FILTER (WHERE e.sort_order IS NULL) > 0;
```

- [ ] Đã chạy câu trên. Kết quả: ☐ 0 dòng (ghi "KHÔNG KIỂM ĐƯỢC")
      ☐ có dòng → kiểm dải xanh trên màn tương ứng.

---

## Báo lại

Với mỗi mục: **OK** / **LỆCH (mô tả thấy gì)** / **KHÔNG KIỂM ĐƯỢC (lý do)**.

⚠ **Chỉ sau khi UAT xanh** mới tới M-2 (xoá dòng GLOBAL + thu hẹp CHECK +
drop index `…_global_unique`). Trước đó dòng GLOBAL vẫn nằm trong DB và
**không đường code nào đọc nó** — đó là trạng thái đã tính trước, không
phải sót.
