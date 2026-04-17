# Settings — ASC Accounts (Supabase CRUD)

> Status: ✅ Implemented (v2 — 2026-04-07)
>
> v1 (2026-03-20): env var builder — generate `ASC_ACCOUNTS` string → copy-paste vào `.env`
> v2 (2026-04-07): full CRUD lưu trong Supabase, private key mã hóa AES-256-GCM

---

## Tóm tắt v2

Admin-only Settings page với full CRUD để quản lý ASC accounts trực tiếp trên UI. Accounts lưu trong Supabase `asc_accounts` table, private key mã hóa AES-256-GCM với `ENCRYPTION_KEY` env var.

---

## Architecture

### Luồng dữ liệu

```
Admin UI (SettingsPage.tsx — Client Component)
    ↓ fetch /api/admin/asc-accounts (+ [id])
Next.js API Routes — check session.user.role === "admin"
    ↓
lib/asc-account-repository.ts
    ↓ encrypt/decrypt via lib/asc-crypto.ts
Supabase asc_accounts table (service_role key)
```

### Fallback logic (trong repository)

```
useSupabase() = SUPABASE_URL + SERVICE_ROLE_KEY + ENCRYPTION_KEY đều set
    ↓ true
Đọc từ Supabase — nếu rỗng, fallback về ASC_ACCOUNTS env var
    ↓ false
Đọc trực tiếp từ ASC_ACCOUNTS env var (backward compat)
```

---

## Files

| File | Mô tả |
|---|---|
| `lib/asc-crypto.ts` | AES-256-GCM encrypt/decrypt. Format: `base64(iv[16] + authTag[16] + ciphertext[N])` |
| `lib/asc-account-repository.ts` | CRUD abstraction + 5-min in-memory cache. `invalidateAccountCache()` sau mỗi write. |
| `app/api/admin/asc-accounts/route.ts` | GET (list public) + POST (create). Guard: `role !== "admin"` → 403 |
| `app/api/admin/asc-accounts/[id]/route.ts` | PATCH (update) + DELETE. Guard: `role !== "admin"` → 403 |
| `components/settings/SettingsPage.tsx` | Full CRUD UI. Merged từ `AscAccountsManager` (trang admin riêng đã xóa) |
| `supabase/migrations/20260407000000_create_asc_accounts.sql` | Table DDL, RLS enabled, no row policies |

**DELETED:**
- `app/(dashboard)/admin/asc-accounts/page.tsx`
- `components/admin/AscAccountsManager.tsx`

---

## Supabase table `asc_accounts`

```sql
CREATE TABLE asc_accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  issuer_id   TEXT NOT NULL,
  private_key TEXT NOT NULL,  -- AES-256-GCM encrypted base64
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
-- RLS enabled, NO row-level policies → chỉ service_role key có quyền
```

---

## Encryption (`lib/asc-crypto.ts`)

- Algorithm: AES-256-GCM (authenticated encryption)
- Key source: `ENCRYPTION_KEY` env var — 64-char hex (32 bytes)
- Packed format: `base64(randomIV[16] + authTag[16] + ciphertext[N])`
- Attacker cần CÙNG LÚC: `ENCRYPTION_KEY` env var + Supabase service_role key → mới decrypt được

Generate key:
```bash
openssl rand -hex 32
```

---

## `lib/asc-account-repository.ts`

```typescript
// Exports
findAllAccounts(): Promise<AscAccount[]>        // decrypted, server-only
findAllAccountsPublic(): Promise<AscAccountPublic[]>  // masked, safe cho client
findAccountById(id): Promise<AscAccount | null>
findDefaultAccount(): Promise<AscAccount | null>
createAccount(data): Promise<AscAccountPublic>
updateAccount(id, data): Promise<AscAccountPublic>
deleteAccount(id): Promise<void>
invalidateAccountCache(): void

// Types
interface AscAccount { id, name, keyId, issuerId, privateKey, isActive }
interface AscAccountPublic { id, name, keyId, issuerId, isActive }  // no privateKey
```

---

## UI (SettingsPage.tsx)

- List accounts: name, keyId (masked), issuerId (masked), active badge
- Add form: name, keyId (10-char A-Z0-9), issuerId (UUID format), privateKey (textarea + .p8 file upload)
- Edit form: same fields (privateKey optional — để trống = giữ nguyên)
- Delete: confirm dialog, disable nếu account đang active
- Validation: keyId 10-char `[A-Z0-9]`, issuerId UUID regex, privateKey phải chứa `-----BEGIN PRIVATE KEY-----`

---

## Env vars

```env
ENCRYPTION_KEY=<64-char hex>      # bắt buộc để dùng Supabase storage
SUPABASE_SERVICE_ROLE_KEY=...     # bắt buộc
NEXT_PUBLIC_SUPABASE_URL=...      # bắt buộc

# Fallback (optional, backward compat):
ASC_ACCOUNTS=[{...}]
```

---

## Security

- Private key không bao giờ trả về qua API (chỉ `AscAccountPublic` — không có `privateKey`)
- PATCH update: nếu `privateKey` field trống → giữ encrypted value cũ trong DB
- `/api/admin/asc-accounts` require `session.user.role === "admin"` → 403 otherwise
- Supabase RLS enabled, không có policies → anon/authenticated client không có quyền
- Service_role key chỉ dùng server-side (`lib/asc-account-repository.ts`)

---

## Decision Log

| Quyết định | Alternatives | Lý do chọn |
|---|---|---|
| Supabase lưu accounts | File-based, env-only | Không cần restart server khi thêm account; phù hợp Railway (ephemeral FS) |
| AES-256-GCM | bcrypt, asymmetric | Symmetric — cần decrypt để dùng; GCM có auth tag chống tamper |
| Single base64 column (iv+authTag+ciphertext) | 3 columns riêng | Đơn giản hơn, atomically consistent |
| Merge AscAccountsManager vào SettingsPage | Trang admin riêng | Giảm số trang, Settings đã admin-only rồi |
| 5-min in-memory cache | No cache, Redis | Tránh Supabase round-trip mỗi request; invalidate sau mỗi write |
