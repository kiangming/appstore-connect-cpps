# Tech Design Deep-Dive — Email Rule Engine

**Scope:** Component [B] classify raw email thành structured data. Pure function, no side effects.
**Prerequisite:** Data Model (section 01), Gmail Sync (section 02)

---

## 1. Overview & contract

Email Rule Engine là **pure function** — input email thô + rules từ DB, output structured classification. Không ghi DB, không gọi external service, không side effects.

```
            ┌──────────────────────────────┐
            │   Email Rule Engine          │
            │                              │
  email  ───▶   1. Match sender           │
  raw    │      2. Match subject           │──▶ ClassificationResult
         │      3. Lookup app (alias)      │
  rules  │      4. Detect type + payload   │
  (DB)   │      5. Extract submission_id   │
         └──────────────────────────────┘
```

**Contract**:

```typescript
function classify(email: ParsedEmail, rules: CachedRules): ClassificationResult
```

Không throw exception (trừ programming error như invalid rules config — throw at startup/save time, not classify time). Email không classify được → trả về `UNCLASSIFIED_*` hoặc `DROPPED`, caller xử lý.

**Design principles**:
1. **Deterministic** — cùng input → cùng output, testable
2. **Fail-soft** — không throw khi rule không match, trả status rõ ràng
3. **Traceable** — output có `matched_rules[]` để debug
4. **Fast** — target <100ms per email (avg)
5. **Safe** — user-provided regex chạy qua RE2, linear time guarantee

---

## 2. ClassificationResult contract

```typescript
type ClassificationResult =
  | DroppedResult          // Email intentionally ignored (wrong sender OR subject not in whitelist)
  | UnclassifiedAppResult  // Subject match nhưng app không có trong Registry
  | UnclassifiedTypeResult // Type không detect được từ body
  | ClassifiedResult       // Full success
  | ErrorResult;           // Parse/regex error — true processing failure

type DroppedReason = 'NO_SENDER_MATCH' | 'SUBJECT_NOT_TRACKED';

type DroppedResult = {
  status: 'DROPPED';
  reason: DroppedReason;
  // Audit fields — populated for SUBJECT_NOT_TRACKED only; absent for NO_SENDER_MATCH.
  platform_id?: UUID;
  platform_key?: PlatformKey;
  matched_sender?: string;
  matched_rules?: MatchedRule[];
};

type UnclassifiedAppResult = {
  status: 'UNCLASSIFIED_APP';
  platform_id: UUID;
  outcome: Outcome;
  extracted_app_name: string | null;
  matched_rules: MatchedRule[];
};

type UnclassifiedTypeResult = {
  status: 'UNCLASSIFIED_TYPE';
  platform_id: UUID;
  app_id: UUID;
  outcome: Outcome;
  extracted_app_name: string;
  matched_rules: MatchedRule[];
};

type ClassifiedResult = {
  status: 'CLASSIFIED';
  platform_id: UUID;
  app_id: UUID;
  type_id: UUID;
  outcome: Outcome;
  type_payload: Record<string, string>;   // {version: '2.4.1', os: 'iOS'}
  submission_id: string | null;
  extracted_app_name: string;
  matched_rules: MatchedRule[];
};

type ErrorResult = {
  status: 'ERROR';
  error_code: 'REGEX_TIMEOUT' | 'PARSE_ERROR';
  error_message: string;
  matched_rules: MatchedRule[];
};

type Outcome = 'APPROVED' | 'REJECTED' | 'IN_REVIEW';

type MatchedRule = {
  step: 'sender' | 'subject' | 'app' | 'type' | 'payload' | 'submission_id';
  matched: boolean;
  details?: any;  // rule_id, capture groups, etc.
};
```

Gmail Sync (section 02) dùng `status` để quyết định:
- `DROPPED` → không INSERT `email_messages` row, skip Gmail label
- `CLASSIFIED` → INSERT row với status=CLASSIFIED, call Ticket Engine, label `Processed`
- `UNCLASSIFIED_APP` / `UNCLASSIFIED_TYPE` → INSERT row với status tương ứng, call Ticket Engine (tạo Unclassified bucket ticket), label `Unclassified`
- `ERROR` → INSERT row với status=ERROR, skip Ticket Engine, label `Error`

---

## 3. Pipeline steps (chi tiết)

### Step 1 — Match sender → Platform

```typescript
function matchSender(senderEmail: string, rules: CachedRules): Platform | null {
  const normalized = senderEmail.trim().toLowerCase();
  return rules.senderToPlatform.get(normalized) ?? null;
}
```

`senderToPlatform` là `Map<string, Platform>` built khi load rules (pre-computed cho O(1) lookup):

```typescript
function buildSenderMap(platforms: Platform[]): Map<string, Platform> {
  const map = new Map<string, Platform>();
  for (const platform of platforms) {
    for (const sender of platform.senders) {
      if (sender.active) {
        map.set(sender.email.trim().toLowerCase(), platform);
      }
    }
  }
  return map;
}
```

**Edge**: Sender email có thể có display name `"Apple <no-reply@apple.com>"`. Parser ở Section 02 đã extract phần email-only → input đã normalized.

Kết quả null → `DroppedResult`, pipeline dừng.

### Step 2 — Match subject → outcome + app_name

```typescript
function matchSubject(
  subject: string,
  platform: Platform
): { outcome: Outcome; extractedAppName: string | null; patternId: UUID } | null {
  // Pattern sort by priority ASC, chạy first-match-wins
  const sortedPatterns = platform.subjectPatterns
    .filter(p => p.active)
    .sort((a, b) => a.priority - b.priority);

  for (const pattern of sortedPatterns) {
    const match = re2Exec(pattern.regex, subject);
    if (match) {
      return {
        outcome: pattern.outcome,
        extractedAppName: match.groups?.app_name?.trim() ?? null,
        patternId: pattern.id,
      };
    }
  }
  return null;
}
```

**Ví dụ**:
- Subject: `"Review of your Skyline Runners submission is complete."`
- Pattern APPROVED: `Review of your (?P<app_name>.+) submission is complete\.`
- Match → `{ outcome: 'APPROVED', extractedAppName: 'Skyline Runners' }`

Không match pattern nào → `DroppedResult { reason: 'SUBJECT_NOT_TRACKED', platform_id, platform_key, matched_sender, matched_rules }`.

**Rationale (reversed since v1 spec)**: subject patterns are a **whitelist** of event types Managers explicitly track. Apple (and other stores) routinely send other mail to the same addresses — "Status Update", "Ready for Distribution", "IAP Approved", weekly digests, etc. Before this change, any such mail was flagged ERROR, which bumped `sync_logs.emails_errored` and `gmail_sync_state.consecutive_failures`, creating alert noise for normal operation. Classifying non-whitelisted subjects as DROPPED preserves the original intent (ignore silently) while keeping ERROR reserved for true processing failures (`REGEX_TIMEOUT`, `PARSE_ERROR`, `NO_RULES`). Audit fields on the DROPPED row still let the Errors tab surface "which platform's whitelist ignored which subjects" so Managers can add patterns when a new event type becomes relevant.

### Step 3 — Lookup app by alias

```typescript
function lookupApp(extractedName: string, aliases: AppAlias[]): UUID | null {
  if (!extractedName) return null;
  const normalized = extractedName.trim().toLowerCase();

  // Stage 1: exact text match (fast, common case)
  for (const alias of aliases) {
    if (alias.alias_text) {
      if (alias.alias_text.toLowerCase() === normalized) {
        return alias.app_id;
      }
    }
  }

  // Stage 2: regex match (slower, fallback)
  for (const alias of aliases) {
    if (alias.alias_regex) {
      if (re2Test(alias.alias_regex, extractedName)) {
        return alias.app_id;
      }
    }
  }

  return null;
}
```

**Priority**: exact text match trước regex. Lý do: 90%+ case là text match (auto alias từ tên app), regex chỉ cho case đặc biệt như "Skyline Runners: .*" để catch localized titles.

**Optimization**: pre-build `Map<normalizedText, app_id>` cho Stage 1 → O(1). Stage 2 vẫn O(n regex aliases).

Không match → `UnclassifiedAppResult`. `extractedAppName` trả về để UI hiển thị gợi ý "App 'Skyline X' không có trong Registry. Add alias?"

### Step 4 — Detect type + extract payload

```typescript
function detectTypeAndPayload(
  bodyText: string,
  platformTypes: Type[]
): { type_id: UUID; payload: Record<string, string> } | null {
  // Sort by sort_order ASC
  const sortedTypes = platformTypes
    .filter(t => t.active)
    .sort((a, b) => a.sort_order - b.sort_order);

  for (const type of sortedTypes) {
    // Step 4a: body keyword detection (cheap substring check)
    if (!bodyText.includes(type.body_keyword)) continue;

    // Step 4b: extract payload via regex
    let payload: Record<string, string> = {};
    if (type.payload_extract_regex) {
      const match = re2Exec(type.payload_extract_regex, bodyText);
      payload = match?.groups ?? {};
    }

    return { type_id: type.id, payload };
  }

  return null;
}
```

**2-stage design**: keyword check là string.includes (O(body size)) → fast filter. Chỉ chạy regex khi keyword match → giảm regex evaluation trên body dài.

**Edge case**: match nhiều type cùng lúc (vd body có cả "App Version" và "In-App Events"). Theo decision với PM: tạo ticket riêng cho mỗi type matched. **Handle ở caller** (Gmail Sync), không trong classifier. Classifier trả về first match theo `sort_order`. Nếu cần multi-match, caller loop:

```typescript
// Trong processEmail của Gmail Sync, nếu cần:
const typeMatches = detectAllTypes(bodyText, platform.types);
for (const typeMatch of typeMatches) {
  // create separate ticket for each
}
```

MVP: classifier first-match only. Multi-match là extension nếu xuất hiện case thực tế.

Không match type nào → `UnclassifiedTypeResult`.

### Step 5 — Extract submission_id (optional)

```typescript
function extractSubmissionId(
  bodyText: string,
  patterns: SubmissionIdPattern[]
): string | null {
  for (const p of patterns.filter(p => p.active)) {
    const match = re2Exec(p.body_regex, bodyText);
    if (match?.groups?.submission_id) {
      return match.groups.submission_id.trim();
    }
  }
  return null;
}
```

Không match → trả null. **Không error** — submission_id là nice-to-have reference data, không ảnh hưởng classify success.

### Step 6 — Orchestrator (main classify function)

```typescript
export function classify(
  email: ParsedEmail,
  rules: CachedRules
): ClassificationResult {
  const matched: MatchedRule[] = [];

  try {
    // Step 1
    const platform = matchSender(email.senderEmail, rules);
    if (!platform) {
      return { status: 'DROPPED', reason: 'NO_SENDER_MATCH' };
    }
    matched.push({ step: 'sender', matched: true, details: { platformKey: platform.key } });

    // Step 2 — subject patterns are a whitelist; non-match = intentional ignore.
    const subjectResult = matchSubject(email.subject, platform);
    if (!subjectResult) {
      return {
        status: 'DROPPED',
        reason: 'SUBJECT_NOT_TRACKED',
        platform_id: platform.id,
        platform_key: platform.key,
        matched_sender: email.senderEmail,
        matched_rules: matched,
      };
    }
    matched.push({
      step: 'subject',
      matched: true,
      details: { outcome: subjectResult.outcome, patternId: subjectResult.patternId },
    });

    // Step 3
    const appId = subjectResult.extractedAppName
      ? lookupApp(subjectResult.extractedAppName, rules.aliasesByPlatform.get(platform.id) ?? [])
      : null;
    if (!appId) {
      matched.push({ step: 'app', matched: false });
      return {
        status: 'UNCLASSIFIED_APP',
        platform_id: platform.id,
        outcome: subjectResult.outcome,
        extracted_app_name: subjectResult.extractedAppName,
        matched_rules: matched,
      };
    }
    matched.push({ step: 'app', matched: true, details: { appId } });

    // Step 4
    const typeResult = detectTypeAndPayload(email.bodyText, rules.typesByPlatform.get(platform.id) ?? []);
    if (!typeResult) {
      matched.push({ step: 'type', matched: false });
      return {
        status: 'UNCLASSIFIED_TYPE',
        platform_id: platform.id,
        app_id: appId,
        outcome: subjectResult.outcome,
        extracted_app_name: subjectResult.extractedAppName!,
        matched_rules: matched,
      };
    }
    matched.push({
      step: 'type',
      matched: true,
      details: { typeId: typeResult.type_id, payload: typeResult.payload },
    });

    // Step 5
    const submissionId = extractSubmissionId(
      email.bodyText,
      rules.submissionIdPatternsByPlatform.get(platform.id) ?? []
    );
    matched.push({ step: 'submission_id', matched: !!submissionId, details: { submissionId } });

    return {
      status: 'CLASSIFIED',
      platform_id: platform.id,
      app_id: appId,
      type_id: typeResult.type_id,
      outcome: subjectResult.outcome,
      type_payload: typeResult.payload,
      submission_id: submissionId,
      extracted_app_name: subjectResult.extractedAppName!,
      matched_rules: matched,
    };
  } catch (err) {
    if (err instanceof RegexTimeoutError) {
      return {
        status: 'ERROR',
        error_code: 'REGEX_TIMEOUT',
        error_message: err.message,
        matched_rules: matched,
      };
    }
    throw err; // unexpected — propagate
  }
}
```

---

## 4. RE2 integration

### 4.1. Lý do bắt buộc RE2

**ReDoS (Regular expression Denial of Service)**: một số regex có thể chạy exponential time với input đặc biệt. Ví dụ pattern `(a+)+b` với input `aaaaaaaaaaaaaaaaX` → catastrophic backtracking, freeze process vài giây đến vài phút.

Manager trong tool này viết regex tự do cho subject patterns, payload extraction, app aliases... → attack surface lớn. Không thể trust user regex trên V8's default engine.

**RE2 guarantees**: linear time regex matching. Không support backtracking features (lookbehind, backreferences) → trade-off acceptable cho use case này.

### 4.2. Package choice

```
re2 (npm)            Native C++ bindings. Fastest. 
                      ⚠ Cần build tools trong Railway (Python, gcc). Test deploy trước.
                     
re2-wasm             Pure WebAssembly. Portable.
                      ⚠ ~5x slower than native, nhưng vẫn đủ nhanh cho use case
                      ✅ Không cần build tools, zero deploy risk

node-re2 (npm)       = re2, alias package
```

**Recommend MVP**: `re2-wasm` — zero deploy risk. Upgrade sang native `re2` nếu perf hit sau.

### 4.3. Wrapper API

```typescript
// lib/regex/re2.ts
import { RE2 } from 're2-wasm';

const COMPILED_CACHE = new Map<string, RE2>();
const MAX_CACHE_SIZE = 500;

function getCompiled(pattern: string): RE2 {
  let re = COMPILED_CACHE.get(pattern);
  if (!re) {
    try {
      re = new RE2(pattern, 'u'); // 'u' = Unicode mode
    } catch (err) {
      throw new InvalidRegexError(pattern, (err as Error).message);
    }
    if (COMPILED_CACHE.size >= MAX_CACHE_SIZE) {
      // Simple LRU-ish: clear when full (classifier uses <100 patterns)
      COMPILED_CACHE.clear();
    }
    COMPILED_CACHE.set(pattern, re);
  }
  return re;
}

export function re2Exec(pattern: string, input: string): RegExpMatchArray | null {
  const re = getCompiled(pattern);
  return input.match(re as any); // RE2 implements String.match protocol
}

export function re2Test(pattern: string, input: string): boolean {
  const re = getCompiled(pattern);
  return re.test(input);
}

export function re2Validate(pattern: string): { ok: true } | { ok: false; error: string } {
  try {
    new RE2(pattern, 'u');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export class InvalidRegexError extends Error {
  constructor(public pattern: string, public reason: string) {
    super(`Invalid regex "${pattern}": ${reason}`);
  }
}

export class RegexTimeoutError extends Error {
  constructor(public pattern: string) {
    super(`Regex execution timeout: ${pattern}`);
  }
}
```

**Timeout**: RE2 có linear time guarantee, nhưng input cực lớn (vd body 10MB) vẫn có thể chậm. Khống chế ở 2 tầng:
1. Body size cap: Gmail Sync chỉ pass `bodyText.slice(0, 100_000)` (100KB) vào classifier
2. RE2 native/wasm không có built-in timeout → dựa vào size cap. Nếu cần strict, wrap trong `Promise.race([match(), timeout(100)])` — tốn overhead, defer.

### 4.4. Validation khi save rule

**Endpoint `POST /api/rules/*` middleware**:

```typescript
// lib/classifier/validate.ts
export function validateRegex(pattern: string, requireNamedGroups?: string[]): { ok: boolean; error?: string } {
  const result = re2Validate(pattern);
  if (!result.ok) return result;

  if (requireNamedGroups) {
    for (const groupName of requireNamedGroups) {
      // Rough check — parse pattern for (?P<name> or (?<name>
      const hasGroup = new RegExp(`\\(\\?P?<${groupName}>`).test(pattern);
      if (!hasGroup) {
        return { ok: false, error: `Missing required named group: ${groupName}` };
      }
    }
  }
  return { ok: true };
}
```

Áp dụng:
- Subject pattern: require named group `app_name`
- Payload extract regex: optional named groups (depends on type)
- App alias regex: no required groups
- Submission_id pattern: require `submission_id`

UI save button disabled khi validate fail, hiện error inline cho user biết sửa gì.

---

## 5. Rule loading & caching

### 5.1. CachedRules shape

```typescript
type CachedRules = {
  version: number;                                         // monotonic từ rule_versions
  platforms: Platform[];
  senderToPlatform: Map<string, Platform>;                 // pre-computed
  aliasesByPlatform: Map<UUID, AppAlias[]>;                // denormalized from apps
  typesByPlatform: Map<UUID, Type[]>;
  submissionIdPatternsByPlatform: Map<UUID, SubmissionIdPattern[]>;
  cachedAt: number;
};

type Platform = {
  id: UUID;
  key: string;
  displayName: string;
  senders: Sender[];
  subjectPatterns: SubjectPattern[];
  types: Type[];
  submissionIdPatterns: SubmissionIdPattern[];
};
```

### 5.2. Cache strategy

```typescript
// lib/classifier/rules-cache.ts
let cache: CachedRules | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

export async function loadRules(db: DB, options?: { forceRefresh?: boolean }): Promise<CachedRules> {
  if (!options?.forceRefresh && cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache;
  }

  const platforms = await db.platforms.findMany({
    where: { active: true },
    include: {
      senders: { where: { active: true } },
      subject_patterns: { where: { active: true } },
      types: { where: { active: true } },
      submission_id_patterns: { where: { active: true } },
    },
  });

  const apps = await db.apps.findMany({
    where: { active: true },
    include: { aliases: true, platform_bindings: true },
  });

  cache = {
    version: await getLatestRuleVersion(db),
    platforms,
    senderToPlatform: buildSenderMap(platforms),
    aliasesByPlatform: groupAliasesByPlatform(apps, platforms),
    typesByPlatform: new Map(platforms.map(p => [p.id, p.types])),
    submissionIdPatternsByPlatform: new Map(platforms.map(p => [p.id, p.submission_id_patterns])),
    cachedAt: Date.now(),
  };

  return cache;
}

export function invalidateRulesCache() {
  cache = null;
}
```

**Aliases per platform**: theo business logic, alias map theo app_name → app_id không phụ thuộc platform. Nhưng vì app có `platform_bindings`, ta chỉ bao gồm alias của apps có binding với platform đó. Logic:

```typescript
function groupAliasesByPlatform(
  apps: AppWithAliasesAndBindings[],
  platforms: Platform[]
): Map<UUID, AppAlias[]> {
  const map = new Map<UUID, AppAlias[]>();
  for (const platform of platforms) {
    map.set(platform.id, []);
  }
  for (const app of apps) {
    for (const binding of app.platform_bindings) {
      const list = map.get(binding.platform_id);
      if (list) {
        list.push(...app.aliases);
      }
    }
  }
  return map;
}
```

App không có binding với platform X → aliases của app không xuất hiện khi lookup trên platform X → email mention app này trong context platform X trả về `UNCLASSIFIED_APP`. Correct behavior.

### 5.3. Cache invalidation

Invalidate khi:
- Save rule change (POST/PATCH/DELETE on `/api/rules/*`): inline call `invalidateRulesCache()`
- Save app change (POST/PATCH on `/api/apps/*`): same
- CSV import: same
- Rule rollback: same

**Cross-process invalidation**: Next.js instance caching độc lập. 2 deploy instances → invalidate chỉ hit 1. Trade-off:

- **MVP accept eventual consistency 60s** — TTL 60s sẽ auto-converge
- **If needed strict**: use Postgres `NOTIFY`/`LISTEN` cho real-time invalidation giữa instances. Defer sang phase 2.

**Railway thường single instance** cho small apps → chưa cần cross-instance invalidation.

---

## 6. Test mode (API endpoint cho UI)

UI cần cho Manager test rule trước khi save. Endpoint:

```
POST /api/rules/test
Content-Type: application/json

{
  "sender": "no-reply@apple.com",
  "subject": "Review of your Skyline Runners submission is complete.",
  "body": "Your app has been approved...\n\nApp Version\n2.4.1 for iOS\n...",
  "override_rules": {                         // optional — test draft rules without save
    "platform_id": "...",
    "subject_patterns": [ {outcome, regex, priority} ],
    "types": [ {name, body_keyword, payload_extract_regex} ],
    "senders": [ {email} ]
  }
}
```

Response includes full trace:

```json
{
  "result": {
    "status": "CLASSIFIED",
    "platform_id": "...",
    "app_id": "...",
    "type_id": "...",
    "outcome": "APPROVED",
    "type_payload": { "version": "2.4.1", "os": "iOS" },
    "submission_id": null
  },
  "trace": [
    { "step": "sender", "matched": true, "details": { "matched_sender": "no-reply@apple.com", "platform": "Apple App Store" }},
    { "step": "subject", "matched": true, "details": {
      "matched_pattern": "Review of your (?P<app_name>.+) submission is complete\\.",
      "outcome": "APPROVED",
      "captured_groups": { "app_name": "Skyline Runners" }
    }},
    { "step": "app", "matched": true, "details": {
      "extracted_name": "Skyline Runners",
      "matched_alias": { "text": "Skyline Runners", "source_type": "AUTO_CURRENT" },
      "app_id": "...", "app_name": "Skyline Runners"
    }},
    { "step": "type", "matched": true, "details": {
      "type": "App",
      "body_keyword": "App Version",
      "payload": { "version": "2.4.1", "os": "iOS" }
    }},
    { "step": "submission_id", "matched": false }
  ]
}
```

**Side-effects**: NONE. Endpoint is pure — không ghi DB, không add Gmail label, không affect cache. Chỉ dùng cho rule debugging.

**UI usage**:
- Khi Manager edit 1 rule, UI save draft → call `/api/rules/test` với `override_rules` → hiện trace inline
- Khi Manager paste 1 email đang "Unclassified" → call endpoint → thấy step nào fail → biết phải sửa rule nào

---

## 7. Rule versioning

### 7.1. Snapshot on save

Transaction ACID khi save rule changes:

```typescript
// lib/rules/save.ts
export async function saveRulesForPlatform(
  platformId: UUID,
  changes: RuleChanges,
  savedBy: UUID,
  note?: string
): Promise<number> {
  return await db.$transaction(async (tx) => {
    // 1. Apply changes
    if (changes.senders) {
      await applyChanges(tx.senders, platformId, changes.senders);
    }
    if (changes.subject_patterns) {
      await applyChanges(tx.subject_patterns, platformId, changes.subject_patterns);
    }
    if (changes.types) {
      await applyChanges(tx.types, platformId, changes.types);
    }
    if (changes.submission_id_patterns) {
      await applyChanges(tx.submission_id_patterns, platformId, changes.submission_id_patterns);
    }

    // 2. Build snapshot of current state
    const snapshot = await buildConfigSnapshot(tx, platformId);

    // 3. Next version number per platform
    const lastVersion = await tx.rule_versions.findFirst({
      where: { platform_id: platformId },
      orderBy: { version_number: 'desc' },
      select: { version_number: true },
    });
    const nextVersion = (lastVersion?.version_number ?? 0) + 1;

    // 4. Insert version row
    await tx.rule_versions.create({
      data: {
        platform_id: platformId,
        version_number: nextVersion,
        config_snapshot: snapshot,
        saved_by: savedBy,
        note: note ?? null,
      },
    });

    return nextVersion;
  }).then(version => {
    invalidateRulesCache();
    return version;
  });
}

async function buildConfigSnapshot(tx, platformId: UUID): Promise<ConfigSnapshot> {
  const [senders, patterns, types, subIdPatterns] = await Promise.all([
    tx.senders.findMany({ where: { platform_id: platformId } }),
    tx.subject_patterns.findMany({ where: { platform_id: platformId } }),
    tx.types.findMany({ where: { platform_id: platformId } }),
    tx.submission_id_patterns.findMany({ where: { platform_id: platformId } }),
  ]);
  return { senders, subject_patterns: patterns, types, submission_id_patterns: subIdPatterns };
}
```

### 7.2. Rollback

```typescript
export async function rollbackToVersion(
  platformId: UUID,
  targetVersion: number,
  savedBy: UUID
): Promise<number> {
  const target = await db.rule_versions.findUnique({
    where: { platform_id_version_number: { platform_id: platformId, version_number: targetVersion } },
  });
  if (!target) throw new NotFoundError(`Version ${targetVersion} not found`);

  const snapshot = target.config_snapshot as ConfigSnapshot;

  return await db.$transaction(async (tx) => {
    // Wipe current rules
    await tx.senders.deleteMany({ where: { platform_id: platformId } });
    await tx.subject_patterns.deleteMany({ where: { platform_id: platformId } });
    await tx.types.deleteMany({ where: { platform_id: platformId } });
    await tx.submission_id_patterns.deleteMany({ where: { platform_id: platformId } });

    // Recreate from snapshot (strip ids để insert generates new ones)
    await tx.senders.createMany({
      data: snapshot.senders.map(({ id, ...s }) => ({ ...s, platform_id: platformId })),
    });
    await tx.subject_patterns.createMany({
      data: snapshot.subject_patterns.map(({ id, ...p }) => ({ ...p, platform_id: platformId })),
    });
    await tx.types.createMany({
      data: snapshot.types.map(({ id, ...t }) => ({ ...t, platform_id: platformId })),
    });
    await tx.submission_id_patterns.createMany({
      data: snapshot.submission_id_patterns.map(({ id, ...p }) => ({ ...p, platform_id: platformId })),
    });

    // Append new version (not overwriting)
    const lastVersion = await tx.rule_versions.findFirst({
      where: { platform_id: platformId },
      orderBy: { version_number: 'desc' },
    });
    const newVersion = (lastVersion?.version_number ?? 0) + 1;

    await tx.rule_versions.create({
      data: {
        platform_id: platformId,
        version_number: newVersion,
        config_snapshot: snapshot,
        saved_by: savedBy,
        note: `Rolled back to v${targetVersion}`,
      },
    });

    return newVersion;
  }).then(v => {
    invalidateRulesCache();
    return v;
  });
}
```

**Note về id re-generation**: sau rollback, `senders`/`patterns`/`types` có UUID mới. Hệ quả:
- Existing `classification_result.matched_rules[].pattern_id` trong `email_messages` trỏ vào UUID cũ không tồn tại nữa
- Không ảnh hưởng functionality (chỉ audit trail)
- Nếu cần strict audit: thêm field `pattern_id_at_classify_time` trong matched_rules (đã có trong snapshot)

### 7.3. Version history UI

```
GET /api/rules/versions?platform_id=xxx
Response: [
  { version: 12, saved_by: 'Linh Tran', saved_at: '2026-04-18T10:23:00Z', note: 'Added IN_REVIEW pattern' },
  { version: 11, saved_by: 'Linh Tran', saved_at: '2026-04-17T09:15:00Z', note: 'Updated payload regex for In-App Event' },
  ...
]

GET /api/rules/versions/{version_number}?platform_id=xxx
Response: full config_snapshot (cho UI diff view)
```

UI hiện list version + diff view (2 snapshots side-by-side). Simple text diff đủ cho MVP.

---

## 8. Error handling

| Error | Source | Action |
|---|---|---|
| `InvalidRegexError` | Save rule với pattern không RE2-compilable | Reject ở API validation, return 400 với error inline cho form field |
| `RegexTimeoutError` | Classify runtime, body quá dài + pattern chậm | Email marked `ERROR`, `error_code=REGEX_TIMEOUT`, log rule_id + email_id |
| `PARSE_ERROR` | Body encoding issue | Email marked `ERROR`, manually inspect |

**Not an error** — `SUBJECT_NOT_TRACKED` (sender matched, subject did not match any whitelist pattern) classifies as `DROPPED`, not `ERROR`. See §3 Step 2 rationale. The row is persisted so UI can surface "untracked subjects per platform" for Managers to decide whether a new pattern is warranted.

**"Errors" view trong UI Email Rules**: liệt kê email có `classification_status='ERROR'` với reason. Post-fix (2026-04-22): the view now shows only true processing failures (`REGEX_TIMEOUT`, `PARSE_ERROR`, `NO_RULES`) — subject-whitelist misses no longer appear here (they live under DROPPED with `reason=SUBJECT_NOT_TRACKED`). Actions: (1) Retry sau khi fix rule; (2) Manual assign ticket; (3) Ignore (đổi status sang `DROPPED`).

**Retry endpoint**:
```
POST /api/email-messages/{id}/retry
→ Reload rules, re-classify, update row, apply Gmail label
```

---

## 9. Performance

### 9.1. Complexity analysis

Với kích thước rule ước tính:
- ~4 platforms
- ~5 senders (avg 1-2/platform)
- ~12 subject patterns (3/platform)
- ~15 types (3-4/platform)
- ~50 apps × ~4 aliases = 200 aliases

| Step | Complexity | Thời gian ước tính |
|---|---|---|
| Sender match | O(1) — Map lookup | <0.1ms |
| Subject match | O(patterns) × O(regex) | 5-50ms |
| App lookup | O(text-aliases) + O(regex-aliases) × regex | 5-20ms |
| Type detect | O(types) × (O(includes) + O(regex)) | 10-50ms |
| Submission_id | O(patterns) × O(regex) | 5-20ms |
| **Total avg** | | **~50ms** |
| **Total worst** | | **~200ms** |

Batch 50 email = 2.5s avg, 10s worst. Dư thừa trong 60s cron budget.

### 9.2. Optimizations (nếu cần)

**Nếu volume tăng đáng kể**:
1. **Pre-compiled regex cache** (đã có trong `re2.ts`)
2. **Text alias map** cho exact match O(1) thay vì linear scan
3. **Body size cap** 100KB (đã có)
4. **Parallel classify** trong batch: `Promise.all` nếu backend DB handle được concurrent
5. **Memoize** kết quả theo `(sender, subject hash)` nếu có email trùng (hiếm, unlikely useful)

Tất cả là optimization, không cần cho MVP.

---

## 10. Code structure

```
lib/
├── classifier/
│   ├── index.ts                     export classify()
│   ├── sender-matcher.ts            matchSender()
│   ├── subject-matcher.ts           matchSubject()
│   ├── app-lookup.ts                lookupApp()
│   ├── type-detector.ts             detectTypeAndPayload()
│   ├── submission-id-extractor.ts   extractSubmissionId()
│   ├── rules-cache.ts               loadRules(), invalidateRulesCache()
│   ├── validate.ts                  validateRegex(), validateRule()
│   ├── types.ts                     ClassificationResult, MatchedRule, etc.
│   └── errors.ts                    InvalidRegexError, RegexTimeoutError
├── regex/
│   └── re2.ts                       re2Exec, re2Test, re2Validate, wrappers
├── rules/
│   ├── save.ts                      saveRulesForPlatform()
│   ├── rollback.ts                  rollbackToVersion()
│   └── snapshot.ts                  buildConfigSnapshot()

app/
├── api/
│   └── rules/
│       ├── test/route.ts            POST: test classify
│       ├── versions/route.ts        GET: list versions
│       ├── senders/route.ts         CRUD senders
│       ├── subject-patterns/route.ts
│       ├── types/route.ts
│       └── submission-id-patterns/route.ts
```

---

## 11. Testing strategy

### 11.1. Unit tests cho pure function

```typescript
// classifier.test.ts
describe('classify()', () => {
  const fixtures = loadFixtures();

  test('Apple APPROVED email with App type', () => {
    const email = fixtures.appleApprovedApp;
    const result = classify(email, fixtures.rules);
    expect(result.status).toBe('CLASSIFIED');
    expect(result.outcome).toBe('APPROVED');
    expect(result.type_payload).toEqual({ version: '2.4.1', os: 'iOS' });
  });

  test('Email from unknown sender → DROPPED', () => {
    const email = { ...fixtures.base, senderEmail: 'random@nowhere.com' };
    const result = classify(email, fixtures.rules);
    expect(result.status).toBe('DROPPED');
  });

  test('Apple email with unknown app → UNCLASSIFIED_APP', () => {
    const email = fixtures.appleWithUnknownApp;
    const result = classify(email, fixtures.rules);
    expect(result.status).toBe('UNCLASSIFIED_APP');
    expect(result.extracted_app_name).toBe('Unknown Game');
  });

  test('App matched but no type keyword → UNCLASSIFIED_TYPE', () => {
    const email = fixtures.appleWithoutTypeKeywords;
    const result = classify(email, fixtures.rules);
    expect(result.status).toBe('UNCLASSIFIED_TYPE');
  });

  test('In-App Event with payload', () => {
    const email = fixtures.appleInAppEvent;
    const result = classify(email, fixtures.rules);
    expect(result.type_payload).toEqual({
      event_name: 'WR Patch 6B',
      event_id: '6761699122',
    });
  });

  test('ReDoS protection: pathological input does not freeze', async () => {
    const email = { ...fixtures.base, bodyText: 'a'.repeat(10000) + 'X' };
    const start = Date.now();
    classify(email, fixtures.rules);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('matched_rules trace structure', () => {
    const result = classify(fixtures.appleApprovedApp, fixtures.rules);
    expect(result.matched_rules).toHaveLength(5); // sender, subject, app, type, submission_id
    expect(result.matched_rules[0].step).toBe('sender');
  });
});
```

### 11.2. Property tests

Dùng `fast-check`:

```typescript
test('classify is deterministic', () => {
  fc.assert(
    fc.property(arbitraryEmail(), arbitraryRules(), (email, rules) => {
      const a = classify(email, rules);
      const b = classify(email, rules);
      expect(a).toEqual(b);
    })
  );
});

test('sender not in map → always DROPPED', () => {
  fc.assert(
    fc.property(fc.emailAddress(), arbitraryRules(), (email, rules) => {
      fc.pre(!rules.senderToPlatform.has(email.toLowerCase()));
      const result = classify({ ...baseEmail, senderEmail: email }, rules);
      expect(result.status).toBe('DROPPED');
    })
  );
});
```

### 11.3. Integration tests

Load real Apple email samples (anonymized) + default Apple rules từ seed. Verify full pipeline.

```
test/fixtures/emails/
├── apple-approved-app.eml
├── apple-rejected-app.eml
├── apple-approved-iae.eml
├── apple-approved-cpp.eml
├── apple-in-review.eml
├── apple-unknown-app.eml
└── google-approved.eml  (khi Google rules ready)
```

---

## 12. Schema update needed

Add `'DROPPED'` vào `email_messages.classification_status` CHECK constraint:

```sql
-- Migration: 20260102000000_add_dropped_status.sql
ALTER TABLE email_messages DROP CONSTRAINT email_messages_classification_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_classification_status_check 
  CHECK (classification_status IN (
    'PENDING', 
    'CLASSIFIED', 
    'UNCLASSIFIED_APP', 
    'UNCLASSIFIED_TYPE', 
    'DROPPED',                      -- NEW: sender không match platform
    'ERROR'
  ));
```

**Nhưng**: có chính sách **không INSERT row cho DROPPED** không? Hai lựa chọn:

- **(A) Vẫn INSERT với status=DROPPED**: dedup qua UNIQUE gmail_msg_id hoạt động, không re-fetch khi fallback. Cost: ~5% noise rows trong DB.
- **(B) Không INSERT**: DB sạch. Cost: fallback sync re-fetch cùng email.

**Recommend (A)**: simpler, consistent. Volume noise thấp (~100/tháng với shared mailbox dedicated submissions). Cleanup job dọn được sau retention.

Schema đã support (A) qua ALTER trên.

---

## 13. Open questions

1. **Multi-Type matching**: nếu email match nhiều Type (vd body có cả "App Version" và "In-App Events"), theo PM quyết định: tạo ticket riêng cho mỗi Type. Handle ở caller hay classifier trả `ClassifiedResult[]` array? **Recommend**: classifier trả array, caller iterate. Cần thêm test case.

2. **Sender matching: primary vs fallback senders**: có scenario 1 platform có nhiều sender email? Vd Apple `no-reply@apple.com` cho status, `developer-relations@apple.com` cho policy. Đã có field `is_primary` nhưng chưa logic. Cần distinguish trong classify? Hay tất cả đều equal?

3. **Capture group name convention**: hiện dùng `(?P<app_name>...)` trong seed. Python/Go syntax. JavaScript regex dùng `(?<app_name>...)`. RE2 support cả hai. Doc/UI hint nào cho Manager biết syntax?

4. **Email body HTML → text conversion**: nếu email chỉ có `text/html` (no plain text), Gmail Sync parser strip tags. Stripped text có thể không match body_keyword chính xác (whitespace lose). Cần HTML-aware extract? **Recommend**: defer, hầu hết platform email đều có text/plain.

5. **Rule test with real Gmail message ID**: thêm endpoint `POST /api/rules/test?gmail_msg_id=xxx` để test rule ngay trên email thực trong inbox (không cần paste subject/body)? **Recommend**: có, UX tốt hơn nhiều cho Manager debug.

---

## 14. Ticket wiring (PR-8)

Classifier output is a **pure value** — zero side effects, zero DB writes. The wire layer (PR-8, `lib/store-submissions/tickets/wire.ts`) is what bridges the classifier verdict into the `tickets` table. This section documents the bridge so a future reader can trace a single email from Gmail → `email_messages` row → ticket link.

### 14.1 Gate: which classifications produce a ticket?

Source of truth: `isTicketableClassification()` in `lib/store-submissions/tickets/types.ts`. Returns `true` for:

| Status | Produces ticket? | Grouping key |
|---|---|---|
| `CLASSIFIED` | ✅ | `(app_id, type_id, platform_id)` |
| `UNCLASSIFIED_APP` | ✅ | `(NULL, NULL, platform_id)` — platform bucket |
| `UNCLASSIFIED_TYPE` | ✅ | `(app_id, NULL, platform_id)` — app bucket |
| `DROPPED` | ❌ | — |
| `ERROR` | ❌ | — |

Unclassified buckets receive tickets **by design** (CLAUDE.md invariant #8). Without them, emails that matched a sender + subject but failed app/type resolution would have no Inbox surface — Managers would miss the operational cue to add rules or merge apps. DROPPED + ERROR stay ticket-less because they are terminal: DROPPED (`NO_SENDER_MATCH` / `SUBJECT_NOT_TRACKED`) = intentional ignore, ERROR = audit-only, recoverable by operator.

### 14.2 Call path

```
gmail/sync.ts :: processMessage()
  ├─ parse
  ├─ resolve sender → platform (early-return DROPPED/ERROR skip wire)
  ├─ classify()  ← pure function, no I/O
  ├─ insertEmailMessageRow()  ← returns { id } | null
  │                              null on UNIQUE(gmail_msg_id) race → skip wire
  └─ if (inserted && isTicketableClassification(c)):
       try:
         associateEmailWithTicket(inserted.id, c)
           ├─ defensive re-gate (source of truth: isTicketableClassification)
           ├─ findOrCreateTicket(...)  ← PR-8 stub / PR-9 real engine
           └─ UPDATE email_messages SET ticket_id = ? WHERE id = ?
       catch:
         log "[sync] ... wire contract violation" — swallow (see 14.4)
```

### 14.3 Graceful degradation

Wire **never rethrows** by contract. Every failure path inside `associateEmailWithTicket`:

1. Engine throws (`TicketEngineNotApplicableError` or unexpected) → log `[tickets-wire] findOrCreateTicket failed` at ERROR level → return `null`.
2. `UPDATE email_messages.ticket_id` fails → log `[tickets-wire] UPDATE ... failed — ticket exists but link lost` at ERROR level → return `null`.

A `null` return means the email row is persisted but `ticket_id` stays NULL. Recovery: PR-9+ Manager-initiated re-association, or the next email for the same grouping key picks up the orphan implicitly when PR-9's `findOrCreateTicket` looks for existing open tickets.

Log prefix `[tickets-wire]` is intentional — enables Sentry filtering once `SENTRY_DSN` wiring lands (tracked in `TODO.md` under PR-7).

### 14.4 Cursor wedge prevention (defensive try/catch in sync.ts)

Wire's "never throw" contract is enforced by wire itself, but sync.ts wraps the call in its own try/catch **as defense-in-depth**. Why this matters:

Without the wrap, a contract violation (future regression, unexpected exception type) would cascade to the batch loop's outer try/catch, which bumps `stats.errors`. That has a pathological consequence:

```
wire throws → stats.errors++ → advanceSyncState blocked
  → cursor stays put → next tick refetches same Gmail IDs
  → dedup via emailAlreadyPersisted → skip processMessage entirely
  → wire never re-runs → ticket_id permanently NULL
```

The email row is persisted but orphaned **forever** — the cursor is wedged and dedup guarantees no retry. The inner try/catch in sync.ts swallows the throw, logs `[sync] associateEmailWithTicket threw — wire contract violation`, and lets the cursor advance. The orphan is still recoverable via Manager action; the cursor is not.

### 14.5 PR-8 stub vs PR-9 real engine

PR-8 ships `lib/store-submissions/tickets/engine-stub.ts` — `findOrCreateTicket()` returns `{ ticketId: randomUUID(), created: true, new_state: 'NEW' }` with no DB writes and no dedup. Purpose:

- Verify the wire path end-to-end without blocking on the real engine's complexity (FOR UPDATE lock, submission_id dedup, state machine, `ticket_entries` snapshots).
- Unblock PR-10 Inbox UI development against mock ticket data before PR-9 ships.
- Isolate wire-path bugs from engine-logic bugs by PR.

PR-9 drops in `engine.ts` behind the **same `findOrCreateTicket(input): FindOrCreateTicketOutput` signature** (`types.ts` documents the stability contract — field extensions allowed, removals/renames break the API). The wire and sync.ts layers do not change when the real engine lands.

See `04-ticket-engine.md §0` for PR-9 implementation scope.

---

## Kết luận

Email Rule Engine là **pure function boundary** — tách biệt logic "hiểu email" khỏi orchestration Gmail + ticket. Critical design points:

- **RE2 là hard requirement** cho user-provided regex (ReDoS prevention)
- **6 steps pipeline** với trace đầy đủ cho debugging
- **4 distinct outcomes** (DROPPED / UNCLASSIFIED_APP / UNCLASSIFIED_TYPE / CLASSIFIED / ERROR) map rõ sang ticket flow
- **Rule versioning với snapshot** cho rollback an toàn
- **Test mode endpoint** cho Manager verify rule trước khi save

**Next up**: Section 4 — Ticket Engine. Transactional find-or-create, state machine implementation, event log, invariant enforcement.
