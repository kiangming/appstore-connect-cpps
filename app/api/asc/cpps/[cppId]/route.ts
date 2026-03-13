import { NextResponse } from "next/server";
import {
  getCpp,
  getCppVersionLocalizations,
  getLocalizationScreenshotSets,
  getLocalizationPreviewSets,
  updateCpp,
  deleteCpp,
} from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";
import type {
  AppCustomProductPageVersion,
  AppCustomProductPageLocalization,
  AppScreenshotSet,
  AppScreenshot,
  AppPreviewSet,
  AppPreview,
} from "@/types/asc";

export interface LocalizationWithMedia {
  localization: AppCustomProductPageLocalization;
  screenshotSets: Array<{
    set: AppScreenshotSet;
    screenshots: AppScreenshot[];
  }>;
  previewSets: Array<{
    set: AppPreviewSet;
    previews: AppPreview[];
  }>;
}

export interface VersionWithLocalizations {
  version: AppCustomProductPageVersion;
  localizations: LocalizationWithMedia[];
}

export async function GET(
  _req: Request,
  { params }: { params: { cppId: string } }
) {
  try {
    const creds = await getActiveAccount();
    const cppRes = await getCpp(creds, params.cppId);
    await log("cpp-detail", `[Detail] cpp.attributes=${JSON.stringify(cppRes.data.attributes)}`);
    const included = cppRes.included ?? [];

    const versions = included.filter(
      (r) => r.type === "appCustomProductPageVersions"
    ) as unknown as AppCustomProductPageVersion[];

    const versionsWithLocalizations: VersionWithLocalizations[] =
      await Promise.all(
        versions.map(async (version) => {
          const locRes = await getCppVersionLocalizations(creds, version.id);
          const locs = locRes.data;

          await log("cpp-detail", `[Detail] version=${version.id} locs=${locs.length}`);
          if (locs[0]) {
            await log("cpp-detail", `[Detail] first loc attrs=${JSON.stringify(locs[0].attributes)}`);
          }

          const localizationsWithMedia: LocalizationWithMedia[] =
            await Promise.all(
              locs.map(async (loc) => {
                // ── Screenshots ──────────────────────────────────────────
                let screenshotSets: LocalizationWithMedia["screenshotSets"] = [];
                try {
                  const setsRes = await getLocalizationScreenshotSets(creds, loc.id);

                  if (setsRes.data[0]) {
                    void log("cpp-detail", `[Detail] screenshotSet[0] rels=${JSON.stringify(setsRes.data[0].relationships)}`);
                  }
                  if (setsRes.included?.[0]) {
                    void log("cpp-detail", `[Detail] screenshot included[0] rels=${JSON.stringify(setsRes.included[0].relationships)}`);
                  }

                  const allScreenshots = (setsRes.included ?? []).filter(
                    (r) => r.type === "appScreenshots"
                  ) as unknown as AppScreenshot[];

                  screenshotSets = setsRes.data.map((set) => {
                    // Use SET's relationships.appScreenshots.data (not screenshot→set)
                    // because resources in `included` only have `links`, not `data`
                    const setRels = set.relationships as {
                      appScreenshots?: { data?: Array<{ id: string }> };
                    };
                    const idsFromSet = setRels?.appScreenshots?.data?.map((d) => d.id) ?? [];

                    // Fallback: if set doesn't have data IDs, try screenshot's relationship
                    const screenshots = idsFromSet.length > 0
                      ? allScreenshots.filter((s) => idsFromSet.includes(s.id))
                      : allScreenshots.filter((s) => {
                          const sRels = s.relationships as {
                            appScreenshotSet?: { data?: { id: string } };
                          };
                          return sRels?.appScreenshotSet?.data?.id === set.id;
                        });

                    void log("cpp-detail", `[Detail] set=${set.id} type=${set.attributes.screenshotDisplayType} idsFromSet=${idsFromSet.length} matched=${screenshots.length}`);
                    return { set, screenshots };
                  });
                } catch (e) {
                  await log("cpp-detail", `[Detail] screenshot fetch failed for loc=${loc.id}: ${e}`, "ERROR");
                }

                // ── App Previews (video) ──────────────────────────────────
                let previewSets: LocalizationWithMedia["previewSets"] = [];
                try {
                  const prevRes = await getLocalizationPreviewSets(creds, loc.id);

                  const allPreviews = (prevRes.included ?? []).filter(
                    (r) => r.type === "appPreviews"
                  ) as unknown as AppPreview[];

                  previewSets = prevRes.data.map((set) => {
                    const setRels = set.relationships as {
                      appPreviews?: { data?: Array<{ id: string }> };
                    };
                    const idsFromSet = setRels?.appPreviews?.data?.map((d) => d.id) ?? [];

                    const previews = idsFromSet.length > 0
                      ? allPreviews.filter((p) => idsFromSet.includes(p.id))
                      : allPreviews.filter((p) => {
                          const pRels = p.relationships as {
                            appPreviewSet?: { data?: { id: string } };
                          };
                          return pRels?.appPreviewSet?.data?.id === set.id;
                        });

                    return { set, previews };
                  });
                } catch {
                  // Preview sets might not exist — ignore error
                }

                return { localization: loc, screenshotSets, previewSets };
              })
            );

          return { version, localizations: localizationsWithMedia };
        })
      );

    return NextResponse.json({
      cpp: cppRes.data,
      versions: versionsWithLocalizations,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-detail", `GET /api/asc/cpps/${params.cppId} error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: { cppId: string } }
) {
  try {
    const body = await req.json();
    const creds = await getActiveAccount();
    const data = await updateCpp(creds, params.cppId, body);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-detail", `PATCH /api/asc/cpps/${params.cppId} error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { cppId: string } }
) {
  try {
    const creds = await getActiveAccount();
    await deleteCpp(creds, params.cppId);
    await log("cpp-detail", `DELETE /api/asc/cpps/${params.cppId} success`);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-detail", `DELETE /api/asc/cpps/${params.cppId} error: ${message}`, "ERROR");
    // Forward 409 Conflict (in-review) and 403 Forbidden as-is
    const status = message.includes("409") ? 409 : message.includes("403") ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
