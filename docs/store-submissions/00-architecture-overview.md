# Dashboard Store Management — Technical Design (Skeleton)

**Version:** 0.1 (Skeleton for review)
**Scope:** Big-picture architecture cho MVP, deep-dive follows per section sau khi align
**Prerequisite:** `business-analysis.md` v1 — đã chốt toàn bộ business logic

---

## 0. Tech Stack (đã chốt)

| Layer | Tech | Ghi chú |
|---|---|---|
| Framework | **Next.js 14+** (App Router) + TypeScript | Full-stack đơn nhất, API routes thay thế backend service |
| UI | **shadcn/ui** + Tailwind CSS | Match design tokens trong mockup (Linear-inspired) |
| File Upload | **React Dropzone** | CSV import, attachment upload |
| Server State | **TanStack Query** | Kết hợp Supabase client |
| Validation | **zod** | Shared schemas giữa client + server |
| Auth | **NextAuth.js** (Google provider) | 1 flow cho cả app login + Gmail connect |
| Database | **Supabase PostgreSQL** (Singapore) | + Auth + Storage + RLS trong cùng service |
| Regex Engine | **`re2` npm package** | Prevent ReDoS khi user-provided regex |
| JWT/Crypto | **`jose`** | Gmail token encryption + CSRF signing |
| Email API | **Gmail REST API v1** | Scope `gmail.modify` |
| Deploy | **Railway** (1 prod env) | Web service + Cron service |

---

## 1. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          RAILWAY                                  │
│  ┌─────────────────────────┐        ┌─────────────────────┐      │
│  │  web service             │        │  cron service        │      │
│  │  (Next.js 14 App Router) │        │  (Railway Cron Jobs) │      │
│  │  - Pages + API Routes    │        │                      │      │
│  │  - Server Components     │        │  */5 → /api/sync     │      │
│  │  - Server Actions        │◀───────│  0 3 → /api/cleanup  │      │
│  │                          │  HTTP  │  0 4 * 0 → /health   │      │
│  └───────┬──────────────────┘        └──────────────────────┘      │
└──────────┼────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────┐       ┌──────────────────────┐
│     SUPABASE (Singapore)     │       │    GMAIL API          │
│  - PostgreSQL (core DB)      │       │  - history.list       │
│  - Auth (via NextAuth)       │       │  - messages.get       │
│  - Storage (attachments)     │◀─────▶│  - labels.modify      │
│  - Row Level Security (RLS)  │       │                       │
│  - Realtime (optional)       │       └──────────────────────┘
└──────────────────────────────┘
```

**Single Next.js service** handle cả UI và tất cả API work. Railway Cron đóng vai trò "background worker" bằng cách hit HTTP endpoints — không cần duy trì process riêng, đơn giản hoá ops. Supabase cover 4 concerns (DB / Auth / Storage / RLS) → không cần Redis, object storage riêng, hay auth service độc lập cho MVP.

**Upgrade paths** deferred khi volume vượt ngưỡng: (1) Gmail Pub/Sub push cho real-time thay 5-phút cron; (2) Dedicated job queue (pgmq hoặc BullMQ) khi emails > 10k/month; (3) Edge caching nếu latency issue. Không cái nào cần trong MVP.

---

## 2. Data Model (High-Level)

Chia 3 domain theo access pattern:

**Config domain** — sửa ít, cache được, managed bởi Manager:
`platforms`, `apps`, `app_aliases`, `types`, `subject_patterns`, `senders`, `submission_id_patterns`, `settings`, `users`, `gmail_credentials`

**Core domain** — hot path, update thường xuyên:
`email_messages`, `tickets`, `ticket_entries`

**Audit domain** — append-only, không UPDATE:
`cleanup_logs`, `rule_versions`, `sync_logs`

**Critical constraints**:
- Grouping invariant enforced ở DB level: `CREATE UNIQUE INDEX ON tickets(app_id, type_id, platform_id) WHERE state IN ('NEW','IN_REVIEW','REJECTED')` — tối đa 1 ticket open per key
- `email_messages.gmail_msg_id` có UNIQUE → dedup tự nhiên khi Gmail trả duplicate
- `ticket_entries` append-only → mọi thay đổi có audit trail
- JSONB cho flexible fields: `classification_result`, `type_payload`, `settings`

**Migration strategy**: SQL files trong `/supabase/migrations/` + `supabase db push` trong CI. Forward-only migrations.

---

## 3. Authentication & Authorization

**Two-flow auth**:
- **App login**: NextAuth.js + Google provider. **Kế thừa Google SSO** từ tool hiện tại — user login bằng Google account công ty.
- **Gmail connect**: Manager duy nhất connect shared mailbox (`studio-ops@company.com`) với scope `gmail.modify`. Token encrypted (AES-256-GCM) lưu trong bảng `gmail_credentials` singleton.

**User management — whitelist-based**:
- Config page **"Team"**: Manager thêm email + assign role (`MANAGER`/`DEV`/`VIEWER`) **trước** khi user login lần đầu
- `users` table là **source of truth** cho whitelist: pre-provision rows với email + role + status
- **Flow login**:
  1. User click "Sign in with Google" → NextAuth OAuth
  2. NextAuth callback lookup `users` theo email
  3. Match + status=active → grant session với role từ DB
  4. Không match → reject với message *"Email chưa được whitelist. Liên hệ Manager để được thêm."*
- Google profile (name, avatar, google_sub) cache lại trong `users` row lần đầu login thành công

**RBAC 3 role** enforce 2 tầng:
- **API layer**: middleware check `session.user.role` trước khi xử lý route
- **Database layer**: Supabase RLS policies per table làm defense-in-depth (vd nếu API bug, RLS vẫn block DEV edit `settings`)

**RLS matrix** (deep-dive sau): authenticated user SELECT được `apps`/`tickets`; chỉ MANAGER+DEV UPDATE được `tickets`; chỉ MANAGER touch được `settings`/`email_rules`/`users`.

**Manager bootstrap** (chicken-and-egg): user đầu tiên phải là MANAGER. Giải pháp: seed migration khi deploy lần đầu insert 1 row MANAGER với email truyền qua env var `INITIAL_MANAGER_EMAIL`. Sau đó Manager này thêm người khác qua UI.

---

## 4. Gmail Sync Pipeline

**Cron**: `*/5 * * * *` → `POST /api/sync/gmail` với header `X-Cron-Secret`

**Flow trong 1 request**:
```
1. Load lastHistoryId từ gmail_sync_state
2. GET history.list?startHistoryId={lastHistoryId}
   - 404 expired → fallback: messages.list?q=in:inbox -label:StoreManagement/Processed
3. Với mỗi messageId mới (batch tối đa 50 per run):
   a. messages.get(format='full') → lấy headers + body
   b. INSERT email_messages (status=PENDING) — UNIQUE trên gmail_msg_id tránh duplicate
   c. Synchronous call Email Rule Engine → classify
   d. Synchronous call Ticket Engine → gom/tạo ticket (transactional)
   e. PATCH labels: add StoreManagement/{Processed|Unclassified|Error}
4. UPDATE gmail_sync_state SET lastHistoryId, last_synced_at
5. Return {processed, classified, errors}
```

**Timeout budget**: 60s per cron run (Railway limit). 50 email/batch là safe với overhead Gmail API ~200ms/call. Backlog tự nhiên xử lý cron tiếp.

**Idempotency**: UNIQUE constraint trên `gmail_msg_id` + label check + transactional classify = chạy 2 lần cùng lúc không gây double-process.

**Health check cron** `0 4 * * 0` (Chủ Nhật 4h sáng): verify `lastHistoryId` chưa expire (test bằng 1 API call nhỏ). Nếu expire → alert Manager, force full fallback sync.

---

## 5. Email Rule Engine

**Engine** là pure function: `(rawEmail, platformRules) → ClassifiedEmail | null`

**Execution order trong 1 email**:
```
1. Match sender email → find platform (linear scan, cached)
2. Match subject với platform's subject_patterns → extract app_name + outcome
3. Lookup app_aliases để map app_name → app_id (exact match trước, regex sau)
4. Scan body với platform's types → match body_keyword → type_id
5. Run type.payload_extract_regex → extract named groups
6. Optional: match submission_id_pattern trên body
7. Return ClassifiedEmail hoặc partial result (nếu unclassified app/type)
```

**Regex safety** (critical): tất cả user-provided regex chạy qua `re2` package. RE2 không support backtracking → ReDoS-safe, linear time guarantee. Pattern nào RE2 không compile được → reject khi save, hiện error cho user.

**Rule versioning**: mỗi lần save rule → snapshot full rule config vào `rule_versions(version, config_json, saved_by, saved_at)`. UI History hiện diff giữa các version, button Rollback = insert version mới copy từ version cũ.

**Test mode**: endpoint `POST /api/rules/test` nhận `{subject, body, sender}` → dry-run classify → trả về từng bước match để Manager debug. Không ghi DB.

---

## 6. Ticket Engine

**Core op**: classify xong → find-or-create ticket, strict transactional.

**Pseudo-SQL**:
```sql
BEGIN;
  -- Lock để prevent race condition khi 2 email cùng lúc
  SELECT * FROM tickets
  WHERE app_id = $1 AND type_id = $2 AND platform_id = $3
    AND state IN ('NEW','IN_REVIEW','REJECTED')
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;
  
  IF found:
    new_state := derive_state(found.state, email.outcome)
    UPDATE tickets SET 
      state = new_state,
      latest_outcome = email.outcome,
      type_payloads = type_payloads || $payload,
      submission_ids = array_append_distinct(submission_ids, $sub_id)
    WHERE id = found.id;
    INSERT ticket_entries (ticket_id, entry_type, ...);
  ELSE:
    INSERT tickets (app_id, type_id, platform_id, state='NEW', ...);
    INSERT ticket_entries (ticket_id, entry_type='EMAIL', ...);
COMMIT;
```

**State derivation** là pure TypeScript function `(currentState, emailOutcome) → newState`, có unit test riêng. Không implement trong DB function để dễ test + version control.

**Denormalized cache** `tickets.latest_outcome`: update mỗi transition → Inbox/Follow-Up list render nhanh, không cần JOIN `email_messages` hay `ticket_entries`.

**Partial index enforce invariant**: nếu có bug trong code logic mà cố INSERT duplicate open ticket → PostgreSQL throw constraint error → catch + log + alert. Database là last line of defense.

---

## 7. API Design

**Route structure** dưới `/api/`:
```
auth/[...nextauth]         NextAuth handlers
gmail/{connect,disconnect} OAuth flow Gmail
sync/gmail                 Cron: Gmail poll
cleanup/emails             Cron: dọn email cũ
health/gmail               Cron: historyId check
rules/
  senders                  CRUD per platform
  subject-patterns         CRUD per platform
  types                    CRUD per platform
  test                     POST dry-run classify
apps/                      CRUD app
  import                   POST CSV
  export                   GET CSV
tickets/
  [id]/{archive,follow-up,done,comment}
reports/
  summary                  với time range
  by-{platform,type,app}
```

**Mutation pattern**:
- Form submit trong UI → **Server Actions** (Next.js native, type-safe, ít boilerplate, auto CSRF)
- Cron + external webhook → **API Routes** (cần HTTP endpoint rõ ràng)
- Client-initiated actions (archive button...) → TanStack Query mutation gọi Server Action

**Validation**: zod schema shared. Ví dụ `ticketPatchSchema` dùng cả ở Server Action và client form.

**Error contract**: `{ error: { code: 'GMAIL_TOKEN_EXPIRED', message: '...', details?: {...} } }` + HTTP status phù hợp.

---

## 8. Frontend Architecture

**App Router structure**:
```
app/
├── (auth)/login/page.tsx
├── (app)/
│   ├── layout.tsx                  Sidebar + top bar
│   ├── inbox/page.tsx
│   ├── follow-up/page.tsx
│   ├── submissions/page.tsx
│   ├── reports/page.tsx
│   ├── config/
│   │   ├── apps/page.tsx           App Registry
│   │   ├── email-rules/page.tsx
│   │   ├── team/page.tsx
│   │   └── settings/page.tsx
├── api/                            API Routes
```

**Render strategy** theo page:
- List views (Inbox, Follow-Up, Submissions) → **Server Component** cho initial data + nested **Client Component** cho filter/selection/keyboard shortcut
- Ticket drawer → Client (interactive animations, form state)
- Reports → Server với Suspense boundaries (charts lazy load client-side)
- Config pages → Client (form-heavy, instant feedback)

**State layers**:
- Server state: TanStack Query + Supabase client
- Form state: `react-hook-form` + zod resolver
- UI state: `useState`/`useReducer` (drawer open, selection)
- Global state: ❌ không cần, URL query params đủ

**Realtime (optional, phase 2)**: Supabase Realtime subscription trên `tickets` table → Inbox auto-refresh khi cron sync xong. Nice-to-have, không critical vì user tab Inbox thường là attention-first.

---

## 9. Background Jobs & Observability

**Cron jobs**:
| Schedule | Endpoint | Purpose |
|---|---|---|
| `*/5 * * * *` | `/api/sync/gmail` | Gmail incremental sync |
| `0 3 * * *` | `/api/cleanup/emails` | Xóa email raw theo retention policy |
| `0 4 * * 0` | `/api/health/gmail` | Check historyId expire weekly |

**Invariants**: mỗi endpoint idempotent + timeout <60s + auth qua `X-Cron-Secret` header (Railway env var). Nếu job fail → log error + Sentry alert, không tự retry (Railway Cron sẽ hit lại lần sau).

**Logging**: structured JSON `{level, ts, event, ticket_id?, email_id?, error?}` → Railway logs. Filter bằng Railway UI hoặc ship Logtail sau (phase 2).

**Error tracking**: Sentry free tier (5k events/month đủ cho 5 người). Wrap Server Actions + API Routes + cron handlers. Source map upload trong deploy step.

**Metrics**: MVP chỉ log count → query SQL trực tiếp khi cần. Phase 2 cân nhắc dashboard (Grafana Cloud hoặc tự build trong tool).

---

## 10. Security

**Secrets**: tất cả trong Railway env vars. Local dev `.env.local` gitignored.
```
DATABASE_URL              Supabase connection
SUPABASE_SERVICE_KEY      Bypass RLS cho cron jobs
NEXTAUTH_SECRET           Session signing
NEXTAUTH_URL              https://... (prod URL)
GOOGLE_CLIENT_ID/SECRET   NextAuth Google + Gmail OAuth
CRON_SECRET               Protect cron endpoints
GMAIL_ENCRYPTION_KEY      AES-256 cho Gmail token
SENTRY_DSN                Error tracking
```

**Gmail token**: AES-256-GCM encrypt trước khi INSERT vào `gmail_credentials.access_token_encrypted`. Refresh flow qua `googleapis` package, auto decrypt → use → re-encrypt.

**RLS policies**: liệt kê đầy đủ trong deep-dive. Nguyên tắc: cron + service actions dùng Supabase service key bypass RLS (trusted); user-initiated requests dùng user JWT qua RLS.

**Rate limiting**: Gmail API quota 1B units/day = effectively unlimited cho 5 người. App-level rate limit defer sang khi public API (phase 2). CSV import giới hạn file 2MB + 1000 rows/file.

**CSV safety**: validate mỗi row với zod → regex patterns validate với RE2 trước khi insert → preview diff trước commit.

**CSRF**: NextAuth built-in + Next.js Server Actions built-in. API routes cho cron dùng secret header (không cần CSRF vì không user-session-based).

---

## 11. Deployment & Environment

**Railway setup**:
```
Project: store-management
├── web service       auto-deploy từ main branch GitHub
│                     build: next build
│                     start: next start
└── cron service      3 scheduled HTTP requests
```

**Supabase**: 1 project prod region Singapore. Migration apply qua `supabase db push` trong GitHub Actions CI trước khi deploy web.

**CI/CD** (GitHub Actions):
```
PR opened → lint + typecheck + unit test
merge main → migrate DB → deploy web → smoke test
```

**Rollback**:
- Web: Railway "Redeploy previous commit" 1-click
- DB: forward-only migrations; nếu migration có breaking change thì staged deploy (deploy code tương thích cả 2 schema trước, rồi mới migrate)

**Backups**: Supabase Pro plan có PITR (Point-In-Time Recovery) 7 ngày default. Không manual backup thêm — chấp nhận risk với retention 7 ngày. Nếu cần extend: upgrade Supabase tier hoặc script dump sang S3 weekly (defer).

---

## 12. Phasing Plan

**MVP (ước 4-6 tuần)**:
- Gmail sync + Email Rule Engine + Ticket Engine (backend core)
- 4 UI module: Inbox / Follow-Up / Submissions / Reports
- Config: App Registry + Email Rules + Settings
- CSV import/export cho App Registry
- Auth + 3-role RBAC
- Email cleanup cron
- Basic logging + Sentry

**v1.1 (2-3 tuần sau launch)**:
- Historical Excel migration tool (import ticket cũ)
- Slack/Discord webhook notification khi có ticket REJECTED mới
- Saved filter views
- Keyboard shortcut help overlay
- App icon upload (thay vì URL)

**v2 (khi metric trigger)**:
- Gmail Pub/Sub push → near real-time
- Multi-mailbox support (nếu team grow)
- AI-assisted reject reason categorization
- Mobile web optimization
- Multi-tenant (nếu tool scale ra multiple teams)

**Trigger để consider v2**: `emails > 5k/month` hoặc `apps > 30` hoặc `team > 10 người`.

---

## Resolved decisions (từ Q&A với PM)

| # | Quyết định | Impact |
|---|---|---|
| R1 | **User management**: whitelist-based. Manager pre-provision email + role trong Team page. Google SSO login auto-match theo email | Section 3 Auth rewritten |
| R2 | **App icon**: không support upload file trong MVP. Giữ text-initial icon trong UI (như mockup hiện tại) | Data model bỏ `icon_url`, không cần Supabase Storage cho icon |
| R3 | **Timezone**: fix `Asia/Ho_Chi_Minh` (GMT+7). DB lưu UTC, format với `date-fns-tz` ở client side | Tất cả date/time display đi qua 1 helper `formatDate(dt, format)` — dễ đổi nếu cần |
| R4 | **Backup**: không manual backup. Chấp nhận PITR 7 ngày default của Supabase | Section 11 update, bỏ S3 weekly dump khỏi roadmap |
| R5 | **App name change**: rename app → giữ alias cũ với marker "prev name", tự động add alias mới | Business logic update trong Component D |

---

## Open questions (detailed implementation, không blocking skeleton)

1. **Supabase Pro vs Free tier**: Free tier có giới hạn 500MB DB, 1GB storage, 2 compute hours/day. Volume 200 submission/tháng × 2000 email/tháng ước tính fit Free tier 6-12 tháng đầu. Manager quyết định Pro ngay hay start Free?
2. **Sentry self-hosted vs cloud**: free tier Sentry 5k events/month đủ, nhưng có compliance cần keep data in VN không?
3. **Initial Manager email**: set qua env var `INITIAL_MANAGER_EMAIL` hoặc migration script cần value cụ thể
4. **Domain restriction cho Google SSO**: chỉ cho phép login với email `@company.com` (hd parameter) hay cho phép mọi Google account (whitelist tự filter)?

---

## Đánh giá skeleton

Document này cover **12 section core** + **5 open question**. Mỗi section có overview đủ để align direction, chưa đi sâu vào implementation detail. Sau khi bạn review skeleton:

1. **Section nào thấy sai hướng / thiếu / overscope** → note lại để điều chỉnh
2. **Open questions** trả lời các câu phù hợp
3. **Ưu tiên deep-dive section nào trước** → tôi viết detail design cho section đó

Gợi ý thứ tự deep-dive hợp lý: Data Model (foundation) → Gmail Sync → Email Rule Engine → Ticket Engine → API → Frontend → còn lại.
