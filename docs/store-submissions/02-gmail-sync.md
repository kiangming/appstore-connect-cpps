# Tech Design Deep-Dive — Gmail Sync Pipeline

**Scope:** Implementation-ready design cho Component [A] Email Ingestion Engine
**Prerequisite:** Data Model (section 01) — tables `gmail_credentials`, `gmail_sync_state`, `email_messages`, `sync_logs`

---

## 1. Overview

Gmail Sync Pipeline có 1 trách nhiệm duy nhất: **fetch email mới từ Gmail, lưu vào DB với status PENDING, call classifier+ticket engine, add Gmail label**. Không quyết định business logic (classification, grouping — thuộc Section 3 & 4).

**Execution model**:
```
Railway Cron (*/5 * * * *)
         │
         ▼
POST /api/sync/gmail  ← stateless HTTP endpoint
         │
         ▼
┌──────────────────────────────────────┐
│  Sync orchestrator (60s budget)       │
│  1. Load state + credentials          │
│  2. Gmail API: history.list (or fallback) │
│  3. Per email (batch ≤50):            │
│     a. messages.get                    │
│     b. INSERT email_messages          │
│     c. call Email Rule Engine         │
│     d. call Ticket Engine             │
│     e. Gmail labels.modify            │
│  4. Update sync state                  │
│  5. Write sync_log                     │
└──────────────────────────────────────┘
```

**Không có queue / worker process riêng** trong MVP. Classification + ticket gom là synchronous trong cron request. Trade-off:

- ✅ Simpler — không cần queue infrastructure, không cần worker service
- ✅ Atomic — 1 transaction cover entire flow, không có intermediate "classified but not ticketed" state
- ⚠ Throughput limit — ~50 email/5min = 600 email/hour = 14k/day. Dư thừa với forecast 2k email/tháng
- ⚠ Khi hit limit: split batch + backlog catchup cron sau, hoặc upgrade sang queue-based (section "Scale out" phía dưới)

---

## 2. Cron endpoint contract

### Request

```
POST /api/sync/gmail
Headers:
  X-Cron-Secret: <CRON_SECRET env var>     ← auth cho Railway cron
  Content-Type: application/json
Body:
  {} | { "forceMode": "incremental" | "fallback" | "auto", "maxBatch": number }
```

Body optional cho Manual trigger trong Settings UI. `forceMode` default `auto`. `maxBatch` default 50, tối đa 100.

### Response

```
200 OK
{
  "success": true,
  "mode": "INCREMENTAL" | "FALLBACK",
  "duration_ms": 8453,
  "stats": {
    "fetched": 12,
    "classified": 10,
    "unclassified_app": 1,
    "unclassified_type": 1,
    "errored": 0,
    "tickets_created": 3,
    "tickets_updated": 9
  },
  "next_history_id": "31234567"
}

409 Conflict
{ "error": "SYNC_IN_PROGRESS", "message": "Another sync is running" }

401 Unauthorized
{ "error": "INVALID_CRON_SECRET" }

500 Internal
{ "error": "GMAIL_API_ERROR", "details": { ... } }
```

### Auth

Middleware check trước khi handler chạy:

```ts
// app/api/sync/gmail/route.ts
export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Cron-Secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'INVALID_CRON_SECRET' }, { status: 401 });
  }
  // ... orchestration
}
```

### Concurrency control

Tránh 2 cron run chồng lấp (vd run trước chạy quá 5 phút):

**Advisory lock** với Postgres:

```sql
SELECT pg_try_advisory_lock(12345);  -- returns true nếu acquire được, false nếu đã locked
-- ... work ...
SELECT pg_advisory_unlock(12345);
```

Acquire fail → trả 409 Conflict, không chạy trùng. Lock scope = current connection, auto-release khi connection close (safety net nếu handler crash).

---

## 3. Main sync algorithm

```ts
// lib/gmail/sync.ts (pseudo-code)

async function runSync(options: SyncOptions): SyncResult {
  const startMs = Date.now();
  const locked = await acquireAdvisoryLock(SYNC_LOCK_KEY);
  if (!locked) throw new ConflictError('SYNC_IN_PROGRESS');

  try {
    // 1. Load state
    const creds = await loadGmailCredentials();
    if (!creds) throw new NotConnectedError();
    
    const gmail = await createGmailClient(creds); // handles token refresh
    const state = await loadSyncState();
    const labels = await ensureLabelsExist(gmail); // bootstrap + cache

    // 2. Decide sync mode
    let mode: 'INCREMENTAL' | 'FALLBACK' = 'INCREMENTAL';
    let messageIds: string[] = [];
    let newHistoryId: string | null = null;

    if (state.last_history_id && options.forceMode !== 'fallback') {
      try {
        const result = await gmail.history.list({
          startHistoryId: state.last_history_id,
          historyTypes: ['messageAdded'],
          labelId: 'INBOX',
        });
        messageIds = extractMessageIds(result);
        newHistoryId = result.historyId;
      } catch (err) {
        if (err.code === 404) {
          // HistoryId expired → fallback
          mode = 'FALLBACK';
        } else throw err;
      }
    } else {
      mode = 'FALLBACK';
    }

    if (mode === 'FALLBACK') {
      const result = await gmail.messages.list({
        q: `in:inbox -label:${labels.processed.name}`,
        maxResults: options.maxBatch ?? 50,
      });
      messageIds = result.messages?.map(m => m.id) ?? [];
      newHistoryId = await getCurrentHistoryId(gmail); // đọc historyId từ message mới nhất
    }

    // 3. Process batch
    const stats = initStats();
    const batch = messageIds.slice(0, options.maxBatch ?? 50);

    for (const msgId of batch) {
      try {
        await processEmail(msgId, gmail, labels, stats);
      } catch (err) {
        logEmailError(msgId, err);
        stats.errored++;
      }
    }

    // 4. Update state
    if (newHistoryId && stats.errored === 0) {
      await updateSyncState({
        last_history_id: newHistoryId,
        last_synced_at: new Date(),
        last_full_sync_at: mode === 'FALLBACK' ? new Date() : undefined,
        consecutive_failures: 0,
        emails_processed_total: { increment: batch.length },
      });
    } else if (stats.errored > 0) {
      await updateSyncState({
        consecutive_failures: { increment: 1 },
        last_error: 'Batch had errors',
        last_error_at: new Date(),
      });
    }

    // 5. Write audit log
    await writeSyncLog({
      sync_method: mode,
      duration_ms: Date.now() - startMs,
      ...stats,
    });

    return { mode, duration_ms: Date.now() - startMs, stats, next_history_id: newHistoryId };

  } finally {
    await releaseAdvisoryLock(SYNC_LOCK_KEY);
  }
}

async function processEmail(msgId: string, gmail: GmailClient, labels: LabelMap, stats: Stats) {
  // Skip if already processed (idempotency check before Gmail fetch)
  const existing = await db.email_messages.findUnique({ where: { gmail_msg_id: msgId } });
  if (existing) return;

  // Fetch full email
  const msg = await gmail.messages.get({ id: msgId, format: 'full' });
  const parsed = parseGmailMessage(msg);

  stats.fetched++;

  // Insert into DB (PENDING status)
  const emailRow = await db.email_messages.create({
    data: {
      gmail_msg_id: msg.id,
      gmail_thread_id: msg.threadId,
      subject: parsed.subject,
      sender_email: parsed.fromEmail,
      sender_name: parsed.fromName,
      received_at: new Date(parseInt(msg.internalDate)),
      raw_body_text: parsed.bodyText,
      classification_status: 'PENDING',
    },
  });

  // Call Email Rule Engine (Section 3) + Ticket Engine (Section 4)
  const result = await classifyAndTicket(emailRow);
  
  // Update classification result + attach to ticket
  await db.email_messages.update({
    where: { id: emailRow.id },
    data: {
      classification_status: result.status,  // CLASSIFIED | UNCLASSIFIED_APP | UNCLASSIFIED_TYPE
      classification_result: result.details,
      ticket_id: result.ticketId,
      processed_at: new Date(),
    },
  });

  if (result.status === 'CLASSIFIED') {
    stats.classified++;
    if (result.ticketCreated) stats.tickets_created++;
    else stats.tickets_updated++;
  } else if (result.status === 'UNCLASSIFIED_APP') {
    stats.unclassified_app++;
  } else if (result.status === 'UNCLASSIFIED_TYPE') {
    stats.unclassified_type++;
  }

  // Apply Gmail label
  const labelToAdd = chooseLabelForStatus(result.status, labels);
  await gmail.messages.modify({
    id: msgId,
    addLabelIds: [labelToAdd.id],
  });
}
```

---

## 4. Gmail API wrappers

### 4.1. Client creation + token refresh

Dùng `googleapis` npm package. Token encrypt/decrypt wrap:

```ts
// lib/gmail/client.ts
import { google } from 'googleapis';
import { decryptToken, encryptToken } from '@/lib/crypto';

export async function createGmailClient(creds: GmailCredentials) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    undefined  // no redirect URL needed for refresh
  );

  oauth2.setCredentials({
    access_token: await decryptToken(creds.access_token_encrypted),
    refresh_token: await decryptToken(creds.refresh_token_encrypted),
    expiry_date: creds.token_expires_at.getTime(),
  });

  // Handle auto-refresh: googleapis tự refresh khi access_token expired
  oauth2.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await db.gmail_credentials.update({
        where: { id: 1 },
        data: {
          access_token_encrypted: await encryptToken(tokens.access_token),
          token_expires_at: new Date(tokens.expiry_date!),
          last_refreshed_at: new Date(),
          ...(tokens.refresh_token && {
            refresh_token_encrypted: await encryptToken(tokens.refresh_token),
          }),
        },
      });
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2 });
}
```

**AES-256-GCM encryption** cho token:
```ts
// lib/crypto.ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const KEY = Buffer.from(process.env.GMAIL_ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv || tag || ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
```

Generate key một lần khi setup: `openssl rand -hex 32` → `GMAIL_ENCRYPTION_KEY` env var. **Không bao giờ rotate** trong production — rotate = hỏng token hiện có, phải reconnect Gmail.

### 4.2. history.list (incremental)

```ts
// lib/gmail/history.ts
export async function fetchHistoryDelta(
  gmail: GmailClient,
  startHistoryId: string,
  maxResults = 100
): Promise<{ messageIds: string[]; newHistoryId: string }> {
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId = startHistoryId;

  // Paginate to handle burst scenarios
  while (true) {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      maxResults,
      pageToken,
    });

    newHistoryId = res.data.historyId ?? newHistoryId;

    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }

    if (!res.data.nextPageToken) break;
    pageToken = res.data.nextPageToken;
    if (messageIds.size >= 200) break;  // safety cap
  }

  return { messageIds: [...messageIds], newHistoryId };
}
```

**Edge case 404**: throw error với code `404`, caller trigger fallback.

### 4.3. messages.get + MIME parsing

Gmail trả email dạng nested MIME. Cần flatten để extract text body:

```ts
// lib/gmail/parser.ts
export function parseGmailMessage(msg: gmail_v1.Schema$Message): ParsedEmail {
  const headers = Object.fromEntries(
    (msg.payload?.headers ?? []).map(h => [h.name!.toLowerCase(), h.value!])
  );

  return {
    gmailMsgId: msg.id!,
    gmailThreadId: msg.threadId!,
    subject: headers['subject'] ?? '(no subject)',
    fromEmail: extractEmail(headers['from']),
    fromName: extractName(headers['from']),
    receivedAt: new Date(parseInt(msg.internalDate!)),
    bodyText: extractPlainTextBody(msg.payload!),
  };
}

function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart): string {
  // Recursive walk to find text/plain part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  for (const part of payload.parts ?? []) {
    const found = extractPlainTextBody(part);
    if (found) return found;
  }
  // Fallback: nếu chỉ có HTML, strip tags basic
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return stripHtmlTags(html);
  }
  return '';
}

function extractEmail(from: string): string {
  // "Name <email@x.com>" → "email@x.com"
  // "email@x.com" → "email@x.com"
  const match = from.match(/<(.+?)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}
```

**Test inputs** (unit tests):
- Plain email: just text/plain body
- Multipart: text/plain + text/html alternatives
- Nested multipart: multipart/related → multipart/alternative → text/plain
- HTML-only (fallback): chỉ text/html
- Forwarded email: parse inline quote
- Multi-language: UTF-8 Vietnamese + English

### 4.4. Labels management

```ts
// lib/gmail/labels.ts
const REQUIRED_LABELS = [
  'StoreManagement/Processed',
  'StoreManagement/Unclassified',
  'StoreManagement/Error',
] as const;

export async function ensureLabelsExist(gmail: GmailClient): Promise<LabelMap> {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = new Map(data.labels?.map(l => [l.name, l]) ?? []);

  const result: LabelMap = { processed: null, unclassified: null, error: null };

  for (const labelName of REQUIRED_LABELS) {
    let label = existing.get(labelName);
    if (!label) {
      const { data: created } = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });
      label = created;
    }
    const key = labelName.split('/')[1].toLowerCase() as keyof LabelMap;
    result[key] = { id: label.id!, name: label.name! };
  }

  return result;
}

export function chooseLabelForStatus(
  status: ClassificationStatus,
  labels: LabelMap
): LabelInfo {
  switch (status) {
    case 'CLASSIFIED': return labels.processed;
    case 'UNCLASSIFIED_APP':
    case 'UNCLASSIFIED_TYPE':
      return labels.unclassified;
    case 'ERROR':
    default:
      return labels.error;
  }
}
```

**Cache label IDs** trong memory của cron run. Labels stable (không user delete) → không cần refresh trong run.

---

## 5. Fallback flow (chi tiết)

Khi `history.list` trả 404 (historyId > 7 ngày tuổi), fallback:

```ts
async function runFallbackSync(gmail: GmailClient, labels: LabelMap, maxBatch: number) {
  // Query email chưa có label Processed
  const query = `in:inbox -label:${labels.processed.name} -label:${labels.error.name}`;
  
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: maxBatch,
  });

  const messageIds = data.messages?.map(m => m.id!) ?? [];
  
  // Lấy historyId hiện tại để save làm baseline mới
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const newHistoryId = profile.data.historyId!;

  return { messageIds, newHistoryId };
}
```

**Logic label filter trong query**:
- `-label:StoreManagement/Processed`: email chưa process
- `-label:StoreManagement/Error`: email đã fail (tránh retry forever)
- Email có label `Unclassified` **vẫn được query lại** — user có thể đã update Email Rule / App Registry → retry hợp lý

**Khi nào trigger fallback ngoài 404**:
- `forceMode: 'fallback'` truyền từ Manual trigger UI
- `consecutive_failures > 3` (auto self-heal)
- Weekly health check cron `0 4 * * 0` detect historyId sắp expire (>5 ngày) → trigger fallback proactive

---

## 6. Error handling & idempotency

### 6.1. Idempotency guarantees

| Operation | Mechanism |
|---|---|
| Email dedup | `UNIQUE(gmail_msg_id)` trên `email_messages` — race INSERT throws, caller skip |
| Classification dedup | Check `classification_status != 'PENDING'` trước khi process |
| Label apply | Gmail `addLabelIds` idempotent — thêm label đã có không error |
| Cron concurrent | Advisory lock — 2nd run trả 409 |
| Sync state update | Chỉ update khi `stats.errored === 0` để tránh skip email lỗi |

### 6.2. Error categories + handling

```ts
// lib/gmail/errors.ts
class GmailTokenExpiredError extends Error {}    // 401 từ Gmail
class GmailRateLimitError extends Error {}        // 429 từ Gmail
class GmailHistoryExpiredError extends Error {}   // 404 từ history.list
class EmailParseError extends Error {}            // MIME/UTF parse fail
class ClassifierError extends Error {}            // Section 3 throw
class TicketEngineError extends Error {}          // Section 4 throw (vd constraint violation)
```

| Error | Action | User-facing |
|---|---|---|
| Token expired, refresh fail | Stop cron, alert Manager, banner UI "Gmail disconnected, please reconnect" | Banner on all pages |
| Rate limit (429) | Backoff 60s, retry in next cron | Silent, auto recover |
| History expired (404) | Fallback mode (auto) | Silent, auto recover |
| Email parse error | Mark email `classification_status=ERROR`, log, Gmail label `Error` | Show trong "Errors" tab dưới Email Rules view |
| Classifier error (vd regex timeout) | Mark `classification_status=ERROR`, log with rule ID | Same as above |
| Ticket engine error (vd DB constraint) | **Rollback transaction**, mark email ERROR, alert | Same as above |

**Retry strategy**: Cron tự retry lần next (5 phút sau). **Không retry trong cùng cron run** — tránh stuck loop. Exception: Gmail API transient errors (502, 503) retry 2 lần với backoff 1s, 3s.

### 6.3. Partial batch failure

Batch 50 email, email thứ 30 fail — xử lý thế nào?

```
Decision: continue processing remaining, don't abort batch.
- Email 1-29: processed OK, committed
- Email 30: error, marked ERROR status in DB
- Email 31-50: continue processing

Nhưng: historyId KHÔNG update trong batch có error.
→ Next cron run sẽ re-query từ historyId cũ, bao gồm email đã process.
→ Email đã có trong DB (UNIQUE gmail_msg_id) → skip (idempotent).
→ Email ERROR status vẫn giữ trong DB (no retry tự động).
```

Email ERROR chỉ retry khi:
- User manually trigger "Retry classification" trong UI (endpoint `POST /api/email-messages/{id}/retry`)
- Hoặc fallback cron pick up lại (vì email không có label Processed)

#### 6.3.1. Soft vs hard errors — stats vs persisted rows

**Not all error paths persist an `email_messages` row.** Implementation
reality (see `lib/store-submissions/gmail/sync.ts` batch loop):

| Error path | Persists ERROR row? | `stats.errors` incremented? |
|---|---|---|
| `EmailParseError` from parser (malformed MIME) | ✅ Yes — row with `sender_email='unknown@parse.error'`, `error_code='PARSE_ERROR'` | ✅ |
| Classifier returns `ErrorResult` (`NO_SUBJECT_MATCH`, `REGEX_TIMEOUT`, `PARSE_ERROR`) | ✅ Yes — row with real sender, `classification_result.error_code` set | ✅ |
| Platform has no rules configured (`NO_RULES`) | ✅ Yes — row with real sender, `error_code='NO_RULES'` | ✅ |
| **Outer-catch "hard" failure** (`getMessage` network error, `emailAlreadyPersisted` DB hiccup, unexpected exception) | ❌ **No row** | ✅ |

**Rationale for no-row on outer-catch:** those failures happen *before*
we have enough context to construct a meaningful row. A partial row
with null `subject`/`sender_email` would just create noise in the
Inbox view without aiding debugging.

**Consequence — dashboards must account for this:**
- `sync_logs.emails_errored` is a **superset** of
  `SELECT count(*) FROM email_messages WHERE classification_status='ERROR'`.
- The gap represents transient failures. These self-heal: the cursor
  doesn't advance on any `stats.errors > 0`, so the next 5-min tick
  re-fetches the same messages; dedup via `UNIQUE(gmail_msg_id)` skips
  already-persisted ones, while the transient failures get retried.
- Debugging transient failures relies on the `console.error` app log
  (Railway), not the `email_messages` table.

If persistent silent failures become a concern (e.g., 20% of runs
showing this gap for a week), add an outer-catch row-write with a
placeholder `sender_email='unknown@outer.error'`, parallel to the
existing parse-error placeholder path. Acceptable for MVP to defer
until the pattern surfaces.

---

## 7. Code structure

```
app/
├── api/
│   ├── sync/
│   │   └── gmail/
│   │       └── route.ts                  POST handler
│   ├── cleanup/
│   │   └── emails/
│   │       └── route.ts                  POST handler
│   ├── gmail/
│   │   ├── connect/route.ts              OAuth start
│   │   └── callback/route.ts             OAuth callback

lib/
├── gmail/
│   ├── client.ts                         createGmailClient, token refresh
│   ├── parser.ts                         MIME parsing, extractEmail
│   ├── history.ts                        fetchHistoryDelta
│   ├── fallback.ts                       runFallbackSync
│   ├── labels.ts                         ensureLabelsExist, chooseLabelForStatus
│   ├── sync.ts                           runSync orchestrator
│   └── errors.ts                         error classes
├── crypto.ts                             encryptToken, decryptToken
├── db/
│   └── prisma.ts                         (or supabase-js client)
├── locks/
│   └── advisory.ts                       acquireAdvisoryLock
├── classifier/                           (Section 3)
└── ticket-engine/                        (Section 4)

types/
├── gmail.ts                              ParsedEmail, LabelMap, etc.
└── sync.ts                               SyncOptions, SyncResult, Stats
```

---

## 8. Testing strategy

### 8.1. Unit tests

| Module | Test focus |
|---|---|
| `parser.ts` | Parse multipart MIME, nested parts, HTML-only fallback, From header variations, Vietnamese UTF-8 |
| `crypto.ts` | Round-trip encrypt/decrypt, tampered ciphertext rejection |
| `labels.ts` | Create missing labels, cache hit/miss |
| `history.ts` | Pagination, empty response, 404 handling |

### 8.2. Integration tests

Mock Gmail API với `nock` hoặc tương đương. Key scenarios:

```
Scenario 1: Happy path incremental
  - State: last_history_id = 'H100'
  - Gmail: history.list returns 3 new messages
  - Expect: 3 emails created, 3 tickets processed, state updated to 'H105'

Scenario 2: History expired fallback  
  - State: last_history_id = 'H100'
  - Gmail: history.list returns 404
  - Expect: fallback mode triggers, messages.list returns 5 emails, mode='FALLBACK'

Scenario 3: Token refresh during run
  - State: token expires in 30 seconds
  - Expect: tokens event fires, DB updated with new token

Scenario 4: Duplicate email (replay)
  - Setup: email already in DB with gmail_msg_id='X'
  - Run: Gmail returns 'X' in batch
  - Expect: skipped, stats.fetched=0, no duplicate INSERT

Scenario 5: Partial batch failure
  - Batch of 10, email #5 throws parse error
  - Expect: #1-4 + #6-10 processed, #5 marked ERROR, state NOT updated (errored > 0)

Scenario 6: Concurrent cron
  - Simulate 2 concurrent POST /api/sync/gmail
  - Expect: 1 returns 200, other returns 409
```

### 8.3. Contract tests (real Gmail)

Chạy weekly trong CI với test Gmail account. Verify:
- OAuth flow works end-to-end
- Labels tạo được
- Sample email được fetch đúng
- historyId tăng monotonically

---

## 9. Monitoring & alerts

### 9.1. Metrics log ra `sync_logs`

Mỗi cron run append 1 row. Query dashboard:

```sql
-- Last 24h sync rate
SELECT date_trunc('hour', ran_at) as hour,
       COUNT(*) as runs,
       SUM(emails_fetched) as emails,
       AVG(duration_ms)::int as avg_ms,
       SUM(emails_errored) as errors
FROM sync_logs
WHERE ran_at > NOW() - INTERVAL '24 hours'
GROUP BY hour ORDER BY hour DESC;

-- Classification success rate
SELECT 
  SUM(emails_classified) * 100.0 / NULLIF(SUM(emails_fetched), 0) as classified_pct,
  SUM(emails_unclassified) * 100.0 / NULLIF(SUM(emails_fetched), 0) as unclassified_pct
FROM sync_logs
WHERE ran_at > NOW() - INTERVAL '7 days';
```

### 9.2. Alerts (Sentry)

```ts
// Wrapper cho API handler
import * as Sentry from '@sentry/nextjs';

export async function POST(req: NextRequest) {
  try {
    // ... sync logic
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'gmail-sync' },
      extra: { mode: currentMode, state: syncState },
    });
    throw err;
  }
}
```

Alert thresholds (config trong Sentry dashboard):
- `consecutive_failures >= 3`: immediate email alert
- `classified_pct < 80% over 1 hour`: warning (rule drift có thể)
- `avg_duration_ms > 45000`: warning (approaching 60s timeout)
- Token refresh fail: critical

### 9.3. Health check endpoint

Thêm `GET /api/health/sync` cho external monitoring (UptimeRobot, etc.):

```ts
// app/api/health/sync/route.ts
export async function GET() {
  const state = await loadSyncState();
  const last = state.last_synced_at;
  const staleMs = last ? Date.now() - last.getTime() : Infinity;
  
  if (staleMs > 15 * 60 * 1000) {
    return NextResponse.json(
      { status: 'STALE', last_synced_at: last, stale_ms: staleMs },
      { status: 503 }
    );
  }
  return NextResponse.json({ status: 'OK', last_synced_at: last });
}
```

---

## 10. Scale out (khi vượt giới hạn MVP)

**Triggers**: email volume > 500/hour (≈ sync run xử lý 40+ email consistently) hoặc duration > 45s regularly.

**Options** (theo thứ tự cost/complexity):

**Option A — Shorter interval, smaller batch** (zero code change)
- `*/2 * * * *` thay vì `*/5`
- maxBatch vẫn 50
- Giảm worst-case latency

**Option B — Queue-based** (1 week refactor)
- `/api/sync/gmail` chỉ fetch IDs + INSERT PENDING rows
- Separate cron `/api/process/pending` chạy classification + ticket engine
- Dùng `SELECT FOR UPDATE SKIP LOCKED` trên `email_messages WHERE status='PENDING'` để worker-style consumption
- Vẫn chạy trong Next.js API routes, không cần worker process

**Option C — Gmail Pub/Sub push** (2-3 week, most complex)
- Gmail `users.watch` → Cloud Pub/Sub topic → push subscription hit webhook
- Cần Google Cloud project + Pub/Sub setup
- Near real-time (giây)
- Renew `watch` mỗi 7 ngày (cron task)

**Option D — Dedicated worker service** (Railway worker type)
- Node process always-on, không qua HTTP
- Dùng `setInterval` hoặc `bull`/`bullmq`
- Redis cần thiết

Recommend path: **A → B → C** khi cần. D chỉ khi complexity đủ để justify worker service riêng.

---

## 11. Initial setup checklist

Trước khi chạy cron lần đầu:

- [ ] `GMAIL_ENCRYPTION_KEY` generated và set trong Railway env: `openssl rand -hex 32`
- [ ] `CRON_SECRET` generated và set: `openssl rand -hex 24`
- [ ] Google Cloud project tạo, OAuth consent screen configured
- [ ] Google OAuth Client ID/Secret set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- [ ] OAuth redirect URI whitelist: `https://{prod-domain}/api/store-submissions/gmail/callback` (plus `http://localhost:3000/...` for dev)
- [ ] Gmail scope enabled trong consent screen: `https://www.googleapis.com/auth/gmail.modify`
- [ ] Manager (initial user) login tool → Settings → "Connect Gmail" → OAuth shared mailbox
- [ ] Verify `gmail_credentials` row tồn tại trong DB
- [ ] Manually trigger 1st sync: `curl -X POST /api/sync/gmail -H "X-Cron-Secret: ..."` → verify labels tạo thành công
- [ ] Enable Railway cron schedule `*/5 * * * *`

---

## 12. Open questions

1. **Health check external service**: dùng UptimeRobot (free) monitor `/api/health/sync`, hay Sentry cron monitoring đã đủ?
2. **Gmail daily quota alert**: Gmail user có quota 1B units/day. Monitor nếu hit 80%? (Rất khó hit với 5 người, defer)
3. **Manual sync UI**: Manager có nên có button "Sync now" trong Settings để trigger manual run không? (Recommend: có, rate-limited 1 call/phút)
4. **Token refresh buffer**: refresh token khi còn 5 phút hay 30 phút trước expire? googleapis default là reactive (refresh khi 401). (Recommend: keep reactive, đơn giản hơn)

---

## Kết luận

Pipeline design ưu tiên **simplicity + idempotency**:
- 1 stateless HTTP endpoint, triggered bằng Railway cron
- Advisory lock cho concurrency
- UNIQUE constraint cho email dedup
- Fallback tự động khi historyId expire
- Partial batch failure không block batch còn lại

**Không có**: queue, worker process, webhook. Tất cả synchronous trong cron run.

**Next up**: Section 3 Email Rule Engine — pure function classify email thành structured data.
