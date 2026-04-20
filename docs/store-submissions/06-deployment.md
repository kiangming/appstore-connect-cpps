# Tech Design Deep-Dive — Deployment, Observability & Phasing

**Scope:** Infrastructure setup, CI/CD, monitoring, phased rollout plan
**Prerequisite:** Sections 01-05 đã chốt

Chia 3 Part:
- **Part A — Deployment**: Railway + Supabase setup, env vars, CI/CD
- **Part B — Observability**: Sentry, logging, health checks, alerts
- **Part C — Phasing Plan**: MVP scope → v1.1 → v2 roadmap

---

# PART A — Deployment

## A.1. Architecture recap

```
Internet
   │
   ▼
Railway (1 project: store-management)
   ├── web service                      → Next.js 14 app
   │   ├── runtime: Node 20             
   │   ├── build: next build            
   │   └── start: next start
   │
   └── cron service                     → Railway Cron (scheduled HTTP)
       ├── */5 * * * * → /api/sync/gmail
       ├── 0 3 * * *   → /api/cleanup/emails
       └── 0 4 * * 0   → /api/health/gmail
                │
                └── tất cả POST với header X-Cron-Secret

External services:
   ├── Supabase (Singapore region)      → PostgreSQL + Storage + Auth adapter
   ├── Sentry                           → error tracking
   └── Google Cloud Console             → OAuth client (Gmail + SSO)
```

**Single deployment region**: Railway (Singapore hoặc nearest Asia) + Supabase (Singapore). Latency DB ≤ 10ms.

## A.2. Railway services setup

### A.2.1. Web service

**Project**: `store-management`
**Service name**: `web`
**Source**: GitHub repo connected, branch `main`, auto-deploy on push

**Build config**:
```
Build command:    npm ci && npm run build
Start command:    npm start
Watch paths:      (default - all)
Root directory:   /  (monorepo option: /apps/web)
```

**Resources**:
- Memory: 512MB (starter), upgrade 1GB nếu build fail hoặc OOM
- CPU: Shared (starter OK)
- Replicas: 1 (scale lên khi > 5 người concurrent)

**Network**:
- Public domain: Railway auto-provision `{service}-{hash}.up.railway.app`
- Custom domain (optional): `store.yourcompany.com` — cần DNS CNAME + Railway verify
- SSL: auto via Railway (Let's Encrypt)

**Health check** Railway config:
- Path: `/api/health/sync`
- Port: 3000
- Interval: 60s
- Timeout: 10s

### A.2.2. Cron service

**Service name**: `cron`
**Type**: Railway Cron (scheduled HTTP trigger)

**Cron jobs** (add via Railway UI hoặc railway.json):

```json
// railway.json (in repo root)
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Railway Cron UI setup:
```
Name: gmail-sync
Schedule: */5 * * * *
Command: curl -X POST $RAILWAY_WEB_URL/api/sync/gmail -H "X-Cron-Secret: $CRON_SECRET"
Timeout: 60s

Name: email-cleanup
Schedule: 0 3 * * *
Command: curl -X POST $RAILWAY_WEB_URL/api/cleanup/emails -H "X-Cron-Secret: $CRON_SECRET"
Timeout: 300s

Name: gmail-health-check
Schedule: 0 4 * * 0
Command: curl -X POST $RAILWAY_WEB_URL/api/health/gmail -H "X-Cron-Secret: $CRON_SECRET"
Timeout: 30s
```

Cron timezone trên Railway: **UTC**. Convert GMT+7 → UTC khi design schedule:
- 3h sáng GMT+7 = 20:00 UTC (hôm trước) → `0 20 * * *`
- 4h sáng Chủ Nhật GMT+7 = 21:00 UTC thứ Bảy → `0 21 * * 6`

Final:
```
*/5 * * * *    gmail-sync            (every 5 min, any TZ)
0 20 * * *     email-cleanup         (3am GMT+7 daily)
0 21 * * 6     gmail-health-check    (4am Sunday GMT+7)
```

## A.3. Supabase project setup

### A.3.1. Project creation

1. Sign up Supabase → create organization
2. Create project:
   - Name: `store-management-prod`
   - Region: **Southeast Asia (Singapore)** — closest to VN
   - Tier: **Free** (start here, monitor usage)
3. Note down:
   - Project URL: `https://{project-ref}.supabase.co`
   - Service role key (secret, for backend)
   - Anon key (public, for potential Realtime client)

### A.3.2. Database setup

```bash
# Local dev
npm install -g supabase
supabase login
supabase link --project-ref {project-ref}

# Apply migrations
supabase db push  # apply all files trong supabase/migrations/
```

**Connection string format**:
```
postgresql://postgres.{project-ref}:{password}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```

**Connection pooling mode**:
- **Transaction mode** (port 6543): Next.js serverless - default
- Session mode (port 5432): chỉ khi cần `SET` hoặc prepared statements

### A.3.3. Storage buckets

Tạo 1 bucket `ticket-attachments` cho reject reason screenshots + comment attachments:

```sql
-- SQL in Supabase SQL editor
INSERT INTO storage.buckets (id, name, public)
VALUES ('ticket-attachments', 'ticket-attachments', false);  -- private

-- RLS policy (khi RLS enabled in phase 2)
CREATE POLICY "Authenticated read attachments" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'ticket-attachments');

CREATE POLICY "Authenticated upload attachments" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ticket-attachments');
```

MVP: backend dùng service role key → bypass policies. File path convention: `ticket-attachments/{ticket_id}/{filename_uuid}.{ext}`.

### A.3.4. Tier sizing

**Free tier** (MVP start):
- 500 MB database
- 1 GB file storage
- 2 GB bandwidth
- 50k monthly active users (anon + authenticated)
- 500K Edge Function invocations
- No PITR (point-in-time recovery)

**Pro tier** ($25/month) — upgrade khi:
- DB size > 400 MB (80% quota)
- Cần PITR 7-day cho backup
- Cần guaranteed uptime SLA

**Estimate timeline**: 12-18 tháng free tier cho 5 người + 50 apps + 2k email/month.

## A.4. Environment variables

Complete list cần set trong Railway cho web service:

```bash
# === Database ===
DATABASE_URL=postgresql://...pooler.supabase.com:6543/postgres?pgbouncer=true
SUPABASE_URL=https://{project-ref}.supabase.co
SUPABASE_ANON_KEY=eyJ...                          # public OK
SUPABASE_SERVICE_KEY=eyJ...                       # secret, bypass RLS

# === NextAuth ===
NEXTAUTH_URL=https://store.yourcompany.com        # production URL
NEXTAUTH_SECRET={32-byte hex}                     # `openssl rand -hex 32`

# === Google OAuth (cho cả app login + Gmail connect) ===
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
GOOGLE_HOSTED_DOMAIN=yourcompany.com              # restrict login to company domain

# === Cron ===
CRON_SECRET={24-byte hex}                         # `openssl rand -hex 24`

# === Gmail token encryption ===
GMAIL_ENCRYPTION_KEY={32-byte hex}                # `openssl rand -hex 32`
                                                   # NEVER rotate in production

# === Sentry ===
SENTRY_DSN=https://...@sentry.io/...
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=${RAILWAY_GIT_COMMIT_SHA}          # auto-inject by Railway

# === App config ===
APP_ENV=production
APP_TIMEZONE=Asia/Ho_Chi_Minh
INITIAL_MANAGER_EMAIL=manager@yourcompany.com     # seed user on first deploy
LOG_LEVEL=info

# === Optional / phase 2 ===
UPSTASH_REDIS_URL=                                # khi cần rate limiting
SLACK_WEBHOOK_URL=                                # v1.1 notification
```

**Generate secrets**:
```bash
# NEXTAUTH_SECRET, GMAIL_ENCRYPTION_KEY
openssl rand -hex 32

# CRON_SECRET
openssl rand -hex 24
```

**Env vars cho cron service**: chỉ cần `CRON_SECRET` + `RAILWAY_WEB_URL` (auto từ Railway).

**GitHub Actions cần** (secrets trong repo):
- `RAILWAY_TOKEN` — deploy trigger
- `SUPABASE_ACCESS_TOKEN` — migration apply
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_REF`
- `SENTRY_AUTH_TOKEN` — upload source maps

## A.5. Google Cloud setup (OAuth)

1. Create GCP project: `store-management`
2. APIs & Services → Enable:
   - Gmail API
   - Google+ API (for profile info)
3. OAuth consent screen:
   - User type: **Internal** (restrict to workspace domain)
   - Scopes: 
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
     - `https://www.googleapis.com/auth/gmail.modify`
4. Credentials → Create OAuth Client ID:
   - Type: Web application
   - Authorized redirect URIs:
     - `https://store.yourcompany.com/api/auth/callback/google` (NextAuth login)
     - `https://store.yourcompany.com/api/store-submissions/gmail/callback` (Gmail connect)
     - `http://localhost:3000/api/auth/callback/google` (dev login)
     - `http://localhost:3000/api/store-submissions/gmail/callback` (dev Gmail connect)
5. Copy Client ID + Secret → Railway env vars

**Note**: `Internal` user type skip verification (không cần Google review). Chỉ cho phép user thuộc workspace domain login.

## A.6. CI/CD workflow

GitHub Actions `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
  
  migrate-db:
    needs: lint-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
      - run: supabase db push
        env:
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  
  deploy-railway:
    needs: migrate-db
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Railway
        run: |
          npm i -g @railway/cli
          railway up --service web --detach
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
  
  upload-sourcemaps:
    needs: deploy-railway
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: getsentry/action-release@v1
        env:
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
          SENTRY_ORG: your-org
          SENTRY_PROJECT: store-management
        with:
          environment: production
          sourcemaps: '.next/static/chunks'
```

**Key guarantees**:
- PR branch: lint + test only, không deploy
- Main push: lint+test → migrate DB → deploy app → upload source maps
- Nếu migrate fail → deploy không chạy → web service vẫn serving version cũ
- Nếu deploy fail → DB đã migrated (schema forward-compatible). Rollback = revert code PR.

## A.7. Database migrations workflow

**File layout**:
```
supabase/
├── config.toml
└── migrations/
    ├── 20260101000000_init_schema.sql        (Section 01)
    ├── 20260101000100_seed_platforms.sql
    ├── 20260101000200_seed_apple_rules.sql
    ├── 20260101000300_seed_initial_manager.sql
    ├── 20260102000000_add_dropped_status.sql (Section 03 update)
    └── 20260201000000_...
```

**Creating new migration locally**:
```bash
supabase migration new add_notifications_table
# Edit the generated file
supabase db reset  # re-apply all migrations locally
supabase db diff   # verify schema matches
```

**Forward-only rule**: KHÔNG viết down migrations. Nếu cần revert → viết migration mới undo.

**Staged deploy cho breaking changes**:
1. **Step 1**: Deploy code tương thích cả old + new schema → merge
2. **Step 2**: Apply migration thêm columns mới (additive) → merge
3. **Step 3**: Deploy code dùng new schema only → merge
4. **Step 4** (optional, sau khi verify stable): Apply cleanup migration (drop old columns)

## A.8. Initial bootstrap runbook

Lần đầu deploy prod, thứ tự thực hiện:

```
[x] 1. Create Supabase project (region Singapore)
    - Note project-ref, service key, anon key

[x] 2. Create Railway project 'store-management'
    - Connect GitHub repo
    - Add 'web' service (from repo)
    - Add 'cron' service (empty Node runtime)

[x] 3. Create Google Cloud OAuth client
    - Save Client ID + Secret
    - Set Authorized redirect URIs (production)

[x] 4. Generate secrets locally:
    openssl rand -hex 32  # NEXTAUTH_SECRET
    openssl rand -hex 32  # GMAIL_ENCRYPTION_KEY
    openssl rand -hex 24  # CRON_SECRET

[x] 5. Set all env vars in Railway web service
    - Connection string
    - Google OAuth credentials
    - All 3 secrets
    - INITIAL_MANAGER_EMAIL=<manager email>

[x] 6. Set env vars in Railway cron service
    - CRON_SECRET (same as web)
    - RAILWAY_WEB_URL (auto)

[x] 7. Apply migrations qua CI first deploy:
    git push origin main → GitHub Actions:
      - Supabase db push (runs all migrations + seeds)
      - Railway deploy (starts web service)
    
    Alternatively, manual first run:
    supabase link --project-ref ...
    supabase db push

[x] 8. Add Railway Cron schedules:
    - gmail-sync (*/5 * * * *)
    - email-cleanup (0 20 * * *)
    - gmail-health-check (0 21 * * 6)

[x] 9. Verify web service healthy:
    curl https://store.yourcompany.com/api/health/sync
    # Expected: 503 STALE (chưa có Gmail sync)

[x] 10. Manager login lần đầu:
    Browser → https://store.yourcompany.com/login
    - Sign in with Google (manager email)
    - Should match INITIAL_MANAGER_EMAIL row trong users table
    - Role = MANAGER

[x] 11. Manager connect Gmail:
    Settings → Connect Gmail → OAuth flow
    - Verify gmail_credentials row tồn tại sau callback

[x] 12. Trigger manual sync:
    Settings → "Sync now" button
    OR: curl POST /api/sync/gmail
    - Expected: labels created on Gmail, few emails classified

[x] 13. Add initial apps qua CSV import:
    Config → App Registry → Import CSV
    - Upload file (xem app-registry-template.csv)

[x] 14. Manager add team members:
    Config → Team → Add email + role
    - Dev members login được sau khi add

[x] 15. Setup Sentry:
    - Create Sentry project 'store-management'
    - Copy DSN → Railway env
    - Test error capture: trigger 1 test error

[x] 16. Setup UptimeRobot (free tier):
    - Monitor GET https://store.yourcompany.com/api/health/sync
    - Alert Manager khi DOWN 5 phút

[x] 17. Smoke test end-to-end:
    - Wait 5 phút, verify cron ran (Railway logs)
    - Check sync_logs table có rows
    - Check emails classified trong Inbox
    - Dev archive 1 ticket, verify flow
```

## A.9. Rollback procedures

### A.9.1. Code rollback (fast)

**Railway 1-click**: Service → Deployments → pick previous → Redeploy.

Trả về code version cũ trong 1-2 phút. DB không ảnh hưởng.

### A.9.2. Migration rollback (slower, dangerous)

Không có down migrations. Procedure:
1. Identify bad migration (vd `20260201_bad_migration.sql`)
2. Viết migration mới reverse changes: `20260201000100_revert_bad_migration.sql`
3. Deploy migration mới via CI
4. Nếu data đã corrupted không recoverable → restore từ Supabase Backup/PITR

**Prevent**: thorough testing trên Supabase staging branch trước khi merge.

### A.9.3. Data corruption / wrong Gmail sync

Nếu Gmail sync tạo tickets sai (vd regex bug):
1. Pause polling: Settings → toggle `gmail_polling_enabled = false`
2. Investigate trong Sentry + sync_logs
3. Fix bug → deploy
4. Clean up wrong tickets qua SQL (manual):
   ```sql
   DELETE FROM ticket_entries WHERE created_at > '...';
   DELETE FROM tickets WHERE created_at > '...';
   DELETE FROM email_messages WHERE classification_status='ERROR' AND created_at > '...';
   ```
5. Reset `gmail_sync_state.last_history_id = NULL` → force fallback sync
6. Re-enable polling
7. Gmail labels trên các email wrong → cần manual cleanup trong Gmail UI (add script `/api/admin/reset-labels` nếu volume lớn)

---

# PART B — Observability

## B.1. Sentry setup

### B.1.1. Installation

```bash
npm install @sentry/nextjs
npx @sentry/wizard@latest -i nextjs
```

Wizard creates:
- `sentry.server.config.ts`
- `sentry.edge.config.ts`  
- `sentry.client.config.ts`
- `next.config.js` wrapped với `withSentryConfig`

Config:
```typescript
// sentry.server.config.ts
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate: 0.1,  // 10% traces sampled
  profilesSampleRate: 0,  // disabled for MVP
  ignoreErrors: [
    'NEXT_REDIRECT',
    'NEXT_NOT_FOUND',
  ],
  beforeSend(event) {
    // Don't send in local dev
    if (process.env.APP_ENV !== 'production') return null;
    return event;
  },
});
```

### B.1.2. Usage patterns

**API Route**:
```typescript
export async function POST(req: NextRequest) {
  try {
    // ... handler
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: '/api/sync/gmail' },
      extra: { requestHeaders: Object.fromEntries(req.headers) },
    });
    throw err;
  }
}
```

**Cron endpoint** (critical):
```typescript
// lib/gmail/sync.ts
export async function runSync(options: SyncOptions) {
  const transaction = Sentry.startTransaction({ name: 'gmail-sync' });
  try {
    // ... sync logic
    transaction.setStatus('ok');
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'gmail-sync', mode: currentMode },
      extra: { state: syncState },
    });
    transaction.setStatus('internal_error');
    throw err;
  } finally {
    transaction.finish();
  }
}
```

**Client-side errors**:
Auto-capture qua wrapper. React Error Boundaries tự send errors.

### B.1.3. Alerts config

Sentry UI → Alerts → create:

| Alert name | Condition | Action |
|---|---|---|
| **Cron failure** | Error in `/api/sync/gmail` OR `/api/cleanup/emails` | Email Manager immediate |
| **Gmail disconnected** | Error tag `type=gmail_token_expired` | Email Manager immediate |
| **Error rate spike** | > 10 errors in 5 min | Email Manager |
| **Unclassified surge** | Custom metric `unclassified_pct > 30%` trong 1 hour | Email Manager (rule drift) |

**Free tier Sentry**: 5k errors/month. Với scale hiện tại (vài error/tuần lý tưởng) → đủ cho 1-2 năm.

## B.2. Structured logging

Console.log → Railway captured logs tự động. Format structured JSON để query sau:

```typescript
// lib/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, data?: Record<string, any>) {
  const threshold: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = threshold[process.env.LOG_LEVEL as LogLevel ?? 'info'];
  if (threshold[level] < currentLevel) return;

  const entry = {
    level,
    ts: new Date().toISOString(),
    event,
    ...data,
  };
  
  // stringify để Railway log shipper (nếu có) parse được
  console.log(JSON.stringify(entry));
}

// Usage
log('info', 'sync.started', { mode: 'INCREMENTAL', batch_size: 50 });
log('error', 'ticket.create_failed', { email_id, error: err.message });
```

**Sampling**: `debug` level off in production. `info` cho milestone events. `warn`/`error` cho anomalies.

## B.3. Health check endpoints

3 endpoints:

### B.3.1. Public health — `/api/health/sync`

```typescript
export async function GET() {
  const state = await db.gmail_sync_state.findUnique({ where: { id: 1 } });
  const now = Date.now();
  const lastSync = state?.last_synced_at?.getTime() ?? 0;
  const staleMs = now - lastSync;
  
  const status = staleMs > 15 * 60 * 1000 ? 'STALE' : 'OK';
  const httpStatus = status === 'OK' ? 200 : 503;

  return NextResponse.json(
    {
      status,
      last_synced_at: state?.last_synced_at,
      stale_minutes: Math.floor(staleMs / 60_000),
      consecutive_failures: state?.consecutive_failures ?? 0,
    },
    { status: httpStatus }
  );
}
```

Dùng cho UptimeRobot + Railway health check.

### B.3.2. Internal health — `/api/health/gmail`

Cron weekly. Verify historyId chưa expire:

```typescript
export async function POST(req: NextRequest) {
  if (req.headers.get('X-Cron-Secret') !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  
  const creds = await loadGmailCredentials();
  if (!creds) return NextResponse.json({ status: 'NOT_CONNECTED' });
  
  const gmail = await createGmailClient(creds);
  const state = await loadSyncState();
  
  try {
    // Probe history.list để test historyId valid
    await gmail.users.history.list({
      userId: 'me',
      startHistoryId: state.last_history_id,
      maxResults: 1,
    });
    return NextResponse.json({ status: 'OK' });
  } catch (err) {
    if (err.code === 404) {
      // HistoryId expired, force fallback next run
      await db.gmail_sync_state.update({
        where: { id: 1 },
        data: { last_history_id: null },
      });
      Sentry.captureMessage('Gmail historyId expired, forcing fallback', { level: 'warning' });
      return NextResponse.json({ status: 'EXPIRED_TRIGGERED_FALLBACK' });
    }
    throw err;
  }
}
```

### B.3.3. Deep health — `/api/health/deep` (optional)

Check DB connectivity, Gmail token validity, recent sync success. Trả detailed info cho admin page.

## B.4. Operational dashboards

### B.4.1. Build-in SQL queries

Không invest vào BI tool cho MVP. Query trực tiếp Supabase SQL editor hoặc tạo `/admin/metrics` page:

```sql
-- Sync health last 24h
SELECT 
  date_trunc('hour', ran_at) as hour,
  COUNT(*) as runs,
  SUM(emails_fetched) as fetched,
  SUM(emails_classified) as classified,
  SUM(emails_unclassified) as unclassified,
  SUM(emails_errored) as errored,
  AVG(duration_ms)::int as avg_ms,
  MAX(duration_ms) as max_ms
FROM sync_logs
WHERE ran_at > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY 1 DESC;

-- Classification success rate 7 days
SELECT 
  SUM(emails_classified) * 100.0 / NULLIF(SUM(emails_fetched), 0) as pct_classified,
  SUM(emails_unclassified) * 100.0 / NULLIF(SUM(emails_fetched), 0) as pct_unclassified,
  SUM(emails_errored) * 100.0 / NULLIF(SUM(emails_fetched), 0) as pct_errored
FROM sync_logs
WHERE ran_at > NOW() - INTERVAL '7 days';

-- Tickets by state (for ops)
SELECT state, COUNT(*) FROM tickets GROUP BY state ORDER BY 2 DESC;

-- Recent ticket activity
SELECT 
  t.display_id, t.state, t.latest_outcome,
  a.name as app, ty.name as type, p.display_name as platform,
  t.updated_at
FROM tickets t
LEFT JOIN apps a ON a.id = t.app_id
LEFT JOIN types ty ON ty.id = t.type_id
JOIN platforms p ON p.id = t.platform_id
ORDER BY t.updated_at DESC
LIMIT 50;

-- Storage usage
SELECT 
  pg_size_pretty(pg_total_relation_size('email_messages')) as email_msg_size,
  pg_size_pretty(pg_total_relation_size('ticket_entries')) as entries_size,
  pg_size_pretty(pg_database_size(current_database())) as total_db_size;
```

### B.4.2. Admin metrics page

`/config/admin/metrics` (MANAGER only) hiện realtime metrics. Simple Server Component fetch + render:

```typescript
// app/(app)/config/admin/metrics/page.tsx
export default async function MetricsPage() {
  const session = await requireRole('MANAGER');
  const [syncStats, ticketStats, dbSize] = await Promise.all([
    getSyncStats24h(),
    getTicketStatsByState(),
    getDatabaseSize(),
  ]);
  
  return (
    <div>
      <KPICards stats={syncStats} />
      <StatePieChart stats={ticketStats} />
      <DbSizeWarning size={dbSize} />
    </div>
  );
}
```

Refresh rate: on page load + manual refresh button. Không realtime (overhead).

## B.5. UptimeRobot setup (free tier)

1. Sign up UptimeRobot (free: 50 monitors, 5-min interval)
2. Create monitor:
   - Type: HTTPS
   - URL: `https://store.yourcompany.com/api/health/sync`
   - Interval: 5 min
   - Keyword: `"status":"OK"` (expect in response)
3. Alert contacts: Manager email, Dev email
4. Alert when: Down (or keyword not found) for 2 consecutive checks → 10min delay avoid noise

---

# PART C — Phasing Plan

## C.1. MVP scope & timeline

**Duration**: 4-6 tuần (1 dev full-time hoặc 2 dev part-time)

**Week 1-2 — Foundation**:
- [ ] Setup Railway + Supabase + Google OAuth
- [ ] Migrations: schema + seed platforms + seed Apple rules
- [ ] NextAuth + whitelist login + Team page CRUD
- [ ] App Registry: CRUD + CSV import/export + auto-alias + rename flow
- [ ] Email Rules config UI: per-platform tabs, senders/patterns/types
- [ ] RE2 integration + rule test endpoint

**Week 3 — Backend core**:
- [ ] Gmail OAuth connect flow
- [ ] Gmail Sync: history.list + fallback + labels + MIME parser
- [ ] Email Rule Engine: full classifier với trace output
- [ ] Ticket Engine: find-or-create, state machine, event log
- [ ] Reclassify (merge on conflict) logic
- [ ] Cron endpoints + advisory lock
- [ ] Email cleanup cron

**Week 4 — Frontend UI**:
- [ ] Inbox: list + 2 unclassified buckets + filters + keyboard shortcuts
- [ ] Follow-Up: cards + assign + priority
- [ ] Submissions: per-app cards với type/platform rows
- [ ] Reports: KPI + charts (platform, type, reject reasons, by-app)
- [ ] Ticket drawer: thread + reply + comment edit + reject reason + add/remove attachments

**Week 5 — Polish + QA**:
- [ ] Rule versioning + rollback UI
- [ ] Error tab trong Email Rules (unclassified + errors)
- [ ] Bulk operations (archive/follow-up)
- [ ] Settings page + manual sync button + cleanup trigger
- [ ] Full test suite (unit + integration + contract)
- [ ] Security audit: env vars, RLS readiness, secrets handling

**Week 6 — Deploy + onboarding**:
- [ ] Deploy prod + initial bootstrap runbook
- [ ] Sentry + UptimeRobot setup
- [ ] Load initial apps via CSV
- [ ] Connect Gmail shared mailbox
- [ ] Onboard team (3-5 users) + training doc
- [ ] Monitor first week actively, fix edge cases

**MVP feature matrix**:
| Feature | MVP | v1.1 | v2 |
|---|---|---|---|
| Gmail sync (polling) | ✅ | | |
| Email classification engine | ✅ | | |
| Ticket state machine | ✅ | | |
| 6 UI modules | ✅ | | |
| Role-based access (3 roles) | ✅ | | |
| CSV import/export Apps | ✅ | | |
| Rule versioning + rollback | ✅ | | |
| Email retention cleanup | ✅ | | |
| Whitelist user management | ✅ | | |
| In-app notifications badge | ✅ | | |
| Historical Excel import | | ✅ | |
| Slack/Discord webhooks | | ✅ | |
| Saved filter views | | ✅ | |
| App icon upload | | ✅ | |
| Realtime subscription (Supabase) | | ✅ | |
| Real-time Gmail push (Pub/Sub) | | | ✅ |
| AI reject reason categorization | | | ✅ |
| Multi-mailbox | | | ✅ |
| Mobile optimization | | | ✅ |
| Multi-tenant | | | ✅ |

## C.2. v1.1 scope (2-3 tuần sau launch)

Trigger: sau khi MVP run 1 tháng stable + user feedback.

**Historical Excel migration**:
- Upload Excel format cũ của team
- Map columns → fields
- Bulk create ticket với state=APPROVED (assume resolved) hoặc state=DONE
- Giữ display_id pattern consistent (có thể có gap)

**Slack/Discord notifications**:
- Setting page: add webhook URL + select events
- Events: ticket REJECTED created, assignment, mention in comment
- Batched (nếu > 5 events/min, gửi digest)

**Saved filter views**:
- User bookmark filter combination (vd "High priority rejected Apple")
- Shared views (Manager create cho cả team) vs personal
- Quick access từ sidebar

**App icon upload**:
- Upload file → Supabase Storage
- Resize server-side (sharp library)
- URL lưu trong `apps.icon_url`

**Realtime subscription**:
- Opt-in trong Settings
- Inbox auto-update khi ticket mới về (không cần refresh)
- Ticket count badge update realtime

**Improvements từ user feedback** (ước tính):
- Additional Apple subject patterns (wording variations)
- Google Play rules (sender + patterns + types)
- Facebook Instant Games rules
- UI polish dựa feedback thực tế

## C.3. v2 triggers & scope

**Triggers to consider v2**:
- Email volume > 5k/month
- Apps tracked > 30
- Team size > 10 người
- Specific feature requests không thể fit v1.1

**v2 candidates**:

**Real-time Gmail push** (Pub/Sub webhook):
- Setup Google Cloud Pub/Sub topic
- `users.watch` với labelId=INBOX
- Webhook endpoint `/api/webhooks/gmail` với Pub/Sub JWT verification
- Renew `watch` mỗi 7 ngày via cron
- **Benefit**: latency 5 phút → vài giây
- **Cost**: Pub/Sub fees (nhỏ), setup complexity cao

**AI reject reason categorization**:
- OpenAI/Anthropic API classify reject_reason text thành category (Metadata/Guideline/Crash/...)
- Dashboard hiện breakdown theo category tự động
- **Cost**: API fees per categorization

**Multi-mailbox support**:
- Nhiều Gmail accounts cho scale team lớn
- Conflict resolution khi email duplicate
- Per-mailbox rules có thể khác

**Mobile optimization**:
- Responsive redesign cho touch
- PWA manifest (install as app)
- Push notifications qua service worker

**Multi-tenant**:
- Multiple orgs trong 1 deployment
- Tách data per-org (schema per-tenant hoặc shared với org_id column)
- SSO có thể từ nhiều workspace khác nhau
- Pricing model (nếu sell ra ngoài)

## C.4. Launch checklist

Trước khi invite team vào dùng prod:

**Functional**:
- [ ] Gmail sync chạy 24h không có error
- [ ] 5 email samples của team được classify đúng (manually verify)
- [ ] Unclassified flow test: email lạ → Inbox bucket → user resolve
- [ ] Archive + Follow Up + Mark Done flow test
- [ ] CSV import 10+ apps thành công
- [ ] Rule edit + rollback test
- [ ] Retention cleanup chạy 1 lần test (set days=0 trên email cũ)

**Security**:
- [ ] Env vars: không có secret nào commit vào git
- [ ] `.env.local` trong `.gitignore`
- [ ] HTTPS forced (Railway default OK)
- [ ] Google SSO restrict to workspace domain (hd parameter)
- [ ] Sentry không capture PII (email addresses OK, content nên scrub)
- [ ] Gmail token encryption verify (decrypt test OK)

**Performance**:
- [ ] Inbox load < 2s với 1000 tickets
- [ ] Ticket drawer load < 1s
- [ ] Reports page render < 3s cho 30-day range
- [ ] Sync duration < 30s average

**Monitoring**:
- [ ] Sentry receiving events (trigger test error)
- [ ] UptimeRobot monitoring active
- [ ] Railway logs accessible
- [ ] At least 1 admin có thể login Supabase SQL editor khẩn

**Documentation**:
- [ ] User guide cho Dev: how to triage, use keyboard shortcuts
- [ ] Admin guide: add user, edit rules, export reports
- [ ] Runbook: Gmail disconnect, rule drift, bulk cleanup
- [ ] Architecture diagram cho onboarding new dev

## C.5. Post-launch operating rhythm

**Daily**:
- Manager check Inbox (part of job)
- Implicit monitoring: nếu sync fail, UptimeRobot alert

**Weekly**:
- Review Sentry errors (15 phút)
- Check sync_logs metrics: classification rate, duration (10 phút)
- Review unclassified bucket: add aliases/patterns nếu cần

**Monthly**:
- Supabase usage review: storage, connections (5 phút)
- Team retrospective: feedback → backlog v1.1
- Gmail quota check (rarely issue)

**Quarterly**:
- Security review: dependencies update (npm audit)
- Review retention policy, cleanup old data
- Sentry + UptimeRobot quota vs tier

---

## Kết luận

**Stack operational hoàn chỉnh**:
- Railway single prod env với web + cron services
- Supabase Singapore: DB + Storage + (future) Realtime + Auth adapter
- GitHub Actions CI/CD: lint → test → migrate → deploy → source maps
- Sentry + UptimeRobot cho observability (free tier đủ)
- SQL-based ops dashboard, không cần BI tool MVP

**Deploy trong 4-6 tuần** với 1 dev full-time, 6-9 tuần với 2 dev part-time.

**v1.1 priorities** từ user feedback: Excel migration, Slack notifications, saved filters.

**v2 trigger**: volume/team scale > 2x MVP → consider real-time push, AI features, multi-tenant.

---

## Document set complete

Bạn giờ có đủ document set để triển khai:

1. `business-analysis.md` — Business requirements đầy đủ
2. `mockup.html` — Visual reference cho UI
3. `app-registry-template.csv` — CSV format mẫu
4. `tech-design.md` — Tech stack skeleton + overall architecture
5. `tech-design-01-data-model.md` — Schema SQL, migrations, RLS strategy
6. `tech-design-02-gmail-sync.md` — Sync pipeline implementation
7. `tech-design-03-email-rule-engine.md` — Classifier pure function + RE2
8. `tech-design-04-ticket-engine.md` — State machine + transactional logic
9. `tech-design-05-api-frontend.md` — Server Actions + Next.js App Router
10. `tech-design-06-deployment-observability.md` — (this doc)

Developer có thể start implementing từ section 01 (schema) + section 03 (Apple rules seed) rồi build outward. Dev 2 có thể parallel làm frontend scaffolding (section 05) với Mock data trong lúc backend build.
