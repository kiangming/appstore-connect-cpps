import { NextResponse } from "next/server";
import { getApps } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

export async function GET() {
  try {
    const creds = await getActiveAccount();
    const data = await getApps(creds);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("apps", `GET /api/asc/apps error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
