# Feature: Submit CPP for Apple Review

> Status: ✅ Implemented (2026-03-13)

---

## Tổng quan

Cho phép user chọn nhiều CPP và submit chúng lên Apple Review cùng lúc từ trang CPP List. Chỉ CPP ở trạng thái `PREPARE_FOR_SUBMISSION` (Draft) mới được submit.

---

## Yêu cầu

1. Reuse checkbox selection từ Delete feature
2. Submit button màu xanh ở bên phải action bar, hiển thị số lượng submittable đang chọn
3. 1-step confirmation dialog với per-CPP skip warnings cho non-Draft CPPs
4. Parallel submit với `Promise.allSettled()`, báo kết quả từng CPP
5. ASC API: `POST /v1/appCustomProductPageSubmissions` → `201 Created`
6. Reject reason tooltip trên badge STATUS khi CPP ở trạng thái `REJECTED`

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `types/asc.ts` | Thêm `rejectedVersionUserFeedback?: string` vào `AppCustomProductPageVersionAttributes` |
| `lib/asc-client.ts` | Thêm `submitCpp(creds, versionId)` |
| `app/api/asc/cpps/[cppId]/submit/route.ts` | New — `POST` handler |
| `app/(dashboard)/apps/[appId]/cpps/page.tsx` | Extract `versionIds` + `rejectReasons` từ `included[]`, pass xuống `CppList` |
| `components/cpp/CppList.tsx` | Submit button, `SubmitConfirmDialog`, refactor `ResultDialog`, reject tooltip |

---

## Submittable states

```typescript
const SUBMITTABLE_STATES: CppState[] = ["PREPARE_FOR_SUBMISSION"];
```

CPP ở trạng thái khác: vẫn có thể được select (nếu eligible cho Delete), nhưng khi click Submit sẽ bị skip với warning trong dialog.

---

## Dialog flow

```
[Click Submit]
      │
      └─ selectedCpps (có thể 0 hoặc nhiều)
              │
              └─ SubmitConfirmDialog:
                    - ✓ PREPARE_FOR_SUBMISSION → "Will submit"
                    - ⚠ APPROVED / other    → "Skipped (Approved)"
                    - Nếu eligibleCount === 0 → nút Submit disabled
                    │
                    ├─ Cancel → đóng dialog
                    │
                    └─ Submit → Promise.allSettled(...)
                                      │
                                      └─ ResultDialog: success/fail per CPP
                                              │
                                              └─ Close → reload (nếu có succeeded)
```

---

## API route

### `POST /api/asc/cpps/[cppId]/submit`

**Request body:** `{ versionId: string }`

```typescript
export async function POST(req, { params }) {
  const { versionId } = await req.json();
  const creds = await getActiveAccount();
  await submitCpp(creds, versionId);
  return new NextResponse(null, { status: 201 });
  // Error: forwards 403, 409, 422 as-is; else 500
}
```

| ASC status | Meaning | Xử lý |
|---|---|---|
| 201 | Success | OK |
| 403 | Permission denied | Forward 403 |
| 409 | State conflict | Forward 409 |
| 422 | Validation error (e.g. no assets) | Forward 422 |

---

## ASC API call

```typescript
POST /v1/appCustomProductPageSubmissions
{
  data: {
    type: "appCustomProductPageSubmissions",
    relationships: {
      appCustomProductPageVersion: {
        data: { type: "appCustomProductPageVersions", id: versionId }
      }
    }
  }
}
```

**Lấy `versionId`:** Từ `included[]` trong response của list API. Khi gọi `GET /v1/apps/{appId}/appCustomProductPages?include=appCustomProductPageVersions`, version data nằm trong `included[]` (không phải `data[]`). Map qua `cpp.relationships.appCustomProductPageVersions.data[0].id`.

---

## Client-side submit logic

```typescript
const submittable = selectedCpps.filter(
  (cpp) => SUBMITTABLE_STATES.includes(versionStates[cpp.id])
);

const results = await Promise.allSettled(
  submittable.map((cpp) =>
    fetch(`/api/asc/cpps/${cpp.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: versionIds[cpp.id] }),
    }).then(async (res) => {
      if (res.status === 201) return { cpp, ok: true, reason: "" };
      const body = await res.json().catch(() => ({}));
      return { cpp, ok: false, reason: body.error ?? `HTTP ${res.status}` };
    })
  )
);
```

---

## Reject reason tooltip

- `StatusBadge` component: khi `state === "REJECTED"`, badge có `cursor-help` + `underline decoration-dashed` + `title` attribute
- Data source: `version.attributes.rejectedVersionUserFeedback` (nếu ASC trả về field này trong `included[]`)
- Fallback: `"Rejected by Apple"` nếu field không có

`rejectReasons: Record<string, string>` được extract trong `cpps/page.tsx` và pass xuống `CppList`.

---

## UX details

- **Action bar layout:** `[Delete (N)]` trái ←→ phải `[Submit (N)] [Export CSV] [Bulk Import]`
- **Submit button:**
  - Không có submittable selection: outline xanh nhạt (`border-blue-200 text-blue-500`)
  - Có submittable selection: filled xanh (`bg-blue-600 text-white`) + badge = số CPP Draft đang chọn
- **Dialog skip warning:** Amber — `⚠ Skipped (Approved)` cho CPP không phải Draft
- **No assets check:** Không check trước submit — ASC trả về 422 nếu thiếu assets, hiển thị trong result dialog
