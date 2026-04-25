# Tech Design Deep-Dive — API + Frontend Architecture

**Scope:** API route design, data fetching patterns, Next.js App Router structure, component architecture
**Prerequisite:** Data Model (01), Gmail Sync (02), Email Rule Engine (03), Ticket Engine (04)

Chia 2 Part:
- **Part A — API Design**: route structure, Server Actions vs API Routes, zod validation, error handling
- **Part B — Frontend Architecture**: App Router, Server/Client Components, TanStack Query, form patterns

---

# PART A — API Design

## A.1. Design philosophy

**3 nguyên tắc**:

1. **Server Actions là default** cho mutations user-initiated (form submit, button click). Next.js native, type-safe, auto CSRF, ít boilerplate.
2. **API Routes cho external callers**: Railway cron, potential webhooks (phase 2), public API (future). Cần HTTP endpoint rõ ràng.
3. **Shared zod schemas** giữa client + server. Source of truth cho validation, inferred types TypeScript.

**Không dùng**:
- ❌ tRPC (overhead setup, Server Actions đã đủ type-safe)
- ❌ GraphQL (overkill cho scope)
- ❌ Direct Supabase client từ browser (bypass business logic, conflict với Service Role pattern)

## A.2. Server Actions vs API Routes — decision tree

```
┌─────────────────────────────────────────────────┐
│ Ai là caller?                                    │
└─────────────────────────────────────────────────┘
    │
    ├─ User trong UI (form/button)
    │   └─ Server Action ✓
    │
    ├─ External service (cron, webhook)
    │   └─ API Route ✓
    │
    ├─ File download (CSV export, PDF)
    │   └─ API Route ✓ (cần Response headers control)
    │
    └─ Third-party OAuth callback
        └─ API Route ✓ (cần URL fixed)
```

**Cả hai đều chạy server-side**, chỉ khác packaging. Logic chung extract vào `lib/` modules, gọi từ cả 2.

## A.3. Route structure (full tree)

### A.3.1. API Routes

```
app/api/
├── auth/
│   └── [...nextauth]/route.ts            NextAuth handlers
├── gmail/
│   ├── connect/route.ts                  Manager bắt đầu OAuth Gmail
│   └── callback/route.ts                 OAuth callback
├── sync/
│   └── gmail/route.ts                    POST: Cron endpoint
├── cleanup/
│   └── emails/route.ts                   POST: Cron endpoint
├── health/
│   ├── gmail/route.ts                    GET: Cron endpoint health check
│   └── sync/route.ts                     GET: Public health check
├── webhooks/                             (phase 2)
│   └── gmail/route.ts                    POST: Gmail Pub/Sub push
├── apps/
│   ├── export/route.ts                   GET: Download CSV
│   └── import/route.ts                   POST: Upload CSV
└── reports/
    └── export/route.ts                   GET: Download Excel/PDF
```

Note: CRUD endpoints cho apps/tickets/rules là **Server Actions**, không có route này.

### A.3.2. Server Actions

Organized theo domain, trong `app/(app)/**/actions.ts`:

```
app/(app)/
├── inbox/actions.ts                      archiveTicketAction, followUpAction, bulkActions
├── follow-up/actions.ts                  (reuse từ inbox)
├── submissions/actions.ts                retryFailedClassifyAction
├── config/
│   ├── apps/actions.ts                   createAppAction, updateAppAction, renameAppAction, ...
│   ├── email-rules/actions.ts            saveSendersAction, savePatternsAction, testRuleAction, ...
│   ├── team/actions.ts                   addUserAction, updateUserRoleAction, disableUserAction
│   └── settings/actions.ts               updateSettingsAction, triggerCleanupAction
└── tickets/[id]/actions.ts               addCommentAction, editCommentAction, addRejectReasonAction, ...
```

**Co-location**: action file cạnh page dùng nó. Shared actions ở `lib/actions/`.

## A.4. Shared zod schemas

Single source of truth ở `lib/schemas/`:

```typescript
// lib/schemas/ticket.ts
import { z } from 'zod';

export const ticketStateSchema = z.enum([
  'NEW', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE', 'ARCHIVED'
]);
export type TicketState = z.infer<typeof ticketStateSchema>;

export const prioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);

export const archiveActionSchema = z.object({
  ticket_id: z.string().uuid(),
});

export const addCommentSchema = z.object({
  ticket_id: z.string().uuid(),
  content: z.string().min(1).max(10_000),
  attachments: z.array(z.object({
    path: z.string(),
    size: z.number().int().positive(),
    mime: z.string(),
  })).optional().default([]),
});

export const bulkArchiveSchema = z.object({
  ticket_ids: z.array(z.string().uuid()).min(1).max(100),
});
```

```typescript
// lib/schemas/app-registry.ts
export const createAppSchema = z.object({
  name: z.string().min(1).max(200),
  display_name: z.string().max(200).optional(),
  team_owner_id: z.string().uuid().nullable(),
  platform_bindings: z.array(z.object({
    platform_id: z.string().uuid(),
    platform_ref: z.string().optional(),
    console_url: z.string().url().optional(),
  })).default([]),
});

export const renameAppSchema = z.object({
  app_id: z.string().uuid(),
  new_name: z.string().min(1).max(200),
});

export const csvRowSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().optional().transform(s => s || undefined),
  aliases: z.string().optional().transform(s => s ? s.split('|').map(a => a.trim()) : []),
  apple_bundle_id: z.string().optional(),
  google_package_name: z.string().optional(),
  huawei_app_id: z.string().optional(),
  facebook_app_id: z.string().optional(),
  team_owner_email: z.string().email().optional(),
  active: z.enum(['true', 'false']).transform(s => s === 'true').default('true'),
});
```

```typescript
// lib/schemas/email-rule.ts
export const outcomeSchema = z.enum(['APPROVED', 'REJECTED', 'IN_REVIEW']);

export const subjectPatternSchema = z.object({
  outcome: outcomeSchema,
  regex: z.string().min(1).refine(v => re2Validate(v).ok, {
    message: 'Invalid regex (must be RE2-compatible)',
  }).refine(v => /\(\?<app_name>/.test(v), {
    message: 'Must contain named group (?<app_name>...)',
  }),
  priority: z.number().int().min(1).max(1000),
  example_subject: z.string().optional(),
  active: z.boolean().default(true),
});

export const typeRuleSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(50),
  body_keyword: z.string().min(1).max(500),
  payload_extract_regex: z.string().optional().refine(
    v => !v || re2Validate(v).ok,
    { message: 'Invalid regex (must be RE2-compatible)' }
  ),
  active: z.boolean().default(true),
});

export const testRuleInputSchema = z.object({
  sender: z.string().email(),
  subject: z.string(),
  body: z.string().optional().default(''),
  override_rules: z.any().optional(), // draft rules, bypass cache
});
```

**Usage pattern**:
```typescript
// Server Action
export async function archiveTicketAction(input: unknown) {
  const data = archiveActionSchema.parse(input); // throws ZodError
  // ... execute
}

// Client form
const form = useForm({ resolver: zodResolver(addCommentSchema) });
```

## A.5. Server Action pattern

```typescript
// app/(app)/inbox/actions.ts
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth';
import { executeUserAction } from '@/lib/ticket-engine';
import { archiveActionSchema } from '@/lib/schemas/ticket';

export async function archiveTicketAction(input: z.infer<typeof archiveActionSchema>) {
  try {
    const session = await requireRole(['MANAGER', 'DEV']);
    const data = archiveActionSchema.parse(input);
    
    const result = await executeUserAction(
      data.ticket_id,
      { type: 'ARCHIVE' },
      session.user
    );
    
    // Invalidate cache
    revalidatePath('/inbox');
    revalidatePath(`/tickets/${data.ticket_id}`);
    
    return { ok: true as const, data: result };
  } catch (err) {
    return { ok: false as const, error: toActionError(err) };
  }
}

function toActionError(err: unknown): ActionError {
  if (err instanceof z.ZodError) {
    return { code: 'VALIDATION', message: 'Invalid input', details: err.flatten() };
  }
  if (err instanceof ForbiddenError) {
    return { code: 'FORBIDDEN', message: err.message };
  }
  if (err instanceof InvalidTransitionError) {
    return { code: 'INVALID_STATE', message: err.message };
  }
  Sentry.captureException(err);
  return { code: 'INTERNAL', message: 'Unexpected error' };
}
```

**Response format** luôn là discriminated union `{ok: true, data} | {ok: false, error}`. Client check `ok` trước khi dùng data.

**Client usage**:
```tsx
'use client';
const [, startTransition] = useTransition();

function handleArchive(ticketId: string) {
  startTransition(async () => {
    const result = await archiveTicketAction({ ticket_id: ticketId });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success('Archived');
  });
}
```

## A.6. API Route pattern

Cho cron + external:

```typescript
// app/api/sync/gmail/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { runSync } from '@/lib/gmail/sync';

export async function POST(req: NextRequest) {
  // Auth
  const secret = req.headers.get('X-Cron-Secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid secret' } },
      { status: 401 }
    );
  }

  // Parse body (optional)
  let options: SyncOptions = {};
  try {
    const body = await req.json().catch(() => ({}));
    options = syncOptionsSchema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: 'VALIDATION', details: err.flatten() } },
        { status: 400 }
      );
    }
  }

  try {
    const result = await runSync(options);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ConflictError) {
      return NextResponse.json(
        { error: { code: 'SYNC_IN_PROGRESS', message: err.message } },
        { status: 409 }
      );
    }
    Sentry.captureException(err, { tags: { component: 'gmail-sync' } });
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Sync failed' } },
      { status: 500 }
    );
  }
}
```

## A.7. Error contract

Unified error shape across Server Actions + API Routes:

```typescript
// lib/errors/contract.ts
export type ApiError = {
  code: ErrorCode;
  message: string;
  details?: Record<string, any>;
};

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'SYNC_IN_PROGRESS'
  | 'GMAIL_DISCONNECTED'
  | 'RATE_LIMITED'
  | 'INTERNAL';
```

HTTP status mapping:
| Code | HTTP Status |
|---|---|
| VALIDATION | 400 |
| UNAUTHORIZED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| CONFLICT, INVALID_STATE, SYNC_IN_PROGRESS | 409 |
| GMAIL_DISCONNECTED | 422 |
| RATE_LIMITED | 429 |
| INTERNAL | 500 |

## A.8. Pagination + filtering standards

**Cursor-based pagination** cho list Tickets/Email Messages (efficient, stable under insert):

```typescript
// GET /api/tickets?cursor=xxx&limit=50&state=NEW&app_id=yyy
const ticketsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  state: z.union([ticketStateSchema, z.array(ticketStateSchema)]).optional(),
  app_id: z.string().uuid().optional(),
  type_id: z.string().uuid().optional(),
  platform_id: z.string().uuid().optional(),
  priority: prioritySchema.optional(),
  assigned_to: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['opened_at_desc', 'updated_at_desc', 'priority_desc']).default('opened_at_desc'),
});

export type TicketsQuery = z.infer<typeof ticketsQuerySchema>;

export type TicketsResult = {
  items: Ticket[];
  next_cursor: string | null;
  has_more: boolean;
};
```

**Offset pagination** cho App Registry, Users, Reports (không có write contention, stable list):

```typescript
// Offset OK cho small lists (<1000 items)
const appsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  active_only: z.coerce.boolean().default(true),
});
```

**Filter convention**:
- Query params cho simple filters (single value hoặc comma-separated)
- POST body với JSON cho complex filters (nested, multi-value)
- Search là fuzzy `ILIKE '%query%'` trên display_id + app name + subject (MVP)

## A.9. Key endpoint contracts

### A.9.1. GET /api/tickets

Query: `TicketsQuery` (Section A.8)

Response:
```typescript
{
  items: [
    {
      id: UUID,
      display_id: 'TICKET-10248',
      app: { id, name, slug, icon_initial },           // denormalized for list render
      type: { id, slug, name } | null,
      platform: { id, key, display_name, icon_name },
      state: 'REJECTED',
      latest_outcome: 'REJECTED',
      priority: 'HIGH',
      assignee: { id, display_name, avatar_url } | null,
      latest_payload: { version: '2.4.1', os: 'iOS' } | null,  // last in type_payloads[]
      payload_count: 3,
      submission_id_count: 2,
      opened_at: '2026-04-01T...',
      updated_at: '2026-04-18T...',
      entry_counts: { comment: 4, state_change: 5, ... },
    },
    ...
  ],
  next_cursor: 'base64-encoded-cursor' | null,
  has_more: true,
  total_count_estimate: 127,  // may be approximate for perf
}
```

Denormalized `app` / `type` / `platform` objects giảm client round-trips.

### A.9.2. GET /api/tickets/:id

Full detail including thread:

```typescript
{
  ticket: { ... full ticket row ... },
  app: { ... },
  type: { ... } | null,
  platform: { ... },
  assignee: { ... } | null,
  entries: [
    {
      id: UUID,
      entry_type: 'EMAIL',
      author: { id, display_name, avatar_url } | null,
      content: string | null,
      metadata: { email_snapshot: {...}, outcome: 'REJECTED' },
      email: { id, subject, raw_body_text } | null,  // null sau cleanup retention
      attachments: [...],
      created_at: '...',
      edited_at: '...' | null,
    },
    ...
  ],
  related_emails: EmailMessage[],  // emails đang PENDING nhưng chưa có entry? edge
}
```

Single query với joins → hiệu quả hơn 3-4 round-trips từ client.

### A.9.3. POST /api/rules/test

Body: `testRuleInputSchema` (Section A.4)

Response: full classification trace (xem Section 03.6 của email-rule-engine doc)

### A.9.4. GET /api/apps/export

Response: CSV file với `Content-Disposition: attachment; filename="app-registry-YYYY-MM-DD.csv"`

```typescript
export async function GET(req: NextRequest) {
  const session = await requireRole(['MANAGER', 'VIEWER']);
  const apps = await db.apps.findMany({
    where: { /* filters from query */ },
    include: { aliases: true, platform_bindings: { include: { platform: true } } },
  });
  
  const csv = generateCsv(apps);
  const filename = `app-registry-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
```

### A.9.5. POST /api/apps/import

Multipart form upload CSV file:

```typescript
export async function POST(req: NextRequest) {
  const session = await requireRole('MANAGER');
  
  const formData = await req.formData();
  const file = formData.get('file') as File;
  if (!file || file.size > 2 * 1024 * 1024) {
    return NextResponse.json(
      { error: { code: 'VALIDATION', message: 'File required, max 2MB' }},
      { status: 400 }
    );
  }
  
  const text = await file.text();
  const parsed = parseCsv(text); // returns { rows, errors }
  
  if (parsed.errors.length > 0 && formData.get('confirm') !== 'true') {
    // Preview mode: return summary + errors
    return NextResponse.json({
      preview: {
        total_rows: parsed.rows.length,
        valid_rows: parsed.valid.length,
        error_rows: parsed.errors,
        existing_apps: await findExisting(parsed.valid),
      },
    });
  }
  
  // Confirm mode: import
  const result = await importApps(parsed.valid, session.user);
  revalidatePath('/config/apps');
  
  return NextResponse.json({ success: true, ...result });
}
```

2-step flow: preview → confirm. UI hiện diff để user review trước khi commit.

---

# PART B — Frontend Architecture

## B.1. App Router structure

```
app/
├── (auth)/
│   ├── layout.tsx                        minimal layout (logo + centered)
│   └── login/page.tsx                    Google SSO button
├── (app)/
│   ├── layout.tsx                        sidebar + top bar (authenticated)
│   ├── page.tsx                          redirect → /inbox
│   ├── inbox/
│   │   ├── page.tsx                      Server Component: ticket list
│   │   ├── client.tsx                    Client Component: filters + selection + keyboard
│   │   └── actions.ts                    Server Actions
│   ├── follow-up/
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── submissions/
│   │   ├── page.tsx
│   │   └── client.tsx
│   ├── reports/
│   │   ├── page.tsx                      Server Component: KPI cards, chart data fetched
│   │   ├── charts.tsx                    Client Components (recharts)
│   │   └── client.tsx                    Date range picker
│   ├── tickets/[id]/
│   │   ├── page.tsx                      Server Component: full detail
│   │   ├── drawer.tsx                    Client Component: thread, reply
│   │   └── actions.ts
│   └── config/
│       ├── apps/
│       │   ├── page.tsx
│       │   ├── client.tsx                List + filters
│       │   ├── [id]/page.tsx             Detail (expanded in row UI, or full page fallback)
│       │   └── actions.ts
│       ├── email-rules/
│       │   ├── page.tsx
│       │   ├── client.tsx                Platform tabs
│       │   └── actions.ts
│       ├── team/
│       │   ├── page.tsx
│       │   └── actions.ts
│       └── settings/
│           ├── page.tsx
│           └── actions.ts
├── api/                                  (Part A)
├── error.tsx                             Global error boundary
├── not-found.tsx                         404
└── layout.tsx                            Root layout (fonts, ThemeProvider)
```

**Route groups** `(auth)` và `(app)` tách layout mà không ảnh hưởng URL. `/login` và `/inbox` có layout khác nhau nhưng URL sạch.

## B.2. Rendering strategy per page

| Page | Initial render | Interactive part |
|---|---|---|
| `/inbox` | **Server Component** — fetch first page tickets, render list shell | Client Component — filters, checkboxes, keyboard shortcuts, drawer |
| `/follow-up` | Server — similar to inbox | Client — priority filters, assignee filter |
| `/submissions` | Server — app cards with latest tickets per platform/type | Client — view toggle (grid/table), filters |
| `/reports` | Server — KPI cards + chart data from DB | Client — date range picker, Recharts components |
| `/tickets/[id]` | Server — full ticket + entries joined | Client — drawer, reply composer, edit comment |
| `/config/apps` | Server — app list | Client — filters, expand detail, modal forms |
| `/config/email-rules` | Server — rules cho default platform (Apple) | Client — platform tabs, rule forms, test mode |

**Rationale**: initial paint là data-heavy, Server Component fetch DB trực tiếp (không cần API round-trip) → TTFB nhanh. Interactive UI phải client (state, event handlers).

## B.3. Data fetching patterns

### B.3.1. Server Components — initial load

```typescript
// app/(app)/inbox/page.tsx
import { getServerSession } from '@/lib/auth';
import { InboxClient } from './client';
import { fetchTickets } from '@/lib/queries/tickets';

export default async function InboxPage({ searchParams }: Props) {
  const session = await getServerSession();
  if (!session) redirect('/login');
  
  const filters = parseFilters(searchParams);
  const initialTickets = await fetchTickets({
    state: ['NEW'],
    ...filters,
    limit: 50,
  });
  
  return (
    <InboxClient
      initialTickets={initialTickets}
      currentUser={session.user}
    />
  );
}

// lib/queries/tickets.ts (server-only data fetching, reused)
export async function fetchTickets(query: TicketsQuery): Promise<TicketsResult> {
  // Direct DB query using service role
  return await db.tickets.findMany({ /* ... */ });
}
```

### B.3.2. Client Components — subsequent queries with TanStack Query

```typescript
// app/(app)/inbox/client.tsx
'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { archiveTicketAction } from './actions';

export function InboxClient({ initialTickets, currentUser }: Props) {
  const [filters, setFilters] = useState(defaultFilters);
  const queryClient = useQueryClient();
  
  // Subsequent queries when filters change
  const { data: tickets = initialTickets, isLoading } = useQuery({
    queryKey: ['tickets', 'inbox', filters],
    queryFn: () => fetch(`/api/tickets?state=NEW&${serialize(filters)}`).then(r => r.json()),
    initialData: initialTickets,
    staleTime: 30_000, // 30s before background refetch
  });
  
  // Mutation: archive ticket
  const archive = useMutation({
    mutationFn: archiveTicketAction,
    onMutate: async ({ ticket_id }) => {
      // Optimistic: remove from list
      await queryClient.cancelQueries({ queryKey: ['tickets', 'inbox'] });
      const previous = queryClient.getQueryData(['tickets', 'inbox', filters]);
      queryClient.setQueryData(['tickets', 'inbox', filters], (old: any) => ({
        ...old,
        items: old.items.filter((t: Ticket) => t.id !== ticket_id),
      }));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Rollback
      queryClient.setQueryData(['tickets', 'inbox', filters], ctx?.previous);
      toast.error('Archive failed');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  
  return (/* ... UI ... */);
}
```

**Pattern**: Server fetch initial data → pass to Client → TanStack Query takes over cho interactive state.

### B.3.3. Query key convention

```typescript
// lib/query-keys.ts
export const queryKeys = {
  tickets: {
    all: ['tickets'] as const,
    list: (filters: TicketsQuery) => ['tickets', 'list', filters] as const,
    detail: (id: UUID) => ['tickets', 'detail', id] as const,
    entries: (id: UUID) => ['tickets', 'entries', id] as const,
    counts: () => ['tickets', 'counts'] as const,
  },
  apps: {
    all: ['apps'] as const,
    list: (filters?: AppsQuery) => ['apps', 'list', filters] as const,
    detail: (id: UUID) => ['apps', 'detail', id] as const,
  },
  rules: {
    byPlatform: (platformId: UUID) => ['rules', 'platform', platformId] as const,
    versions: (platformId: UUID) => ['rules', 'versions', platformId] as const,
  },
  reports: {
    summary: (range: DateRange) => ['reports', 'summary', range] as const,
  },
};

// Usage
useQuery({ queryKey: queryKeys.tickets.list(filters), queryFn: ... })

// Invalidate
queryClient.invalidateQueries({ queryKey: queryKeys.tickets.all });  // invalidates all tickets queries
```

Hierarchical keys cho fine-grained invalidation.

## B.4. Form handling pattern

`react-hook-form` + `zodResolver`:

```typescript
// app/(app)/config/apps/create-app-form.tsx
'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createAppSchema } from '@/lib/schemas/app-registry';
import { createAppAction } from './actions';

type FormValues = z.infer<typeof createAppSchema>;

export function CreateAppForm({ platforms, onCreated }: Props) {
  const form = useForm<FormValues>({
    resolver: zodResolver(createAppSchema),
    defaultValues: {
      name: '',
      display_name: '',
      team_owner_id: null,
      platform_bindings: [],
    },
  });

  const submit = async (values: FormValues) => {
    const result = await createAppAction(values);
    if (!result.ok) {
      // Map server errors to form fields
      if (result.error.code === 'VALIDATION' && result.error.details) {
        Object.entries(result.error.details.fieldErrors ?? {}).forEach(([field, msgs]) => {
          form.setError(field as any, { message: (msgs as string[])[0] });
        });
        return;
      }
      toast.error(result.error.message);
      return;
    }
    toast.success('App created');
    onCreated(result.data);
    form.reset();
  };

  return (
    <form onSubmit={form.handleSubmit(submit)}>
      <Input {...form.register('name')} />
      {form.formState.errors.name && <span>{form.formState.errors.name.message}</span>}
      {/* ... */}
    </form>
  );
}
```

**Validation dual-layer**: client validate (instant feedback) + server re-validate (trust boundary). Same schema.

## B.5. Keyboard shortcuts

Library: `react-hotkeys-hook` v5.2.4 (note: this repo ships v5; v4 docs differ in option-shape minor details, not in the basic `useHotkeys(keys, callback, options, deps)` signature).

### Shipped (PR-10d.2)

| Key | Action | Notes |
|---|---|---|
| `j` | Focus next row | `Math.min(prev + 1, count - 1)` — stays at end (no wrap) |
| `k` | Focus previous row | `Math.max(prev - 1, 0)` — stays at start (no wrap) |
| `Enter` | Open detail panel for focused row | No-op when no row is focused |
| `Esc` | Close detail panel | Wired by Radix Dialog — no explicit `useHotkeys('esc')` needed |

Source: `components/store-submissions/inbox/InboxClient.tsx` (vim-style `j`/`k` chosen over `up`/`down` so browser arrow scrolling still works inside the panel).

### Gating

- **`enabled: !isPanelOpen`** — j/k navigation paused while the detail panel is open, so keys typed inside the dialog don't move list focus underneath
- **`enableOnFormTags: false`** (v5 default) — typing into the search input or comment composer doesn't trigger navigation
- **Empty list** — early return; no focus state created

### Reset semantics

`focusedIndex` is reset to `null` when the underlying ticket list changes (filter / sort / pagination). The reset is keyed on `ticketsKey = tickets.map(t => t.id).join(',')` rather than on `initialData` identity, so panel toggling (which re-renders InboxClient with new `searchParams` but the same list) does NOT clobber the user's focused position.

### Deferred shortcuts

`e` (archive) / `f` (follow-up) bindings from the original spec snippet are not shipped — the on-row Enter→panel→action footer flow was sufficient for MVP triage volume (~200/month). Revisit when keyboard-only users complain or volume forces faster bulk handling.

### Discoverability

Subtle hint strip immediately above the table (`hidden md:flex`, slate-400) shows `j k to navigate · Enter to open`. No global `?` cheatsheet modal — single-page surface, low shortcut count.

## B.6. Drawer state — ticket detail

Drawer open qua URL query param → shareable link + browser back button works.

```typescript
// app/(app)/inbox/client.tsx
import { useSearchParams, useRouter } from 'next/navigation';

export function InboxClient(...) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const openTicketId = searchParams.get('ticket');
  
  function openDrawer(ticketId: string) {
    const params = new URLSearchParams(searchParams);
    params.set('ticket', ticketId);
    router.push(`?${params}`, { scroll: false });
  }
  
  function closeDrawer() {
    const params = new URLSearchParams(searchParams);
    params.delete('ticket');
    router.push(`?${params}`, { scroll: false });
  }
  
  return (
    <>
      <TicketList onOpen={openDrawer} />
      {openTicketId && (
        <TicketDrawer 
          ticketId={openTicketId} 
          onClose={closeDrawer}
        />
      )}
    </>
  );
}

function TicketDrawer({ ticketId, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.tickets.detail(ticketId),
    queryFn: () => fetch(`/api/tickets/${ticketId}`).then(r => r.json()),
  });
  // ... render drawer
}
```

**URL**: `/inbox?state=NEW&ticket=uuid` — state preserved khi copy link.

## B.7. Toast + global UI state

**Library**: `sonner` (shadcn recommend, minimal API):

```typescript
// app/(app)/layout.tsx
import { Toaster } from 'sonner';

export default function Layout({ children }: Props) {
  return (
    <>
      <Sidebar />
      <TopBar />
      <main>{children}</main>
      <Toaster position="bottom-right" richColors />
    </>
  );
}

// Usage
import { toast } from 'sonner';

toast.success('Ticket archived');
toast.error('Failed to save');
toast.promise(saveAction(), {
  loading: 'Saving...',
  success: 'Saved',
  error: 'Failed',
});
```

**Archive undo toast** (10s):
```typescript
toast('Ticket archived', {
  action: {
    label: 'Undo',
    onClick: () => unarchiveAction({ ticket_id: id }),
  },
  duration: 10_000,
});
```

## B.8. Loading + error states

**Loading skeletons** với `react-loading-skeleton` hoặc custom Tailwind:

```tsx
function InboxSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="h-14 bg-stone-100 rounded-xl animate-pulse" />
      ))}
    </div>
  );
}

// In page
{isLoading ? <InboxSkeleton /> : <TicketList tickets={tickets} />}
```

**Error boundaries**:
- `app/error.tsx` — global error boundary
- `app/(app)/*/error.tsx` — route-specific if cần custom UX

**Empty states**: friendly message + CTA (vd "No tickets. Take a break!" với illustration).

## B.9. Realtime subscriptions (optional phase 2)

Supabase Realtime → Inbox auto-refresh khi có ticket mới:

```typescript
'use client';
import { createClient } from '@supabase/supabase-js';
import { useEffect } from 'react';

export function InboxClient(...) {
  const queryClient = useQueryClient();
  
  useEffect(() => {
    if (!settings.inbox_badge_realtime_enabled) return;
    
    const supabase = createClient(url, anonKey);
    const channel = supabase
      .channel('inbox-tickets')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'tickets',
        filter: 'state=eq.NEW',
      }, (payload) => {
        // New ticket arrived — invalidate to refetch
        queryClient.invalidateQueries({ queryKey: queryKeys.tickets.list });
        toast.info(`New ticket: ${payload.new.display_id}`);
      })
      .subscribe();
    
    return () => {
      channel.unsubscribe();
    };
  }, [queryClient]);
  
  // ... rest
}
```

**Opt-in setting** — default OFF cho MVP để tránh unexpected behavior. Enable trong Settings.

## B.10. Optimistic updates — patterns

**3 operations cần optimistic update cho UX tốt**:

1. **Archive/Follow Up**: remove row khỏi list ngay lập tức
2. **Priority/Assign change**: update row badge ngay
3. **Comment post**: append comment lên thread ngay, hiện placeholder "Sending..."

Pattern implementation: xem Section B.3.2.

**Rollback on error**: always restore previous state. Show error toast.

## B.11. Accessibility + i18n

**Accessibility baseline**:
- Semantic HTML (`<button>` không phải `<div onClick>`)
- ARIA labels cho icon-only buttons (vd drawer close)
- Keyboard navigation (Tab flow, focus visible)
- Color contrast 4.5:1 (design system đã ensure)

**i18n**: **defer**. MVP Vietnamese + English mixed UI (business context đã vậy). Nếu sau cần strict i18n → `next-intl` library, không block MVP.

---

## C. Open questions

1. **Error boundary UX**: crash page global có form "Report bug" không? Hay chỉ "Reload"? **Recommend**: simple "Something went wrong, reload" + Sentry capture automatic.

2. **Drawer animation**: slide from right (mockup hiện tại) hay modal center? **Recommend**: slide from right (consistent với mockup, không block background context).

3. **Pagination UI**: infinite scroll (TanStack `useInfiniteQuery`) hay cursor button "Load more"? **Recommend**: infinite scroll cho Inbox/Follow-Up (feels fluid), button cho Reports/Submissions (discrete chunks).

4. **Mobile responsive**: MVP support mobile viewport? **Recommend**: desktop-first, mobile fallback OK (không optimize). Real mobile optimization phase 2 nếu cần.

5. **Keyboard shortcut conflict với browser**: vd `E` conflict với `Cmd+E` find. **Recommend**: dùng plain letter keys (E, F) khi không có modifier → chỉ trigger khi focus không trong input. Các shortcut critical dùng modifier (Cmd+K for search).

---

## Kết luận

**API layer stack**:
- Server Actions as default for mutations → type-safe, CSRF-free, co-located
- API Routes cho external callers (cron, CSV export, OAuth)
- Shared zod schemas = single source of truth
- Unified error contract discriminated union

**Frontend stack**:
- Server Components cho initial data fetch (zero client round-trip)
- Client Components cho interactive (TanStack Query, react-hook-form)
- URL-driven state (drawer, filters) → shareable + back button works
- Optimistic updates cho 3 hot-path operations

**Next up** (final sections): Deployment + Observability + Phasing plan — cấu hình Railway, Sentry setup, env vars list, CI/CD workflow, và roadmap MVP → v1.1 → v2.
