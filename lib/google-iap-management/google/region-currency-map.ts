/**
 * BCP-47 language code → ISO 4217 default currency (Hotfix 4).
 *
 * Used as a fallback when an app has no cached IAPs yet (the ground truth
 * for default_currency comes from existing IAPs' defaultPrice.currency,
 * which we capture opportunistically during inappproducts.list refresh).
 *
 * The map mirrors Google Play Console's "default currency follows
 * developer's payouts country" behaviour for the common cases the
 * Manager's portfolio covers. Unknown locales fall back to USD — the
 * Manager can always edit the field manually in the Create form before
 * submitting, and the IAPs-refresh path will overwrite with ground
 * truth on the next sync.
 */

const LANGUAGE_TO_CURRENCY: Record<string, string> = {
  // English variants
  "en": "USD",
  "en-US": "USD",
  "en-GB": "GBP",
  "en-AU": "AUD",
  "en-CA": "CAD",
  "en-IN": "INR",

  // Vietnamese
  "vi": "VND",
  "vi-VN": "VND",

  // East Asian
  "ja": "JPY",
  "ja-JP": "JPY",
  "ko": "KRW",
  "ko-KR": "KRW",
  "zh-CN": "CNY",
  "zh-TW": "TWD",
  "zh-HK": "HKD",

  // South-East Asian
  "th": "THB",
  "th-TH": "THB",
  "id": "IDR",
  "id-ID": "IDR",
  "ms": "MYR",
  "ms-MY": "MYR",
  "fil": "PHP",
  "tl": "PHP",
  "km": "USD",
  "km-KH": "USD",
  "my": "MMK",
  "my-MM": "MMK",
  "lo": "LAK",
  "lo-LA": "LAK",

  // South Asian
  "hi": "INR",
  "hi-IN": "INR",
  "bn": "BDT",
  "bn-BD": "BDT",
  "ta": "INR",
  "te": "INR",
  "ml": "INR",
  "mr": "INR",
  "gu": "INR",
  "kn": "INR",
  "pa": "INR",
  "ur": "PKR",

  // European
  "de": "EUR",
  "de-DE": "EUR",
  "de-AT": "EUR",
  "de-CH": "CHF",
  "fr": "EUR",
  "fr-FR": "EUR",
  "fr-CA": "CAD",
  "fr-CH": "CHF",
  "es": "EUR",
  "es-ES": "EUR",
  "es-419": "USD",
  "es-MX": "MXN",
  "es-AR": "ARS",
  "es-US": "USD",
  "it": "EUR",
  "it-IT": "EUR",
  "nl": "EUR",
  "nl-NL": "EUR",
  "pt": "EUR",
  "pt-PT": "EUR",
  "pt-BR": "BRL",
  "pl": "PLN",
  "pl-PL": "PLN",
  "ru": "RUB",
  "ru-RU": "RUB",
  "uk": "UAH",
  "tr": "TRY",
  "tr-TR": "TRY",
  "cs": "CZK",
  "cs-CZ": "CZK",
  "sk": "EUR",
  "hu": "HUF",
  "hu-HU": "HUF",
  "ro": "RON",
  "el": "EUR",
  "el-GR": "EUR",
  "sv": "SEK",
  "sv-SE": "SEK",
  "no": "NOK",
  "da": "DKK",
  "da-DK": "DKK",
  "fi": "EUR",
  "fi-FI": "EUR",
  "is": "ISK",
  "et": "EUR",
  "lv": "EUR",
  "lt": "EUR",
  "bg": "BGN",
  "hr": "EUR",
  "sl": "EUR",
  "sr": "RSD",
  "mk": "MKD",
  "sq": "ALL",
  "be": "BYN",

  // Middle East + Africa
  "ar": "USD",
  "iw": "ILS",
  "iw-IL": "ILS",
  "he": "ILS",
  "fa": "IRR",
  "am": "ETB",
  "sw": "KES",
  "af": "ZAR",
  "zu": "ZAR",

  // Other
  "hy": "AMD",
  "hy-AM": "AMD",
  "ka": "GEL",
  "ka-GE": "GEL",
  "kk": "KZT",
  "ky": "KGS",
  "az": "AZN",
  "az-AZ": "AZN",
  "mn": "MNT",
  "ne": "NPR",
  "si": "LKR",
  "rm": "CHF",
  "ca": "EUR",
  "eu": "EUR",
  "gl": "EUR",
  "ga": "EUR",
};

/**
 * Map an app's defaultLanguage (BCP-47) to a sensible default currency.
 * Returns "USD" when the language is unknown — caller decides whether
 * that's an acceptable fallback or should surface as a warning.
 */
export function inferCurrencyFromLanguage(
  language: string | null | undefined,
): string {
  if (!language) return "USD";
  const trimmed = language.trim();
  if (trimmed === "") return "USD";
  if (LANGUAGE_TO_CURRENCY[trimmed]) return LANGUAGE_TO_CURRENCY[trimmed];
  // Try the base language (e.g. "en" from "en-US") in case the input has
  // a region we don't list explicitly.
  const base = trimmed.split("-")[0];
  if (base && LANGUAGE_TO_CURRENCY[base]) return LANGUAGE_TO_CURRENCY[base];
  return "USD";
}

/** Whether a specific BCP-47 code is recognised by the map directly
 *  (used by the UI to decide whether to surface "auto-detected from
 *  language" vs "fell back to USD" copy). */
export function isKnownLanguage(language: string | null | undefined): boolean {
  if (!language) return false;
  const trimmed = language.trim();
  return Boolean(LANGUAGE_TO_CURRENCY[trimmed] || LANGUAGE_TO_CURRENCY[trimmed.split("-")[0] ?? ""]);
}
