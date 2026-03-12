# CPP Manager — Trạng thái hiện tại

> **Đây là file đọc đầu tiên** khi bắt đầu session mới. Cung cấp toàn cảnh dự án, features đã làm và chưa làm.
>
> Last updated: 2026-03-12

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
| Authentication (email/password) | `app/(auth)/login/page.tsx` | `docs/architecture.md` |
| CPP List + trạng thái | `app/(dashboard)/apps/[appId]/cpps/page.tsx` | `docs/feature-app-cpp-list.md` |
| CPP Detail Panel (view) | `components/cpp/CppDetailPanel.tsx` | `docs/feature-app-cpp-list.md` |
| New CPP form | `app/(dashboard)/apps/[appId]/cpps/new/page.tsx` | — |
| CPP Editor (tabs: Overview/Details/Assets) | `components/cpp/CppEditor.tsx` | `docs/feature-cpp-editor.md` |
| Localization Manager | `components/cpp/LocalizationManager.tsx` | `docs/feature-cpp-editor.md` |
| Manual Asset Upload (screenshot + preview) | `components/cpp/LocalizationManager.tsx` | `docs/feature-cpp-editor.md` |
| **Bulk Import** (folder → multi-locale upload) | `components/cpp/BulkImportDialog.tsx` | `docs/bulk-import-design.md` |

---

## Features chưa làm / còn là stub ⏳

| Feature | Ghi chú |
|---|---|
| Settings page (ASC credentials) | UI stub có, nhưng không có endpoint lưu — env vars được hardcode trong `.env.local` |
| AppStorePreview tab | Component có nhưng không render gì (empty stub) |
| Submit CPP for Review | Chưa implement submit flow |
| Delete CPP | Có `deleteCpp()` trong asc-client nhưng không có UI |
| Template system | Phase 2 roadmap |
| Status dashboard / realtime polling | Phase 2 roadmap |

---

## Cấu trúc thư mục quan trọng

```
app/
├── (auth)/login/page.tsx           Client — form đăng nhập
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
│   ├── cpps/[cppId]/route.ts       GET + PATCH
│   ├── cpps/[cppId]/localizations/route.ts  POST
│   ├── localizations/[id]/route.ts  PATCH (promo text)
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
    ├── BulkImportDialog.tsx        ← ~763 lines
    └── AppStorePreview.tsx         stub

lib/
├── asc-client.ts       Tất cả ASC API calls (server-side only)
├── asc-jwt.ts          JWT signing
├── auth.ts             NextAuth config
├── parseFolderStructure.ts  Parser cho bulk import
├── supabase.ts         Supabase client
└── utils.ts            cn() helper

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
ASC_KEY_ID=            # Key ID từ App Store Connect
ASC_ISSUER_ID=         # Issuer ID
ASC_PRIVATE_KEY=       # Nội dung file .p8 (multiline, không cần quote)
ADMIN_EMAIL=           # Email đăng nhập dashboard
ADMIN_PASSWORD=        # Password đăng nhập dashboard
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
