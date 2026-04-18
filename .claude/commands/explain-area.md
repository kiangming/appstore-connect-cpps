---
description: Explain 1 domain/area trong codebase dựa vào docs
---

Explain area `$ARGUMENTS` trong project này.

## Valid areas

Cho user biết available areas và ref doc nào:

- `classifier` / `email-rule` / `rules` → `docs/store-submissions/03-email-rule-engine.md`
- `ticket` / `ticket-engine` / `state-machine` → `docs/store-submissions/04-ticket-engine.md`
- `gmail` / `gmail-sync` / `sync` → `docs/store-submissions/02-gmail-sync.md`
- `data-model` / `schema` / `database` → `docs/store-submissions/01-data-model.md`
- `api` / `server-actions` / `api-routes` → `docs/store-submissions/05-api-frontend.md` Part A
- `frontend` / `ui` / `components` → `docs/store-submissions/05-api-frontend.md` Part B
- `deploy` / `railway` / `supabase` → `docs/store-submissions/06-deployment.md`
- `auth` / `authentication` / `rbac` → `docs/store-submissions/05-api-frontend.md` section A.7 + `docs/store-submissions/00-architecture-overview.md` section 3

## Format for explanation

Output:

### What it does
2-3 sentence summary of domain's responsibility.

### Key concepts
Bullet list of 3-5 most important concepts to understand.

### Critical invariants
Any invariants that must be preserved (link to doc section).

### Files involved
List of `lib/` và `app/` files relating to this area.

### Tests
Where tests live, what patterns.

### Gotchas
Common mistakes dev mới mắc phải khi làm việc với area này. Reference `docs/store-submissions/onboarding-guide.md` section 8 "Gotchas".

## Example

User: `/explain-area classifier`

Output:

> ### What it does
> Email Rule Engine là pure function classify raw email thành structured data. Input: email + rules snapshot. Output: 1 trong 5 ClassificationResult outcomes (DROPPED / UNCLASSIFIED_APP / UNCLASSIFIED_TYPE / CLASSIFIED / ERROR). Không DB, không side-effects.
> 
> ### Key concepts
> - **Pure function boundary**: tách biệt "hiểu email" khỏi orchestration
> - **5-step pipeline**: sender → subject → app → type → submission_id
> - **RE2-safe regex**: mọi user-provided regex qua `re2-wasm`, linear time guarantee
> - **matched_rules trace**: output có trace đầy đủ cho debugging
> - **Rule versioning**: snapshot trên mỗi save, rollback 1-click
> 
> ### Critical invariants
> - User-provided regex NEVER qua V8 regex engine (xem CLAUDE.md rule #4)
> - Validate regex RE2-compatible TRƯỚC khi save
> - Pattern must have named group `app_name` cho subject, `submission_id` cho submission_id patterns
> 
> ### Files involved
> - `lib/classifier/index.ts` — main `classify()` entry
> - `lib/classifier/*.ts` — per-step matchers
> - `lib/regex/re2.ts` — RE2 wrapper
> - `lib/rules/save.ts` — save with versioning snapshot
> - `app/api/rules/test/route.ts` — test endpoint
> 
> ### Tests
> - `lib/classifier/index.test.ts` — full pipeline unit tests
> - Fixtures: `test/fixtures/emails/` — .eml samples
> 
> ### Gotchas
> - Python-style regex `(?P<n>...)` works in RE2 nhưng UI hint dùng JS style `(?<n>...)` — stick with JS
> - Body size cap 100KB — nếu email body lớn hơn, slice trước khi pass vào classifier
> - Caching rules TTL 60s — nếu vừa save rule mà không thấy effect ngay → invalidate cache
