# Settings — ASC Account Builder

> Status: **PENDING DEVELOPMENT**
> Priority: Medium
> Estimated effort: ~2 giờ (Claude)

---

## Tóm tắt

Settings page giúp admin tạo chuỗi `ASC_ACCOUNTS` đúng format để paste vào `.env` — thay thế việc tự tay escape newlines và construct JSON một dòng.

**Pain point gốc:** Khai báo nhiều ASC accounts trong `ASC_ACCOUNTS` env var phải là JSON array trên 1 dòng duy nhất. Private key `.p8` có nhiều dòng phải được escape thủ công thành `\n` — dễ sai, khó đọc.

**Giải pháp:** Form nhập từng field riêng, upload `.p8` file, `JSON.stringify()` tự xử lý escape. Output là chuỗi hoàn chỉnh để copy-paste.

---

## Understanding Summary

- **Xây dựng:** Settings Helper page — form nhập account info → generate `ASC_ACCOUNTS` string → copy-paste vào `.env` → restart
- **Tại sao:** Giảm friction khi khai báo ASC accounts, đặc biệt private key multiline
- **Ai dùng:** Chỉ admin (login bằng `ADMIN_EMAIL/ADMIN_PASSWORD`)
- **Constraints:** Không lưu gì vào DB; không cần API route mới; client-side only
- **Non-goals:** Real-time update AccountSwitcher, edit account sau khi tạo, delete account đang hoạt động, test connection

---

## Assumptions

- Admin = user login bằng Credentials provider có email === `ADMIN_EMAIL` env var
- Sau khi paste `ASC_ACCOUNTS` vào `.env` và restart, AccountSwitcher tự cập nhật (behavior hiện tại)
- Private key trong builder list tồn tại trong browser memory — mất khi refresh/navigate away (chấp nhận được)
- Không cần warn user khi navigate away với data unsaved trong builder

---

## Architecture

### Luồng tổng quan

```
/settings  (Server Component)
    ↓ getServerSession(authOptions)
    ↓ if session.user.email !== ADMIN_EMAIL → redirect("/")
    ↓ đọc ASC_ACCOUNTS env → mask sensitive fields → pass to client
    ↓
<SettingsPage />  (Client Component)
    ├── Section 1: Active Accounts   ← env accounts, masked, read-only
    └── Section 2: Account Builder   ← form, generate, copy output
```

### Files cần tạo/sửa

| File | Thay đổi |
|---|---|
| `app/(dashboard)/settings/page.tsx` | **Tạo mới** — Server Component, auth guard, pass masked accounts |
| `components/settings/SettingsPage.tsx` | **Tạo mới** — Client Component, toàn bộ UI + logic |
| `components/layout/SidebarNav.tsx` | **Sửa** — Thêm link "Settings" (luôn hiện, không cần isAdmin check) |

Không cần API route mới, không cần DB, không cần env var mới.

---

## UI Layout & Mockup

### Page layout

```
┌──────────────────┬─────────────────────────────────────────────┐
│ Sidebar          │ Settings                                    │
│                  │ ─────────────────────────────────────────── │
│  📱 Apps         │                                             │
│  ⚙️ Settings  ← │  App Store Connect Accounts                 │
│                  │  [Section 1 — Active Accounts]              │
│                  │                                             │
│                  │  Tạo cấu hình ASC_ACCOUNTS                 │
│                  │  [Section 2 — Account Builder]              │
└──────────────────┴─────────────────────────────────────────────┘
```

### Section 1 — Active Accounts (read-only)

```
┌─────────────────────────────────────────────────────────────────┐
│ App Store Connect Accounts                                      │
│ Accounts đang được cấu hình qua ASC_ACCOUNTS trong .env        │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 🏢 Client A                              [From ENV]       │  │
│  │    Key ID:    AAAA••••••                                  │  │
│  │    Issuer ID: aaaa-••••-••••-••••-aaaaaaaaaaaa            │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 🏢 Client B                              [From ENV]       │  │
│  │    Key ID:    BBBB••••••                                  │  │
│  │    Issuer ID: bbbb-••••-••••-••••-bbbbbbbbbbbb            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Nếu `ASC_ACCOUNTS` không được set → hiển thị empty state:
```
  (Chưa có account nào được cấu hình trong .env)
```

### Section 2 — Account Builder

```
┌─────────────────────────────────────────────────────────────────┐
│ Tạo cấu hình ASC_ACCOUNTS                                      │
│ Dùng form bên dưới để tạo chuỗi ASC_ACCOUNTS cho .env         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Accounts trong builder:                     (có thể để trống) │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Client A  │  Key: AAAAAAAAAA  │               [✕ Xoá]    │  │
│  │ Client B  │  Key: BBBBBBBBBB  │               [✕ Xoá]    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ── Thêm account ─────────────────────────────────────────────  │
│                                                                 │
│  Tên hiển thị *              Key ID * (10 ký tự)               │
│  [____________________]      [__________]                       │
│                                                                 │
│  Issuer ID *                                                    │
│  [________________________________________________]             │
│                                                                 │
│  Private Key (.p8) *                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ -----BEGIN PRIVATE KEY-----                             │   │
│  │ MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBH...             │   │
│  │ -----END PRIVATE KEY-----                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│  [ Upload file .p8 ]  ← click để chọn file, tự điền textarea  │
│                                                                 │
│                                    [+ Thêm vào danh sách]      │
│                                                                 │
│  ── Output ───────────────────────────────────────────────────  │
│                                                                 │
│  [ Generate ASC_ACCOUNTS string ]                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ASC_ACCOUNTS=[{"id":"client-a","name":"Client A",...}]  │[📋]│
│  └─────────────────────────────────────────────────────────┘   │
│  ⚡ Copy toàn bộ dòng trên vào .env, thay ASC_ACCOUNTS cũ,    │
│     rồi restart server.                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow & Key Logic

### Generate function (client-side, không gọi server)

```typescript
interface BuilderAccount {
  name: string;       // "Client A"
  keyId: string;      // "AAAAAAAAAA"
  issuerId: string;   // "aaaa-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  privateKey: string; // full .p8 content (multiline)
}

function generateEnvString(accounts: BuilderAccount[]): string {
  const arr = accounts.map((a) => ({
    id: slugify(a.name),
    name: a.name,
    keyId: a.keyId,
    issuerId: a.issuerId,
    privateKey: a.privateKey.trim().replace(/\r\n/g, "\n"),
  }));
  return `ASC_ACCOUNTS=${JSON.stringify(arr)}`;
  // JSON.stringify tự escape \n trong privateKey ✓
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
```

### Upload .p8 — đọc client-side

```typescript
// File chỉ đọc trong browser, không upload lên server
function handleFileUpload(file: File) {
  const reader = new FileReader();
  reader.onload = (e) => setPrivateKey(e.target?.result as string);
  reader.readAsText(file);
}
```

### Mask logic (server-side, trước khi truyền xuống client)

```typescript
// Server Component — không bao giờ expose privateKey hoặc issuerId đầy đủ
const maskedAccounts = accounts.map((a) => ({
  name: a.name,
  keyId: a.keyId.slice(0, 4) + "••••••",
  issuerId: a.issuerId.slice(0, 4) + "-••••-••••-••••-" + a.issuerId.slice(-4),
}));
```

### Auth guard (server-side)

```typescript
// app/(dashboard)/settings/page.tsx
const session = await getServerSession(authOptions);
const isAdmin = session?.user?.email === process.env.ADMIN_EMAIL;
if (!isAdmin) redirect("/");
```

---

## Validation (khi nhấn "Thêm vào danh sách")

| Field | Rule | Error message |
|---|---|---|
| Tên hiển thị | Bắt buộc, không trống | "Vui lòng nhập tên account" |
| Key ID | Exactly 10 ký tự, alphanumeric | "Key ID phải đúng 10 ký tự" |
| Issuer ID | UUID format | "Issuer ID không đúng định dạng UUID" |
| Private Key | Phải chứa `-----BEGIN PRIVATE KEY-----` | "Private key không hợp lệ" |
| Slug unique | `slugify(name)` chưa tồn tại trong builder | "Tên này trùng với account đã thêm" |

---

## Edge Cases

| Tình huống | Xử lý |
|---|---|
| Builder list rỗng, click Generate | Button disabled, tooltip "Thêm ít nhất 1 account" |
| Private key có Windows CRLF (`\r\n`) | `replace(/\r\n/g, "\n")` trước khi stringify |
| File upload không phải `.p8` / sai format | Validate header, show inline error |
| Output string rất dài (5+ accounts) | Textarea scroll, không truncate |
| User navigate away với data trong builder | Không warn — data không persist, không gây hại |

---

## Security Notes

**Private key exposure mitigations:**
- Page chỉ accessible với admin (server redirect)
- HTTPS — không leak trên network
- Private key không gửi lên server (client-side FileReader + JSON.stringify)
- Output textarea không auto-copy — user chủ động action

**Acceptable risks (internal tool):**
- Private key visible trong textarea khi nhập
- Browser memory giữ key cho đến khi navigate away / refresh

---

## Decision Log

| Quyết định | Alternatives | Lý do chọn |
|---|---|---|
| Không dùng DB | Supabase hybrid | Pain point là input format, không phải persistence. YAGNI. |
| Auth guard bằng email === ADMIN_EMAIL | `isAdmin` trong JWT | Không cần thay đổi JWT schema; đủ đơn giản cho single-tenant |
| Sidebar luôn hiện Settings link | Ẩn với non-admin | Server redirect rõ ràng hơn ẩn link; simpler |
| Client-side generate | Server API | Không cần server xử lý sensitive data; simpler |
| `JSON.stringify` cho escape | Manual string concat | Đây chính là lý do tính năng tồn tại — delegate escaping cho built-in |
| Textarea + file upload cho private key | Chỉ paste / chỉ upload | File upload tránh lỗi copy-paste; textarea cho power users |
| Slugify name thành ID | UUID / manual input | Tự động, consistent, không cần user hiểu concept "ID" |
