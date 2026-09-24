/**
 * Apple App Store Connect — IAP API types.
 *
 * Shares the AscResource / AscApiResponse generic shape with CPP (re-exported
 * from @/types/asc) so consumers can use a single import for JSON:API plumbing.
 *
 * IAP-specific resource attribute shapes follow Apple's documented public
 * schema (best-effort — verify against real responses at IAP.n UAT).
 */

import type {
  AscApiResponse,
  AscResource,
  UploadOperation,
} from "@/types/asc";

export type { AscApiResponse, AscResource, UploadOperation };

// ─── IAP types — Q1 lock: no auto-renewable ──────────────────────────────────

export type InAppPurchaseType =
  | "CONSUMABLE"
  | "NON_CONSUMABLE"
  | "NON_RENEWING_SUBSCRIPTION";

/**
 * Apple's InAppPurchaseState enum. Kept as a string union for IDE hints, but
 * the DB column (iap_mgmt.iaps.state) is plain TEXT — see migration comment.
 * If Apple adds a new state, parsers fall through to the raw string without
 * a forward migration.
 */
export type InAppPurchaseState =
  | "MISSING_METADATA"
  | "READY_TO_SUBMIT"
  | "WAITING_FOR_REVIEW"
  | "IN_REVIEW"
  | "DEVELOPER_ACTION_NEEDED"
  | "PENDING_APPLE_RELEASE"
  | "PENDING_DEVELOPER_RELEASE"
  | "APPROVED"
  | "READY_FOR_SALE"
  | "REJECTED"
  | "REMOVED_FROM_SALE"
  | "DEVELOPER_REMOVED_FROM_SALE";

export interface InAppPurchaseAttributes {
  name: string;
  productId: string;
  inAppPurchaseType: InAppPurchaseType;
  state: InAppPurchaseState;
  reviewNote?: string;
  familySharable?: boolean;
}

export type InAppPurchase = AscResource<"inAppPurchases", InAppPurchaseAttributes>;

// ─── IAP Localizations ───────────────────────────────────────────────────────

export interface InAppPurchaseLocalizationAttributes {
  locale: string;
  name: string;
  description?: string;
  state?: string;
}

export type InAppPurchaseLocalization = AscResource<
  "inAppPurchaseLocalizations",
  InAppPurchaseLocalizationAttributes
>;

// ─── Review Screenshot ───────────────────────────────────────────────────────

export interface InAppPurchaseAppStoreReviewScreenshotAttributes {
  fileName: string;
  fileSize: number;
  sourceFileChecksum?: string;
  uploadOperations?: UploadOperation[];
  uploaded?: boolean;
  imageAsset?: {
    width: number;
    height: number;
    url: string;
    templateUrl: string;
  };
  assetDeliveryState?: {
    state: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED";
    errors?: Array<{ code: string; description: string }>;
  };
}

export type InAppPurchaseAppStoreReviewScreenshot = AscResource<
  "inAppPurchaseAppStoreReviewScreenshots",
  InAppPurchaseAppStoreReviewScreenshotAttributes
>;

// ─── Payloads ────────────────────────────────────────────────────────────────

export interface CreateInAppPurchasePayload {
  appId: string;
  name: string;
  productId: string;
  inAppPurchaseType: InAppPurchaseType;
  reviewNote?: string;
  familySharable?: boolean;
}

export interface UpdateInAppPurchasePayload {
  name?: string;
  reviewNote?: string;
  familySharable?: boolean;
}

export interface CreateInAppPurchaseLocalizationPayload {
  iapId: string;
  locale: string;
  name: string;
  description?: string;
}

export interface UpdateInAppPurchaseLocalizationPayload {
  name?: string;
  description?: string;
}

// ─── Pricing — Price Schedule (IAP.p2.a) ─────────────────────────────────────
//
// Apple exposes the price schedule for an IAP via the relationship-traversal
// endpoint /v2/inAppPurchases/{id}/iapPriceSchedule. The path segment uses
// the SHORT relationship name (`iapPriceSchedule`), NOT the resource type
// (`inAppPurchasePriceSchedule`) — same Apple naming inconsistency as
// `appStoreReviewScreenshot` (IAP.o.9b). The schedule resource itself
// carries no attributes — every field comes from the `included[]` block
// (territories + inAppPurchasePrices + price points).

export type Territory = AscResource<"territories", Record<string, never>>;

export interface InAppPurchasePriceAttributes {
  /** ISO date when the price becomes effective. `null` means "active now". */
  startDate: string | null;
  /** ISO date when the price stops being effective (optional, future-dated). */
  endDate?: string | null;
  /**
   * TRUE when a human set this territory's price; FALSE when Apple's
   * auto-equalization derived it from the base territory.
   *
   * ⚠ THIS IS THE SOURCE OF TRUTH FOR "manual vs automatic", not the
   * sub-resource the entry arrived from. Both `/manualPrices` and
   * `/automaticPrices` return `inAppPurchasePrices` resources, so the two
   * facts are separately observable and can in principle disagree — and when
   * they do, the attribute is Apple's own statement about the row while the
   * endpoint is our inference about it. Measured live 2026-08-27: an
   * automaticPrices entry carries `manual: false`.
   *
   * ⚠ OPTIONAL because it is a recent addition to the read path and an older
   * cached/fixture response may not carry it. `undefined` means "Apple did
   * not say" and must not be read as `false` — see `entryIsManual`.
   */
  manual?: boolean;
}

export type InAppPurchasePrice = AscResource<
  "inAppPurchasePrices",
  InAppPurchasePriceAttributes
>;

export interface InAppPurchasePricePointAttributes {
  customerPrice: string;
  proceeds: string;
  currency?: string;
  priceTier?: string;
}

export type InAppPurchasePricePointResource = AscResource<
  "inAppPurchasePricePoints",
  InAppPurchasePricePointAttributes
>;

/** Schedule resource has no attributes — everything lives in relationships. */
export type InAppPurchasePriceSchedule = AscResource<
  "inAppPurchasePriceSchedules",
  Record<string, never>
>;

// ─── IAP Version (v2 reviewSubmission migration) ─────────────────────────────
//
// The resource actually attached to a reviewSubmissionItem — mirrors CPP's
// AppCustomProductPageVersion. Confirmed empirically (design doc §0 Q1)
// that a READY_TO_SUBMIT IAP already has one of these in PREPARE_FOR_SUBMISSION;
// `POST /v1/inAppPurchaseVersions` is a rare defensive fallback only.

export type InAppPurchaseVersionState =
  | "PREPARE_FOR_SUBMISSION"
  | "READY_FOR_REVIEW"
  | "WAITING_FOR_REVIEW"
  | "IN_REVIEW"
  | "ACCEPTED"
  | "APPROVED"
  | "REPLACED_WITH_NEW_VERSION"
  | "REJECTED"
  | "DEVELOPER_REJECTED";

export interface InAppPurchaseVersionAttributes {
  version?: number;
  state: InAppPurchaseVersionState;
}

export type InAppPurchaseVersion = AscResource<
  "inAppPurchaseVersions",
  InAppPurchaseVersionAttributes
>;

// ─── IAP Localization, V2 MODEL — arc `[LOC-V2-model]` ───────────────────────
//
// ⚠⚠ THIS IS A DIFFERENT MODEL FROM `InAppPurchaseLocalization` ABOVE, NOT A
// NEWER VERSION OF IT. Both are live in OAS 4.4.1 and they disagree about two
// things that matter:
//
//   | | V1 (`InAppPurchaseLocalization`) | V2 (this type) |
//   |---|---|---|
//   | `attributes.state` | PRESENT | ⚠ **ABSENT** |
//   | relationship | `inAppPurchaseV2` → the IAP | `version` → an IAP VERSION |
//
// OAS 4.4.1, `#/components/schemas/InAppPurchaseLocalizationV2` — machine-read
// 2026-09-24: `attributes` = {name, locale, description}; `relationships` =
// {version: {data: {type: "inAppPurchaseVersions", id}}}.
//
// ⚠ `type` IS THE SAME STRING IN BOTH MODELS (`"inAppPurchaseLocalizations"`).
// Apple did not give the V2 resource its own type name, so a JSON:API
// `included[]` discriminator CANNOT tell them apart — only the ENDPOINT that
// produced the document can. That is exactly the trap `client.ts:242` sits in:
// a path containing "v2" that answers with the V1 shape (KB §28.3, §30.4).
//
// ⚠ WHERE THE STATE WENT — do not go looking for it on this type. Under the V2
// model a localization has no lifecycle of its own; the lifecycle belongs to
// the VERSION that owns it (`InAppPurchaseVersionState`, 9 values). That is a
// simplification, not a loss.
export interface InAppPurchaseLocalizationV2Attributes {
  locale: string;
  name: string;
  description?: string;
}

export type InAppPurchaseLocalizationV2 = AscResource<
  "inAppPurchaseLocalizations",
  InAppPurchaseLocalizationV2Attributes
>;
