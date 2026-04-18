# Store Management — Documentation

Technical design + business analysis + user training cho Store Management module.

## Reading order cho developer mới

Tổng thời gian: 9-13 giờ (~2 ngày part-time)

1. **`onboarding-guide.md`** (30 phút) — Start here. Overview project + workflow + local setup.
2. **`00-business-analysis.md`** (1-2 giờ) — Business context đầy đủ. What & Why.
3. **`00-architecture-overview.md`** (1 giờ) — High-level architecture.
4. **`01-data-model.md`** (1-2 giờ) — Database schema foundation. SQL, indexes, migrations.
5. **`02-gmail-sync.md`** (1-2 giờ) — Gmail API integration, cron pipeline.
6. **`03-email-rule-engine.md`** (1-2 giờ) — Pure function classifier + RE2.
7. **`04-ticket-engine.md`** (1-2 giờ) — Transactional ticket ops + state machine.
8. **`05-api-frontend.md`** (2 giờ) — Server Actions, App Router, TanStack Query.
9. **`06-deployment.md`** (1-2 giờ) — Railway + Sentry + phasing.

## Docs cho PM / Manager

- **`user-training.docx`** — Hướng dẫn sử dụng tool cho team (Word format, 11 sections)
- **`00-business-analysis.md`** — Reference business decisions đã chốt

## Quick reference by task

| Working on... | Read |
|---|---|
| Adding a table/migration | `01-data-model.md` |
| Gmail sync / cron | `02-gmail-sync.md` |
| Email classification | `03-email-rule-engine.md` |
| Ticket state/actions | `04-ticket-engine.md` |
| New UI page | `05-api-frontend.md` Part B |
| New Server Action / API | `05-api-frontend.md` Part A |
| Railway cron setup | `../railway/README.md` |
| Deploy / env setup | `06-deployment.md` Part A |
| Monitoring / alerts | `06-deployment.md` Part B |
| Phasing decisions | `06-deployment.md` Part C |

## Visual reference

- **`../mockups/mockup.html`** — Mở trong browser. 6 UI views hoàn chỉnh.

## Templates

- **`../templates/app-registry-template.csv`** — CSV format cho bulk import apps.

---

## Schema isolation reminder

Store Management database nằm trong Postgres schema **`store_mgmt`**. Tất cả SQL trong docs dùng schema-qualified names. Khi code dùng Supabase client, wrapper `lib/store-submissions/db.ts` tự động apply schema.

## Module isolation reminder

Route prefix **`/store-submissions/*`**. Không overlap với CPP Manager (`/apps/*`).
