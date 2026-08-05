# Bulk Import Template — Locale Selection Before Download — Investigation & Design

**Status: IMPLEMENTED (August 2026).** Shipped as designed, with these
resolutions to §I: risk I.1 → a Preview-time WARNING in the Google wizard
(names the affected SKUs, derived live from per-row Overwrite decisions)
PLUS the Notes-sheet caution — the underlying replace-semantics defect is
recorded as an OPEN BACKLOG item in
`IAP-MANAGEMENT-KNOWLEDGE-BASE.md` §10.13.K (P4 RMW violation) and was
deliberately NOT fixed in that pass; I.2 → selections are NEVER
remembered (Manager lock); I.5 → the Apple wizard's "N locale pairs"
copy was left as-is (informational). One deviation from §C worth noting:
sample rows fill Vietnamese when it is in the selection, otherwise the
first selected locale — that keeps the FULL template byte-identical to
the pre-picker file, which matters because the full selection also keeps
the original filename.

**Scope: BOTH modules.** Google pointer stub:
`docs/google-iap-management/design-bulk-import-locale-picker.md`.
**Mockup:** `docs/iap-management/design/bulk-import-locale-picker-mockup.html`
(interactive — real 39/82 locale lists embedded, module toggle, search,
select-all/clear-all, live count, zero-state banner).

Goal: "Download bulk import template" opens a locale-picker form; the
template is generated with ONLY the chosen locale columns plus all core
columns. Manager locks: nothing pre-ticked; zero locales is a valid —
and therefore the DEFAULT — output; only locale columns selectable;
show country + language per row; per-module locale lists.

---

## PART 1 — STEP 1 GATE: do subset templates import through the CURRENT parsers?

### Verdict (stated up front)

**YES — subset templates, including the zero-locale default, import
through the existing bulk-import mechanism UNCHANGED. No parser change
is needed; blast radius on the live-store import path is zero. This
feature is generator + shared-button UI + tests/docs only.**

Proven two ways: code reading with file:line (below) and an empirical
harness that pushed subset / zero-locale / arbitrary-position workbooks
through the REAL parsers — **5/5 passed** (temporary root-level vitest
file, deleted after the run per the no-code guardrail; the doc's §G
specifies the permanent versions to be written at implementation).

### 1a. Header matching is NAME-based in both modules — no positional stage

- Apple: lead headers resolve via `findHeaderIndex` (trimmed,
  case-insensitive) — `lib/iap-management/parsers/iap-items.ts:153`,
  lookups `:256-261`. Locale pairs are matched by regex
  `LOCALE_HEADER_RE` (`:79`) during a scan of the header cells
  (`:281` onward). The old positional check was removed by Hotfix 27
  (KB §3.3 lock restoration) — nothing indexes by column position.
- Google: `indexColumns` iterates the header CELLS
  (`lib/google-iap-management/parsers/excel-parser.ts:226-241`), fixed
  headers by name, locale pairs by `Title/Description (X)` regex
  (`:255-256`); the price column resolves by name/regex scan
  (`resolvePriceColumn`, `:181-197`).

Empirical confirmation: an Apple file with a locale pair placed BETWEEN
lead columns (adjacency of the pair kept) parsed cleanly — position is
irrelevant; only Display-Name→Description adjacency matters (a
generator invariant we already satisfy by construction).

### 1b. Neither parser iterates the expected locale set — both DISCOVER from the file

Both parsers walk the header row that is actually present and match
what they find. An ABSENT locale column is simply never visited: no
skip-list entry, no warning, no throw. (`skipped_locales` /
`unknownLocales` fire only for PRESENT-but-unrecognised names —
`iap-items.ts:308-311`, `excel-parser.ts:258-266`.) This is the
structural reason the gate passes: "expected set" exists only in the
generator, not in the parsers.

### 1c. Zero locale columns — traced end-to-end (the default path)

- **Parse**: empirically clean in both modules — Apple: items parse,
  `locale_pair_count: 0`, `localizations: []`, zero warnings; Google:
  rows parse, `listings: []`, zero errors/warnings.
- **Preview**: Apple Step-1 summary shows "0 locale pairs" (cosmetic);
  the Next gate needs only `items.length > 0`. Google preview route
  (`bulk-import/preview/route.ts:117` parse entry) has no locale
  requirement.
- **Execute, CREATE**: Apple creates the IAP then loops
  `item.localizations` (no-op when empty — execute route, the
  localization loop) — succeeds; the IAP is metadata-incomplete on ASC
  until localizations are added (already-documented behavior). Google
  `buildProduct` synthesizes a default listing when none provided:
  `listings["en-US"] = { title: row.sku, description: "" }`
  (`orchestration/bulk-import.ts:179-180`) — import succeeds with the
  SKU as the store title.
- **Execute, OVERWRITE**: Apple's delta sync SUPPRESSES all deletions
  when the desired locale set is empty
  (`lib/iap-management/bulk-import/localization-sync.ts:19-21, 47-49`)
  — a zero-locale overwrite leaves existing localizations untouched.
  Google REPLACES listings with the row-built set: the overwrite
  read-modify-write GET merges **purchase options only**
  (`google/publisher-client.ts:864-872`), so a zero-locale overwrite
  row replaces the store listings with the synthesized en-US/SKU
  listing. ⚠ This is PRE-EXISTING semantics — today's full template
  with all locale cells left empty produces the identical `desired`
  set — but the picker makes that file the one-click default. See §D
  (Notes caution) and §I risk 1.

### 1d. No other stage assumes the full column set

- Apple conflict resolution: no locale logic (the only mention is a
  comment — `bulk-import/conflict-resolution.ts:65`).
- Screenshot matcher: filename ↔ Product ID only; zero locale
  references (`parsers/screenshot-matcher.ts`).
- Apple server-side re-parse on execute (`execute/route.ts`, the
  `parseIapItemsXlsx` call) uses the SAME parser — identical discovery
  semantics at both loci.
- Google price resolver: name/regex scan (1a) — a subset changes
  nothing.
- Google preview/execute routes: consume parsed rows; listings are
  per-row lists, never validated against a locale roster.

### 1e. FEWER columns proven, not generalised from EXTRA

The legacy Google artifact (178 headers = 168 + 10 duplicates) only
proved extra-column tolerance. Fewer-column tolerance was proven
directly by the empirical harness: Apple 2-of-39 subset, Apple
zero-locale, Apple arbitrary-position pair, Google 1-of-82 subset,
Google zero-locale — all parse with zero errors AND zero warnings, and
Google's explicit-USD price semantics held (`baseCurrency: "USD"`
against a VND app).

---

## PART 2 — DESIGN

### A. Modal UX (see the mockup)

One modal, opened by every template-download button (all four call
sites). Contents: header ("core columns are always included; nothing
selected = core-only template"); search input matching language,
country/variant, and code; **Select all (visible)** — applies to the
filtered rows, so "English" → select 5 variants in two clicks — and
**Clear all**; a live count "Đã chọn N / 39|82"; a permanent amber
zero-state banner while N = 0 (since nothing is pre-ticked, this is the
state every user sees first — it explains that core-only is valid, not
an error); rows = checkbox · Language · Country/Variant · code; footer
CTA whose label tracks the state: "Tải template (chỉ cột core)" vs
"Tải template (N locale)". Module accent colors (Apple blue, Google
emerald). Cancel/ESC closes without downloading.

### B. Country + language derivation — precomputed, no client country library

Derivation rule (per row):
1. Name has a parenthetical → display it verbatim as the
   country/variant column: real countries ("U.S.", "Brazil",
   "United States"), scripts ("Simplified", "Traditional"), groupings
   ("Latin America"). Verbatim display sidesteps the script/grouping
   ambiguity — the column is titled "Quốc gia / biến thể".
2. No parenthetical but the BCP-47 code has a region subtag → country
   name from the subtag (e.g. Apple "Arabic" → `ar-SA` → Saudi Arabia).
3. Neither → "—" (language-only locale). Counts: Apple 24/39 rows,
   Google ~30/82 rows hit rule 3 — the dash is the common case, so the
   code column stays visible on every row as the disambiguator
   (Google's generic "English" (`en`) sits alongside 4 regional English
   variants; the code makes them distinct).

**Implementation: precompute** `{ name, language, country, code }` into
each module's `template-spec.ts` as a checked-in const
(`APPLE_LOCALE_OPTIONS` / `GOOGLE_LOCALE_OPTIONS`), exhaustiveness
pinned by a test asserting every key of the locale map has exactly one
display entry. Measured cost: ~2–3 KB of strings per module in the
already-loaded spec module. The alternative — deriving at runtime with
`i18n-iso-countries` — would pull a **780 KB installed package** (used
today only server-side by the Apple export) toward the client bundle;
rejected per the T1-8 bundle concern. The mockup's embedded data was
generated with this exact rule (via `Intl.DisplayNames`) and doubles as
the review copy of the precomputed table.

### C. Sample rows adapt to the selection

Rule: the 3 sample rows fill core cells always; the locale pair is
filled for the **first selected locale in canonical template order**
(today it happens to be Vietnamese only because Vietnamese is in the
full set). Zero locales selected → sample rows carry core cells only.
A sample row must never reference a column that is not in the file —
enforced by building rows from the same selected-locale list the
header builder uses. Sample metadata-completeness stays illustrative
only (rows are auto-skipped via `TEMPLATE_SAMPLE_PRODUCT_IDS`).

### D. Notes sheet adapts to the selection

- Locale row of the column table becomes: "N locale pair(s) included
  (selected at download; the full set has 39/82)".
- Zero-locale variant adds an explicit paragraph: this template has no
  locale columns; NEW items import without localizations (Apple:
  metadata-incomplete on ASC until localizations are added; Google:
  the default listing falls back to the SKU as title). ⚠ OVERWRITE
  caution: on Google, overwriting an existing item from a no-locale
  row replaces its store listings with that fallback; on Apple,
  existing localizations are preserved (deletion suppression).
- The two GT statements are kept verbatim in every variant: Apple —
  "GT Price / GT Currency are currently NOT applied for Apple…";
  Google — GT Price is "a REAL per-region store price … NOT an
  exchange rate".

### E. Filename — differentiate by content

Decision: keep the base for the full set, suffix otherwise —
- full selection → `apple-iap-bulk-import-template.xlsx` (byte-shape of
  today's file, name unchanged — docs and habits stay valid);
- zero locales → `…-template-core.xlsx`;
- partial → `…-template-<N>-locales.xlsx` (e.g. `…-template-3-locales.xlsx`).

Tradeoff: a static name keeps docs simplest but two different-content
downloads silently collide in Downloads — the exact confusion this
feature fights. The count suffix is a discriminator, not a manifest
(two different 3-locale sets still share a name and get the browser's
"(1)" suffix — accepted; listing locale codes in the filename gets
unwieldy past ~3). Google mirrors the same pattern.

### F. Spec parameterization — bundle isolation preserved

- `XlsxTemplateSpec` shape unchanged. Module factories become
  `appleIapTemplateSpec(selectedLocaleNames?: readonly string[])` /
  `googleIapTemplateSpec(selected…?)` — **omitted/undefined = full
  set**, so the spec-identity tests and any existing caller semantics
  survive unchanged.
- Modules additionally export the display consts from §B.
- Shared `DownloadTemplateButton` props evolve to
  `{ localeOptions, getSpec(selectedNames) => XlsxTemplateSpec, … }`;
  the modal (list, search, selection state) lives ONCE in
  `components/ui/shared/` (inside the button component or a sibling
  `LocalePickerModal` it owns). Isolation holds because both the
  options and the factory arrive as props from each module's
  client-safe spec module — the shared component still imports neither
  module, so Apple pages never bundle Google's map and vice versa.
  Still ONE component serving all FOUR call sites; zero duplicated
  modal or generation code.

### G. Test reframing (shapes only — written at implementation)

- **Anti-drift, parameterized but not weakened**:
  `headers(sel) === [...CORE_HEADERS, ...pairsFor(sel)]` (exact
  equality, order included) for representative selections, PLUS
  `headers(FULL)` must equal the canonical 84/168 full set — the full
  case is what still catches a parser gaining a core column or the
  locale map growing without the template following. Also assert core
  ∩ locale-pairs = ∅ (locale columns are the only selectable ones).
- **Sample-row completeness becomes conditional**: ≥1 selected → the
  first selected locale's pair is filled on every sample row; zero →
  sample rows contain no locale cells.
- **New round-trip acceptance** (both modules, real parsers): the
  zero-locale template (DEFAULT path — first-class test), a
  single-locale template, and a 3-locale template — each filled with
  real rows and parsed to zero errors/warnings with the expected
  listings/localizations. (These are the permanent versions of the
  gate harness.)
- **Locale-options exhaustiveness**: every locale-map key has exactly
  one display entry (§B) and every display entry maps back to a key.
- **Unchanged and must stay green**: notes-sheet-first mutation
  targets, sample-skip round-trip (3 skipped / 0 items / 0 errors),
  replace-then-import, shared-skip-list, spec-identity per call site
  (full/default invocation), both legacy Sheet1 smoke tests.

### H. Backward compatibility

Parsers are untouched, so: previously-downloaded FULL templates parse
bit-identically (their headers don't change); both legacy on-disk
artifacts keep parsing via the Sheet1 fallback (their smoke tests are
unchanged); a full selection reproduces today's file under today's
name. Nothing in this design touches skip logic, import validation, or
template content semantics for the full-set case.

### I. Open questions / risks

1. **Google zero-locale OVERWRITE replaces store listings** with the
   en-US/SKU fallback (1c). Pre-existing semantics, but the picker
   makes the no-locale file one click away. Options: (a) accept +
   Notes-sheet caution (this design's default), (b) add an import-time
   warning when an OVERWRITE row carries no listings — that touches
   validation, explicitly out of scope this pass. Manager call.
2. Remember the last selection (localStorage) for repeat downloads?
   Lock #1 demands nothing pre-ticked — treating that as
   first-open-per-session vs literally-always changes the UX. Default:
   literally always empty until Manager says otherwise.
3. Filename suffix uses a count, not locale codes — two different
   3-locale sets share a name (browser adds "(1)"). Accepted; flagged.
4. Modal accessibility (focus trap, ESC, checkbox keyboard nav) —
   implementation detail, noted for the component work.
5. UNCERTAIN (cosmetic only): whether the Apple wizard's "N locale
   pairs detected" copy should call out "0" specially for core-only
   files — UI polish decided at implementation; no correctness impact
   (the count is informational).
6. User-docs updates (bulk-import + apps-list sections + SVG parity
   for the modal) follow AFTER implementation, per the established
   doc-consolidation pattern — not in this pass.

---

## Implementation inventory (when approved — NOT started)

Per module: display consts + parameterized spec factory (§B/§F) →
shared modal in `DownloadTemplateButton` (§A/§F) → sample/Notes
adaptation (§C/§D) → filename rule (§E) → tests (§G) → docs + mockup
parity pass. Pre-push checklist per CLAUDE.md.
