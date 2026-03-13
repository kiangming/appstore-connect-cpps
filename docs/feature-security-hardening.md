# Security Hardening — Design Document

> Status: **PENDING DEVELOPMENT**
> Priority: 🔴 Critical (phải làm trước khi deploy Vercel)
> Estimated effort: ~1 giờ (Claude)

---

## Bối cảnh

Hiện tại, chỉ có `app/api/asc/accounts/route.ts` kiểm tra NextAuth session. **12 route còn lại không có auth check** — bất kỳ ai biết URL cũng có thể gọi ASC API proxy mà không cần đăng nhập.

Đây là lỗ hổng nghiêm trọng với Vercel deploy (URL public).
Với Docker self-host trên internal network thì rủi ro thấp hơn, nhưng vẫn nên fix.

---

## Yêu cầu

- Tất cả `/api/asc/*` routes phải yêu cầu NextAuth session hợp lệ
- Không phá vỡ existing behavior cho user đã login
- Unauthenticated request trả về `401 Unauthorized`
- Solution phải minimal, không over-engineer

---

## Design

### Approach: Shared auth guard utility

Tạo 1 helper function `requireAuth()` dùng chung cho tất cả routes.

```typescript
// lib/require-auth.ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function requireAuth(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null; // null = ok, tiếp tục xử lý
}
```

Dùng trong mỗi route handler:

```typescript
export async function GET(req: Request) {
  const authError = await requireAuth();
  if (authError) return authError;
  // ... xử lý bình thường
}
```

### Tại sao không dùng Next.js middleware?

Middleware (`middleware.ts`) là cách "đúng" theo Next.js docs, nhưng có trade-off:
- Middleware chạy trên Edge Runtime — không tương thích với `getServerSession` (Node.js only)
- Phải dùng `getToken()` từ `next-auth/jwt` thay thế — thêm complexity
- Với 12 routes và codebase nội bộ, inline guard đơn giản hơn và dễ debug hơn

**Decision: Dùng `requireAuth()` utility, gọi inline trong mỗi route.**

### Thay thế (không chọn)

| Option | Pros | Cons |
|---|---|---|
| `middleware.ts` + `getToken()` | Centralized, 1 chỗ | Edge Runtime limit, harder to debug |
| `requireAuth()` inline | Simple, explicit | Phải update 12 files |
| Route Group với shared layout | Clean | Không apply cho API routes trong Next.js |

---

## Files cần thay đổi

### File mới

- `lib/require-auth.ts` — auth guard utility

### Files update (thêm `requireAuth()` call đầu mỗi handler)

| Route file | Handlers cần guard |
|---|---|
| `app/api/asc/apps/route.ts` | GET |
| `app/api/asc/apps/[appId]/route.ts` | GET |
| `app/api/asc/apps/[appId]/app-info-localizations/route.ts` | GET, POST |
| `app/api/asc/cpps/route.ts` | GET, POST |
| `app/api/asc/cpps/[cppId]/route.ts` | GET, PATCH, DELETE |
| `app/api/asc/cpps/[cppId]/submit/route.ts` | POST |
| `app/api/asc/cpps/[cppId]/localizations/route.ts` | POST |
| `app/api/asc/localizations/[localizationId]/route.ts` | PATCH |
| `app/api/asc/versions/[versionId]/route.ts` | PATCH |
| `app/api/asc/screenshot-sets/route.ts` | GET, POST |
| `app/api/asc/preview-sets/route.ts` | GET, POST |
| `app/api/asc/upload/route.ts` | POST |
| `app/api/asc/upload-preview/route.ts` | POST |

> `app/api/asc/accounts/route.ts` đã có auth check — không cần update.

---

## Testing

Sau khi implement:

1. **Logout**, rồi dùng `curl` hoặc Postman gọi `GET /api/asc/apps` → expect `401`
2. **Login**, gọi lại → expect `200` với data bình thường
3. Smoke test toàn bộ UI flow (App List → CPP List → CPP Detail) để đảm bảo không break

---

## Decision Log

| Quyết định | Lý do |
|---|---|
| Dùng inline `requireAuth()` thay middleware | Edge Runtime không tương thích với `getServerSession`; simpler for small codebase |
| Trả về 401 (không phải 403) | 401 = chưa xác thực (đúng semantic); 403 = đã xác thực nhưng không có quyền |
| Không check role/permission | App nội bộ, single-tenant, mọi user đã login đều có full access |
