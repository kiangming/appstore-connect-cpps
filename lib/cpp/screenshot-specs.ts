/**
 * Screenshot size specs — the ONE table every CPP screenshot path reads
 * (arcs `[CPP-bulkimport-ipad-screenshot-sizes]` and
 * `[CPP-bulkimport-iphone-screenshot-sizes]`, designs
 * docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md and
 * docs/cpp-management/design-cpp-bulkimport-iphone-screenshot-sizes.md).
 *
 * CERTAINTY (per row, see `source`).
 * - iPad: sizes per screen group from Apple docs (Manager, 2026-11-06). Group
 *   → `ScreenshotDisplayType` MEASURED for 13" / 11" / 10.5" / 9.7" by the
 *   end-to-end UAT after deploy of `3c0afa3` (reported 2026-11-13): all 24 kit
 *   images landed in the ASC slot of their row, `assetDeliveryState` COMPLETE.
 *   The 12.9" row is NOT measured: Q1 sends its two sizes to 13", so the UAT
 *   put nothing in that set.
 * - iPhone: sizes per screen group from Apple docs (Manager, 2026-11-13). Group
 *   → `ScreenshotDisplayType` INFERRED: 8 groups ↔ the 8 `APP_IPHONE_*` enum
 *   values of the OAS 4.4.1, matched by screen size order. Face ID (medium) →
 *   `APP_IPHONE_58` is inferred BY ELIMINATION (alternative: `APP_IPHONE_61`).
 *   To be measured by the iPhone UAT (docs/cpp-management/uat-iphone-screenshot-sizes.md).
 * - iPhone Duo: the OAS 4.4.1 declares NO display type for it ⇒ its sizes are
 *   refused with their own sentence (Manager D6, BACKLOG `[CPP-iphone-duo-screenshots]`).
 * The OAS declares no pixel sizes at all. If an image ever lands in the wrong
 * slot, fix exactly ONE row here.
 *
 * MERGE-SAFE: two rows MAY share a display type (e.g. the iPhone UAT's
 * fallback "Face ID (medium) → APP_IPHONE_61", the type Dynamic Island
 * (medium) already uses). Then the type gets ONE set holding both rows' images
 * (`groupScreenshots`), accepts the union of both rows' sizes
 * (`sizesForDisplayType`), and shows the FIRST row's label. So that fallback
 * stays a one-row hotfix.
 */
import type { ScreenshotDisplayType } from "@/types/asc";

export type ScreenshotDevice = "iphone" | "ipad";
export type ScreenshotSize = readonly [w: number, h: number];
export type IpadDisplayType = Extract<ScreenshotDisplayType, `APP_IPAD_${string}`>;
export type IphoneDisplayType = Extract<ScreenshotDisplayType, `APP_IPHONE_${string}`>;

export interface ScreenshotSpec<T extends ScreenshotDisplayType = ScreenshotDisplayType> {
  displayType: T;
  label: string;
  sizes: readonly ScreenshotSize[];
  source: string;
}
export type IpadScreenshotSpec = ScreenshotSpec<IpadDisplayType>;
export type IphoneScreenshotSpec = ScreenshotSpec<IphoneDisplayType>;

const MEASURED_BY_UAT = "ĐÃ ĐO qua UAT 2026-11-13 (đường code thật, 3c0afa3)";
const APPLE_DOCS_VIA_MANAGER_NOT_MEASURED =
  "Apple docs via Manager 2026-11-06 — CHƯA ĐO: Q1 gửi 2 kích thước này vào 13\", UAT không đưa ảnh nào vào set này";
const IPHONE_APPLE_DOCS = "Apple docs via Manager 2026-11-13 — map → display type SUY LUẬN, chờ UAT iPhone";
const IPHONE_APPLE_DOCS_BY_ELIMINATION =
  "Apple docs via Manager 2026-11-13 — map → APP_IPHONE_58 SUY LUẬN THEO LOẠI TRỪ (ứng viên thay thế: APP_IPHONE_61), chờ UAT iPhone";

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

/**
 * iPhone, largest screen first (labels = Apple's group names, Manager Q-C).
 * No size belongs to two groups (census C3), so the order only sets the order
 * of the sets in Preview and in the upload.
 */
export const IPHONE_SCREENSHOT_SPECS: readonly IphoneScreenshotSpec[] = [
  {
    displayType: "APP_IPHONE_67",
    label: "iPhone Dynamic Island (large)",
    sizes: [[1260, 2736], [2736, 1260], [1290, 2796], [2796, 1290], [1320, 2868], [2868, 1320]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_65",
    label: "iPhone Face ID (large)",
    sizes: [[1284, 2778], [2778, 1284], [1242, 2688], [2688, 1242]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_61",
    label: "iPhone Dynamic Island (medium)",
    sizes: [[1179, 2556], [2556, 1179], [1206, 2622], [2622, 1206]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_58",
    label: "iPhone Face ID (medium)",
    sizes: [[1170, 2532], [2532, 1170], [1125, 2436], [2436, 1125], [1080, 2340], [2340, 1080]],
    source: IPHONE_APPLE_DOCS_BY_ELIMINATION,
  },
  {
    displayType: "APP_IPHONE_55",
    label: "iPhone Home Button (large)",
    sizes: [[1242, 2208], [2208, 1242]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_47",
    label: "iPhone Home Button (medium)",
    sizes: [[750, 1334], [1334, 750]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_40",
    label: 'iPhone Home Button (4")',
    sizes: [[640, 1096], [640, 1136], [1136, 600], [1136, 640]],
    source: IPHONE_APPLE_DOCS,
  },
  {
    displayType: "APP_IPHONE_35",
    label: 'iPhone Home Button (3.5")',
    sizes: [[640, 920], [640, 960], [960, 600], [960, 640]],
    source: IPHONE_APPLE_DOCS,
  },
];

/**
 * iPhone Duo (outer 1398×2034 · 2034×1398, inner 2007×2853 · 2853×2007) —
 * Apple docs via Manager 2026-11-13. NOT uploadable: the OAS 4.4.1 has no
 * display type for it (Manager D6). Refused with `IPHONE_DUO_REFUSAL`.
 */
export const IPHONE_DUO_SIZES: readonly ScreenshotSize[] = [
  [1398, 2034], [2034, 1398], [2007, 2853], [2853, 2007],
];

/** Every iPhone size the tool uploads (all 8 groups; not Duo). */
export const IPHONE_SCREENSHOT_SIZES: readonly ScreenshotSize[] = IPHONE_SCREENSHOT_SPECS.flatMap((s) => s.sizes);

/** Apple requires this set for apps that run on iPad (Manager Q3: warn, never block). */
export const IPAD_REQUIRED_DISPLAY_TYPE: IpadDisplayType = "APP_IPAD_PRO_3GEN_129";

/**
 * The display type of the iPhone row with this Apple group label. Read FROM
 * the row (not hard-coded) so a one-row hotfix of that row's display type
 * carries over to the default (D5) and the required types (D3). Throws at
 * module load if the row is gone — fail loud, never a silent stale constant.
 */
function iphoneTypeOfGroup(label: string): IphoneDisplayType {
  const row = IPHONE_SCREENSHOT_SPECS.find((s) => s.label === label);
  if (!row) throw new Error(`screenshot-specs: no iPhone row labelled "${label}"`);
  return row.displayType;
}

/**
 * Apple requires one of these for apps that run on iPhone: Dynamic Island
 * (large), or Face ID (large) when there is no Dynamic Island (large) (Manager
 * D3: warn, never block).
 */
export const IPHONE_REQUIRED_DISPLAY_TYPES: readonly IphoneDisplayType[] = [
  iphoneTypeOfGroup("iPhone Dynamic Island (large)"),
  iphoneTypeOfGroup("iPhone Face ID (large)"),
];

/**
 * The iPhone set the editor offers when a locale has none yet — Dynamic Island
 * (large) (Manager D5). Bulk import never uses it: there the type comes from
 * the image size.
 */
export const IPHONE_DEFAULT_DISPLAY_TYPE: IphoneDisplayType = iphoneTypeOfGroup("iPhone Dynamic Island (large)");

/** Max screenshots per set (Apple docs; the OAS declares no `maxItems`). */
export const MAX_SCREENSHOTS_PER_SET = 10;

/** Manager Q-D, verbatim after the size. */
const IPHONE_DUO_REFUSAL =
  "is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.";

/** One label per display type — the FIRST row's when two rows share a type (merge-safe). */
export function labelsOf(specs: readonly ScreenshotSpec[]): Record<ScreenshotDisplayType, string> {
  return specs.reduce(
    (labels, s) => (s.displayType in labels ? labels : { ...labels, [s.displayType]: s.label }),
    {} as Record<ScreenshotDisplayType, string>,
  );
}

export const SCREENSHOT_DISPLAY_TYPE_LABELS = labelsOf([...IPHONE_SCREENSHOT_SPECS, ...IPAD_SCREENSHOT_SPECS]);

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

function specsFor(device: ScreenshotDevice): readonly ScreenshotSpec[] {
  return device === "ipad" ? IPAD_SCREENSHOT_SPECS : IPHONE_SCREENSHOT_SPECS;
}

/** The iPad spec a size belongs to (first in precedence order), or null. */
export function classifyIpadScreenshot(w: number, h: number): IpadScreenshotSpec | null {
  return IPAD_SCREENSHOT_SPECS.find((s) => hasSize(s.sizes, w, h)) ?? null;
}

/** The iPhone spec a size belongs to, or null (Duo sizes ⇒ null). */
export function classifyIphoneScreenshot(w: number, h: number): IphoneScreenshotSpec | null {
  return IPHONE_SCREENSHOT_SPECS.find((s) => hasSize(s.sizes, w, h)) ?? null;
}

/** The spec of the device folder a size belongs to, or null. */
export function classifyScreenshot(device: ScreenshotDevice, w: number, h: number): ScreenshotSpec | null {
  return device === "ipad" ? classifyIpadScreenshot(w, h) : classifyIphoneScreenshot(w, h);
}

export function isIphoneDuoSize(w: number, h: number): boolean {
  return hasSize(IPHONE_DUO_SIZES, w, h);
}

/** Every row of `type` in `specs`, sizes concatenated in table order (merge-safe). */
export function sizesOfTypeIn(specs: readonly ScreenshotSpec[], type: ScreenshotDisplayType): readonly ScreenshotSize[] {
  return specs.filter((s) => s.displayType === type).flatMap((s) => s.sizes);
}

/** Sizes accepted into a set of this display type (editor: the TARGET set). */
export function sizesForDisplayType(type: ScreenshotDisplayType): readonly ScreenshotSize[] {
  return sizesOfTypeIn(isIpadDisplayType(type) ? IPAD_SCREENSHOT_SPECS : IPHONE_SCREENSHOT_SPECS, type);
}

function validSizesSentence(device: ScreenshotDevice): string {
  const prefix = device === "ipad" ? /^iPad / : /^iPhone /;
  const name = device === "ipad" ? "iPad" : "iPhone";
  const valid = specsFor(device)
    .map((s) => `${s.label.replace(prefix, "")}: ${formatSizes(s.sizes)}`)
    .join(" · ");
  return `Valid ${name} sizes — ${valid}`;
}

/**
 * Bulk import: is this a valid image for the device folder it sits in?
 * Returns the error sentence (design iPad §4.3; iPhone Q-D) or null.
 * - ipad/: hint when the image is one of the iPhone table's sizes (Q-A).
 * - iphone/: Duo sizes get their own sentence (D6); hint when the image is an
 *   iPad size (D8).
 */
export function screenshotSizeError(device: ScreenshotDevice, w: number, h: number): string | null {
  if (classifyScreenshot(device, w, h)) return null;
  if (device === "iphone" && isIphoneDuoSize(w, h)) return `${w}×${h} ${IPHONE_DUO_REFUSAL}`;
  const hint =
    device === "ipad"
      ? hasSize(IPHONE_SCREENSHOT_SIZES, w, h)
        ? " — this looks like an iPhone screenshot; move it to screenshots/iphone/"
        : ""
      : classifyIpadScreenshot(w, h)
        ? " — this looks like an iPad screenshot; move it to screenshots/ipad/"
        : "";
  const name = device === "ipad" ? "iPad" : "iPhone";
  return `${w}×${h} is not a valid ${name} screenshot size${hint}. ${validSizesSentence(device)}`;
}

/**
 * Editor: is this a valid image for the TARGET set? (iPad Q4, iPhone D2 — the
 * editor checks against the set the image is dropped on, not the device.) For
 * a 13" set the sentence is exactly the pre-arc one; when the image belongs to
 * another set of the same device, the sentence names it.
 */
export function screenshotSizeErrorForDisplayType(
  type: ScreenshotDisplayType,
  w: number,
  h: number,
): string | null {
  const sizes = sizesForDisplayType(type);
  if (hasSize(sizes, w, h)) return null;
  const ipad = isIpadDisplayType(type);
  if (!ipad && isIphoneDuoSize(w, h)) return `${w}×${h} ${IPHONE_DUO_REFUSAL}`;
  const base = `Resolution: got ${w}×${h} — expected one of: ${formatSizes(sizes)}`;
  const other = ipad ? classifyIpadScreenshot(w, h) : classifyIphoneScreenshot(w, h);
  return other ? `${base} — this is an ${other.label} size, not ${displayTypeLabel(type)}` : base;
}
