import { NextResponse } from "next/server";
import { getApps } from "@/lib/asc-client";

export async function GET() {
  try {
    const data = await getApps();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[API] GET /api/asc/apps error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
