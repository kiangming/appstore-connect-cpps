# Feature: Google OAuth + Admin Login Control

> Status: ✅ Implemented (2026-03-12)

---

## Tổng quan

Thêm Google OAuth 2.0 login bên cạnh credentials login hiện có. Admin login form được ẩn/hiện bằng env var `ADMIN_ENABLE`.

---

## Yêu cầu

1. Thêm Google OAuth 2.0 login (NextAuth GoogleProvider)
2. Chỉ cho phép email nằm trong `GOOGLE_ALLOWED_EMAILS` đăng nhập bằng Google
3. Login page luôn hiển thị nút "Sign in with Google"
4. Form username/password chỉ hiển thị khi `ADMIN_ENABLE=1`
5. Không cần file riêng — tất cả config trong `.env.local`

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `lib/auth.ts` | Thêm `GoogleProvider` + `signIn` callback allowlist |
| `components/auth/LoginForm.tsx` | **Tạo mới** — Client Component với Google button + conditional credentials form |
| `app/(auth)/login/page.tsx` | Đổi thành Server Component wrapper, đọc `ADMIN_ENABLE` từ env |

---

## Cấu trúc mới

### `lib/auth.ts`

```typescript
providers: [
  GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
  CredentialsProvider({ ... }), // giữ nguyên
],
callbacks: {
  async signIn({ account, profile }) {
    if (account?.provider === "google") {
      const allowed = (process.env.GOOGLE_ALLOWED_EMAILS ?? "")
        .split(",").map(e => e.trim()).filter(Boolean);
      return allowed.includes(profile?.email ?? "");
    }
    return true; // credentials tự xử lý
  },
  // jwt + session callbacks giữ nguyên (activeAccountId)
}
```

### `app/(auth)/login/page.tsx` — Server Component

```typescript
export default function LoginPage() {
  const adminEnabled = process.env.ADMIN_ENABLE === "1";
  return <LoginForm adminEnabled={adminEnabled} />;
}
```

Đọc `ADMIN_ENABLE` server-side → không expose env var ra client.

### `components/auth/LoginForm.tsx` — Client Component

- Google button: luôn hiển thị, gọi `signIn("google", { callbackUrl: "/" })`
- Divider + credentials form: render có điều kiện theo prop `adminEnabled`

---

## Env vars

```env
# Google OAuth
GOOGLE_CLIENT_ID=           # từ Google Cloud Console
GOOGLE_CLIENT_SECRET=       # từ Google Cloud Console
GOOGLE_ALLOWED_EMAILS=user1@gmail.com,user2@company.com   # comma-separated, không space

# Admin login control
ADMIN_ENABLE=1              # 1 = hiển thị form email/password | 0 hoặc không set = ẩn
ADMIN_EMAIL=                # giữ nguyên
ADMIN_PASSWORD=             # giữ nguyên
```

### Setup Google OAuth

1. Vào [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Tạo OAuth 2.0 Client ID (Web application)
3. Thêm Authorized redirect URI: `https://yourdomain.com/api/auth/callback/google`
4. Copy Client ID + Client Secret vào `.env.local`

---

## Security

- Allowlist enforce ở server-side trong `signIn` callback — không phụ thuộc UI
- `ADMIN_ENABLE` đọc server-side trong Server Component — không expose ra client
- Private key ASC không liên quan đến flow auth này
- Google user và admin user có quyền ngang nhau sau khi login

---

## Decision Log

| Quyết định | Lý do |
|---|---|
| `GOOGLE_ALLOWED_EMAILS` env var | Đơn giản, không cần DB, phù hợp team nhỏ |
| Server Component wrapper cho login page | Đọc `ADMIN_ENABLE` server-side, không cần `NEXT_PUBLIC_` prefix |
| Tách `LoginForm` thành Client Component | Server Component không dùng hooks/state |
| `signIn` callback enforce allowlist | Block ở NextAuth level, không phụ thuộc UI |
| Giữ tất cả trong `.env.local` | Không cần file riêng, đơn giản nhất |
