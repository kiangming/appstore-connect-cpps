# CPP Manager — Trạng thái hiện tại

> **Đây là file đọc đầu tiên** khi bắt đầu session mới. Cung cấp toàn cảnh dự án, features đã làm và chưa làm.
>
> Last updated: 2026-04-07 (session 15)

---

## Tóm tắt nhanh

Web dashboard nội bộ để quản lý App Store Connect Custom Product Pages (CPP) mà không cần vào UI của Apple.
- **Tech:** Next.js 14 App Router + TypeScript + Tailwind CSS + NextAuth + Supabase
- **Deploy:** Railway (primary), Docker (self-host option)
- **Người dùng:** Team nội bộ 2–5 người

---

## Features đã hoàn thành ✅

| Feature | Entry point | Doc chi tiết |
|---|---|---|
| App List + Search (fluid grid auto-fill, iTunes icon) | `app/(dashboard)/apps/page.tsx` + `components/apps/AppList.tsx` | `docs/feature-app-cpp-list.md` |
| **Top Nav redesign** (bỏ sidebar, top nav + app sub-nav) | `components/layout/TopNav.tsx` + `components/layout/AppSubNav.tsx` | — |
| **Authentication (Google OAuth only + role-based)** | `app/(auth)/login/page.tsx` + `lib/auth.ts`. Google-only (CredentialsProvider đã xóa). Role `admin`/`member` gán qua `ADMIN_EMAILS` env var. | `docs/feature-google-auth.md` |
| CPP List + trạng thái | `app/(dashboard)/apps/[appId]/cpps/page.tsx` | `docs/feature-app-cpp-list.md` |
| CPP Detail Panel (view) | `components/cpp/CppDetailPanel.tsx` | `docs/feature-app-cpp-list.md` |
| New CPP form | `app/(dashboard)/apps/[appId]/cpps/new/page.tsx` | — |
| CPP Editor (tabs: Overview/Details/Assets) | `components/cpp/CppEditor.tsx` | `docs/feature-cpp-editor.md` |
| Localization Manager | `components/cpp/LocalizationManager.tsx` | `docs/feature-cpp-editor.md` |
| Manual Asset Upload (screenshot + preview) | `components/cpp/LocalizationManager.tsx` | `docs/feature-cpp-editor.md` |
| **Bulk Import** (folder → multi-locale upload) | `components/cpp/BulkImportDialog.tsx` | `docs/bulk-import-design.md` |
| **CPP Bulk Import** (tạo nhiều CPP cùng lúc từ folder) | `components/cpp/CppBulkImportDialog.tsx` | `docs/feature-cpp-bulk-import-design.md` |
| CPP URL column + Export CSV | `components/cpp/CppList.tsx` | `docs/feature-cpp-url-export.md` |
| **CPP Bulk Import — Excel metadata** (`metadata.xlsx`) | `lib/parseMetadataXlsx.ts` + `CppBulkImportDialog.tsx` | `docs/feature-cpp-bulk-import-xlsx.md` |
| **Multi-Account ASC** (switch account trên UI) | `components/layout/AccountSwitcher.tsx` + `lib/asc-accounts.ts` | `docs/feature-multi-account.md` |
| **Google OAuth + Role-Based Auth** | `lib/auth.ts` + `components/auth/LoginForm.tsx`. Xem feature row Authentication ở trên. | `docs/feature-google-auth.md` |
| **User Footer + Logout** | Tích hợp vào `components/layout/TopNav.tsx` (right side) | — |
| **Delete CPP** (multi-select, 2-step confirm) | `components/cpp/CppList.tsx` + `app/api/asc/cpps/[cppId]/route.ts` | `docs/feature-delete-cpp.md` |
| **Submit CPP for Review v2** (sequential + retry + partial fail UX) | `components/cpp/CppList.tsx` + 3 routes: `submit/prepare`, `submit/confirm`, `submit/[submissionId]` DELETE. State machine `SubmitPhase`. PartialFailDialog. | `docs/feature-submit-cpp.md` |
| **Settings — ASC Accounts (Supabase CRUD)** | Admin-only page. Full CRUD: list/add/edit/delete accounts lưu trong Supabase `asc_accounts` table. Private key mã hóa AES-256-GCM. | `docs/feature-settings-asc-accounts.md` |
| **Asset Validation** (screenshot + video trước upload) | `lib/asset-validator.ts` + `lib/ffmpeg-loader.ts`. Tích hợp vào cả 3 flow upload. Deep mode dùng ffmpeg.wasm. | `docs/feature-asset-validation.md` |

---

## Features chưa làm / còn là stub ⏳

| Feature | Ghi chú | Doc |
|---|---|---|
| 🔴 **API Auth Guard** | 12 API routes không có session check — critical cho Vercel deploy | `docs/feature-security-hardening.md` |
| 🟡 **Client-side Direct Upload** | File upload đang đi qua Vercel server (double bandwidth) | `docs/feature-client-side-upload.md` |
| AppStorePreview tab | Component có nhưng không render gì (empty stub) | — |
| AppStorePreview tab | Component có nhưng không render gì (empty stub) | — |
| Template system | Phase 2 roadmap | — |
| Status dashboard / realtime polling | Phase 2 roadmap | — |

---

## Cấu trúc thư mục quan trọng

```
app/
├── (auth)/login/page.tsx           Server — wrapper (không còn đọc ADMIN_ENABLE)
├── (dashboard)/
│   ├── layout.tsx                  Shell layout (TopNav + AppSubNav + main)
│   ├── apps/page.tsx               Server — App List + export const dynamic
│   └── apps/[appId]/cpps/
│       ├── page.tsx                Server — CPP List
│       ├── new/page.tsx            Client — New CPP form
│       └── [cppId]/page.tsx        Server — CPP Editor page
├── api/asc/                        Proxy routes (server-side only)
│   ├── apps/route.ts               GET /api/asc/apps
│   ├── apps/[appId]/route.ts       GET /api/asc/apps/[appId]
│   ├── apps/[appId]/app-info-localizations/route.ts  GET + POST
│   ├── accounts/route.ts           GET list (public-masked) + active default
│   ├── accounts/active/route.ts    GET active account
│   ├── cpps/route.ts               GET + POST /api/asc/cpps
│   ├── cpps/[cppId]/route.ts       GET + PATCH + DELETE
│   ├── cpps/submit/route.ts        DEPRECATED (giữ lại, không dùng)
│   ├── cpps/submit/prepare/route.ts   POST — Step 1+2, trả per-item result
│   ├── cpps/submit/confirm/route.ts   POST — Step 3, PATCH submitted:true
│   ├── cpps/submit/[submissionId]/route.ts  DELETE — rollback
│   ├── cpps/[cppId]/submit/route.ts  DEPRECATED
│   ├── cpps/[cppId]/localizations/route.ts  POST
│   ├── localizations/[id]/route.ts  PATCH (promo text)
│   ├── versions/[versionId]/route.ts  PATCH (deepLink)
│   ├── screenshot-sets/route.ts    GET + POST
│   ├── preview-sets/route.ts       GET + POST
│   ├── upload/route.ts             POST (screenshot file)
│   └── upload-preview/route.ts     POST (video file)
├── api/admin/
│   ├── asc-accounts/route.ts       GET list + POST create (admin only)
│   └── asc-accounts/[id]/route.ts  PATCH update + DELETE (admin only)
└── page.tsx                        export const dynamic = "force-dynamic" (Railway build fix)

components/
├── auth/
│   └── LoginForm.tsx       Google button only (CredentialsProvider đã xóa)
├── layout/
│   ├── TopNav.tsx
│   ├── AppSubNav.tsx
│   ├── SidebarNav.tsx      DEPRECATED (không dùng trong layout)
│   ├── UserFooter.tsx      DEPRECATED
│   └── AccountSwitcher.tsx
├── apps/AppList.tsx
├── settings/
│   └── SettingsPage.tsx    Full CRUD UI cho ASC accounts (Supabase), xóa admin page riêng
└── cpp/
    ├── CppList.tsx         Submit v2: SubmitPhase state machine + PartialFailDialog
    ├── CppDetailPanel.tsx
    ├── CppEditor.tsx
    ├── LocalizationManager.tsx
    ├── BulkImportDialog.tsx
    ├── CppBulkImportDialog.tsx
    └── AppStorePreview.tsx  stub

lib/
├── asc-client.ts               Tất cả ASC API calls. Thêm: prepareCppSubmission(), confirmCppSubmission(), rollbackCppSubmission()
├── asc-jwt.ts                  JWT signing
├── asc-crypto.ts               AES-256-GCM encrypt/decrypt (ENCRYPTION_KEY env var)
├── asc-account-repository.ts   CRUD + 5-min cache. Supabase nếu env set, fallback env ASC_ACCOUNTS
├── auth.ts                     NextAuth: GoogleProvider only, role admin/member via ADMIN_EMAILS
├── get-active-account.ts       Dùng repository thay vì env trực tiếp
├── use-app-icon.ts
├── locale-map.json
├── locale-utils.ts
├── parseFolderStructure.ts
├── parseCppFolderStructure.ts
├── asset-validator.ts
├── ffmpeg-loader.ts
├── supabase.ts
└── utils.ts

supabase/
└── migrations/
    └── 20260407000000_create_asc_accounts.sql  Table asc_accounts, RLS enabled, service_role only

types/asc.ts            TypeScript types cho ASC API

DELETED FILES:
- app/(dashboard)/admin/asc-accounts/page.tsx  (merged into SettingsPage)
- components/admin/AscAccountsManager.tsx       (merged into SettingsPage)
```

---

## Luồng dữ liệu tổng quan

```
Browser Client
    ↓ fetch /api/asc/...
Next.js API Routes (server)
    ↓ ascFetch() with JWT Bearer token
App Store Connect API (api.appstoreconnect.apple.com)
```

**Quy tắc tuyệt đối:** Không bao giờ gọi ASC API trực tiếp từ client. Tất cả đi qua `/api/asc/`.

---

## Env vars cần có

```env
# Google OAuth
GOOGLE_CLIENT_ID=       # từ Google Cloud Console
GOOGLE_CLIENT_SECRET=   # từ Google Cloud Console
GOOGLE_ALLOWED_EMAILS=  # comma-separated emails được phép login bằng Google

# Role-based auth
ADMIN_EMAILS=           # comma-separated emails có role "admin" (Settings page, admin API)

# ASC Accounts (Supabase storage — primary)
# Accounts lưu trong Supabase asc_accounts table, mã hóa bằng ENCRYPTION_KEY
ENCRYPTION_KEY=         # 64-char hex (32 bytes). Generate: openssl rand -hex 32

# ASC Accounts (env fallback — dùng khi Supabase chưa set hoặc DB rỗng)
ASC_ACCOUNTS=[{"id":"acme","name":"Acme Vietnam","keyId":"...","issuerId":"...","privateKey":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}]

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# NextAuth
NEXTAUTH_SECRET=
NEXTAUTH_URL=

# Asset validation
NEXT_PUBLIC_ASSET_VALIDATION_DEEP=true  # true = ffmpeg.wasm deep | false = basic + checklist

# REMOVED env vars (không còn dùng):
# ADMIN_ENABLE, ADMIN_EMAIL, ADMIN_PASSWORD — CredentialsProvider đã xóa
```

---

## Vấn đề đã biết / Lưu ý kỹ thuật

1. **JSON:API compound document quirk** — Khi fetch với `?include=xxx`:
   - Resources trong `data[]` → `relationships.xxx.data` có IDs → dùng để map
   - Resources trong `included[]` → `relationships.xxx` CHỈ có `links`, KHÔNG có `data` IDs
   - **→ Map screenshot vào set qua `set.relationships.appScreenshots.data` (phía set trong `data`)**

2. **CPP Lifecycle** — Enum `"APPROVED"` (không phải `"ACCEPTED"`)

3. **Screenshot thumbnail URL** — Dùng template:
   ```typescript
   asset.templateUrl.replace("{w}", "390").replace("{h}", "844").replace("{f}", "png")
   ```

4. **`resolveVisibility()`** trong `types/asc.ts` — normalize field vì ASC trả về cả `visible: "VISIBLE"|"HIDDEN"` lẫn `isVisible: boolean` tùy version.

5. **Next.js router cache** — Sau khi tạo CPP mới, phải gọi cả `router.push()` lẫn `router.refresh()` để CPP list reload fresh data.

6. **Device type defaults** — Bulk import dùng `APP_IPHONE_65` (6.5"), không phải `APP_IPHONE_67` (6.7"), vì đây là device type thực tế trong ASC data.

7. **Locale display** — Toàn bộ app hiển thị tên locale theo Apple user-friendly format ("Vietnamese", "English (U.S.)"), không phải short-code. Dùng `localeNameFromCode()` từ `lib/locale-utils.ts`. API calls vẫn dùng short-code.

8. **Locale folder names (CPP Bulk Import + Bulk Import)** — Hỗ trợ cả tên user-friendly ("Vietnamese", "English (U.S.)") lẫn BCP-47 short-code ("vi", "en-US") làm tên folder — backward compatible. Mapping qua `lib/locale-map.json`.

9. **primary-locale.txt (CPP Bulk Import)** — Đặt ở **root folder** (cùng cấp với các CPP folders), dùng chung cho tất cả CPPs mới trong batch. Không dùng file riêng lẻ trong từng CPP folder nữa.

10. **CPP creation 409 fix** — Trước khi tạo CPP mới, nếu primaryLocale có status `"not-in-app"` → gọi `POST /api/asc/apps/${appId}/app-info-localizations` để thêm locale vào app trước, rồi mới tạo CPP. Fallback primaryLocale ưu tiên locale đã có trong app.

11. **Deep Link** — Là field per-**version** (`AppCustomProductPageVersionAttributes.deepLink`), không phải per-locale. Được cập nhật qua `PATCH /api/asc/versions/[versionId]` → `updateCppVersion()` trong `asc-client.ts`. Hiển thị trong:
    - `CppDetailPanel`: phần General (dưới URL, trên Localizations) — luôn hiển thị, fallback "No deep link"
    - `CppEditor`: tab Details — input field optional
    - `BulkImportDialog`: step preview — input field optional
    - `CppBulkImportDialog`: đọc từ `metadata.xlsx` (nếu có) hoặc fallback `deeplink.txt` trong CPP folder

12. **Deep Link optional chaining** — Khi truy cập `data.versions[0]?.attributes?.deepLink`, phải dùng `?.` ở CẢ HAI chỗ: `versions[0]?.attributes?.deepLink`. Nếu dùng `versions[0]?.attributes.deepLink`, sẽ throw TypeError khi `versions` rỗng vì `undefined?.attributes` = `undefined` nhưng `undefined.deepLink` throw.

13. **`VersionWithLocalizations` vs `AppCustomProductPageVersion` — type confusion bug** — `CppDetailPanel` nhận `data.versions: VersionWithLocalizations[]` từ `/api/asc/cpps/[cppId]`. Mỗi phần tử có shape `{ version: AppCustomProductPageVersion, localizations: [...] }`. Phải truy cập `data.versions[0]?.version?.attributes?.deepLink`, **không phải** `data.versions[0]?.attributes?.deepLink` (attributes không tồn tại trực tiếp trên `VersionWithLocalizations`). Ngược lại, `CppEditor` nhận `versions: AppCustomProductPageVersion[]` trực tiếp nên dùng `versions[0]?.attributes.deepLink` là đúng. Đây là lý do Deep Link luôn hiển thị "No deep link" trong Detail Panel dù CppEditor hiển thị đúng.

14. **metadata.xlsx (CPP Bulk Import)** — `metadata.xlsx` optional đặt trong root folder của batch. Khi có: Excel thắng toàn bộ (bỏ qua `deeplink.txt` + `promo.txt`). Columns: `CPP Name` (bắt buộc, case sensitive) | `Deep Link` (bắt buộc) | `<Locale Name>` (user-friendly, dynamic). Parse client-side: `lib/parseMetadataXlsx.ts` dùng SheetJS dynamic import, 5MB limit, formula disabled. CPP không khớp tên → warning badge `⚠ no metadata`. Template tại `public/metadata-template.xlsx` (41 columns, Vietnamese + English (U.S.) ưu tiên đầu). Xem `docs/feature-cpp-bulk-import-xlsx.md`.

15. **Submit CPP — batch review submission flow v2 (session 15)** — 3 endpoints riêng biệt: `POST /prepare` (Step 1+2 sequential với retry + 200ms sleep), `POST /confirm` (Step 3), `DELETE /[submissionId]` (rollback). Frontend dùng `SubmitPhase` state machine + `inPartialFailFlow` boolean. Auto-confirm khi 0 fail; hiển thị `PartialFailDialog` khi có ít nhất 1 fail. Route cũ `POST /api/asc/cpps/submit` deprecated.

16. **Submit CPP — no assets check** — Không check assets trước khi submit. Nếu CPP không có assets, ASC trả về 422 và error được hiển thị trong result dialog per-CPP. Đây là design decision (YAGNI — tránh N+1 calls).

17. **CppList Props mở rộng (session 10)** — `CppList` nhận thêm 2 props: `versionIds: Record<string, string>` và `rejectReasons: Record<string, string>`. `rejectReasons` map cppId → `version.attributes.rejectedVersionUserFeedback` (optional field từ ASC). Cả hai được extract trong `cpps/page.tsx` từ `included[]`.

18. **ResultDialog refactor** — Component `ResultDialog` trong `CppList.tsx` được refactor thêm props `title` và `succeededVerb` để dùng chung cho cả Delete và Submit flows.

19. **Asset Validation — ffmpeg.wasm concurrency mutex** — `validateVideoDeep` dùng module-level promise queue (`ffmpegQueue`) để serialize các calls — Emscripten virtual FS không thread-safe. Bug ban đầu: CPP Bulk Import dùng nested `Promise.all` → nhiều video validate song song → `ErrnoError: FS error` → fallback về basic mode → hiển thị checklist. Fix trong `lib/asset-validator.ts`: acquire queue trước khi gọi ffmpeg, release trong `finally`. Thêm named `logHandler` + `ffmpeg.off()` để tránh listener leak. Screenshots không bị ảnh hưởng (không dùng ffmpeg).

20. **Asset Validation — env var** — `NEXT_PUBLIC_ASSET_VALIDATION_DEEP=true` trong `.env.local`. `true` (default) → ffmpeg.wasm deep validation. `false` → basic only + checklist reminder.

21. **UI Redesign — Top Nav (session 13)** — Bỏ hoàn toàn sidebar trái. Layout mới: `TopNav` (h-14, full width) + `AppSubNav` (h-12, chỉ hiện khi trong `/apps/[id]/...`) + main content full width. `TopNav` gồm: logo `C` xanh + "CPP Manager" | tabs Apps/Settings (blue underline indicator khi active) | AccountSwitcher + user email + logout. `AppSubNav` gồm: colored avatar (hash name → 8 colors, 2 initials) + tên app + `[+ New CPP]` button xanh. `SidebarNav.tsx` và `UserFooter.tsx` còn file nhưng không được dùng trong layout nữa.

22. **App icon — iTunes Lookup API (session 13)** — App card trong AppList fetch icon client-side từ `https://itunes.apple.com/lookup?bundleId={bundleId}&country=vn`. API public, CORS ok, không cần auth. Mỗi `AppIcon` component tự fetch bằng `useEffect` → avatar hiển thị ngay, icon swap in sau. Dùng `<img>` thay `<Image>` (tránh Next.js domain restriction với URL client-fetched). Fallback: colored avatar nếu app chưa publish hoặc fetch lỗi. `iconAssetToken` (ASC API) và `appStoreIcon` đều không hoạt động trên `fields[apps]`.

23. **UI Redesign — session 14 (grid + AppSubNav + CppList)**
    - **App grid:** Bỏ `max-w-6xl` khỏi `apps/page.tsx`. Grid dùng `grid-cols-[repeat(auto-fill,minmax(200px,1fr))]` thay vì hardcode 4 cột — fill full viewport, responsive tự nhiên.
    - **Shared hook `lib/use-app-icon.ts`:** Export `useAppIcon(bundleId)`, `getAvatarColor(name)`, `getInitials(name)`, `AVATAR_COLORS`. Cả `AppList.tsx` và `AppSubNav.tsx` đều import từ đây — không còn duplicate logic.
    - **AppSubNav iTunes icon:** Fetch response `/api/asc/apps/${appId}` cũng extract `bundleId`. `useAppIcon(bundleId)` drive icon — hiển thị `<img>` khi loaded, fallback colored avatar. Không tốn thêm request.
    - **AppSubNav size 2×:** `h-12→h-24`, icon `30px→60px rounded-[16px]`, initials `text-[20px]`, tên app `text-[22px]`, button `px-5 py-3 text-[15px]`, Plus icon `h-5 w-5`.
    - **CppList styling:** `<th>` → `font-semibold text-slate-400 text-[11px] tracking-[0.05em]`. `StatusBadge` thêm colored dot (6px circle từ `STATE_DOT_STYLES`). Action bar buttons: `px-[14px] py-[7px] text-[13px]`, icon 14px.

24. **Auth refactor — Google only + role-based (session 15)** — Xóa hoàn toàn `CredentialsProvider`. `lib/auth.ts` chỉ còn `GoogleProvider`. Role `"admin"|"member"` được gán trong `jwt` callback dựa trên `ADMIN_EMAILS` env var (comma-separated). Settings page guard: `session.user.role !== "admin"` (trước là `email === ADMIN_EMAIL`). `LoginForm.tsx` chỉ còn Google button (không props). `app/(auth)/login/page.tsx` không còn đọc `ADMIN_ENABLE`.

25. **ASC Accounts — Supabase storage (session 15)** — `lib/asc-crypto.ts` encrypt/decrypt AES-256-GCM. `lib/asc-account-repository.ts` abstraction layer với 5-min in-memory cache; dùng Supabase khi `SUPABASE_URL + SERVICE_ROLE_KEY + ENCRYPTION_KEY` đều set, fallback về `ASC_ACCOUNTS` env var khi DB rỗng hoặc chưa configure. Admin CRUD: `/api/admin/asc-accounts` (GET list + POST create) + `/api/admin/asc-accounts/[id]` (PATCH + DELETE). `SettingsPage.tsx` merged từ `AscAccountsManager` (xóa trang `/admin/asc-accounts` riêng). Supabase table `asc_accounts`: RLS enabled, **không** có row-level policies — chỉ service_role key có quyền.

26. **Railway deployment + build fix (session 15)** — Deploy target chính: Railway. `output: "standalone"` trong `next.config.mjs`. Build fail issue: pages gọi `getServerSession` được Next.js cố gắng pre-render static → fail vì `GoogleProvider` đọc env var. Fix: thêm `export const dynamic = "force-dynamic"` vào `app/page.tsx`, `app/(dashboard)/settings/page.tsx`, bất kỳ page nào dùng `getServerSession` trực tiếp. Railway env vars tương đương `.env.local` — set trong Railway project Settings > Variables.
