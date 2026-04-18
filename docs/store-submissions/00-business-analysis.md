# Dashboard Store Management — Business Analysis

**Version:** 1.0 (Draft)
**Scope:** Multi-platform submission tracking (Apple, Google Play, Facebook, Huawei…)
**Primary users:** PM/Manager + Dev team (2–5 người)
**Status:** Requirements analysis — chưa đề xuất tech stack

---

## 1. Executive Summary

### 1.1. Problem Statement

Hiện trạng quản lý submission của team đang thủ công 100%:

- Mỗi khi submit build lên store → nhận email thông báo từ platform → PM phải **đọc từng email**, phân loại, và **gõ tay** vào file Excel
- Số lượng email lớn, nhiều app, nhiều build version → **dễ miss email quan trọng** (đặc biệt là email reject cần action gấp)
- Để xem chi tiết lý do reject → phải **login vào từng platform** (App Store Connect, Play Console…) → tốn thời gian
- Report thống kê (số submission, số reject, lý do reject) phải **tổng hợp thủ công** từ Excel

### 1.2. Business Goals

| Goal | Metric đo lường | Target |
|---|---|---|
| Giảm thời gian nhập liệu | Phút/ngày PM dành cho data entry | Giảm ≥ 80% |
| Không miss email quan trọng | Số ticket "critical" bị bỏ sót | = 0 |
| Rút ngắn thời gian phản ứng reject | Thời gian từ khi platform reject đến khi team bắt đầu xử lý | Giảm ≥ 50% |
| Tự động hóa reporting | Số phút để generate báo cáo tuần/tháng | ≤ 5 phút |
| Single source of truth | Số nơi team phải check để biết trạng thái submit | Từ N → 1 |

### 1.3. Out of Scope (MVP)

- Auto-submit build lên platform (không platform nào expose API này cho 3rd party)
- AI phân tích reject reason hoặc đề xuất fix
- Deep integration với App Store Connect API (Apple không có API trả nội dung reject)
- Mobile app native (chỉ web responsive)
- Multi-tenant / multi-org (team 2–5 người, single workspace)

### 1.4. Non-functional Assumptions

| Khía cạnh | Assumption |
|---|---|
| Scale | ≤ 50 apps quản lý đồng thời, ≤ 200 submission/tháng, ≤ 2000 email/tháng |
| Performance | Inbox load ≤ 2s, email sync ≤ 5 phút delay |
| Availability | Business hours availability đủ (không cần 99.99%) |
| Security | Gmail OAuth scope read-only; không lưu body email raw sau khi parse |
| Retention | Submission history giữ ≥ 2 năm; email raw giữ 90 ngày |

> ⚠ Các giả định trên có thể điều chỉnh khi bạn confirm lại thực tế.

---

## 2. Stakeholders & Roles

Team 2–5 người → RBAC đơn giản, không cần phức tạp:

| Role | Responsibility | Permissions |
|---|---|---|
| **Manager/PM** | Triage inbox, assign follow-up, review report | Tất cả thao tác + config |
| **Developer** | Nhận ticket assign, update thread, mark Done | Xem + update ticket được assign, không config |
| **Viewer** (optional) | Chỉ xem report | Read-only toàn bộ |

---

## 3. System Components

Hệ thống chia làm **8 component** — 3 backend logic và 5 UI module. Component được thiết kế tương đối độc lập để dễ maintain và extend khi thêm platform mới.

### 3.1. Sơ đồ tổng quan component

```
┌────────────────────────────────────────────────────────────────────┐
│                      DASHBOARD STORE MGMT                           │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────┐   │
│  │ [A] Email    │───▶│ [B] Email Rule   │───▶│ [C] Ticket     │   │
│  │  Ingestion   │    │     Engine       │    │    Engine       │   │
│  │   (Gmail)    │    │  classify +      │    │  (gom + state)  │   │
│  │              │    │  extract payload │    │                 │   │
│  └──────────────┘    └────────┬─────────┘    └────────┬────────┘   │
│                               │                        │             │
│                 rules         │          app meta      │             │
│                               ▼                        ▼             │
│                      ┌─────────────────────────────────────┐        │
│                      │         [D] App Registry             │        │
│                      │   (apps + aliases + platform link)   │        │
│                      └─────────────────────────────────────┘        │
│                                      │                               │
│         ┌────────────────────────────┼────────────────────┐         │
│         ▼                            ▼                    ▼         │
│  ┌────────────┐           ┌─────────────────┐    ┌───────────────┐ │
│  │[E] Inbox   │◀──────────│[F] Follow-Up    │    │[G] Submission │ │
│  │  Module    │           │   Module         │    │   Tracking    │ │
│  └────────────┘           └─────────────────┘    └───────┬───────┘ │
│                                                           │         │
│                                                           ▼         │
│                                                  ┌──────────────┐  │
│                                                  │[H] Reports & │  │
│                                                  │   Analytics  │  │
│                                                  └──────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Luồng xử lý email**: [A] fetch email từ Gmail → [B] áp rules (sender, subject pattern, Type detection, payload extraction) → [C] quyết định gom vào ticket nào hoặc tạo ticket mới, áp state machine → [E/F/G] hiển thị cho user. [D] cung cấp metadata app cho cả [B] (để match app name qua aliases) và [C] (để enrich ticket).

### 3.2. Chi tiết từng component

#### Component [A] — Email Ingestion Engine (background)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Kết nối Gmail, fetch email thô, đẩy sang [B] Email Rule Engine để classify |
| **Input** | OAuth Gmail token + inbox/label filter (cấu hình trong Settings) |
| **Output** | Raw email payload (subject, sender, body, received_at, gmail_msg_id, attachments) → [B] |
| **Features chính** | <ul><li>OAuth connect Gmail (read-only scope)</li><li>Polling định kỳ (mặc định 5 phút) hoặc push qua Gmail API watch</li><li>Dedup theo `gmail_msg_id`: cùng 1 email chỉ đẩy xuống pipeline 1 lần</li><li>Handle attachment → lưu reference, không lưu binary trong DB chính</li><li>Retry + exponential backoff khi Gmail rate limit</li></ul> |
| **Events emit** | `email.received` → [B] |
| **Edge cases** | <ul><li>Token expire → notify Manager + banner cảnh báo, pause polling</li><li>Burst emails → batch processing + rate limit</li><li>Email multi-language (VN/EN) → chuyển nguyên sang [B], không parse ở đây</li></ul> |

> **Phân tách rõ** giữa [A] và [B]: [A] chỉ lo "lấy email về", [B] lo "hiểu email nói gì". Khi platform đổi format email → chỉ update rule trong [B] là đủ, không đụng [A].

#### Component [B] — Email Rule Engine (background + UI config)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Classify email thành structured data: platform, app, type, outcome, type payload. Toàn bộ logic "hiểu email" nằm ở đây và có thể cấu hình từ UI |
| **Input** | Raw email từ [A] + config rule (sender, subject pattern, Type rule) từ DB |
| **Output** | `ClassifiedEmail { platform, app_id, type, outcome, type_payload, submission_id? }` → [C] |
| **4 loại rule cấu hình** (per platform) | <ol><li>**Sender rule**: map sender email → platform (ví dụ `no-reply@apple.com` → Apple)</li><li>**App matching rule**: regex/alias để extract app_name từ subject → lookup App Registry [D]</li><li>**Subject pattern rule**: map subject regex → outcome ∈ `{APPROVED, REJECTED, IN_REVIEW}`</li><li>**Type rule**: body keyword detection + payload extraction</li></ol> |
| **Flow classify** | <ol><li>Match sender → xác định platform. Không match → drop email (không phải email từ platform)</li><li>Extract app_name từ subject → lookup app_id trong [D]. Không match → gửi xuống [C] với `app_id = null` (Unclassified App)</li><li>Match subject pattern → xác định outcome</li><li>Scan body để match Type rule của platform đó → xác định type + extract type_payload</li><li>Extract submission_id từ body (pattern config được, optional)</li><li>Emit `ClassifiedEmail` xuống [C]</li></ol> |
| **Features UI** | Page "Email Rule" trong Configure: <ul><li>**Per-platform tab** (Apple / Google / Facebook / Huawei / ...). Manager thêm/xóa platform, set sender</li><li>**Subject patterns tab** cho mỗi platform: list `{outcome, regex, example}` với test tool (paste subject thật → xem outcome match gì)</li><li>**Types tab** cho mỗi platform: list Type với form (name, body keyword matcher, payload extraction regex, example email). Test tool tương tự</li><li>Version history + rollback khi rule thay đổi (nếu rule mới làm miss email → rollback nhanh)</li></ul> |
| **Cấu hình mẫu ban đầu (Apple App Store)** | **Sender**: `no-reply@apple.com`<br/>**Subject patterns**:<ul><li>APPROVED: `Review of your .* submission is complete\.`</li><li>REJECTED: `There's an issue with your .* submission\.`</li><li>IN_REVIEW: `Your .* status has changed to Waiting for Review` (ví dụ, cấu hình được)</li></ul>**Types**:<ul><li>`App` — body keyword `App Version`, payload regex `App Version\n(?<version>[\d.]+) for (?<platform>\w+)`</li><li>`In-App Event` — body keyword `In-App Events`, payload regex `In-App Events\n(?<name>.+?)\s+(?<event_id>\d+)`</li><li>`Custom Product Page` — body keyword `Custom Product Pages`, payload regex `Custom Product Pages\n(?<name>.+?)\s+(?<page_id>[a-f0-9-]{36})`</li></ul> |
| **Edge cases** | <ul><li>Email match sender nhưng không match Type nào → `type = null`, ticket vào bucket **"Unclassified Type"** trong Inbox (tương tự Unclassified App)</li><li>Email match nhiều Type (hiếm, theo xác nhận của PM) → tạo ticket riêng cho mỗi Type matched</li><li>Subject khớp nhiều pattern outcome → lấy pattern đầu tiên match theo thứ tự config, log warning</li><li>Rule regex bị invalid syntax → UI validate trước khi save, không cho save rule lỗi</li></ul> |

#### Component [C] — Ticket Engine (background + state machine)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Nhận ClassifiedEmail từ [B], áp rule gom ticket, quản lý state, attach email vào thread |
| **Input** | `ClassifiedEmail { platform, app_id, type, outcome, type_payload, submission_id? }` |
| **Grouping key** | **`(app_id + type + platform)`**. Không dùng time window. Không dùng build_version/submission_id làm key. |
| **Logic gom ticket** | Xem bảng dưới |
| **State machine** | Xem Section 5. Gồm `NEW`, `IN_REVIEW`, `REJECTED`, `APPROVED` (terminal auto), `DONE` (terminal manual), `ARCHIVED` (terminal dismiss) |
| **Features chính** | <ul><li>Tạo/merge ticket tự động theo key + state</li><li>Đẩy email mới vào `ticket.entries[]` dưới dạng EMAIL entry</li><li>Auto-derive state từ `outcome` của email mới nhất khi ticket ở state mở</li><li>Accumulate `ticket.type_payloads[]`: mỗi email đến kèm payload (version, event id, page id...) append vào mảng với timestamp</li><li>Accumulate `ticket.submission_ids[]`: nếu email có submission_id thì append (deduplicate)</li><li>User action: Archive / Follow Up / Mark Done / Add Reject Reason / Comment</li><li>Bulk action support</li></ul> |
| **Edge cases** | <ul><li>Email đến sau khi ticket đã `APPROVED` / `DONE` / `ARCHIVED` → **tạo ticket mới** (không reopen), coi như đợt submit kế tiếp</li><li>Cùng đợt submit dev đổi build mới (version khác) → vẫn gom vào ticket hiện tại (vì key không có version), `type_payload` mới append vào array với timestamp</li><li>Email type=`Unclassified` (không match type rule nào) → ticket vẫn được tạo với `type = null`, hiện trong bucket "Unclassified Type" trong Inbox</li><li>Submission ID reuse (hiếm) → log warning nhưng không block, vẫn gom theo key chính</li><li>App bị deactivate trong Registry nhưng vẫn có email đến → ticket cũ giữ nguyên, email mới → Unclassified App</li></ul> |

##### Logic gom ticket chi tiết

Với mỗi `ClassifiedEmail` có `(app_id, type, platform)`, tìm ticket mới nhất khớp key:

| Tình huống | Hành động |
|---|---|
| Chưa có ticket nào với key này | → **Tạo ticket mới**, state = `NEW` (xem state machine cho auto-derive từ outcome) |
| Ticket gần nhất đang ở `APPROVED` | → **Tạo ticket mới** (đợt submit trước đã thành công, đây là đợt mới) |
| Ticket gần nhất đang ở `DONE` hoặc `ARCHIVED` | → **Tạo ticket mới** (user đã đóng đợt trước) |
| Ticket gần nhất đang ở state mở (`NEW`, `IN_REVIEW`, `REJECTED`) | → **Gom vào ticket đó**, state chuyển theo outcome của email mới (xem state machine) |

Khi gom vào ticket hiện có:
- Email mới append vào `ticket.entries[]`
- `type_payload` mới append vào `ticket.type_payloads[]` với timestamp (trace lại việc đổi version / event / page trong cùng đợt)
- `submission_id` mới (nếu có) append vào `ticket.submission_ids[]` sau dedup
- State transition theo outcome: `IN_REVIEW` → state `IN_REVIEW`, `REJECTED` → state `REJECTED`, `APPROVED` → state `APPROVED` (terminal auto, ticket đóng)

> 📝 **APPROVED vs DONE**: `APPROVED` = terminal **tự động** khi platform xác nhận pass (từ subject pattern). `DONE` = terminal **thủ công** khi user chủ động đóng (hủy submit, không cần follow, v.v.). Phân biệt 2 trạng thái giúp report chính xác: "tỷ lệ approved thật" vs "tickets đóng thủ công".
>
> 📝 **Về submission_id**: là reference data hiển thị trong ticket detail (copy-able cho PM khi cần reference với platform console). Không dùng để filter, grouping, hay search chính.

#### Component [D] — App Registry (UI + data)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Nguồn sự thật về danh sách app team đang quản lý + aliases để Email Rule Engine [B] match email |
| **Features chính** | <ul><li>**CRUD app** với fields: `name` (required), `display_name` (optional, fallback = name), `icon_url` (optional), `team_owner` (optional), `active` (default true)</li><li>**Aliases**: text alias hoặc regex pattern. Khi tạo app, **tên app tự động được add thành alias đầu tiên** (không cần nhập lại). User có thể thêm/xóa alias khác sau</li><li>**Platform bindings (all optional)**: bundle_id (Apple), package_name (Google), app_id (Huawei/Facebook), console_url tự generate từ ID hoặc custom. App có thể publish trên 1, 2, 3 hoặc cả 4 platform — không bắt buộc đầy đủ</li><li>**Import CSV** — bootstrap nhanh hàng chục app từ Excel hiện có. Spec ở dưới</li><li>**Export CSV** — download snapshot hiện tại, round-trip được (export → edit → import lại)</li><li>Enable/disable tracking cho từng app (inactive app không nhận email, nhưng data cũ vẫn giữ)</li></ul> |
| **Rule auto-alias** | Khi user tạo app mới (qua UI hoặc CSV import), **tên app được tự động thêm làm alias đầu tiên**. Trong UI, alias này hiển thị với badge "auto" để phân biệt với alias manually-added. User có thể xóa nhưng sẽ nhận warning "Bỏ alias mặc định có thể làm email mất match". |
| **Rule đổi tên app** | Khi user rename app từ "Old Name" → "New Name":<ul><li>**Giữ nguyên** alias "Old Name" trong danh sách (platform có thể vẫn gửi email với tên cũ do cache/delay)</li><li>**Tự động add** alias mới "New Name" với source `AUTO_CURRENT`</li><li>Alias cũ "Old Name" đổi source từ `AUTO_CURRENT` → `AUTO_HISTORICAL`</li><li>UI hiển thị alias "Old Name" với badge **"prev name"** để user biết alias này sinh ra từ lần rename trước đó</li><li>User có thể xóa manually nếu confirm không còn cần</li></ul> |
| **Tại sao quan trọng** | Đây là **anchor** để [B] biết email nào thuộc app nào. Không có app trong Registry (hoặc thiếu alias phù hợp) → email vào bucket "Unclassified App" trong Inbox |

##### CSV Import / Export format

**File format**: UTF-8 CSV với header row. Tên file: `app-registry-YYYY-MM-DD.csv`. Support cả dấu phẩy `,` và dấu chấm phẩy `;` làm separator (Excel locale).

**Columns** (theo thứ tự):

| # | Column | Required | Type | Ghi chú |
|---|---|---|---|---|
| 1 | `name` | ✓ | string | Tên chính. Tự động add làm alias đầu tiên khi import |
| 2 | `display_name` | — | string | Optional. Nếu trống → fallback = `name` |
| 3 | `aliases` | — | string | Pipe-separated (`\|`): `Skyline\|Skyline Runners: Endless`. KHÔNG cần lặp lại `name` — sẽ được auto-add |
| 4 | `apple_bundle_id` | — | string | vd `com.studio.skylinerunners`. Trống → app không có trên Apple |
| 5 | `google_package_name` | — | string | vd `com.studio.skylinerunners`. Trống → app không có trên Google Play |
| 6 | `huawei_app_id` | — | string | vd `107892345`. Trống → app không có trên Huawei |
| 7 | `facebook_app_id` | — | string | vd `9284715620`. Trống → app không có trên Facebook |
| 8 | `team_owner_email` | — | string | Email của owner. Trống → gán cho user đang import |
| 9 | `active` | — | bool | `true` / `false`. Trống → default `true` |

**Example CSV**:

```csv
name,display_name,aliases,apple_bundle_id,google_package_name,huawei_app_id,facebook_app_id,team_owner_email,active
Skyline Runners,,Skyline|Skyline Runners: Endless,com.studio.skylinerunners,com.studio.skylinerunners,,9284715620,linh@company.com,true
Dragon Guild,Dragon Guild: Fantasy Wars,DG|DG: Fantasy Wars,com.studio.dragonguild,com.studio.dragonguild,107892345,,nam@company.com,true
Puzzle Quest Saga,,Puzzle Quest,com.studio.puzzlequest,com.studio.puzzlequest,,,linh@company.com,true
Tap Tap Empire,,TTE,com.studio.taptapempire,,,8472910563,,true
Legacy Heroes,,,com.studio.legacyheroes,,,,,false
```

**Import behavior**:
- Nếu `name` trùng app đã có → UI hỏi **skip / overwrite / merge aliases**
- Mỗi row validate độc lập; row lỗi skip kèm báo cáo, row ok vẫn import
- Upload xong hiện preview "Sẽ import 12 app mới, skip 3 trùng, 1 row lỗi (thiếu name)" trước khi confirm
- Console URL tự generate từ ID theo template mặc định (có thể custom sau trong detail view)

**Export behavior**:
- Export toàn bộ Registry hiện tại (hoặc subset theo filter active/platform đang chọn)
- Columns khớp 100% với import spec → round-trip được
- Filename auto: `app-registry-2026-04-18.csv`

#### Component [E] — Inbox Module (UI)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Nơi PM **triage hàng ngày** các ticket mới đến từ email |
| **Features chính** | <ul><li>List view: Ticket mới (state = `NEW`), sort mặc định theo received_at desc</li><li>Filter: platform, app, type, outcome, date range</li><li>2 bucket đặc biệt ở đầu list: **Unclassified App** (email sender đúng nhưng không match app trong Registry) và **Unclassified Type** (match app nhưng body không match Type rule nào)</li><li>Action trên mỗi row: **Archive** (→ `ARCHIVED`, không cần xử lý) / **Follow Up** (→ chuyển sang module F, state derive từ outcome của email mới nhất)</li><li>Bulk action: select nhiều + Archive/Follow Up cùng lúc</li><li>Quick preview: click row → drawer phải hiện email body + thread</li><li>Type chip hiển thị trên mỗi row (App / In-App Event / Custom Product Page / ...)</li><li>Counter ở sidebar: số ticket `NEW` đang chờ triage</li></ul> |
| **Key UX** | Mỗi ticket chỉ cần **1 click** để ra quyết định. Keyboard shortcut: `E` = archive, `F` = follow-up, `↑↓` = navigate |

#### Component [F] — Follow-Up Module (UI)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Workspace làm việc cho ticket cần xử lý. Đây là nơi dev/PM thực sự dành thời gian |
| **Features chính** | <ul><li>List ticket có state = FOLLOW_UP hoặc IN_PROGRESS</li><li>Assign to member (team 2–5 → dropdown đơn giản)</li><li>Detail view: thread theo thời gian gồm (a) email gốc từ platform, (b) comment manual từ team, (c) nội dung reject mà PM paste từ App Store Connect, (d) state changes</li><li>Button **"Open in App Store Connect / Play Console"** → redirect URL sâu tới app/build đó</li><li>Button **"Add reject reason"** → mở form text area, PM paste nội dung từ App Store Connect vào, save thành 1 entry trong thread</li><li>Priority flag: Low / Normal / High (PM tự set)</li><li>Due date (optional)</li><li>Mark **DONE** khi xử lý xong → ticket biến mất khỏi list nhưng vẫn giữ trong Submissions + History</li></ul> |
| **Notification** | @mention trong comment → notify member qua email hoặc in-app |

#### Component [G] — Submission Tracking Module (UI)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | View **theo app × build version** — PM nhìn 1 phát biết app nào đang ở stage nào |
| **View modes** | <ul><li>**Grid view** (default): card mỗi app, hiển thị build mới nhất + status</li><li>**Table view**: rows là submission, columns: app, platform, build, submitted_at, status, last_update, action</li><li>**Timeline view**: Gantt-like theo app, mỗi build là 1 thanh kéo dài từ submit đến resolved</li></ul> |
| **Features** | <ul><li>Filter: platform, app, status (waiting/in-review/rejected/approved/ready-for-sale), date range</li><li>Status chip có màu: xanh (approved), vàng (in-review), đỏ (rejected), xám (waiting)</li><li>Click submission → drawer gộp tất cả ticket + thread liên quan build đó</li><li>Link trực tiếp ra platform console</li><li>Indicator "có follow-up chưa DONE"</li></ul> |
| **Differentiation với Inbox/FollowUp** | Inbox/FollowUp tập trung vào **email-as-ticket**. Submission Tracking tập trung vào **build-as-lifecycle**. Cùng 1 build có thể sinh nhiều ticket email (submitted → in-review → rejected) — ở đây gộp lại thành 1 timeline |

#### Component [H] — Reports & Analytics (UI)

| Thuộc tính | Mô tả |
|---|---|
| **Mục đích** | Số liệu tổng hợp cho quản lý + export khi cần báo cáo |
| **Time range** | Today / This week / This month / Last month / Custom range |
| **KPI cards** | <ul><li>Total submissions trong kỳ</li><li>Approved count + rate (%)</li><li>Rejected count + rate (%)</li><li>Avg. time from submit → approved</li><li>Avg. time from reject → resubmit</li></ul> |
| **Charts** | <ul><li>Bar chart: submissions / ngày hoặc tuần</li><li>Stacked bar: status breakdown theo platform</li><li>Horizontal bar: top reject reasons (phân loại từ text do team nhập)</li><li>Heatmap: submission theo app × tuần (phát hiện app nào submit dày đặc)</li></ul> |
| **Export** | CSV / Excel / PDF. Columns config được. Schedule email weekly/monthly |
| **Drill-down** | Click bar trong chart → filter apply vào Submission Tracking |

---

## 4. Data Model (conceptual)

```
Platform
 ├── id, name (Apple|Google|Facebook|Huawei|…), display_name, icon_url, active,
 │   sender_emails[], console_base_url

App
 ├── id, name, display_name, bundle_id, icon_url, team_owner, active
 ├── app_platform_link[]  ← map app với các platform (mỗi app có thể publish trên nhiều platform)

AppAlias
 ├── id, app_id, platform_id, alias_text | alias_regex
    ← dùng ở [B] để match app_name extract từ subject email

Type
 ├── id, platform_id, name (App|In-App Event|Custom Product Page|…), active,
 │   body_keyword,                     ← keyword detect trong body email
 │   payload_extract_regex,            ← regex có named groups để extract payload
 │   payload_schema (jsonb)            ← shape của payload: {version: str} / {event_name, event_id} / ...

SubjectPattern
 ├── id, platform_id, outcome (APPROVED|REJECTED|IN_REVIEW),
 │   regex, priority, active, example_subject
    ← khi match nhiều, lấy theo priority ascending

SubmissionIDPattern
 ├── id, platform_id, body_regex (optional)
    ← extract submission_id từ body cho hiển thị

Ticket
 ├── id, app_id (nullable = unclassified app), platform_id,
 │   type_id (nullable = unclassified type),
 │   state (NEW|IN_REVIEW|REJECTED|APPROVED|DONE|ARCHIVED),
 │   priority, assigned_to, created_at, resolved_at, resolution_type,
 │   type_payloads[],                  ← array: [{payload: {...}, first_seen_at: ...}]
 │   submission_ids[],                 ← array reference: submission IDs xuất hiện trong đợt
 │   latest_outcome                    ← cache outcome của email mới nhất (IN_REVIEW|REJECTED|APPROVED)

TicketEntry (thread item)
 ├── id, ticket_id,
 │   entry_type (EMAIL|COMMENT|REJECT_REASON|STATE_CHANGE|PAYLOAD_ADDED),
 │   author (user_id | "system"), content, created_at, attachment_refs[]

EmailMessage
 ├── id, gmail_msg_id, subject, sender, received_at, raw_body_ref,
 │   ticket_id (nullable),
 │   classified (bool), classification_result (jsonb)
     ← classification_result = {platform_id, app_id, type_id, outcome, 
                                type_payload, submission_id, matched_rules[]}

User
 ├── id, email, name, role (MANAGER|DEV|VIEWER)
```

Key relationships:
- `Platform 1—N App` (qua `app_platform_link`), `Platform 1—N Type`, `Platform 1—N SubjectPattern`
- `App 1—N Ticket` (qua `app_id`), `App 1—N AppAlias`
- `Type 1—N Ticket` (qua `type_id`)
- `Ticket 1—N TicketEntry`, `Ticket 1—N EmailMessage`
- Grouping key trong [C] Ticket Engine: `(app_id, type_id, platform_id)` — khớp đúng unique index tự nhiên cho ticket "đang mở"

Notes:
- `type_payloads[]` lưu chuỗi payload xuất hiện qua từng email — trace được lịch sử đổi version/event/page trong cùng đợt submit
- `submission_ids[]` là pure reference data, không dùng index cho filter/search chính
- `latest_outcome` là denormalized cache để render nhanh chip status trong list view — được update mỗi khi email mới đến và khi state transition

---

## 5. Ticket State Machine

6 states, chia làm 2 nhóm: **open** (ticket đang mở, còn có thể nhận email mới) và **terminal** (đóng, email mới → tạo ticket mới).

**Open states**:
- `NEW` — email đầu tiên đến, ticket chưa được triage (đang ở Inbox)
- `IN_REVIEW` — email mới nhất cho biết platform đang review (đã triage, ở Follow-Up)
- `REJECTED` — email mới nhất là reject (đã triage, ở Follow-Up, cần dev action)

**Terminal states**:
- `APPROVED` — auto, khi email có subject pattern khớp outcome APPROVED
- `DONE` — manual, user chủ động đóng (hủy submit, không cần follow…)
- `ARCHIVED` — manual, user dismiss từ Inbox không track

```
                   ┌────────────────┐
                   │  email mới đến │
                   │(app+type+plat.)│
                   └────────┬───────┘
                            │
              không có ticket mở với key này?
                            │
                           ▼
                    ┌──────────┐
                    │   NEW    │ ◀── Inbox
                    │          │
                    └────┬─────┘
                         │
          ┌──────────────┼───────────────┐
  archive │   follow-up  │               │ auto (email đầu
  (user)  │   (user)     │               │  là approval)
          ▼              ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │ ARCHIVED │   │IN_REVIEW │◀─▶│ REJECTED │
   │(terminal)│   │  (open)  │   │  (open)  │
   └──────────┘   └─────┬────┘   └────┬─────┘
                        │             │
                    email APPROVED │ email APPROVED
                        │             │
                        ▼             ▼
                    ┌────────────────────┐
                    │     APPROVED       │
                    │  (terminal auto)   │
                    └────────────────────┘
                  
  bất kỳ open state nào ──user mark done──▶ ┌──────┐
                                            │ DONE │
                                            └──────┘
                                           (terminal manual)

  Sau terminal (APPROVED / DONE / ARCHIVED):
  email mới với key (app+type+platform) → tạo TICKET MỚI state NEW
```

### Transition rules chi tiết

| Từ state | Trigger | Sang state | Ghi chú |
|---|---|---|---|
| *(chưa có)* | Email đầu tiên cho key (app+type+platform) | `NEW` | Auto tạo ticket, ghi outcome vào `latest_outcome` |
| `NEW` | User bấm Archive trong Inbox | `ARCHIVED` | Terminal |
| `NEW` | User bấm Follow Up trong Inbox | Theo `latest_outcome`: `IN_REVIEW` / `REJECTED` / `APPROVED` | Auto derive từ email mới nhất |
| `NEW` | Email mới đến khi ticket chưa triage (hiếm) | `NEW` (giữ) | Update `latest_outcome`, `type_payloads`, không chuyển state |
| `IN_REVIEW` | Email outcome = `REJECTED` | `REJECTED` | Nằm trong Follow-Up, visible với priority cao hơn |
| `IN_REVIEW` | Email outcome = `APPROVED` | `APPROVED` | Terminal, ticket đóng |
| `IN_REVIEW` | Email outcome = `IN_REVIEW` | `IN_REVIEW` (giữ) | Append email, update payload |
| `REJECTED` | Email outcome = `IN_REVIEW` | `IN_REVIEW` | **Resubmit case**: dev fix + submit lại, state quay về IN_REVIEW |
| `REJECTED` | Email outcome = `APPROVED` | `APPROVED` | Terminal |
| `REJECTED` | Email outcome = `REJECTED` | `REJECTED` (giữ) | Lần reject tiếp theo trong cùng đợt |
| Any open (`NEW`,`IN_REVIEW`,`REJECTED`) | User mark Done | `DONE` | Terminal manual |
| `ARCHIVED` | User bấm Undo trong 10s sau archive | `NEW` | Ngoại lệ duy nhất cho "unarchive" |
| Any terminal (`APPROVED`, `DONE`, `ARCHIVED`) | Email mới cùng key đến | Không reopen — **tạo ticket mới** state `NEW` | Xem Section 3.2 Component [C] |

### Invariants
- Tại bất kỳ thời điểm nào, với 1 key `(app_id, type_id, platform_id)`, **tối đa 1 ticket ở open state**. Nếu có 2 → bug của [C] hoặc race condition khi email burst, cần alert.
- Terminal states là **absolute terminal**: không có đường quay về open (ngoại trừ undo archive trong 10s).

---

## 6. Core User Flows

### Flow 1 — Daily Inbox Triage (PM, ~10 phút/sáng)

```
1. Mở Dashboard → landing page = Inbox (badge hiển thị N ticket mới)
2. Scan list từ trên xuống:
   2a. Ticket "Approved" / "Ready for Sale" → bấm Archive (không cần làm gì)
   2b. Ticket "Rejected" / "Metadata Issue" → bấm Follow Up
   2c. Ticket "In Review" → thường bấm Archive (chỉ là notification)
3. Nếu có "Unclassified" → click xem → gán app thủ công hoặc update alias trong App Registry
4. Kết thúc: Inbox empty, các ticket quan trọng đã chuyển sang Follow-Up
```

### Flow 2 — Follow-Up Resolution (Dev + PM)

```
1. Dev vào Follow-Up module → xem list ticket được assign
2. Chọn 1 ticket reject → click "Open in App Store Connect" → đọc nội dung reject
3. Copy nội dung reject → quay về dashboard → "Add reject reason" → paste
4. Thread ticket giờ có: email gốc + reject reason chi tiết
5. Dev fix → submit build mới → email mới về → sinh ticket mới (hoặc gộp vào ticket cũ nếu cùng version)
6. Khi Apple approve → email "Ready for Sale" → Dev/PM bấm DONE trên ticket gốc
```

### Flow 3 — Submission Tracking (PM check nhanh)

```
1. PM mở Submission Tracking view (grid)
2. Scan card theo app → thấy app X có build 2.4.1 đang đỏ (rejected)
3. Click card → drawer hiện full timeline + các ticket liên quan
4. Nếu đã có ai đang follow-up → ok. Nếu chưa → bấm "Create Follow-Up"
```

### Flow 4 — Weekly Report (Manager)

```
1. Vào Reports → chọn time range = This week
2. Xem KPI cards: 23 submissions, 18 approved (78%), 5 rejected (22%)
3. Xem chart "Top reject reasons": Metadata (3), Guideline 4.3 (1), Crash (1)
4. Export PDF → gửi stakeholder
```

---

## 7. Edge Cases & Risks

| # | Edge case | Xử lý đề xuất |
|---|---|---|
| 1 | Platform đổi subject format đột ngột | Manager vào [B] Email Rule Engine → tab Subject Patterns → update regex. Có "test rule" tool để paste subject thật test outcome match gì. Có version history để rollback nếu rule mới làm mất email |
| 2 | Platform đổi body format (Type keyword đổi hoặc payload structure đổi) | Manager update Type rule trong [B]. Payload extraction regex có thể tune lại. Các ticket cũ không bị ảnh hưởng, chỉ email từ lúc rule update trở đi mới theo logic mới |
| 3 | Email match sender đúng nhưng không match Type nào | Ticket tạo với `type_id = null`, hiện trong bucket "Unclassified Type" ở Inbox. PM có thể (a) manually assign Type, (b) update Type rule để cover pattern mới |
| 4 | Email match app đúng nhưng sender không khớp platform config | Email bị drop ở [B] với log warning. Manager thấy trong Email Rule Engine → "Dropped emails" tab và có thể thêm sender vào Platform config |
| 5 | Email match nhiều Type (hiếm) | Tạo ticket riêng cho mỗi Type matched. UI hiện warning icon trên ticket kèm tooltip "Email này match nhiều Type, kiểm tra lại rule" |
| 6 | 1 đợt submit kéo dài > 30 ngày với nhiều lần resubmit | Không problem — không có time window, ticket gom đúng theo (app+type+platform) cho đến khi APPROVED/DONE/ARCHIVED. `type_payloads[]` trace đủ lịch sử thay đổi version |
| 7 | Dev đổi build version giữa đợt (vd v2.4.1 → v2.4.2) | Append payload mới vào `type_payloads[]` với timestamp. Không tạo ticket mới. Ticket detail drawer hiển thị timeline các version đã thử |
| 8 | Email bị team move vào label khác trong Gmail | [A] chỉ đọc Inbox + optionally các label cấu hình. Manager add/remove labels trong Settings |
| 9 | Team paste reject reason có ảnh screenshot | Support attach image trong TicketEntry, lưu reference ra object storage |
| 10 | App bị deactivate trong Registry nhưng vẫn còn email chưa xử lý | Ticket cũ giữ nguyên. Email mới cho app này đi vào "Unclassified App" trong Inbox |
| 11 | User archive nhầm trong Inbox | Toast "Undo" hiện 10s + filter "Show archived" để recover. Sau 10s muốn unarchive phải contact Manager hoặc dùng bulk tool |
| 12 | Gmail token expire | Notify Manager + banner warning trên dashboard. [A] pause polling đến khi reconnect |
| 13 | Nhiều email đến cùng 1 ticket trong burst (race condition) | [C] dùng optimistic locking theo ticket_id, batch update trong cùng transaction |
| 14 | 2 ticket open cho cùng key (app+type+platform) do bug | Alert cho admin. UI hiện cả 2 ticket với warning, cho phép merge manual |
| 15 | Email từ đợt cũ arrive trễ (sau khi ticket đã APPROVED) | Tạo ticket mới state NEW. Inbox hiện ticket này với hint "Có thể thuộc đợt APPROVED ở {timestamp}" để PM quyết định archive hay follow |

---

## 8. KPIs để đo thành công sau launch

| KPI | Baseline (trước) | Target (sau 1 tháng) |
|---|---|---|
| Thời gian PM dành cho data entry/ngày | 30–60 phút | ≤ 10 phút |
| Số email reject bị miss > 24h | ước tính 2–5/tuần | 0 |
| Thời gian generate weekly report | 1–2 giờ thủ công | ≤ 5 phút |
| User adoption (daily active) | — | 100% team trong tháng đầu |
| NPS của team với tool | — | ≥ 8/10 |

---

## 9. Open Questions (cần confirm thêm khi kickoff)

1. **Volume thực tế**: số app đang quản lý? Số email/ngày hiện tại? Peak lúc nào (ví dụ release weeks)?
2. **App Registry bootstrap**: có sẵn list app + bundle_id ở đâu đó (Excel, Google Sheet) để import không?
3. **Historical data migration**: có cần import Excel cũ để làm baseline report không? Nếu có, format file hiện tại như thế nào?
4. **Gmail shared mailbox**: email đến 1 Gmail cá nhân hay shared inbox của team? Nếu shared thì OAuth của ai?
5. **Thông báo real-time**: PM có muốn nhận push notification khi có reject không, hay chỉ check dashboard là đủ?
6. **Platform ngoài Apple/Google/FB**: còn platform nào khác cần hỗ trợ (Huawei AppGallery, Amazon, Samsung Galaxy Store, Steam…)?
7. **Ai quyết định "Archive"**: chỉ Manager, hay Dev cũng được?
8. **Data retention**: có ràng buộc compliance (GDPR, nội bộ) về lưu trữ email không?

---

## 10. Decision Log (đến thời điểm này)

| # | Quyết định | Lý do | Alternatives đã cân nhắc |
|---|---|---|---|
| D1 | Multi-platform từ MVP, data model generic với Platform entity riêng | User yêu cầu + tránh refactor lớn về sau | Apple-only → reject |
| D2 | Team 2–5, RBAC đơn giản 3 role | Không over-engineer cho team nhỏ | Full RBAC → YAGNI |
| D3 | Không integrate App Store Connect API trả reject content | Apple không expose API này | Scrape → rủi ro vi phạm TOS |
| D4 | Gom ticket theo `(app_id + type_id + platform_id)`, state-based, không time window, không dùng version/submission_id làm key | Type là unit tự nhiên trong submission flow của platform (App, In-App Event, Custom Product Page là 3 khái niệm tách biệt trong ASC). Key này khớp đúng cách platform tổ chức submission. State-based gom chính xác với khái niệm "đợt submit" | `(app+sender)` → reject (bỏ qua dimension Type); `(app+build_version)` → reject (version có thể đổi giữa đợt); time window 14 ngày → reject (đợt dài hơn bị cắt sai) |
| D5 | 3 module UI chính (Inbox / Follow-Up / Submissions) + Reports | Tách rõ workflow triage, workflow xử lý, workflow theo dõi | Gộp vào 1 dashboard → confuse user |
| D6 | UI style: refined minimalism Linear-inspired, light mode | Nhúng vào tool sẵn có, cần neutral + professional | Dark dashboard → clash với host tool có thể là light |
| D7 | Tách **[B] Email Rule Engine** thành component riêng, configurable từ UI, không hardcode | Platform thay đổi format email khá thường xuyên (subject wording, body keyword). Hardcode rule → cần deploy mỗi lần platform đổi. UI config → Manager tự update trong phút, có test tool + rollback | Hardcode rule trong code → reject; Rule trong file YAML cần SSH edit → reject cho team PM không tech |
| D8 | Type là khái niệm **per-platform**, không global | Apple có App/IAE/CPP, Google có thể có concept khác hoàn toàn (App Bundle / Store Listing Experiment / ...). Gộp global → không extensible, gộp chung Type giữa 2 platform không đúng business | Type global shared across platforms → reject (không khớp với cách platform tổ chức) |
| D9 | State machine **6 states** (NEW, IN_REVIEW, REJECTED, APPROVED, DONE, ARCHIVED) với REJECTED ↔ IN_REVIEW cycle | Phản ánh đúng chu trình resubmit: reject → fix → submit lại → in-review. Phân biệt APPROVED (auto, platform confirmed) vs DONE (manual, user đóng) giúp report chính xác về tỷ lệ approved thật | 3 states đơn giản (OPEN/CLOSED/ARCHIVED) → reject (không trace được resubmit cycle); merge APPROVED vào DONE → reject (mất độ phân giải về success rate) |
| D10 | Email không match Type → bucket "Unclassified Type" riêng trong Inbox, tương tự Unclassified App | Consistent UX. PM có thể manually triage hoặc update rule để cover case mới. Không lặng lẽ drop email → tránh miss thông tin | Drop silently → reject (mất email); Auto-assign Type = "Other" → reject (làm report nhiễu) |
| D11 | Subject pattern + Type rule cấu hình riêng từng dimension, outcome ∈ `{APPROVED, REJECTED, IN_REVIEW}` là fixed enum | Subject pattern quyết định outcome (state machine), Type rule quyết định grouping. 2 concerns tách biệt → rule clean, dễ test độc lập. Outcome enum fixed vì là driver của state machine, thêm outcome mới = thay đổi state machine | Free-form outcome string → reject (không drive được state machine); Gộp subject pattern với Type rule → reject (rối rắm, khó test) |

---

## Kết luận

Hệ thống gồm **8 component** (3 backend + 5 UI), flow chính xoay quanh **Inbox → Follow-Up → Submissions → Reports**, với 2 engine là xương sống:

- **[B] Email Rule Engine** — toàn bộ logic "hiểu email" nằm ở đây, cấu hình được từ UI. Thay vì deploy khi platform đổi format, Manager tự update rule + test + rollback
- **[C] Ticket Engine** — state machine 6 states với grouping key `(app + type + platform)`, match chính xác cách platform tổ chức submission

Điểm khác biệt quan trọng của 4 UI module:
- **Inbox** là nơi "lọc nhiễu" — chỉ giữ email cần action, có 2 bucket unclassified (App / Type)
- **Follow-Up** là nơi "làm việc" — ticket mở với REJECTED ↔ IN_REVIEW cycle trace đầy đủ
- **Submissions** là view "tổng quan" — PM không cần mở từng ticket vẫn biết app × type × platform đang ở đâu
- **Reports** là output — giảm công sức báo cáo thủ công, breakdown theo Type + platform

Bước tiếp theo (sau khi validate document này): confirm Open Questions → chốt scope MVP → chuyển sang đề xuất tech stack.
