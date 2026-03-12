import localeMapJson from "@/lib/locale-map.json";

// name → code  (e.g. "Vietnamese" → "vi")
const nameToCode: Record<string, string> = localeMapJson;

// code → name  (e.g. "vi" → "Vietnamese")
const codeToName: Record<string, string> = Object.fromEntries(
  Object.entries(localeMapJson).map(([name, code]) => [code, name])
);

/**
 * Resolve a locale short-code from a user-friendly Apple locale name.
 * Returns undefined if the name is not in the map.
 * e.g. "English (U.S.)" → "en-US"
 */
export function localeCodeFromName(name: string): string | undefined {
  return nameToCode[name];
}

/**
 * Resolve a user-friendly locale name from a locale short-code.
 * Falls back to the code itself if not found in the map.
 * e.g. "en-US" → "English (U.S.)"
 */
export function localeNameFromCode(code: string): string {
  return codeToName[code] ?? code;
}

/**
 * All Apple locales as { value, label } pairs — for use in dropdowns.
 * Sorted alphabetically by label.
 */
export const ALL_APPLE_LOCALES: { value: string; label: string }[] =
  Object.entries(localeMapJson)
    .map(([name, code]) => ({ value: code, label: name }))
    .sort((a, b) => a.label.localeCompare(b.label));
