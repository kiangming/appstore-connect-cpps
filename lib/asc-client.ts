import { generateAscToken } from "./asc-jwt";
import type { AscCredentials } from "@/lib/asc-jwt";
import { log } from "@/lib/logger";
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

/**
 * Hotfix 20 — page-size + safety cap for the apps catalogue fetch.
 *
 * Apple ASC `/v1/apps` returns 20 by default, max 200 per page, and
 * carries a `links.next` cursor (full URL form) when more pages exist.
 * `getApps()` follows the cursor and accumulates pages so callers see
 * the complete catalogue (Manager symptom 2026-05-23: 50-app cap on
 * the Apple IAP "Apps" page).
 *
 * Safety net: 50 pages × 200 = 10,000 apps — well above any realistic
 * tenant catalogue. Prevents an unbounded loop if Apple ever returns a
 * malformed cursor.
 */
const APPS_PAGE_SIZE = 200;
const APPS_MAX_PAGES = 50;

async function ascFetch<T>(
  creds: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const token = await generateAscToken(creds);
  // Hotfix 20: accept either a path (`/v1/apps?...`) or a full URL
  // (Apple's `links.next` carries the full origin). Detect via prefix.
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${ASC_BASE_URL}${endpoint}`;

  if (body) {
    await log("asc-client", `[${creds.keyId}] ${method} ${endpoint} body: ${JSON.stringify(body)}`);
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  await log("asc-client", `[${creds.keyId}] ${method} ${endpoint} → ${res.status}`);

  if (!res.ok) {
    const errorBody = await res.text();
    await log("asc-client", `[${creds.keyId}] ${method} ${endpoint} ERROR ${res.status}: ${errorBody}`, "ERROR");
    throw new Error(`ASC API error ${res.status} on ${method} ${endpoint}: ${errorBody}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

/**
 * Hotfix 20 — paginated fetch of the active ASC account's apps.
 *
 * Pre-Hotfix-20 this was a single `GET /v1/apps?limit=50` call, so
 * Manager could never see app #51+ in either the CPP Manager dashboard
 * or the Apple IAP Management module (both consume this function). The
 * symptom surfaced on the Apple IAP "Apps" page after Manager added a
 * 51st app to the ASC account.
 *
 * Behaviour now: request `?limit=200`, then follow `links.next` (a full
 * URL Apple returns when more pages exist) until exhausted or the
 * safety cap kicks in. Synthesises an `AscApiResponse<App[]>` whose
 * `data` array contains every app — callers stay drop-in. `included`
 * arrays from each page are concatenated (rare for `/v1/apps`, but
 * preserves the shape). `links.self` carries the first page's self
 * URL; pagination cursors are intentionally dropped since they no
 * longer point at the caller's current position.
 */
export async function getApps(creds: AscCredentials): Promise<AscApiResponse<App[]>> {
  const allApps: App[] = [];
  const allIncluded: NonNullable<AscApiResponse<App[]>["included"]> = [];
  let next: string | null = `/v1/apps?limit=${APPS_PAGE_SIZE}`;
  let firstSelf: string | undefined;
  let pageCount = 0;

  while (next && pageCount < APPS_MAX_PAGES) {
    const page: AscApiResponse<App[]> = await ascFetch<AscApiResponse<App[]>>(
      creds,
      "GET",
      next,
    );
    allApps.push(...page.data);
    if (page.included) allIncluded.push(...page.included);
    if (firstSelf === undefined) firstSelf = page.links?.self;
    next = page.links?.next ?? null;
    pageCount += 1;
    await log(
      "asc-client",
      `[${creds.keyId}] getApps page ${pageCount} total=${allApps.length} has_next=${next ? "yes" : "no"}`,
    );
  }

  if (next) {
    await log(
      "asc-client",
      `[${creds.keyId}] getApps page cap (${APPS_MAX_PAGES}) reached at ${allApps.length} apps; truncating remainder`,
      "WARN",
    );
  }

  return {
    data: allApps,
    ...(allIncluded.length > 0 ? { included: allIncluded } : {}),
    links: firstSelf ? { self: firstSelf } : undefined,
  };
}

export async function getApp(creds: AscCredentials, appId: string): Promise<AscApiResponse<App>> {
  return ascFetch<AscApiResponse<App>>(creds, "GET", `/v1/apps/${appId}`);
}

export async function getCpps(
  creds: AscCredentials,
  appId: string
): Promise<AscApiResponse<AppCustomProductPage[]>> {
  return ascFetch<AscApiResponse<AppCustomProductPage[]>>(
    creds,
    "GET",
    `/v1/apps/${appId}/appCustomProductPages?include=appCustomProductPageVersions&limit=70`
  );
}

export async function getCpp(
  creds: AscCredentials,
  cppId: string
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    creds,
    "GET",
    `/v1/appCustomProductPages/${cppId}?include=appCustomProductPageVersions`
  );
}

export async function createCpp(
  creds: AscCredentials,
  payload: CreateCppPayload
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    creds,
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
  creds: AscCredentials,
  appId: string
): Promise<AscApiResponse<AppStoreVersion[]>> {
  return ascFetch<AscApiResponse<AppStoreVersion[]>>(
    creds,
    "GET",
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=1`
  );
}

/** Creates a localization linked directly to a CPP (per Apple's documented 2-step flow). */
export async function createCppLocalization(
  creds: AscCredentials,
  cppId: string,
  locale: string,
  promotionalText?: string
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    creds,
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
  creds: AscCredentials,
  cppId: string,
  attributes: { name?: string; visible?: "VISIBLE" | "HIDDEN" }
): Promise<AscApiResponse<AppCustomProductPage>> {
  return ascFetch<AscApiResponse<AppCustomProductPage>>(
    creds,
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

export async function updateCppVersion(
  creds: AscCredentials,
  versionId: string,
  deepLink: string
): Promise<AscApiResponse<AppCustomProductPageVersion>> {
  return ascFetch<AscApiResponse<AppCustomProductPageVersion>>(
    creds,
    "PATCH",
    `/v1/appCustomProductPageVersions/${versionId}`,
    {
      data: {
        type: "appCustomProductPageVersions",
        id: versionId,
        attributes: { deepLink },
      },
    }
  );
}

export async function deleteCpp(creds: AscCredentials, cppId: string): Promise<void> {
  return ascFetch<void>(creds, "DELETE", `/v1/appCustomProductPages/${cppId}`);
}

/**
 * Submit multiple CPP versions in a single Apple Review Submission (API v1.7+).
 * Flow: POST reviewSubmissions → parallel POST reviewSubmissionItems → PATCH state=SUBMITTED
 */
export async function submitCpps(
  creds: AscCredentials,
  appId: string,
  versionIds: string[]
): Promise<void> {
  // Step 1: Create one review submission container for the whole batch
  const submissionRes = await ascFetch<{ data: { id: string } }>(
    creds,
    "POST",
    "/v1/reviewSubmissions",
    {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    }
  );
  const submissionId = submissionRes.data.id;

  // Step 2: Add all CPP versions to the same submission (parallel)
  await Promise.all(
    versionIds.map((versionId) =>
      ascFetch<unknown>(creds, "POST", "/v1/reviewSubmissionItems", {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: {
              data: { type: "reviewSubmissions", id: submissionId },
            },
            appCustomProductPageVersion: {
              data: { type: "appCustomProductPageVersions", id: versionId },
            },
          },
        },
      })
    )
  );

  // Step 3: Submit the whole batch for review
  await ascFetch<unknown>(
    creds,
    "PATCH",
    `/v1/reviewSubmissions/${submissionId}`,
    {
      data: {
        type: "reviewSubmissions",
        id: submissionId,
        attributes: { submitted: true },
      },
    }
  );
}

// ─── Submit v2: per-item tracking, sequential, retry ─────────────────────────

export interface PrepareItemResult {
  cppId: string;
  cppName: string;
  versionId: string;
  status: "success" | "failed";
  error?: string;
}

export interface PrepareCppSubmissionResult {
  submissionId: string;
  items: PrepareItemResult[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Step 1+2 of the new submit flow:
 * - Creates one reviewSubmission container
 * - Sequentially POSTs reviewSubmissionItems (200ms gap, up to 3 attempts each)
 * - Returns per-item results so the caller can decide to confirm or rollback
 */
export async function prepareCppSubmission(
  creds: AscCredentials,
  appId: string,
  items: Array<{ cppId: string; cppName: string; versionId: string }>
): Promise<PrepareCppSubmissionResult> {
  const submissionRes = await ascFetch<{ data: { id: string } }>(
    creds,
    "POST",
    "/v1/reviewSubmissions",
    {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: {
          app: { data: { type: "apps", id: appId } },
        },
      },
    }
  );
  const submissionId = submissionRes.data.id;

  const results: PrepareItemResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const { cppId, cppName, versionId } = items[i];
    if (i > 0) await sleep(200);

    let lastError: string | undefined;
    let succeeded = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ascFetch<unknown>(creds, "POST", "/v1/reviewSubmissionItems", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: {
                data: { type: "reviewSubmissions", id: submissionId },
              },
              appCustomProductPageVersion: {
                data: { type: "appCustomProductPageVersions", id: versionId },
              },
            },
          },
        });
        succeeded = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Unknown error";
      }
    }

    results.push({
      cppId,
      cppName,
      versionId,
      status: succeeded ? "success" : "failed",
      error: succeeded ? undefined : lastError,
    });
  }

  return { submissionId, items: results };
}

/**
 * Step 3: PATCH the submission to submitted:true
 */
export async function confirmCppSubmission(
  creds: AscCredentials,
  submissionId: string
): Promise<void> {
  await ascFetch<unknown>(
    creds,
    "PATCH",
    `/v1/reviewSubmissions/${submissionId}`,
    {
      data: {
        type: "reviewSubmissions",
        id: submissionId,
        attributes: { submitted: true },
      },
    }
  );
}

/**
 * Rollback: DELETE the submission container (cancels all added items)
 */
export async function rollbackCppSubmission(
  creds: AscCredentials,
  submissionId: string
): Promise<void> {
  await ascFetch<void>(
    creds,
    "DELETE",
    `/v1/reviewSubmissions/${submissionId}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export async function createCppVersion(
  creds: AscCredentials,
  payload: CreateCppVersionPayload
): Promise<AscApiResponse<AppCustomProductPageVersion>> {
  return ascFetch<AscApiResponse<AppCustomProductPageVersion>>(
    creds,
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
  creds: AscCredentials,
  versionId: string
): Promise<AscApiResponse<AppCustomProductPageLocalization[]>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization[]>>(
    creds,
    "GET",
    `/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations`
  );
}

export async function getLocalizationScreenshotSets(
  creds: AscCredentials,
  localizationId: string
): Promise<AscApiResponse<AppScreenshotSet[]>> {
  return ascFetch<AscApiResponse<AppScreenshotSet[]>>(
    creds,
    "GET",
    `/v1/appCustomProductPageLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots`
  );
}

export async function getLocalizationPreviewSets(
  creds: AscCredentials,
  localizationId: string
): Promise<AscApiResponse<AppPreviewSet[]>> {
  return ascFetch<AscApiResponse<AppPreviewSet[]>>(
    creds,
    "GET",
    `/v1/appCustomProductPageLocalizations/${localizationId}/appPreviewSets?include=appPreviews`
  );
}

export async function createLocalization(
  creds: AscCredentials,
  payload: CreateLocalizationPayload
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    creds,
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
  creds: AscCredentials,
  localizationId: string,
  promotionalText: string
): Promise<AscApiResponse<AppCustomProductPageLocalization>> {
  return ascFetch<AscApiResponse<AppCustomProductPageLocalization>>(
    creds,
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
  creds: AscCredentials,
  localizationId: string,
  screenshotDisplayType: ScreenshotDisplayType
): Promise<AscApiResponse<AppScreenshotSet>> {
  return ascFetch<AscApiResponse<AppScreenshotSet>>(
    creds,
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
  creds: AscCredentials,
  screenshotSetId: string,
  fileName: string,
  fileSize: number
): Promise<AscApiResponse<AppScreenshot>> {
  return ascFetch<AscApiResponse<AppScreenshot>>(
    creds,
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
  creds: AscCredentials,
  screenshotId: string,
  sourceFileChecksum: string
): Promise<AscApiResponse<AppScreenshot>> {
  return ascFetch<AscApiResponse<AppScreenshot>>(
    creds,
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

/** Does NOT need creds — uploads directly to Apple's CDN via presigned operations */
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
  creds: AscCredentials,
  previewSetId: string,
  fileName: string,
  fileSize: number,
  mimeType: string
): Promise<AscApiResponse<AppPreview>> {
  return ascFetch<AscApiResponse<AppPreview>>(
    creds,
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
  creds: AscCredentials,
  previewId: string,
  sourceFileChecksum: string
): Promise<AscApiResponse<AppPreview>> {
  return ascFetch<AscApiResponse<AppPreview>>(
    creds,
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
  creds: AscCredentials,
  localizationId: string,
  previewType: PreviewType
): Promise<AscApiResponse<AppPreviewSet>> {
  return ascFetch<AscApiResponse<AppPreviewSet>>(
    creds,
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
  creds: AscCredentials,
  appId: string
): Promise<AscApiResponse<AppInfo[]>> {
  return ascFetch<AscApiResponse<AppInfo[]>>(
    creds,
    "GET",
    `/v1/apps/${appId}/appInfos`
  );
}

export async function getAppInfoLocalizations(
  creds: AscCredentials,
  appInfoId: string
): Promise<AscApiResponse<AppInfoLocalization[]>> {
  return ascFetch<AscApiResponse<AppInfoLocalization[]>>(
    creds,
    "GET",
    `/v1/appInfos/${appInfoId}/appInfoLocalizations`
  );
}

export async function createAppInfoLocalization(
  creds: AscCredentials,
  appInfoId: string,
  locale: string
): Promise<AscApiResponse<AppInfoLocalization>> {
  return ascFetch<AscApiResponse<AppInfoLocalization>>(
    creds,
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
