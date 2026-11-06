/**
 * Screenshot set routing + upload, SHARED by both bulk-import dialogs
 * (CppBulkImportDialog — many CPPs, BulkImportDialog — one CPP). Arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]`, Manager Q4 = S3 / Q5: before this
 * arc each dialog carried its own copy of this logic and every iPad image of a
 * locale went into ONE set picked from existing sets; now each iPad image goes
 * to the set of the display type its SIZE maps to.
 *
 * iPhone is unchanged: the caller still resolves one iPhone display type
 * (existing set / default) and passes all iPhone files as one group.
 */
import type { AppScreenshotSet, AscApiResponse, ScreenshotDisplayType } from "@/types/asc";
import {
  IPAD_REQUIRED_DISPLAY_TYPE,
  IPAD_SCREENSHOT_SPECS,
  MAX_SCREENSHOTS_PER_SET,
  displayTypeLabel,
} from "@/lib/cpp/screenshot-specs";

export interface ScreenshotGroup {
  displayType: ScreenshotDisplayType;
  files: File[];
}

/**
 * Group classified iPad images by display type. Groups follow the spec order
 * (13" first); files keep the order they were given in (file-name order from
 * the folder parsers).
 */
export function groupIpadScreenshots(
  items: Array<{ file: File; displayType: ScreenshotDisplayType }>,
): ScreenshotGroup[] {
  const groups: ScreenshotGroup[] = [];
  for (const spec of IPAD_SCREENSHOT_SPECS) {
    const files = items.filter((i) => i.displayType === spec.displayType).map((i) => i.file);
    if (files.length > 0) groups.push({ displayType: spec.displayType, files });
  }
  return groups;
}

/**
 * Existing screenshot count per display type of a localization, read once at
 * Preview. `null` = could not be read (the caller then skips the 13" warning
 * rather than guess — KB P7, prefer a missed signal over a wrong one).
 */
export async function fetchExistingScreenshotCounts(
  localizationId: string,
): Promise<Map<ScreenshotDisplayType, number> | null> {
  try {
    const res = await fetch(`/api/asc/screenshot-sets?localizationId=${localizationId}`);
    if (!res.ok) return null;
    const d = (await res.json()) as AscApiResponse<AppScreenshotSet[]>;
    const counts = new Map<ScreenshotDisplayType, number>();
    for (const set of d.data ?? []) {
      const rels = set.relationships as { appScreenshots?: { data?: unknown[] } } | undefined;
      counts.set(set.attributes.screenshotDisplayType, rels?.appScreenshots?.data?.length ?? 0);
    }
    return counts;
  } catch {
    return null;
  }
}

/**
 * Preview checks for a locale's iPad groups (Manager Q3 + Q4):
 * - error (blocks): more than 10 screenshots for one display type, counting
 *   the ones already on Apple when known;
 * - warning (never blocks): the locale will have iPad screenshots but no 13"
 *   set after the import.
 */
export function checkIpadGroups(
  groups: ScreenshotGroup[],
  existing: Map<ScreenshotDisplayType, number> | null,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const g of groups) {
    const already = existing?.get(g.displayType) ?? 0;
    const total = already + g.files.length;
    if (total > MAX_SCREENSHOTS_PER_SET) {
      const detail = already > 0 ? ` (${already} already on Apple + ${g.files.length} new)` : "";
      errors.push(
        `Too many screenshots for ${displayTypeLabel(g.displayType)}: ${total}${detail} — max ${MAX_SCREENSHOTS_PER_SET}`,
      );
    }
  }
  const has13 =
    groups.some((g) => g.displayType === IPAD_REQUIRED_DISPLAY_TYPE) ||
    (existing?.has(IPAD_REQUIRED_DISPLAY_TYPE) ?? false);
  if (groups.length > 0 && existing !== null && !has13) {
    warnings.push(
      `No iPad 13" screenshots — Apple requires iPad 13" screenshots for apps that run on iPad. Import is not blocked.`,
    );
  }
  return { errors, warnings };
}

/**
 * Get-or-create one set per group, then upload its files in order.
 * `setCache` holds the locale's existing sets (display type → set id) and is
 * filled as sets are created — an existing set of the same type is reused,
 * never duplicated.
 */
export async function uploadScreenshotGroups(opts: {
  localizationId: string;
  groups: ScreenshotGroup[];
  setCache: Map<ScreenshotDisplayType, string>;
  retry: (fn: () => Promise<Response>) => Promise<Response>;
  onFile: (name: string) => void;
}): Promise<void> {
  const { localizationId, groups, setCache, retry, onFile } = opts;

  async function getOrCreateSet(type: ScreenshotDisplayType): Promise<string> {
    const cached = setCache.get(type);
    if (cached) return cached;
    const res = await retry(() =>
      fetch("/api/asc/screenshot-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localizationId, screenshotDisplayType: type }),
      }),
    );
    if (!res.ok) {
      if (res.status === 409) {
        const r2 = await fetch(`/api/asc/screenshot-sets?localizationId=${localizationId}`);
        if (r2.ok) {
          const d = (await r2.json()) as { data?: AppScreenshotSet[] };
          const found = d.data?.find((s) => s.attributes.screenshotDisplayType === type);
          if (found) {
            setCache.set(type, found.id);
            return found.id;
          }
        }
      }
      throw new Error(`Failed to get screenshot set for ${type}`);
    }
    const d = (await res.json()) as { data: AppScreenshotSet };
    setCache.set(type, d.data.id);
    return d.data.id;
  }

  for (const { displayType, files } of groups) {
    if (files.length === 0) continue;
    const setId = await getOrCreateSet(displayType);
    for (const file of files) {
      onFile(file.name);
      const fd = new FormData();
      fd.append("screenshotSetId", setId);
      fd.append("file", file);
      const res = await retry(() => fetch("/api/asc/upload", { method: "POST", body: fd }));
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Failed to upload ${file.name}`);
      }
    }
  }
}
