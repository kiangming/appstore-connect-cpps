# CPP Manager — Tài liệu triển khai

> Dành cho: Admin / DevOps — hướng dẫn cài đặt, cấu hình và triển khai CPP Manager lên Railway.

---

## Mục lục

1. [Tổng quan sản phẩm](#1-tổng-quan-sản-phẩm)
2. [Yêu cầu hệ thống](#2-yêu-cầu-hệ-thống)
3. [Chuẩn bị trước khi deploy](#3-chuẩn-bị-trước-khi-deploy)
4. [Deploy lên Railway](#4-deploy-lên-railway)
5. [Cấu hình Environment Variables](#5-cấu-hình-environment-variables)
6. [Thiết lập Supabase](#6-thiết-lập-supabase)
7. [Quản lý người dùng](#7-quản-lý-người-dùng)
8. [Thêm App Store Connect Account](#8-thêm-app-store-connect-account)
9. [Kiểm tra sau khi deploy](#9-kiểm-tra-sau-khi-deploy)
10. [Cập nhật phiên bản mới](#10-cập-nhật-phiên-bản-mới)

---

## 1. Tổng quan sản phẩm

**CPP Manager** là web dashboard nội bộ giúp team upload và quản lý **Custom Product Pages (CPP)** lên App Store Connect mà không cần đăng nhập trực tiếp vào trang web Apple.

### Tính năng chính

| Tính năng | Mô tả |
|---|---|
| App List | Xem danh sách apps với icon từ App Store |
| CPP List | Xem, lọc, quản lý CPP của từng app |
| CPP Editor | Chỉnh sửa nội dung, deep link, upload assets theo locale |
| Bulk Import Assets | Upload nhiều ảnh/video cho 1 CPP từ thư mục |
| CPP Bulk Import | Tạo nhiều CPP cùng lúc từ cấu trúc thư mục |
| Submit CPP | Gửi CPP lên Apple Review (sequential, retry, partial fail) |
| Export CSV | Xuất danh sách CPP kèm URL |
| Multi-Account | Quản lý và switch giữa nhiều Apple Developer accounts |
| Settings | Admin quản lý ASC accounts trực tiếp trên UI (lưu Supabase) |

### Kiến trúc

```
Browser ──→ Next.js App (Railway)
                ↓
         /api/asc/* routes (server-side)
                ↓
         App Store Connect API (api.appstoreconnect.apple.com)

Lưu trữ:
- Supabase (PostgreSQL): ASC accounts (encrypted)
- NextAuth JWT: session, active account, user role
```

**Quy tắc bảo mật:**
- Private key ASC (.p8) không bao giờ rời khỏi server
- Tất cả ASC API calls đi qua `/api/asc/` — không gọi trực tiếp từ browser
- Private key được mã hóa AES-256-GCM trước khi lưu vào Supabase

---

## 2. Yêu cầu hệ thống

### Cần có trước khi bắt đầu

| Thứ | Mô tả | Lấy ở đâu |
|---|---|---|
| Railway account | Nền tảng deploy | [railway.app](https://railway.app) |
| Supabase project | Database lưu ASC accounts | [supabase.com](https://supabase.com) |
| Google Cloud project | OAuth 2.0 cho đăng nhập | [console.cloud.google.com](https://console.cloud.google.com) |
| App Store Connect API key | File `.p8` + Key ID + Issuer ID | App Store Connect → Users and Access → Integrations |

### Quyền App Store Connect API key cần có

Khi tạo API key trên App Store Connect, chọn role:
- **App Manager** — tối thiểu để quản lý CPP
- Hoặc **Admin** — đủ quyền tất cả

---

## 3. Chuẩn bị trước khi deploy

### Bước 3.1 — Tạo Google OAuth credentials

1. Vào [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services** → **Credentials**
2. Nhấn **Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Authorized redirect URIs: thêm URI sau (sẽ điền domain Railway sau):
   ```
   https://<your-railway-domain>/api/auth/callback/google
   ```
   > Có thể điền tạm `https://localhost:3000/api/auth/callback/google` để test local, cập nhật sau khi có domain Railway.
5. Copy **Client ID** và **Client Secret**

### Bước 3.2 — Tạo Supabase project

1. Vào [supabase.com](https://supabase.com) → **New Project**
2. Chọn region gần nhất (ví dụ: Southeast Asia)
3. Sau khi project tạo xong, vào **Project Settings** → **API**:
   - Copy **Project URL** (`NEXT_PUBLIC_SUPABASE_URL`)
   - Copy **anon/public key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - Copy **service_role key** (`SUPABASE_SERVICE_ROLE_KEY`) — giữ bí mật

### Bước 3.3 — Chạy Supabase migration

Trong Supabase dashboard → **SQL Editor**, chạy nội dung file:

```
supabase/migrations/20260407000000_create_asc_accounts.sql
```

SQL tạo bảng `asc_accounts` với Row Level Security enabled (service_role only).

### Bước 3.4 — Generate Encryption Key

```bash
openssl rand -hex 32
```

Lưu kết quả (64 ký tự hex) làm `ENCRYPTION_KEY`.

### Bước 3.5 — Generate NextAuth Secret

```bash
openssl rand -base64 32
```

Lưu kết quả làm `NEXTAUTH_SECRET`.

---

## 4. Deploy lên Railway

### Bước 4.1 — Tạo Railway project

1. Vào [railway.app](https://railway.app) → **New Project**
2. Chọn **Deploy from GitHub repo**
3. Kết nối GitHub và chọn repo `appstore-connect-cpps`
4. Railway tự detect Next.js và cấu hình build

### Bước 4.2 — Cấu hình domain

1. Trong Railway project → tab **Settings** → **Networking**
2. Nhấn **Generate Domain** để lấy domain Railway (dạng `xxx.up.railway.app`)
3. Hoặc add custom domain của bạn

### Bước 4.3 — Cập nhật Google OAuth redirect URI

Quay lại Google Cloud Console → OAuth credentials → thêm URI:
```
https://<your-railway-domain>/api/auth/callback/google
```

---

## 5. Cấu hình Environment Variables

Vào Railway project → tab **Variables** → thêm từng biến sau:

### Bắt buộc

| Variable | Giá trị | Mô tả |
|---|---|---|
| `NEXTAUTH_SECRET` | `<openssl rand -base64 32>` | Secret để ký NextAuth JWT |
| `NEXTAUTH_URL` | `https://<your-railway-domain>` | URL chính xác của app (không có slash cuối) |
| `GOOGLE_CLIENT_ID` | `<từ Google Cloud Console>` | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | `<từ Google Cloud Console>` | OAuth Client Secret |
| `GOOGLE_ALLOWED_EMAILS` | `user1@gmail.com,user2@company.com` | Danh sách email được phép đăng nhập (comma-separated, không space) |
| `ADMIN_EMAILS` | `admin@company.com` | Danh sách email có quyền admin (comma-separated). Admin mới có thể vào Settings và quản lý accounts. |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxx.supabase.co` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Supabase service_role key — **giữ bí mật** |
| `ENCRYPTION_KEY` | `<64-char hex>` | Key mã hóa AES-256-GCM cho private keys |

### Tùy chọn (fallback)

| Variable | Giá trị | Mô tả |
|---|---|---|
| `ASC_ACCOUNTS` | `[{"id":"...","name":"...","keyId":"...","issuerId":"...","privateKey":"..."}]` | Fallback accounts từ env (dùng khi Supabase chưa có account nào). Có thể dùng để bootstrap lần đầu. |
| `NEXT_PUBLIC_ASSET_VALIDATION_DEEP` | `true` | Bật deep validation bằng ffmpeg.wasm. Mặc định `true`. |

### Ví dụ cấu hình đầy đủ

```env
NEXTAUTH_SECRET=abc123...
NEXTAUTH_URL=https://cpp-manager.up.railway.app
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_ALLOWED_EMAILS=alice@company.com,bob@company.com,charlie@gmail.com
ADMIN_EMAILS=alice@company.com
NEXT_PUBLIC_SUPABASE_URL=https://abcdefgh.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ENCRYPTION_KEY=a1b2c3d4e5f6...64chars...
```

---

## 6. Thiết lập Supabase

### Schema `asc_accounts`

Bảng được tạo bởi migration:

| Column | Type | Mô tả |
|---|---|---|
| `id` | TEXT (PK) | Slug duy nhất (ví dụ: `acme-vietnam`) |
| `name` | TEXT | Tên hiển thị (ví dụ: "Acme Vietnam") |
| `key_id` | TEXT | App Store Connect Key ID (10 ký tự) |
| `issuer_id` | TEXT | App Store Connect Issuer ID (UUID) |
| `private_key` | TEXT | Private key đã mã hóa AES-256-GCM |
| `is_active` | BOOLEAN | Account mặc định khi user chưa switch |
| `created_at` | TIMESTAMPTZ | Thời điểm tạo |
| `updated_at` | TIMESTAMPTZ | Thời điểm cập nhật cuối |

**Row Level Security:** Bật, không có row-level policies → chỉ `service_role` key mới có quyền truy cập. Client browser không thể đọc/ghi bảng này.

---

## 7. Quản lý người dùng

### Thêm user mới

Thêm email vào `GOOGLE_ALLOWED_EMAILS` trong Railway Variables:

```
GOOGLE_ALLOWED_EMAILS=existing@company.com,newuser@company.com
```

Sau khi cập nhật variable, Railway tự redeploy. User mới có thể đăng nhập ngay.

### Phân quyền Admin

Admin có thể:
- Vào trang **Settings** để quản lý ASC accounts
- Thêm / sửa / xóa App Store Connect accounts

Thêm email vào `ADMIN_EMAILS`:
```
ADMIN_EMAILS=admin1@company.com,admin2@company.com
```

### Xóa user

Xóa email khỏi `GOOGLE_ALLOWED_EMAILS` → user không thể đăng nhập sau khi session hết hạn (mặc định 30 ngày). Nếu cần revoke ngay: xóa NextAuth session trong Supabase (nếu dùng DB sessions) hoặc thay đổi `NEXTAUTH_SECRET` (logout tất cả user).

---

## 8. Thêm App Store Connect Account

Sau khi deploy xong, admin cần thêm ít nhất 1 ASC account để app hoạt động.

### Cách lấy thông tin từ App Store Connect

1. Đăng nhập [App Store Connect](https://appstoreconnect.apple.com)
2. Vào **Users and Access** → **Integrations** → **App Store Connect API**
3. Nhấn **Generate API Key** (nếu chưa có):
   - Name: tùy ý (ví dụ: "CPP Manager")
   - Access: **App Manager** hoặc **Admin**
4. Tải file `.p8` (chỉ tải được 1 lần — lưu cẩn thận)
5. Copy **Key ID** (10 ký tự, ví dụ: `ABC123DEF4`)
6. Copy **Issuer ID** (UUID, ví dụ: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### Thêm account qua Settings UI

1. Đăng nhập CPP Manager với tài khoản admin
2. Vào **Settings** (tab trên cùng)
3. Nhấn **+ Add Account**
4. Điền thông tin:
   - **Display Name**: tên hiển thị tùy ý (ví dụ: "Acme Vietnam")
   - **Key ID**: 10 ký tự từ App Store Connect
   - **Issuer ID**: UUID từ App Store Connect
   - **Private Key**: dán nội dung file `.p8` hoặc nhấn **Upload .p8 file**
5. Nhấn **Save**
6. Account xuất hiện trong danh sách — bật **Set as default** nếu muốn đây là account mặc định

### Lưu ý bảo mật

- File `.p8` chứa private key — lưu ở nơi an toàn sau khi upload
- Nếu key bị lộ: vào App Store Connect → **Revoke** key cũ → tạo key mới → cập nhật trong Settings
- Private key được mã hóa AES-256-GCM trước khi lưu vào Supabase — cần cả `ENCRYPTION_KEY` lẫn `SUPABASE_SERVICE_ROLE_KEY` để giải mã

---

## 9. Kiểm tra sau khi deploy

### Checklist

- [ ] Truy cập `https://<your-domain>` → redirect về trang login
- [ ] Đăng nhập bằng Google (email trong `GOOGLE_ALLOWED_EMAILS`)
- [ ] Thấy trang App List → có nghĩa là ASC account hoạt động
- [ ] Switch account hoạt động (AccountSwitcher góc trên phải)
- [ ] Admin đăng nhập → vào Settings → thêm/sửa account thành công
- [ ] Upload thử 1 screenshot → thành công

### Lỗi thường gặp

| Lỗi | Nguyên nhân | Giải pháp |
|---|---|---|
| Redirect loop khi login | `NEXTAUTH_URL` sai domain | Cập nhật đúng `https://<your-domain>` |
| "This account is not authorized" | Email chưa trong `GOOGLE_ALLOWED_EMAILS` | Thêm email vào biến |
| App List rỗng / lỗi 401 | ASC account chưa được thêm hoặc key hết hạn | Vào Settings → thêm account |
| Settings page redirect về `/` | User không phải admin | Thêm email vào `ADMIN_EMAILS` |
| Build fail "Cannot read properties of undefined" | Thiếu `export const dynamic = "force-dynamic"` | Đã fix trong codebase — kiểm tra lại |
| Supabase permission denied | Dùng sai key (anon thay vì service_role) | Kiểm tra `SUPABASE_SERVICE_ROLE_KEY` |

---

## 10. Cập nhật phiên bản mới

### Quy trình

1. Push code mới lên GitHub (branch main)
2. Railway tự động detect thay đổi và redeploy
3. Build thường mất 2–3 phút
4. Không cần downtime — Railway deploy song song (zero-downtime deployment)

### Nếu có Supabase migration mới

Sau khi deploy code mới:
1. Vào Supabase Dashboard → **SQL Editor**
2. Chạy file migration mới trong `supabase/migrations/`

### Rollback

Trong Railway project → tab **Deployments** → chọn deployment cũ → **Rollback**.

---

## Phụ lục — Cấu trúc dữ liệu ASC Account

### Format JSON (dùng cho `ASC_ACCOUNTS` env fallback)

```json
[
  {
    "id": "acme-vietnam",
    "name": "Acme Vietnam",
    "keyId": "ABC123DEF4",
    "issuerId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "privateKey": "-----BEGIN PRIVATE KEY-----\nMIGTA...\n-----END PRIVATE KEY-----"
  }
]
```

**Lưu ý:** Trong env var, `privateKey` phải escape newlines thành `\n` (trên 1 dòng duy nhất). Khi thêm qua Settings UI, app tự xử lý việc này.

### App Store Connect API — thứ bậc resource

```
App
└── AppCustomProductPage (CPP)
    └── AppCustomProductPageVersion (draft / approved / in-review)
        └── AppCustomProductPageLocalization (per locale)
            ├── AppScreenshotSet (nhóm theo device type)
            │   └── AppScreenshot
            └── AppPreviewSet (nhóm theo device type)
                └── AppPreview (video)
```

### CPP States

| State | Mô tả | Hành động được phép |
|---|---|---|
| `PREPARE_FOR_SUBMISSION` | Draft | Edit, upload, submit, delete |
| `WAITING_FOR_REVIEW` | Đã submit, chờ vào hàng | Không edit |
| `IN_REVIEW` | Apple đang review | Không edit |
| `APPROVED` | Đã duyệt — hiển thị cho user | Không edit, có thể xóa |
| `REJECTED` | Bị từ chối | Xem lý do, tạo version mới |
