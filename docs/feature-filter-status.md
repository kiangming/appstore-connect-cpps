# Feature: Filter theo Status ở CPP List

> Status: ✅ Implemented (2026-03-16)

---

## Tổng quan

Filter client-side theo Status cho CPP List. Data đã fetch đủ server-side, không cần thêm API call.

---

## Behavior

- **UI:** Nút "Status ▾" trong action bar, click mở dropdown multi-select
- **Không filter nào = hiển thị tất cả** CPPs
- **Chọn 1+ status** = chỉ hiển thị CPPs thuộc các status đó
- **Selection state là global** — không bị clear khi đổi filter
- **"Select all"** chỉ select CPPs đang visible trong filtered list
- **Actions (Submit/Delete)** chỉ tác động lên CPPs đang visible và được chọn

### Ví dụ
- Filter = Draft → 10 CPPs hiển thị
- "Select all" → chọn 10 cái
- Submit → submit 10 cái đó (không phải toàn bộ list)

---

## UI

### Nút Status (idle)
```
[ ⊞ Status ▾ ]   border-slate-200, text-slate-600
```

### Nút Status (active — N status đang filter)
```
[ ⊞ Status · 2 ▾ ]   border-blue-300, text-blue-600, bg-blue-50
```

### Dropdown
```
┌──────────────────────┐
│ ☑  Draft             │
│ ☐  Ready             │
│ ☑  Waiting for review│
│ ☐  In Review         │
│ ☐  Approved          │
│ ☐  Rejected          │
├──────────────────────┤
│ Clear filter         │  ← chỉ hiện khi có ≥1 đang chọn
└──────────────────────┘
```

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `components/cpp/CppList.tsx` | Thêm `selectedStatuses` state, `StatusFilterDropdown` component, filter visible CPPs, update select-all logic |

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| Multi-select filter | Single-select | Linh hoạt hơn khi cần xem nhiều status cùng lúc |
| Dropdown | Tab bar | Tab bar chiếm chiều ngang, action bar đã có nhiều buttons |
| Không filter = show all | Không filter = show trống | UX tự nhiên hơn |
| Selection state global | Clear khi đổi filter | Tránh mất selection vô ý |
| Client-side | Server-side (URL params) | Data đã fetch đủ, không cần roundtrip |
