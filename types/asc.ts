export interface AscApiResponse<T> {
  data: T;
  included?: AscResource<string, Record<string, unknown>>[];
  links?: {
    self: string;
    first?: string;
    next?: string;
    prev?: string;
    last?: string;
  };
  meta?: {
    paging?: {
      total: number;
      limit: number;
    };
  };
}

export interface AscResource<T extends string, A> {
  type: T;
  id: string;
  attributes: A;
  links?: {
    self: string;
  };
  relationships?: Record<string, unknown>;
}

export interface AppAttributes {
  name: string;
  bundleId: string;
  sku: string;
  primaryLocale: string;
}

export interface BuildAttributes {
  iconAssetToken?: {
    templateUrl: string;
    width: number;
    height: number;
  };
}

export type Build = AscResource<"builds", BuildAttributes>;

export type App = AscResource<"apps", AppAttributes>;

export type CppState =
  | "PREPARE_FOR_SUBMISSION"
  | "READY_FOR_REVIEW"
  | "WAITING_FOR_REVIEW"
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED";

export interface AppCustomProductPageAttributes {
  name: string;
  url?: string;
  /** String enum returned by the ASC API: "VISIBLE" | "HIDDEN" */
  visible?: "VISIBLE" | "HIDDEN" | null;
  /** Legacy boolean field — may be returned by some API versions */
  isVisible?: boolean | null;
}

/** Resolves whichever visibility field the API actually returns */
export function resolveVisibility(
  attrs: AppCustomProductPageAttributes
): "Visible" | "Hidden" | "—" {
  if (attrs.visible === "VISIBLE") return "Visible";
  if (attrs.visible === "HIDDEN") return "Hidden";
  if (attrs.isVisible === true) return "Visible";
  if (attrs.isVisible === false) return "Hidden";
  return "—";
}

export type AppCustomProductPage = AscResource<
  "appCustomProductPages",
  AppCustomProductPageAttributes
>;

export interface AppCustomProductPageVersionAttributes {
  state: CppState;
  deepLink?: string;
  rejectedVersionUserFeedback?: string;
}

export type AppCustomProductPageVersion = AscResource<
  "appCustomProductPageVersions",
  AppCustomProductPageVersionAttributes
>;

export interface AppCustomProductPageLocalizationAttributes {
  locale: string;
  promotionalText?: string;
}

export type AppCustomProductPageLocalization = AscResource<
  "appCustomProductPageLocalizations",
  AppCustomProductPageLocalizationAttributes
>;

export type ScreenshotDisplayType =
  | "APP_IPHONE_67"
  | "APP_IPHONE_65"
  | "APP_IPHONE_61"
  | "APP_IPHONE_55"
  | "APP_IPHONE_47"
  | "APP_IPHONE_40"
  | "APP_IPHONE_35"
  | "APP_IPAD_PRO_3GEN_129"
  | "APP_IPAD_PRO_3GEN_11"
  | "APP_IPAD_PRO_129"
  | "APP_IPAD_105"
  | "APP_IPAD_97";

export interface AppScreenshotSetAttributes {
  screenshotDisplayType: ScreenshotDisplayType;
}

export type AppScreenshotSet = AscResource<
  "appScreenshotSets",
  AppScreenshotSetAttributes
>;

export interface UploadOperation {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: Array<{ name: string; value: string }>;
}

export interface AppScreenshotAttributes {
  fileSize: number;
  fileName: string;
  sourceFileChecksum?: string;
  imageAsset?: {
    width: number;
    height: number;
    url: string;
    templateUrl: string;
  };
  assetToken?: string;
  assetType?: string;
  uploadOperations?: UploadOperation[];
  assetDeliveryState?: {
    state: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED";
    errors?: Array<{ code: string; description: string }>;
  };
}

export type AppScreenshot = AscResource<"appScreenshots", AppScreenshotAttributes>;

export type PreviewType =
  | "IPHONE_67"
  | "IPHONE_65"
  | "IPHONE_61"
  | "IPHONE_58"
  | "IPHONE_55"
  | "IPHONE_47"
  | "IPHONE_40"
  | "IPAD_PRO_3GEN_129"
  | "IPAD_PRO_3GEN_11"
  | "IPAD_PRO_129"
  | "IPAD_105"
  | "IPAD_97";

export interface AppPreviewSetAttributes {
  previewType: PreviewType;
}

export type AppPreviewSet = AscResource<"appPreviewSets", AppPreviewSetAttributes>;

export interface AppPreviewAttributes {
  fileSize: number;
  fileName: string;
  sourceFileChecksum?: string;
  previewFrameTimeCode?: string;
  mimeType?: string;
  videoUrl?: string;
  previewImage?: {
    width: number;
    height: number;
    url: string;
    templateUrl: string;
  };
  uploadOperations?: UploadOperation[];
  assetDeliveryState?: {
    state: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED";
    errors?: Array<{ code: string; description: string }>;
  };
}

export type AppPreview = AscResource<"appPreviews", AppPreviewAttributes>;

export interface AscError {
  id?: string;
  status: string;
  code: string;
  title: string;
  detail?: string;
  source?: {
    pointer?: string;
    parameter?: string;
  };
}

export interface AscErrorResponse {
  errors: AscError[];
}

export interface CreateCppPayload {
  name: string;
  appId: string;
  locale: string;
}

export interface AppStoreVersionAttributes {
  versionString: string;
  platform: string;
  appStoreState: string;
}

export type AppStoreVersion = AscResource<"appStoreVersions", AppStoreVersionAttributes>;

export interface CreateCppVersionPayload {
  cppId: string;
  appStoreVersionId: string;
  deepLink?: string;
}

export interface CreateLocalizationPayload {
  cppVersionId: string;
  locale: string;
  promotionalText?: string;
}

export interface AppInfoAttributes {
  state: string;
}

export type AppInfo = AscResource<"appInfos", AppInfoAttributes>;

export interface AppInfoLocalizationAttributes {
  locale: string;
  name?: string;
  subtitle?: string;
}

export type AppInfoLocalization = AscResource<
  "appInfoLocalizations",
  AppInfoLocalizationAttributes
>;
