export interface ParsedCppLocaleData {
  locale: string;
  promoTextFile: File | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
}

export interface ParsedCppFolder {
  cppName: string;
  locales: ParsedCppLocaleData[];
}

export interface ParsedCppStructure {
  /** Root-level primary-locale.txt — shared primary locale for all new CPPs */
  primaryLocaleFile: File | null;
  cpps: ParsedCppFolder[];
}

const LOCALE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/**
 * Parse a FileList from a webkitdirectory input where the structure is:
 *
 *   <root>/
 *   ├── primary-locale.txt   ← BCP-47 locale code, shared for ALL CPPs (e.g. "en-US")
 *   ├── <CPP Name>/
 *   │   ├── en-US/
 *   │   │   ├── promo.txt
 *   │   │   ├── screenshots/iphone/
 *   │   │   ├── screenshots/ipad/
 *   │   │   ├── previews/iphone/
 *   │   │   └── previews/ipad/
 *   │   └── vi/
 *   │       └── ...
 *   └── <Another CPP>/
 *       └── ...
 *
 * Folders starting with "_" or "." are skipped.
 * Hidden files/folders (any path segment starting with ".") are also skipped.
 */
export function parseCppFolderStructure(files: File[]): ParsedCppStructure {
  let primaryLocaleFile: File | null = null;

  // Map: CPP name → locale map
  const cppMap = new Map<
    string,
    Map<
      string,
      {
        promoTextFile: File | null;
        screenshotFiles: { iphone: File[]; ipad: File[] };
        previewFiles: { iphone: File[]; ipad: File[] };
      }
    >
  >();

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

    if (!cppMap.has(cppName)) {
      cppMap.set(cppName, new Map());
    }
    const localeMap = cppMap.get(cppName)!;

    // parts[2] = locale code or undefined (per-CPP primary-locale.txt no longer used)
    const segment2 = parts[2];
    if (!segment2) continue;

    // ── Locale content: need <root>/<cppName>/<locale>/... ─────────────────
    if (parts.length < 4) continue;

    const locale = segment2;
    if (!locale || locale.startsWith(".")) continue;

    if (!localeMap.has(locale)) {
      localeMap.set(locale, {
        promoTextFile: null,
        screenshotFiles: { iphone: [], ipad: [] },
        previewFiles: { iphone: [], ipad: [] },
      });
    }
    const localeData = localeMap.get(locale)!;

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

  for (const [cppName, localeMap] of cppMap) {
    const locales: ParsedCppLocaleData[] = [];
    for (const [locale, data] of localeMap) {
      if (!LOCALE_REGEX.test(locale)) continue; // skip obviously invalid locale dirs
      data.screenshotFiles.iphone.sort(sort);
      data.screenshotFiles.ipad.sort(sort);
      data.previewFiles.iphone.sort(sort);
      data.previewFiles.ipad.sort(sort);
      locales.push({ locale, ...data });
    }
    // Sort locales alphabetically for consistent display
    locales.sort((a, b) => a.locale.localeCompare(b.locale));
    cpps.push({ cppName, locales });
  }

  return { primaryLocaleFile, cpps };
}
