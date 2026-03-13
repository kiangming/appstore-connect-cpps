import { NextResponse } from "next/server";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

export async function GET(
  _req: Request,
  { params }: { params: { appId: string } }
) {
  try {
    const creds = await getActiveAccount();
    const data = await getApp(creds, params.appId);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("apps", `[API] GET /api/asc/apps/${params.appId} error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
