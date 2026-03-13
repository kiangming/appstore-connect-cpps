# Feature: Submit CPP for Apple Review

> Status: ✅ Implemented (2026-03-13) — Bugfix 1: wrong endpoint (2026-03-13) — Bugfix 2: submitted attribute (2026-03-13)

---

## Tổng quan

Cho phép user chọn nhiều CPP và submit chúng lên Apple Review cùng lúc từ trang CPP List. Chỉ CPP ở trạng thái `PREPARE_FOR_SUBMISSION` (Draft) mới được submit.

---

## Yêu cầu

1. Reuse checkbox selection từ Delete feature
2. Submit button màu xanh ở bên phải action bar, hiển thị số lượng submittable đang chọn
3. 1-step confirmation dialog với per-CPP skip warnings cho non-Draft CPPs
4. Batch submit — tất cả CPPs gom vào 1 Apple Review Submission, 1 request duy nhất từ client
5. ASC API: 3-step review submission flow (API v1.7+) — xem chi tiết bên dưới
6. Reject reason tooltip trên badge STATUS khi CPP ở trạng thái `REJECTED`

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `types/asc.ts` | Thêm `rejectedVersionUserFeedback?: string` vào `AppCustomProductPageVersionAttributes` |
| `lib/asc-client.ts` | `submitCpps(creds, appId, versionIds[])` — 1 submission, N items parallel |
| `app/api/asc/cpps/submit/route.ts` | New — batch `POST` handler, nhận `{ appId, items[] }` |
| `app/api/asc/cpps/[cppId]/submit/route.ts` | ~~Deprecated~~ — thay bằng route batch bên trên |
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

### `POST /api/asc/cpps/submit`

**Request body:** `{ appId: string, items: Array<{ cppId: string, versionId: string }> }`

```typescript
export async function POST(req) {
  const { appId, items } = await req.json();
  const creds = await getActiveAccount();
  await submitCpps(creds, appId, items.map(i => i.versionId));
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

## ASC API call sequence (API v1.7+)

> ⚠️ **Bugfix 1 (2026-03-13):** Endpoint cũ `POST /v1/appCustomProductPageSubmissions` không tồn tại (404). Apple đã thay bằng unified Review Submissions flow từ API v1.7.
>
> ⚠️ **Bugfix 2 (2026-03-13):** `PATCH /v1/reviewSubmissions/{id}` với `attributes: { state: "SUBMITTED" }` trả về 409 `ENTITY_ERROR.ATTRIBUTE.NOT_ALLOWED` — Apple không cho phép set `state` trực tiếp qua UPDATE. Đúng là dùng `attributes: { submitted: true }`.

```
Step 1 — Tạo review submission container:
POST /v1/reviewSubmissions
{
  data: {
    type: "reviewSubmissions",
    attributes: { platform: "IOS" },
    relationships: { app: { data: { type: "apps", id: appId } } }
  }
}
← response: { data: { id: submissionId } }

Step 2 — Thêm CPP version vào submission:
POST /v1/reviewSubmissionItems
{
  data: {
    type: "reviewSubmissionItems",
    relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
      appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: versionId } }
    }
  }
}

Step 3 — Submit for review:
PATCH /v1/reviewSubmissions/{submissionId}
{
  data: {
    type: "reviewSubmissions",
    id: submissionId,
    attributes: { submitted: true }
  }
}
```

**Batch submit:** Tất cả CPPs được chọn gom vào **1 `reviewSubmission` duy nhất**. Step 2 POST nhiều `reviewSubmissionItems` song song (Promise.all), sau đó mới PATCH state=SUBMITTED. Client chỉ gọi 1 request đến `/api/asc/cpps/submit`.

**Lấy `versionId`:** Từ `included[]` trong response của list API. Khi gọi `GET /v1/apps/{appId}/appCustomProductPages?include=appCustomProductPageVersions`, version data nằm trong `included[]` (không phải `data[]`). Map qua `cpp.relationships.appCustomProductPageVersions.data[0].id`.

---

## Client-side submit logic

```typescript
const submittable = selectedCpps.filter(
  (cpp) => SUBMITTABLE_STATES.includes(versionStates[cpp.id])
);

// 1 request — tất cả CPPs gom vào 1 Apple Review Submission
const res = await fetch("/api/asc/cpps/submit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    appId,
    items: submittable.map((cpp) => ({ cppId: cpp.id, versionId: versionIds[cpp.id] })),
  }),
});

// 201 = all succeeded; lỗi = tất cả failed (Apple xử lý batch atomically)
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
