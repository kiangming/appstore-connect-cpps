/**
 * Screenshot set routing + upload, SHARED by both bulk-import dialogs
 * (CppBulkImportDialog — many CPPs, BulkImportDialog — one CPP). Arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]`, Manager Q4 = S3 / Q5: before this
 * arc each dialog carried its own copy of this logic and every iPad image of a
 * locale went into ONE set picked from existing sets; now each iPad image goes
 * to the set of the display type its SIZE maps to.
 *
 * Arc `[CPP-bulkimport-iphone-screenshot-sizes]` (Manager D1): iPhone images
 * take the SAME path — classified by size, one set per display type, an
 * existing set of the same type reused. The old iPhone rule (last iPhone set /
 * first ready locale's / APP_IPHONE_65) is gone.
 */
import type { AppScreenshotSet, ScreenshotDisplayType } from "@/types/asc";
import {
  IPAD_REQUIRED_DISPLAY_TYPE,
  IPAD_SCREENSHOT_SPECS,
  IPHONE_REQUIRED_DISPLAY_TYPES,
  IPHONE_SCREENSHOT_SPECS,
  MAX_SCREENSHOTS_PER_SET,
  displayTypeLabel,
  type ScreenshotDevice,
} from "@/lib/cpp/screenshot-specs";

export interface ScreenshotGroup {
  displayType: ScreenshotDisplayType;
  files: File[];
}

/**
 * Group classified images of one device folder by display type. Groups follow
 * the spec order (iPad 13" first; iPhone Dynamic Island (large) first); files
 * keep the order they were given in (file-name order from the folder parsers).
 * Items of a display type not in `specs` are dropped. ONE group per display
 * type even when several rows share it (merge-safe, see screenshot-specs.ts).
 */
export function groupBySpecs(
  specs: ReadonlyArray<{ displayType: ScreenshotDisplayType }>,
  items: Array<{ file: File; displayType: ScreenshotDisplayType }>,
): ScreenshotGroup[] {
  const groups: ScreenshotGroup[] = [];
  const seen = new Set<ScreenshotDisplayType>();
  for (const { displayType } of specs) {
    if (seen.has(displayType)) continue;
    seen.add(displayType);
    const files = items.filter((i) => i.displayType === displayType).map((i) => i.file);
    if (files.length > 0) groups.push({ displayType, files });
  }
  return groups;
}

export function groupScreenshots(
  device: ScreenshotDevice,
  items: Array<{ file: File; displayType: ScreenshotDisplayType }>,
): ScreenshotGroup[] {
  return groupBySpecs(device === "ipad" ? IPAD_SCREENSHOT_SPECS : IPHONE_SCREENSHOT_SPECS, items);
}

export function groupIpadScreenshots(
  items: Array<{ file: File; displayType: ScreenshotDisplayType }>,
): ScreenshotGroup[] {
  return groupScreenshots("ipad", items);
}

interface ScreenshotSetsResponse {
  data?: AppScreenshotSet[];
  included?: Array<{ type: string; id: string }>;
}

/**
 * Screenshots already in each set, from one `GET …/appScreenshotSets
 * ?include=appScreenshots&limit[appScreenshots]=50` response.
 *
 * Not from `relationships.appScreenshots.data` alone: Apple has been seen to
 * cut that relationship list while `included` stays complete (IAP KB §4.1).
 * But an included screenshot carries NO link back to its set (JSON:API —
 * CLAUDE.md "JSON:API quy tắc"), so a set's own id list is the only thing
 * that says which included screenshot is whose. Hence:
 *   - per set: max(its id list's length, `meta.paging.total` when Apple sends it);
 *   - included screenshots that NO set lists = the cut list's fingerprint:
 *     one set ⇒ they are all that set's (count = every included screenshot);
 *     several sets ⇒ which set is unknown ⇒ `null` — no count, no
 *     required-set warning, rather than a guess (KB P7).
 */
export function countScreenshotsPerSet(
  d: ScreenshotSetsResponse,
): Map<ScreenshotDisplayType, number> | null {
  const sets = d.data ?? [];
  const included = (d.included ?? []).filter((r) => r.type === "appScreenshots");
  const listed = new Set<string>();
  const counts = new Map<ScreenshotDisplayType, number>();
  for (const set of sets) {
    const rel = (set.relationships as {
      appScreenshots?: { data?: Array<{ id: string }>; meta?: { paging?: { total?: number } } };
    } | undefined)?.appScreenshots;
    const ids = (rel?.data ?? []).map((r) => r.id);
    ids.forEach((id) => listed.add(id));
    counts.set(set.attributes.screenshotDisplayType, Math.max(ids.length, rel?.meta?.paging?.total ?? 0));
  }
  const unlisted = included.filter((s) => !listed.has(s.id)).length;
  if (unlisted > 0) {
    if (sets.length !== 1) return null;
    const only = sets[0].attributes.screenshotDisplayType;
    counts.set(only, Math.max(counts.get(only) ?? 0, included.length));
  }
  return counts;
}

/**
 * Existing screenshot count per display type of a localization, read once at
 * Preview. `null` = could not be read or not attributable (the caller then
 * skips the required-set warning rather than guess — KB P7, prefer a missed
 * signal over a wrong one).
 */
export async function fetchExistingScreenshotCounts(
  localizationId: string,
): Promise<Map<ScreenshotDisplayType, number> | null> {
  try {
    const res = await fetch(`/api/asc/screenshot-sets?localizationId=${localizationId}`);
    if (!res.ok) return null;
    return countScreenshotsPerSet((await res.json()) as ScreenshotSetsResponse);
  } catch {
    return null;
  }
}

const REQUIRED_WARNING: Record<ScreenshotDevice, string> = {
  ipad: `No iPad 13" screenshots — Apple requires iPad 13" screenshots for apps that run on iPad. Import is not blocked.`,
  // Manager Q-D, verbatim.
  iphone:
    "No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.",
};

const REQUIRED_TYPES: Record<ScreenshotDevice, readonly ScreenshotDisplayType[]> = {
  ipad: [IPAD_REQUIRED_DISPLAY_TYPE],
  iphone: IPHONE_REQUIRED_DISPLAY_TYPES,
};

/**
 * Preview checks for a locale's groups of one device (iPad Q3 + Q4; iPhone
 * D3 + D7):
 * - error (blocks): more than 10 screenshots for one display type, counting
 *   the ones already on Apple when known;
 * - warning (never blocks): the locale will have screenshots of this device
 *   but none of its REQUIRED set(s) after the import (iPad 13"; iPhone Dynamic
 *   Island (large) or Face ID (large)). Skipped when the existing sets could
 *   not be read (`null`) rather than guessed (KB P7).
 */
export function checkScreenshotGroups(
  device: ScreenshotDevice,
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
  const required = REQUIRED_TYPES[device];
  const hasRequired = required.some(
    (t) => groups.some((g) => g.displayType === t) || (existing?.has(t) ?? false),
  );
  if (groups.length > 0 && existing !== null && !hasRequired) {
    warnings.push(REQUIRED_WARNING[device]);
  }
  return { errors, warnings };
}

export function checkIpadGroups(
  groups: ScreenshotGroup[],
  existing: Map<ScreenshotDisplayType, number> | null,
): { errors: string[]; warnings: string[] } {
  return checkScreenshotGroups("ipad", groups, existing);
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
