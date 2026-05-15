/**
 * IAP form validation (Q-IAP.h.3 lock — hybrid live checklist + Apple safety net).
 *
 * Six prerequisites surfaced as a live checklist on the form. Submit button
 * enables only when all six are green. Apple-side validation (the safety net)
 * still applies at submit time and any 4xx response is surfaced via toast.
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

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  passed: boolean;
  detail?: string;
}

export type ChecklistKey =
  | "reference_name"
  | "product_id"
  | "type"
  | "tier"
  | "localization"
  | "screenshot";

export interface ChecklistState {
  items: ChecklistItem[];
  /** Total green count (0..6). Submit button enables iff allPassed. */
  allPassed: boolean;
  passedCount: number;
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

export function validateIapFormState(form: IapFormState): ChecklistState {
  const items: ChecklistItem[] = [];

  // 1. Reference name
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

  // 2. Product ID
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

  // 3. Type
  items.push({
    key: "type",
    label: "Type assigned",
    passed: form.type !== "",
    detail: form.type === "" ? "required" : undefined,
  });

  // 4. Pricing tier
  items.push({
    key: "tier",
    label: "Pricing tier set",
    passed: form.tier_id !== null && form.tier_id !== "",
    detail: !form.tier_id ? "required" : undefined,
  });

  // 5. ≥1 localization filled (both Display Name + Description)
  const filledCount = filledLocalizationCount(form.localizations);
  items.push({
    key: "localization",
    label: "≥ 1 localization filled",
    passed: filledCount > 0,
    detail: filledCount > 0 ? `${filledCount} filled` : "required",
  });

  // 6. Screenshot
  items.push({
    key: "screenshot",
    label: "Review screenshot uploaded",
    passed: form.screenshot_filename !== null && form.screenshot_filename !== "",
    detail: form.screenshot_filename ? undefined : "required",
  });

  const passedCount = items.filter((i) => i.passed).length;
  return {
    items,
    allPassed: passedCount === items.length,
    passedCount,
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
