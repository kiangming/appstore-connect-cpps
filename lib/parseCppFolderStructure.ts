import { localeCodeFromName } from "@/lib/locale-utils";

export interface ParsedCppLocaleData {
  locale: string;
  promoTextFile: File | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
}

export interface ParsedCppFolder {
  cppName: string;
  deepLinkFile: File | null;
  locales: ParsedCppLocaleData[];
}

export interface ParsedCppStructure {
  /** Root-level primary-locale.txt — shared primary locale for all new CPPs */
  primaryLocaleFile: File | null;
  cpps: ParsedCppFolder[];
}

const LOCALE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/**
 * Resolve a folder name to a BCP-47 locale short-code.
 * Accepts user-friendly Apple names ("Vietnamese", "English (U.S.)")
 * or BCP-47 short-codes directly ("vi", "en-US") for backward compatibility.
 * Returns undefined if the name cannot be resolved.
 */
function resolveLocale(folderName: string): string | undefined {
  const fromMap = localeCodeFromName(folderName);
  if (fromMap) return fromMap;
  if (LOCALE_REGEX.test(folderName)) return folderName;
  return undefined;
}

/**
 * Parse a FileList from a webkitdirectory input where the structure is:
 *
 *   <root>/
 *   ├── primary-locale.txt   ← BCP-47 locale code, shared for ALL CPPs (e.g. "en-US")
 *   ├── <CPP Name>/
 *   │   ├── deeplink.txt     ← optional deep link URL for this CPP
 *   │   ├── English (U.S.)/
 *   │   │   ├── promo.txt
 *   │   │   ├── screenshots/iphone/
 *   │   │   ├── screenshots/ipad/
 *   │   │   ├── previews/iphone/
 *   │   │   └── previews/ipad/
 *   │   └── Vietnamese/
 *   │       └── ...
 *   └── <Another CPP>/
 *       └── ...
 *
 * Locale folder names can be Apple user-friendly names ("Vietnamese", "English (U.S.)")
 * or BCP-47 short-codes ("vi", "en-US") — both are supported.
 * Folders starting with "_" or "." are skipped.
 * Hidden files/folders (any path segment starting with ".") are also skipped.
 */
export function parseCppFolderStructure(files: File[]): ParsedCppStructure {
  let primaryLocaleFile: File | null = null;

  // Map: CPP name → (resolved locale code → data)
  const cppMap = new Map<
    string,
    {
      deepLinkFile: File | null;
      localeMap: Map<
        string,
        {
          promoTextFile: File | null;
          screenshotFiles: { iphone: File[]; ipad: File[] };
          previewFiles: { iphone: File[]; ipad: File[] };
        }
      >;
    }
  >();

  function getOrCreateCpp(cppName: string) {
    if (!cppMap.has(cppName)) {
      cppMap.set(cppName, { deepLinkFile: null, localeMap: new Map() });
    }
    return cppMap.get(cppName)!;
  }

  for (const file of files) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
      file.name;

    const parts = relativePath.split("/").filter(Boolean);
    // Skip hidden files/folders (any segment starting with "." — e.g. .DS_Store, .gitkeep)
    if (parts.some((p) => p.startsWith("."))) continue;

    // ── Root-level primary-locale.txt: <root>/primary-locale.txt ──────────
    if (parts.length === 2 && parts[1].toLowerCase() === "primary-locale.txt") {
      primaryLocaleFile = file;
      continue;
    }

    // Need at least: <root>/<cppName>/...
    if (parts.length < 2) continue;

    // parts[0] = root folder (ignored), parts[1] = CPP folder name
    const cppName = parts[1];
    if (!cppName || cppName.startsWith("_") || cppName.startsWith(".")) continue;

    const cppEntry = getOrCreateCpp(cppName);

    // parts[2] = locale folder name / deeplink.txt / other
    const segment2 = parts[2];
    if (!segment2) continue;

    // ── CPP-level deeplink.txt: <root>/<cppName>/deeplink.txt ─────────────
    if (parts.length === 3 && segment2.toLowerCase() === "deeplink.txt") {
      cppEntry.deepLinkFile = file;
      continue;
    }

    // ── Locale content: need <root>/<cppName>/<locale>/... ─────────────────
    if (parts.length < 4) continue;

    if (segment2.startsWith(".")) continue;

    // Resolve folder name → BCP-47 short-code
    const locale = resolveLocale(segment2);
    if (!locale) continue; // skip unrecognised folder names

    if (!cppEntry.localeMap.has(locale)) {
      cppEntry.localeMap.set(locale, {
        promoTextFile: null,
        screenshotFiles: { iphone: [], ipad: [] },
        previewFiles: { iphone: [], ipad: [] },
      });
    }
    const localeData = cppEntry.localeMap.get(locale)!;

    // sub = parts after <root>/<cppName>/<locale>/
    const sub = parts.slice(3);

    if (sub.length === 1 && sub[0].toLowerCase() === "promo.txt") {
      localeData.promoTextFile = file;
    } else if (sub[0]?.toLowerCase() === "screenshots" && sub.length === 3) {
      const device = sub[1].toLowerCase();
      if (device === "iphone") localeData.screenshotFiles.iphone.push(file);
      else if (device === "ipad") localeData.screenshotFiles.ipad.push(file);
    } else if (sub[0]?.toLowerCase() === "previews" && sub.length === 3) {
      const device = sub[1].toLowerCase();
      if (device === "iphone") localeData.previewFiles.iphone.push(file);
      else if (device === "ipad") localeData.previewFiles.ipad.push(file);
    }
  }

  // Sort files lexicographically within each locale
  const sort = (a: File, b: File) => a.name.localeCompare(b.name);
  const cpps: ParsedCppFolder[] = [];

  for (const [cppName, { deepLinkFile, localeMap }] of cppMap) {
    const locales: ParsedCppLocaleData[] = [];
    for (const [locale, data] of localeMap) {
      data.screenshotFiles.iphone.sort(sort);
      data.screenshotFiles.ipad.sort(sort);
      data.previewFiles.iphone.sort(sort);
      data.previewFiles.ipad.sort(sort);
      locales.push({ locale, ...data });
    }
    // Sort locales alphabetically for consistent display
    locales.sort((a, b) => a.locale.localeCompare(b.locale));
    cpps.push({ cppName, deepLinkFile, locales });
  }

  return { primaryLocaleFile, cpps };
}
