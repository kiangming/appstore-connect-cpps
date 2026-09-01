/**
 * PINNED SNAPSHOT — the 173 regions Google Play sells in, with the currency
 * Google bills each one in.
 *
 * ─── PROVENANCE ────────────────────────────────────────────────────────────
 *
 *   Measured   2026-09-01
 *   Version    regionsVersion "2025/03"  (Google's own name for this catalog)
 *   Command    GET /api/google-iap-management/regions/catalog?packageName=<cached pkg>
 *              — one `monetization.convertRegionPrices` call
 *              (google/regions-helper.ts:76-103), read-only, writes nothing.
 *
 * ⚠ THE CODES **AND** THE CURRENCIES WERE CROSS-CHECKED, NOT ASSUMED. All 173
 * `{code, currency}` pairs were compared by machine against the Google Play
 * Console **Pricing** screen (Manager-supplied) and MATCH 100 PERCENT, 0
 * differing in either direction. Independently, census Q7 over
 * `google_iap_mgmt.iap_prices` (308,933 price rows, 1,794 IAPs) returned the
 * same 173 codes. Three sources, one answer.
 *
 * ⚠ WHAT THIS REPLACED, AND WHY IT MATTERS. The export dialog used to offer
 * `TERRITORY_CATALOG` — 183 hand-typed entries in the **Apple** module —
 * because the Google caller never passed a `catalog` prop and the shared
 * dialog default filled it in. Measured against this file that list was wrong
 * in both directions: **15 markets Google sells in could not be ticked at
 * all** (AW BM BY CF ER GI KY LY RU SO TC VA VG YE ZW — Russia among them) and
 * **25 tickable entries were markets Google does not sell in**. See KB P34.
 *
 * ─── HOW DRIFT IS DETECTED, AND WHY NOT APPLE'S WAY ────────────────────────
 *
 * ⚠ GOOGLE STATES ITS OWN CATALOG VERSION, WHICH IS A BETTER SIGNAL THAN
 * ANYTHING THE APPLE SIDE HAS. `ConvertRegionPricesResponse.regionVersion
 * .version` comes back on every conversion, so one string comparison answers
 * "has the catalog moved?" — where Apple has to diff its snapshot code by code
 * to find out. `checkRegionsVersion()` below is that comparison. Do NOT port
 * Apple's code-by-code sweep here: it would be slower, later, and strictly
 * less informative than a field Google already sends for free.
 *
 * ⚠ THE CHECK RUNS ONLY WHERE A CONVERSION ALREADY HAPPENS. The export dialog
 * must stay at zero requests, so it never triggers this — the
 * `regions/catalog` route reports it, because that route has already paid for
 * the call.
 *
 * To refresh:
 *   1. Open  /api/google-iap-management/regions/catalog?packageName=<cached pkg>
 *      while signed in. Read `regionsVersion` and the `regions` array.
 *   2. Replace `PLAY_REGIONS_VERSION`, `PLAY_REGIONS_MEASURED_AT` and the
 *      table below TOGETHER, in one commit.
 *   3. Read the Console Pricing screen for any NEW code's label and add it to
 *      `PLAY_CONSOLE_LABELS` (region-name.ts). A code with no label falls back
 *      to its ISO name, and the tripwire in `export-territory-header.test.ts`
 *      fails and names it.
 *
 * ⚠ NEVER EDIT ONE FIELD ALONE. A hand-edited row that the version string no
 * longer describes is a snapshot lying about its own provenance — the version
 * is what makes every other line in here checkable.
 */

/** Google's own name for the catalog these pairs came from. */
export const PLAY_REGIONS_VERSION = "2025/03";

/** ISO date of the measurement above. */
export const PLAY_REGIONS_MEASURED_AT = "2026-09-01";

export interface PlayRegion {
  /** ISO 3166-1 alpha-2 — Google's native format for `prices` keys. */
  code: string;
  /** ISO 4217, the currency Google BILLS this market in. Not the country's own
   *  currency in every case: Google prices 76 of these 173 in USD. */
  currency: string;
}

/** The 173, sorted by code so a future diff of this file reads cleanly. */
export const PLAY_REGIONS: readonly PlayRegion[] = [
  { code: "AE", currency: "AED" }, { code: "AG", currency: "USD" },
  { code: "AL", currency: "USD" }, { code: "AM", currency: "USD" },
  { code: "AO", currency: "USD" }, { code: "AR", currency: "USD" },
  { code: "AT", currency: "EUR" }, { code: "AU", currency: "AUD" },
  { code: "AW", currency: "USD" }, { code: "AZ", currency: "USD" },
  { code: "BA", currency: "USD" }, { code: "BD", currency: "BDT" },
  { code: "BE", currency: "EUR" }, { code: "BF", currency: "EUR" },
  { code: "BG", currency: "EUR" }, { code: "BH", currency: "USD" },
  { code: "BJ", currency: "EUR" }, { code: "BM", currency: "USD" },
  { code: "BO", currency: "BOB" }, { code: "BR", currency: "BRL" },
  { code: "BS", currency: "USD" }, { code: "BW", currency: "USD" },
  { code: "BY", currency: "USD" }, { code: "BZ", currency: "USD" },
  { code: "CA", currency: "CAD" }, { code: "CD", currency: "USD" },
  { code: "CF", currency: "EUR" }, { code: "CG", currency: "USD" },
  { code: "CH", currency: "CHF" }, { code: "CI", currency: "XOF" },
  { code: "CL", currency: "CLP" }, { code: "CM", currency: "XAF" },
  { code: "CO", currency: "COP" }, { code: "CR", currency: "CRC" },
  { code: "CV", currency: "USD" }, { code: "CY", currency: "EUR" },
  { code: "CZ", currency: "CZK" }, { code: "DE", currency: "EUR" },
  { code: "DJ", currency: "USD" }, { code: "DK", currency: "DKK" },
  { code: "DM", currency: "USD" }, { code: "DO", currency: "USD" },
  { code: "DZ", currency: "DZD" }, { code: "EC", currency: "USD" },
  { code: "EE", currency: "EUR" }, { code: "EG", currency: "EGP" },
  { code: "ER", currency: "USD" }, { code: "ES", currency: "EUR" },
  { code: "FI", currency: "EUR" }, { code: "FJ", currency: "USD" },
  { code: "FM", currency: "USD" }, { code: "FR", currency: "EUR" },
  { code: "GA", currency: "EUR" }, { code: "GB", currency: "GBP" },
  { code: "GD", currency: "USD" }, { code: "GE", currency: "GEL" },
  { code: "GH", currency: "GHS" }, { code: "GI", currency: "GBP" },
  { code: "GM", currency: "USD" }, { code: "GN", currency: "USD" },
  { code: "GR", currency: "EUR" }, { code: "GT", currency: "USD" },
  { code: "GW", currency: "EUR" }, { code: "HK", currency: "HKD" },
  { code: "HN", currency: "USD" }, { code: "HR", currency: "EUR" },
  { code: "HT", currency: "USD" }, { code: "HU", currency: "HUF" },
  { code: "ID", currency: "IDR" }, { code: "IE", currency: "EUR" },
  { code: "IL", currency: "ILS" }, { code: "IN", currency: "INR" },
  { code: "IQ", currency: "IQD" }, { code: "IS", currency: "EUR" },
  { code: "IT", currency: "EUR" }, { code: "JM", currency: "USD" },
  { code: "JO", currency: "JOD" }, { code: "JP", currency: "JPY" },
  { code: "KE", currency: "KES" }, { code: "KG", currency: "USD" },
  { code: "KH", currency: "USD" }, { code: "KM", currency: "USD" },
  { code: "KN", currency: "USD" }, { code: "KR", currency: "KRW" },
  { code: "KW", currency: "USD" }, { code: "KY", currency: "USD" },
  { code: "KZ", currency: "KZT" }, { code: "LA", currency: "USD" },
  { code: "LB", currency: "USD" }, { code: "LC", currency: "USD" },
  { code: "LI", currency: "CHF" }, { code: "LK", currency: "LKR" },
  { code: "LR", currency: "USD" }, { code: "LT", currency: "EUR" },
  { code: "LU", currency: "EUR" }, { code: "LV", currency: "EUR" },
  { code: "LY", currency: "USD" }, { code: "MA", currency: "MAD" },
  { code: "MC", currency: "EUR" }, { code: "MD", currency: "USD" },
  { code: "MK", currency: "USD" }, { code: "ML", currency: "EUR" },
  { code: "MM", currency: "MMK" }, { code: "MN", currency: "MNT" },
  { code: "MO", currency: "MOP" }, { code: "MT", currency: "EUR" },
  { code: "MU", currency: "USD" }, { code: "MV", currency: "USD" },
  { code: "MX", currency: "MXN" }, { code: "MY", currency: "MYR" },
  { code: "MZ", currency: "USD" }, { code: "NA", currency: "USD" },
  { code: "NE", currency: "EUR" }, { code: "NG", currency: "NGN" },
  { code: "NI", currency: "USD" }, { code: "NL", currency: "EUR" },
  { code: "NO", currency: "NOK" }, { code: "NP", currency: "USD" },
  { code: "NZ", currency: "NZD" }, { code: "OM", currency: "USD" },
  { code: "PA", currency: "USD" }, { code: "PE", currency: "PEN" },
  { code: "PG", currency: "USD" }, { code: "PH", currency: "PHP" },
  { code: "PK", currency: "PKR" }, { code: "PL", currency: "PLN" },
  { code: "PT", currency: "EUR" }, { code: "PY", currency: "PYG" },
  { code: "QA", currency: "QAR" }, { code: "RO", currency: "RON" },
  { code: "RS", currency: "RSD" }, { code: "RU", currency: "RUB" },
  { code: "RW", currency: "USD" }, { code: "SA", currency: "SAR" },
  { code: "SB", currency: "USD" }, { code: "SC", currency: "USD" },
  { code: "SE", currency: "SEK" }, { code: "SG", currency: "SGD" },
  { code: "SI", currency: "EUR" }, { code: "SK", currency: "EUR" },
  { code: "SL", currency: "USD" }, { code: "SM", currency: "EUR" },
  { code: "SN", currency: "XOF" }, { code: "SO", currency: "USD" },
  { code: "SR", currency: "USD" }, { code: "SV", currency: "USD" },
  { code: "TC", currency: "USD" }, { code: "TD", currency: "USD" },
  { code: "TG", currency: "EUR" }, { code: "TH", currency: "THB" },
  { code: "TJ", currency: "USD" }, { code: "TM", currency: "USD" },
  { code: "TN", currency: "USD" }, { code: "TO", currency: "USD" },
  { code: "TR", currency: "TRY" }, { code: "TT", currency: "USD" },
  { code: "TW", currency: "TWD" }, { code: "TZ", currency: "TZS" },
  { code: "UA", currency: "UAH" }, { code: "UG", currency: "USD" },
  { code: "US", currency: "USD" }, { code: "UY", currency: "USD" },
  { code: "UZ", currency: "USD" }, { code: "VA", currency: "EUR" },
  { code: "VE", currency: "USD" }, { code: "VG", currency: "USD" },
  { code: "VN", currency: "VND" }, { code: "VU", currency: "USD" },
  { code: "WS", currency: "USD" }, { code: "YE", currency: "USD" },
  { code: "ZA", currency: "ZAR" }, { code: "ZM", currency: "USD" },
  { code: "ZW", currency: "USD" },
];

export interface RegionsVersionCheck {
  pinned: string;
  live: string | null;
  /** True only when Google reported a version AND it differs from the pin. */
  drifted: boolean;
}

/**
 * Compare a live `regionsVersion` against the pinned one.
 *
 * ⚠ A MISSING VERSION IS NOT DRIFT. `regionsVersion` is `string | null` in the
 * helper's own result type (`regions-helper.ts:61`) because the field can be
 * absent from a response. Reporting drift for an absent value would raise a
 * false alarm whenever the SDK shape wobbles, and an alarm that cries wolf is
 * how a real drift gets ignored.
 *
 * ⚠ AND THIS IS A REPORT, NOT A GATE. It must never block an export or a
 * write. A newer catalog is normal and usually harmless; the pin exists so
 * somebody is TOLD to re-measure, not so the tool stops when Google ships a
 * routine update.
 */
export function checkRegionsVersion(
  live: string | null | undefined,
): RegionsVersionCheck {
  const normalised =
    typeof live === "string" && live.trim() !== "" ? live.trim() : null;
  return {
    pinned: PLAY_REGIONS_VERSION,
    live: normalised,
    drifted: normalised !== null && normalised !== PLAY_REGIONS_VERSION,
  };
}
