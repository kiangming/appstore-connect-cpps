# Google IAP Management — Cycle 35 Session Arc

A chronological snapshot of how the Google IAP Management module was
shipped end-to-end, with architectural decisions and Q-GIAP locks
captured at each step. Treat this as the developer onboarding
narrative — `google-api-reference.md` is the technical reference,
`operational-guide.md` is the Manager workflow.

---

## Phase 2 — Discovery + Mockup

**Output:**

- 10-question Q-GIAP lock sheet (A..J), Manager-confirmed.
- `docs/google-iap-management/design/google-iap-mockup.html`.
- `docs/google-iap-management/api/google-android-publisher-v3-discovery.json`.

**Key Q-GIAP locks established:**

| Lock | Decision |
|---|---|
| A | v1 covers managed products only; subscriptions deferred to v2. |
| B | Service-account JSON stored AES-256-GCM encrypted in DB. |
| C | Apps list via Reporting `apps:search` GET (cursor pagination). |
| D | Template parser format deferred — schema accepts identifier TEXT so SKU-mode AND tier-mode templates both round-trip. |
| E | Bulk import = single `batchUpdate` call with `allowMissing: true`; no per-row decision table — counters live in `import_batches`. |
| F | Decimal manager input → server-side `decimalToMicros` conversion → stored as TEXT (matches Google's wire format). |
| G | Multi-region pricing v1 — sparse per-region overrides. |
| H | Route-based context resolver (no schema-level enforcement) — `/google-iap-management/*` layout selects google_console_accounts. |
| I | Create defaults to `status='active'`. |
| J | Multi-locale full v1 — listings keyed (iap_id, locale). |

---

## Phase 3 Session 1 — g1.a..g (foundation)

Cohesive 7-commit arc, all gauntlets clean.

| Chunk | Commit | Scope |
|---|---|---|
| g1.a | 27c9cfc | DB schema (9 tables under `google_iap_mgmt.*`), RLS-disabled + explicit GRANTs (avoiding IAP.c's blunder). Phase 2 artefacts checked in. |
| g1.b | 55b8c0a | Google API client (Publisher + Reporting wrappers), JWT auth via googleapis SDK, decimal ↔ micros conversion (BigInt-based, no float drift). |
| g1.c | 8eb4e20 | Settings UI for Google Console accounts (upload + verify + delete). Verify exercises BOTH scopes — passes Publisher, fails Reporting if role missing. |
| g1.d | 7ffb38e | Module routing + nav entry points (hub card + sidebar). |
| g1.e | f92fcd2 | Apps list page + Reporting `apps:search` sync. |
| g1.f | b53bc35 | App detail page + IAPs list refresh via Publisher `inappproducts.list`. |
| g1.g | 35df742 | Create IAP form orchestration — multi-locale listings, multi-region pricing, single API POST. |

**Architectural decisions Session 1:**

- googleapis SDK for auth (not hand-rolled JWT) — pays off vs Apple
  IAP's manual JWT pain.
- RLS disabled + explicit GRANTs baked into the init migration — the
  IAP.c lesson (RLS-on without policies = 500s) is in the migration
  header comment.
- TopNav layout positioning — account switcher self-fetches the API
  to avoid prop drilling.
- Verify endpoint hits Reporting scope only (Publisher is implicit
  because the scopes share an OAuth path).

Tests: 1815 → 1854 (+39).

---

## Phase 3 Session 2 — g1.h..l (today, 2026-05-21)

| Chunk | Commit | Scope | Tests |
|---|---|---|---|
| g1.h | 5038c83 | Edit IAP form + diff preview modal. | +7 |
| g1.i | b762211 | Bulk import wizard with `batchUpdate`. Template parser. | +10 |
| g1.j | 6ce6e72 | Pricing templates schema + 3-tab UI (Default + Per-App + Reference). | +7 |
| g1.k | 7f675e0 | Pricing source integration across Create / Edit / Bulk. | +3 |
| g1.l | (this) | Docs + (planned) integration tests. | (this) |

### g1.h — Edit IAP form + diff modal

- New `iap-diff` pure utility: symmetric snapshot comparison
  (Attributes / Listings / Prices buckets, added · modified ·
  removed). Importable from both client preview modal and server audit
  log payload.
- `update-iap` orchestrator: builds full target body (Publisher v3
  map-field semantics don't model sparse delete cleanly), calls
  `inappproducts.patch`, syncs cache, audit-logs `IAP_UPDATE` with the
  full diff.
- `form-state.ts` pure helper for cache → form-initial conversion —
  lives outside the IapForm "use client" boundary so server pages can
  call it without crossing the wire.
- SKU is immutable in edit mode (Google Play doesn't allow renaming).
- Currency casing is normalised in the diff (`usd` vs `USD` is not a
  change).

### g1.i — Bulk import wizard

- Manager delivered the IAP template format on 2026-05-21 — Q-GIAP.D
  resolved. Template files committed to
  `docs/google-iap-management/templates/`.
- 4-step wizard: Pricing source → Upload → Preview (per-row
  Overwrite/Skip for existing SKUs) → Execute.
- Single `batchUpdate` call with `allowMissing: true` so new + existing
  SKUs land in one round-trip.
- Parser tolerance: unknown locale columns warn rather than fail;
  unmapped GT currencies drop the override with a warning; mismatched
  GT Price/Currency pairs ditto.
- Locale name → BCP-47 table covers the 82 names in the v1 template.

### g1.j — Pricing templates

- Two formats in `pricing_template_entries`: identifier can be either
  SKU (SKU-keyed templates) or tier label (`Tier 1`, …). The v1
  Manager template is tier-keyed.
- Pricing template parser handles sheet `price_tiers`, header column
  format `CC - CUR - Country Name`; sparse cells permitted; decimal →
  micros at parse time.
- 3-tab UI: Google Default Reference (informational), Default Template
  (one row global), Per-App Templates (one row per app).
- Replace-on-upload is enforced by partial unique indexes
  (`idx_..._global_unique` + `idx_..._app_unique`).

### g1.k — Pricing source integration

- Reusable `PricingSourceSelector` component used by Create form, Edit
  form, and Bulk Import Step 1.
- GET `/api/.../pricing-templates/availability` returns
  `{ defaultExists, appExists, defaultTiers, appTiers }` so the
  selector can grey out unavailable sources and populate the tier
  dropdown (single-IAP form only — Bulk Import does SKU-keyed lookup
  server-side).
- Tier resolution server-side at submit: template entries replace
  inline overrides before forwarding to the orchestrator. Bulk Import
  matches per-row SKU against the template's identifier column;
  unmatched rows fall back to inline pricing without warning (the
  documented contract).

---

## Trajectory milestone

Session 2 closes the **6-deliverable strategic trajectory**:

1. Phase E (Apple IAP) ✅
2. ForwardDedup ✅
3. IAP Management MVP ✅
4. IAP Pricing Templates ✅
5. IAP View Detail UI ✅
6. **Google IAP Management** ✅ ← Cycle 35

---

## Manager MV35 v11 — post-Session-2 test scenarios

The Manager will exercise these end-to-end after Session 2 ships:

1. Edit IAP single — change SKU title → diff modal → confirm → verify on Google Play.
2. Edit IAP status — active → inactive → verify on Google Play.
3. Edit IAP per-region pricing — add custom regions → diff → verify.
4. Bulk import 5 NEW IAPs — batch-level pricing source → execute → 5 created.
5. Bulk import 5 existing IAPs (Overwrite) — 5 updated.
6. Bulk import 5 existing IAPs (Skip) — 0 changes.
7. Bulk import mixed (3 NEW + 3 existing with mixed decisions) — verify per-row.
8. Default template upload → apply to Create IAP form (tier picker → submit).
9. Per-App template upload → apply for a specific app.
10. 3-source pricing radio gating per template availability state.

---

## Files map (Phase 3, both sessions)

```
app/(dashboard)/google-iap-management/
├── layout.tsx                              (Session 1 g1.d)
├── page.tsx                                (Session 1 g1.d, Session 2 g1.j tab added)
├── apps/
│   ├── page.tsx                            (g1.e)
│   └── [packageName]/
│       ├── page.tsx                        (g1.f)
│       ├── iaps/
│       │   ├── new/page.tsx                (g1.g)
│       │   └── [sku]/page.tsx              (g1.h)
│       └── bulk-import/page.tsx            (g1.i)
└── settings/
    ├── google-accounts/page.tsx            (g1.c)
    └── pricing-templates/page.tsx          (g1.j)

app/api/google-iap-management/
├── active-account/route.ts
├── google-accounts/
│   ├── route.ts
│   └── [id]/{route,verify}.ts
├── apps/
│   ├── refresh/route.ts
│   └── [packageName]/
│       ├── iaps/
│       │   ├── route.ts                    (POST create)
│       │   ├── refresh/route.ts
│       │   └── [sku]/route.ts              (PATCH update)
│       └── bulk-import/
│           ├── preview/route.ts
│           └── execute/route.ts
└── pricing-templates/
    ├── route.ts                            (POST upload)
    ├── [id]/route.ts                       (DELETE)
    └── availability/route.ts               (GET)

lib/google-iap-management/
├── db.ts                                   (Session 1)
├── crypto.ts                               (Session 1)
├── active-account.ts                       (Session 1)
├── regions.ts                              (Session 1)
├── form-state.ts                           (g1.h)
├── google/
│   ├── auth.ts
│   ├── publisher-client.ts
│   ├── reporting-client.ts
│   ├── price-conversion.ts
│   └── logging.ts
├── parsers/
│   ├── excel-parser.ts                     (g1.i — IAP template)
│   └── pricing-template-parser.ts          (g1.j — price tiers template)
├── orchestration/
│   ├── create-iap.ts                       (g1.g)
│   ├── update-iap.ts                       (g1.h)
│   ├── iap-diff.ts                         (g1.h, shared client+server)
│   └── bulk-import.ts                      (g1.i, extended in g1.k)
├── queries/
│   └── templates.ts                        (g1.j, extended in g1.k)
└── repository/
    ├── google-accounts.ts
    ├── apps.ts
    ├── iaps.ts
    └── actions-log.ts

components/google-iap-management/
├── layout/                                 (Session 1)
├── settings/                               (g1.c)
├── apps/                                   (g1.e)
├── iap-list/                               (g1.f, g1.i)
├── iap-form/
│   ├── GoogleLocaleSidebar.tsx             (g1.g)
│   ├── IapForm.tsx                         (g1.g, extended g1.h + g1.k)
│   ├── UpdateChangesPreviewModal.tsx       (g1.h)
│   ├── PricingSourceSelector.tsx           (g1.k)
│   └── PricingSourceSelector.test.tsx      (g1.k)
├── bulk-import/
│   ├── BulkImportWizard.tsx                (g1.i, refactored g1.k)
│   └── PreviewTable.tsx                    (g1.i)
└── pricing-templates/
    ├── PricingTemplatesClient.tsx          (g1.j)
    ├── GoogleDefaultReferenceTab.tsx       (g1.j)
    ├── DefaultTemplateTab.tsx              (g1.j)
    ├── PerAppTemplateTab.tsx               (g1.j)
    └── EntriesPreviewTable.tsx             (g1.j)

supabase/migrations/
└── 20260520010000_google_iap_mgmt_init.sql (g1.a — RLS-off + GRANTs)

docs/google-iap-management/
├── design/google-iap-mockup.html           (Phase 2)
├── api/google-android-publisher-v3-discovery.json
├── templates/
│   ├── template-item-iap-google.xlsx       (Manager-delivered 2026-05-21)
│   └── pricing-template-google.xlsx
├── google-api-reference.md                 (g1.l)
├── operational-guide.md                    (g1.l)
└── SESSION-ARC-2026-05-21-summary.md       (g1.l, this file)
```
