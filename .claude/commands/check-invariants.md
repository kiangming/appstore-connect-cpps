---
description: Verify code changes không vi phạm critical invariants
---

Verify pending changes (git diff hoặc PR) không vi phạm critical invariants của project.

## Steps

1. **Get diff**:
   ```bash
   git diff HEAD --stat  # summary
   git diff HEAD          # full diff
   ```

2. **Check against 10 invariants** của `CLAUDE.md`:

   - [ ] **Invariant 1**: One open ticket per `(app_id, type_id, platform_id)` — search for `INSERT INTO tickets` không có FOR UPDATE lock surrounding
   - [ ] **Invariant 2**: `ticket_entries` append-only (except COMMENT edits) — search for `UPDATE ticket_entries` không phải COMMENT edit
   - [ ] **Invariant 3**: EMAIL entries must have `metadata.email_snapshot` — search for `entry_type.*EMAIL` creation without snapshot field
   - [ ] **Invariant 4**: User-provided regex via RE2 only — search for `new RegExp`, `/.../.test(`, `.match(` trên user-provided patterns
   - [ ] **Invariant 5**: Gmail tokens encrypted before storage — search for `access_token` / `refresh_token` insert không qua `encryptToken()`
   - [ ] **Invariant 6**: Terminal state consistency — state ∈ terminal → closed_at + resolution_type set
   - [ ] **Invariant 7**: Forward-only migrations — check `supabase/migrations/` không có down migrations
   - [ ] **Invariant 8**: Classification status mapping — DROPPED không INSERT email_messages với ticket_id
   - [ ] **Invariant 9**: No secrets in code — grep for patterns like `sk_`, `eyJ`, `-----BEGIN PRIVATE KEY`, literal tokens
   - [ ] **Invariant 10**: No `any` type without justification comment

3. **Common anti-patterns to flag**:
   - `setTimeout` hoặc `setInterval` trong server code (use cron)
   - `localStorage` / `sessionStorage` trong components (TanStack Query / React state only)
   - Direct `fetch('/api/...')` từ Server Components (use data fetching function directly)
   - Swallowed exceptions `catch {}` without Sentry
   - Hardcoded UUIDs hoặc URLs trong business logic
   - Untyped API responses

4. **Output format**:

   ```
   ✅ Invariants verified — no violations detected
   
   OR
   
   ⚠ Potential violations found:
   
   1. file.ts:45 — new RegExp(userInput) detected. Use re2Exec() instead.
      → Rule: CLAUDE.md invariant #4 "User-provided regex ONLY via RE2"
      → Fix: import { re2Exec } from '@/lib/regex/re2'; re2Exec(userInput, input);
   
   2. migration.sql — appears to have down migration (DROP statement).
      → Rule: CLAUDE.md invariant #7 "Forward-only migrations"
      → Fix: if need revert, write new migration reversing changes
   
   ...
   ```

5. **Recommend**:
   - Run `pnpm lint && pnpm typecheck && pnpm test` trước khi commit
   - Update `docs/` nếu architectural change

## Don't

- Don't just rubber-stamp. Read actual diff carefully.
- Don't flag false positives — vd `new RegExp('^[a-z]+$')` cho hardcoded pattern trong code logic khác với user-provided pattern.
- Don't skip the git diff — invariants depend on actual changes.
