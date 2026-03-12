import { NextRequest, NextResponse } from "next/server";
import { updateCppVersion } from "@/lib/asc-client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { versionId: string } }
) {
  try {
    const { deepLink } = (await req.json()) as { deepLink: string };
    if (!deepLink) {
      return NextResponse.json({ error: "deepLink is required" }, { status: 400 });
    }

    const result = await updateCppVersion(params.versionId, deepLink);
    console.log(`[API] PATCH /api/asc/versions/${params.versionId} deepLink updated`);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] PATCH /api/asc/versions/${params.versionId} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
