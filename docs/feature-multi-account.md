# Feature: Multi-Account App Store Connect

**Date:** 2026-03-12
**Status:** ✅ Implemented
**Scope:** Cho phép user switch giữa nhiều App Store Connect accounts trực tiếp trên UI

---

## Mục tiêu

Team quản lý nhiều Apple Developer accounts (vd: nhiều client khác nhau). Hiện tại credentials hardcode trong `.env.local` — chỉ hỗ trợ 1 account, cần redeploy để đổi. Tính năng này cho phép khai báo nhiều accounts và switch nhanh trên UI mà không cần redeploy.

---

## Understanding Lock (confirmed)

- **Cái gì:** Multi-account ASC support — switch giữa nhiều App Store Connect accounts trực tiếp trên UI
- **Tại sao:** Team quản lý nhiều Apple Developer accounts (vd: nhiều client), cần chuyển đổi nhanh
- **Ai dùng:** Tất cả authenticated users có thể switch; admin quản lý credentials ở infrastructure level (env vars)
- **Lưu trữ credentials:** `ASC_ACCOUNTS` JSON blob env var duy nhất — không lưu database; redeploy khi thêm/xóa account
- **Active account:** Per-user, per-session — lưu trong NextAuth session JWT
- **UI:** Account switcher góc trên phải — tất cả users đều thấy và dùng được; full page reload sau switch
- **Security boundary:** Private key (.p8) không bao giờ rời khỏi server; client chỉ nhận `id`, `name`, `keyId`

---

## Assumptions

| # | Assumption |
|---|---|
| A1 | Backward compatible: nếu `ASC_ACCOUNTS` không tồn tại → fallback về `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY` cũ |
| A2 | Account đầu tiên trong JSON array = default account khi user chưa chọn |
| A3 | Admin được xác định bởi `ADMIN_EMAIL` env var (đã có trong hệ thống) |
| A4 | "Admin quản lý credentials" = quản lý env vars trực tiếp (Vercel dashboard / Docker .env), không có CRUD UI |
| A5 | Account name là human-readable label tùy ý (vd: "Client A - Vietnam", "Internal") |
| A6 | Khi session hết hạn → active account reset về default |
| A7 | Số lượng accounts nhỏ (< 20) — không cần pagination hay search |
| A8 | Sau khi switch account → full page reload để load data theo account mới |

---

## Env Var Format

### `ASC_ACCOUNTS` (JSON blob)

```json
[
  {
    "id": "acme-vn",
    "name": "Acme Vietnam",
    "keyId": "ABC123DEF4",
    "issuerId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  },
  {
    "id": "internal",
    "name": "Internal Team",
    "keyId": "XYZ987GHI1",
    "issuerId": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  }
]
```

**Fields:**
| Field | Bắt buộc | Mô tả |
|---|---|---|
| `id` | ✅ | Slug unique, dùng làm key trong session (vd: `"acme-vn"`) |
| `name` | ✅ | Human-readable label hiển thị trên UI |
| `keyId` | ✅ | App Store Connect Key ID |
| `issuerId` | ✅ | App Store Connect Issuer ID |
| `privateKey` | ✅ | Nội dung file .p8 (dùng `\n` cho newline trong JSON string) |

**Backward compat:** Nếu `ASC_ACCOUNTS` không tồn tại → fallback về `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY` đơn lẻ.

---

## Architecture

### Data Flow

```
Browser (AccountSwitcher)
    ↓ POST /api/asc/accounts/active  ← validate accountId tồn tại
    ↓ useSession().update({ activeAccountId })  ← NextAuth JWT update
    ↓ window.location.reload()

Server (API Routes)
    ↓ getActiveAccount()  ← đọc session → lookup ASC_ACCOUNTS
    ↓ asc-client.ts(creds)  ← credentials passed as parameter
    ↓ asc-jwt.ts(creds)  ← generate JWT với credentials động
    ↓ App Store Connect API
```

### NextAuth Session

```typescript
// types/next-auth.d.ts
declare module "next-auth" {
  interface Session {
    user: { email: string; role: "admin" | "user" }
    activeAccountId: string | null
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    activeAccountId: string | null
  }
}
```

JWT callback trong `lib/auth.ts`:
```typescript
callbacks: {
  jwt({ token, trigger, session }) {
    if (trigger === "update" && session?.activeAccountId !== undefined) {
      token.activeAccountId = session.activeAccountId;
    }
    return token;
  },
  session({ session, token }) {
    session.activeAccountId = token.activeAccountId ?? null;
    return session;
  }
}
```

---

## Files đã tạo / sửa (Implementation)

### Tạo mới ✅

| File | Mô tả |
|---|---|
| `lib/asc-accounts.ts` | Parse `ASC_ACCOUNTS`, export `getAscAccounts()`, `getAscAccountById()`, `getDefaultAscAccount()`, `getAscAccountsPublic()`. Fail-fast validation khi module load. Backward compat với env vars cũ. |
| `lib/get-active-account.ts` | `getActiveAccount()` — đọc session → lookup account → fallback về default |
| `app/api/asc/accounts/route.ts` | `GET` — trả về account list (safe: không có privateKey/issuerId) + activeAccountId |
| `app/api/asc/accounts/active/route.ts` | `POST` — validate accountId server-side trước khi client gọi `useSession().update()` |
| `components/layout/AccountSwitcher.tsx` | Dropdown component góc trên phải. Ẩn khi chỉ có 1 account. Switch flow: validate → `useSession().update()` → `window.location.reload()` |

### Sửa ✅

| File | Thay đổi |
|---|---|
| `lib/asc-jwt.ts` | Nhận `AscCredentials` làm parameter; không còn đọc `process.env` trực tiếp |
| `lib/asc-client.ts` | `ascFetch()` + tất cả 18 exported functions nhận `AscCredentials` làm arg đầu tiên. Log prefix `[ASC:<keyId>]` để debug multi-account. `uploadAssetToOperations` không cần creds (upload thẳng lên CDN) |
| `lib/auth.ts` | Thêm `jwt` + `session` callbacks để persist `activeAccountId`; augment `Session` + `JWT` types inline |
| `app/api/asc/apps/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/apps/[appId]/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/apps/[appId]/app-info-localizations/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/cpps/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/cpps/[cppId]/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/cpps/[cppId]/localizations/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/localizations/[localizationId]/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/screenshot-sets/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/preview-sets/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/upload/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/upload-preview/route.ts` | Dùng `getActiveAccount()` |
| `app/api/asc/versions/[versionId]/route.ts` | Dùng `getActiveAccount()` |
| `app/(dashboard)/layout.tsx` | Thêm `<header>` bar với `<AccountSwitcher />` góc trên phải |
| `.env.example` | Cập nhật format mới: `ASC_ACCOUNTS` JSON array với ví dụ 5 accounts; giữ Option B backward compat |

---

## `lib/asc-accounts.ts` — Interface

```typescript
export interface AscAccount {
  id: string;
  name: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
}

export interface AscAccountPublic {
  id: string;
  name: string;
  keyId: string;   // non-sensitive, dùng để debug/display
  // privateKey + issuerId: KHÔNG expose
}

export function getAscAccounts(): AscAccount[]
export function getAscAccountById(id: string): AscAccount | null
export function getDefaultAscAccount(): AscAccount  // fallback về env vars cũ nếu cần
export function getAscAccountsPublic(): AscAccountPublic[]
```

---

## `lib/asc-jwt.ts` — Refactored Interface

```typescript
export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKey: string;
}

export async function generateAscToken(creds: AscCredentials): Promise<string>
```

---

## AccountSwitcher UI

```
┌──────────────────────────────────────┐
│  [Acme Vietnam ▾]                    │  ← góc trên phải header
└──────────────────────────────────────┘

Dropdown khi mở:
  ✓  Acme Vietnam       (key: ABC123...)
     Internal Team      (key: XYZ987...)
  ─────────────────────────────────────
     [Chọn → reload toàn trang]
```

- Ẩn hoàn toàn nếu chỉ có 1 account
- Hiển thị checkmark trên active account
- Khi chọn account khác: validate → update session → `window.location.reload()`

---

## API Routes

### `GET /api/asc/accounts`

Response:
```json
{
  "accounts": [
    { "id": "acme-vn", "name": "Acme Vietnam", "keyId": "ABC123DEF4" },
    { "id": "internal", "name": "Internal Team", "keyId": "XYZ987GHI1" }
  ],
  "activeAccountId": "acme-vn"
}
```

### `POST /api/asc/accounts/active`

Request body: `{ "accountId": "internal" }`

Response: `{ "ok": true }` hoặc `{ "error": "Invalid account" }` (400)

**Mục đích:** Server validate `accountId` tồn tại trong `ASC_ACCOUNTS` trước khi client gọi `useSession().update()`. Tránh session bị set giá trị không hợp lệ.

---

## Error Handling & Edge Cases

| Tình huống | Hành vi |
|---|---|
| `ASC_ACCOUNTS` không tồn tại | Fallback về `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY` cũ — backward compatible |
| `ASC_ACCOUNTS` JSON malformed | Throw error khi module load — fail fast, app không start |
| `ASC_ACCOUNTS` array rỗng | Throw error khi module load |
| `activeAccountId` trong session trỏ tới account đã xóa | `getActiveAccount()` fallback về default (index 0) |
| Chỉ có 1 account | `AccountSwitcher` ẩn hoàn toàn |
| Session hết hạn | Active account reset về default khi login lại |

---

## Security Controls

| # | Control | Chi tiết |
|---|---|---|
| S1 | **Private key không rời server** | `privateKey` + `issuerId` không serialize vào response; `GET /api/asc/accounts` chỉ trả `id`, `name`, `keyId` |
| S2 | **Server-side validation trước session update** | `POST /api/asc/accounts/active` validate `accountId` tồn tại trước khi client gọi `useSession().update()` |
| S3 | **Credentials không vào session JWT** | JWT chỉ chứa `activeAccountId` (slug) — nếu JWT bị decode không lộ credentials |
| S4 | **All API routes require auth** | `getServerSession()` check trên mọi route |
| S5 | **Env var là single source of truth** | Không có copy của private key trong database, cache, hay log |
| S6 | **Fail fast on misconfiguration** | Parse `ASC_ACCOUNTS` khi module load — lỗi format bị phát hiện sớm |
| S7 | **`keyId` non-sensitive** | Hiển thị trên UI để debug — Apple Key ID là identifier, không phải secret |
| S8 | **Logging** | Log `account.name` và `account.keyId` only — KHÔNG log `privateKey` hay `issuerId` |

---

## Decision Log

| # | Quyết định | Alternatives | Lý do |
|---|---|---|---|
| D1 | Active account = per-session | Global shared | Mỗi user làm việc độc lập — global gây conflict |
| D2 | Chỉ admin quản lý credentials | Tất cả users | Private key nhạy cảm — giới hạn attack surface |
| D3 | Credentials trong env vars (không database) | Supabase encrypted, filesystem | Không risk DB breach; infrastructure-level security; không cần quản lý encryption key |
| D4 | `ASC_ACCOUNTS` = JSON blob 1 env var | Numbered prefix, named prefix | Dễ parse, dễ đọc, không giới hạn số lượng accounts |
| D5 | Active account trong NextAuth session JWT | Cookie riêng, localStorage, Supabase | Native pattern; tự expire theo session; CSRF-safe; không cần thêm storage |
| D6 | Tất cả users có thể switch | Chỉ admin switch | Team nhỏ, trust nội bộ; mỗi người cần làm việc với account phù hợp |
| D7 | Full page reload sau switch | Incremental cache invalidation | Đơn giản, không stale state, consistent với team size |
| D8 | Approach A: NextAuth session + `getActiveAccount()` | Cookie riêng, Middleware inject | Native NextAuth, minimal moving parts, transparent server-side lookup |
| D9 | `POST /api/asc/accounts/active` validate trước `useSession().update()` | Client tự update session trực tiếp | Tránh session pollution với accountId không hợp lệ |
| D10 | Chỉ expose `id`, `name`, `keyId` ra client | Expose toàn bộ | `privateKey` + `issuerId` không bao giờ rời server |
