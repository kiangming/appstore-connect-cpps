import { NextRequest, NextResponse } from "next/server";
import { getCpps, createCpp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";

export async function GET(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get("appId");

  if (!appId) {
    return NextResponse.json({ error: "appId query param is required" }, { status: 400 });
  }

  try {
    const creds = await getActiveAccount();
    const data = await getCpps(creds, appId);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[API] GET /api/asc/cpps error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { appId, name, locale } = body as { appId: string; name: string; locale: string };

    if (!appId || !name || !locale) {
      return NextResponse.json({ error: "appId, name, and locale are required" }, { status: 400 });
    }

    const creds = await getActiveAccount();
    const cpp = await createCpp(creds, { appId, name, locale });
    console.log(`[API] CPP created id=${cpp.data.id}`);

    return NextResponse.json(cpp, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[API] POST /api/asc/cpps error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
