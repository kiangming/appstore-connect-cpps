/**
 * D9 [arc-google-missing-purchase-options] — an app's currency / language are
 * values the MANAGER declares. Pure module (no DB, no Google): shared by the
 * declare route, the gate, and client components.
 *
 * Provenance (google_iap_mgmt.apps.default_<field>_source):
 *   "declared" — Manager declared or confirmed it. The ONLY state bulk import accepts.
 *   "guessed"  — written by the tool before 2026-10-16 (guessed from the Play
 *                Console language, or from the first product's US region /
 *                first listing on IAP refresh). Kept, shown, never trusted.
 *   null       — never set.
 *
 * ⚠ Nothing in the code may PRODUCE "guessed" any more (both refresh routes
 *   stopped writing these columns in the same chunk). The literal exists here
 *   only so the read side can name it.
 */
import { PLAY_REGIONS } from "./google/play-regions.snapshot";
import { GOOGLE_LOCALE_OPTIONS } from "./parsers/template-spec";

export const APP_DEFAULT_DECLARED = "declared" as const;
export const APP_DEFAULT_GUESSED = "guessed" as const;
export type AppDefaultSource = typeof APP_DEFAULT_DECLARED | typeof APP_DEFAULT_GUESSED;

export type AppDefaultField = "currency" | "language";
export const APP_DEFAULT_FIELDS: readonly AppDefaultField[] = ["currency", "language"];

export interface AppDefaultValue {
  value: string | null;
  source: AppDefaultSource | null;
}

export interface AppDefaultsState {
  currency: AppDefaultValue;
  language: AppDefaultValue;
}

export function isDeclared(v: AppDefaultValue): boolean {
  return v.source === APP_DEFAULT_DECLARED && !!v.value;
}

/** Fields that block bulk import (not declared — guessed or empty). */
export function undeclaredFields(state: AppDefaultsState): AppDefaultField[] {
  return APP_DEFAULT_FIELDS.filter((f) => !isDeclared(state[f]));
}

/** Currencies Google Play actually bills in (measured snapshot, 173 regions). */
export const DECLARABLE_CURRENCIES: readonly string[] = Array.from(
  new Set(PLAY_REGIONS.map((r) => r.currency)),
).sort();

/**
 * Google Play listing locales THIS TOOL supports (82 — the template's list).
 * ⚠ Not proven to be every locale Play accepts (P38: a vendor list is what the
 *   API agrees with — not measured). An app whose real default language is
 *   outside it cannot be declared yet; widen the list from a measurement.
 */
export const DECLARABLE_LANGUAGES: readonly string[] = GOOGLE_LOCALE_OPTIONS.map((o) => o.code);

/**
 * Validate a declared value. Returns the canonical value or an error message.
 * Currency: an ISO code Google Play bills in (case-normalised to upper).
 * Language: one of DECLARABLE_LANGUAGES, case-normalised to the list's own
 *   spelling ("EN-US" → "en-US"); never a guessed region ("zh" stays invalid).
 */
export function validateAppDefault(
  field: AppDefaultField,
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `A ${field} value is required.` };
  }
  const v = raw.trim();
  if (field === "currency") {
    const upper = v.toUpperCase();
    if (!DECLARABLE_CURRENCIES.includes(upper)) {
      return {
        ok: false,
        error: `"${v}" is not a currency Google Play bills in. Use a 3-letter code such as USD, TWD, VND.`,
      };
    }
    return { ok: true, value: upper };
  }
  const canonical = DECLARABLE_LANGUAGES.find((code) => code.toLowerCase() === v.toLowerCase());
  if (!canonical) {
    return {
      ok: false,
      error:
        `"${v}" is not one of the ${DECLARABLE_LANGUAGES.length} Google Play locales this tool ` +
        `supports (examples: en-US, zh-TW, vi).`,
    };
  }
  return { ok: true, value: canonical };
}
