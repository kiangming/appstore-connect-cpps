import { NextRequest, NextResponse } from "next/server";
import {
  getAppInfos,
  getAppInfoLocalizations,
  createAppInfoLocalization,
} from "@/lib/asc-client";

export async function GET(
  _req: NextRequest,
  { params }: { params: { appId: string } }
) {
  try {
    const infosRes = await getAppInfos(params.appId);
    const appInfoId = infosRes.data[0]?.id;
    if (!appInfoId) {
      return NextResponse.json({ locales: [], appInfoId: null });
    }
    const locsRes = await getAppInfoLocalizations(appInfoId);
    const locales = locsRes.data.map((l) => l.attributes.locale);
    return NextResponse.json({ locales, appInfoId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] GET /api/asc/apps/${params.appId}/app-info-localizations error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { appId: string } }
) {
  try {
    const { locale } = (await req.json()) as { locale: string };
    if (!locale) {
      return NextResponse.json({ error: "locale is required" }, { status: 400 });
    }

    // Resolve appInfoId
    const infosRes = await getAppInfos(params.appId);
    const appInfoId = infosRes.data[0]?.id;
    if (!appInfoId) {
      return NextResponse.json({ error: "No app info found" }, { status: 404 });
    }

    const result = await createAppInfoLocalization(appInfoId, locale);
    console.log(`[API] Created app info localization appId=${params.appId} locale=${locale}`);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] POST /api/asc/apps/${params.appId}/app-info-localizations error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
