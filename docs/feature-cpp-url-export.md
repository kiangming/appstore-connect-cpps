# Feature: CPP URL Display & Export CSV

**Date:** 2026-03-12
**Status:** ✅ Implemented
**Scope:** Hiển thị CPP URL trong CppList table + Export toàn bộ CPP list ra file CSV

---

## Mục tiêu

- **F1 — CPP URL column:** Cho phép team nhìn và copy URL của từng CPP trực tiếp từ danh sách, không cần mở detail panel hay vào App Store Connect
- **F2 — Export CSV:** Cho phép export toàn bộ danh sách CPP của một app ra file CSV để chia sẻ hoặc lưu trữ ngoài hệ thống

---

## Understanding Lock (confirmed)

- **F1:** Thêm cột `CPP URL` vào table CppList — hiển thị `cpp.attributes.url`, copy icon bên cạnh, click mở tab mới
- **F2:** Button "Export CSV" ở header page — 1 file duy nhất cho toàn bộ CPPs, gồm: Name, Status, URL
- `cpp.attributes.url` luôn có giá trị (Apple set khi tạo CPP)
- Data đã có sẵn trên client — không cần API call thêm
- Người dùng: Team nội bộ 2–5 người

**Non-goals:**
- Không filter/sort trước khi export
- Không server-side export
- Không pagination

---

## Assumptions

| # | Assumption |
|---|---|
| A1 | Copy URL dùng `navigator.clipboard.writeText()` — feedback bằng đổi icon từ `Copy` → `Check` trong 1.5s, sau đó revert |
| A2 | URL trong table: truncate nếu dài (CSS `max-w` + `truncate`), full URL hiện qua `title` attribute khi hover |
| A3 | Tên file CSV: `cpps-{YYYY-MM-DD}.csv` (vd: `cpps-2026-03-12.csv`) |
| A4 | CSV generate hoàn toàn client-side, download qua `<a href="data:text/csv...">` trigger |
| A5 | Status trong CSV dùng **label hiển thị** ("Draft", "Approved"...), không phải raw enum |
| A6 | Export toàn bộ list hiện tại (không filter) |

---

## Design

### F1 — Cột CPP URL trong CppList

**Vị trí cột:** Thêm sau cột Visibility, trước cột ID.

**Table columns sau khi cập nhật:**
```
Name | Status | Visibility | CPP URL | ID | Actions
```

**Cell layout (khi có URL):**
```
┌─────────────────────────────────────────────┐
│  https://apps.apple.com/us/app/... [copy]   │
└─────────────────────────────────────────────┘
```
- URL text: `text-xs font-mono text-[#0071E3]`, truncate nếu quá dài, `title={url}` để hover thấy full
- Click vào URL text → mở tab mới (`target="_blank"`)
- Copy icon (`Copy` từ lucide-react, `h-3.5 w-3.5`): nằm ngay bên phải URL text
  - Click → `navigator.clipboard.writeText(url)` → icon đổi thành `Check` (green) trong 1.5s → revert về `Copy`
  - Prevent propagation để không trigger row click / View panel

**State management cho copy feedback:**
```typescript
const [copiedId, setCopiedId] = useState<string | null>(null);

function handleCopy(cppId: string, url: string) {
  navigator.clipboard.writeText(url);
  setCopiedId(cppId);
  setTimeout(() => setCopiedId(null), 1500);
}
```

---

### F2 — Export CSV

**Button placement:** Header của CPP List page, cùng hàng với "Bulk Import CPPs" và "+ New CPP"

**Header layout sau khi cập nhật:**
```
┌──────────────────────────────────────────────────────────────────┐
│ Custom Product Pages                                             │
│ Manage CPPs for [app name]                              [appId]  │
│                                                                  │
│              [Export CSV]  [Bulk Import CPPs]  [+ New CPP]      │
└──────────────────────────────────────────────────────────────────┘
```

- **"Export CSV" button:** outline style (border, white bg), icon `Download` (lucide-react, `h-4 w-4`)
- Phân biệt với "+ New CPP" (solid blue) và "Bulk Import CPPs" (outline nhưng không có icon)

**CSV format:**
```
Name,Status,URL
Summer Campaign,Draft,https://apps.apple.com/us/app/myapp/id123?ppid=abc
Holiday Sale,Approved,https://apps.apple.com/us/app/myapp/id123?ppid=def
```

**CSV generation logic:**
```typescript
function exportCsv(cpps: AppCustomProductPage[], versionStates: Record<string, CppState | undefined>) {
  const header = ["Name", "Status", "URL"];
  const rows = cpps.map((cpp) => [
    `"${cpp.attributes.name.replace(/"/g, '""')}"`,       // escape quotes
    `"${STATE_LABELS[versionStates[cpp.id]!] ?? ""}"`,
    `"${cpp.attributes.url ?? ""}"`,
  ]);

  const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cpps-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

---

## Mockup

### CppList Table

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Custom Product Pages                                                        │
│ 12 CPPs · com.example.app                                                  │
│                              [Export CSV ↓]  [Bulk Import CPPs]  [+ New]  │
├────────────────┬──────────┬────────────┬──────────────────────────────┬────┤
│ Name           │ Status   │ Visibility │ CPP URL                      │ ID │
├────────────────┼──────────┼────────────┼──────────────────────────────┼────┤
│ Summer Campaign│ [Draft]  │ Visible    │ apps.apple.com/us/... [📋]   │ ...│
│ Holiday Sale   │ [Approved]│ Hidden    │ apps.apple.com/us/... [✓]   │ ...│
│ Promo Q1       │ [Review] │ Visible    │ apps.apple.com/us/... [📋]   │ ...│
└────────────────┴──────────┴────────────┴──────────────────────────────┴────┘
```

Ghi chú:
- `[📋]` = Copy icon (mặc định)
- `[✓]` = Check icon màu xanh lá (vừa copy xong, revert sau 1.5s)
- URL text màu `#0071E3`, click mở tab mới
- URL truncate với `max-w-[200px]` hoặc tương tự

---

## Files cần sửa

| File | Action | Ghi chú |
|---|---|---|
| `components/cpp/CppList.tsx` | **Sửa** | Thêm cột CPP URL, copy state, Export CSV button + handler |

**Không cần thêm file mới, không cần API route mới.**

---

## Edge Cases

| Tình huống | Hành vi |
|---|---|
| `navigator.clipboard` không available (HTTP, old browser) | Wrap trong try/catch — silent fail (không crash) |
| CPP list rỗng (0 CPPs) | Button Export CSV vẫn hiện, download file CSV chỉ có header row |
| Tên CPP chứa dấu phẩy hoặc ngoặc kép | Escape bằng RFC 4180: wrap trong `"..."`, double `""` cho ngoặc kép |

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| CPP URL là cột riêng trong table | Inline dưới tên CPP, tooltip, hover card | Cột riêng dễ scan nhất; consistent với layout table hiện tại |
| Copy feedback bằng đổi icon 1.5s | Toast notification, tooltip "Copied!" | Nhẹ nhàng nhất, không cần thêm component; icon Check ngay bên cạnh rõ ràng |
| Export CSV client-side (Blob + `<a>`) | Server-side CSV endpoint, server-side streaming | Không cần API call mới; data đã có sẵn trên client; team nhỏ không cần streaming |
| Status trong CSV là label ("Draft") | Raw enum ("PREPARE_FOR_SUBMISSION") | Dễ đọc khi mở trong Excel/Sheets; nhất quán với UI display |
| Tên file `cpps-{date}.csv` | `cpps-{appName}-{date}.csv` | Đơn giản; tránh ký tự đặc biệt trong tên app gây lỗi filesystem |
| Button Export CSV ở header (cùng hàng các action buttons) | Footer table, dropdown menu | Consistent với pattern hiện tại (Bulk Import CPPs cũng ở header) |

---

## Implementation Plan

1. **`components/cpp/CppList.tsx`:**
   - Thêm `useState<string | null>(null)` cho `copiedId`
   - Thêm hàm `handleCopy(cppId, url)`
   - Thêm hàm `handleExportCsv()`
   - Thêm button "Export CSV" vào header (trước "Bulk Import CPPs")
   - Thêm cột `CPP URL` vào `<thead>` và `<tbody>` rows
   - Import `Copy`, `Check`, `Download` từ `lucide-react`
