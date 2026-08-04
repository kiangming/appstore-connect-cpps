# Bulk Import "Download template" — Investigation & Design (Apple + Google)

**Status: IMPLEMENTED (August 2026).** Manager sign-off resolved the open
questions as: G.1 → FIXED `Price (USD)` header (verified safe: the parser
reads the header currency explicitly — `resolvePriceColumn` Pass 1 — so a
USD template against a non-USD app stays USD; the Notes sheet states the
unit unmissably); G.2 → Notes sheet ENGLISH only (matches tool UI); G.3 →
legacy artifacts kept as fallback-path fixtures (a Google real-file smoke
test was added — the asymmetry in F4 is closed); G.4/G.5 → user-docs
tables + KB §7.2 corrected in the same commit. Spec modules:
`lib/iap-management/parsers/template-spec.ts`,
`lib/google-iap-management/parsers/template-spec.ts`; shared generator:
`lib/xlsx-template.ts`. Sheet-selection hardening (§C) landed in both
parsers with a name-miss-aware error message, proven by a
mutation check (by-name selection neutered → notes-first round-trip
tests fail → restored → pass).

**Addendum (August 2026) — example rows + sample-ID skip guard.**
Manager decision REVERSED §B's headers-only data sheet: the data sheet
now ships PRE-FILLED with 3 example rows, genericized from the Manager's
source files (`apple-item-iap-test.xlsx`, updated
`template-item-iap-google.xlsx`) to Product IDs
`com.vngg.tool.product.sample01–03`. Because those IDs don't exist on
any store, an accidental import would have silently created them — so a
row-level skip guard landed in BOTH parsers: rows whose Product ID is in
`TEMPLATE_SAMPLE_PRODUCT_IDS` (single shared const in
`lib/xlsx-template.ts`, imported by the generators AND both parsers —
same anti-drift discipline as the header specs, pinned by a
shared-skip-list test) are skipped and surfaced as an explicit
`sample_rows_skipped` / `skippedSampleRows` outcome, never an error. A
delete-me note row (empty Product ID cell → invisible to the parsers)
sits under the samples in-sheet. GT Price/GT Currency deviate from the
source files' constant 23000 (verified: the pair is a base-territory/
region PRICE, not an exchange rate): the GOOGLE examples carry per-row
illustrative VND prices (Google posts the pair as the literal VN-region
price), while the APPLE examples leave the pair BLANK — Apple parses it
into `base_price`/`base_currency` but consumes it nowhere downstream
(pricing comes from Price (USD) → tier → price schedule), and the Apple
Notes sheet now states this "currently NOT applied" status explicitly;
filling an inert column would teach a wrong pattern.
The §B "headers-only" rationale is superseded by the skip guard, which
closes the same risk more directly.
**Scope: BOTH modules** (Apple IAP Management + Google IAP Management). The
Google module has a pointer stub at
`docs/google-iap-management/design-bulk-import-template-download.md`.

Task origin: the user guide (`docs/user-docs/index.html`) already *describes*
a "Tải template Excel" button in both bulk-import wizards. The button does not
exist in the tool. This is doc-vs-reality drift; the design below fixes the
gap without creating a new drift vector (a static template file would just
relocate the drift — see Finding F4 and Recommendation A).

Out of scope: the PRICING template (Tier × Territory matrix at Settings →
Pricing Tiers) — different artifact, different parsers
(`lib/iap-management/parsers/price-tiers.ts`,
`lib/google-iap-management/parsers/pricing-template-parser.ts`). See G.7.
Export behavior is not changed. Bulk-import validation/orchestration is not
changed except the sheet-selection hardening in section C.

---

## PART 1 — FINDINGS (investigation-first; every claim has file:line)

### F1. Sheet selection — BOTH parsers select by INDEX (case b: fragile)

| Module | Evidence | Verdict |
|---|---|---|
| Apple | `lib/iap-management/parsers/iap-items.ts:183` — `const sheetName = workbook.SheetNames[0]` | **By index.** |
| Google | `lib/google-iap-management/parsers/excel-parser.ts:415` — `const sheetName = wb.SheetNames[0]` | **By index.** |

Consequence for both: an instructions sheet placed *first* is parsed as data.
Failure mode is loud, not silent — the notes sheet won't contain the required
headers, so Apple throws `missing the required "Product ID" column`
(`iap-items.ts:210-217`) and Google errors `Required column "Product ID" not
found` (`excel-parser.ts:432-435`) — but the import is broken and sheet
*order* becomes load-bearing (a user reorder or an Excel re-save can flip it).
Hardening required before shipping a template with a notes sheet → section C.

Choke-point check (KB §9 twin-path rule): all call sites flow through the one
parser function per module, so the hardening lands in exactly one place each:

- Apple — client parse in the wizard:
  `app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx:628`,
  AND server re-parse on execute:
  `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:354`.
  Both call `parseIapItemsXlsx` — one function, two loci.
- Google — server parse only:
  `app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts:117`
  calls `parseIapTemplate`.

### F2. Column definitions — partially declarative in both; generation is feasible

**Apple (`lib/iap-management/parsers/iap-items.ts`)**

- Declarative: `REQUIRED_LEAD_HEADERS = ["Product ID", "Reference Name"]`
  (`iap-items.ts:55`) — but it only declares the 2 *required* columns.
- Semi-declarative: the 4 optional lead headers (`"Type"`, `"Price (USD)"`,
  `"GT Price"`, `"GT Currency"`) are inline string literals inside the
  `leadIdx` construction (`iap-items.ts:219-226`), not a single const array.
- Dynamic: locale pairs are discovered by regex
  `LOCALE_HEADER_RE = /^(Display Name|Description) \((.+)\)$/`
  (`iap-items.ts:63`) and mapped via `localeCodeFromName`
  (`iap-items.ts:272`) over **`lib/locale-map.json` — 39 entries** (verified
  by count).
- **Canonical full set: 6 lead + 39×2 locale = 84 columns.** The "84-column
  template" documentation claim is **verified**: KB file-map says "84-col XLSX
  parser (with Type column)"
  (`docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md:580`), and the real
  artifact has exactly 84 populated header cells (plus 73 trailing *empty*
  header cells — raw header-row length 157; empty cells are skipped silently
  at `iap-items.ts:250-254`, harmless).
- Stale note: the smoke-test header comment still says "83 columns (5 lead +
  39 locale pairs)" (`lib/iap-management/parsers/parsers.smoke.test.ts:8`) —
  pre-Hotfix-27 count, before Type. Minor comment drift.

**Google (`lib/google-iap-management/parsers/excel-parser.ts`)**

- Declarative: `FIXED_HEADERS = {"Product ID", "GT Price", "GT Currency"}`
  (`excel-parser.ts:199-203`).
- Flexible price column: `resolvePriceColumn` (`excel-parser.ts:232-270`)
  accepts `Price (XXX)` for any 3-letter code, or generic
  `Price` / `Default Price` / `Base Price` → app default currency
  (Hotfix 16).
- Declarative locale source: **`LOCALE_NAME_TO_BCP47` — exported, 82
  entries** (`excel-parser.ts:27-110`; count verified — includes `es-419`),
  matched via `Title (X)` / `Description (X)` regexes
  (`excel-parser.ts:311-312`).
- **Canonical emission set: 4 lead (Product ID, Price (XXX), GT Price,
  GT Currency) + 82×2 locale = 168 columns.**

**Verdict:** a generated template CANNOT drift from the parser if both consume
the same spec. Google's locale map is already exported; Apple needs a small
behavior-neutral extraction (one canonical lead-header const) — see A.

### F3. Header matching semantics (how forgiving must the template be)

| Aspect | Apple | Google |
|---|---|---|
| Positional? | **No** — name-based since Hotfix 27 (KB §3.3 lock restoration, KB:1315-1335) | **No** — name-based |
| Lead-header case | Trimmed + **case-insensitive** (`findHeaderIndex`, `iap-items.ts:134-140`) | Trimmed but **case-SENSITIVE exact** for `Product ID`/`GT Price`/`GT Currency` (`excel-parser.ts:303-305`); generic price headers case-insensitive (`excel-parser.ts:257-259`) |
| Locale-header match | Regex, case-sensitive `Display Name (X)`/`Description (X)`; locale name must exactly match a `lib/locale-map.json` key, else skipped + warned (`iap-items.ts:272-275`) | Regex, case-sensitive `Title (X)`/`Description (X)`; name must match `LOCALE_NAME_TO_BCP47` key, else warned (`excel-parser.ts:313-333`, `452-458`) |
| Pair adjacency | **REQUIRED** — `Display Name (X)` must be immediately followed by `Description (X)` or the whole file errors (`iap-items.ts:264-271`) | Not required — map-based; Title/Description found independently |
| Duplicate locale columns | N/A (adjacency scan claims pairs) | **Silently last-win** — later column overwrites the map entry (`excel-parser.ts:320-321, 330-331`); data in earlier duplicates is dropped with no warning |
| Required columns | Product ID + Reference Name only (`iap-items.ts:55, 210-217`) | Product ID (`excel-parser.ts:432-435`) + one resolvable price column (`excel-parser.ts:436-443`) |
| Type column | Optional — absent/empty → `CONSUMABLE`; present+invalid → row error (`iap-items.ts:306-323`; §3.3 institutional lock) | No Type column in this module |
| Price columns | All optional — `Price (USD)`/`GT Price`/`GT Currency` default to 0/0/"" (`iap-items.ts:325-337`) | Price required; GT Price + GT Currency optional but must be paired per-row (`excel-parser.ts:473-496`) |
| Unknown extra headers | Warning, not error (`iap-items.ts:256-261`) | Silently ignored (`excel-parser.ts:334`) |

Implication: a generated template that emits the canonical names exactly is
accepted by both parsers with maximum headroom; Apple's adjacency rule means
the Apple generator MUST emit Display Name/Description as adjacent pairs
(guaranteed by construction).

### F4. Existing template artifacts — both carry live risks

| Artifact | State |
|---|---|
| `docs/iap-management/templates/item-iap-template.xlsx` (Apple, 8.9 KB) | 1 sheet `Sheet1`; 84 populated headers; **3 example data rows** (`com.vng.example.product1` …). Parses clean — **pinned by a real-artifact smoke test** (`lib/iap-management/parsers/parsers.smoke.test.ts:102-131`: asserts sample row values, Type default, `locale_pair_count === 39`, zero skipped locales). |
| `docs/google-iap-management/templates/template-item-iap-google.xlsx` (Google) | 1 sheet `Sheet1`; 178 headers = 4 lead + **87 locale pairs, of which 5 are DUPLICATES** (`Title/Description (English)` ×3, `(Persian)` ×4 → 82 distinct); **3 example data rows**. **NOT pinned by any test** (no test references this file — asymmetry vs Apple). |
| `templates/app-registry-template.csv` (repo root, ~4 KB) | Store Management app-registry import template (multi-platform app rows). **Unrelated to IAP** — not a candidate for reuse here. |
| `docs/iap-management/templates/price-tiers-template.xlsx`, `docs/google-iap-management/templates/pricing-template-google.xlsx` | PRICING templates — out of scope (G.7). |

Two live defects found in the shipped artifacts:

1. **Example rows sit in the data sheet of both artifacts.** Uploaded
   unedited (or with rows forgotten), they import as REAL store IAPs
   (`com.vng.example.*`) with zero error — the exact silent-junk failure this
   design must close. This is not hypothetical; it is the current state of
   both Manager-provided files.
2. **Google artifact has duplicate locale pairs** that the parser silently
   last-wins (F3) — anything typed into the first `Title (English)` column is
   dropped without a warning. This is static-template drift already in
   production, and is the concrete evidence for Recommendation A.

### F5. The promised contract (user guide = spec) vs what parsers accept

**Apple — `docs/user-docs/index.html`:**

- `:1301` — "File Excel theo template chuẩn (**tải template ở bước 1 của
  wizard**)" and `:1315-1317` — "Ở Step 1, click **Tải template Excel**".
  → **The button does not exist** (see F7 for the real Step 1 UI).
- `:1318-1330` — promises a **5-column** template:
  `productId, referenceName, type, priceTier, familySharable`.
  `:1479-1495` — shows a `bulk-import-template.csv` example with those
  columns.
  → **Mismatch on nearly every column.** The parser's real contract is the
  84-column name-based schema (F2/F3). `priceTier` and `familySharable`
  **do not exist anywhere in the parser** (`iap-items.ts` has no such
  strings); pricing actually travels as `Price (USD)`/`GT Price`/
  `GT Currency` with tier inference downstream (`iap-items.ts:40-43`);
  locale pairs are absent from the promise entirely. The example is CSV but
  the dropzone accepts **only `.xlsx`** (MIME-restricted,
  `BulkImportWizard.tsx:618-620`).
  The only accurate promise: Type optional → `CONSUMABLE` (Hotfix 27,
  `:1330`), which matches `iap-items.ts:306-323`.

**Google — `docs/user-docs/index.html`:**

- `:3556` — Step 1 row promises "Tải template với 5 cột"; `:3570-3582` lists
  `sku, title, description, default_price, default_currency`.
  → **None of these header names exist in the parser.** Real contract:
  `Product ID`, `Price (XXX)` (flexible per Hotfix 16), `GT Price`,
  `GT Currency`, plus `Title (Locale)`/`Description (Locale)` ×82 (F2/F3).
  Guide implies CSV; the route enforces `.xlsx` ≤ 5 MB
  (`app/api/google-iap-management/apps/[packageName]/bulk-import/preview/route.ts:51,94`).

**Accurate docs (for contrast):**
`docs/google-iap-management/operational-guide.md:144-155` describes the real
Google template correctly (Column A–D + `Title/Description (LangName)` pairs,
82 locales). The Apple operational guide contains no template contract at all
(it covers Bulk Import *results* reading + hub tracking).

**Additional doc drift found:** KB §7.2 lists the Apple wizard as
"Step 1 — Pricing source, Step 2 — Upload Excel" (KB:715-718), but the shipped
stepper is `["Excel", "Screenshots", "Preview", "Result"]`
(`BulkImportWizard.tsx:562`). Flagged for KB correction (G.5).

### F6. XLSX generation + delivery — existing path to reuse

- Pure per-module workbook builders (sibling pattern, no cross-module code):
  `lib/iap-management/xlsx-export.ts` (SHEET_NAME `:34`, builders,
  `xlsxExportFilename` `:237`) and `lib/google-iap-management/xlsx-export.ts`
  (`:25`, `:207`).
- Server delivery: POST route → `XLSX.write(workbook, {type:"buffer"})` →
  `NextResponse` with `Content-Disposition: attachment`. Apple:
  `app/api/iap-management/apps/[appId]/export/route.ts:80-95`, auth
  `requireIapSession` `:52`. Google:
  `app/api/google-iap-management/apps/[packageName]/export/route.ts:93-104`,
  auth `getServerSession` `:55-57`.
- Client download trigger: fetch → blob → `URL.createObjectURL` → anchor
  `.click()`. Apple:
  `app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx:322-342`;
  Google:
  `components/google-iap-management/iap-list/IapListClient.tsx:176-198`.
- Shared-UI precedent: `components/iap-management/ExportOptionsDialog.tsx:4-7`
  — one component imported by both modules (documented exception).
- `xlsx` (SheetJS 0.18.5) is a dependency; **client-side dynamic-import
  precedent already exists**: the Apple parser does `await import("xlsx")` in
  the browser (`iap-items.ts:167`).

**EXPORT ≠ TEMPLATE** — kept strictly separate. Export dumps existing IAPs
(live-fetched data); template is a blank form. The design reuses the
*delivery pattern* and the `xlsx` dependency, never the export builders, and
adds no second XLSX codepath (the generator is a new pure module per side,
same shape as the existing `xlsx-export.ts` siblings).

### F7. Button placement — wizards are structurally asymmetric

- **Apple**: 4-step wizard at `/iap-management/apps/[appId]/bulk-import`,
  steps `Excel → Screenshots → Preview → Result`
  (`BulkImportWizard.tsx:562`). **Step 1 = Excel upload**: the `Step1Excel`
  card (`BulkImportWizard.tsx:601-676`), heading "Step 1 — Upload Excel
  template" (`:641`), subtitle already names
  `item-iap-template.xlsx` (`:643-646`). → Button goes in this card.
- **Google**: wizard `components/google-iap-management/bulk-import/BulkImportWizard.tsx`,
  steps `pricing → upload → preview → execute/done` (`:128`, stepper
  `:1015-1017`). **Step 2 = upload** (Step 1 is Pricing source): the upload
  card (`:599-609`) mentions `template-item-iap-google.xlsx` as inline text
  (`:604-609`). → Button goes in the Step-2 card; do NOT mirror Apple's
  "Step 1" placement.
- The Google wizard already receives `appDefaultCurrency` as a prop
  (`app/(dashboard)/google-iap-management/apps/[packageName]/bulk-import/page.tsx:47`)
  — a client-generated template can emit `Price (<CUR>)` per app (G.1).

---

## PART 2 — DESIGN

### A. Recommendation: GENERATED-FROM-PARSER (both modules)

**Generate the workbook from the same declarative spec the parser consumes.**
Grounds (F2): all column knowledge already lives in code —

- Apple: `REQUIRED_LEAD_HEADERS` + 4 inline optional lead literals +
  `lib/locale-map.json` (39 locales).
- Google: `FIXED_HEADERS` + `resolvePriceColumn` + exported
  `LOCALE_NAME_TO_BCP47` (82 locales).

A static file is rejected because static-template drift is not hypothetical —
it is the *current state* (F4: duplicate locale pairs in the Google artifact;
example rows in both; F5: the user guide's fictional 5-column contracts). A
static download would relocate exactly the drift this task exists to fix:
parser adds a column → file silently stale → users upload the wrong shape.

Required extraction (small, behavior-neutral):

- **Apple**: export one canonical const, e.g.
  `APPLE_TEMPLATE_LEAD_HEADERS = ["Product ID", "Reference Name", "Type",
  "Price (USD)", "GT Price", "GT Currency"]`, and have the `leadIdx`
  literals (`iap-items.ts:219-226`) read from it. Locale pair headers derive
  from `lib/locale-map.json` keys (keep the current artifact's alphabetical
  order), emitted as adjacent `Display Name (X)` / `Description (X)` pairs —
  adjacency is a parser requirement (`iap-items.ts:264-271`).
- **Google**: a canonical emission const, e.g.
  `GOOGLE_TEMPLATE_FIXED_HEADERS(cur) = ["Product ID", "Price (" + cur + ")",
  "GT Price", "GT Currency"]`. Parser *acceptance* stays flexible (Hotfix 16
  untouched); the template just emits the canonical explicit form. Locale
  pairs from `Object.keys(LOCALE_NAME_TO_BCP47)` — uniqueness by construction
  **fixes the v1 artifact's duplicate-column defect**.

New pure generator module per side (sibling shape of `xlsx-export.ts`):
`lib/iap-management/parsers/iap-items-template.ts` and
`lib/google-iap-management/parsers/excel-template.ts` (names indicative).

### B. Template structure (per Manager requirement, arranged to kill both risks)

- **Sheet 1 (first) — DATA sheet, HEADERS ONLY, zero data rows.**
  Name: `IAP Items` (both modules — the per-module canonical name constant is
  what section C's hardening selects). Rationale: both current artifacts ship
  example rows in the data sheet, and unedited/forgotten rows import as real
  store IAPs with no error (F4.1). Headers-only means there is nothing to
  forget to delete.
- **Sheet 2 — NOTES sheet** (name: `Notes`), generated from the same spec:
  - per-column table: header name, required/optional, default when
    empty/absent, allowed values (Apple `Type` enum from `TYPE_VALUES`,
    `iap-items.ts:57-61`; Google price-header flexibility per Hotfix 16;
    GT Price + GT Currency must be paired, `excel-parser.ts:473-496`);
  - locale-pair fill rules: both-or-skip; one-of-two filled → warning + skip
    (Apple `iap-items.ts:346-355`; Google skips empty pairs
    `excel-parser.ts:498-506`);
  - an **illustrative example table** showing a filled row — the current
    artifacts' 3 sample rows move here, where they can be read but never
    imported.
- Data sheet placed first as belt-and-braces, but **order is not
  load-bearing** once C lands — the parser selects the data sheet by NAME.

### C. Extra-sheet safety — sheet-selection hardening (REQUIRED, both parsers)

Neither parser selects by name (F1), so the notes sheet is NOT yet safe.
Hardening (small, additive, inside the parser = the per-module choke point
covering all call sites — Apple `BulkImportWizard.tsx:628` +
`execute/route.ts:354`, Google `preview/route.ts:117`):

```
prefer workbook.Sheets[DATA_SHEET_NAME]   // "IAP Items"
else fall back to workbook.Sheets[SheetNames[0]]   // today's behavior
```

- Apple: replaces `iap-items.ts:183-188`. Google: replaces
  `excel-parser.ts:411-420`. `DATA_SHEET_NAME` is exported from the same
  spec module the generator uses — single source of truth.
- **Regression risk: minimal.** Every existing file (both Manager artifacts
  use `Sheet1`) takes the fallback path — behavior identical to today.
- **Proof of safety:** existing tests must stay green unchanged —
  `lib/iap-management/parsers/parsers.smoke.test.ts` (parses the REAL Apple
  artifact through the fallback path), `iap-items.test.ts`,
  `lib/google-iap-management/parsers/excel-parser.test.ts`. New tests: a
  workbook with the Notes sheet FIRST and the named data sheet second parses
  the data sheet (order independence) — per module.
- Never rely on sheet ORDER (user reorder / Excel re-save can change it).

### D. Anti-drift tests (the structural guard, per module)

1. **Round-trip WITH notes sheet**: generate the template, fill valid rows
   into the data sheet, parse → 0 errors, 0 warnings, 0 skipped locales,
   full locale count (`locale_pair_count === 39` Apple; 82 locales resolved
   Google), all lead columns resolved. Proves the notes sheet is harmless AND
   the generated headers are parser-exact.
2. **Spec pin**: the generated data-sheet header row equals the canonical
   spec array exactly (lead + pairs, order included) — catches accidental
   generator edits.
3. **Coupling guarantee**: parser and generator import the same exported spec
   consts, so a parser column change that forgets the template fails test 1
   instead of reaching users.
4. Keep the legacy-artifact smoke tests as back-compat locks
   (`parsers.smoke.test.ts` for Apple). **Add the missing Google artifact
   smoke test** (F4: the Google template is pinned by nothing today).

### E. Twin-path split — explicitly NOT a 1:1 mirror

Shared (pattern, not code):

- Delivery pattern (blob → `createObjectURL` → `a.click()`, same as export).
- Template structure rules (headers-only data sheet + Notes sheet).
- Test pattern (D).

Per-module (differs, by evidence):

| | Apple | Google |
|---|---|---|
| Header spec | 6 lead + 39 pairs from `lib/locale-map.json` | 4 lead + 82 pairs from `LOCALE_NAME_TO_BCP47` |
| Price header | Fixed `Price (USD)` (tier inference downstream) | `Price (<appDefaultCurrency>)` — prop available (F7) |
| Pair emission | MUST be adjacent (`iap-items.ts:264-271`) | Order-free, emit adjacent anyway for readability |
| Wizard placement | Step 1 "Excel" card (`BulkImportWizard.tsx:601-676`) | Step 2 "upload" card (`BulkImportWizard.tsx:599-609`) |
| Filename | `item-iap-template.xlsx` (kept — referenced at `:644`) | `template-item-iap-google.xlsx` (kept — referenced at `:607`) |
| Auth context | Apple module session (`requireIapSession`) | Google module session (`getServerSession` + whitelist) |
| Generator module | `lib/iap-management/parsers/…` | `lib/google-iap-management/parsers/…` |

No cross-module import of generation code: the per-module sibling pattern is
the precedent (`xlsx-export.ts` ×2); the genuinely shareable part is ~10
lines of `aoa_to_sheet` + `book_append_sheet`, not worth a shared module.
(`ExportOptionsDialog` is a UI-sharing exception with different calculus.)

### F. Delivery mechanism — recommend CLIENT-SIDE generation

On click: `await import("xlsx")` (lazy) → build workbook from the spec module
→ `XLSX.write` to blob → `createObjectURL` → `a.click()`. Rationale:

- The template is pure/static — no server data, no secrets. The one dynamic
  input (Google's app default currency) is already a client prop
  (`page.tsx:47`).
- Precedent: the Apple wizard already dynamic-imports `xlsx` in the browser
  to parse (`iap-items.ts:167`) — zero new bundle weight on the Apple page.
- No new API routes or auth surface; the wizard pages already sit behind each
  module's auth. The final download UX is byte-identical to export's blob
  pattern (F6).
- Trade-off: the Google wizard gains a lazy `xlsx` chunk on first
  template-download click (dynamic import — not in the initial bundle).

Alternative (documented, not recommended): a GET route per module wrapping
the same generator, guarded like export (`requireIapSession` /
`getServerSession`). Adds surface with no benefit while the template stays
static; switch to it only if the template ever needs server-only data.
Template content is non-sensitive (header names only), so client-side
generation does not weaken any guard export relies on.

### G. Open questions / risks

1. **Google price header**: recommend `Price (<app default currency>)` (prop
   available); fallback `Price (USD)` is also valid — Cycle 43
   cross-currency handles USD-in-VND-app either way. Manager preference?
2. **Notes-sheet language**: Vietnamese (user-docs style), English
   (parser-message style), or bilingual? Recommend bilingual short table.
3. **Fate of checked-in artifacts**: keep both as back-compat parser
   fixtures (the Apple smoke test depends on one); mark superseded in each
   module's docs. Do not delete.
4. **User-docs must be fixed in the implementation PR**: the fictional
   5-column tables (`index.html:1318-1330` Apple, `:3570-3582` Google) must
   be rewritten to the real contract, otherwise the original drift this task
   exists to fix stays live in the guide that describes the new button.
5. **KB §7.2 step-list drift** (KB:715-718 vs `BulkImportWizard.tsx:562`) —
   correct alongside.
6. **Optional parser hardening (follow-up only, out of scope)**: warn on
   duplicate locale columns in the Google parser (today silently last-win,
   `excel-parser.ts:320-331`) — surfaced by F4.
7. **Pricing templates (out of scope)**: different parsers; the Apple
   price-tiers artifact uses a *named* sheet `price_tiers`
   (`parsers.smoke.test.ts:5-7`) but whether its parser selects by name is
   **UNCERTAIN — not verified** (would be settled by reading
   `parsers/price-tiers.ts` sheet selection). If a pricing-template download
   is wanted later, re-run this investigation there; it does not share this
   mechanism by default.

---

## Implementation inventory (when approved — NOT started)

Per module: spec extraction (A) → generator module (A/B) → sheet-selection
hardening (C) → wizard button (F7 placements) → tests (D) → user-docs + KB
corrections (G.4/G.5). Pre-push checklist per CLAUDE.md (typecheck, test,
lint, build).
