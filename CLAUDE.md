# CPP Manager — Project Context for Claude Code

## Mục tiêu dự án
Web dashboard nội bộ để **upload và quản lý Custom Product Pages (CPP) lên App Store Connect** mà không cần truy cập trực tiếp vào trang web của Apple.

Thay thế hoàn toàn thao tác thủ công trên App Store Connect UI.

---

## Người dùng
- Team nội bộ 2–5 người
- Upload assets (screenshots, videos) thủ công từ máy
- Không yêu cầu technical background cao

---

## Tech Stack

| Layer | Công nghệ |
|---|---|
| Framework | Next.js 14+ (App Router) + TypeScript |
| UI Components | shadcn/ui + Tailwind CSS |
| File Upload | React Dropzone |
| ASC API Auth | JWT signing server-side (`jose`) |
| Server State | TanStack Query |
| Database | Supabase (PostgreSQL) |
| App Auth | NextAuth.js |
| Deploy | Vercel hoặc Docker (self-host) |

> ⚠️ **Bảo mật:** App Store Connect private key KHÔNG ĐƯỢC để ở client. Toàn bộ JWT signing phải thực hiện ở server-side (Next.js API Routes / Route Handlers).

---

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

---

## Feature Roadmap

### Phase 1 — MVP
- [x] App List: hiển thị tất cả apps, bundleId, search theo tên/bundleId
- [x] Sidebar động: hiển thị tên app đang chọn, điều hướng CPP List
- [x] CPP List: hiển thị tất cả CPPs, trạng thái version, visibility
- [x] CPP Detail Panel (View): slide-over panel hiển thị đầy đủ thông tin CPP
  - General info (name, visibility, URL)
  - Version state badge
  - Localizations với promotional text
  - Screenshots nhóm theo device type (iPhone/iPad)
  - App Previews (video) nhóm theo device type
- [ ] Auth: login team, lưu ASC credentials an toàn
- [ ] CPP Creator: tạo mới với tên, locale, promo text
- [ ] Asset Uploader: drag & drop screenshots/videos, preview
- [ ] Submit flow: submit CPP for Apple Review

### Phase 2 — Automation
- [ ] Bulk upload: nhiều CPP cùng lúc từ folder
- [ ] Template system: lưu & tái sử dụng cấu hình CPP
- [ ] Status dashboard: realtime polling trạng thái in-review
- [ ] Notification: alert khi CPP approved/rejected

---

## UI Layout

```
┌──────────────────┬─────────────────────────────────┐
│ Sidebar          │ Main Content                    │
│ ──────────       │ ─────────────────────────────   │
│ 📱 [App Name]    │ CPP List / CPP Editor           │
│   > CPP List     │                                 │
│   > Templates    │ [Right panel: CPP Detail]       │
│ ─────────        │                                 │
│ ⚙️ Settings      │                                 │
└──────────────────┴─────────────────────────────────┘
```

Visual style: Clean, minimal. Tham chiếu Apple HIG. Màu neutral (white/slate), accent xanh Apple (`#0071E3`), font Inter.

---

## Project Structure (Next.js App Router)

```
cpp-manager/
├── CLAUDE.md
├── next.config.mjs             ← ESM format (next.config.ts không được hỗ trợ)
├── app/
│   ├── (auth)/
│   │   └── login/
│   ├── (dashboard)/
│   │   ├── layout.tsx          ← Shell layout với SidebarNav
│   │   ├── apps/
│   │   │   └── page.tsx        ← App List (Server Component)
│   │   └── apps/[appId]/
│   │       └── cpps/
│   │           ├── page.tsx        ← CPP List (Server Component)
│   │           ├── new/page.tsx    ← CPP Creator
│   │           └── [cppId]/page.tsx← CPP Editor
│   └── api/
│       └── asc/                ← Proxy tới ASC API (server-side only)
│           ├── apps/
│           │   ├── route.ts        ← GET /api/asc/apps (list)
│           │   └── [appId]/route.ts← GET /api/asc/apps/[appId]
│           └── cpps/
│               └── [cppId]/route.ts← GET + PATCH /api/asc/cpps/[cppId]
├── lib/
│   ├── asc-client.ts           ← ASC API client (server-side only)
│   ├── asc-jwt.ts              ← JWT signing với jose
│   └── supabase.ts
├── components/
│   ├── layout/
│   │   └── SidebarNav.tsx      ← Client Component, đọc appId từ usePathname()
│   ├── apps/
│   │   └── AppList.tsx         ← Client Component với search
│   ├── cpp/
│   │   ├── CppList.tsx         ← Client Component với View button
│   │   ├── CppDetailPanel.tsx  ← Slide-over panel hiển thị chi tiết CPP
│   │   ├── CppEditor.tsx
│   │   └── AppStorePreview.tsx
│   └── upload/
│       └── AssetUploader.tsx
└── types/
    └── asc.ts                  ← TypeScript types cho ASC API responses
```

### Key exported types từ route handlers
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

---

## Environment Variables cần có

```env
# App Store Connect API
ASC_KEY_ID=
ASC_ISSUER_ID=
ASC_PRIVATE_KEY=        # nội dung file .p8 (multiline, không cần dấu "")

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# NextAuth
NEXTAUTH_SECRET=
NEXTAUTH_URL=
```

---

## Conventions

- Tất cả ASC API calls đi qua `/app/api/asc/` — không gọi trực tiếp từ client
- TypeScript strict mode bật
- Dùng Server Components cho data fetching, Client Components cho interactivity
- Error handling: wrap tất cả ASC calls trong try/catch, trả về typed error response
- Logging: log tất cả ASC API calls (method, endpoint, status) để debug
- `next.config.mjs` dùng ESM export (không dùng `.ts`)
