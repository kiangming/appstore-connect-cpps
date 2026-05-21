# Google IAP Management — Google API Reference

This is the developer-facing reference for the two Google APIs the Google
IAP Management module talks to, plus the quirks the v1 codebase had to
work around. It is **not** a Manager-facing operational guide — see
`operational-guide.md` for that.

---

## 1. Dual-API architecture

| API | Role | Scope |
|---|---|---|
| **Google Play Android Publisher API v3** | Read + write IAPs (and apps' metadata) | `https://www.googleapis.com/auth/androidpublisher` |
| **Google Play Developer Reporting API v1beta1** | List apps reachable by the Service Account | `https://www.googleapis.com/auth/playdeveloperreporting` |

The Reporting API exists because the Publisher API has no first-class
"list all apps under this developer" endpoint — only per-package
operations. Reporting fills that gap via `apps:search`.

Both APIs accept the same Service Account JWT credential (uploaded
under Settings → Google Console Accounts). The Settings UI's Verify
button explicitly hits **both** scopes; a Service Account that only has
Publisher access will pass IAP operations but fail Reporting (and
therefore fail to populate the Apps list).

The googleapis SDK manages OAuth token minting + caching per JWT
instance, so we don't hand-roll the JWT signing (a notable departure
from Apple IAP, which we built manually with `jose`).

---

## 2. Authentication

```ts
// lib/google-iap-management/google/auth.ts
import { JWT } from "google-auth-library";

export function jwtClientFromEncrypted(encryptedCredentialsJson: string): JWT {
  const decrypted = decryptCredentials(encryptedCredentialsJson);
  return new JWT({
    email: decrypted.client_email,
    key: decrypted.private_key,
    scopes: [
      "https://www.googleapis.com/auth/androidpublisher",
      "https://www.googleapis.com/auth/playdeveloperreporting",
    ],
  });
}
```

Credentials are stored AES-256-GCM-encrypted in
`google_iap_mgmt.google_console_accounts.encrypted_credentials` (TEXT
column). The encryption key is `GOOGLE_CREDENTIALS_ENCRYPTION_KEY` —
**never rotate this in production** (rotating breaks every stored
credential and forces a re-upload of every Service Account JSON).

---

## 3. Publisher API endpoints used

| Method | Endpoint | Caller |
|---|---|---|
| GET | `/inappproducts` | Apps detail page → IAPs list refresh |
| GET | `/inappproducts/{sku}` | (reserved for future detail-view refresh) |
| POST | `/inappproducts` | Create IAP orchestrator |
| PATCH | `/inappproducts/{sku}` | Edit IAP orchestrator |
| DELETE | `/inappproducts/{sku}` | (reserved for future delete UI) |
| POST | `/inappproducts:batchUpdate` | Bulk Import orchestrator |
| POST | `/monetization/convertRegionPrices` | (reserved — preview-only equalisation) |

All calls live in `lib/google-iap-management/google/publisher-client.ts`.
Every call is wrapped by `timed()` which logs `method · packageName ·
sku · outcome · durationMs · status` on completion. **Error bodies are
truncated to the first 200 characters** — Google's error responses
occasionally echo private-key fragments back when scope mismatches
occur, so we never log the full body.

### batchUpdate semantics

```ts
type InappproductsBatchUpdateRequest = {
  requests: InappproductsUpdateRequest[]; // up to 100
};

type InappproductsUpdateRequest = {
  packageName: string;
  sku: string;
  allowMissing?: boolean;         // when true: insert if SKU absent
  autoConvertMissingPrices?: boolean;
  inappproduct: InAppProduct;
  latencyTolerance?: string;
};
```

Insert + update are unified via `allowMissing: true`. The response
shape is `{ inappproducts: InAppProduct[] }`, one entry per request in
the **same order** — there is no per-row error array. If a row fails
the whole batch throws and the orchestrator marks every actionable row
as failed. The 100-row cap is enforced server-side; the wizard's
preview step shows the count.

---

## 4. Reporting API endpoints used

| Method | Endpoint | Caller |
|---|---|---|
| GET | `/v1beta1/apps:search` | Apps refresh handler |

Cursor pagination via `pageToken` — we follow the chain until
`nextPageToken` is empty. Each page yields up to 50 `{ packageName,
displayName }` rows that are UPSERTed in batch.

---

## 5. priceMicros — the serialisation quirk

Google's wire format for in-app product prices is **a string of digits
representing one-millionth-of-currency units**. Examples:

| Display | priceMicros |
|---|---|
| `$1.99` | `"1990000"` |
| `$0.99` | `"990000"` |
| `$10` | `"10000000"` |
| `1 micro` | `"1"` |

A Number-based conversion drifts: `0.99 * 1_000_000 === 989_999.9999…`
on JavaScript floats. We therefore use **string + BigInt arithmetic**
in `lib/google-iap-management/google/price-conversion.ts`:

```ts
decimalToMicros("1.99")  // "1990000"  ← exact
microsToDecimal("1990000", 2)  // "1.99"  ← exact
```

The Manager UI takes decimal input; conversion happens **only** at the
API boundary (orchestrators), never client-side. Storage uses Google's
wire format (TEXT) so `default_price_micros` and
`pricing_template_entries.price_micros` are both digits-only strings.

---

## 6. Locale codes

The Publisher API expects BCP-47 locale codes (`en-US`, `fr-FR`,
`zh-CN`, …). The Manager template's IAP file uses human-readable
display names (`English (United States)`, `French (France)`). The
mapping lives in `lib/google-iap-management/parsers/excel-parser.ts`
under `LOCALE_NAME_TO_BCP47` and covers the 82 locale names observed in
the v1 template. Unrecognised display names surface as warnings; they
are not fatal.

Google's locale codes have a few legacy aliases we honour:

| BCP-47 modern | Google's variant |
|---|---|
| `he-IL` | `iw-IL` (preserved) |
| `id` | `id` (Indonesian, no region) |
| `fil` | `fil` (Filipino, no region) |

---

## 7. The InAppProduct enum mapping (managed vs subscription)

Google's wire enum:

- `purchaseType = "managedUser"` — one-time managed product. The
  Manager UI distinguishes `managed` (non-consumable) from `consumable`
  by **client-acknowledgment behaviour**, not by API field — both
  serialize as `managedUser`. The DB schema permits all three values
  (`managed | consumable | subscription`) but v1 only writes the first
  two.
- `purchaseType = "subscription"` — Q-GIAP.A defers this to v2 since
  subscriptions live under the `monetization.subscriptions` resource
  with a different lifecycle.

---

## 8. Status enum

| Manager wire value | Google wire value | Effect |
|---|---|---|
| `active` | `active` | Visible to users |
| `inactive` | `inactive` | Hidden from store |

There is **no draft state** for IAPs (unlike Apple CPPs). Going
`active → inactive` immediately hides the product; flipping back to
`active` re-exposes it.

---

## 9. Pricing template resolution order (Q-GIAP.D)

When a Manager picks a pricing source on the Create / Edit / Bulk
Import form, the server resolves prices in this order:

1. If `app_template` is selected and an App template exists for this
   app: use its tier entries.
2. Else if `default_template` is selected and a Default template
   exists: use its tier entries.
3. Else (`google_default`): use the row's inline base price + region
   overrides + Google's auto-equalisation for unset regions.

For the single-IAP forms, the tier identifier is chosen via dropdown.
For Bulk Import, **each row's SKU is matched against the template's
`identifier` column**; rows without a match silently fall back to
inline pricing (no warning shown — this is the documented contract).

---

## 10. Observability

Every Publisher / Reporting call is logged via
`lib/google-iap-management/google/logging.ts` with shape:

```
[google-iap:publisher] method=inappproducts.batchUpdate package=com.example.app sku= outcome=ok duration_ms=412 status=200
```

Audit-log writes go to `google_iap_mgmt.actions_log` (append-only) for:

- `ACCOUNT_CREATE`, `ACCOUNT_VERIFY`, `ACCOUNT_DELETE`
- `APPS_SYNC`, `IAPS_LIST_SYNC`
- `IAP_CREATE`, `IAP_UPDATE`, `IAP_DELETE`
- `BULK_IMPORT_BATCH`
- `PRICING_TEMPLATE_UPLOAD`

The full diff is recorded in `IAP_UPDATE` payloads (attributes +
listings + prices buckets, plus summary counts).

---

## 11. Known v1 constraints

- **Subscriptions deferred** — Q-GIAP.A. Schema permits the value but
  no API call paths populate it.
- **batchUpdate 100-row cap** — orchestrator surfaces an error; wizard
  preview shows the count so the Manager can split files manually.
- **Per-row failures inside batchUpdate** — Google doesn't return a
  structured per-row error array. A failed batch fails the whole
  import; orchestrator marks all actionable rows as failed.
- **`GOOGLE_CREDENTIALS_ENCRYPTION_KEY`** — never rotate in production.
- **Locale name → BCP-47** coverage is the 82 names in the v1 IAP
  template. Add to `LOCALE_NAME_TO_BCP47` when Manager introduces a new
  one.
