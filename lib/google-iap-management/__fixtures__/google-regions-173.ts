/**
 * ⚠ THE 173 REGIONS GOOGLE PLAY ACTUALLY SELLS IN — measured, not invented.
 *
 * Provenance, so the next person can re-derive rather than trust:
 *   • Measurement M1, run by the Manager 2026-09-01 against production:
 *     `GET /api/google-iap-management/regions/catalog?packageName=<cached>`
 *     → 173 `{regionCode, currency}` entries, `regionsVersion: "2025/03"`.
 *     That route makes exactly one `monetization.convertRegionPrices` call
 *     (`google/regions-helper.ts:85`), which is Google's own canonical
 *     "every supported region" answer.
 *   • Census Q7 over `google_iap_mgmt.iap_prices` (308,933 price rows,
 *     1,794 IAPs) returned 173 distinct codes — and the two sets match
 *     100%, 0 codes differing in either direction.
 *   • Reconstructed here from the census arithmetic, which closes exactly:
 *     183 shared-catalog codes − 25 catalog-only + 15 Google-only = 173,
 *     and 158 + 25 = 183, 158 + 15 = 173.
 *
 * ⚠ THIS IS A TEST FIXTURE, NOT THE PRODUCTION CATALOG. It carries codes
 * only — M1 also returned a currency per region, which this chunk does not
 * need. Chunk X4 promotes the measurement to a real pinned snapshot module
 * (codes + currency + `regionsVersion` + the refresh command). When it does,
 * THIS ARRAY MUST BE DELETED and the snapshot imported instead — two copies
 * of a measured set is exactly the drift this arc exists to remove.
 *
 * ⚠ 183 IS NOT THIS LIST AND MUST NOT BE USED HERE. `TERRITORY_CATALOG`
 * (`lib/iap-management/territory-catalog.ts`) is a hand-typed constant in the
 * APPLE module; the Google export dialog reaches it only through an
 * unpassed default parameter, which is the R2 defect X4 removes.
 */
export const GOOGLE_REGIONS_173: readonly string[] = [
  "AE", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AW", "AZ", "BA", "BD",
  "BE", "BF", "BG", "BH", "BJ", "BM", "BO", "BR", "BS", "BW", "BY", "BZ",
  "CA", "CD", "CF", "CG", "CH", "CI", "CL", "CM", "CO", "CR", "CV", "CY",
  "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "ER", "ES",
  "FI", "FJ", "FM", "FR", "GA", "GB", "GD", "GE", "GH", "GI", "GM", "GN",
  "GR", "GT", "GW", "HK", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IN",
  "IQ", "IS", "IT", "JM", "JO", "JP", "KE", "KG", "KH", "KM", "KN", "KR",
  "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LT", "LU", "LV",
  "LY", "MA", "MC", "MD", "MK", "ML", "MM", "MN", "MO", "MT", "MU", "MV",
  "MX", "MY", "MZ", "NA", "NE", "NG", "NI", "NL", "NO", "NP", "NZ", "OM",
  "PA", "PE", "PG", "PH", "PK", "PL", "PT", "PY", "QA", "RO", "RS", "RU",
  "RW", "SA", "SB", "SC", "SE", "SG", "SI", "SK", "SL", "SM", "SN", "SO",
  "SR", "SV", "TC", "TD", "TG", "TH", "TJ", "TM", "TN", "TO", "TR", "TT",
  "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VE", "VG", "VN", "VU",
  "WS", "YE", "ZA", "ZM", "ZW",
];
