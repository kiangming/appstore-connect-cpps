# CPP Manager — Trạng thái hiện tại

> **Đây là file đọc đầu tiên** khi bắt đầu session mới. Cung cấp toàn cảnh dự án, features đã làm và chưa làm.
>
> Last updated: 2026-03-13 (session 10)

---

## Tóm tắt nhanh

Web dashboard nội bộ để quản lý App Store Connect Custom Product Pages (CPP) mà không cần vào UI của Apple.
- **Tech:** Next.js 14 App Router + TypeScript + Tailwind CSS + NextAuth + Supabase
- **Deploy:** Vercel hoặc Docker
- **Người dùng:** Team nội bộ 2–5 người

---

## Features đã hoàn thành ✅

| Feature | Entry point | Doc chi tiết |
|---|---|---|
| App List + Search | `app/(dashboard)/apps/page.tsx` | `docs/feature-app-cpp-list.md` |
| Sidebar động (tên app) | `components/layout/SidebarNav.tsx` | `docs/feature-app-cpp-list.md` |
| Authentication (Google OAuth + email/password) | `app/(auth)/login/page.tsx` + `lib/auth.ts` | `docs/feature-google-auth.md` |
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
| **Google OAuth + Admin Login Control** | `lib/auth.ts` + `components/auth/LoginForm.tsx` | `docs/feature-google-auth.md` |
| **User Footer + Logout** | `components/layout/UserFooter.tsx` | — |
| **Delete CPP** (multi-select, 2-step confirm) | `components/cpp/CppList.tsx` + `app/api/asc/cpps/[cppId]/route.ts` | `docs/feature-delete-cpp.md` |
| **Submit CPP for Review** (multi-select, parallel submit, reject tooltip) | `components/cpp/CppList.tsx` + `app/api/asc/cpps/[cppId]/submit/route.ts` | `docs/feature-submit-cpp.md` |

---

## Features chưa làm / còn là stub ⏳

| Feature | Ghi chú |
|---|---|
| Settings page (ASC credentials) | UI stub có, nhưng không có endpoint lưu — accounts khai báo qua `ASC_ACCOUNTS` env var |
| AppStorePreview tab | Component có nhưng không render gì (empty stub) |
| Template system | Phase 2 roadmap |
| Status dashboard / realtime polling | Phase 2 roadmap |

---

## Cấu trúc thư mục quan trọng

```
app/
├── (auth)/login/page.tsx           Server — wrapper, đọc ADMIN_ENABLE
├── (dashboard)/
│   ├── layout.tsx                  Shell layout (sidebar + main)
│   ├── apps/page.tsx               Server — App List
│   └── apps/[appId]/cpps/
│       ├── page.tsx                Server — CPP List
│       ├── new/page.tsx            Client — New CPP form
│       └── [cppId]/page.tsx        Server — CPP Editor page
├── api/asc/                        Proxy routes (server-side only)
│   ├── apps/route.ts               GET /api/asc/apps
│   ├── apps/[appId]/route.ts       GET /api/asc/apps/[appId]
│   ├── apps/[appId]/app-info-localizations/route.ts  GET + POST
│   ├── cpps/route.ts               GET + POST /api/asc/cpps
│   ├── cpps/[cppId]/route.ts       GET + PATCH + DELETE
│   ├── cpps/[cppId]/submit/route.ts  POST (submit for review)   ← MỚI
│   ├── cpps/[cppId]/localizations/route.ts  POST
│   ├── localizations/[id]/route.ts  PATCH (promo text)
│   ├── versions/[versionId]/route.ts  PATCH (deepLink)   ← MỚI
│   ├── screenshot-sets/route.ts    GET + POST
│   ├── preview-sets/route.ts       GET + POST
│   ├── upload/route.ts             POST (screenshot file)
│   └── upload-preview/route.ts     POST (video file)

components/
├── layout/SidebarNav.tsx
├── apps/AppList.tsx
└── cpp/
    ├── CppList.tsx
    ├── CppDetailPanel.tsx
    ├── CppEditor.tsx
    ├── LocalizationManager.tsx     ← Component lớn nhất (~900 lines)
    ├── BulkImportDialog.tsx        ← Bulk Import (assets cho 1 CPP)
    ├── CppBulkImportDialog.tsx     ← CPP Bulk Import (tạo nhiều CPP)
    └── AppStorePreview.tsx         stub

lib/
├── asc-client.ts               Tất cả ASC API calls (server-side only)
├── asc-jwt.ts                  JWT signing
├── auth.ts                     NextAuth config
├── locale-map.json             39 Apple locales: friendly name → BCP-47 code
├── locale-utils.ts             localeCodeFromName(), localeNameFromCode(), ALL_APPLE_LOCALES
├── parseFolderStructure.ts     Parser cho Bulk Import (single CPP)
├── parseCppFolderStructure.ts  Parser cho CPP Bulk Import (multi-CPP)
├── supabase.ts                 Supabase client
└── utils.ts                    cn() helper

types/asc.ts            Tất cả TypeScript types cho ASC API
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
# Multi-account (recommended) — JSON array, 1 env var duy nhất:
ASC_ACCOUNTS=[{"id":"acme","name":"Acme Vietnam","keyId":"...","issuerId":"...","privateKey":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}]

# Single-account (backward compat) — dùng khi không set ASC_ACCOUNTS:
# ASC_KEY_ID=
# ASC_ISSUER_ID=
# ASC_PRIVATE_KEY=

GOOGLE_CLIENT_ID=      # Google OAuth — từ Google Cloud Console
GOOGLE_CLIENT_SECRET=  # Google OAuth — từ Google Cloud Console
GOOGLE_ALLOWED_EMAILS= # comma-separated emails được phép login bằng Google
ADMIN_ENABLE=1         # 1 = hiển thị form email/password | 0 hoặc không set = ẩn
ADMIN_EMAIL=           # Email đăng nhập dashboard (credentials login)
ADMIN_PASSWORD=        # Password đăng nhập dashboard (credentials login)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
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

15. **Submit CPP — versionId source** — `versionId` cần cho submit (`POST /v1/appCustomProductPageSubmissions`) lấy từ `included[]` trong response của list API (`GET /v1/apps/{appId}/appCustomProductPages?include=appCustomProductPageVersions`). Page extract thành `versionIds: Record<string, string>` (cppId → versionId) và pass xuống `CppList`. Không cần gọi thêm API.

16. **Submit CPP — no assets check** — Không check assets trước khi submit. Nếu CPP không có assets, ASC trả về 422 và error được hiển thị trong result dialog per-CPP. Đây là design decision (YAGNI — tránh N+1 calls).

17. **CppList Props mở rộng (session 10)** — `CppList` nhận thêm 2 props: `versionIds: Record<string, string>` và `rejectReasons: Record<string, string>`. `rejectReasons` map cppId → `version.attributes.rejectedVersionUserFeedback` (optional field từ ASC). Cả hai được extract trong `cpps/page.tsx` từ `included[]`.

18. **ResultDialog refactor** — Component `ResultDialog` trong `CppList.tsx` được refactor thêm props `title` và `succeededVerb` để dùng chung cho cả Delete và Submit flows.
