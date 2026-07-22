# Design: Bulk Import Result Table — Expandable Notes / Full Apple Error

Status: **Investigation + design for review — NO CODE WRITTEN.** A build prompt follows approval.

Goal (Manager): on the Bulk Import Step 4 result table, a failed row's Notes cell today shows a truncated raw error; the full Apple error is visible only in Railway logs. Make the full error viewable inline via an expandable cell, without breaking the existing result table.

---

## 1. Investigation

### 1.1 Data availability — the gate (is the full error client-side today?)

**No — the full Apple error body is Railway-only.** Traced end to end:

1. `lib/shared/apple-fetch.ts:243-244` — on a non-2xx Apple response, `const errBody = await res.text();` captures Apple's **complete, untruncated** response body.
2. `lib/shared/apple-fetch.ts:254-259` — logs `` `... ERROR ${res.status}: ${errBody}` `` at `"ERROR"` level via `log()`. `lib/logger.ts:16-20` always `console.error`s the full message (file logging is opt-in behind `LOG_TO_FILE`, but Railway captures stdout/stderr regardless) — **this is where the "full error, Railway only" experience comes from.**
3. Still in `apple-fetch.ts:259`, the full body is thrown: `throw new AppleApiError(res.status, method, endpoint, errBody)`. The exception's `.body` property (`lib/shared/apple-fetch.ts:30-44`) carries the **complete** text — nothing is truncated at throw time.
4. The truncation happens one layer up, in the bulk-import route's own helper — `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:1279-1284`:
   ```ts
   function errMsg(err: unknown): string {
     if (err instanceof AppleApiError) {
       return `${err.status}: ${err.body.slice(0, 500)}`;
     }
     return err instanceof Error ? err.message : String(err);
   }
   ```
   **This is the single choke point that caps the error at 500 characters** before it becomes part of a row's result.
5. `errMsg()` feeds exactly **three** call sites that populate a field the Notes cell renders:
   - `route.ts:697` — CREATE path, Apple-create failure → `result.error` (row `status: "ERROR"`, `stage: "apple-create"`)
   - `route.ts:945` — OVERWRITE path, Apple-patch failure → `result.error` (row `status: "ERROR"`, `stage: "apple-patch"`)
   - `route.ts:885` — post-guard submit failure → `result.submit_error` (row stays `status: "SUCCESS"`, `submit_outcome: "failed"`)
   (`errMsg()` is also called at 7 other sites — locale/screenshot/availability/list-locale/db-upsert failures — but those only feed `log()` WARN lines, not any field the Notes cell reads. Out of scope.)
6. The 500-char-capped string is returned as-is inside `ExecuteSummary.results[]` (the JSON response body, `route.ts:597-606`) — so what reaches the client is already lossy.
7. Client renders it with a **second** truncation, in `app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx`:
   - `:1347-1348` — `` `${r.stage ?? ""}: ${r.error.slice(0, 120)}` `` for `status: "ERROR"` rows
   - `:1352` — `` `... submit failed: ${(r.submit_error ?? "").slice(0, 100)}. ...` `` for the deferred-submit-failed sub-note

**Conclusion: truncated twice (500 server, then 120/100 client). The full text exists only as a Railway console line.** Confirms the Manager's premise exactly.

### 1.2 Where the full error would need to be captured, and actions_log vs. live response

- `persistResult()` (`route.ts:1198-1277`) inserts one `actions_log` row per IAP with `action_type: "BULK_IMPORT_CREATE"` and `payload: { ...result, ... }` (`route.ts:1243-1258`) — it spreads whatever is already on `result`, i.e. **whatever `errMsg()` produced**. So today `actions_log.payload` also only ever gets the 500-char-capped string; persisting doesn't currently carry more detail than the response does.
- `actions_log.payload` is `jsonb` (`supabase/migrations/20260515000000_iap_mgmt_init.sql:180`). Adding new keys to the payload is a pure data change, **not a schema change** — the table's only `CHECK` constraint governs the `action_type` enum (`supabase/migrations/20260517000000_...sql`, `20260518000000_...sql`), and this work doesn't introduce a new `action_type`. No migration needed.
- Whether persisting the full text to `actions_log` actually matters for "surviving navigation": checked for any surface that reconstructs the Step-4 result table from `actions_log`/`import_batches` instead of the live POST response — **none exists** (`grep` for `BULK_IMPORT_CREATE` / `import_batches` outside the execute route turns up nothing in the IAP or Google UI). The result table is rendered purely from the in-memory `result` state set by the `execute` POST response (`BulkImportWizard.tsx`) — it's lost on refresh/navigation today regardless of what this feature does. Persisting the full text to `actions_log` is still worth doing (cheap, and correct for future audit tooling) but is **not required** to solve "view the full error without checking Railway" — fixing the response is what does that.

### 1.3 Error shape enumeration

- **`AppleApiError`** (`lib/shared/apple-fetch.ts:30-44`): `.body` is Apple's raw response text. Apple's documented error format is JSON:API — `{"errors":[{"id":...,"status":"...","code":"...","title":"...","detail":"...","source":{...}}]}`. No existing helper in the codebase parses this shape today (`grep` for `errors[0]` / `.detail` / `parseAppleError` across `lib/iap-management` found nothing relevant) — the collapsed-summary parser below is new, not a duplicate of something already written.
- **`AppleRateLimitError`** extends `AppleApiError` (`lib/shared/apple-fetch.ts:51-64`) — same `.body` shape. In practice it never reaches a row's `error`/`submit_error` field because `withRetry` (`lib/shared/apple-fetch.ts:101-132`) retries 429s internally; only if retries are exhausted does it propagate as a (still `AppleApiError`-shaped) exception, handled identically.
- **Generic `Error`** (non-Apple): network failure, timeout/abort, or a thrown non-Apple error. `err.message` is plain text (e.g. `"fetch failed"`), not JSON. Must fall back to the raw-truncated string as-is — cannot be parsed for `.detail`/`.title`/`.code`.
- **Multi-error arrays**: Apple's `errors[]` can contain more than one entry (e.g. multiple invalid attributes). Collapsed summary uses the first entry + a `"(+N more)"` suffix; full text still shows everything.

### 1.4 Reuse — is there an existing disclosure component?

`components/ui/iap/ExpandablePanel.tsx` exists (one of the 7 IAP UI primitives) — a **block-level** section disclosure: full-width row, chevron icon, `title` prop, toggles a `children` block. It's built for wrapping a whole page section (e.g. "In-App Purchase Pricing"), not for a compact table `<td>`. Reusing it as-is would mean a chevron + title row *inside* a table cell, which doesn't match the Manager's locked "2-line summary + Detail/Close text button" shape. **Not a direct fit** — this design introduces a new, purpose-built component, but keeps the same idiom (local `useState` toggle, `aria-expanded` button) for consistency with `ExpandablePanel`.

### 1.5 Result table + Notes cell today

Everything lives in the single file `BulkImportWizard.tsx` (no separate `ResultTable.tsx`):
- Table markup: `:1308-1368`. Notes column header: `:1317`.
- Notes cell body: `:1343-1362` — a plain `<td>` with a ternary chain of plain-text strings (no `line-clamp` CSS, no truncation styling beyond the `.slice()` calls already covered in §1.1).
- `ExecuteResult` (the client-side mirror of the server's `PerIapResult`) is hand-duplicated at `:79-129` — any new field must be added in both places (not a shared type import).

---

## 2. Scope verdict

**Backend + frontend.** The truncation the Manager wants fixed happens server-side (`errMsg()`, `route.ts:1279-1284`) before the response is even built — a frontend-only change has nothing to expand into. The backend change is additive and backward-compatible:

- `errMsg()` itself is **left untouched** — it still backs the 7 WARN-log-only call sites unchanged.
- A new pure helper, `describeAppleError()`, is added and used **only** at the 3 call sites that populate rendered fields (apple-create, apple-patch, submit). It returns `{ message, full, httpStatus }` — `message` is exactly what `errMsg()` produces today (so nothing existing changes shape), `full`/`httpStatus` are new.
- `PerIapResult` (`route.ts`) gets two new **optional** fields: `error_full?: string`, `error_http_status?: number`. `ExecuteResult.results[]` (`BulkImportWizard.tsx`) gets the same two fields mirrored. No existing field is renamed, removed, or reshaped — old consumers of `.error`/`.submit_error` keep working unchanged.
- `persistResult()` needs no code change — it already spreads `...result`, so the new fields ride along into `actions_log.payload` for free. No migration (§1.2).
- Response size: Apple JSON:API error bodies are small (a few hundred bytes to ~1-2KB even with several `errors[]` entries) — no batching/pagination concern.

---

## 3. Collapsed-summary parse chain

Pure, testable helper — no React, no fetch — e.g. `lib/iap-management/bulk-import/apple-error-summary.ts`:

```ts
export interface AppleErrorSummary {
  /** Collapsed-cell text, e.g. `apple-create 409 — This name is already being used…` */
  summary: string;
  /** True when `raw` parsed as Apple's {errors:[...]} JSON:API shape. */
  isAppleJson: boolean;
}

interface ApiErrorEntry {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
}

export function summarizeAppleError(params: {
  /** error_full — untruncated text, when available. */
  raw: string | undefined;
  /** error / submit_error — always present, may already be 500-char-capped. */
  fallback: string;
  stage?: string;
  httpStatus?: number;
}): AppleErrorSummary {
  const text = params.raw ?? params.fallback;
  let errors: ApiErrorEntry[] | undefined;
  try {
    errors = (JSON.parse(text) as { errors?: ApiErrorEntry[] }).errors;
  } catch {
    errors = undefined;
  }

  if (!Array.isArray(errors) || errors.length === 0) {
    // Not valid Apple JSON (network error, timeout, non-Apple error) — raw-truncated fallback, same text the cell shows today.
    const prefix = params.stage ? `${params.stage}: ` : "";
    return { summary: `${prefix}${params.fallback.slice(0, 120)}`, isAppleJson: false };
  }

  const first = errors[0];
  const detail = first.detail ?? first.title ?? first.code ?? "Unknown Apple error";
  const prefix = [params.stage, params.httpStatus].filter((v) => v !== undefined).join(" ");
  const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return { summary: `${prefix ? `${prefix} — ` : ""}${detail}${suffix}`, isAppleJson: true };
}
```

Parse chain per Manager's decision #1: `detail` → `title` → `code` → raw-truncated fallback. Multi-error case: first entry's detail + `"(+N more)"`. Lives as a standalone module so both the collapsed-cell logic and a future test file can import it without touching React.

---

## 4. Reusable component — `ExpandableErrorCell`

**Proposed location: `components/ui/shared/ExpandableErrorCell.tsx`** (new folder), not nested under `components/ui/iap/`. Rationale: `ui/iap/*` is IAP's own primitive set (per its `index.ts`); the Manager's requirement is that Google's bulk-import result table adopt this later "with no rewrite" — nesting it under `iap/` would make that cross-module import read oddly even though nothing technically blocks it. Flagged as an open question below in case the Manager prefers keeping it alongside the other 7 IAP primitives instead.

```ts
export interface ExpandableErrorCellProps {
  /** Collapsed 2-line summary (e.g. from summarizeAppleError().summary). Always shown. */
  summary: string;
  /** Full text to pretty-print when expanded. Omit entirely to render a plain cell with no Detail button (success/skipped rows). */
  detail?: string;
  className?: string;
}
```

Behavior:
- Collapsed: `summary` rendered with `line-clamp-2`, plus a `Detail` text button — **only when `detail` is present and non-empty**.
- On `Detail` click: expands in place to a pretty-printed block. Tries `JSON.stringify(JSON.parse(detail), null, 2)`; if `detail` isn't valid JSON, renders `detail` as-is. Wrapped in a monospace `<pre>` capped at ~10 lines (`max-h-[220px] overflow-y-auto`, `whitespace-pre-wrap`), so a long single-line minified JSON body scrolls inside the cell rather than blowing out the row.
- A `Close` button collapses back to the 2-line summary.
- Expand state is a local `useState(false)` inside the component — each row is its own component instance, so multiple rows expand independently for free; no lifted/shared state needed (Manager's decision #3).
- `Detail`/`Close` are `<button type="button">` with `aria-expanded={open}` — not clickable `<div>`s (Manager's decision E / a11y).

---

## 5. Wiring — Apple Bulk Import result table only

`BulkImportWizard.tsx` `ExecuteResult.results[]` (`:79-129`) gains:
```ts
error_full?: string;
error_http_status?: number;
```

The Notes cell's `r.error` branch (`:1347-1348`) changes from a plain string to the new component:

**Before**
```tsx
{r.error
  ? `${r.stage ?? ""}: ${r.error.slice(0, 120)}`
  : /* ...unchanged branches... */}
```

**After**
```tsx
{r.error ? (
  <ExpandableErrorCell
    summary={
      summarizeAppleError({
        raw: r.error_full,
        fallback: r.error,
        stage: r.stage,
        httpStatus: r.error_http_status,
      }).summary
    }
    detail={r.error_full ?? r.error}
  />
) : (
  /* ...unchanged branches (submit deferred/failed, failed_locales, screenshot_note, apple_iap_id, "—")... */
)}
```

Only the `r.error` branch (status `"ERROR"` rows: validation / apple-create / apple-patch) is touched. Every other Notes-cell branch is byte-for-byte unchanged this pass (see §7 open question #2 re: the submit-failed sub-note).

Server side, the 3 call sites become (shown for apple-create; apple-patch and submit-failed are the same shape):
```ts
} catch (err) {
  const desc = describeAppleError(err);
  return await persistResult(args, {
    product_id: item.product_id,
    disposition: "CREATE",
    status: "ERROR",
    stage: "apple-create",
    error: desc.message,
    error_full: desc.full,
    error_http_status: desc.httpStatus,
  });
}
```

---

## 6. Edge cases

- **Empty notes** (SUCCESS/SKIPPED rows with no error) — `r.error` is falsy, the ternary falls through to the existing unchanged branches; `ExpandableErrorCell` is never rendered, so there's no stray `Detail` button.
- **Very long single-line minified JSON** — handled by the `<pre>` scroll box (§4); pretty-printing via `JSON.stringify(..., null, 2)` also forces line breaks so it's not one giant unwrapped line.
- **Non-JSON note** (network error, timeout, non-Apple error) — `JSON.parse` throws inside both `summarizeAppleError` and the component's expand-render; both fall back to showing the raw text as-is. Still expandable (Detail button still shows, since `detail` is non-empty) — the value of expanding is smaller here (there's no "more" hidden beyond what's already short), but consistent behavior beats a special case.
- **a11y** — `Detail`/`Close` are real `<button>`s with `aria-expanded`, matching `ExpandablePanel`'s existing pattern.

---

## 7. Open questions / risks

1. **Component location** — recommended `components/ui/shared/ExpandableErrorCell.tsx` (new shared folder) over nesting in `components/ui/iap/`, specifically because Google's result table is meant to adopt it later. Please confirm, or say to keep it under `ui/iap/` if that's preferred despite the cross-module import.
2. **Submit-failure sub-note** (`BulkImportWizard.tsx:1352`, SUCCESS row with `submit_outcome: "failed"`) goes through the exact same `errMsg()` truncation and renders in the same Notes column, but the Manager's locked scope says "a failed row's Notes cell" (i.e. `status: "ERROR"`). This pass wires `error_full`/`error_http_status` onto `submit_error` too (cheap, same call site) but does **not** change that Notes-cell branch to use `ExpandableErrorCell` — flagging as a likely fast-follow for consistency rather than doing it unasked.
3. **`pricing_error` twin path** — `applyPricingSchedule` (`lib/iap-management/apple/pricing-orchestration.ts`) already carries the *full* untruncated `err.message` (it never goes through `errMsg()`), and it's already surfaced via a native `title` tooltip on `PriceBadge` (`BulkImportWizard.tsx:1557`) — a different UI surface, not the Notes column. Out of scope for this pass, noted only so a future "why does pricing already show full text but create/patch don't" question doesn't surprise anyone.
4. **`actions_log.payload` now carries the full Apple response body** (potentially including `source.pointer`/attribute paths) where before it only carried 500 chars. This is the same text already sent to the client and already logged to Railway — no new exposure — but it now persists indefinitely in Postgres rather than only appearing in ephemeral Railway logs. Flagging for a one-line Manager sign-off, not because anything looks sensitive in practice.
5. The task description referenced "the Manager's example" of pretty-printed JSON — that example wasn't available in this investigation's context. The mockup below uses a representative Apple JSON:API error shape (`errors[]` with `status`/`code`/`title`/`detail`). If the Manager's real example differs materially in shape, the mockup/parser should be adjusted before implementation.
