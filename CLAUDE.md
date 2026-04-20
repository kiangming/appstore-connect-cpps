# Internal Tools — Project Context for Claude Code

Workspace chứa nhiều internal tools cho team. Sau login Google → Hub page → chọn tool.
Kiến trúc modular: shared shell (Sidebar + Hub + TopNav + login) + per-tool modules.

---

## Available modules

| Module | Route prefix | Purpose |
|---|---|---|
| CPP Manager | `/apps/*`, `/api/asc/*` | Upload Custom Product Pages lên App Store Connect |
| Store Management | `/store-submissions/*`, `/api/store-submissions/*` | Quản lý submission multi-platform qua email |

Khi Claude bắt đầu session, **hỏi user đang làm việc với module nào** trước khi code. Mỗi module có conventions riêng, KHÔNG mix cross-module trong cùng session.

---

## Shared infrastructure

### Tech stack (cả 2 modules dùng chung)

| Layer | Công nghệ |
|---|---|
| Framework | Next.js 14+ (App Router) + TypeScript |
| UI Components | shadcn/ui + Tailwind CSS |
| Server State | TanStack Query |
| Database | Supabase (PostgreSQL) |
| App Auth | NextAuth.js + Google Provider |
| Deploy | Railway |
| Runtime | Node 20+, npm 10+ |

### Shared files (không động trừ khi rõ ràng cần update)

| File | Purpose |
|---|---|
| `app/(auth)/login/` | Google SSO login |
| `app/(dashboard)/layout.tsx` | Shell layout với AppSidebar |
| `app/(dashboard)/page.tsx` | Hub page với tool cards |
| `components/layout/AppSidebar.tsx` | Icon rail sidebar, hover flyout |
| `components/layout/TopNav.tsx` | AccountSwitcher + user menu |
| `lib/supabase.ts` | Base Supabase client |
| `tailwind.config.ts` | Design tokens |

### Shared conventions

- Login là Google SSO duy nhất cho cả workspace
- **Authorization per-module**: mỗi module có bảng user/role riêng, check qua middleware
- Database schema isolation: mỗi module có Postgres schema riêng, KHÔNG query cross-schema
- TypeScript strict mode ON
- Server Components cho data fetching, Client Components cho interactivity
- Error handling: wrap external API calls trong try/catch, typed error responses

### Shared deployment (Railway)

1 Railway project với nhiều services:
- `web` — Next.js app (serve cả 2 modules)
- `cron-store` — cron service cho Store Management (Gmail sync, cleanup)
- CPP Manager không cần cron (user-initiated actions)

---

---

# MODULE 1: CPP Manager

## Mục tiêu
Web dashboard nội bộ để **upload và quản lý Custom Product Pages (CPP) lên App Store Connect** mà không cần truy cập trực tiếp vào trang web của Apple. Thay thế hoàn toàn thao tác thủ công trên App Store Connect UI.

## Người dùng
- Team nội bộ 2–5 người
- Upload assets (screenshots, videos) thủ công từ máy
- Không yêu cầu technical background cao

## Tech Stack (CPP-specific additions)

| Layer | Công nghệ |
|---|---|
| File Upload | React Dropzone |
| ASC API Auth | JWT signing server-side (`jose`) |

> ⚠️ **Bảo mật:** App Store Connect private key KHÔNG ĐƯỢC để ở client. Toàn bộ JWT signing phải thực hiện ở server-side (Next.js API Routes / Route Handlers).

## App Store Connect API — Custom Product Pages

### Authentication
- Dùng JWT (ES256) với private key `.p8` từ App Store Connect
- Header: `Authorization: Bearer <signed_jwt>`
- JWT payload: `iss` (Issuer ID), `aud`, `exp` (tối đa 20 phút)

### Resource hierarchy
```
App
└── AppCustomProductPage (CPP)
    └── AppCustomProductPageVersion (draft/approved)
        └── AppCustomProductPageLocalization (per locale)
            ├── AppScreenshotSet (grouped by ScreenshotDisplayType)
            │   └── AppScreenshot
            └── AppPreviewSet (grouped by PreviewType)
                └── AppPreview (video)
```

### Endpoints chính

| Method | Endpoint | Mô tả |
|---|---|---|
| GET | `/v1/apps` | List tất cả apps |
| GET | `/v1/apps/{id}` | Đọc thông tin 1 app |
| GET | `/v1/apps/{id}/appCustomProductPages` | List tất cả CPPs của app |
| POST | `/v1/apps/{id}/appCustomProductPages` | Tạo CPP mới |
| GET | `/v1/appCustomProductPages/{id}` | Đọc thông tin 1 CPP |
| PATCH | `/v1/appCustomProductPages/{id}` | Cập nhật CPP (visibility, etc.) |
| DELETE | `/v1/appCustomProductPages/{id}` | Xoá CPP |
| POST | `/v1/appCustomProductPageVersions` | Tạo version mới (draft) |
| GET | `/v1/appCustomProductPageVersions/{id}/appCustomProductPageLocalizations` | List localizations của version |
| POST | `/v1/appCustomProductPageLocalizations` | Thêm localization |
| PATCH | `/v1/appCustomProductPageLocalizations/{id}` | Cập nhật promo text |
| GET | `/v1/appCustomProductPageLocalizations/{id}/appScreenshotSets?include=appScreenshots` | Lấy screenshot sets + ảnh |
| GET | `/v1/appCustomProductPageLocalizations/{id}/appPreviewSets?include=appPreviews` | Lấy preview sets + video |
| POST | `/v1/appScreenshotSets` | Tạo screenshot set cho 1 locale |
| POST | `/v1/appScreenshots` | Reserve slot upload screenshot |
| POST | `/v1/appPreviewSets` | Tạo preview set |

### Upload asset flow (screenshots)
Asset upload trên ASC API dùng **2-step upload**:
1. `POST /v1/appScreenshots` → nhận `uploadOperations` (presigned URL)
2. Upload file trực tiếp lên URL đó (PUT request với headers từ `uploadOperations`)
3. `PATCH /v1/appScreenshots/{id}` với `{ uploaded: true, sourceFileChecksum }` để confirm

### CPP Lifecycle states
```
PREPARE_FOR_SUBMISSION → WAITING_FOR_REVIEW → IN_REVIEW → APPROVED / REJECTED
```
> ⚠️ Enum value là `"APPROVED"` (không phải `"ACCEPTED"`).

### JSON:API — quy tắc quan trọng
ASC API tuân thủ JSON:API spec. Khi fetch resource có `?include=xxx`:
- Resources trong mảng `data` → `relationships.xxx` có cả `data` (IDs) lẫn `links`
- Resources trong mảng `included` → `relationships.xxx` CHỈ có `links`, **KHÔNG có `data` IDs**

**→ Để map screenshot vào đúng set:** dùng `set.relationships.appScreenshots.data` (từ phía set trong `data`), không dùng `screenshot.relationships.appScreenshotSet.data` (screenshot nằm trong `included`).

### Screenshot thumbnail URL
```typescript
asset.templateUrl
  .replace("{w}", "390")
  .replace("{h}", "844")
  .replace("{f}", "png")
```

## CPP Feature Roadmap

### Phase 1 — MVP
- [x] App List: hiển thị tất cả apps, bundleId, search theo tên/bundleId
- [x] Sidebar động: hiển thị tên app đang chọn, điều hướng CPP List
- [x] CPP List: hiển thị tất cả CPPs, trạng thái version, visibility
- [x] CPP Detail Panel (View): slide-over panel hiển thị đầy đủ thông tin CPP
- [ ] Auth: login team, lưu ASC credentials an toàn
- [ ] CPP Creator: tạo mới với tên, locale, promo text
- [ ] Asset Uploader: drag & drop screenshots/videos, preview
- [ ] Submit flow: submit CPP for Apple Review

### Phase 2 — Automation
- [ ] Bulk upload: nhiều CPP cùng lúc từ folder
- [ ] Template system: lưu & tái sử dụng cấu hình CPP
- [ ] Status dashboard: realtime polling trạng thái in-review
- [ ] Notification: alert khi CPP approved/rejected

## CPP Project Structure

```
app/
├── (dashboard)/
│   ├── apps/
│   │   └── page.tsx                    ← App List
│   └── apps/[appId]/cpps/
│       ├── page.tsx                    ← CPP List
│       ├── new/page.tsx                ← CPP Creator
│       └── [cppId]/page.tsx            ← CPP Editor
└── api/asc/                            ← ASC API proxy (server-side only)
    ├── apps/
    └── cpps/

lib/
├── asc-client.ts                       ← ASC API client
└── asc-jwt.ts                          ← JWT signing với jose

components/
├── apps/AppList.tsx
├── cpp/
│   ├── CppList.tsx
│   ├── CppDetailPanel.tsx
│   ├── CppEditor.tsx
│   └── AppStorePreview.tsx
└── upload/AssetUploader.tsx

types/asc.ts                            ← ASC API types
```

### Key exported types
```typescript
// app/api/asc/cpps/[cppId]/route.ts
export interface LocalizationWithMedia {
  localization: AppCustomProductPageLocalization;
  screenshotSets: Array<{ set: AppScreenshotSet; screenshots: AppScreenshot[] }>;
  previewSets: Array<{ set: AppPreviewSet; previews: AppPreview[] }>;
}
export interface VersionWithLocalizations {
  version: AppCustomProductPageVersion;
  localizations: LocalizationWithMedia[];
}
```

## CPP Environment Variables

```env
# App Store Connect API
ASC_KEY_ID=
ASC_ISSUER_ID=
ASC_PRIVATE_KEY=        # nội dung file .p8 (multiline, không cần dấu "")
```

## CPP Conventions (module-specific)

- Tất cả ASC API calls đi qua `/app/api/asc/` — không gọi trực tiếp từ client
- `next.config.mjs` dùng ESM export (không dùng `.ts`)
- Logging: log tất cả ASC API calls (method, endpoint, status) để debug

---

---

# MODULE 2: Store Management

## Mục tiêu
Tool quản lý submission app/game lên **multi-platform** (Apple App Store, Google Play, Huawei AppGallery, Facebook Instant Games) qua auto-classify email từ shared Gmail mailbox. Thay thế workflow manual (đọc email → copy vào Excel).

## Người dùng
- Team nội bộ 2-5 người (PM + Dev)
- Volume ~200 submissions/tháng, ~2000 email/tháng

## Tech Stack (Store-specific additions)

| Layer | Công nghệ |
|---|---|
| Forms | react-hook-form + zod |
| Email API | Gmail REST API v1 (scope `gmail.modify`) |
| Regex Engine | `re2-wasm` (NOT V8 regex) |
| Cron | Railway Cron service |
| Error tracking | Sentry (free tier) |

## Full context
**Tech design docs**: `docs/store-submissions/` (10 files, đọc theo thứ tự)
**Visual mockup**: `docs/store-submissions/mockups/mockup.html`

## Reading order trước khi code (Store Management)

1. `docs/store-submissions/00-business-analysis.md` — WHAT & WHY
2. `docs/store-submissions/00-architecture-overview.md` — High-level architecture
3. `docs/store-submissions/01-data-model.md` — Schema SQL đầy đủ
4. Deep-dive tương ứng với phần đang code:
   - Code Gmail sync → `02-gmail-sync.md`
   - Code classifier → `03-email-rule-engine.md`
   - Code ticket logic → `04-ticket-engine.md`
   - Code API/UI → `05-api-frontend.md`
   - Setup/deploy → `06-deployment.md`

## Critical invariants — NEVER violate

1. **One open ticket per grouping key**: Max 1 ticket với `state IN ('NEW', 'IN_REVIEW', 'REJECTED')` cho mỗi `(app_id, type_id, platform_id)`. Enforced by partial unique index `store_mgmt.idx_tickets_open_unique`. Dùng `FOR UPDATE` lock trong transaction khi find-or-create.

2. **Event log append-only**: `store_mgmt.ticket_entries` không UPDATE, chỉ INSERT. Exception: `entry_type='COMMENT'` có thể update `content` + `edited_at` bởi author.

3. **Email snapshot preservation**: Mọi `ticket_entries` type=EMAIL phải có `metadata.email_snapshot` với `{subject, sender, received_at, body_excerpt (500 chars)}`.

4. **User-provided regex ONLY via RE2**: TUYỆT ĐỐI không dùng V8 regex cho user-provided patterns. Dùng `re2-wasm`. ReDoS prevention.

5. **Gmail tokens encrypted**: AES-256-GCM với `GMAIL_ENCRYPTION_KEY` trước khi insert `store_mgmt.gmail_credentials`.

6. **Terminal state consistency**: `state IN ('APPROVED', 'DONE', 'ARCHIVED')` ↔ `closed_at IS NOT NULL` ↔ `resolution_type IS NOT NULL`.

7. **Forward-only migrations**: Không down migrations. Revert = viết migration mới reverse.

8. **Classification status mapping**:
   - `DROPPED`: sender không match — KHÔNG tạo ticket, KHÔNG apply Gmail label
   - `CLASSIFIED`: tạo/update ticket, label `Processed`
   - `UNCLASSIFIED_APP` / `UNCLASSIFIED_TYPE`: tạo ticket bucket tương ứng, label `Unclassified`
   - `ERROR`: không tạo ticket, label `Error`

9. **Schema isolation**: TẤT CẢ tables/sequences/functions của Store Management nằm trong schema `store_mgmt`. Query: `supabase.schema('store_mgmt').from('tickets')` hoặc SQL fully-qualified `store_mgmt.tickets`. KHÔNG query cross-schema với CPP Manager.

10. **Gmail encryption key**: NEVER rotate `GMAIL_ENCRYPTION_KEY` trong production — rotate = hỏng tất cả stored tokens.

## Store Management Project Structure

```
app/
├── (dashboard)/
│   ├── store-submissions/             ← Store Management module
│   │   ├── layout.tsx                    module layout (optional subnav)
│   │   ├── page.tsx                      redirect → /store-submissions/inbox
│   │   ├── inbox/
│   │   ├── follow-up/
│   │   ├── submissions/
│   │   ├── reports/
│   │   ├── tickets/[id]/
│   │   └── config/
│   │       ├── apps/                     App Registry (store_mgmt, not CPP)
│   │       ├── email-rules/
│   │       ├── team/
│   │       └── settings/
└── api/
    └── store-submissions/             ← Store Management API
        ├── sync/gmail/route.ts           Cron endpoint
        ├── cleanup/emails/route.ts       Cron endpoint
        ├── health/gmail/route.ts         Cron endpoint
        ├── tickets/
        ├── apps/
        └── rules/

lib/
└── store-submissions/                 ← Store Management libs (isolated)
    ├── db.ts                             Supabase client với .schema('store_mgmt')
    ├── auth.ts                           Whitelist check middleware
    ├── classifier/                       Email Rule Engine
    ├── ticket-engine/                    Transactional ticket ops
    ├── gmail/                            Gmail API wrappers
    ├── regex/re2.ts                      RE2 wrapper
    ├── crypto.ts                         AES-256-GCM token encrypt
    ├── schemas/                          Shared zod schemas
    └── queries/                          Server-side data fetching

components/
└── store-submissions/                 ← Store Management UI components

types/
└── store-submissions/                 ← Store Management types

supabase/migrations/
├── xxx_init_cpp.sql                   CPP schema (public.*)
└── yyy_init_store_mgmt.sql            Store Management (store_mgmt.*)

docs/store-submissions/                ← All Store Management tech design
```

## Store Management Environment Variables (thêm vào .env)

```env
# Cron endpoints
CRON_SECRET=                            # openssl rand -hex 24

# Gmail token encryption
GMAIL_ENCRYPTION_KEY=                   # openssl rand -hex 32 — NEVER rotate

# Sentry (optional in dev, required in prod)
SENTRY_DSN=

# Initial manager (first MANAGER role trong store_mgmt.users)
INITIAL_MANAGER_EMAIL=
```

## Store Management Conventions (module-specific)

- Tất cả DB queries của Store Mgmt qua `lib/store-submissions/db.ts` wrapper (auto apply schema)
- Tất cả API endpoints under `/api/store-submissions/*`
- Cron endpoints auth qua `X-Cron-Secret` header, match env `CRON_SECRET`
- Mutations user-initiated: Server Actions trong `app/(dashboard)/store-submissions/**/actions.ts`
- External triggers (cron, webhooks): API Routes trong `app/api/store-submissions/*`
- Regex user-provided: LUÔN qua `lib/store-submissions/regex/re2.ts`, không bao giờ V8
- Gmail tokens: encrypt/decrypt qua `lib/store-submissions/crypto.ts`
- Authorization check: middleware trong `lib/store-submissions/auth.ts`, query `store_mgmt.users` theo session email

## Store Management Deploy (Railway)

Thêm vào Railway project hiện tại (cùng project với CPP Manager web service):

1. **Service `web`** (existing): serve cả 2 modules, chung Next.js app
2. **Service `cron-store`** (NEW): cron jobs cho Store Management
   - `*/5 * * * *` → POST `/api/store-submissions/sync/gmail`
   - `0 20 * * *` (3am GMT+7) → POST `/api/store-submissions/cleanup/emails`
   - `0 21 * * 6` (4am Sunday GMT+7) → POST `/api/store-submissions/health/gmail`

Xem `railway/README.md` trong delivery package để setup cụ thể.

---

---

# Workflow rules (both modules)

## Starting a Claude Code session

Recommended opening prompt:

> "Hôm nay tôi làm việc với module [CPP Manager | Store Management].
> Đọc relevant section trong CLAUDE.md + docs của module đó.
> Task cụ thể: [mô tả]."

Claude sẽ skip module không liên quan để tránh confusion context.

## Don't (absolute rules)

1. Don't use V8 regex for user-provided patterns (Store Management only)
2. Don't write down migrations (cả 2 modules)
3. Don't expose Supabase service key to browser
4. Don't query cross-schema giữa `public.*` (CPP) và `store_mgmt.*` (Store)
5. Don't skip `email_snapshot` khi create EMAIL ticket_entry
6. Don't bypass `FOR UPDATE` lock khi handle classified email
7. Don't break one-open-ticket-per-key invariant
8. Don't commit `.env.local`, secrets, Gmail tokens, ASC private key
9. Don't use `any` type without documented reason
10. Don't rotate `GMAIL_ENCRYPTION_KEY` in production
11. Don't modify shared files (`AppSidebar`, `Hub page`, `TopNav`) without cross-module considerations

## Lessons learned (traps we've already hit)

### 1. `ADMIN_EMAIL` vs `ADMIN_EMAILS` — two distinct env vars, do NOT conflate

| Var | Purpose |
|---|---|
| `ADMIN_EMAIL` (singular) + `ADMIN_PASSWORD` | Legacy password-login admin. Shown on login page only when `ADMIN_ENABLE=1`. Bypasses Google SSO. |
| `ADMIN_EMAILS` (plural, comma-separated) | Google SSO admin whitelist. Emails here receive `session.user.role = "admin"` via `lib/auth.ts:isAdminEmail`. **Required** for `/settings` (ASC `.p8` management). Without it, Google SSO users silently default to `role: "member"` and `/settings` redirects home with no error. |

Changing `ADMIN_EMAILS`: restart dev/prod server (NextAuth caches env at startup) **and** sign out + sign in to mint a fresh JWT. Existing sessions keep the stale role.

### 2. `'use server'` files — every export must be async

Next.js rejects non-async exports in any module whose first line is `'use server'`. Pure sync helpers (e.g. row counters, validators, formatters) must live in a utility module, not the actions file. Example: `countSnapshotRows` was extracted to `lib/store-submissions/rules/snapshot-utils.ts` after Railway rejected the build.

`next dev` is lenient — always verify with `npm run build`, not just `npm run dev`, before pushing.

### 3. WASM-bundling npm packages need `serverComponentsExternalPackages`

Packages that ship a `.wasm` binary (e.g. `re2-wasm`) fail at Next.js's "Collecting page data" phase with `ENOENT: ... re2.wasm` because webpack doesn't copy the binary into the expected output path. Fix: add the package to `experimental.serverComponentsExternalPackages` in `next.config.mjs` so Next.js treats it as external and resolves via `require()` against `node_modules/` at runtime.

Current externalized packages: `re2-wasm`. Add new WASM-shipping dependencies to this array.

## Pre-push checklist (both modules)

Before pushing to `origin/main`, run in order:

1. `npm run typecheck` — must be clean (zero errors).
2. `npm test` — all tests must pass.
3. `npm run lint` — zero errors; warnings acceptable.
4. **`npm run build` — CRITICAL.** Catches production-only errors that `next dev` skips: `'use server'` async violations, WASM bundling failures, page-data-collection errors. Railway runs this same command.

If any step fails, fix the root cause — never `--no-verify` past a hook or skip a check.

## Slash commands

Custom commands trong `.claude/commands/`:
- `/new-feature [name]` — Scaffold feature mới theo patterns
- `/new-migration [desc]` — Tạo migration forward-only
- `/explain-area [area]` — Explain 1 domain
- `/check-invariants` — Verify code changes không vi phạm invariants

---

## Version

- v1.0 — April 2026: Initial CPP Manager
- v2.0 — April 2026: Added Home Hub + modular architecture
- v3.0 — April 2026: Added Store Management module với schema `store_mgmt`
- v3.1 — April 2026: Added Lessons learned (ADMIN_EMAILS, `'use server'` async, WASM externalization) + pre-push checklist after PR-6 Railway incidents
