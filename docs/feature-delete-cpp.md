# Feature: Delete CPP

> Status: ✅ Implemented (2026-03-13)

---

## Tổng quan

Cho phép user chọn nhiều CPP và xóa chúng cùng lúc từ trang CPP List. Chỉ CPP ở trạng thái `Draft` hoặc `Approved` mới được phép xóa.

---

## Yêu cầu

1. Checkbox column trong bảng — chỉ enable cho `PREPARE_FOR_SUBMISSION` (Draft) và `APPROVED`
2. Delete button màu đỏ ở bên trái action bar, hiển thị số lượng đang chọn
3. 2-step confirmation flow để tránh xóa nhầm
4. Parallel delete với `Promise.allSettled()`, báo kết quả từng CPP
5. ASC API: `DELETE /v1/appCustomProductPages/{id}` → `204 No Content`

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `app/api/asc/cpps/[cppId]/route.ts` | Thêm `DELETE` handler |
| `components/cpp/CppList.tsx` | Checkbox selection, Delete button, 4-step dialog flow |

---

## Deletable states

```typescript
const DELETABLE_STATES: CppState[] = ["PREPARE_FOR_SUBMISSION", "APPROVED"];
```

CPP ở trạng thái khác (`READY_FOR_REVIEW`, `WAITING_FOR_REVIEW`, `IN_REVIEW`, `REJECTED`): checkbox disabled với tooltip giải thích.

---

## Dialog flow

```
[Click Delete]
      │
      ├─ selectedIds.size === 0 → Dialog "No CPPs selected" → Close
      │
      └─ selectedIds.size > 0 → Dialog 1: Review list
                                    │
                                    ├─ Cancel → Close all
                                    │
                                    └─ Continue → Dialog 2: Final confirm
                                                      │
                                                      ├─ Cancel → Close all
                                                      │
                                                      └─ Delete → Promise.allSettled(...)
                                                                      │
                                                                      └─ Dialog 3: Result summary
                                                                              │
                                                                              └─ Close → reload (if any succeeded)
```

---

## API route

### `DELETE /api/asc/cpps/[cppId]`

```typescript
export async function DELETE(_req, { params }) {
  const creds = await getActiveAccount();
  await deleteCpp(creds, params.cppId);
  return new NextResponse(null, { status: 204 });
  // Error: forwards 409 (in-review) and 403 (forbidden) as-is
}
```

| ASC status | Meaning | Xử lý |
|---|---|---|
| 204 | Success | OK |
| 403 | Permission denied | Forward 403 |
| 404 | Not found / already deleted | Error |
| 409 | CPP đang in-review | Forward 409 |

---

## Client-side delete logic

```typescript
const results = await Promise.allSettled(
  selected.map((cpp) =>
    fetch(`/api/asc/cpps/${cpp.id}`, { method: "DELETE" })
      .then(async (res) => {
        if (res.status === 204) return { cpp, ok: true };
        const body = await res.json();
        return { cpp, ok: false, reason: body.error ?? `HTTP ${res.status}` };
      })
  )
);
// succeeded = results where ok === true
// failed = results where ok === false, hiển thị reason
// After close: reload nếu succeeded > 0
```

---

## UX details

- **Action bar layout:** `[Delete (N)]` trái ←→ phải `[Export CSV] [Bulk Import]`
- **Delete button:**
  - Không có selection: outline đỏ nhạt (`border-red-200 text-red-500`)
  - Có selection: filled đỏ (`bg-red-600 text-white`) + badge số lượng
- **Header checkbox:** Select all eligible (Draft/Approved) — partial state khi chỉ chọn một phần
- **Row highlight:** Hàng đang chọn có `bg-red-50/40`
- **Result dialog:** Hiển thị số thành công (xanh) + danh sách thất bại kèm lý do (đỏ)
