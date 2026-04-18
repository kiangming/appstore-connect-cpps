# Railway Cron Service Setup

Store Management cần 3 cron jobs. Cách thiết lập trên Railway project hiện tại của CPP Manager.

---

## Overview

Railway project đã có `web` service (Next.js app). Thêm **1 service mới** `cron-store` để trigger các endpoint của Store Management theo schedule.

```
Railway Project: internal-tools
├── web                          ← existing Next.js app (serves CPP + Store)
└── cron-store                   ← NEW: cron scheduler for Store Management
    ├── */5 * * * *              → POST /api/store-submissions/sync/gmail
    ├── 0 20 * * *               → POST /api/store-submissions/cleanup/emails
    └── 0 21 * * 6               → POST /api/store-submissions/health/gmail
```

**Lưu ý timezone**: Railway Cron chạy UTC. Convert từ GMT+7:
- 3h sáng GMT+7 = 20:00 UTC (hôm trước) → `0 20 * * *`
- 4h sáng Chủ Nhật GMT+7 = 21:00 UTC thứ Bảy → `0 21 * * 6`

---

## Setup steps

### Bước 1 — Tạo cron service mới

Trong Railway dashboard → project → **New Service** → **Empty Service**.

- Service name: `cron-store`
- Không cần repo deploy (dùng Railway Cron Job feature)

### Bước 2 — Config Cron Jobs

Trong service `cron-store` → **Settings** → **Cron Schedule**, thêm 3 jobs:

#### Job 1: Gmail sync (every 5 minutes)

```
Name: gmail-sync
Schedule: */5 * * * *
Command:
  curl -sSf -X POST $WEB_URL/api/store-submissions/sync/gmail \
    -H "X-Cron-Secret: $CRON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 60
```

#### Job 2: Email cleanup (daily 3am GMT+7)

```
Name: email-cleanup
Schedule: 0 20 * * *
Command:
  curl -sSf -X POST $WEB_URL/api/store-submissions/cleanup/emails \
    -H "X-Cron-Secret: $CRON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 300
```

#### Job 3: Gmail health check (weekly Sunday 4am GMT+7)

```
Name: gmail-health
Schedule: 0 21 * * 6
Command:
  curl -sSf -X POST $WEB_URL/api/store-submissions/health/gmail \
    -H "X-Cron-Secret: $CRON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time 30
```

### Bước 3 — Environment variables cho cron-store

Trong service `cron-store` → **Variables**:

```bash
# URL của web service (dùng Railway internal hostname cho faster routing)
WEB_URL=${{web.RAILWAY_PUBLIC_DOMAIN}}
# HOẶC dùng full custom domain nếu có:
# WEB_URL=https://tools.yourcompany.com

# Shared cron secret (cùng giá trị với web service)
CRON_SECRET=${{web.CRON_SECRET}}
```

**Template references**:
- `${{web.RAILWAY_PUBLIC_DOMAIN}}` — auto-inject từ web service
- `${{web.CRON_SECRET}}` — share env var từ web service

### Bước 4 — Verify setup

Sau khi save config:

1. **Manual trigger test** (Railway UI → cron-store → Trigger Now):
   ```
   Expected output:
   {"success":true,"mode":"INCREMENTAL",...}
   ```

2. **Check logs** của web service — thấy request log:
   ```
   POST /api/store-submissions/sync/gmail 200 in 2.3s
   ```

3. **Query sync_logs** trong Supabase:
   ```sql
   SELECT * FROM store_mgmt.sync_logs ORDER BY ran_at DESC LIMIT 5;
   ```

---

## Alternative: Vercel Cron (if web service moves to Vercel)

Nếu sau này move web service sang Vercel, tạo `vercel.json` ở project root:

```json
{
  "crons": [
    {
      "path": "/api/store-submissions/sync/gmail",
      "schedule": "*/5 * * * *"
    },
    {
      "path": "/api/store-submissions/cleanup/emails",
      "schedule": "0 20 * * *"
    },
    {
      "path": "/api/store-submissions/health/gmail",
      "schedule": "0 21 * * 6"
    }
  ]
}
```

**Constraints**:
- Vercel Pro required ($20/mo) cho sub-hourly cron
- Vercel Cron uses GET by default; endpoints cần support GET (hoặc dùng Pro+ cho POST)
- Auth qua `Authorization: Bearer $CRON_SECRET` header tự động (Vercel specific)

Railway cron cho flexibility hơn — stick với Railway trừ khi có lý do chuyển.

---

## Monitoring

### Health check (external)

Dùng UptimeRobot (free tier) monitor:

```
URL: https://{web.url}/api/store-submissions/health/sync
Method: GET
Interval: 5 min
Expected status: 200
Alert: Down 2 consecutive checks → email Manager
```

Endpoint trả `{"status":"OK"}` nếu sync chạy gần đây (<15 phút), `{"status":"STALE"}` nếu không.

### Sentry alerts

Config trong Sentry project (xem `docs/store-submissions/06-deployment.md` section B.1.3):
- Cron failure → email immediate
- Gmail disconnected → email immediate
- Error rate spike → warning
- Unclassified surge → warning (rule drift)

---

## Troubleshooting

### Cron không chạy

Check:
1. Railway service `cron-store` status = Running
2. Schedule syntax valid: https://crontab.guru
3. `WEB_URL` + `CRON_SECRET` env vars set correctly
4. curl command manual trigger trong Railway UI thành công

### 401 Unauthorized từ endpoint

- `CRON_SECRET` mismatch giữa web service và cron-store service
- Check env vars trên cả 2 services match exactly

### Timeout

- Endpoint cần > 60s → check Gmail API response time, batch size
- Adjust `--max-time` trong curl command
- Consider split batch thành chunks nhỏ hơn

### Email không được classified

Không phải cron issue — check trong Store Management UI:
- Settings → Gmail connection status
- Email Rules → Recent classifications tab
- `store_mgmt.sync_logs` table để xem sync có chạy không
