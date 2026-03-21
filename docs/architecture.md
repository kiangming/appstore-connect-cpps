# Architecture & Technical Patterns

> Đọc file này khi cần hiểu pattern, convention, hoặc làm việc với ASC API.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 14 App Router + TypeScript (strict mode) |
| UI | Tailwind CSS + Lucide React icons |
| Auth | NextAuth.js v4 (credentials provider, JWT strategy) |
| ASC API Auth | `jose` library (ES256 JWT signing, server-side only) |
| File Upload | Native drag-drop + FormData |
| Database | Supabase (khởi tạo xong nhưng chưa có schema/queries thực) |
| Config | `next.config.mjs` (ESM format, không dùng `.ts`) |

---

## ASC API Authentication

```typescript
// lib/asc-jwt.ts
// JWT payload:
{
  iss: process.env.ASC_ISSUER_ID,
  aud: "appstoreconnect-v1",
  exp: now + 20 * 60  // max 20 phút
}
// Header: ES256, kid: process.env.ASC_KEY_ID
// Private key: process.env.ASC_PRIVATE_KEY (nội dung file .p8 dạng PKCS#8)
```

**Tất cả ASC calls** đi qua `ascFetch()` trong `lib/asc-client.ts`:
```typescript
async function ascFetch<T>(method, endpoint, body?): Promise<T>
// - Tự generate JWT mỗi call
// - Log: [ASC] METHOD endpoint → status
// - Throw Error nếu !res.ok (kèm response body)
// - Return undefined nếu status 204
```

---

## Routing & Data Fetching Pattern

### Server Components (data fetching)
```typescript
// app/(dashboard)/apps/[appId]/cpps/page.tsx — pattern điển hình
export default async function CppsPage({ params }: Props) {
  try {
    const res = await getCpps(params.appId);  // direct asc-client call
    // process data...
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed";
  }
  return <ClientComponent data={data} />;
}
```

### Client Components (interactivity)
- Gọi `/api/asc/...` qua `fetch()`
- Không bao giờ import từ `lib/asc-client.ts` (server-side only)

### API Routes (proxy layer)
```typescript
// Pattern chuẩn của mọi API route:
export async function GET/POST/PATCH(req, { params }) {
  try {
    const result = await ascClientFunction(params.xxx);
    return NextResponse.json(result, { status: 200/201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] METHOD /path error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

---

## ASC API — JSON:API Quirks

### Compound documents (`?include=xxx`)

```
GET /v1/appCustomProductPageLocalizations/{id}/appScreenshotSets?include=appScreenshots
Response:
{
  data: [                         ← Screenshot SETS
    {
      id: "set-1",
      attributes: { screenshotDisplayType: "APP_IPHONE_65" },
      relationships: {
        appScreenshots: {
          data: [{ id: "ss-1" }, { id: "ss-2" }]  ← IDs có ở đây ✅
        }
      }
    }
  ],
  included: [                     ← Screenshots
    {
      id: "ss-1",
      attributes: { imageAsset: { templateUrl: "..." } },
      relationships: {
        appScreenshotSet: {
          // CHỈ có links, KHÔNG có data.id ❌
        }
      }
    }
  ]
}
```

**→ Luôn map từ phía `set.relationships.appScreenshots.data`** (trong mảng `data`), không từ `screenshot.relationships.appScreenshotSet` (trong `included`).

### Screenshot Thumbnail URL

```typescript
asset.attributes.imageAsset?.templateUrl
  .replace("{w}", "80")    // thumbnail nhỏ trong LocalizationManager
  .replace("{h}", "160")
  .replace("{f}", "png")

// Hoặc cho full size trong CppDetailPanel:
  .replace("{w}", "390")
  .replace("{h}", "844")
  .replace("{f}", "png")
```

### Preview (Video) Thumbnail

```typescript
preview.attributes.previewImage?.templateUrl  // dùng previewImage, không phải imageAsset
  .replace("{w}", "80").replace("{h}", "160").replace("{f}", "png")
```

---

## Asset Upload Flow (2-step)

### Screenshots
```
1. POST /api/asc/upload  (FormData: { screenshotSetId, file })
   → route.ts gọi:
   a. reserveScreenshot(setId, fileName, fileSize)  → { id, uploadOperations }
   b. uploadAssetToOperations(uploadOperations, file)  → PUT chunks to presigned URLs
   c. Tính MD5 checksum (SubtleCrypto hoặc server fallback)
   d. confirmScreenshot(screenshotId, checksum)  → { uploaded: true }
```

### App Previews (Video)
```
1. POST /api/asc/upload-preview  (FormData: { previewSetId, file })
   → Tương tự screenshot nhưng:
   a. reservePreview(setId, fileName, fileSize, mimeType)
   b. uploadAssetToOperations(...)
   c. confirmPreview(previewId, checksum)
```

### Screenshot Set management
- `screenshotDisplayType` → group theo device: `APP_IPHONE_65`, `APP_IPAD_PRO_3GEN_129`, v.v.
- Một localization có thể có nhiều set (một per device type)
- 409 Conflict khi tạo set đã tồn tại → re-fetch để lấy ID

---

## CPP Resource Hierarchy

```
App
└── AppCustomProductPage (CPP)
    └── AppCustomProductPageVersion  (state: PREPARE_FOR_SUBMISSION → APPROVED/REJECTED)
        └── AppCustomProductPageLocalization  (per locale, e.g. en-US, vi)
            ├── AppScreenshotSet  (per device type)
            │   └── AppScreenshot
            └── AppPreviewSet  (per device type)
                └── AppPreview
```

### Tạo CPP mới — Payload đặc biệt
`createCpp()` dùng "included" pattern của JSON:API để tạo CPP + version + localization trong một request:
```typescript
POST /v1/appCustomProductPages
body: {
  data: { type: "appCustomProductPages", ... },
  included: [
    { type: "appCustomProductPageVersions", id: "${new-...}", ... },
    { type: "appCustomProductPageLocalizations", id: "${new-...}", attributes: { locale } }
  ]
}
```

### Tạo thêm localization cho CPP đã có
```typescript
// createCppLocalization() — link trực tiếp vào CPP (không phải version)
POST /v1/appCustomProductPageLocalizations
relationships: { appCustomProductPage: { data: { id: cppId } } }
```

---

## TypeScript Types (types/asc.ts)

Key types:
```typescript
type CppState = "PREPARE_FOR_SUBMISSION" | "READY_FOR_REVIEW" | "WAITING_FOR_REVIEW"
              | "IN_REVIEW" | "APPROVED" | "REJECTED"

type ScreenshotDisplayType = "APP_IPHONE_67" | "APP_IPHONE_65" | "APP_IPHONE_61"
                           | "APP_IPHONE_55" | "APP_IPHONE_47"
                           | "APP_IPAD_PRO_3GEN_129" | "APP_IPAD_PRO_3GEN_11"
                           | "APP_IPAD_PRO_129" | "APP_IPAD_105"

type PreviewType = "IPHONE_67" | "IPHONE_65" | "IPHONE_61" | "IPHONE_58"
                 | "IPHONE_55" | "IPHONE_47" | "IPHONE_40"
                 | "IPAD_PRO_3GEN_129" | "IPAD_PRO_3GEN_11" | "IPAD_PRO_129"
                 | "IPAD_105" | "IPAD_97"

// resolveVisibility() — normalize field visibility
// ASC trả về cả visible: "VISIBLE"|"HIDDEN" và isVisible: boolean
function resolveVisibility(cpp): boolean
```

---

## Authentication (NextAuth)

```typescript
// lib/auth.ts
// - Credentials provider: ADMIN_EMAIL + ADMIN_PASSWORD từ env
// - Strategy: JWT (không cần database session)
// - Session chứa: { user: { id, name, email } }
```

Tất cả dashboard pages được protect bởi `SessionProvider` + middleware (nếu cần).

---

## Locales được hỗ trợ (hardcoded)

```
en-US, en-GB, vi, ja, zh-Hans, zh-Hant, ko, fr-FR, de-DE, es-ES, pt-BR
```

Dùng ở: New CPP form, LocalizationManager "Add locale" dropdown.

---

## UI Layout

### Shell Layout (`app/(dashboard)/layout.tsx`)
```
┌──────────────────────────────────────────────────────────────┐
│  TopNav (h-14)  Logo | Apps · Settings | AccountSwitcher 👤  │
├──────────────────────────────────────────────────────────────┤
│  AppSubNav (h-12, chỉ hiện khi /apps/[id]/...)               │
│  [🎨] App Name                           [+ New CPP]         │
├──────────────────────────────────────────────────────────────┤
│  main (flex-1, overflow-y-auto, bg-slate-50)                 │
│  {children}                                                  │
└──────────────────────────────────────────────────────────────┘
```

- **Không còn sidebar** — bỏ hoàn toàn `SidebarNav` + `UserFooter` khỏi layout
- `TopNav` — client component, dùng `usePathname()` cho active tab highlight
- `AppSubNav` — client component, extract `appId` từ `usePathname()`, fetch app name từ `/api/asc/apps/${appId}`
- `AccountSwitcher` — ẩn khi chỉ có 1 account

### App List (`/apps`)
- Grid 4 cột responsive: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`
- App icon: fetch client-side từ iTunes Lookup API (`itunes.apple.com/lookup?bundleId=...&country=vn`) bằng `useEffect` trong `AppIcon` component
- Fallback: colored avatar (hash app name → 8 preset colors, 2 initials)

---

## Conventions

- **Server Components** cho data fetching, **Client Components** cho interactivity
- Tất cả error responses: `{ error: string }` với HTTP status phù hợp
- Log format: `[API] METHOD /path error:` và `[ASC] METHOD endpoint → status`
- File config: `next.config.mjs` (ESM), không dùng `.ts`
- TypeScript strict mode bật
