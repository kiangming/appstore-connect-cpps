/**
 * IAP form validation (IAP.o.6a — Manager Apple workflow alignment).
 *
 * Two-stage Apple workflow:
 *   • Group A — Create on Apple (5 items): refName + productId + type + tier + ≥1 localization
 *   • Group B — Additional for Submit (1 item): screenshot
 *
 * The single-IAP form gates the "Create on Apple" button on Group A.
 * The list-page "Submit Selected" flow uses Apple's GET state as source of
 * truth — local Group B is informational only (Apple may flip MISSING_METADATA
 * even with screenshot if other Apple-side requirements miss).
 */

import type { InAppPurchaseType } from "@/types/iap-management/apple";

export const PRODUCT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const REFERENCE_NAME_MAX = 64;

export interface FormLocalization {
  /** BCP-47 short-code matching lib/locale-map.json values. */
  locale: string;
  display_name: string;
  description: string;
}

export interface IapFormState {
  reference_name: string;
  product_id: string;
  type: InAppPurchaseType | "";
  tier_id: string | null;
  /** Keyed by BCP-47 locale code. Entries with both fields empty are ignored. */
  localizations: Record<string, FormLocalization>;
  /** Screenshot file_name once the file is staged client-side. */
  screenshot_filename: string | null;
}

export type ChecklistKey =
  | "reference_name"
  | "product_id"
  | "type"
  | "tier"
  | "localization"
  | "screenshot";

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ChecklistState {
  items: ChecklistItem[];
  allPassed: boolean;
  passedCount: number;
}

export interface GroupedChecklistState {
  /** Group A — 5 prerequisites for Create on Apple. */
  createItems: ChecklistItem[];
  /** Group B — additional prerequisites for Submit (screenshot, currently 1 item). */
  submitOnlyItems: ChecklistItem[];
  createReady: boolean;
  /** True iff every Group A and Group B item passes. */
  submitReady: boolean;
  createPassedCount: number;
  submitPassedCount: number;
}

export function filledLocalizationCount(
  localizations: Record<string, FormLocalization>,
): number {
  let n = 0;
  for (const v of Object.values(localizations)) {
    if (v.display_name.trim() && v.description.trim()) n++;
  }
  return n;
}

function buildCreateItems(form: IapFormState): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  const refName = form.reference_name.trim();
  items.push({
    key: "reference_name",
    label: "Reference name (≤ 64 chars)",
    passed: refName.length > 0 && refName.length <= REFERENCE_NAME_MAX,
    detail:
      refName.length > REFERENCE_NAME_MAX
        ? `${refName.length}/${REFERENCE_NAME_MAX} chars`
        : refName.length === 0
          ? "required"
          : undefined,
  });

  const productId = form.product_id.trim();
  items.push({
    key: "product_id",
    label: "Product ID (alphanumeric + . _ -)",
    passed: productId.length > 0 && PRODUCT_ID_REGEX.test(productId),
    detail:
      productId.length === 0
        ? "required"
        : !PRODUCT_ID_REGEX.test(productId)
          ? "invalid characters"
          : undefined,
  });

  items.push({
    key: "type",
    label: "Type assigned",
    passed: form.type !== "",
    detail: form.type === "" ? "required" : undefined,
  });

  items.push({
    key: "tier",
    label: "Pricing tier set",
    passed: form.tier_id !== null && form.tier_id !== "",
    detail: !form.tier_id ? "required" : undefined,
  });

  const filledCount = filledLocalizationCount(form.localizations);
  items.push({
    key: "localization",
    label: "≥ 1 localization filled",
    passed: filledCount > 0,
    detail: filledCount > 0 ? `${filledCount} filled` : "required",
  });

  return items;
}

function buildSubmitOnlyItems(form: IapFormState): ChecklistItem[] {
  return [
    {
      key: "screenshot",
      label: "Review screenshot uploaded",
      passed:
        form.screenshot_filename !== null && form.screenshot_filename !== "",
      detail: form.screenshot_filename ? undefined : "required",
    },
  ];
}

function toState(items: ChecklistItem[]): ChecklistState {
  const passedCount = items.filter((i) => i.passed).length;
  return {
    items,
    allPassed: passedCount === items.length,
    passedCount,
  };
}

/**
 * Group A — minimum prerequisites for "Create on Apple". Five items;
 * screenshot deliberately excluded — Apple accepts IAP creation without it
 * and reports MISSING_METADATA on the resulting resource.
 */
export function validateIapFormForCreate(form: IapFormState): ChecklistState {
  return toState(buildCreateItems(form));
}

/**
 * Group A + B — full prerequisite set for Submit for Apple Review. Six items.
 * Used for read-only display: the actual submit gate is Apple's per-IAP state
 * (READY_TO_SUBMIT vs MISSING_METADATA), surfaced via the list-page batch flow.
 */
export function validateIapFormForSubmit(form: IapFormState): ChecklistState {
  return toState([...buildCreateItems(form), ...buildSubmitOnlyItems(form)]);
}

/**
 * Grouped view for the SubmitChecklist component. Renders Group A and Group B
 * as visually distinct sections (5/5 Create-ready · 1/1 additional for review).
 */
export function validateIapFormGrouped(
  form: IapFormState,
): GroupedChecklistState {
  const createItems = buildCreateItems(form);
  const submitOnlyItems = buildSubmitOnlyItems(form);
  const createPassedCount = createItems.filter((i) => i.passed).length;
  const submitPassedCount = submitOnlyItems.filter((i) => i.passed).length;
  const createReady = createPassedCount === createItems.length;
  return {
    createItems,
    submitOnlyItems,
    createReady,
    submitReady: createReady && submitPassedCount === submitOnlyItems.length,
    createPassedCount,
    submitPassedCount,
  };
}

/** Empty initial form — used by the New IAP page. */
export function emptyIapForm(): IapFormState {
  return {
    reference_name: "",
    product_id: "",
    type: "",
    tier_id: null,
    localizations: {},
    screenshot_filename: null,
  };
}
