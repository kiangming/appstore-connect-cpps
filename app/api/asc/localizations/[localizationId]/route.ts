import { NextRequest, NextResponse } from "next/server";
import { updateLocalization } from "@/lib/asc-client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { localizationId: string } }
) {
  try {
    const body = await req.json();
    const { promotionalText } = body as { promotionalText: string };

    const data = await updateLocalization(params.localizationId, promotionalText);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] PATCH /api/asc/localizations/${params.localizationId} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
