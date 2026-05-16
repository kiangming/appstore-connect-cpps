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
