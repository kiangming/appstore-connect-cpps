# Developer Onboarding Guide — Store Management

**Welcome!** Guide này giúp bạn lên roadmap tiếp cận codebase Store Management nhanh nhất. Dự kiến 1-2 ngày để đọc docs + setup local, sau đó có thể bắt đầu đóng góp code.

---

## 1. Dự án là gì (60 giây)

Dashboard quản lý submission app/game lên các store (Apple App Store, Google Play, Huawei AppGallery, Facebook Instant Games). Thay thế workflow thủ công của team hiện tại (check Gmail → copy vào Excel), tool tự động:

1. **Fetch email** từ shared mailbox team (qua Gmail API)
2. **Classify** email theo platform/app/type bằng rule engine cấu hình được
3. **Gom thành ticket** theo grouping key `(app + type + platform)` với state machine (NEW → IN_REVIEW ↔ REJECTED → APPROVED/DONE/ARCHIVED)
4. **UI cho team** triage trong Inbox, xử lý Follow-Up, theo dõi Submissions, báo cáo Reports

Team target: 2-5 người (PM + Dev). Volume: ~200 submissions/tháng, ~2k email/tháng.

---

## 2. Tech stack at a glance

| Layer | Tech | Lý do chọn |
|---|---|---|
| Framework | Next.js 14 App Router + TypeScript | Full-stack đơn nhất, kế thừa stack tool hiện tại |
| UI | shadcn/ui + Tailwind CSS | Component primitives, match mockup Linear-style |
| Auth | NextAuth.js + Google Provider | Kế thừa Google SSO |
| Server state | TanStack Query | Cache + optimistic updates |
| Forms | react-hook-form + zod | Shared schemas client/server |
| Database | Supabase PostgreSQL (Singapore) | DB + Storage + (future) Realtime |
| Email API | Gmail REST API v1, scope `gmail.modify` | Fetch + label emails |
| Regex | `re2-wasm` | ReDoS-safe cho user-provided patterns |
| Deploy | Railway (web + cron services) | Nhẹ, auto-deploy từ GitHub |
| Error tracking | Sentry | Free tier đủ |

**Non-obvious choices**:
- **Không có queue/worker** — tất cả async work làm trong Next.js cron endpoints, gọi bởi Railway Cron Job
- **RE2 (not V8 regex)** — user viết regex cho classifier, RE2 guarantee linear time để prevent ReDoS
- **Service role cho backend DB access, RLS deferred** — MVP đủ, RLS bật khi enable Realtime

---

## 3. Reading order — tech design docs

Đọc theo đúng thứ tự này, **không nhảy cóc**. Mỗi doc tự reference previous docs:

```
Phase 1: Context (1-2 giờ)
  └─ business-analysis.md
     "What are we building, why, for whom?"
     
Phase 2: Architecture (1 giờ)
  └─ tech-design.md (skeleton)
     "High-level system architecture"
     
Phase 3: Deep-dive backend (4-5 giờ)
  ├─ tech-design-01-data-model.md
  │   "Database schema, migrations, indexes"
  ├─ tech-design-02-gmail-sync.md
  │   "Gmail API integration, cron pipeline"
  ├─ tech-design-03-email-rule-engine.md
  │   "Classifier pure function + RE2"
  └─ tech-design-04-ticket-engine.md
     "Ticket state machine, transactions, event log"
     
Phase 4: Deep-dive frontend (2-3 giờ)
  └─ tech-design-05-api-frontend.md
     "Server Actions, App Router structure, TanStack Query"
     
Phase 5: Ops (1-2 giờ)
  └─ tech-design-06-deployment-observability.md
     "Railway setup, Sentry, phasing"

Phase 6: Visual (30 phút)
  └─ mockup.html
     Mở trong browser, click qua các view để feel UI
```

**Total**: 9-13 giờ reading, chia làm 2 ngày là hợp lý.

**Tip**: đọc doc, ghi **open questions** xuống notebook. Sau khi đọc hết, ask trong team Slack/meeting.

---

## 4. Key concepts cần nắm

### 4.1. Grouping key

Mọi ticket được xác định duy nhất bởi `(app_id, type_id, platform_id)` **khi đang ở open state**. Invariant này enforce ở 2 tầng:
- **DB**: partial unique index `idx_tickets_open_unique`
- **Code**: `FOR UPDATE` lock + `find_or_create` pattern trong transaction

### 4.2. State machine

```
                    email mới đến (app+type+platform key)
                              │
        không có open ticket──┴──có open ticket
              │                        │
              ▼                        ▼
            NEW ────user Archive──▶ ARCHIVED (terminal)
             │
             │──user Follow Up + latest_outcome──▶
             ▼
      ┌──IN_REVIEW ◀─────email IN_REVIEW─────┐
      │      │                                │
      │      │──email REJECTED──▶ REJECTED ───┤
      │      │                     │          │
      │      └───email APPROVED────┤          │
      │                            │          │
      ▼                            ▼          │
  APPROVED                    APPROVED ◀──────┘
  (terminal)                  (terminal)
  
  Any open state ──user Mark Done──▶ DONE (terminal)
```

**Critical edge case** để nhớ: `REJECTED → IN_REVIEW` khi dev resubmit sau fix. State machine cho phép cycle này — KHÔNG tạo ticket mới.

### 4.3. 5 loại classification outcome

Email đi qua classifier → 1 trong 5 outcomes:
- `DROPPED` — sender không match platform nào (không phải email từ store)
- `UNCLASSIFIED_APP` — sender đúng, nhưng app không có trong Registry
- `UNCLASSIFIED_TYPE` — app có, nhưng body không match Type nào
- `CLASSIFIED` — full match, tạo ticket bình thường
- `ERROR` — regex/parse error

Mỗi outcome có Gmail label riêng (`Processed` / `Unclassified` / `Error`) và UI behavior riêng.

### 4.4. Pure function boundary

Email Rule Engine (classifier) là **pure function** — không DB, không side-effects. Input: email + rules snapshot. Output: ClassificationResult. Testable hoàn toàn trong isolation.

Ticket Engine mới handle DB + state transitions. Tách rõ 2 concerns này.

### 4.5. Event log append-only

`ticket_entries` không bao giờ UPDATE (trừ edit COMMENT type). Mọi thay đổi trạng thái, email mới, action của user đều là INSERT entry mới. Audit trail miễn phí.

**Important detail**: mỗi EMAIL entry lưu snapshot của email (subject + sender + body excerpt 500 chars) trong `metadata` — sau khi email_messages bị cleanup theo retention, thread timeline vẫn đủ.

### 4.6. Cron endpoints làm worker

Thay vì dedicated worker process, Railway Cron Job hit HTTP endpoints:
- `*/5 * * * *` → `/api/sync/gmail`
- `0 20 * * *` (3h sáng GMT+7) → `/api/cleanup/emails`
- `0 21 * * 6` (4h sáng CN GMT+7) → `/api/health/gmail`

Tất cả auth qua header `X-Cron-Secret`. Advisory lock ngăn concurrent runs.

---

## 5. Local dev setup

### 5.1. Prerequisites

- Node 20+ (recommend nvm)
- npm 10+
- Git
- Supabase CLI (`npm i -g supabase`)
- VS Code + recommended extensions (ESLint, Prettier, Tailwind IntelliSense)

### 5.2. Clone + install

```bash
git clone git@github.com:yourcompany/store-management.git
cd store-management
npm install
```

### 5.3. Local Supabase

```bash
# Start local Supabase stack (Docker)
supabase start
# Copy the local anon key, service key, DB URL vào .env.local
```

### 5.4. Env vars

Copy `.env.example` → `.env.local`, fill values:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=<from supabase status>
SUPABASE_SERVICE_KEY=<from supabase status>

NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<generate: openssl rand -hex 32>

GOOGLE_CLIENT_ID=<dev OAuth client>
GOOGLE_CLIENT_SECRET=<dev OAuth client>
GOOGLE_HOSTED_DOMAIN=yourcompany.com

CRON_SECRET=<generate: openssl rand -hex 24>
GMAIL_ENCRYPTION_KEY=<generate: openssl rand -hex 32>

APP_ENV=development
APP_TIMEZONE=Asia/Ho_Chi_Minh
INITIAL_MANAGER_EMAIL=yourname@yourcompany.com
LOG_LEVEL=debug
```

**Google OAuth dev client**: xin team hoặc tạo riêng trong Google Cloud Console, add `http://localhost:3000/api/auth/callback/google` vào redirect URIs.

### 5.5. Apply migrations

```bash
supabase db reset  # wipes local DB + applies all migrations + seeds
```

Verify:
```bash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM platforms;"  # expect 4
psql $DATABASE_URL -c "SELECT COUNT(*) FROM subject_patterns;"  # expect 3 (Apple only MVP)
psql $DATABASE_URL -c "SELECT * FROM users;"  # expect 1 (INITIAL_MANAGER_EMAIL)
```

### 5.6. Run dev server

```bash
npm run dev
# Open http://localhost:3000
```

Login với Google account = `INITIAL_MANAGER_EMAIL`. Verify dashboard renders.

### 5.7. Run tests

```bash
npm test              # unit + integration tests
npm run test:watch    # watch mode during development
npm run typecheck     # TS check
npm run lint          # ESLint
```

### 5.8. Hit a cron endpoint locally

```bash
# Manual trigger Gmail sync
curl -X POST http://localhost:3000/api/sync/gmail \
  -H "X-Cron-Secret: $CRON_SECRET"

# Expect 500 nếu chưa connect Gmail - OK, verify auth không bị reject 401
```

---

## 6. Code structure map

```
.
├── app/                          Next.js App Router
│   ├── (auth)/login/             Login page
│   ├── (app)/                    Authenticated app shell
│   │   ├── inbox/                   Ticket triage
│   │   ├── follow-up/               Active tickets
│   │   ├── submissions/             Per-app view
│   │   ├── reports/                 Analytics
│   │   ├── tickets/[id]/            Detail drawer
│   │   └── config/                  Admin pages
│   │       ├── apps/                   App Registry
│   │       ├── email-rules/            Rule config
│   │       ├── team/                   Whitelist users
│   │       └── settings/               Global settings
│   └── api/                      API routes (cron, OAuth, CSV, webhooks)
│
├── lib/                          Business logic (pure, testable)
│   ├── auth/                        NextAuth config + session helpers
│   ├── classifier/                  Email Rule Engine (pure function)
│   ├── ticket-engine/               Transactional ticket ops
│   ├── gmail/                       Gmail API wrappers
│   ├── regex/                       RE2 wrappers + validation
│   ├── db/                          Prisma/Drizzle client
│   ├── schemas/                     Shared zod schemas
│   ├── queries/                     Server-side data fetching
│   ├── errors/                      Error classes
│   ├── crypto.ts                    Token encryption
│   ├── logger.ts                    Structured logging
│   └── query-keys.ts                TanStack Query key factory
│
├── components/                   Shared UI components
│   ├── ui/                          shadcn/ui primitives
│   ├── ticket/                      Ticket-specific components
│   └── layout/                      Sidebar, top bar
│
├── supabase/
│   ├── config.toml
│   └── migrations/                  SQL migration files
│
├── test/
│   ├── fixtures/                    Email samples, rule configs
│   └── helpers/                     Test setup, factory functions
│
├── .github/workflows/            CI/CD (lint-test + deploy)
└── railway.json                  Railway build config
```

**Naming patterns**:
- `app/**/client.tsx` — Client Component cho page đó
- `app/**/actions.ts` — Server Actions cho page đó
- `app/**/page.tsx` — Server Component entry
- `lib/{domain}/index.ts` — public exports của domain

---

## 7. Dev workflow

### 7.1. Tạo feature branch

```bash
git checkout main
git pull
git checkout -b feat/add-bulk-assign

# Code, commit, push
git commit -m "feat: bulk assign action for Follow-Up tickets"
git push -u origin feat/add-bulk-assign
```

### 7.2. PR workflow

1. Open PR vào `main`
2. GitHub Actions runs: lint + typecheck + test
3. Request review từ 1 team member
4. Merge → auto deploy to Railway (migrate DB first, then web)
5. Monitor Sentry + Railway logs trong 15-30 phút sau deploy

### 7.3. Write new migration

```bash
# Tạo file migration mới
supabase migration new add_notifications_table

# Edit file SQL trong supabase/migrations/
# Test locally
supabase db reset

# Commit migration + code changes cùng PR
```

**Forward-only migrations**: không viết down migration. Nếu cần revert → viết migration mới reverse.

### 7.4. Write tests

Mỗi PR phải có test coverage cho business logic:
- **Unit test** cho pure functions (classifier, state derivation)
- **Integration test** cho transactions (ticket engine, rename app)
- **API test** với mocked Gmail

Xem `tech-design-04-ticket-engine.md` section 11 cho test pattern.

### 7.5. Add user-facing feature — checklist

Mỗi feature user-facing phải có:
- [ ] Zod schema trong `lib/schemas/`
- [ ] Business logic trong `lib/` (pure nếu được, transactional nếu DB)
- [ ] Server Action hoặc API Route
- [ ] UI component sử dụng TanStack Query
- [ ] Loading state + error handling + toast
- [ ] Optimistic update nếu affect list view
- [ ] Unit test cho business logic
- [ ] Keyboard shortcut nếu applicable (xem `lib/shortcuts`)
- [ ] Accessibility: semantic HTML + ARIA labels
- [ ] Update relevant tech-design doc nếu thay đổi architecture

---

## 8. Gotchas — bugs phổ biến đã gặp

### 8.1. Timezone

- DB lưu UTC (TIMESTAMPTZ)
- Frontend display GMT+7 (hardcoded)
- Railway Cron chạy UTC → convert khi set schedule
- Đừng bao giờ dùng `new Date().toISOString().slice(0, 10)` để get "today" — có thể off by 1 ngày tùy TZ. Dùng helper `formatInTZ(date, 'yyyy-MM-dd')`.

### 8.2. Regex syntax

- Always test trong RE2 trước khi save (`re2Validate()`)
- JS named groups: `(?<name>...)` không phải `(?P<name>...)` Python style (cả 2 RE2 support, UI hint dùng JS)
- Escape dấu `.` thành `\.` khi match literal

### 8.3. FOR UPDATE trong transaction

- Transaction isolation: ReadCommitted (default Postgres)
- Lock scope: chỉ rows matching WHERE clause với FOR UPDATE
- Nếu 2 transaction lock same row → 2nd blocks đến khi 1st commit
- Timeout default 10s (set trong `db.$transaction(() => {...}, { timeout: 10_000 })`)

### 8.4. Server Actions return type

- Always return `{ ok: true, data } | { ok: false, error }` discriminated union
- Không throw từ Server Action — throw không serialize được cho client
- Client check `result.ok` trước khi dùng `result.data`

### 8.5. TanStack Query key invariance

- Query key phải stable: same filter → same key → cache hit
- Object properties phải serializable (không Date objects trực tiếp)
- Convention: `['tickets', 'list', { state: 'NEW', app_id: '...' }]`

### 8.6. Gmail API quirks

- `history.list` returns `historyId` — save cho next run
- 404 = historyId expired → fallback mode
- `messages.get` MIME có thể nested sâu — dùng parser có test coverage
- `labels.list` một lần, cache labels trong memory

### 8.7. Next.js App Router quirks

- `'use server'` directive cho Server Actions
- `'use client'` cho components có hooks/events
- Server Components không import Client Components contain state
- Revalidate cache: `revalidatePath('/inbox')` sau mutations

---

## 9. Who to ask

| Topic | Person | Channel |
|---|---|---|
| Product decisions, business logic | PM | Slack #product |
| Infrastructure, deploy issues | Tech lead | Slack #eng |
| Design tokens, UI patterns | Designer | Slack #design |
| Urgent prod issue | On-call | Slack #eng-oncall |
| Access request (Supabase, Sentry, etc.) | Manager | DM |

**Docs đầu tiên** khi stuck: search trong tech-design docs. 80% câu hỏi đã có answer.

---

## 10. First 2-week milestones

**Week 1**:
- [ ] Đọc hết tech-design docs
- [ ] Setup local dev working end-to-end
- [ ] Run full test suite passing
- [ ] Pair với team member qua 1 feature hiện có (code walkthrough)
- [ ] Fix 1 bug nhỏ (look for `good-first-issue` label)

**Week 2**:
- [ ] Ship 1 small feature trong production (với mentor review)
- [ ] Attend retrospective đầu tiên
- [ ] Update onboarding doc nếu tìm ra gì không clear (pay it forward)

---

## 11. Resources

**Internal docs** (trong `docs/` folder):
- `business-analysis.md` — product spec
- `tech-design-*.md` — 6 technical design deep-dives
- `mockup.html` — UI reference

**External reading**:
- Next.js App Router: https://nextjs.org/docs/app
- Supabase: https://supabase.com/docs
- TanStack Query: https://tanstack.com/query/latest/docs/framework/react/overview
- RE2 syntax: https://github.com/google/re2/wiki/Syntax
- Gmail API: https://developers.google.com/gmail/api

**Keyboard shortcuts** (dùng trong tool):
- `1` / `2` / `3` / `4` — switch tabs
- `E` — Archive ticket (Inbox)
- `F` — Follow Up (Inbox)
- `↑` `↓` — Navigate list
- `⏎` — Open ticket drawer
- `Esc` — Close drawer
- `?` — Show all shortcuts

---

Chào mừng gia nhập team! 🎮
