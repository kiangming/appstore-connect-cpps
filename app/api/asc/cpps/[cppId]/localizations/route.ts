import { NextRequest, NextResponse } from "next/server";
import { createLocalization } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";

export async function POST(
  req: NextRequest,
  { params }: { params: { cppId: string } }
) {
  try {
    const body = await req.json();
    const { versionId, locale, promotionalText } = body as {
      versionId: string;
      locale: string;
      promotionalText?: string;
    };

    if (!versionId || !locale) {
      return NextResponse.json(
        { error: "versionId and locale are required" },
        { status: 400 }
      );
    }

    const creds = await getActiveAccount();
    const data = await createLocalization(creds, { cppVersionId: versionId, locale, promotionalText });
    console.log(`[API] Localization created cppId=${params.cppId} locale=${locale}`);
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] POST /api/asc/cpps/${params.cppId}/localizations error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
