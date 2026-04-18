# Patch: .env.example — thêm env vars cho Store Management

**File**: `.env.example`

## Change

Append vào cuối file:

```env
# ============================================================
# Store Management module
# ============================================================

# Cron endpoints auth (cho Railway cron hit /api/store-submissions/*)
# Generate: openssl rand -hex 24
CRON_SECRET=

# Gmail token encryption (AES-256-GCM)
# Generate: openssl rand -hex 32
# ⚠ WARNING: NEVER rotate in production — rotate sẽ làm hỏng tất cả stored tokens
GMAIL_ENCRYPTION_KEY=

# Sentry error tracking (Store Management uses this; CPP optional)
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=

# Initial Manager cho Store Management whitelist (seed lần đầu deploy)
STORE_INITIAL_MANAGER_EMAIL=yourname@yourcompany.com

# Timezone (fixed cho Store Management UI + cron schedules)
APP_TIMEZONE=Asia/Ho_Chi_Minh

# Log level
LOG_LEVEL=info
```

## Also update `.env.local` (developer local setup)

Generate secrets:
```bash
echo "CRON_SECRET=$(openssl rand -hex 24)" >> .env.local
echo "GMAIL_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env.local
echo "STORE_INITIAL_MANAGER_EMAIL=your.email@company.com" >> .env.local
echo "APP_TIMEZONE=Asia/Ho_Chi_Minh" >> .env.local
echo "LOG_LEVEL=debug" >> .env.local
```

**Sentry DSN**: chỉ set trong production. Dev mode để trống sẽ skip Sentry init.

## Google OAuth scope update

**Important**: `GOOGLE_CLIENT_ID` hiện tại của CPP Manager cần **thêm scope `gmail.modify`** cho Store Management's Gmail OAuth flow:

1. Vào Google Cloud Console → OAuth consent screen
2. Add scope: `https://www.googleapis.com/auth/gmail.modify`
3. Test với Internal users (không cần Google verification)

Scope này chỉ activate khi Store Manager connect Gmail (Settings page của Store Module), KHÔNG ảnh hưởng login flow thông thường.
