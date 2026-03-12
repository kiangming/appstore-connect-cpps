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
- Card: emoji 📱, tên app, bundleId, "View CPPs →" link
- Empty state nếu search không có kết quả

---

## 2. Sidebar Navigation

**File:** `components/layout/SidebarNav.tsx` (Client)

### Logic
```typescript
// Extract appId từ pathname: /apps/[appId]/...
const match = pathname.match(/\/apps\/([^/]+)/);
const appId = match?.[1] ?? null;

// Fetch tên app nếu có appId
useEffect(() => {
  if (appId) fetch(`/api/asc/apps/${appId}`) → setAppName(...)
}, [appId]);
```

### Nav items
- **CPP List** → `/apps/[appId]/cpps`
- **New CPP** → `/apps/[appId]/cpps/new`
- **Settings** → `/settings` (bottom)

Active link: `text-[#0071E3]` (Apple blue)

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
- Table: Name | Status badge | Visibility | ID
- **Status badge colors:**

| State | Màu |
|---|---|
| PREPARE_FOR_SUBMISSION | Blue (Draft) |
| READY_FOR_REVIEW | Yellow |
| WAITING_FOR_REVIEW | Yellow |
| IN_REVIEW | Orange |
| APPROVED | Green |
| REJECTED | Red |
| (undefined) | Gray |

- **View button** → mở `CppDetailPanel` (slide-over)
- **Edit link** → navigate tới `/apps/[appId]/cpps/[cppId]`
- "+ New CPP" button → `/apps/[appId]/cpps/new`

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
  - **General info:** Name, Visibility badge, URL, CPP ID
  - **Versions:** State badge per version
  - **Localizations** (collapsible per locale):
    - Promotional text (hiển thị hoặc "—")
    - Screenshots nhóm theo device type (thumbnails 80×160)
    - App Previews nhóm theo device type (thumbnail + play icon overlay)

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
