import { NextResponse } from "next/server";
import { getApp } from "@/lib/asc-client";

export async function GET(
  _req: Request,
  { params }: { params: { appId: string } }
) {
  try {
    const data = await getApp(params.appId);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[API] GET /api/asc/apps/${params.appId} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
