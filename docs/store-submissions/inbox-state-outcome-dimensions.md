# Inbox UI: State Tabs vs Outcome Chips — Two-Dimension Model

> Tài liệu giải thích quan hệ và cơ chế hoạt động giữa **state tabs** và **outcome chips** trong Inbox UI của Store Submissions module. Bao gồm concept overview, mechanism, scenarios cụ thể, và Manager workflow examples.

**Last updated**: 2026-05-01 (post PR-15.5 hotfix)
**Related PRs**: PR-9 (Q1 Option A subject_patterns), PR-13 (dimension separation), PR-15.5 (stale entry filter)

---

## Mục lục

1. [Tổng quan: Hai dimension độc lập](#1-tổng-quan-hai-dimension-độc-lập)
2. [Dimension 1: state (lifecycle stage)](#2-dimension-1-state-lifecycle-stage)
3. [Dimension 2: latest_outcome (Apple verdict)](#3-dimension-2-latest_outcome-apple-verdict)
4. [UI mechanism: Tabs vs Chips](#4-ui-mechanism-tabs-vs-chips)
5. [Visual diagram: Two-dimension matrix](#5-visual-diagram-two-dimension-matrix)
6. [Scenario chính: Reject email → Approve email cùng app](#6-scenario-chính-reject-email--approve-email-cùng-app)
7. [Manager workflow scenarios chi tiết](#7-manager-workflow-scenarios-chi-tiết)
8. [Common confusions clarified](#8-common-confusions-clarified)
9. [Pre-PR-16 implications](#9-pre-pr-16-implications)

---

## 1. Tổng quan: Hai dimension độc lập

Inbox UI surface 2 filter dimensions độc lập:

| Dimension | UI element | Field | Source |
|---|---|---|---|
| **Lifecycle position** | State tabs (5 tabs) | `tickets.state` | Manager intent |
| **Apple verdict** | Outcome chips (5 chips) | `tickets.latest_outcome` | Apple email signal |

**Key principle**: Same ticket có thể có **bất kỳ combination** của state × outcome. Cannot derive one từ other.

**Ví dụ minh họa** — same ticket trong các trạng thái khác nhau:

| state | latest_outcome | Manager interpretation |
|---|---|---|
| NEW | REJECTED | "Apple reject, tôi chưa review" |
| IN_REVIEW | REJECTED | "Tôi đang fix issues" |
| IN_REVIEW | APPROVED | "Resubmit đã approve, đợi milestone tiếp" |
| APPROVED | APPROVED | "Approved + acknowledged, đợi release" |
| DONE | APPROVED | "Released, đóng case" |
| DONE | REJECTED | "Project killed" |
| ARCHIVED | APPROVED | "Historical record" |

---

## 2. Dimension 1: state (lifecycle stage)

**Field**: `tickets.state` enum
**Reflects**: Manager workflow position — ticket nằm ở đâu trong lifecycle

### State values

| State | Meaning | Manager action source |
|---|---|---|
| `NEW` | Vừa tạo, đợi Manager review | System auto-set khi ticket first created |
| `IN_REVIEW` | Manager đang xử lý | Manager click "Move to In Review" |
| `APPROVED` | Apple approved + Manager acknowledged + đợi milestone | Manager click "Mark Approved" (FOLLOW_UP action) |
| `DONE` | Terminal — Manager hoàn thành | Manager click "Mark Done" |
| `ARCHIVED` | Hidden khỏi active inbox | Manager click "Archive" |
| `UNCLASSIFIED_TYPE` | Email không match type pattern | System (catch-all) |
| `UNCLASSIFIED_APP` | Email không match app registry | System (catch-all) |

**Key insight**: `state` driven primarily by **Manager intent** — explicit human decisions về workflow position.

### State transition diagram

```svg
<svg width="100%" viewBox="0 0 680 420" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>

  <!-- NEW -->
  <rect x="60" y="40" width="120" height="50" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
  <text x="120" y="62" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#0C447C">NEW</text>
  <text x="120" y="78" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#185FA5">Auto on email arrival</text>

  <!-- IN_REVIEW -->
  <rect x="240" y="40" width="120" height="50" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
  <text x="300" y="62" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#0C447C">IN_REVIEW</text>
  <text x="300" y="78" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#185FA5">Manager working</text>

  <!-- APPROVED -->
  <rect x="420" y="40" width="120" height="50" rx="8" fill="#EAF3DE" stroke="#3B6D11" stroke-width="0.5"/>
  <text x="480" y="62" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#27500A">APPROVED</text>
  <text x="480" y="78" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#3B6D11">Awaiting milestone</text>

  <!-- DONE -->
  <rect x="240" y="180" width="120" height="50" rx="8" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="0.5"/>
  <text x="300" y="202" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#444441">DONE</text>
  <text x="300" y="218" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Terminal — finished</text>

  <!-- ARCHIVED -->
  <rect x="420" y="180" width="120" height="50" rx="8" fill="#F1EFE8" stroke="#5F5E5A" stroke-width="0.5"/>
  <text x="480" y="202" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#444441">ARCHIVED</text>
  <text x="480" y="218" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Hidden from active</text>

  <!-- UNCLASSIFIED -->
  <rect x="60" y="180" width="120" height="50" rx="8" fill="#FAEEDA" stroke="#854F0B" stroke-width="0.5"/>
  <text x="120" y="202" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#633806">UNCLASSIFIED_*</text>
  <text x="120" y="218" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#854F0B">No app/type match</text>

  <!-- Arrows -->
  <line x1="180" y1="65" x2="238" y2="65" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="209" y="58" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Move</text>

  <line x1="360" y1="65" x2="418" y2="65" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="389" y="58" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Approve</text>

  <line x1="300" y1="90" x2="300" y2="178" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="312" y="138" font-family="sans-serif" font-size="12" fill="#5F5E5A">Done</text>

  <line x1="480" y1="90" x2="480" y2="178" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="492" y="138" font-family="sans-serif" font-size="12" fill="#5F5E5A">Archive</text>

  <path d="M120 90 L120 130 L300 130 L300 178" fill="none" stroke="#5F5E5A" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#arrow1)"/>
  <text x="200" y="120" font-family="sans-serif" font-size="12" fill="#5F5E5A">Skip review (rare)</text>

  <line x1="180" y1="205" x2="238" y2="205" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="209" y="198" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Reclassify</text>

  <line x1="360" y1="205" x2="418" y2="205" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow1)"/>
  <text x="389" y="198" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5F5E5A">Archive</text>

  <!-- Legend -->
  <rect x="60" y="290" width="560" height="100" rx="8" fill="#F1EFE8" stroke="#888780" stroke-width="0.5"/>
  <text x="80" y="312" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">Manager actions on tab</text>
  <text x="80" y="334" font-family="sans-serif" font-size="12" fill="#444441">• "Move to In Review" — accept ticket for processing</text>
  <text x="80" y="352" font-family="sans-serif" font-size="12" fill="#444441">• "Mark Approved" — Apple approved + awaiting next milestone (rare standalone state)</text>
  <text x="80" y="370" font-family="sans-serif" font-size="12" fill="#444441">• "Mark Done" — terminal close, often skipped from NEW directly</text>
</svg>
```

### Notes về state transitions

- **NEW → DONE direct**: workflow shortcut khi Manager close immediately mà không qua IN_REVIEW (e.g. duplicate, no-action-needed)
- **state=APPROVED rare**: most approved tickets directly go to DONE. APPROVED reserved cho FOLLOW_UP cases (Apple approved + awaiting next milestone)
- **UNCLASSIFIED_* → CLASSIFIED**: reclassify path may **create new ticket** if app/type now matches → original UNCLASSIFIED row gets "reclassify_out" audit entry

---

## 3. Dimension 2: latest_outcome (Apple verdict)

**Field**: `tickets.latest_outcome` enum (nullable)
**Reflects**: Apple's most recent decision về submission

### Outcome values

| Outcome | Meaning | Source |
|---|---|---|
| `APPROVED` | Apple accepted submission | Subject pattern match (Q1 Option A — PR-9) |
| `REJECTED` | Apple rejected submission | Subject pattern match |
| `IN_REVIEW` | Apple still reviewing | Subject pattern match (e.g. "submitted for review") |
| `NULL` | Outcome not detected | No subject pattern match |

**Key insight**: `latest_outcome` driven by **Apple's email signal** — extracted từ `subject_patterns` table. Manager doesn't directly mutate this dimension (chỉ indirect via subject_patterns rule edits).

### Q1 Option A discipline (PR-9)

`subject_patterns` table = **single source of truth** cho `latest_outcome`:
- Subject regex patterns map to outcome values
- HTML body extractor detects outcome too BUT chỉ audit-only (không override subject_patterns)
- Discipline reinforced PR-9 → PR-12 → PR-13

**Why subject-only, not body**:
- Subject patterns deterministic + auditable (1 regex per pattern)
- HTML body parsing complex, more variance
- Single dimension write = simpler debugging

---

## 4. UI mechanism: Tabs vs Chips

### Tabs filter by state

5 tabs map to state subsets:

| Tab | URL `state=` param | State values shown |
|---|---|---|
| **Open** | `state=NEW&state=IN_REVIEW` (default) | NEW, IN_REVIEW |
| **Approved** | `state=APPROVED` | APPROVED |
| **Done** | `state=DONE` | DONE |
| **Archived** | `state=ARCHIVED` | ARCHIVED |
| **Unclassified** | `state=UNCLASSIFIED_TYPE&state=UNCLASSIFIED_APP` | UNCLASSIFIED_* |

URL example: `/inbox?state=NEW&state=IN_REVIEW` → Open tab active.

### Chips filter by latest_outcome

5 chips trong each tab (except Unclassified — chips hidden):

| Chip | URL `outcome=` param | Outcome values shown |
|---|---|---|
| **All** | (param absent) | All outcomes (no filter) |
| **Approve** | `outcome=APPROVED` | latest_outcome = APPROVED |
| **Reject** | `outcome=REJECTED` | latest_outcome = REJECTED |
| **In review** | `outcome=IN_REVIEW` | latest_outcome = IN_REVIEW |
| **No outcome** | `outcome=NULL` | latest_outcome IS NULL |

URL example: `/inbox?state=NEW&state=IN_REVIEW&outcome=REJECTED` → Open tab + Reject chip = "tickets I'm working on that Apple rejected".

### Combined query (AND logic)

```sql
SELECT * FROM tickets
WHERE state = ANY(:tab_states)        -- Tab filter (dimension 1)
  AND (
    :outcome IS NULL                  -- All chip
    OR (latest_outcome = :outcome     -- Specific chip
        AND latest_outcome IS NOT NULL)
    OR (:outcome = 'NULL'             -- No outcome chip
        AND latest_outcome IS NULL)
  )
```

**Two independent WHERE clauses combined với AND**. Either dimension can be "all" (no filter trên dimension đó).

### Cross-tab chip persistence

Chip selection persists across tab switches (PR-13 design). Manager workflow: "show me Reject across all states" works clicking Reject chip + cycling tabs.

### Smart UI conditionals

- **Unclassified tab → chips hidden**: tickets này có no extracted outcome (email không match patterns yet). Showing chips = dead UI.
- **"All" chip default**: most common workflow = "show me everything trong this lifecycle position". Chip filter opt-in cho refinement.

---

## 5. Visual diagram: Two-dimension matrix

```svg
<svg width="100%" viewBox="0 0 680 540" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>

  <text x="340" y="32" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">Two independent dimensions combine via AND</text>

  <!-- Dimension 1 header -->
  <rect x="40" y="60" width="290" height="60" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="0.5"/>
  <text x="185" y="82" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#3C3489">State (lifecycle position)</text>
  <text x="185" y="102" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#534AB7">Where Manager is in workflow</text>

  <!-- Dimension 2 header -->
  <rect x="350" y="60" width="290" height="60" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"/>
  <text x="495" y="82" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#085041">Outcome (Apple verdict)</text>
  <text x="495" y="102" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#0F6E56">What Apple said about submission</text>

  <!-- Tab values -->
  <rect x="40" y="140" width="290" height="200" rx="8" fill="#EEEDFE" stroke="#534AB7" stroke-width="0.5"/>
  <text x="185" y="162" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#3C3489">Tab filter</text>
  <text x="60" y="186" font-family="sans-serif" font-size="12" fill="#534AB7">Open: NEW + IN_REVIEW</text>
  <text x="60" y="206" font-family="sans-serif" font-size="12" fill="#534AB7">Approved: APPROVED</text>
  <text x="60" y="226" font-family="sans-serif" font-size="12" fill="#534AB7">Done: DONE</text>
  <text x="60" y="246" font-family="sans-serif" font-size="12" fill="#534AB7">Archived: ARCHIVED</text>
  <text x="60" y="266" font-family="sans-serif" font-size="12" fill="#534AB7">Unclassified: UNCLASSIFIED_*</text>
  <text x="60" y="296" font-family="sans-serif" font-size="12" fill="#534AB7">Source: Manager intent</text>
  <text x="60" y="316" font-family="sans-serif" font-size="12" fill="#534AB7">Mutated by: state actions</text>

  <!-- Chip values -->
  <rect x="350" y="140" width="290" height="200" rx="8" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"/>
  <text x="495" y="162" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#085041">Chip filter</text>
  <text x="370" y="186" font-family="sans-serif" font-size="12" fill="#0F6E56">All: no outcome filter</text>
  <text x="370" y="206" font-family="sans-serif" font-size="12" fill="#0F6E56">Approve: latest_outcome=APPROVED</text>
  <text x="370" y="226" font-family="sans-serif" font-size="12" fill="#0F6E56">Reject: latest_outcome=REJECTED</text>
  <text x="370" y="246" font-family="sans-serif" font-size="12" fill="#0F6E56">In review: IN_REVIEW</text>
  <text x="370" y="266" font-family="sans-serif" font-size="12" fill="#0F6E56">No outcome: NULL</text>
  <text x="370" y="296" font-family="sans-serif" font-size="12" fill="#0F6E56">Source: Apple email signal</text>
  <text x="370" y="316" font-family="sans-serif" font-size="12" fill="#0F6E56">Mutated by: subject_patterns</text>

  <!-- Combined arrows -->
  <line x1="185" y1="345" x2="185" y2="385" stroke="#534AB7" stroke-width="1.5" marker-end="url(#arrow2)"/>
  <line x1="495" y1="345" x2="495" y2="385" stroke="#0F6E56" stroke-width="1.5" marker-end="url(#arrow2)"/>

  <!-- Combined query box -->
  <rect x="100" y="390" width="480" height="130" rx="8" fill="#F1EFE8" stroke="#888780" stroke-width="0.5"/>
  <text x="340" y="414" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">Combined query (AND)</text>
  <text x="340" y="438" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#444441">"Open + Reject" = state in (NEW, IN_REVIEW)</text>
  <text x="340" y="456" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#444441">AND latest_outcome = REJECTED</text>
  <text x="340" y="482" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#444441">= tickets I'm working on that Apple rejected</text>
  <text x="340" y="502" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#444441">5 tabs × 5 chips = 25 filter combinations</text>
</svg>
```

---

## 6. Scenario chính: Reject email → Approve email cùng app

### Email arrival timeline

**Email 1** (T0): Apple rejects "Play Together VNG" submission
- Subject: "There's an issue with your Play Together VNG (iOS) submission."
- Subject pattern match: outcome = `REJECTED`

**Email 2** (T1): Apple approves "Play Together VNG" resubmission
- Subject: "Review of your Play Together VNG (iOS) submission is complete."
- Body: "Submission has been completed. It is now eligible for distribution."
- Subject pattern match: outcome = `APPROVED`

### Ticket grouping logic

Tickets grouped by `(app_id, type_id, platform_id)` triple. Same app + same type + apple = **same ticket**.

→ Email 2 không tạo ticket mới. Becomes new EMAIL entry on existing ticket.

### State progression

```svg
<svg width="100%" viewBox="0 0 680 360" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow3" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>

  <!-- T0 -->
  <text x="40" y="40" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">T0: Email 1 arrives (REJECT)</text>
  <rect x="40" y="55" width="280" height="80" rx="8" fill="#FCEBEB" stroke="#A32D2D" stroke-width="0.5"/>
  <text x="180" y="78" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#791F1F">Ticket created</text>
  <text x="180" y="98" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#A32D2D">state = NEW</text>
  <text x="180" y="116" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#A32D2D">latest_outcome = REJECTED</text>

  <!-- T0.5 (optional Manager action) -->
  <text x="360" y="40" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">T0.5: Manager processes (optional)</text>
  <rect x="360" y="55" width="280" height="80" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
  <text x="500" y="78" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#0C447C">Manager: "Move to In Review"</text>
  <text x="500" y="98" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#185FA5">state = IN_REVIEW</text>
  <text x="500" y="116" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#185FA5">latest_outcome = REJECTED (unchanged)</text>

  <!-- T1 -->
  <text x="40" y="180" font-family="sans-serif" font-size="14" font-weight="500" fill="#2C2C2A">T1: Email 2 arrives (APPROVE)</text>
  <rect x="40" y="195" width="600" height="100" rx="8" fill="#EAF3DE" stroke="#3B6D11" stroke-width="0.5"/>
  <text x="340" y="218" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="500" fill="#27500A">Same ticket, new EMAIL entry</text>
  <text x="340" y="238" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#3B6D11">state = IN_REVIEW (unchanged — Manager intent preserved)</text>
  <text x="340" y="256" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#3B6D11">latest_outcome = APPROVED (updated by subject_patterns)</text>
  <text x="340" y="276" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#3B6D11">ticket_entries: [REJECT email, REJECT state_change, APPROVE email]</text>

  <!-- Arrow -->
  <line x1="180" y1="135" x2="180" y2="180" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow3)"/>
  <text x="195" y="160" font-family="sans-serif" font-size="12" fill="#5F5E5A">If Manager skip step</text>

  <line x1="500" y1="135" x2="500" y2="180" stroke="#5F5E5A" stroke-width="1.5" marker-end="url(#arrow3)"/>
  <text x="515" y="160" font-family="sans-serif" font-size="12" fill="#5F5E5A">If Manager processed</text>

  <!-- Key insight -->
  <rect x="40" y="310" width="600" height="40" rx="8" fill="#FAEEDA" stroke="#854F0B" stroke-width="0.5"/>
  <text x="340" y="334" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#633806">Key: latest_outcome reflects MOST RECENT email. state reflects Manager workflow position.</text>
</svg>
```

### Ticket visibility per filter combination

After T1 (cả 2 email arrived), tickets visibility tùy filter:

#### Case A: Manager hadn't acted (state=NEW)

| Tab | Chip | Visible? | Lý do |
|---|---|---|---|
| Open | All | ✅ Yes | state=NEW ∈ Open subset |
| Open | Approve | ✅ Yes | latest_outcome=APPROVED matches |
| Open | Reject | ❌ No | latest_outcome=APPROVED, không match Reject |
| Open | In review | ❌ No | outcome không match |
| Open | No outcome | ❌ No | outcome có value |
| Approved | Any | ❌ No | state=NEW, không match Approved tab |
| Done | Any | ❌ No | state=NEW |

→ Ticket xuất hiện **Open tab + Approve chip** (most relevant view).

**Lưu ý quan trọng**: Reject chip filter **không show** ticket này nữa, dù email đầu tiên là REJECT. Manager muốn xem lịch sử reject phải mở ticket detail.

#### Case B: Manager đã "Move to In Review" trước email 2 (state=IN_REVIEW)

Same visibility như Case A — IN_REVIEW also ∈ Open tab subset.

#### Case C: Manager đã "Mark Done" trước email 2 (state=DONE)

| Tab | Chip | Visible? | Lý do |
|---|---|---|---|
| Open | Any | ❌ No | state=DONE, không match Open |
| Approved | Any | ❌ No | state=DONE |
| Done | All | ✅ Yes | state=DONE matches |
| Done | Approve | ✅ Yes | latest_outcome=APPROVED matches |
| Done | Reject | ❌ No | outcome=APPROVED |

→ Ticket trong **Done tab + Approve chip**, dù email đầu là REJECT.

---

## 7. Manager workflow scenarios chi tiết

### Scenario 1: Triage rejection thông thường

**Setup**: Apple sends rejection email cho new app submission.

```
T0: Email arrives → ticket NEW + REJECTED
T1: Manager opens Inbox → Open tab default
T2: Manager clicks "Reject" chip → see only rejection tickets
T3: Manager opens specific ticket → reads details
T4: Manager clicks "Move to In Review" → state=IN_REVIEW (outcome unchanged REJECTED)
T5: Ticket still visible Open tab + Reject chip (continue working)
T6: Developer fixes issues + resubmits
T7: Apple sends approval email → same ticket: outcome → APPROVED (state unchanged)
T8: Ticket disappears Reject chip view
T9: Ticket appears Open tab + Approve chip
T10: Manager clicks "Mark Done" → state=DONE
T11: Ticket moves Done tab + Approve chip
```

### Scenario 2: User-requested case — Reject → Approve cùng app, cùng ticket

**Setup**: Email 1 = REJECT, Email 2 = APPROVE same app (resubmission cycle).

#### Manager workflow option A: Watch and acknowledge

```
T0: Email 1 (REJECT) arrives → ticket state=NEW, outcome=REJECTED
T1: Manager opens Inbox → Open tab + Reject chip → sees ticket
T2: Manager opens ticket → reads rejection details
T3: Manager: "Tôi đợi developer fix"
T4: Email 2 (APPROVE) arrives → ticket: outcome → APPROVED (state=NEW unchanged)
T5: Manager refreshes Inbox → Reject chip empty (ticket moved away)
T6: Manager clicks Approve chip → sees ticket
T7: Manager clicks "Mark Done" → state=DONE
T8: Ticket → Done tab + Approve chip
```

**Filter trail**:
- T1-T3: Open + Reject → ticket visible
- T5: Open + Reject → ticket gone (chuyển outcome)
- T6-T7: Open + Approve → ticket visible
- T8+: Done + Approve → ticket archived to terminal

#### Manager workflow option B: Active processing

```
T0: Email 1 (REJECT) arrives → ticket NEW + REJECTED
T1: Manager: "Move to In Review" → state=IN_REVIEW + REJECTED
T2: Manager đang fix issues
T3: Email 2 (APPROVE) arrives → state=IN_REVIEW + APPROVED
T4: Manager refreshes → ticket vẫn trong Open tab (state IN_REVIEW)
T5: Manager xem ticket → thấy 3 entries (REJECT email, state_change, APPROVE email)
T6: Manager: "Mark Done" → state=DONE + APPROVED
T7: Ticket → Done tab + Approve chip
```

**Key insight**: state IN_REVIEW persists across outcome changes. Manager workflow position **không reset** khi Apple verdict thay đổi.

#### Manager workflow option C: Skip review entirely

```
T0: Email 1 (REJECT) arrives → ticket NEW + REJECTED
T1: Email 2 (APPROVE) arrives → ticket NEW + APPROVED (state=NEW)
T2: Manager opens Inbox first time
T3: Manager sees ticket Open tab + Approve chip (current state)
T4: Manager: "Mark Done" directly (skip IN_REVIEW)
T5: Ticket → Done tab + Approve chip
```

**No record of REJECT outcome trong tab/chip visibility** — chỉ trong ticket detail timeline (audit history preserved).

### Scenario 3: View historical reject outcomes

**Question**: Manager muốn audit "tất cả tickets Apple đã từng reject"?

**Answer**: Tab/chip filter chỉ surface **current** outcome, không history.

Cách view historical reject:
1. Open ticket detail → timeline shows all email entries + state changes
2. SQL query `ticket_entries` cho REJECT-pattern subjects historical
3. Hoặc filter Reject chip + check Done tab (ticket close-out as REJECTED)

→ **Active filter = current state**, **Audit trail = ticket detail timeline**.

### Scenario 4: Mass approve workflow

**Setup**: Multiple apps approve cùng lúc (release wave).

```
T0: 10 emails approve arrive trong cron tick
T1: 10 tickets NEW + APPROVED
T2: Manager opens Inbox → Open tab + Approve chip
T3: Manager sees 10 tickets bulk
T4: Manager review từng ticket → "Mark Done" each
T5: Tickets move Done tab + Approve chip individually
```

**✅ Shipped PR-16 (2026-05-02)**: auto-mark-done logic eliminates T4-T5 manual steps when Manager opts-in via `subject_patterns.auto_done_eligible` toggle. Auto-DONE fires on CLASSIFIED + APPROVED + eligible pattern. See [`CURRENT-STATE.md`](./CURRENT-STATE.md) PR-16 milestone section.

### Scenario 5: Rejection workflow với resubmit cycle

```
Cycle 1:
  T0: Reject email → NEW + REJECTED
  T1: Manager: Move to In Review → IN_REVIEW + REJECTED
  T2: Developer fixes + resubmits
  T3: Approve email → IN_REVIEW + APPROVED

Cycle 2 (rare — Apple re-rejects after partial approve):
  T4: Reject email arrives → IN_REVIEW + REJECTED
  T5: Same ticket, outcome flipped REJECTED again
  T6: Manager continues working

Cycle close:
  T7: Final approve email → IN_REVIEW + APPROVED
  T8: Manager: Mark Done → DONE + APPROVED
```

**Key**: outcome reflects most-recent email signal. Cycles don't fragment tickets — same `(app_id, type_id, platform)` group.

### Scenario 6: Archive old historical tickets

```
T0: Old ticket DONE + APPROVED for 6 months
T1: Manager wants clean Done tab
T2: Manager: Archive → state=ARCHIVED + APPROVED unchanged
T3: Ticket → Archived tab + Approve chip
T4: Hidden từ active workflow tabs
```

### Scenario 7: Project killed (DONE + REJECTED)

```
T0: Reject email → NEW + REJECTED
T1: Manager: Move to In Review → IN_REVIEW + REJECTED
T2: Decision: project killed (no fix planned)
T3: Manager: Mark Done → DONE + REJECTED
T4: Ticket → Done tab + Reject chip (historical record)
```

**Visibility**: Done tab + Reject chip surfaces all "killed" projects. Useful retrospective view.

### Scenario 8: Manager mistakenly closed → reopen

```
T0: Ticket DONE + APPROVED
T1: New email arrives same app+type → reopens?
```

**Current behavior**: depends on system. Likely creates new entry on existing terminal ticket OR creates new ticket. Verify với codebase nếu cần precise behavior.

**✅ Partially shipped PR-16b + PR-16b.5**: Auto-reopen semantics defined cho REJECTED post-auto-DONE (Q2.D + Q3.B; gated by Manager opt-in `auto_reopen_eligible`, default FALSE preserves "build mới = ticket mới" Apple workflow semantic). Manual reopen Q2.B affordance verification pending Manager UAT Scenario D.

---

## 8. Common confusions clarified

### Confusion 1: "Approved tab vs Approve chip same thing?"

**No, different**:
- Approved tab: `state = APPROVED` (Manager set lifecycle position via "Mark Approved")
- Approve chip: `latest_outcome = APPROVED` (Apple email said this)

Ticket có thể `state=NEW` + `latest_outcome=APPROVED` (Apple approved, Manager hasn't acknowledged) → visible **Open tab + Approve chip**, NOT Approved tab.

### Confusion 2: "Why state=APPROVED rare in production?"

PR-13 investigation noted: `state=APPROVED` rare. Lý do:
- Most approved tickets immediately marked DONE by Manager (workflow shortcut NEW → DONE)
- `state=APPROVED` reserved cho FOLLOW_UP cases (Apple approved + đợi next milestone trước close)
- Auto-mark-done logic ✅ shipped PR-16; state=APPROVED có thể become near-extinct post-Manager-opt-in → drop tab decision deferred PR-17+ telemetry-informed (Q8.D defer; 1-2 months data needed)

### Confusion 3: "Reclassify changes both dimensions?"

**No, primarily outcome dimension**:
- Reclassify re-runs subject_patterns + app_registry lookup
- Updates `latest_outcome` based on subject pattern match
- May change `classification_status` (UNCLASSIFIED_APP → CLASSIFIED)
- Does **NOT** touch `state` (Manager workflow preserved)
- Exception: if classification creates new ticket (UNCLASSIFIED_APP → CLASSIFIED moves email to new ticket), new ticket starts state=NEW

### Confusion 4: "Unclassified tab chips hidden why?"

UNCLASSIFIED_TYPE tickets có no extracted outcome (email không match patterns yet). UI design choice (PR-13 Decision):
- Unclassified tab focus: "fix classification first"
- Outcome chip filter not meaningful trong this state
- Hide chips reduces dead UI

### Confusion 5: "Email 1 reject → Email 2 approve, ticket trong Reject chip không?"

**No, không trong Reject chip post-Email-2**.
- `latest_outcome` reflects MOST RECENT email
- Email 2 (APPROVE) overwrites latest_outcome = APPROVED
- Reject chip filter `latest_outcome = REJECTED` → ticket không match
- Audit trail (REJECT history) lives trong ticket detail timeline, không trong filter

### Confusion 6: "Why same email show 2 places sau reclassify?" (PR-15.5 fix)

**Pre-PR-15.5 bug**: stale EMAIL entries leaked vào TICKET-10000 sau reclassify.

**Root cause**: `ticket_entries` append-only invariant (audit log). Reclassify đặt new EMAIL entry trong new ticket nhưng **không xóa** old EMAIL entry trong unclassified ticket. UI query không filter → duplicate visible.

**Fix PR-15.5**: read-time filter using `email_messages.ticket_id` source of truth. Append-only invariant preserved + UI shows current state only.

---

## 9. Pre-PR-16 implications

### Auto-mark-done logic (Manager request)

Manager đề xuất earlier session:
- Trigger: `latest_outcome = APPROVED` on classification
- Action: `state = NEW → state = DONE` automatically

Bypasses lifecycle:
- Skip Open tab entirely (no Manager review opportunity)
- Skip Approved tab entirely
- Direct to Done tab
- Manager loses visibility ("I never saw this ticket")

### 8 Design questions cho PR-16

1. **Manager visibility safeguard**: dwell time trong Open trước auto-DONE? Notification mechanism?
2. **Override mechanism**: re-open auto-DONE ticket cho Manager review?
3. **Edge case**: REJECTED email arrives sau auto-DONE → reverse? Stay DONE?
4. **Audit trail**: system actor type (`actor_type='SYSTEM'` distinguishable từ Manager actions?)
5. **Confidence threshold**: subject_patterns + HTML extractor agree required? Or single source ok?
6. **App registry timing**: auto-DONE before app added → app_registry add then need backfill?
7. **Notification flow**: weekly digest cho auto-completed tickets?
8. **Approved tab fate**: state=APPROVED becomes extinct → drop tab?

### Other PR-17+ candidates from PR-15.5

- Auto-archive empty unclassified tickets (TICKET-10000 cleanup khi entries reduce zero)
- "Reclassified from TICKET-10000" annotation new ticket (mirror reclassify_out audit)
- entry_count semantics review (count emails vs total entries including STATE_CHANGE)

---

## Mental model summary

> **Tab** answers: "Where is this ticket trong MY workflow?"
> **Chip** answers: "What did Apple say about this ticket?"

Two independent questions → two independent filters → AND combined.

**3 dimensions actually exist trong DB**:
| Dimension | Type | Source | Manager controls |
|---|---|---|---|
| state | Lifecycle | Workflow actions | YES |
| latest_outcome | Apple verdict | Email signal | NO (indirect via subject_patterns rules) |
| classification_status | Classifier verdict | App/type matching | NO (indirect via app_registry adds) |

UI surfaces 2 dimensions (tabs + chips). classification_status surfaces via Unclassified tab grouping (3rd dimension hidden trong UI but observable).

**Anti-mental-model** (pre-PR-13): "What is the ticket's current bucket?" — tried to collapse 2 dimensions into 1, lost expressiveness.

---

## References

- **PR-9**: Q1 Option A — subject_patterns single source of truth cho outcome
- **PR-12**: Apple rejection parser + Backfill button
- **PR-13**: Outcome filter dimension separation (5-tab + 5-chip)
- **PR-14**: Byte-level QP decoder + corrupt payload repair
- **PR-15**: Slug generator non-ASCII support
- **PR-15.5**: Stale-EMAIL filter post-reclassify (hotfix)
- **PR-16**: Auto-mark-done + auto-completed banner + auto-reopen Manager opt-in (4 sub-PRs + 1 hotfix shipped 2026-05-02 / 2026-05-03)
- **PR-17+**: Telemetry capture (Q1.E + Q8) + Path C DB integration tests + buildSavePayload helper extraction (PR-16a.5 follow-up)

**Code locations**:
- State enum: `lib/store-submissions/schemas/ticket.ts`
- Outcome enum: `lib/store-submissions/schemas/email-message.ts`
- Subject patterns: `store_mgmt.subject_patterns` table
- Reclassify RPC: `supabase/migrations/20260425000002_store_mgmt_reclassify_rpc.sql`
- Find or create ticket: `supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql`
- UI tab/chip: `components/store-submissions/inbox/InboxClient.tsx`
- Query filter: `lib/store-submissions/queries/tickets.ts`
