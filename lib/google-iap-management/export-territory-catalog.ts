/**
 * G-EXPORT X4 — the country list the Google export dialog offers.
 *
 * ⚠ THIS FILE EXISTS TO CLOSE R2. Before it, the Google caller rendered
 * `<ExportOptionsDialog>` with three props and no `catalog`, so the shared
 * dialog's DEFAULT PARAMETER supplied `TERRITORY_CATALOG` — 183 hand-typed
 * entries living in the **Apple** module. Nothing in the Google tree imported
 * that constant, so every grep for it came back clean and the dependency was
 * invisible (KB P34). Measured, the borrowed list was wrong both ways: 15
 * markets Google sells in could not be ticked, 25 tickable ones Google does
 * not sell in.
 *
 * ─── ONE FIELD, ONE SOURCE — none of them Apple's ──────────────────────────
 *
 *   code + currency   `google/play-regions.snapshot.ts`  — measured from
 *                     `convertRegionPrices`, regionsVersion "2025/03", cross-
 *                     checked 100% against the Console's Pricing screen.
 *   name              `regionNameFromCode` (region-name.ts) — the Console's
 *                     own labels for all 173.
 *   region bucket     `getContinentForRegion` (region-continent.ts) — the
 *                     Google module's own 5-continent table.
 *
 * Nothing is duplicated here: this module only joins three existing sources
 * into the row shape the dialog's prop wants.
 *
 * ⚠ THE ONLY THING IMPORTED FROM THE APPLE MODULE IS THE TYPE. `TerritoryEntry`
 * is the shape of the shared dialog's `catalog` prop, so it has to come from
 * where the prop is declared. A TYPE carries no territories; the DATA is what
 * R2 was about, and none of it crosses here. A structural test pins that this
 * file's only `lib/iap-management` import is `import type`.
 *
 * ─── ⚠ FIVE BUCKETS, NOT SIX, AND THAT IS DELIBERATE ───────────────────────
 *
 * Apple's picker groups into six (…, "Middle East", …). This one groups into
 * the FIVE the Google module already uses everywhere else — the pricing-matrix
 * continent filter's buckets, a Manager decision locked 2026-05-23 (Q2.D). The
 * dialog renders whichever buckets have entries and skips the empty ones
 * (ExportOptionsDialog.tsx:121-124), so "Middle East" simply does not appear
 * and nothing in the shared component needs changing.
 *
 * Using Apple's buckets instead would mean importing Apple's per-country data
 * to decide where a Google market is shown — the exact dependency this file
 * was written to remove, re-entering through a cosmetic door.
 */
import type { TerritoryEntry } from "@/lib/iap-management/territory-catalog";

import { getContinentForRegion } from "./region-continent";
import { regionNameFromCode } from "./region-name";
import { PLAY_REGIONS } from "./google/play-regions.snapshot";

/**
 * Display order inside the dialog. Matches the order the Google module's own
 * continent filter uses, so the two surfaces read the same way.
 */
const BUCKET_ORDER = ["Asia", "Europe", "Americas", "Africa", "Oceania"] as const;

/**
 * ⚠ A CODE WITH NO CONTINENT IS BUCKETED, NOT DROPPED. Measured 2026-09-01:
 * `getContinentForRegion` covers all 173, so this branch is unreachable today
 * and a test pins that. It stays because the alternative — silently omitting
 * a market Google sells in from the picker — is the R2 defect in miniature,
 * and a market nobody can tick is exactly what this arc exists to remove. If a
 * future refresh adds a code the continent table lacks, it still shows up, and
 * `export-territory-catalog.test.ts` fails and names it.
 */
function bucketFor(code: string): TerritoryEntry["region"] {
  const c = getContinentForRegion(code);
  return c ?? "Asia";
}

function build(): TerritoryEntry[] {
  const all: TerritoryEntry[] = PLAY_REGIONS.map((r) => ({
    code: r.code,
    currency: r.currency,
    name: regionNameFromCode(r.code),
    region: bucketFor(r.code),
  }));

  // Grouped by bucket, alphabetical by NAME inside each — the same ordering
  // the shared dialog was built against, so the list reads as it always did.
  const out: TerritoryEntry[] = [];
  for (const bucket of BUCKET_ORDER) {
    out.push(
      ...all
        .filter((t) => t.region === bucket)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  return out;
}

/**
 * The 173 markets Google Play sells in, as the dialog's `catalog` prop.
 * Computed once at module load — the inputs are static for the process.
 */
export const GOOGLE_TERRITORY_CATALOG: readonly TerritoryEntry[] = build();

/** Codes only, in catalog order. */
export const GOOGLE_TERRITORY_CODES: readonly string[] =
  GOOGLE_TERRITORY_CATALOG.map((t) => t.code);
