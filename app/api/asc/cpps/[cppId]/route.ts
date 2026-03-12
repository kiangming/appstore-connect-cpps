import { NextResponse } from "next/server";
import {
  getCpp,
  getCppVersionLocalizations,
  getLocalizationScreenshotSets,
  getLocalizationPreviewSets,
  updateCpp,
} from "@/lib/asc-client";
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
    const cppRes = await getCpp(params.cppId);
    console.log(`[Detail] cpp.attributes=`, JSON.stringify(cppRes.data.attributes));
    const included = cppRes.included ?? [];

    const versions = included.filter(
      (r) => r.type === "appCustomProductPageVersions"
    ) as unknown as AppCustomProductPageVersion[];

    const versionsWithLocalizations: VersionWithLocalizations[] =
      await Promise.all(
        versions.map(async (version) => {
          const locRes = await getCppVersionLocalizations(version.id);
          const locs = locRes.data;

          console.log(`[Detail] version=${version.id} locs=${locs.length}`);
          if (locs[0]) {
            console.log(`[Detail] first loc attrs=`, JSON.stringify(locs[0].attributes));
          }

          const localizationsWithMedia: LocalizationWithMedia[] =
            await Promise.all(
              locs.map(async (loc) => {
                // ── Screenshots ──────────────────────────────────────────
                let screenshotSets: LocalizationWithMedia["screenshotSets"] = [];
                try {
                  const setsRes = await getLocalizationScreenshotSets(loc.id);

                  // Log first set to understand relationship structure
                  if (setsRes.data[0]) {
                    console.log(`[Detail] screenshotSet[0] rels=`, JSON.stringify(setsRes.data[0].relationships));
                  }
                  if (setsRes.included?.[0]) {
                    console.log(`[Detail] screenshot included[0] rels=`, JSON.stringify(setsRes.included[0].relationships));
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

                    console.log(`[Detail] set=${set.id} type=${set.attributes.screenshotDisplayType} idsFromSet=${idsFromSet.length} matched=${screenshots.length}`);
                    return { set, screenshots };
                  });
                } catch (e) {
                  console.error(`[Detail] screenshot fetch failed for loc=${loc.id}:`, e);
                }

                // ── App Previews (video) ──────────────────────────────────
                let previewSets: LocalizationWithMedia["previewSets"] = [];
                try {
                  const prevRes = await getLocalizationPreviewSets(loc.id);

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
    console.error(`[API] GET /api/asc/cpps/${params.cppId} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: { cppId: string } }
) {
  try {
    const body = await req.json();
    const data = await updateCpp(params.cppId, body);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] PATCH /api/asc/cpps/${params.cppId} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
