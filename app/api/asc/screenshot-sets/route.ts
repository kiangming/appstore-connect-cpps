import { NextRequest, NextResponse } from "next/server";
import { createScreenshotSet, getLocalizationScreenshotSets } from "@/lib/asc-client";
import type { ScreenshotDisplayType } from "@/types/asc";

export async function GET(req: NextRequest) {
  const localizationId = req.nextUrl.searchParams.get("localizationId");
  if (!localizationId) {
    return NextResponse.json({ error: "localizationId query param is required" }, { status: 400 });
  }
  try {
    const data = await getLocalizationScreenshotSets(localizationId);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { localizationId, screenshotDisplayType } = body as {
      localizationId: string;
      screenshotDisplayType: ScreenshotDisplayType;
    };

    if (!localizationId || !screenshotDisplayType) {
      return NextResponse.json(
        { error: "localizationId and screenshotDisplayType are required" },
        { status: 400 }
      );
    }

    const data = await createScreenshotSet(localizationId, screenshotDisplayType);
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[API] POST /api/asc/screenshot-sets error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
