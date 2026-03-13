import { NextRequest, NextResponse } from "next/server";
import { updateLocalization } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { localizationId: string } }
) {
  try {
    const body = await req.json();
    const { promotionalText } = body as { promotionalText: string };

    const creds = await getActiveAccount();
    const data = await updateLocalization(creds, params.localizationId, promotionalText);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("localization", `[API] PATCH /api/asc/localizations/${params.localizationId} error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
