# Feature: App List, CPP List & CPP Detail Panel

> Đọc file này khi làm việc với: AppList, SidebarNav, CppList, CppDetailPanel, New CPP form.

---

## 1. App List

**File:** `app/(dashboard)/apps/page.tsx` (Server) + `components/apps/AppList.tsx` (Client)

### Luồng
```
Server: getApps() → ASC /v1/apps?limit=50
→ AppList (client) nhận apps[]
→ Search filter (name hoặc bundleId, client-side)
→ Grid của app cards
→ Click → /apps/[appId]/cpps
```

### AppList component
- Search input lọc theo `app.attributes.name` hoặc `app.attributes.bundleId`
- Grid: `grid-cols-[repeat(auto-fill,minmax(200px,1fr))]` — fluid, fill full viewport, không max-width
- Card: icon (iTunes hoặc colored avatar), tên app, bundleId, "View CPPs →" hover link
- `AppIcon` component dùng `useAppIcon(bundleId)` từ `lib/use-app-icon.ts` — hiển thị avatar ngay, swap in iTunes icon sau khi loaded
- Empty state nếu search không có kết quả

---

## 2. App Sub Nav

**File:** `components/layout/AppSubNav.tsx` (Client) — thay thế SidebarNav (deprecated)

### Logic
```typescript
// Extract appId từ pathname
const match = pathname.match(/^\/apps\/([^/]+)/);

// Fetch tên app + bundleId từ /api/asc/apps/${appId}
useEffect(() => {
  fetch(`/api/asc/apps/${appId}`)
    .then(r => r.json())
    .then(data => {
      setAppName(data?.data?.attributes?.name);
      setBundleId(data?.data?.attributes?.bundleId);  // ← dùng cho iTunes icon
    });
}, [appId]);

// Icon: useAppIcon(bundleId) từ lib/use-app-icon.ts
// Hiển thị <img> nếu iconUrl loaded, fallback colored avatar
```

### Sizing (session 14)
- Bar: `h-24` (96px)
- Icon: `w-[60px] h-[60px] rounded-[16px]`
- App name: `text-[22px] font-semibold`
- New CPP button: `px-5 py-3 text-[15px]`, Plus `h-5 w-5`
- Returns `null` khi không có appId trong pathname

---

## 3. CPP List

**File:** `app/(dashboard)/apps/[appId]/cpps/page.tsx` (Server) + `components/cpp/CppList.tsx` (Client)

### Server data fetching
```typescript
const res = await getCpps(params.appId);
// getCpps → GET /v1/apps/${appId}/appCustomProductPages?include=appCustomProductPageVersions

// Extract version states từ included:
const versions = res.included.filter(r => r.type === "appCustomProductPageVersions");
for (const cpp of cpps) {
  const versionIds = cpp.relationships.appCustomProductPageVersions?.data?.map(d => d.id) ?? [];
  const match = versions.find(v => versionIds.includes(v.id));
  versionStates[cpp.id] = match?.attributes.state;
}
```

### CppList component
- Table: checkbox | Name | Status | Visibility | CPP URL | ID | Actions
- **`<th>` styling:** `font-semibold text-slate-400 text-[11px] uppercase tracking-[0.05em]`
- **StatusBadge:** `inline-flex gap-[5px] rounded-full px-[9px] py-[2px]` — có colored dot (6px circle từ `STATE_DOT_STYLES`) trước label text

| State | Background | Text | Dot |
|---|---|---|---|
| PREPARE_FOR_SUBMISSION (Draft) | slate-100 | slate-600 | slate-400 |
| READY_FOR_REVIEW | blue-50 | blue-700 | blue-500 |
| WAITING_FOR_REVIEW | yellow-50 | yellow-700 | yellow-500 |
| IN_REVIEW | orange-50 | orange-700 | orange-500 |
| APPROVED | green-50 | green-700 | green-500 |
| REJECTED | red-50 | red-700 | red-500 |

- **Action bar buttons:** `px-[14px] py-[7px] text-[13px]`, icon 14px
- **View button** → mở `CppDetailPanel`
- **Edit link** → navigate tới `/apps/[appId]/cpps/[cppId]`

---

## 4. CPP Detail Panel

**File:** `components/cpp/CppDetailPanel.tsx` (Client)

### Data fetching
```typescript
// Fetch khi panel mở:
GET /api/asc/cpps/${cppId}
→ { cpp, versions: VersionWithLocalizations[] }

// VersionWithLocalizations:
{
  version: AppCustomProductPageVersion,
  localizations: Array<{
    localization: AppCustomProductPageLocalization,
    screenshotSets: Array<{ set: AppScreenshotSet, screenshots: AppScreenshot[] }>,
    previewSets: Array<{ set: AppPreviewSet, previews: AppPreview[] }>
  }>
}
```

### Layout
- Modal centered với backdrop (không phải slide-over mặc dù tên có "Panel")
- Fixed header: CPP name + X button
- Scrollable body:
  - **General info:** Name, Visibility, URL (nếu có), **Deep Link** (luôn hiển thị — "No deep link" nếu chưa set)
  - **Versions:** State badge per version (chỉ còn label "Localizations" + state badge, không có Deep Link nữa)
  - **Localizations** (collapsible per locale):
    - Promotional text (hiển thị hoặc "Not set")
    - Screenshots nhóm theo device type (thumbnails)
    - App Previews nhóm theo device type (thumbnail + play icon overlay)

> **Lưu ý quan trọng:** `data.versions` là `VersionWithLocalizations[]` (shape: `{ version, localizations }`), không phải `AppCustomProductPageVersion[]`. Phải truy cập `data.versions[0]?.version?.attributes?.deepLink` — không phải `data.versions[0]?.attributes?.deepLink` (sẽ luôn `undefined`). Đây là nguồn gốc bug "No deep link" dù CPP có deepLink thực.

### Thumbnail URLs
```typescript
// Screenshots:
asset.attributes.imageAsset?.templateUrl
  .replace("{w}", "390").replace("{h}", "844").replace("{f}", "png")

// Previews:
preview.attributes.previewImage?.templateUrl
  .replace("{w}", "390").replace("{h}", "844").replace("{f}", "png")
```

---

## 5. New CPP Form

**File:** `app/(dashboard)/apps/[appId]/cpps/new/page.tsx` (Client)

### Form fields
- **CPP Name** (required) — internal name, không hiển thị trên App Store
- **Primary Locale** (required) — dropdown từ `SUPPORTED_LOCALES[]`

### Submit flow
```typescript
POST /api/asc/cpps  { appId, name, locale }
→ ASC tạo CPP + initial version + localization trong một request
→ router.push(`/apps/${appId}/cpps`)
→ router.refresh()  // ← quan trọng: invalidate Next.js router cache để list reload
```

### Supported locales
```
en-US, en-GB, vi, ja, zh-Hans, zh-Hant, ko, fr-FR, de-DE, es-ES, pt-BR
```

---

## API Route: GET+PATCH /api/asc/cpps/[cppId]

**File:** `app/api/asc/cpps/[cppId]/route.ts`

GET trả về enriched object (không phải raw ASC response):
```typescript
{
  cpp: AppCustomProductPage,
  versions: Array<{
    version: AppCustomProductPageVersion,
    localizations: Array<{
      localization: AppCustomProductPageLocalization,
      screenshotSets: Array<{ set: AppScreenshotSet, screenshots: AppScreenshot[] }>,
      previewSets: Array<{ set: AppPreviewSet, previews: AppPreview[] }>
    }>
  }>
}
```

**JSON:API mapping logic trong route này:**
```typescript
// Map screenshots vào đúng set:
// ✅ Dùng: set.relationships.appScreenshots.data (trong mảng data)
// ❌ Không dùng: screenshot.relationships.appScreenshotSet.data (trong included — không có .data)

// Fallback nếu relationship data bị thiếu:
// So sánh screenshot IDs với tất cả screenshots có trong included
```

---

## 6. API Route: PATCH /api/asc/versions/[versionId]

**File:** `app/api/asc/versions/[versionId]/route.ts`

Cập nhật Deep Link cho một CPP version:
```typescript
PATCH /api/asc/versions/${versionId}
Body: { deepLink: string }
→ updateCppVersion(versionId, deepLink) trong asc-client.ts
→ PATCH /v1/appCustomProductPageVersions/${versionId}
   body: { data: { type, id, attributes: { deepLink } } }
```

Được gọi từ:
- `CppEditor.tsx` — sau khi save nếu `deepLink.trim()` có giá trị
- `BulkImportDialog.tsx` — sau khi upload tất cả locale, nếu user nhập deep link
- `CppBulkImportDialog.tsx` — sau khi lấy `versionId`, nếu `plan.deepLink` có giá trị
