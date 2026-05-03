# PR-16 — Auto-mark-done APPROVED logic — Design decisions

> Design phase document cho PR-16 auto-mark-done feature. 8 design questions resolved với rationale + tradeoffs + implementation guidance.

**Date locked**: 2026-05-01 (post PR-15.5 hotfix)
**Status**: Design phase complete, awaiting implementation
**Estimated effort**: ~5.5h split across 3 sub-PRs (PR-16a/b/c)

---

## Mục lục

1. [Context](#1-context)
2. [Proposal recap](#2-proposal-recap)
3. [Design decisions Q1-Q8](#3-design-decisions-q1-q8)
4. [Schema changes](#4-schema-changes)
5. [Implementation flow](#5-implementation-flow)
6. [Sub-PR breakdown](#6-sub-pr-breakdown)
7. [Manager UAT plan](#7-manager-uat-plan)
8. [Risk register](#8-risk-register)
9. [References](#9-references)

---

## 1. Context

### Manager request (earlier session)

Manager requested auto-mark-done logic cho 2 cases:

1. **App chưa có ticket**: First email arrives với `latest_outcome=APPROVED` → ticket created + immediately auto-mark-done
2. **App đang có ticket**: Outcome flips từ non-APPROVED → APPROVED → auto-mark-done

**Goal**: Reduce Manager friction cho clean APPROVE cases. Eliminate manual "Mark Done" clicks for tickets that don't need review.

### Pre-PR-16 disposition

PR-12 → PR-15.5 shipped. Foundation pieces ready:
- Subject patterns single source of truth (PR-9 Q1 Option A)
- Outcome filter dimension UI (PR-13)
- Reclassify path with stale entry filter (PR-15.5)
- 3-dimension model documented (state / latest_outcome / classification_status)

PR-16 builds on these. Workflow change → Manager UAT critical.

### Why design phase needed

Auto-mark-done = **workflow logic change**, không pure data fix. Different risk profile từ data bugs:
- Data bugs: wrong values stored, recoverable
- Workflow bugs: Manager process disrupted, harder to recover (audit trail, training)

Design phase resolves edge cases trước implementation. 8 questions surface scope concerns.

---

## 2. Proposal recap

### Auto-mark-done trigger

**Condition**:
```
classification_status = 'CLASSIFIED'
AND latest_outcome = 'APPROVED'
AND subject_pattern.auto_done_eligible = TRUE
```

**Action**:
```
state = state_before  → state = 'DONE'
ticket_state_changes log entry với actor_id = SYSTEM_USER_ID
```

**Effect**:
- Skip Open tab entirely (no Manager review needed)
- Direct to Done tab
- Manager visibility via inbox banner

### Why auto-mark-done valuable

Common case observed production:
- Apple approves submission → ticket NEW + APPROVED
- Manager has no action to take (release pipeline auto-handles)
- Manager clicks "Mark Done" purely to clear inbox

Auto-mark-done eliminates manual click. Friction reduction.

### Why auto-mark-done risky

Workflow visibility loss:
- Manager doesn't see ticket trong Open tab
- "I never knew Apple approved X" complaint risk
- Audit trail relies on `ticket_state_changes` (Manager must dig)

Mitigations needed (banner, override, telemetry).

---

## 3. Design decisions Q1-Q8

### Q1 — Manager visibility safeguard

**Concern**: Auto-DONE bypasses Open tab. Manager loses visibility.

**Decision**: **Q1.E (inbox banner)**

**Rationale**:
- Real-time visibility (Manager checking inbox sees auto-completed)
- Low infrastructure cost (no email/Slack)
- Easy to add notifications later (PR-17+)
- Manager retains override capability (Q2)

**Implementation**:
- Banner trong Inbox khi count > 0 cho recent auto-DONE tickets (last 7 days)
- "X tickets auto-completed last 7 days [View]"
- Click → dedicated view list
- Auto-hides khi count = 0
- MANAGER role only

**Discarded options**:
- Q1.A (no safeguard): visibility loss too severe
- Q1.B (dwell time + cron): complexity + Manager confusion ("tại sao biến mất từ Open?")
- Q1.C (per-app config): defeats friction-reduction goal
- Q1.D (email digest): infrastructure expansion

**Telemetry to capture**:
- Banner click frequency
- View list page views
- Manager UAT signal (sufficient visibility?)

---

### Q2 — Override mechanism

**Concern**: Auto-DONE ticket needs Manager intervention sau (e.g. follow-up needed).

**Decision**: **Q2.B (manual reopen) + Q2.D (auto-reopen on REJECTED)**

**Rationale**:
- Q2.B: Existing pattern, low complexity, auditable
- Q2.D: New REJECTED email = real workflow signal, không clean approval

**Implementation Q2.B**:
- "Reopen" button on DONE tickets
- State transition `DONE → IN_REVIEW`
- Audit log records reopen action (actor_id = Manager)
- Same affordance cho manual DONE + auto-DONE

**Implementation Q2.D**:
- New REJECTED email arrives ticket có state=DONE + actor=SYSTEM
- Auto-transition `DONE → IN_REVIEW`
- ticket_state_changes log entry với reason='auto_reopen_rejected'
- Manager notified via banner (separate "needs reattention" surface)

**Discarded options**:
- Q2.A (no reopen): inflexible
- Q2.C (auto-reopen on any email): redundant cho APPROVED

**State machine validation needed**:
- Verify `DONE → IN_REVIEW` transition legal trong existing state machine
- If not, migration needed

---

### Q3 — Edge case: REJECTED email arrives sau auto-DONE

**Concern**: Auto-DONE assumed completion. New REJECTED contradicts.

**Decision**: **Q3.B (auto-reopen IN_REVIEW)**

**Rationale**:
- Aligns Q2.D
- IN_REVIEW signals "previously handled, needs reattention"
- Differs từ NEW (fresh arrival) appropriately
- No new UI surface needed

**Implementation**:
- Same as Q2.D
- Banner could distinguish "newly auto-completed" vs "auto-reopened"
- Or: single "needs attention" banner aggregating both

**Discarded options**:
- Q3.A (silent flip): contradiction confusing
- Q3.C (reset to NEW): noisy if previously handled
- Q3.D (Anomalies view): new surface, defer

**Edge case nested**: Manager reopens auto-DONE → ticket state=IN_REVIEW. New REJECTED arrives. State stays IN_REVIEW (already in working bucket). No double-transition.

---

### Q4 — Audit trail

**Concern**: System actor distinguishable từ Manager.

**Decision**: **Q4.A (reserved system UUID) + Q4.C (reason field)**

**Rationale**:
- Q4.A: Existing schema unchanged, simple
- Q4.C: Granular debugging context

**Implementation Q4.A**:
- System user reserved UUID declared trong code:
  ```typescript
  export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
  ```
- No schema change (uses existing actor_id column)
- UI logic:
  ```typescript
  if (entry.actor_id === SYSTEM_USER_ID) render('System')
  else render(actor.name)
  ```

**Implementation Q4.C**:
- New column `ticket_state_changes.reason TEXT NULL`
- Captures auto-DONE rationale
- Future system actions also use reason field
- UI inline display: `[State change] DONE → IN_REVIEW (reason: auto_reopen_rejected)`

**Reserved reason values**:
- `auto_mark_done` — initial auto-DONE
- `auto_reopen_rejected` — REJECTED email post-auto-DONE
- `manager_reopen` — Manager-initiated reopen
- (future: `auto_archive_empty`, etc.)

**Discarded options**:
- Q4.B (actor_type enum): redundant với reserved UUID approach

---

### Q5 — Confidence threshold

**Concern**: subject_patterns alone sufficient cho auto-DONE? Or require additional confirmation?

**Decision**: **Q5.A (subject patterns single source) + Q5.D (Manager opt-in per pattern)**

**Rationale**:
- Q5.A: Aligns Q1 Option A discipline (PR-9), don't violate single-source-of-truth
- Q5.D: Manager control without architectural change

**Implementation Q5.A**:
- Trust existing subject_patterns pipeline
- HTML extractor stays audit-only (PR-9 discipline preserved)

**Implementation Q5.D**:
- New column `subject_patterns.auto_done_eligible BOOLEAN NOT NULL DEFAULT FALSE`
- Settings → Email rules UI: toggle per pattern
- Default false (opt-in only)
- Manager curates which patterns considered "high confidence"

**Trigger condition**:
```sql
WHERE classification_status = 'CLASSIFIED'
  AND latest_outcome = 'APPROVED'
  AND subject_pattern_matched.auto_done_eligible = TRUE
```

**Discarded options**:
- Q5.B (subject + HTML extractor agree): violates Q1 Option A discipline
- Q5.C (subject + extracted_payload agree): same Q5.B issue

**Manager UAT signal**:
- Initial setup: Manager toggles 1-2 patterns "high confidence" cho test
- Observe accuracy 1-2 weeks
- Expand based on confidence

---

### Q6 — App registry timing

**Concern**: Email arrives APPROVED + app NOT in registry yet. Auto-DONE trigger?

**Decision**: **Q6.A (CLASSIFIED only) + Q6.B (retroactive on reclassify)**

**Rationale**:
- Q6.A: UNCLASSIFIED_APP rows skip auto-DONE (no actionable target)
- Q6.B: Manager adds app late + reclassify → retroactive auto-DONE works gracefully

**Implementation Q6.A**:
- Auto-DONE check after classification status determined
- UNCLASSIFIED_APP/UNCLASSIFIED_TYPE skip auto-DONE
- Tickets sit trong Unclassified tab until Manager adds app/rule

**Implementation Q6.B**:
- Reclassify path includes auto-DONE check post-CLASSIFIED transition
- `reclassify_email_tx` RPC update:
  ```sql
  -- After successful reclassify to CLASSIFIED status
  IF v_new_classification_status = 'CLASSIFIED'
     AND v_latest_outcome = 'APPROVED'
     AND v_subject_pattern.auto_done_eligible
  THEN
    UPDATE tickets SET state = 'DONE' WHERE id = v_new_ticket_id;
    INSERT INTO ticket_state_changes (...) VALUES (
      v_new_ticket_id, 'STATE_CHANGE', SYSTEM_USER_ID, NULL,
      jsonb_build_object('type', 'auto_mark_done', 'reason', 'apple_approved_post_reclassify')
    );
  END IF;
  ```

**Atomicity**: Auto-DONE must execute trong same transaction as reclassify. PR-15.5 stale filter logic preserved.

**Discarded options**:
- Q6.C (queue table): maintenance burden

---

### Q7 — Notification flow

**Concern**: Manager visibility loss. Notifications offset?

**Decision**: **Q7.A (banner only initially)**, defer Q7.E (Slack hybrid) based on UAT

**Rationale**:
- Banner = primary visibility mechanism (Q1.E)
- Notifications = additive enhancement
- Easier add later than retire
- Manager UAT reveals if banner sufficient

**Implementation phase 1 (PR-16)**:
- Inbox banner only
- No email/Slack notifications

**Implementation phase 2 (PR-17+, conditional)**:
- Manager UAT signals banner insufficient → add notifications
- Options: weekly digest email, Slack daily summary
- Manager preference dependent

**Discarded options**:
- Q7.B/Q7.C (email digest): premature, requires email infrastructure
- Q7.D (Slack real-time): noise risk

**UAT feedback questions cho Manager post-deploy**:
- "Did banner give sufficient visibility into auto-completed tickets?"
- "Any tickets you wished you'd seen but didn't?"
- "Would daily/weekly digest help?"

---

### Q8 — Approved tab fate

**Concern**: state=APPROVED already rare per PR-13 investigation. Drop tab?

**Decision**: **Q8.D (defer decision, telemetry-informed PR-17+)**

**Rationale**:
- Auto-DONE will reveal state=APPROVED actual usage
- Drop tab = irreversible UX disruption
- Keep tab = reversible (just unused)
- 1-2 months production data informs decision

**Implementation**:
- No change PR-16
- Capture telemetry:
  - Count tickets reaching state=APPROVED post-PR-16 ship
  - Count auto-DONE per day
  - Manager click frequency Approved tab
  - Manager use of "Mark Approved" button
- Re-evaluate PR-17+ candidate

**Decision criteria post-data**:
- < 5 tickets/month state=APPROVED → drop tab + state value
- 5-20/month → rename "Follow-up" tab (Q8.C)
- > 20/month → keep tab as-is (Q8.A)

**Discarded options**:
- Q8.A (keep) premature decision
- Q8.B (drop) premature decision
- Q8.C (rename) premature decision

---

## 4. Schema changes

### Migration outline

```sql
-- File: supabase/migrations/20260502xxx_pr16_auto_mark_done.sql

-- Q4 — audit trail granularity
ALTER TABLE store_mgmt.ticket_state_changes
ADD COLUMN reason TEXT NULL;

COMMENT ON COLUMN store_mgmt.ticket_state_changes.reason IS
  'Reason for state change. Reserved values: auto_mark_done, '
  'auto_reopen_rejected, manager_reopen. Free-form for future actions.';

-- Q5 — Manager opt-in per pattern
ALTER TABLE store_mgmt.subject_patterns
ADD COLUMN auto_done_eligible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN store_mgmt.subject_patterns.auto_done_eligible IS
  'When TRUE, matching emails với latest_outcome=APPROVED trigger '
  'auto-mark-done. Manager opt-in per pattern. Default FALSE.';

-- Q4 — system user account (no schema change, code constant)
-- Constant declared TS code:
--   export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
-- 
-- Optional: insert reserved row trong users table if FK constraint exists:
-- INSERT INTO public.users (id, email, name, role)
-- VALUES (
--   '00000000-0000-0000-0000-000000000001',
--   'system@store-mgmt.internal',
--   'System',
--   'SYSTEM'
-- ) ON CONFLICT (id) DO NOTHING;
```

### Verification queries

```sql
-- Verify columns added
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'store_mgmt'
  AND table_name IN ('ticket_state_changes', 'subject_patterns')
  AND column_name IN ('reason', 'auto_done_eligible');

-- Verify defaults
SELECT auto_done_eligible, COUNT(*)
FROM store_mgmt.subject_patterns
GROUP BY auto_done_eligible;
-- Expected: all FALSE post-migration
```

### Backward compat

- `reason` column nullable → existing rows unaffected
- `auto_done_eligible` default FALSE → existing patterns disabled
- Manager opts-in per pattern (no surprise auto-DONE post-deploy)

---

## 5. Implementation flow

### Live email arrival

```
Email arrives (cron sync)
  ↓
parseGmailMessage + extractApple
  ↓
classify_email_tx RPC
  ↓
classification_status determined
  ├─ UNCLASSIFIED_TYPE/APP → ticket Unclassified bucket
  └─ CLASSIFIED → check auto-DONE conditions
      ↓
      latest_outcome = APPROVED
      AND subject_pattern.auto_done_eligible = TRUE
      ↓
      [YES]
      ├─ find_or_create_ticket_tx (existing)
      ├─ ticket state set to DONE (instead of NEW)
      ├─ ticket_state_changes log:
      │    actor_id = SYSTEM_USER_ID
      │    type = 'auto_mark_done'
      │    reason = 'apple_approved_initial'
      └─ Skip Open tab entirely
      
      [NO]
      └─ Normal flow: ticket state = NEW
```

### Reclassify path (Q6.B retroactive)

```
Manager triggers reclassify
  ↓
reclassify_email_tx RPC
  ↓
new classification determined
  ├─ UNCLASSIFIED → no auto-DONE
  └─ CLASSIFIED + APPROVED + auto_done_eligible
      ↓
      Auto-DONE check (same as live)
      ↓
      ticket state = DONE
      ticket_state_changes log:
        reason = 'apple_approved_post_reclassify'
```

### REJECTED email post-auto-DONE (Q3.B)

```
Email arrives → ticket exists state=DONE + auto_done origin
  ↓
classifier detects new latest_outcome = REJECTED
  ↓
Auto-reopen check:
  IF state = 'DONE'
     AND latest auto-DONE state_change actor_id = SYSTEM_USER_ID
     AND new latest_outcome = 'REJECTED'
  THEN
    state = 'IN_REVIEW'
    ticket_state_changes log:
      actor_id = SYSTEM_USER_ID
      type = 'auto_reopen'
      reason = 'apple_rejected_post_auto_done'
```

**Detection mechanism**:
- Query latest state_change cho ticket
- IF actor_id = SYSTEM_USER_ID AND type = 'auto_mark_done' → auto-reopen eligible
- ELSE: don't auto-reopen (manual DONE preserved)

### Manager Inbox load (Q1.E banner)

```
GET /inbox
  ↓
Page load query:
  - Tickets per filter (existing)
  - Auto-completed count (last 7 days):
      SELECT COUNT(*) FROM tickets t
      JOIN ticket_state_changes sc ON sc.ticket_id = t.id
      WHERE sc.actor_id = SYSTEM_USER_ID
        AND sc.type = 'auto_mark_done'
        AND sc.created_at > NOW() - INTERVAL '7 days'
        AND t.state = 'DONE'
  ↓
Render Inbox với banner if count > 0
```

### Manager click banner

```
Banner click → /inbox/auto-completed
  ↓
Dedicated view:
  - List auto-completed tickets last 7 days
  - Sort by completion time
  - Quick actions: View detail, Reopen
  - Filter: time range, app
```

---

## 6. Sub-PR breakdown

### PR-16a — Core auto-DONE logic (~2h)

**Scope**:
- Migration: reason column + auto_done_eligible column
- RPC update: classify_email_tx + reclassify_email_tx auto-DONE check
- Settings UI: subject_patterns toggle
- Tests: unit tests cho auto-DONE conditions

**Files**:
- `supabase/migrations/20260502xxx_pr16_auto_mark_done.sql` (NEW)
- `supabase/migrations/*classify*` (UPDATE)
- `supabase/migrations/*reclassify*` (UPDATE)
- `lib/store-submissions/constants.ts` (NEW: SYSTEM_USER_ID)
- `lib/store-submissions/schemas/subject-pattern.ts` (UPDATE: auto_done_eligible field)
- `components/store-submissions/email-rules/SubjectPatternRow.tsx` (UPDATE: toggle)
- `lib/store-submissions/queries/subject-patterns.ts` (UPDATE: include field)

**Tests**:
- Subject pattern auto_done_eligible default FALSE
- Email arrives, pattern auto_done_eligible=TRUE + APPROVED → auto-DONE
- Email arrives, pattern auto_done_eligible=FALSE + APPROVED → state=NEW (control)
- Email arrives, pattern auto_done_eligible=TRUE + REJECTED → state=NEW (outcome guard)
- UNCLASSIFIED → no auto-DONE
- Reclassify retroactive → auto-DONE post-CLASSIFIED transition

**Risk flags**:
- RPC atomicity: auto-DONE must execute trong same transaction as classification
- Backward compat: existing patterns default FALSE, no surprise behavior

### PR-16b — Auto-reopen + UI banner (~1.75h)

**Scope**:
- Auto-reopen on REJECTED email post-auto-DONE
- Inbox banner cho recent auto-completed tickets
- Dedicated /auto-completed view
- Telemetry capture infrastructure

**Files**:
- `supabase/migrations/*classify*` (UPDATE: auto-reopen logic)
- `components/store-submissions/inbox/AutoCompletedBanner.tsx` (NEW)
- `app/(dashboard)/store-submissions/inbox/auto-completed/page.tsx` (NEW)
- `lib/store-submissions/queries/auto-completed.ts` (NEW)

**Tests**:
- New REJECTED email post-auto-DONE → state=IN_REVIEW
- New APPROVED email post-auto-DONE → state stays DONE (no double-transition)
- Manual DONE ticket + REJECTED email → state stays DONE (auto-reopen only fires for SYSTEM_USER_ID origin)
- Banner count query correct (last 7 days, SYSTEM origin only)
- Banner hidden when count = 0
- Manager-only banner visibility

**Risk flags**:
- Detection mechanism (latest state_change check) → query optimization
- Banner refresh on revalidate

### PR-16c — Tests + docs (~1.5h)

**Scope**:
- Edge case tests
- Integration tests
- CURRENT-STATE PR-16 milestone section
- Manager UAT plan document

**Files**:
- Test files trong existing structure
- `docs/store-submissions/CURRENT-STATE.md` (UPDATE)
- `TODO.md` (UPDATE: PR-16 COMPLETED)

**Tests**:
- Edge case: ticket reopened manually + new APPROVED → no double auto-DONE
- Edge case: rapid succession APPROVED → REJECTED → APPROVED → final state correct
- Edge case: subject_patterns.auto_done_eligible toggled mid-cycle
- Integration: full cron sync → classify → auto-DONE flow
- Integration: reclassify path retroactive auto-DONE

**Docs**:
- CURRENT-STATE PR-16 milestone section (~150 lines):
  - Design decisions Q1-Q8 summary
  - Schema changes
  - Implementation flow diagram
  - Telemetry capture
  - Manager UAT plan
- TODO PR-16 COMPLETED section
- Stale tag retag (PR-16+ → PR-17+)

---

## 7. Manager UAT plan

### Pre-deploy preparation

**Manager training**:
- Walk through auto-DONE concept (5 min)
- Show subject_patterns toggle UI (2 min)
- Explain banner + auto-completed view (3 min)
- Discuss override mechanisms (5 min)

**Manager opt-in setup**:
- Start with 1-2 high-confidence patterns enabled
- Recommended: "Review of your X (iOS) submission is complete." (clean approval)
- Avoid: ambiguous patterns initially

### Phase 1 — PR-16a deploy (Core logic)

**Verification (week 1)**:
- Verify subject_patterns toggle UI accessible
- Toggle 1 pattern auto_done_eligible=TRUE
- Wait for next APPROVED email match → check auto-DONE fires
- Verify ticket goes directly Done tab (skip Open)
- Verify ticket_state_changes audit trail present

**Manager feedback**:
- "Did auto-DONE fire correctly?"
- "Were there any false positives?"
- "Did you miss seeing tickets you wished you'd reviewed?"

### Phase 2 — PR-16b deploy (Banner + auto-reopen)

**Verification (week 2)**:
- Inbox banner visible với count
- Click banner → auto-completed view loads
- Reopen button on auto-DONE ticket works
- Auto-reopen on REJECTED email fires correctly

**Manager feedback**:
- "Was banner visibility sufficient?"
- "Did you use the auto-completed view?"
- "Were any tickets auto-reopened unexpectedly?"

### Phase 3 — Production telemetry (week 3-4)

**Metrics to capture**:
- Auto-DONE count per day
- Manual DONE count per day (control)
- Banner click frequency
- Reopen frequency (manual + auto)
- state=APPROVED ticket count (Q8 telemetry)

**Decision criteria**:
- Auto-DONE accuracy ≥ 95% (false positive rate)
- Manager satisfaction (qualitative)
- No production incidents (workflow disruption)

### Phase 4 — PR-17+ candidates from UAT data

Based on Phase 3 telemetry:
- Q7 notifications (if banner insufficient)
- Q8 Approved tab fate (if state=APPROVED truly rare)
- Threshold tuning (if patterns over/under-aggressive)
- Additional auto-* logic (if Manager requests)

---

## 8. Risk register

### High risk

| Risk | Mitigation |
|---|---|
| Auto-DONE false positive (wrong patterns matched) | Manager opt-in per pattern (Q5.D), small initial set |
| Manager misses important tickets | Banner + dedicated view, override mechanisms |
| Workflow disruption Manager training gap | Phase 1 staged rollout, training pre-deploy |

### Medium risk

| Risk | Mitigation |
|---|---|
| Auto-reopen disruption (REJECTED email post-DONE) | Detection limited to SYSTEM origin (Q4.A check) |
| RPC atomicity break | Single transaction enforcement, integration tests |
| Banner count query performance | Indexed on actor_id + created_at, head:true count |

### Low risk

| Risk | Mitigation |
|---|---|
| Migration backward compat | Defaults preserve current behavior |
| Schema constraint violation | Verification queries post-migration |
| State machine transition unknown | Pre-implementation verify DONE → IN_REVIEW legal |

### Defer to PR-17+

- Approved tab fate (Q8 telemetry-informed)
- Notification expansion (Q7 conditional)
- Threshold tuning (Manager UAT signals)
- Additional auto-* logic per Manager request

---

## 9. References

### Related PRs

- **PR-9**: Q1 Option A — subject_patterns single source of truth cho outcome
- **PR-12**: Apple rejection parser + Backfill button
- **PR-13**: Outcome filter dimension separation (5-tab + 5-chip)
- **PR-14**: Byte-level QP decoder + corrupt payload repair
- **PR-15**: Slug generator non-ASCII support
- **PR-15.5**: Stale-EMAIL filter post-reclassify (hotfix)
- **PR-16**: This design — auto-mark-done APPROVED logic

### Code locations

- **State enum**: `lib/store-submissions/schemas/ticket.ts`
- **Outcome enum**: `lib/store-submissions/schemas/email-message.ts`
- **Subject patterns table**: `store_mgmt.subject_patterns`
- **Classify RPC**: `supabase/migrations/*classify*` (existing)
- **Reclassify RPC**: `supabase/migrations/20260425000002_store_mgmt_reclassify_rpc.sql`
- **Find or create ticket**: `supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql`
- **UI tab/chip**: `components/store-submissions/inbox/InboxClient.tsx`
- **Query filter**: `lib/store-submissions/queries/tickets.ts`

### Documentation

- **CURRENT-STATE.md**: `docs/store-submissions/CURRENT-STATE.md`
- **02-gmail-sync.md**: `docs/store-submissions/02-gmail-sync.md`
- **State-outcome dimensions training**: `inbox-state-outcome-dimensions.md`

### External references

- Q1 Option A discipline (PR-9 design): subject_patterns single source of truth
- 3-dimension model: state / latest_outcome / classification_status (PR-13 separation)
- Append-only invariant #2: ticket_entries event log (PR-15.5 filter)

---

## Decisions table summary

| Q | Decision | Schema impact | UI impact |
|---|---|---|---|
| Q1 (Visibility) | Q1.E inbox banner | None | New banner + view |
| Q2 (Override) | Q2.B + Q2.D | None | Reopen button |
| Q3 (Post-DONE REJECTED) | Q3.B auto-reopen | None | (covered Q2.D) |
| Q4 (Audit) | Q4.A + Q4.C | reason column | Display reason inline |
| Q5 (Confidence) | Q5.A + Q5.D | auto_done_eligible column | Settings toggle |
| Q6 (App registry timing) | Q6.A + Q6.B | None | (RPC update) |
| Q7 (Notifications) | Q7.A initially | None | Banner only |
| Q8 (Approved tab) | Q8.D defer | None | (telemetry capture) |

**Schema changes**: 2 column additions, 1 migration
**UI changes**: Banner + view + Settings toggle + Reopen button + reason display
**Implementation effort**: ~5.5h split 3 sub-PRs

---

## Implementation order

1. **PR-16a** (Foundation): Migration + RPC + Settings toggle (~2h)
2. **PR-16b** (Visibility): Banner + auto-completed view + auto-reopen (~1.75h)
3. **PR-16c** (Polish): Tests + docs + Manager UAT plan (~1.5h)

**Total**: ~5.5h, 3 sub-PRs over 1-2 sessions

**Pre-implementation checks**:
- [ ] Verify state machine allows `DONE → IN_REVIEW` transition
- [ ] Verify FK constraints on ticket_state_changes.actor_id (SYSTEM_USER_ID acceptable?)
- [ ] Verify reclassify RPC atomicity preserved with new auto-DONE check
- [ ] Verify Settings UI extensible for new subject_patterns column

**Post-implementation Manager UAT**:
- Phase 1 (week 1): Verify core auto-DONE
- Phase 2 (week 2): Verify banner + auto-reopen
- Phase 3 (week 3-4): Telemetry capture
- Phase 4 (PR-17+): Decisions based on UAT data

---

**Document status**: Design phase complete. Ready PR-16 implementation kickoff.
