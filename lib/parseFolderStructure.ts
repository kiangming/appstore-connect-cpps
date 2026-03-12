import { localeCodeFromName } from "@/lib/locale-utils";

export interface ParsedLocaleData {
  locale: string;
  promoTextFile: File | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
}

const LOCALE_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

function resolveLocale(folderName: string): string | undefined {
  const fromMap = localeCodeFromName(folderName);
  if (fromMap) return fromMap;
  if (LOCALE_REGEX.test(folderName)) return folderName;
  return undefined;
}

export function parseFolderStructure(files: File[]): ParsedLocaleData[] {
  const localeMap = new Map<string, ParsedLocaleData>();

  for (const file of files) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
      file.name;

    const parts = relativePath.split("/").filter(Boolean);
    // Skip hidden files/folders (any segment starting with "." — e.g. .DS_Store, .gitkeep)
    if (parts.some((p) => p.startsWith("."))) continue;
    // Expect at least: <root>/<locale>/<something>
    if (parts.length < 3) continue;

    // parts[0] = root folder, parts[1] = locale folder name (friendly or short-code)
    const folderName = parts[1];
    if (!folderName || folderName.startsWith(".")) continue;

    const locale = resolveLocale(folderName);
    if (!locale) continue;

    if (!localeMap.has(locale)) {
      localeMap.set(locale, {
        locale,
        promoTextFile: null,
        screenshotFiles: { iphone: [], ipad: [] },
        previewFiles: { iphone: [], ipad: [] },
      });
    }

    const data = localeMap.get(locale)!;
    const sub = parts.slice(2); // parts after <root>/<locale>/

    if (sub.length === 1 && sub[0].toLowerCase() === "promo.txt") {
      data.promoTextFile = file;
    } else if (sub[0]?.toLowerCase() === "screenshots" && sub.length === 3) {
      const device = sub[1].toLowerCase();
      if (device === "iphone") data.screenshotFiles.iphone.push(file);
      else if (device === "ipad") data.screenshotFiles.ipad.push(file);
    } else if (sub[0]?.toLowerCase() === "previews" && sub.length === 3) {
      const device = sub[1].toLowerCase();
      if (device === "iphone") data.previewFiles.iphone.push(file);
      else if (device === "ipad") data.previewFiles.ipad.push(file);
    }
  }

  const sort = (a: File, b: File) => a.name.localeCompare(b.name);
  for (const data of localeMap.values()) {
    data.screenshotFiles.iphone.sort(sort);
    data.screenshotFiles.ipad.sort(sort);
    data.previewFiles.iphone.sort(sort);
    data.previewFiles.ipad.sort(sort);
  }

  return Array.from(localeMap.values());
}
