---
description: Tạo migration SQL mới theo forward-only convention
---

Tạo migration file mới cho change: `$ARGUMENTS`

## Steps

1. **Understand the change**: đọc `docs/store-submissions/01-data-model.md` để nắm schema hiện tại. Identify tables/columns/indexes cần thay đổi.

2. **Generate migration file**:
   ```bash
   supabase migration new {snake_case_name}
   ```
   Naming convention: descriptive snake_case, vd:
   - `add_notifications_table`
   - `add_index_on_tickets_assigned_to`
   - `alter_email_messages_add_dropped_status`

3. **Write SQL** trong file mới tạo. Tuân thủ:
   - **Forward-only**: không viết down migration
   - **Idempotent khi có thể**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`
   - **ALTER CHECK constraints**: DROP + ADD (không thể modify trực tiếp)
   - **Named indexes**: naming `idx_{table}_{columns}_{condition?}`
   - **Comments**: header nói rõ purpose + source doc

4. **Template for common changes**:

   ### Add column
   ```sql
   ALTER TABLE tickets
     ADD COLUMN IF NOT EXISTS archived_reason TEXT;
   ```

   ### Add index
   ```sql
   CREATE INDEX IF NOT EXISTS idx_tickets_due_date 
     ON tickets(due_date) 
     WHERE due_date IS NOT NULL;
   ```

   ### Modify CHECK constraint
   ```sql
   ALTER TABLE tickets DROP CONSTRAINT tickets_state_check;
   ALTER TABLE tickets ADD CONSTRAINT tickets_state_check 
     CHECK (state IN ('NEW', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE', 'ARCHIVED', 'BLOCKED'));
   ```

   ### Add new enum value
   Same pattern as CHECK constraint — DROP + ADD.

5. **Verify locally**:
   ```bash
   pnpm db:reset  # applies all migrations from scratch
   ```
   Check không có lỗi. Verify schema matches expectation.

6. **Breaking schema changes** cần staged deploy:
   - Step A: Deploy code tương thích cả old + new schema
   - Step B: Apply migration additive (ADD COLUMN, không DROP)
   - Step C: Deploy code dùng new schema only
   - Step D (optional): Cleanup migration (DROP COLUMN) sau khi stable

## Don't

- Don't write down migrations
- Don't use `DROP TABLE` hoặc `DROP COLUMN` trong 1 migration với code change — risky
- Don't forget `IF EXISTS` / `IF NOT EXISTS` với idempotent operations
- Don't mix data migrations với schema migrations — tách riêng files
