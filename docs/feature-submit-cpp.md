# Feature: Submit CPP for Apple Review

> Status: ✅ Implemented (2026-03-13) — Redesign v2 planned (2026-04-06)

---

## Tổng quan

Cho phép user chọn nhiều CPP và submit chúng lên Apple Review cùng lúc từ trang CPP List. Chỉ CPP ở trạng thái `PREPARE_FOR_SUBMISSION` (Draft) mới được submit.

---

## Submittable states

```typescript
const SUBMITTABLE_STATES: CppState[] = ["PREPARE_FOR_SUBMISSION"];
```

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

Step 2 — Thêm từng CPP version vào submission (sequential, retry, sleep):
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

Rollback (nếu user chọn) — Xoá submission container:
DELETE /v1/reviewSubmissions/{submissionId}
```

---

## Redesign v2 — Sequential add + Partial Fail UX (2026-04-06)

### Vấn đề với v1

- Step 2 dùng `Promise.all` → risk bị Apple rate limit khi submit nhiều CPP
- Toàn batch fail khi 1 item fail (không có per-item visibility)
- Không có cơ chế rollback khi partial fail

### Thiết kế mới

#### API — 3 endpoints thay vì 1

| Endpoint | Mục đích |
|---|---|
| `POST /api/asc/cpps/submit/prepare` | Step 1 + Step 2 (sequential + retry). Trả về per-item result + submissionId |
| `POST /api/asc/cpps/submit/confirm` | Step 3 — `PATCH submitted: true` |
| `DELETE /api/asc/cpps/submit/:submissionId` | Rollback — xoá submission container |

#### `POST /api/asc/cpps/submit/prepare`

**Request:**
```typescript
{
  appId: string,
  items: Array<{ cppId: string; cppName: string; versionId: string }>
}
```

**Response 200** (luôn 200 nếu Step 1 thành công, dù có item fail):
```typescript
{
  submissionId: string,
  items: Array<{
    cppId: string,
    cppName: string,
    status: "success" | "failed",
    error?: string
  }>
}
```

**Response 5xx** — chỉ khi `POST /v1/reviewSubmissions` (Step 1) fail:
```typescript
{ error: string }
```

#### `POST /api/asc/cpps/submit/confirm`

```typescript
// Request
{ submissionId: string }
// Response: 201 no body
// Error: { error: string } + status 4xx/5xx
```

#### `DELETE /api/asc/cpps/submit/:submissionId`

```
// Response: 204 no body
// Error: { error: string } — non-blocking, log + toast
```

---

#### Sequential add logic (trong `prepareCppSubmission`)

```
for each item (sequential):
  attempt = 0
  while attempt < 3:
    try POST /v1/reviewSubmissionItems
    if success → mark "success", break
    if fail → attempt++, continue (no delay between retries)
  if attempt == 3 → mark "failed", error = last error message

  if not last item → sleep 200ms

return { submissionId, items[] }
```

- Retry tối đa 2 lần (3 attempts total), không delay giữa các retry
- Sleep 200ms giữa các item để tránh Apple rate limit
- Item fail không dừng loop — tiếp tục item tiếp theo

---

#### Frontend state machine (`CppList.tsx`)

```typescript
type SubmitPhase =
  | null           // idle
  | "confirm"      // dialog xác nhận ban đầu (giữ nguyên hiện tại)
  | "preparing"    // spinner — POST /prepare đang chạy
  | "partial-fail" // dialog partial result + action buttons
  | "confirming"   // spinner — POST /confirm đang chạy (trong partial-fail dialog)
  | "rolling-back" // spinner — DELETE đang chạy (trong partial-fail dialog)
  | "result"       // final result dialog (happy path)

interface SubmitState {
  phase: SubmitPhase;
  prepareResult?: {
    submissionId: string;
    items: Array<{
      cppId: string;
      cppName: string;
      status: "success" | "failed";
      error?: string;
    }>;
  };
  confirmError?: string;   // có nếu /confirm fail
  rollbackError?: string;  // có nếu DELETE fail
}
```

---

#### Flow diagram

```
User clicks [Submit (N)]
         │
         ▼
┌─────────────────────┐
│  Dialog: Confirm    │  ← giữ nguyên dialog hiện tại
│  "Submit N CPPs?"   │
└────────┬────────────┘
         │ click "Submit"
         ▼
┌─────────────────────┐
│  Spinner            │  "Adding CPPs to submission…"
│  POST /prepare      │  sequential + retry + sleep
└────────┬────────────┘
         │
    ┌────┴──────────┐
    │               │
  ALL OK      PARTIAL/ALL FAIL
    │               │
    ▼               ▼
  POST /confirm   Dialog: Partial Result
    │               │
  OK → Result    ┌──┴─────────────────┐
  Dialog         │                   │
  FAIL →      [Rollback]      [Submit X CPPs]
  Result                              │
  Dialog      DELETE /id          POST /confirm
              OK → close          OK → Result Dialog
              FAIL → toast        FAIL → Error Popup
                     stay                 │ close
                     dialog               │ stay
                                          ▼
                                     Partial dialog
```

---

#### UI Mockups

**Dialog: Partial Fail (có success lẫn fail)**
```
┌──────────────────────────────────────────────────────────┐
│  ⚠️  Some CPPs failed to add                        [×]  │
│                                                          │
│  2 of 5 CPPs could not be added to the submission.       │
│  Review and decide whether to proceed or rollback.       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ✅  Summer Sale Campaign                          │  │
│  │ ✅  Holiday 2024                                  │  │
│  │ ✅  Back to School                                │  │
│  │ ❌  Spring Promo                                  │  │
│  │     422 · Invalid version state                  │  │
│  │ ❌  Black Friday                                  │  │
│  │     409 · Already in another submission          │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  [ Rollback ]          [ Submit 3 successful CPPs → ]    │
└──────────────────────────────────────────────────────────┘
```

**Dialog: All Fail (0/N success) — Submit button disabled**
```
┌──────────────────────────────────────────────────────────┐
│  ❌  All CPPs failed to add                         [×]  │
│                                                          │
│  0 of 3 CPPs were added. Please rollback and retry.      │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ❌  Summer Sale Campaign                          │  │
│  │     422 · Invalid version state                  │  │
│  │ ❌  Holiday 2024                                  │  │
│  │     409 · Already in another submission          │  │
│  │ ❌  Spring Promo                                  │  │
│  │     500 · Internal server error                  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  [ Rollback ]          [ Submit 0 CPPs → ]  (disabled)   │
└──────────────────────────────────────────────────────────┘
```

**Error Popup: /confirm fail (overlay trên partial dialog)**
```
┌──────────────────────────────────────────┐
│  ❌  Submission failed                   │
│                                          │
│  Could not finalize submission:          │
│  422 · Missing required review items     │
│                                          │
│                           [ Close ]      │
└──────────────────────────────────────────┘
  ↑ khi đóng: quay lại partial-fail dialog
```

---

#### Decision Log

| Quyết định | Alternatives | Lý do chọn |
|---|---|---|
| 2 endpoints (prepare + confirm) | 1 endpoint với flag `confirmed`, Streaming/SSE | Flow có điểm ngắt (user confirm), mỗi endpoint single responsibility |
| Auto-confirm khi 0 fail | Luôn show confirm dialog | Không thêm friction vào happy path |
| Sequential loop thay Promise.all | Promise.allSettled | Rate limit risk, cần per-item result + control |
| 200ms sleep giữa items (không giữa retries) | Exponential backoff | Retry ngay (transient error), sleep để tránh rate limit |
| Rollback = DELETE submissionId | Mark as abandoned, ignore | Sạch, đơn giản — ASC xoá toàn bộ container |
| /confirm fail → stay on dialog | Auto rollback, show final error | User tự quyết retry hay rollback, không mất submissionId |

---

## Files thay đổi (v2)

| File | Thay đổi |
|---|---|
| `lib/asc-client.ts` | Thêm `prepareCppSubmission()`, `confirmCppSubmission()`, `rollbackCppSubmission()`. Giữ `submitCpps()` (deprecated) |
| `app/api/asc/cpps/submit/prepare/route.ts` | NEW — `POST` handler |
| `app/api/asc/cpps/submit/confirm/route.ts` | NEW — `POST` handler |
| `app/api/asc/cpps/submit/[submissionId]/route.ts` | NEW — `DELETE` handler |
| `app/api/asc/cpps/submit/route.ts` | Deprecated — giữ lại nhưng không dùng |
| `components/cpp/CppList.tsx` | Thay `handleSubmit` + states, thêm `PartialFailDialog` |

---

## UX details (giữ từ v1)

- **Action bar layout:** `[Delete (N)]` trái ←→ phải `[Submit (N)] [Export CSV] [Bulk Import]`
- **Submit button:**
  - Không có submittable selection: outline xanh nhạt (`border-blue-200 text-blue-500`)
  - Có submittable selection: filled xanh (`bg-blue-600 text-white`) + badge
- **Reject reason tooltip:** `StatusBadge` khi `state === "REJECTED"` — `cursor-help` + `underline decoration-dashed` + `title`
