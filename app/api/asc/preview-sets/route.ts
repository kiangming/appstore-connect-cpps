import { NextRequest, NextResponse } from "next/server";
import { createPreviewSet, getLocalizationPreviewSets } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import type { PreviewType } from "@/types/asc";
import { log } from "@/lib/logger";

export async function GET(req: NextRequest) {
  const localizationId = req.nextUrl.searchParams.get("localizationId");
  if (!localizationId) {
    return NextResponse.json({ error: "localizationId query param is required" }, { status: 400 });
  }
  try {
    const creds = await getActiveAccount();
    const data = await getLocalizationPreviewSets(creds, localizationId);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { localizationId, previewType } = body as {
      localizationId: string;
      previewType: PreviewType;
    };

    if (!localizationId || !previewType) {
      return NextResponse.json(
        { error: "localizationId and previewType are required" },
        { status: 400 }
      );
    }

    const creds = await getActiveAccount();
    const data = await createPreviewSet(creds, localizationId, previewType);
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("upload", `[API] POST /api/asc/preview-sets error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
