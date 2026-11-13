/**
 * Screenshot size specs — the ONE table every CPP screenshot path reads
 * (arc `[CPP-bulkimport-ipad-screenshot-sizes]`, design
 * docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md §P4, §P6-chốt).
 *
 * CERTAINTY (per row, see `source`). Sizes per screen group: Apple docs, as
 * listed by Manager on 2026-11-06. Group → `ScreenshotDisplayType`: MEASURED
 * for 13" / 11" / 10.5" / 9.7" by the end-to-end UAT after deploy of
 * `3c0afa3` (docs/cpp-management/uat-ipad-screenshot-sizes.md, reported
 * 2026-11-13): every one of the 24 kit images landed in the ASC slot of its
 * row, `assetDeliveryState` COMPLETE for all 24. The 12.9" row is NOT
 * measured: Q1 sends its two sizes to 13", so the UAT put nothing in that set
 * (its slot stayed empty, as intended). The OAS (4.4.1) declares no pixel
 * sizes. If an image ever lands in the wrong slot, fix exactly ONE row here.
 *
 * iPhone is out of scope (Q6, BACKLOG `[CPP-iphone-screenshot-sizes]`): the
 * four 6.5" sizes are kept as a device-level list, and iPhone images are still
 * routed by existing set / default, not by size.
 */
import type { ScreenshotDisplayType } from "@/types/asc";

export type ScreenshotDevice = "iphone" | "ipad";
export type ScreenshotSize = readonly [w: number, h: number];
export type IpadDisplayType = Extract<ScreenshotDisplayType, `APP_IPAD_${string}`>;

export interface IpadScreenshotSpec {
  displayType: IpadDisplayType;
  label: string;
  sizes: readonly ScreenshotSize[];
  source: string;
}

const MEASURED_BY_UAT = "ĐÃ ĐO qua UAT 2026-11-13 (đường code thật, 3c0afa3)";
const APPLE_DOCS_VIA_MANAGER_NOT_MEASURED =
  "Apple docs via Manager 2026-11-06 — CHƯA ĐO: Q1 gửi 2 kích thước này vào 13\", UAT không đưa ảnh nào vào set này";

/**
 * Order = precedence when one size belongs to several groups. 2048×2732 and
 * 2732×2048 are both 13" and 12.9"; Manager Q1 = they always go to 13".
 */
export const IPAD_SCREENSHOT_SPECS: readonly IpadScreenshotSpec[] = [
  {
    displayType: "APP_IPAD_PRO_3GEN_129",
    label: 'iPad 13"',
    sizes: [[2064, 2752], [2752, 2064], [2048, 2732], [2732, 2048]],
    source: MEASURED_BY_UAT,
  },
  {
    displayType: "APP_IPAD_PRO_129",
    label: 'iPad 12.9"',
    sizes: [[2048, 2732], [2732, 2048]],
    source: APPLE_DOCS_VIA_MANAGER_NOT_MEASURED,
  },
  {
    displayType: "APP_IPAD_PRO_3GEN_11",
    label: 'iPad 11"',
    sizes: [
      [1488, 2266], [2266, 1488], [1512, 2316], [2316, 1512], [1668, 2420],
      [2420, 1668], [1668, 2388], [2388, 1668], [1640, 2360], [2360, 1640],
    ],
    source: MEASURED_BY_UAT,
  },
  {
    displayType: "APP_IPAD_105",
    label: 'iPad 10.5"',
    sizes: [[1668, 2224], [2224, 1668]],
    source: MEASURED_BY_UAT,
  },
  {
    displayType: "APP_IPAD_97",
    label: 'iPad 9.7"',
    sizes: [
      [1536, 2008], [1536, 2048], [2048, 1496], [2048, 1536],
      [768, 1004], [768, 1024], [1024, 748], [1024, 768],
    ],
    source: MEASURED_BY_UAT,
  },
];

/** iPhone — unchanged by this arc (device-level, no display type). */
export const IPHONE_SCREENSHOT_SIZES: readonly ScreenshotSize[] = [
  [1284, 2778], [2778, 1284], [1242, 2688], [2688, 1242],
];

/** Apple requires this set for apps that run on iPad (Manager Q3: warn, never block). */
export const IPAD_REQUIRED_DISPLAY_TYPE: IpadDisplayType = "APP_IPAD_PRO_3GEN_129";

/** Max screenshots per set (Apple docs; the OAS declares no `maxItems`). */
export const MAX_SCREENSHOTS_PER_SET = 10;

const IPAD_LABELS = Object.fromEntries(
  IPAD_SCREENSHOT_SPECS.map((s) => [s.displayType, s.label]),
) as Record<IpadDisplayType, string>;

export const SCREENSHOT_DISPLAY_TYPE_LABELS: Record<ScreenshotDisplayType, string> = {
  APP_IPHONE_67: 'iPhone 6.7"',
  APP_IPHONE_65: 'iPhone 6.5"',
  APP_IPHONE_61: 'iPhone 6.1"',
  APP_IPHONE_55: 'iPhone 5.5"',
  APP_IPHONE_47: 'iPhone 4.7"',
  APP_IPHONE_40: 'iPhone 4"',
  APP_IPHONE_35: 'iPhone 3.5"',
  ...IPAD_LABELS,
};

export function displayTypeLabel(type: ScreenshotDisplayType): string {
  return SCREENSHOT_DISPLAY_TYPE_LABELS[type] ?? type;
}

function hasSize(sizes: readonly ScreenshotSize[], w: number, h: number): boolean {
  return sizes.some(([sw, sh]) => sw === w && sh === h);
}

function formatSizes(sizes: readonly ScreenshotSize[]): string {
  return sizes.map(([w, h]) => `${w}×${h}`).join(", ");
}

function isIpadDisplayType(type: ScreenshotDisplayType): type is IpadDisplayType {
  return type.startsWith("APP_IPAD");
}

/** The iPad spec a size belongs to (first in precedence order), or null. */
export function classifyIpadScreenshot(w: number, h: number): IpadScreenshotSpec | null {
  return IPAD_SCREENSHOT_SPECS.find((s) => hasSize(s.sizes, w, h)) ?? null;
}

/** Sizes accepted into a set of this display type. */
export function sizesForDisplayType(type: ScreenshotDisplayType): readonly ScreenshotSize[] {
  if (!isIpadDisplayType(type)) return IPHONE_SCREENSHOT_SIZES;
  return IPAD_SCREENSHOT_SPECS.find((s) => s.displayType === type)?.sizes ?? [];
}

/**
 * Bulk import: is this a valid image for the device folder it sits in?
 * Returns the error sentence (design §4.3) or null. The iPhone sentence is
 * today's, unchanged (iPhone out of scope).
 */
export function screenshotSizeError(device: ScreenshotDevice, w: number, h: number): string | null {
  if (device === "iphone") {
    if (hasSize(IPHONE_SCREENSHOT_SIZES, w, h)) return null;
    return `Resolution: got ${w}×${h} — expected one of: ${formatSizes(IPHONE_SCREENSHOT_SIZES)}`;
  }
  if (classifyIpadScreenshot(w, h)) return null;
  const hint = hasSize(IPHONE_SCREENSHOT_SIZES, w, h)
    ? " — this looks like an iPhone screenshot; move it to screenshots/iphone/"
    : "";
  const valid = IPAD_SCREENSHOT_SPECS.map(
    (s) => `${s.label.replace(/^iPad /, "")}: ${formatSizes(s.sizes)}`,
  ).join(" · ");
  return `${w}×${h} is not a valid iPad screenshot size${hint}. Valid iPad sizes — ${valid}`;
}

/**
 * Editor: is this a valid image for the TARGET set? (Manager Q4 — the editor
 * checks against the set the image is dropped on, not the device.) For a 13"
 * set the sentence is exactly today's.
 */
export function screenshotSizeErrorForDisplayType(
  type: ScreenshotDisplayType,
  w: number,
  h: number,
): string | null {
  const sizes = sizesForDisplayType(type);
  if (hasSize(sizes, w, h)) return null;
  const base = `Resolution: got ${w}×${h} — expected one of: ${formatSizes(sizes)}`;
  if (!isIpadDisplayType(type)) return base;
  const other = classifyIpadScreenshot(w, h);
  return other ? `${base} — this is an ${other.label} size, not ${displayTypeLabel(type)}` : base;
}
