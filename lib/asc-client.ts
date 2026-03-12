import { generateAscToken } from "./asc-jwt";
import type {
  AscApiResponse,
  App,
  AppCustomProductPage,
  AppCustomProductPageVersion,
  AppCustomProductPageLocalization,
  AppScreenshotSet,
  AppScreenshot,
  AppPreviewSet,
  AppPreview,
  AppStoreVersion,
  AppInfo,
  AppInfoLocalization,
  CreateCppPayload,
  CreateCppVersionPayload,
  CreateLocalizationPayload,
  ScreenshotDisplayType,
  PreviewType,
  UploadOperation,
} from "@/types/asc";

const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";

async function ascFetch<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const token = await generateAscToken();
  const url = `${ASC_BASE_URL}${endpoint}`;

  if (body) {
    console.log(`[ASC] ${method} ${endpoint} body:`, JSON.stringify(body, null, 2));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  console.log(`[ASC] ${method} ${endpoint} → ${res.status}`);

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`ASC API error ${res.status} on ${method} ${endpoint}: ${errorBody}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export async function getApps(): Promise<AscApiResponse<App[]>> {
  return ascFetch<AscApiResponse<App[]>>("GET", "/v1/apps?limit=50");
}

export async function getApp(appId: string): Promise<AscApiResponse<App>> {
  return ascFetch<AscApiResponse<App>>("GET", `/v1/apps/${appId}`);
}

export async function getCpps(
  appId: string
): Promise<AscApiResponse<AppCustomProductPage[]>> {
  return ascFetch<AscApiResponse<AppCustomProductPage[]>>(
    "GET",
    `/v1/apps/${appId}/appCustomProductPages?include=appCustomProductPageVersions&limit=50`
  );
}

export async function getCpp(
  cppId: string
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    "GET",
    `/v1/appCustomProductPages/${cppId}?include=appCustomProductPageVersions`
  );
}

export async function createCpp(
  payload: CreateCppPayload
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    "POST",
    "/v1/appCustomProductPages",
    {
      data: {
        type: "appCustomProductPages",
        attributes: { name: payload.name },
        relationships: {
          app: {
            data: { type: "apps", id: payload.appId },
          },
          appCustomProductPageVersions: {
            data: [{ type: "appCustomProductPageVersions", id: "${new-appCustomProductPageVersion-id}" }],
          },
        },
      },
      included: [
        {
          type: "appCustomProductPageVersions",
          id: "${new-appCustomProductPageVersion-id}",
          relationships: {
            appCustomProductPage: {},
            appCustomProductPageLocalizations: {
              data: [{ type: "appCustomProductPageLocalizations", id: "${new-appCustomProductPageLocalization-id}" }],
            },
          },
        },
        {
          type: "appCustomProductPageLocalizations",
          id: "${new-appCustomProductPageLocalization-id}",
          attributes: { locale: payload.locale, promotionalText: "" },
        },
      ],
    }
  );
}

export async function getAppStoreVersions(
  appId: string
): Promise<AscApiResponse<AppStoreVersion[]>> {
  return ascFetch<AscApiResponse<AppStoreVersion[]>>(
    "GET",
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=1`
  );
}

/** Creates a localization linked directly to a CPP (per Apple's documented 2-step flow). */
export async function createCppLocalization(
  cppId: string,
  locale: string,
  promotionalText?: string
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    "POST",
    `/v1/appCustomProductPageLocalizations`,
    {
      data: {
        type: "appCustomProductPageLocalizations",
        attributes: {
          locale,
          ...(promotionalText ? { promotionalText } : {}),
        },
        relationships: {
          appCustomProductPage: {
            data: { type: "appCustomProductPages", id: cppId },
          },
        },
      },
    }
  );
}

export async function updateCpp(
  cppId: string,
  attributes: { name?: string; visible?: "VISIBLE" | "HIDDEN" }
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    "PATCH",
    `/v1/appCustomProductPages/${cppId}`,
    {
      data: {
        type: "appCustomProductPages",
        id: cppId,
        attributes,
      },
    }
  );
}

export async function deleteCpp(cppId: string): Promise<void> {
  return ascFetch<void>("DELETE", `/v1/appCustomProductPages/${cppId}`);
}

export async function createCppVersion(
  payload: CreateCppVersionPayload
): Promise<AscApiResponse<AppCustomProductPageVersion>> {
  return ascFetch<AscApiResponse<AppCustomProductPageVersion>>(
    "POST",
    `/v1/appCustomProductPageVersions`,
    {
      data: {
        type: "appCustomProductPageVersions",
        attributes: payload.deepLink ? { deepLink: payload.deepLink } : {},
        relationships: {
          appCustomProductPage: {
            data: { type: "appCustomProductPages", id: payload.cppId },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: payload.appStoreVersionId },
          },
        },
      },
    }
  );
}

export async function getCppVersionLocalizations(
  versionId: string
): Promise<AscApiResponse<AppCustomProductPageLocalization[]>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization[]>>(
    "GET",
    `/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations`
  );
}

export async function getLocalizationScreenshotSets(
  localizationId: string
): Promise<AscApiResponse<AppScreenshotSet[]>> {
  return ascFetch<AscApiResponse<AppScreenshotSet[]>>(
    "GET",
    `/v1/appCustomProductPageLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots`
  );
}

export async function getLocalizationPreviewSets(
  localizationId: string
): Promise<AscApiResponse<AppPreviewSet[]>> {
  return ascFetch<AscApiResponse<AppPreviewSet[]>>(
    "GET",
    `/v1/appCustomProductPageLocalizations/${localizationId}/appPreviewSets?include=appPreviews`
  );
}

export async function createLocalization(
  payload: CreateLocalizationPayload
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    "POST",
    `/v1/appCustomProductPageLocalizations`,
    {
      data: {
        type: "appCustomProductPageLocalizations",
        attributes: {
          locale: payload.locale,
          ...(payload.promotionalText
            ? { promotionalText: payload.promotionalText }
            : {}),
        },
        relationships: {
          appCustomProductPageVersion: {
            data: {
              type: "appCustomProductPageVersions",
              id: payload.cppVersionId,
            },
          },
        },
      },
    }
  );
}

export async function updateLocalization(
  localizationId: string,
  promotionalText: string
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    "PATCH",
    `/v1/appCustomProductPageLocalizations/${localizationId}`,
    {
      data: {
        type: "appCustomProductPageLocalizations",
        id: localizationId,
        attributes: { promotionalText },
      },
    }
  );
}

export async function createScreenshotSet(
  localizationId: string,
  screenshotDisplayType: ScreenshotDisplayType
): Promise<AscApiResponse<AppScreenshotSet>> {
  return ascFetch<AscApiResponse<AppScreenshotSet>>(
    "POST",
    `/v1/appScreenshotSets`,
    {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType },
        relationships: {
          appCustomProductPageLocalization: {
            data: {
              type: "appCustomProductPageLocalizations",
              id: localizationId,
            },
          },
        },
      },
    }
  );
}

export async function reserveScreenshot(
  screenshotSetId: string,
  fileName: string,
  fileSize: number
): Promise<AscApiResponse<AppScreenshot>> {
  return ascFetch<AscApiResponse<AppScreenshot>>(
    "POST",
    `/v1/appScreenshots`,
    {
      data: {
        type: "appScreenshots",
        attributes: { fileName, fileSize },
        relationships: {
          appScreenshotSet: {
            data: { type: "appScreenshotSets", id: screenshotSetId },
          },
        },
      },
    }
  );
}

export async function confirmScreenshot(
  screenshotId: string,
  sourceFileChecksum: string
): Promise<AscApiResponse<AppScreenshot>> {
  return ascFetch<AscApiResponse<AppScreenshot>>(
    "PATCH",
    `/v1/appScreenshots/${screenshotId}`,
    {
      data: {
        type: "appScreenshots",
        id: screenshotId,
        attributes: { uploaded: true, sourceFileChecksum },
      },
    }
  );
}

export async function uploadAssetToOperations(
  uploadOperations: UploadOperation[],
  file: Blob
): Promise<void> {
  for (const op of uploadOperations) {
    const chunk = file.slice(op.offset, op.offset + op.length);
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders ?? []) {
      headers[h.name] = h.value;
    }

    const res = await fetch(op.url, {
      method: op.method,
      headers,
      body: chunk,
    });

    if (!res.ok) {
      throw new Error(`Upload chunk failed: ${res.status} ${op.url}`);
    }
  }
}

export async function reservePreview(
  previewSetId: string,
  fileName: string,
  fileSize: number,
  mimeType: string
): Promise<AscApiResponse<AppPreview>> {
  return ascFetch<AscApiResponse<AppPreview>>(
    "POST",
    `/v1/appPreviews`,
    {
      data: {
        type: "appPreviews",
        attributes: { fileName, fileSize, mimeType },
        relationships: {
          appPreviewSet: {
            data: { type: "appPreviewSets", id: previewSetId },
          },
        },
      },
    }
  );
}

export async function confirmPreview(
  previewId: string,
  sourceFileChecksum: string
): Promise<AscApiResponse<AppPreview>> {
  return ascFetch<AscApiResponse<AppPreview>>(
    "PATCH",
    `/v1/appPreviews/${previewId}`,
    {
      data: {
        type: "appPreviews",
        id: previewId,
        attributes: { uploaded: true, sourceFileChecksum },
      },
    }
  );
}

export async function createPreviewSet(
  localizationId: string,
  previewType: PreviewType
): Promise<AscApiResponse<AppPreviewSet>> {
  return ascFetch<AscApiResponse<AppPreviewSet>>(
    "POST",
    `/v1/appPreviewSets`,
    {
      data: {
        type: "appPreviewSets",
        attributes: { previewType },
        relationships: {
          appCustomProductPageLocalization: {
            data: {
              type: "appCustomProductPageLocalizations",
              id: localizationId,
            },
          },
        },
      },
    }
  );
}

export async function getAppInfos(
  appId: string
): Promise<AscApiResponse<AppInfo[]>> {
  return ascFetch<AscApiResponse<AppInfo[]>>(
    "GET",
    `/v1/apps/${appId}/appInfos`
  );
}

export async function getAppInfoLocalizations(
  appInfoId: string
): Promise<AscApiResponse<AppInfoLocalization[]>> {
  return ascFetch<AscApiResponse<AppInfoLocalization[]>>(
    "GET",
    `/v1/appInfos/${appInfoId}/appInfoLocalizations`
  );
}

export async function createAppInfoLocalization(
  appInfoId: string,
  locale: string
): Promise<AscApiResponse<AppInfoLocalization>> {
  return ascFetch<AscApiResponse<AppInfoLocalization>>(
    "POST",
    `/v1/appInfoLocalizations`,
    {
      data: {
        type: "appInfoLocalizations",
        attributes: { locale },
        relationships: {
          appInfo: {
            data: { type: "appInfos", id: appInfoId },
          },
        },
      },
    }
  );
}
