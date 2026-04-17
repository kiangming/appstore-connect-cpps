# Feature: Google OAuth + Role-Based Auth

> Status: ✅ Implemented (v1: 2026-03-12, v2 refactor: 2026-04-07)

---

## Tổng quan

- **v1 (2026-03-12):** Thêm Google OAuth bên cạnh CredentialsProvider. `ADMIN_ENABLE` ẩn/hiện form email/password.
- **v2 (2026-04-07):** Xóa hoàn toàn CredentialsProvider. Google OAuth only. Role-based: `admin` | `member` gán qua `ADMIN_EMAILS` env var.

---

## Yêu cầu (v2)

1. Chỉ Google OAuth — không còn form email/password
2. Emails trong `GOOGLE_ALLOWED_EMAILS` được phép login
3. Emails trong `ADMIN_EMAILS` được gán role `"admin"` → truy cập Settings + admin APIs
4. Emails còn lại được gán role `"member"`
5. Settings page guard: `session.user.role !== "admin"` → redirect

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `lib/auth.ts` | Xóa CredentialsProvider. Chỉ GoogleProvider. `jwt` callback gán role từ `ADMIN_EMAILS`. Module augmentation thêm `role` vào Session + JWT types. |
| `components/auth/LoginForm.tsx` | Rewrite: chỉ còn Google button, không props |
| `app/(auth)/login/page.tsx` | Simplify: không còn đọc `ADMIN_ENABLE`, render `<LoginForm />` không props |

---

## Cấu trúc mới

### `lib/auth.ts`

```typescript
declare module "next-auth" {
  interface Session { user: { role: "admin" | "member" } & DefaultSession["user"] }
}
declare module "next-auth/jwt" {
  interface JWT { role: "admin" | "member" }
}

function isAdminEmail(email: string): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS ?? "").split(",").map(e => e.trim()).filter(Boolean);
  return adminEmails.includes(email);
}

providers: [
  GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
],
callbacks: {
  async signIn({ account, profile }) {
    if (account?.provider !== "google") return false;
    const allowed = (process.env.GOOGLE_ALLOWED_EMAILS ?? "")
      .split(",").map(e => e.trim()).filter(Boolean);
    return allowed.includes(profile?.email ?? "");
  },
  async jwt({ token, profile, trigger }) {
    if (trigger === "signIn" && profile?.email) {
      token.role = isAdminEmail(profile.email) ? "admin" : "member";
    }
    return token;
  },
  async session({ session, token }) {
    session.user.role = token.role ?? "member";
    return session;
  },
}
```

### Settings page guard

```typescript
// app/(dashboard)/settings/page.tsx
const session = await getServerSession(authOptions);
if (!session || session.user.role !== "admin") redirect("/");
```

---

## Env vars

```env
GOOGLE_CLIENT_ID=           # từ Google Cloud Console
GOOGLE_CLIENT_SECRET=       # từ Google Cloud Console
GOOGLE_ALLOWED_EMAILS=user1@gmail.com,user2@company.com  # ai được login
ADMIN_EMAILS=admin@company.com                           # ai có role admin

# REMOVED:
# ADMIN_ENABLE, ADMIN_EMAIL, ADMIN_PASSWORD
```

---

## Setup Google OAuth

1. Vào [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Tạo OAuth 2.0 Client ID (Web application)
3. Thêm Authorized redirect URI: `https://yourdomain.com/api/auth/callback/google`
4. Copy Client ID + Client Secret

---

## Decision Log

| Quyết định | Alternatives | Lý do chọn |
|---|---|---|
| Xóa CredentialsProvider | Giữ lại với ADMIN_ENABLE | Deploy lên Railway, không cần local fallback, đơn giản hơn |
| `ADMIN_EMAILS` env var cho role | DB role table, JWT custom claim | Team nhỏ, không thay đổi thường xuyên |
| Role trong JWT (không query DB mỗi request) | Middleware DB check | Performance, JWT strategy không có DB per-request |
| `export const dynamic = "force-dynamic"` trên pages dùng getServerSession | Middleware route protection | Fix Railway build failure — Next.js cố pre-render static |
