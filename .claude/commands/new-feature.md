---
description: Scaffold 1 feature mới theo patterns đã chốt trong docs
---

Scaffold feature `$ARGUMENTS` theo đúng pattern của project.

Trước khi scaffold, làm theo thứ tự:

## Bước 1 — Understand

1. Đọc `docs/store-submissions/00-business-analysis.md` nếu chưa — hiểu business context
2. Xác định feature này thuộc domain nào:
   - Classifier / rule engine → đọc `docs/store-submissions/03-email-rule-engine.md`
   - Ticket state/actions → đọc `docs/store-submissions/04-ticket-engine.md`
   - UI pages/components → đọc `docs/store-submissions/05-api-frontend.md`
   - Data model change → đọc `docs/store-submissions/01-data-model.md`
3. Ask clarifying question nếu scope ambiguous. KHÔNG guess.

## Bước 2 — Plan

Output 1 plan gồm:
- Files sẽ tạo/sửa (list đầy đủ với đường dẫn)
- Zod schemas cần define
- Business logic functions
- UI components (nếu có)
- Tests cần viết
- Migration (nếu schema change)

Wait for user approval trước khi implement.

## Bước 3 — Implement theo checklist

Checklist cho mọi user-facing feature:

- [ ] Zod schema trong `lib/schemas/{domain}.ts`
- [ ] Business logic trong `lib/{domain}/` (pure if possible)
- [ ] Unit tests cho business logic
- [ ] Server Action trong `app/(app)/{route}/actions.ts` HOẶC API Route trong `app/api/{route}/route.ts`
- [ ] Integration test cho Server Action/API
- [ ] UI component theo design tokens trong `mockups/mockup.html`
- [ ] Loading state + error state + toast
- [ ] Optimistic update nếu affect list view
- [ ] Update relevant `docs/` nếu có architectural change
- [ ] Run `npm run lint && npm run typecheck && npm test` — verify pass

## Critical rules

- Server Actions return `{ok: true, data} | {ok: false, error}` — không throw
- User-provided regex → `re2-wasm`, không bao giờ V8 regex
- Transaction `FOR UPDATE` khi find-or-create ticket
- Luôn lưu `email_snapshot` trong ticket_entries metadata
- Forward-only migrations

## Domain-specific reminders

**Nếu ticket engine**: ticket grouping key = `(app_id, type_id, platform_id)`, state machine trong `lib/ticket-engine/state-machine.ts` với pure functions. Xem section 4 của doc 04.

**Nếu classifier**: pure function `classify(email, rules) → ClassificationResult`, 5 outcomes. RE2 cho mọi user-provided regex. Xem section 3 của doc 03.

**Nếu Gmail sync**: cron endpoint synchronous, advisory lock cho concurrency, history.list + fallback. Xem section 3-5 của doc 02.

**Nếu UI**: Server Component cho initial render, Client Component cho interactive, URL-driven drawer state, TanStack Query cho subsequent fetch. Xem Part B của doc 05.
